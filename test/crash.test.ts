import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashPlan, lossNotice, readSessions, removeSessions, writeSessions } from "../src/hub/crash.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

// issue #37: what comes back after a crash, and what each peer is told it lost.
test("the plan resumes what the hub launches itself and says what the user reattaches", () => {
  const plan = crashPlan([
    { peer: "claude", meta: {} },
    { peer: "codex", meta: { threadId: "th1" } },
    { peer: "kimi", meta: { launch: { kind: "acp", model: "k2" }, sessionId: "s1" } },
    { peer: "pi", meta: { launch: { kind: "pi", mode: "headless", backend: "dgx" }, sessionFile: "/x/s.jsonl" } },
    { peer: "local", meta: { launch: { route: "sy/coding", model: "fallback" } } }, // the worker records both
    { peer: "kimi", meta: {} },
    { peer: "local", meta: { launch: { model: "pinned" } } },
    { peer: "pi", meta: { launch: { kind: "pi", mode: "tui" }, sessionFile: "/x/t.jsonl" } }, // the CLI ran it in a terminal
  ]);
  expect(plan.map((p) => p.resume)).toEqual([undefined, undefined, { sessionId: "s1", model: "k2" }, { sessionFile: "/x/s.jsonl", mode: "headless", backend: "dgx" }, { route: "sy/coding" }, undefined, { model: "pinned" }, undefined]);
  expect(plan[7]!.how).toBe("pi: it ran in a terminal; start it again with ahub pi --mode tui --session-file /x/t.jsonl");
  expect(plan[1]!.how).toBe("codex: its app-server died with the hub; run ahub codex again (its conversation was thread th1)");
  expect(plan[5]!.how).toBe("kimi: no session id was recorded; start it again with ahub kimi");
});

test("the loss notice lists deliveries by id, sender and public task title, never their text", () => {
  const env = (from: string, task?: string) => ({ ...newEnvelope(from, "secret body 900101-1234567"), ...(task ? { refs: { task } } : {}) });
  const text = lossNotice(
    [
      { id: "d1", peer: "kimi", state: "needs_review", revision: 2, createdAt: 0, updatedAt: 0, originals: [env("claude", "3"), env("hub", "4")], out: [] },
      { id: "d2", peer: "kimi", state: "needs_review", revision: 2, createdAt: 0, updatedAt: 0, originals: [env("user")], out: [] },
    ],
    (id) => (id === 4 ? "#4 [pii]" : `#${id} refactor`),
  );
  expect(text).toContain("- delivery d1 from claude, hub, about task #3 refactor, #4 [pii]");
  expect(text).toContain("- delivery d2 from user");
  expect(text).not.toContain("secret body");
});

test("the session record is removed only by the run that wrote it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-crash-"));
  writeSessions(dir, { instanceId: "new", at: 1, peers: [{ peer: "kimi", meta: { sessionId: "s1" } }] });
  removeSessions(dir, "old");
  expect(readSessions(dir)?.peers[0]!.peer).toBe("kimi");
  removeSessions(dir, "new");
  expect(existsSync(join(dir, "sessions.json"))).toBe(false);
  writeSessions(dir, { instanceId: "source", at: 1, peers: [] });
  removeSessions(dir); // a controlled restart's target clears whatever a cut-short source left
  expect(existsSync(join(dir, "sessions.json"))).toBe(false);
});
