import { expect, test } from "bun:test";
import { classifyPeerCommand, cliCommandLabel, detectCliIdentity, liveTestRefusal, peerCommandRefusal } from "../src/cli/identity.ts";

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
  expect(classifyPeerCommand("queue", ["list"])).toBe("console");
  for (const sub of ["show", "resolve", "discard"]) expect(classifyPeerCommand("queue", [sub])).toBe("conductor");
  for (const command of ["say", "status", "board", "report", "turns", "review", "remember", "help", "version", "facts", "check-path"]) expect(classifyPeerCommand(command, [])).toBe("allowed");
  expect(classifyPeerCommand("task", ["propose"])).toBe("allowed");
  expect(classifyPeerCommand("task", ["show"])).toBe("allowed");
  expect(classifyPeerCommand("task", ["unassign"])).toBe("console");
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
  expect(cliCommandLabel("stop", ["private-peer"])).toBe("stop");
  for (const args of [[], ["pi", "--as-user"]]) expect(classifyPeerCommand("stop", args)).toBe("console");
  expect(classifyPeerCommand("stop", ["pi"])).toBe("conductor");
  expect(cliCommandLabel("task", ["private-text"])).toBe("task");
  expect(cliCommandLabel("task", ["assign", "42", "private-text"])).toBe("task assign");
  expect(cliCommandLabel("task", ["unassign", "42"])).toBe("task unassign");
  expect(cliCommandLabel("malformed\ncommand", [])).toBe("unknown");
  expect(cliCommandLabel("permit\n", [])).toBe("unknown");
  expect(peerCommandRefusal("claude", "permit")).toContain("ahub console or a terminal");
});

 test("permission is human-only even with --as-user or conductor markers (#242)", () => {
  for (const args of [[], ["pi"], ["pi", "never-ask", "--yes"], ["pi", "never-ask", "--yes", "--as-user"]]) expect(classifyPeerCommand("permission", args)).toBe("console");
  expect(cliCommandLabel("permission", ["private-peer"])).toBe("permission");
});

test("roster mutation requires conductor authority while direct roster settings stay person-only (#812)", () => {
  for (const args of [[], ["--json"]]) expect(classifyPeerCommand("roster", args)).toBe("console");
  for (const args of [["add", "kimi"], ["remove", "kimi", "--yes", "--now"]]) expect(classifyPeerCommand("roster", args)).toBe("conductor");
  for (const args of [["set", "roster.kimi", "true"], ["set", "roster.kimi", "false", "--yes"]]) expect(classifyPeerCommand("settings", args)).toBe("console");
});

test("structural config edits and their backups are human-only for an agent identity (#689)", () => {
  for (const args of [["edit", "config.local.json", "set", "review.pool", "[]"], ["edit", "sdlc.toml", "set", "mode", "\"off\"", "--yes"], ["edit", "config.local.json", "set", "instances.jcode-two.model", "\"m\"", "--as-user"], ["backups"], ["backups", "--json"]]) expect(classifyPeerCommand("settings", args)).toBe("console");
});


test("memory dedupe listing and apply are console-only and audit-labeled without note text (#380)", () => {
  for (const args of [["dedupe"], ["dedupe", "--json"], ["dedupe", "--apply"], ["dedupe", "--apply", "--as-user"]]) {
    expect(classifyPeerCommand("memory", args)).toBe("console");
    expect(cliCommandLabel("memory", args)).toBe("memory dedupe");
  }
});

test("explicit Pi history replacement is a person-only CLI command", () => {
  expect(classifyPeerCommand("pi", ["--replace-session", "--session-file", "preserved.jsonl"])).toBe("console");
});

test("AC6: console refusal explains inherited markers and bang commands (#434)", () => {
  const refusal = peerCommandRefusal("claude", "queue");
  expect(refusal).toContain("inherited agent markers");
  expect(refusal).toContain("! command");
  expect(refusal).toContain("separate terminal");
  expect(refusal).toContain("ahub console");
});


test("console refusal names only identity markers actually present, never their values (#434 follow-up)", () => {
  const markerOnly = peerCommandRefusal("codex", "queue", { CODEX_THREAD_ID: "private-thread-marker" });
  expect(markerOnly).toContain("CODEX_THREAD_ID");
  expect(markerOnly).not.toContain("CLAUDECODE");
  expect(markerOnly).not.toContain("AGENTHUB_PEER_ID");
  expect(markerOnly).not.toContain("private-thread-marker");
  const combined = peerCommandRefusal("claude", "queue", { CLAUDECODE: "1", AGENTHUB_PEER_ID: "private-peer-marker" });
  expect(combined).toContain("CLAUDECODE"); expect(combined).toContain("AGENTHUB_PEER_ID");
  expect(combined).not.toContain("CODEX_THREAD_ID"); expect(combined).not.toContain("private-peer-marker");
  const empty = peerCommandRefusal("claude", "queue", {});
  for (const marker of ["CLAUDECODE", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID"]) expect(empty).not.toContain(marker);
});


test("release authorization stays person-only while exact release preflights are peer reads", () => {
  expect(classifyPeerCommand("sdlc", ["authorize-release", "1.2.3"])).toBe("console");
  expect(liveTestRefusal("sdlc", ["authorize-release", "1.2.3"])).toBe(true);
  for (const sub of ["release-guard", "release-guard-hook"]) expect(classifyPeerCommand("sdlc", [sub])).toBe("allowed");
  for (const sub of ["record", "accept", "plan-review", "unknown"]) expect(classifyPeerCommand("sdlc", [sub])).toBe("console");
});
