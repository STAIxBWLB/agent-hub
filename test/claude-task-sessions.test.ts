import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeTaskSessions } from "../src/adapters/claude-task-sessions.ts";
import { claudeStateFile, transcriptPersisted } from "../src/hub/claude-state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-task-sessions-")); roots.push(root);
  const file = join(root, claudeStateFile("claude-session", "claude-impl"));
  return { root, file, store: new ClaudeTaskSessions(file) };
}

test("#525 task session first turn persists a UUID; later turns and restart resume only that task", () => {
  const f = fixture(), first = f.store.session(41), other = f.store.session(42);
  expect(first).toMatchObject({ persistent: true, resume: false });
  expect(other.sessionId).not.toBe(first.sessionId);
  expect(f.store.session(41)).toEqual(first); // A failed pre-spawn start retains its proposed identity.
  expect(f.store.markStarted(41, first.sessionId)).toBe(true);
  expect(new ClaudeTaskSessions(f.file).session(41)).toEqual({ ...first, resume: true });
  expect(new ClaudeTaskSessions(f.file).session(42)).toEqual(other);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.root)).toEqual([claudeStateFile("claude-session", "claude-impl")]);
  const raw = JSON.parse(readFileSync(f.file, "utf8"));
  expect(Object.keys(raw.sessions)).toEqual(["41", "42"]);
  expect(Object.keys(raw.sessions["41"]).sort()).toEqual(["sessionId", "started"]);
});

test("#525 unscoped chat gets distinct ephemeral sessions without changing persisted task state", () => {
  const f = fixture(); f.store.session(7);
  const before = readFileSync(f.file, "utf8"), a = f.store.session(), b = f.store.session();
  expect(a).toMatchObject({ persistent: false, resume: false });
  expect(b.sessionId).not.toBe(a.sessionId);
  expect(readFileSync(f.file, "utf8")).toBe(before);
});

test("#525 only a positively missing transcript retires the matching task session; stale children cannot mark it", () => {
  const f = fixture(), first = f.store.session(7);
  f.store.markStarted(7, first.sessionId);
  const before = readFileSync(f.file, "utf8");
  const reported = { sessionId: first.sessionId, transcriptPath: "/fixture/transcript" };
  expect(transcriptPersisted(reported, first.sessionId, true, "", () => "unknown")).toBe(true);
  expect(new ClaudeTaskSessions(f.file).session(7).sessionId).toBe(first.sessionId);
  expect(readFileSync(f.file, "utf8")).toBe(before);
  expect(transcriptPersisted(reported, first.sessionId, true, "", () => false)).toBe(false);
  expect(f.store.forgetMissing(7, "stale-id")).toBe(false);
  expect(f.store.forgetMissing(7, first.sessionId)).toBe(true);
  const fresh = f.store.session(7);
  expect(fresh.sessionId).not.toBe(first.sessionId);
  expect(fresh.resume).toBe(false);
  expect(f.store.markStarted(7, first.sessionId)).toBe(false);
  expect(f.store.forgetMissing(7, first.sessionId)).toBe(false);
  expect(f.store.session(7)).toEqual(fresh);
});

for (const raw of ["{", '{"version":2,"sessions":{}}', '{"version":1,"sessions":{"7":{"sessionId":"invalid","started":true}}}', '{"version":1,"sessions":{},"taskText":"must refuse"}']) test("#525 malformed state fails closed without replacing its bytes: " + raw.slice(0, 20), () => {
  const f = fixture(); writeFileSync(f.file, raw);
  expect(() => new ClaudeTaskSessions(f.file)).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe(raw);
});

test("#525 non-ENOENT state read errors fail closed, and task ids are validated", () => {
  const f = fixture(); mkdirSync(f.file);
  expect(() => new ClaudeTaskSessions(f.file)).toThrow();
  for (const id of [0, -1, 1.5, NaN, Infinity]) expect(() => f.store.session(id)).toThrow("task id");
});

test("#525 a failed atomic write leaves the previous in-memory session state intact", () => {
  const f = fixture(), first = f.store.session(7), bytes = readFileSync(f.file, "utf8");
  rmSync(f.file); mkdirSync(f.file);
  expect(() => f.store.markStarted(7, first.sessionId)).toThrow();
  expect(f.store.session(7)).toEqual(first);
  expect(readdirSync(f.root)).toEqual([claudeStateFile("claude-session", "claude-impl")]);
  rmSync(f.file, { recursive: true }); writeFileSync(f.file, bytes);
  expect(f.store.markStarted(7, first.sessionId)).toBe(true);
  expect(f.store.session(7).resume).toBe(true);
});
