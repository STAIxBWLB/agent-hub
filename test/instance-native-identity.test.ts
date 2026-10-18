import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { detectCliIdentity } from "../src/cli/identity.ts";
import { buildPiLaunch } from "../src/pi/launch.ts";
import { validatePiSession, PiSessionUnresumable } from "../src/pi/session.ts";
import { qwenNativeIdentity, QwenIdentityError } from "../src/adapters/definitions/qwen-native.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { realPath } from "../src/hub/project.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = realPath(mkdtempSync(join(tmpdir(), "ahub-instance-native-"))); roots.push(path); return path; };

test("declared native kinds validate markers while preserving the exact instance actor", () => {
  const kinds = { "codex-2": { kind: "codex" }, "claude-2": { kind: "claude" }, "pi-2": { kind: "pi" } };
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex-2", CODEX_THREAD_ID: "thread" }, kinds)).toEqual({ role: "tools", peer: "codex-2" });
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "claude-2", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "session" }, kinds)).toEqual({ role: "tools", peer: "claude-2" });
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex-2", CODEX_THREAD_ID: "thread" }).role).toBe("invalid");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "pi-2", CODEX_THREAD_ID: "thread" }, kinds).role).toBe("invalid");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex-2", CODEX_THREAD_ID: "thread", CLAUDECODE: "1" }, kinds).role).toBe("invalid");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex-2" }, kinds)).toEqual({ role: "tools", peer: "codex-2" });
  expect(detectCliIdentity({}, kinds)).toEqual({ role: "console" });
});

test("Pi launch separates native instance state from the canonical hub binding", () => {
  const hub = root(), native = join(hub, "instances", "pi-2");
  const options = { instance: "pi-2", stateDir: native, hubStateDir: hub, mode: "headless" as const, backend: "auto" as const, relay: { url: "http://127.0.0.1:1", token: "fixture", models: [] }, tools: [] };
  const plan = buildPiLaunch(options, { AGENTHUB_PEER_ID: "outer", AGENTHUB_STATE_DIR: "wrong", CODEX_THREAD_ID: "old", CLAUDECODE: "1" }, "extension.ts", 1234, "bridge");
  expect(plan.env.AGENTHUB_PEER_ID).toBe("pi-2");
  expect(plan.env.AGENTHUB_STATE_DIR).toBe(hub);
  expect(plan.env.PI_CODING_AGENT_DIR).toBe(join(native, "pi"));
  expect(plan.args[plan.args.indexOf("--session-dir") + 1]).toBe(join(native, "pi-sessions"));
  expect(plan.env.CODEX_THREAD_ID).toBeUndefined(); expect(plan.env.CLAUDECODE).toBeUndefined();
  const defaultPlan = buildPiLaunch({ ...options, instance: undefined, stateDir: hub, hubStateDir: undefined }, {}, "extension.ts", 1234, "bridge");
  expect(defaultPlan.env.AGENTHUB_PEER_ID).toBe("pi");
  expect(defaultPlan.env.PI_CODING_AGENT_DIR).toBe(join(hub, "pi"));
});

test("Pi session validation accepts only that native instance's managed transcript", () => {
  const hub = root(), own = join(hub, "instances", "pi-2"), other = join(hub, "instances", "pi-3");
  for (const state of [own, other]) mkdirSync(join(state, "pi-sessions"), { recursive: true });
  const file = join(own, "pi-sessions", "session.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", id: "same-native-id", cwd: hub }) + "\n");
  expect(validatePiSession(own, hub, file, "same-native-id")).toEqual({ sessionFile: file, sessionId: "same-native-id" });
  expect(() => validatePiSession(other, hub, file, "same-native-id")).toThrow(PiSessionUnresumable);
});

test("Qwen native proof uses the trusted kind and never infers instance suffixes", () => {
  const init = { agentInfo: { name: "qwen-code", version: "0.25.0" } };
  expect(() => qwenNativeIdentity("qwen-2", true, init, "qwen")).not.toThrow();
  expect(qwenNativeIdentity("qwen-2", true, init, "qwen")).toBe(true);
  expect(() => qwenNativeIdentity("qwen-2", true, init)).toThrow(QwenIdentityError);
  expect(() => qwenNativeIdentity("qwen-2", true, init, "kimi")).toThrow(QwenIdentityError);
  expect(() => qwenNativeIdentity("qwen-2", true, { agentInfo: { name: "qwen-code", version: "0.24.0" } }, "qwen")).toThrow(QwenIdentityError);
  expect(qwenNativeIdentity("qwen-2", false, init, "qwen")).toBe(false);
});

test("spawned Codex app servers carry their exact instance identity", async () => {
  const base = root(), bin = join(base, "codex-fixture");
  writeFileSync(bin, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.AHUB_INSTANCE_RECORD, JSON.stringify({ peer: process.env.AGENTHUB_PEER_ID, codex: process.env.CODEX_THREAD_ID, claude: process.env.CLAUDECODE }));\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  for (const instance of ["codex-2", "codex-3"]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = probe.port!; probe.stop(true);
    const record = join(base, `${instance}.json`), peer = new CodexPeer(instance, { cwd: base, bin, appPort: port, proxyPort: 0, env: { AHUB_INSTANCE_RECORD: record, AGENTHUB_PEER_ID: "outer", CODEX_THREAD_ID: "old", CLAUDECODE: "1" } });
    try { await peer.start(); expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ peer: instance }); }
    finally { await peer.stop(); }
  }
}, 20_000);
