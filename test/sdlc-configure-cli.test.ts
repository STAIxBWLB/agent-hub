import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal, LIVE_TEST_PERSON_REFUSAL } from "../src/cli/identity.ts";
import { renderSdlcConfiguration } from "../src/cli/sdlc-output.ts";
import { processSignature } from "../src/pi/process-signature.ts";

const receipt = { ok: true, saved: true, by: "claude", instructionClaim: "person_direct_instruction", text: "sdlc.toml written; restart pending",
  lines: ['sdlc.mode: "off" -> "advise" (pending restart)', 'sdlc.required_checks: [] -> ["unit", "lint"] (pending restart)'], restartPending: ["sdlc.mode", "sdlc.required_checks"] };
async function fixture(run: (f: { cli(args: string[], markers?: Record<string, string>, width?: number): Promise<{ code: number; stdout: string; stderr: string }>; requests: Record<string, any>[]; hellos: Record<string, any>[]; respond(value: Record<string, unknown>): void }) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-configure-cli-"))), home = join(root, "home"), state = join(root, ".agenthub/state");
  mkdirSync(home); mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  let answer: Record<string, unknown> = receipt;
  const requests: Record<string, any>[] = [], hellos: Record<string, any>[] = [], token = "synthetic-control-token";
  const identity = { cwd: root, protocol: PROTOCOL, projectId: "configure-fixture", instanceId: "configure-fixture" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw));
    if (row.t === "hello") { hellos.push(row); ws.send(JSON.stringify({ t: "welcome", rid: row.rid, ok: row.token === token, ...identity, features: [] })); return; }
    requests.push(row);
    if (row.t === "conductor_operational" && row.op === "authorize") { ws.send(JSON.stringify({ rid: row.rid, ok: true })); return; }
    ws.send(JSON.stringify({ rid: row.rid, ...answer }));
  } } });
  writeFileSync(join(state, "control-token"), token); writeFileSync(join(state, "status.json"), JSON.stringify({ ...identity, controlPort: server.port, pid: process.pid, pidSignature: processSignature(process.pid) }));
  const cli = async (args: string[], markers: Record<string, string> = {}, width = 80) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"),
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), PATH: process.env.PATH ?? "", TMPDIR: root, TERM: "xterm-256color", COLUMNS: String(width), ...markers } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run({ cli, requests, hellos, respond: value => { answer = value; } }); }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

test("CLI configure makes only the explicit cooperative claim and prints human or transport-free JSON at both widths", async () => {
  await fixture(async f => {
    for (const width of [80, 200]) {
      const human = await f.cli(["sdlc", "configure", "--mode", "advise", "--required-checks", "unit, lint", "--color=never"], {}, width);
      expect(human.code, human.stderr).toBe(0); expect(human.stdout.trim().startsWith("{")).toBe(false); expect(human.stdout).toContain("restart pending");
      expect(human.stdout).toContain("claude"); expect(human.stdout).toContain("explicit instruction");
      for (const line of human.stdout.trimEnd().split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      const json = await f.cli(["sdlc", "configure", "--mode", "advise", "--required-checks", "unit, lint", "--json"], {}, width);
      expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout)).toEqual(receipt); expect(JSON.parse(json.stdout)).not.toHaveProperty("rid");
    }
    for (const row of f.requests) { const { rid: _rid, ...wire } = row; expect(wire).toEqual({ t: "sdlc", op: "configure", mode: "advise", required_checks: ["unit", "lint"], instructionClaim: true }); }
    expect(f.hellos.every(row => row.role === "console" && row.peer === undefined)).toBe(true);
    const cleared = await f.cli(["sdlc", "configure", "--required-checks", "", "--json"]); expect(cleared.code, cleared.stderr).toBe(0);
    expect(f.requests.at(-1)?.required_checks).toEqual([]); expect(f.requests.at(-1)).not.toHaveProperty("mode");
  });
}, 20_000);

test("malformed and protected command forms refuse before any SDLC request", async () => {
  await fixture(async f => {
    for (const args of [[], ["--mode", "enforce"], ["--mode", "advise", "--mode", "off"], ["--required-checks"], ["--mode", "advise", "--security", "{}"], ["--mode", "advise", "unexpected"]]) {
      const result = await f.cli(["sdlc", "configure", ...args]); expect(result.code, args.join(" ")).toBe(2); expect(result.stdout).toBe(""); // every one is a usage error (#1484)
    }
    expect(f.requests).toEqual([]);
  });
}, 20_000);

test("agent identity remains tools/conductor and live-test never impersonates a person for configure", async () => {
  await fixture(async f => {
    const markers = { AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "synthetic-session" };
    const agent = await f.cli(["sdlc", "configure", "--mode", "advise", "--json"], markers);
    expect(agent.code, agent.stderr).toBe(0); expect(f.hellos.at(-1)).toMatchObject({ role: "tools", peer: "claude" });
    expect(f.requests.find(row => row.t === "conductor_operational")).toMatchObject({ op: "authorize", command: "sdlc configure" });
    expect(f.requests.at(-1)).toMatchObject({ t: "sdlc", op: "configure", instructionClaim: true });
    const before = f.requests.length, delegated = await f.cli(["--live-test", "sdlc", "configure", "--mode", "advise"], markers);
    expect(delegated.code).toBe(1); expect(delegated.stdout).toBe(""); expect(delegated.stderr).toContain(LIVE_TEST_PERSON_REFUSAL); expect(f.requests).toHaveLength(before);
    expect(classifyPeerCommand("sdlc", ["configure", "--mode", "advise"])).toBe("conductor");
    expect(classifyPeerCommand("settings", ["edit", "sdlc.toml", "set", "mode", '"advise"'])).toBe("console");
    expect(classifyPeerCommand("init", ["--sdlc", "advise"])).toBe("console");
    expect(liveTestRefusal("sdlc", ["configure", "--mode", "advise"])).toBe(true);
    expect(cliCommandLabel("sdlc", ["configure", "--required-checks", "VALUE_CANARY"])).toBe("sdlc configure");
  });
}, 20_000);

test("old hub refusals name upgrade and renderers keep long receipts within the chosen width", async () => {
  await fixture(async f => {
    f.respond({ ok: false, error: "unknown SDLC operation" });
    const result = await f.cli(["sdlc", "configure", "--mode", "advise"]);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toMatch(/upgrade and restart/);
  });
  for (const width of [80, 200]) {
    const lines = renderSdlcConfiguration({ ...receipt, lines: ["Long required check name ".repeat(20)], backup: "sdlc.toml.1700000000000.abcdef12.bak" }, width);
    for (const line of lines) expect(Bun.stringWidth(line.map(span => span.text).join(""))).toBeLessThanOrEqual(width);
  }
}, 20_000);
