import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole } from "../src/cli/console-state.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { DOING_STUB, DoingTracker, sessionTitleBindings, sessionTitleText, unnamedSessionLabel } from "../src/hub/peer-doing.ts";
import { HELP } from "../src/cli/help.ts";

test("session title normalization has an 80-code-point ceiling and fallback is display-only, screened as a whole", () => {
  expect(sessionTitleText("  이름\n정리  ")).toBe("이름 정리");
  expect(sessionTitleText("가".repeat(80))).toHaveLength(80);
  expect(sessionTitleText("  " + "가".repeat(80) + "\n ")).toBe("가".repeat(80));
  expect(sessionTitleText("가".repeat(81))).toBeUndefined();
  expect(sessionTitleText(" \n ")).toBeUndefined();
  const source = "Public ".repeat(25) + "SECRET";
  expect(unnamedSessionLabel(source, text => text.includes("SECRET"), 1)).toEqual({ text: DOING_STUB, source: "label", at: 1 });
  expect(unnamedSessionLabel("first line\nsecond line", () => false, 2)).toEqual({ text: "first line second line", source: "label", at: 2 });
  expect(unnamedSessionLabel("public", () => { throw new Error("screen failed"); }, 3)?.text).toBe(DOING_STUB);
  const tracker = new DoingTracker(); tracker.observe("title", "Public title", () => false, 4);
  expect(tracker.view(false, () => { throw new Error("policy changed"); })?.text).toBe(DOING_STUB);
});

test("restart bindings contain opaque IDs only, reject copied text metadata and stay bounded", () => {
  const good = { session: "s1", delivery: "d1", envelope: "e1" };
  expect(sessionTitleBindings({ local: good })).toEqual({ local: good });
  expect(sessionTitleBindings({ local: { ...good, label: "must never store me" } })).toEqual({});
  expect(sessionTitleBindings({ local: { ...good, session: "" } })).toEqual({});
  expect(Object.keys(sessionTitleBindings(Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`p${i}`, good]))))).toHaveLength(128);
});

test("console title editor starts empty after the command prefix and native-title peers use their own UI", () => {
  const s = initialConsoleState(true); s.peers = { local: { state: "idle", doing: { text: "Never prefill this fallback label", source: "label", at: 1 } } };
  const edit = reduceConsole(s, "t", 1).state;
  expect(edit.editing).toBe(true); expect(edit.input).toBe("title local ");
  expect(edit.input).not.toContain("fallback");
  const native = initialConsoleState(true); native.peers = { codex: { state: "idle" } };
  const refused = reduceConsole(native, "t", 1).state;
  expect(refused.editing).toBe(false); expect(refused.notice).toContain("native UI");
  expect(classifyPeerCommand("title", ["local", "Name"])).toBe("console");
  expect(liveTestRefusal("title", ["local", "Name"])).toBe(true);
  expect(HELP.some(section => JSON.stringify(section).includes("ahub title <peer>"))).toBe(true);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

test("title CLI prints the daemon's actionable refusal without dropping its next step", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-title-cli-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const errors = ["this peer uses native titles; rename the session in its own UI", "peer is offline; start it with ahub pi, then retry ahub title", "title withheld by privacy policy; finish PII work or use a public, non-secret title"];
  let error = errors[0]!;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no"); }, websocket: {
    message(ws, data) { const m = JSON.parse(String(data)); ws.send(JSON.stringify(m.t === "hello" ? { rid: m.rid, ok: true, t: "welcome", cwd: root, projectId: "title-cli", instanceId: "title-cli" } : { rid: m.rid, ok: false, reason: "invalid", error })); },
  } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ pid: process.pid, cwd: root, projectId: "title-cli", instanceId: "title-cli", controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "title-cli-token");
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: root, AGENTHUB_HOME: join(root, "home"), AGENTHUB_PROJECT_DIR: root, AGENTHUB_STATE_DIR: stateDir };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || ["AGENTHUB_PEER_ID", "AGENTHUB_MODE", "AGENTHUB_CHANNEL", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  try {
    for (const expected of errors) {
      error = expected;
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "title", "pi", "Public title"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0); expect(stderr).toContain(expected);
    }
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
