import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class BusyBase extends BasePeer {
  async start() { this.setState("busy"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!; probe.stop(true); return port;
}
async function until(condition: () => boolean, name: string) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), name).toBe(true);
}

test("I2 daemon never promotes a canonical reviewer runtime into a write owner through ordinary role reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-owner-isolation-")), stateDir = join(root, ".agenthub", "state"), instance = "codex-reviewer";
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, console_: ControlClient | undefined, tui: WebSocket | undefined;
  try {
    expect(hubGitSync(["init", "--quiet", root], { encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, ".agenthub"));
    const bin = join(root, "fake-codex");
    writeFileSync(bin, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
    const configuration = (role: string) => ({
      instances: { [instance]: { kind: "codex" } }, // Ordinary roles, never declaration.roles, govern this runtime.
      roles: { [instance]: [role] }, codex_bin: bin, batch_ms: 0,
      memory: { enabled: false, native: false }, snapshots: { enabled: false }, inference: { enabled: false },
      mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, approvals: { notify: false },
    });
    const write = (role: string) => writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify(configuration(role)));
    write("reviewer");
    writeFileSync(join(root, ".agenthub", "routing.toml"), '[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort() });
    console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const client = console_;
    const started = await client.request({ t: "start", peer: instance });
    expect(started).toMatchObject({ t: "started", ok: true, executionCwd: root });
    expect(daemon.bus.peers.get(instance)?.id).toBe(instance);
    const seen: any[] = [];
    tui = new WebSocket(started.proxyUrl); tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { tui!.onopen = () => resolve(); tui!.onerror = () => reject(new Error("fake TUI connection failed")); });
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "instance-owner-isolation-fixture" } } }));
    await until(() => seen.some(message => message.id === 1), "native initialize reply");
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => seen.some(message => message.id === 2 && message.result?.thread?.id) && daemon!.bus.stateOf(instance) === "idle", "canonical reviewer adopted its native thread");
    const nativeOwner = daemon.bus.peers.get(instance);
    const base = new BusyBase("codex"); await base.start(); daemon.bus.add(base);
    expect(daemon.bus.stateOf("codex")).toBe("busy");
    const op = (name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args }, 15000);
    const task = async (id: number) => {
      const shown = await op("task_show", { id }); expect(shown.ok).toBe(true); return JSON.parse(shown.text);
    };
    for (const [phase, reason] of [["reviewer", "current implementer role"], ["implementer", "verified isolated execution root"]] as const) {
      if (phase === "implementer") {
        write("implementer");
        const preview = await client.request({ t: "settings_reload" });
        const reloaded = preview.confirmation ? await client.request({ t: "settings_reload", confirm: preview.confirmation.token }) : preview;
        expect(reloaded).toMatchObject({ ok: true });
      }
      const status = (await client.request({ t: "status" })).status;
      expect(status.roleInfo[instance].flowRoles).toEqual([phase]);
      expect(daemon.bus.peers.get(instance)).toBe(nativeOwner);
      expect(daemon.bus.stateOf("codex")).toBe("busy");
      const proposed = await op("hub_task_propose", { title: `Canonical ${phase} must not own implementation`, class: "implement" });
      expect(proposed.ok).toBe(true);
      const id = Number(proposed.text.match(/task #(\d+)/)![1]);
      const before = await task(id);
      expect(before.owner).not.toBe(instance);
      const explained = await op("route_explain", { id });
      expect(explained.ok).toBe(true);
      expect(explained.text).toContain(reason);
      expect(explained.text).not.toContain(`owner: ${instance}`);
      expect(await task(id)).toEqual(before); // Explain is read-only even when the instance is inadmissible.
      const assigned = await op("task_assign", { id, peer: instance, role: "owner" });
      expect(assigned.ok).toBe(false);
      expect(assigned.error).toContain(reason);
      expect(await task(id)).toEqual(before); // Refuse before owner/history/revision writes.
    }
  } finally {
    tui?.close(); console_?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
