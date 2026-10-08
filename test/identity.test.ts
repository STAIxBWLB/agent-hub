import { expect, test } from "bun:test";
import { classifyPeerCommand, cliCommandLabel, detectCliIdentity, peerCommandRefusal } from "../src/cli/identity.ts";

test("plain terminals keep console identity and native markers select tools identity", () => {
  expect(detectCliIdentity({})).toEqual({ role: "console" });
  for (const peer of ["claude", "codex", "kimi", "pi", "local"]) expect(detectCliIdentity({ AGENTHUB_PEER_ID: peer })).toEqual({ role: "tools", peer });
  expect(detectCliIdentity({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "session-1" })).toEqual({ role: "tools", peer: "claude" });
  expect(detectCliIdentity({ CODEX_THREAD_ID: "thread-1" })).toEqual({ role: "tools", peer: "codex" });
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "thread-1" })).toEqual({ role: "tools", peer: "codex" });
});

test("malformed and conflicting native identity never falls back to the person", () => {
  for (const env of [
    { AGENTHUB_PEER_ID: "" }, { AGENTHUB_PEER_ID: "user" }, { AGENTHUB_PEER_ID: "hub" }, { AGENTHUB_PEER_ID: "digest" }, { AGENTHUB_PEER_ID: "x".repeat(33) }, { AGENTHUB_PEER_ID: "codex\n" },
    { CLAUDECODE: "" }, { CLAUDECODE: "0" }, { CODEX_THREAD_ID: "" }, { CODEX_THREAD_ID: "thread with spaces" },
    { CLAUDE_CODE_SESSION_ID: "session-1" }, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "" },
    { CLAUDECODE: "1", CODEX_THREAD_ID: "thread-1" }, { AGENTHUB_PEER_ID: "kimi", CODEX_THREAD_ID: "thread-1" },
    { AGENTHUB_PEER_ID: "codex", CLAUDECODE: "1" },
  ]) expect(detectCliIdentity(env).role).toBe("invalid");
});

test("agent command classification refuses all human authority and keeps ordinary tools", () => {
  for (const command of ["permit", "queue", "kill", "recovery", "recovery-run", "upgrade", "restart", "up", "ask", "console", "ui", "tail", "undo", "unknown"]) expect(classifyPeerCommand(command, [])).toBe("console");
  for (const sub of ["resume", "set", "execution"]) expect(classifyPeerCommand("budget", [sub])).toBe("console");
  for (const sub of ["list", "show", "resolve"]) expect(classifyPeerCommand("queue", [sub])).toBe("console");
  for (const command of ["say", "status", "board", "report", "turns", "review", "remember", "help", "version", "facts", "check-path"]) expect(classifyPeerCommand(command, [])).toBe("allowed");
  expect(classifyPeerCommand("task", ["propose"])).toBe("allowed");
  expect(classifyPeerCommand("task", ["show"])).toBe("allowed");
  expect(classifyPeerCommand("route", ["explain"])).toBe("allowed");
  expect(classifyPeerCommand("budget", [])).toBe("allowed");
  expect(classifyPeerCommand("say", ["--as-user", "hello"])).toBe("console");
  expect(classifyPeerCommand("status", ["--as-user=true"])).toBe("console");
});

test("starts, holds and assignment require daemon conductor authority, never an environment flag", () => {
  for (const command of ["claude", "codex", "kimi", "pi", "local", "pause", "resume"]) expect(classifyPeerCommand(command, [])).toBe("conductor");
  for (const sub of ["assign", "escalate"]) expect(classifyPeerCommand("task", [sub])).toBe("conductor");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "kimi", AGENTHUB_CONDUCTOR: "true" })).toEqual({ role: "tools", peer: "kimi" });
});

test("audit labels and human-action hints contain command names only", () => {
  expect(cliCommandLabel("say", ["private-text"])).toBe("say");
  expect(cliCommandLabel("task", ["private-text"])).toBe("task");
  expect(cliCommandLabel("task", ["assign", "42", "private-text"])).toBe("task assign");
  expect(cliCommandLabel("malformed\ncommand", [])).toBe("unknown");
  expect(cliCommandLabel("permit\n", [])).toBe("unknown");
  expect(peerCommandRefusal("claude", "permit")).toContain("ahub console or a terminal");
});
