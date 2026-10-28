import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { readEvents } from "../src/hub/events.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeout = 3500) => {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(15);
  expect(await condition(), label).toBe(true);
};
class IdlePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

/** Real four-file loader, Git trust and WS requests; only the explicit embedding regression uses opts.config. */
async function fixture(initial: { local?: unknown; trackedLocal?: boolean; embedded?: boolean } = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-reload-daemon-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  const shared = {
    batch_ms: 0,
    roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
    memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    research: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false },
    pi: { enabled: false, auto_start: false }, coordination: "advisory", tasks: { wip_limits: { codex: 1 } },
    task_sweep: { enabled: false, interval_s: 30 },
  };
  const file = (name: string) => join(dir, ".agenthub", name);
  const configText = JSON.stringify(shared);
  writeFileSync(file("config.json"), configText);
  if (initial.local !== undefined) writeFileSync(file("config.local.json"), JSON.stringify(initial.local));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(file("routing.toml"), routing);
  writeFileSync(join(dir, "example.txt"), "initial\n");
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml", "example.txt"); git("commit", "-qm", "fixture baseline");
  if (initial.trackedLocal) git("add", "-f", ".agenthub/config.local.json");
  let ticks = 0;
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    ...(initial.embedded ? { config: loadConfig(dir) } : {}), taskSweepNow: () => { ticks++; return Date.now(); }, researchGraceMs: 1,
    // #550: the snapshots test below needs a turn's snapshot evidence; a fixed clock keeps a slow runner from spending the 250 ms budget (tests.md).
    snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());
  const pushes: Record<string, any>[] = []; client.onPush = value => pushes.push(value);
  client.send({ t: "tail" });
  await client.request({ t: "status" }); // same-socket barrier after the fire-and-forget subscription
  const get = () => client.request({ t: "settings_get" });
  const row = async (key: string) => (await get()).rows.find((item: { key: string }) => item.key === key);
  const reload = (confirm?: string) => client.request({ t: "settings_reload", ...(confirm ? { confirm } : {}) });
  // Only tests explicitly approving a complete person-reviewed candidate use this helper; watchers and
  // ordinary/dashboard reloads below never acquire or submit this terminal confirmation token.
  const personReload = async () => {
    const preview = await reload();
    expect(preview.ok, String(preview.error)).toBe(true);
    if (!preview.confirmation) return preview;
    expect(typeof preview.confirmation.token).toBe("string");
    const result = await reload(preview.confirmation.token);
    expect(result.ok, String(result.error)).toBe(true);
    return result;
  };
  const set = (key: string, value: unknown) => client.request({ t: "settings_set", key, value, reason: "reload regression" });
  return { dir, state, file, shared, routing, configText, daemon, client, pushes, get, row, reload, personReload, set, git, ticks: () => ticks };
}

test("#439 daemon settings writes apply safe switches and WIP without disturbing a pause or queue; undo reloads", async () => {
  const f = await fixture();
  const peer = new IdlePeer("reload-observer"); f.daemon.bus.add(peer); await peer.start();
  f.daemon.bus.pause(peer.id);
  expect((await f.client.request({ t: "send", to: [peer.id], body: "must remain queued through reload" })).ok).toBe(true);
  const queued = f.daemon.bus.queued(peer.id), instance = (await f.client.request({ t: "status" })).status.instanceId;
  for (const [key, value] of [["research.enabled", true], ["approvals.notify", true], ["snapshots.enabled", true], ["tasks.wip_limits.codex", 0]] as const) {
    expect((await f.set(key, value)).ok, key).toBe(true);
    const row = await f.row(key);
    expect(row.value, key).toEqual(value);
    expect(row.fileValue, key).toEqual(value);
    expect(["live", "next use"]).toContain(row.applies);
  }
  const preview = await f.client.request({ t: "settings_preview", undo: true });
  expect(preview.ok).toBe(true);
  expect((await f.client.request({ t: "settings_undo", reason: "restore WIP" })).ok).toBe(true);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect(f.daemon.bus.stateOf(peer.id)).toBe("paused");
  expect(f.daemon.bus.queued(peer.id)).toBe(queued);
  expect((await f.client.request({ t: "status" })).status.instanceId).toBe(instance);
  expect(readFileSync(f.file("config.json"), "utf8")).toBe(f.configText);
}, 15_000);

test("#439 task_sweep reload installs and cancels the actual running timer", async () => {
  const f = await fixture();
  expect(f.ticks()).toBe(0);
  expect((await f.set("task_sweep.interval_s", 1)).ok).toBe(true);
  expect((await f.set("task_sweep.enabled", true)).ok).toBe(true);
  await until(() => f.ticks() >= 1, "new one-second sweep timer", 2500);
  expect((await f.set("task_sweep.enabled", false)).ok).toBe(true);
  const stopped = f.ticks();
  await Bun.sleep(1150);
  expect(f.ticks(), "disabled sweep cannot keep the old timer alive").toBe(stopped);
  expect((await f.set("task_sweep.enabled", true)).ok).toBe(true);
  await until(() => f.ticks() > stopped, "re-enabled sweep timer", 2500);
}, 15_000);

for (const name of ["config.json", "config.local.json", "routing.toml", "routing.local.toml"]) {
  test(`#439 malformed ${name} rejects the entire candidate and emits one notice`, async () => {
    const f = await fixture();
    // A valid live change in one layer must not leak past an invalid other layer.
    writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: true } }));
    writeFileSync(f.file(name), name.endsWith("json") ? '{ "approvals": ' : '[classes.implement\npeers = [');
    const result = await f.reload();
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain(name);
    expect((await f.row("research.enabled")).value).toBe(false);
    expect((await f.row("approvals.notify")).value).toBe(false);
    await until(() => f.pushes.some(message => message.t === "notice" && String(message.line).includes(name)), "invalid candidate notice");
    // The watcher's debounce and explicit reload may see the same bytes: one error notice per candidate.
    await Bun.sleep(400);
    expect(f.pushes.filter(message => message.t === "notice" && String(message.line).includes(name))).toHaveLength(1);
    expect((await f.client.request({ t: "status" })).status.pendingRestart ?? []).toEqual([]);
  }, 15_000);
}

test("#439 unknown nested config key cannot partially enable an otherwise valid live switch", async () => {
  const f = await fixture();
  writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: true }, task_sweep: { enabeld: true } }));
  const result = await f.reload();
  expect(result.ok).toBe(false);
  expect(String(result.error)).toContain("task_sweep.enabeld");
  expect((await f.row("research.enabled")).value).toBe(false);
}, 15_000);

for (const forbidden of ["machine-local", "raises"] as const) {
  test(`#439 tracked ${forbidden} edit stays rejected while independent safe changes apply`, async () => {
    const f = await fixture();
    const changed = { ...f.shared, research: { enabled: true }, ...(forbidden === "machine-local"
      ? { local: { read_allow: ["/tmp/reload-secret"] } }
      : { tasks: { wip_limits: { codex: 2 } } }) };
    writeFileSync(f.file("config.json"), JSON.stringify(changed));
    const result = await f.reload();
    expect(result.ok).toBe(true);
    const key = forbidden === "machine-local" ? "local.read_allow" : "tasks.wip_limits.codex";
    expect(result.rejected.some((entry: { key: string; reason: string }) => entry.key.includes(key) && /tracked|committed|authority/i.test(entry.reason))).toBe(true);
    expect((await f.row("research.enabled")).value).toBe(true);
    expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
    expect(f.daemon.bus.peers.has("local")).toBe(false);
  }, 15_000);
}

test("#439 ordinary dashboard reload cannot launder an unrelated untracked raises edit", async () => {
  const f = await fixture();
  writeFileSync(f.file("config.local.json"), JSON.stringify({ tasks: { wip_limits: { codex: 2 } }, research: { enabled: true } }));
  const before = await f.client.request({ t: "status" });
  const result = await f.client.request({ t: "ui_action", instanceId: before.status.instanceId, action: { action: "setting_reload" } });
  expect(result.ok).toBe(true);
  expect(result.rejected.some((entry: { key: string }) => entry.key.includes("tasks.wip_limits.codex"))).toBe(true);
  expect((await f.row("tasks.wip_limits.codex")).value).toBe(1);
  expect((await f.row("research.enabled")).value).toBe(true);
}, 15_000);

test("#439 tools and peer roles cannot reload, edit, preview or undo settings", async () => {
  const f = await fixture();
  const original = readFileSync(f.file("config.json"), "utf8");
  for (const role of ["tools", "peer"] as const) {
    const client = await ControlClient.connect(f.state, { role, peer: "reload-agent", channel: false }); cleanup.push(() => client.close());
    for (const message of [{ t: "settings_reload" }, { t: "settings_preview", undo: true }, { t: "settings_set", key: "research.enabled", value: true }, { t: "settings_undo" }]) {
      expect((await client.request(message)).ok, `${role}: ${message.t}`).toBe(false);
    }
  }
  expect(readFileSync(f.file("config.json"), "utf8")).toBe(original);
  expect(existsSync(f.file("config.local.json"))).toBe(false);
}, 15_000);

test("#439 atomic config rename is watched and applies safe values without an explicit reload", async () => {
  const f = await fixture();
  const temp = f.file("config.local.json.tmp");
  writeFileSync(temp, JSON.stringify({ research: { enabled: true } }));
  renameSync(temp, f.file("config.local.json"));
  await until(async () => (await f.row("research.enabled")).value === true, "atomic-rename watch applied research", 4000);
  expect((await f.row("research.enabled")).fileValue).toBe(true);
}, 15_000);

test("#439 restart-only file differences are reported without opening native memory", async () => {
  const f = await fixture();
  writeFileSync(f.file("config.local.json"), JSON.stringify({ memory: { enabled: true } }));
  const result = await f.personReload();
  expect(result.ok).toBe(true);
  const pending = result.pendingRestart.find((entry: { key: string }) => entry.key === "memory.enabled");
  expect(pending).toBeDefined();
  expect(pending.reason.length).toBeGreaterThan(0);
  const status = (await f.client.request({ t: "status" })).status;
  expect(status.pendingRestart).toEqual(result.pendingRestart);
  expect((await f.get()).pendingRestart).toEqual(result.pendingRestart);
  expect(status.memoryProfile.state).toBe("disabled");
}, 15_000);

test("#439 snapshots enabled by reload captures a later real peer turn", async () => {
  const f = await fixture();
  expect((await f.set("snapshots.enabled", true)).ok).toBe(true);
  class Editor extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver() {
      this.setState("busy");
      writeFileSync(join(f.dir, "example.txt"), "changed after reload\n");
      setTimeout(() => this.setState("idle"), 5);
    }
  }
  const editor = new Editor("reload-editor"); f.daemon.bus.add(editor); await editor.start();
  expect((await f.client.request({ t: "send", to: [editor.id], body: "change tracked file" })).ok).toBe(true);
  const ended = () => readEvents(join(f.state, "events.jsonl")).find(event => event.type === "turn_end" && event.peer === editor.id);
  await until(() => !!ended(), "post-reload editor turn");
  const event = ended();
  expect(event?.type === "turn_end" ? event.files : undefined).toBe(1);
  expect(event?.type === "turn_end" ? event.snapshotMs : undefined).toBeGreaterThanOrEqual(0);
}, 15_000);


test("#439 tracked routing constraints cannot widen privacy during an otherwise safe reload", async () => {
  const f = await fixture();
  writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: true } }));
  writeFileSync(f.file("routing.toml"), f.routing.replace('pii = "local_only"', 'pii = "off"'));
  const result = await f.reload();
  expect(result.ok).toBe(true);
  expect(result.rejected.some((entry: { key: string; reason: string }) => entry.key.includes("constraints.pii") && /tracked|committed|authority/i.test(entry.reason))).toBe(true);
  expect((await f.row("research.enabled")).value).toBe(true);
}, 15_000);


test("#439 a settings dashboard cannot reload a command outside its editable authority", async () => {
  const f = await fixture();
  const url = new URL((await f.client.request({ t: "ui", settings: true })).url);
  const session = await fetch(`${url.origin}/session`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  writeFileSync(f.file("config.local.json"), JSON.stringify({ pi: { cmd: ["untrusted-fixture-only"] }, research: { enabled: true } }));
  const response = await fetch(`${url.origin}/action`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", cookie }, body: JSON.stringify({ action: "setting_reload", authority: "terminal" }) });
  const result = await response.json() as { ok: boolean; applied?: string[]; rejected?: { key: string; reason: string }[] };
  expect(result.ok).toBe(true);
  expect(result.rejected?.some(entry => entry.key.includes("pi.cmd") && /confirmed terminal reload/i.test(entry.reason))).toBe(true);
  expect(result.applied ?? []).not.toContain("pi.cmd");
  expect((await f.row("research.enabled")).value).toBe(true);
  expect(f.daemon.bus.peers.has("pi")).toBe(false);
}, 15_000);


test("#439 ordinary reload cannot activate an unchanged declaration whose Git trust changed", async () => {
  const local = { permission_modes: { codex: "never-ask" } };
  const f = await fixture({ local, trackedLocal: true });
  f.git("rm", "--cached", "-f", ".agenthub/config.local.json");
  writeFileSync(f.file("config.local.json"), JSON.stringify({ ...local, research: { enabled: true } }));
  const instanceId = (await f.client.request({ t: "status" })).status.instanceId;
  const result = await f.client.request({ t: "ui_action", instanceId, action: { action: "setting_reload" } });
  expect(result.ok).toBe(true);
  expect(result.rejected.some((entry: { key: string; reason: string }) => entry.key.includes("permission_modes.codex") && /selected setting|confirmed terminal reload/i.test(entry.reason))).toBe(true);
  expect((await f.row("permission_modes.codex")).value).not.toBe("never-ask");
  expect((await f.row("permission.codex")).value).not.toBe("never-ask");
  expect((await f.row("research.enabled")).value).toBe(true);
}, 15_000);

test("#439 relay changes stay pending across reloads while watchdog changes reach the next peer turn", async () => {
  const f = await fixture();
  const peer = new IdlePeer("reload-observer", 60_000); f.daemon.bus.add(peer); await peer.start();
  f.git("rm", "--cached", "-f", ".agenthub/routing.toml");
  writeFileSync(f.file("routing.toml"), f.routing.replace(/dgx_max_context_tokens = \d+/, "dgx_max_context_tokens = 123456"));
  writeFileSync(f.file("config.local.json"), JSON.stringify({ watchdog_ms: 120_000, pi: { dgx_coding: "future-coding-model" } }));
  const result = await f.personReload();
  expect(result.ok).toBe(true);
  expect(result.pendingRestart.map((item: { key: string }) => item.key)).toContain("routing.pi.dgx_max_context_tokens");
  expect(result.pendingRestart.map((item: { key: string }) => item.key)).toContain("pi.dgx_coding");
  expect((peer as any).watchdogMs).toBe(60_000);
  (peer as any).setState("busy");
  expect((peer as any).watchdogMs).toBe(120_000);
  (peer as any).setState("idle");
  expect((await f.personReload()).pendingRestart).toEqual(result.pendingRestart);
  writeFileSync(f.file("routing.toml"), f.routing);
  writeFileSync(f.file("config.local.json"), JSON.stringify({ watchdog_ms: 120_000 }));
  expect((await f.personReload()).pendingRestart).toEqual([]);
}, 15_000);

test("#439 embedded callers retain desired restart values across unchanged and unrelated reloads", async () => {
  const f = await fixture({ embedded: true });
  writeFileSync(f.file("config.local.json"), JSON.stringify({ memory: { enabled: true } }));
  const first = await f.personReload();
  expect(first.ok).toBe(true);
  expect(first.pendingRestart.map((x: {key: string}) => x.key)).toContain("memory.enabled");
  expect((await f.personReload()).pendingRestart).toEqual(first.pendingRestart);
  writeFileSync(f.file("config.local.json"), JSON.stringify({ memory: { enabled: true }, research: { enabled: true } }));
  expect((await f.personReload()).pendingRestart).toEqual(first.pendingRestart);
  expect((await f.row("research.enabled")).value).toBe(true);
  writeFileSync(f.file("config.local.json"), JSON.stringify({ research: { enabled: true } }));
  expect((await f.personReload()).pendingRestart).toEqual([]);
}, 15_000);
