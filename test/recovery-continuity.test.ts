import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";

interface Bookmark {
  schema: 1; operationId: string; projectId: string; projectRoot: string; at: number;
  pi: { sessionId: string; sessionFile?: string; backend?: "auto" | "dgx" | "mlx"; model?: string };
}
interface Expected { projectId: string; projectRoot: string; operationId?: string }
type Reading = { state: "absent" } | { state: "invalid"; reason: string } | { state: "ready"; bookmark: Bookmark; digest: string };
interface Api {
  writeRecoveryContinuity(stateDir: string, bookmark: Bookmark): { digest: string };
  readRecoveryContinuity(stateDir: string, expected: Expected): Reading;
  consumeRecoveryContinuity(stateDir: string, expected: Expected & { operationId: string; digest: string }): boolean;
  retireRecoveryContinuity(stateDir: string, expected: Expected & { operationId: string; digest: string }, reason: "authenticated_session_changed" | "resume_unavailable" | "recovery_released"): { retired: boolean; archive?: string };
}
const OP_A = "00000000-0000-4000-8000-000000000001", OP_B = "00000000-0000-4000-8000-000000000002";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const path = "../src/hub/recovery-continuity.ts";
  const module = await import(path).catch(() => undefined);
  expect(typeof module?.writeRecoveryContinuity).toBe("function");
  expect(typeof module?.readRecoveryContinuity).toBe("function");
  expect(typeof module?.consumeRecoveryContinuity).toBe("function");
  const api = module as Api, root = realPath(mkdtempSync(join(tmpdir(), "ahub-continuity-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project"), stateDir = join(root, "state");
  mkdirSync(projectRoot); mkdirSync(stateDir, { mode: 0o700 });
  const expected = { projectId: "fixture-project", projectRoot };
  const bookmark: Bookmark = { schema: 1, operationId: OP_A, ...expected, at: 1000, pi: { sessionId: "fixture-pi-A", sessionFile: join(root, "fixture-session.jsonl"), backend: "dgx", model: "fixture/model" } };
  return { api, root, stateDir, expected, bookmark, file: join(stateDir, "recovery-continuity.json") };
}

test("#463 continuity distinguishes absent from invalid and round-trips only bounded private project metadata", async () => {
  const f = await fixture();
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected)).toEqual({ state: "absent" });
  const wrote = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  const read = f.api.readRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A });
  expect(read).toEqual({ state: "ready", bookmark: f.bookmark, digest: wrote.digest });
  expect(wrote.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.file, "utf8")).not.toContain("transcript");
});

test("#463 continuity refuses a different project id, root or expected operation without treating it as absent", async () => {
  const f = await fixture(); f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  const otherRoot = join(f.root, "other"); mkdirSync(otherRoot);
  for (const expected of [{ ...f.expected, projectId: "other-project" }, { ...f.expected, projectRoot: otherRoot }, { ...f.expected, operationId: OP_B }]) {
    expect(f.api.readRecoveryContinuity(f.stateDir, expected).state).toBe("invalid");
  }
  expect(existsSync(f.file)).toBe(true);
});

test("#463 invalid, oversized and unknown-depth continuity evidence is never a fresh-start absence", async () => {
  const f = await fixture();
  for (const text of ["{", " ".repeat(16_385), JSON.stringify({ ...f.bookmark, token: "private-fixture-marker" }), JSON.stringify({ ...f.bookmark, pi: { ...f.bookmark.pi, nested: { deeper: { token: "private-fixture-marker" } } } })]) {
    writeFileSync(f.file, text, { mode: 0o600 });
    const read = f.api.readRecoveryContinuity(f.stateDir, f.expected);
    expect(read.state).toBe("invalid");
    expect(JSON.stringify(read)).not.toContain("private-fixture-marker");
  }
});

test("#463 writes validate identity, session fields and paths before replacing a valid bookmark", async () => {
  const f = await fixture(); f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  const before = readFileSync(f.file, "utf8");
  for (const bad of [{ operationId: "../other" }, { at: Infinity }, { pi: { sessionId: "" } }, { pi: { sessionId: "fixture\nforged" } }, { pi: { ...f.bookmark.pi, sessionFile: "relative/session.jsonl" } }, { pi: { ...f.bookmark.pi, backend: "other" } }, { pi: { ...f.bookmark.pi, model: "x".repeat(4097) } }]) {
    expect(() => f.api.writeRecoveryContinuity(f.stateDir, { ...f.bookmark, ...bad } as Bookmark)).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(before);
  }
});

test("#463 symlinked bookmarks and state directories fail closed without touching their targets", async () => {
  const f = await fixture(), target = join(f.root, "outside.json");
  writeFileSync(target, JSON.stringify(f.bookmark), { mode: 0o600 }); symlinkSync(target, f.file);
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected).state).toBe("invalid");
  expect(() => f.api.writeRecoveryContinuity(f.stateDir, f.bookmark)).toThrow();
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(f.bookmark);
  rmSync(f.file); const alias = join(f.root, "alias-state"); symlinkSync(f.stateDir, alias);
  expect(f.api.readRecoveryContinuity(alias, f.expected).state).toBe("invalid");
  expect(() => f.api.writeRecoveryContinuity(alias, f.bookmark)).toThrow();
});

test("#463 consume compares operation and exact digest and cannot delete a newer bookmark", async () => {
  const f = await fixture(), first = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  const later = { ...f.bookmark, operationId: OP_B, at: 2000, pi: { ...f.bookmark.pi, sessionId: "fixture-pi-B" } };
  const second = f.api.writeRecoveryContinuity(f.stateDir, later), before = readFileSync(f.file, "utf8");
  expect(f.api.consumeRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A, digest: first.digest })).toBe(false);
  expect(f.api.consumeRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_B, digest: first.digest })).toBe(false);
  expect(readFileSync(f.file, "utf8")).toBe(before);
  expect(f.api.consumeRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_B, digest: second.digest })).toBe(true);
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected)).toEqual({ state: "absent" });
  expect(f.api.consumeRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_B, digest: second.digest })).toBe(false);
});

test("#463 consume storage failure stays an error and preserves the bookmark", async () => {
  const f = await fixture(), wrote = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  const lock = join(f.stateDir, "recovery-continuity-lock.db"); rmSync(lock, { force: true }); mkdirSync(lock);
  expect(() => f.api.consumeRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A, digest: wrote.digest })).toThrow();
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected).state).toBe("ready");
});

test("#463 a symlinked SQLite continuity lock cannot redirect writes outside this project", async () => {
  const f = await fixture(), target = join(f.root, "outside.db"); writeFileSync(target, "fixture untouched");
  symlinkSync(target, join(f.stateDir, "recovery-continuity-lock.db"));
  expect(() => f.api.writeRecoveryContinuity(f.stateDir, f.bookmark)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("fixture untouched");
  expect(existsSync(f.file)).toBe(false);
});

test("#463 world-readable continuity metadata is invalid rather than silently trusted", async () => {
  const f = await fixture(); f.api.writeRecoveryContinuity(f.stateDir, f.bookmark); chmodSync(f.file, 0o644);
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected).state).toBe("invalid");
});

test("#463 retirement archives the exact private bookmark under a structured reason without deleting its evidence", async () => {
  const f = await fixture(), wrote = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  expect(typeof f.api.retireRecoveryContinuity).toBe("function");
  const before = readFileSync(f.file, "utf8");
  const retired = f.api.retireRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A, digest: wrote.digest }, "authenticated_session_changed");
  expect(retired.retired).toBe(true); expect(retired.archive).toContain("authenticated_session_changed");
  expect(readFileSync(retired.archive!, "utf8")).toBe(before);
  expect(statSync(retired.archive!).mode & 0o777).toBe(0o600);
  expect(f.api.readRecoveryContinuity(f.stateDir, f.expected)).toEqual({ state: "absent" });
});

test("#463 retirement CAS retains a newer bookmark and invalid evidence remains fail closed", async () => {
  const f = await fixture(), first = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  expect(typeof f.api.retireRecoveryContinuity).toBe("function");
  f.api.writeRecoveryContinuity(f.stateDir, { ...f.bookmark, operationId: OP_B, at: 2000 });
  const before = readFileSync(f.file, "utf8");
  expect(f.api.retireRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A, digest: first.digest }, "recovery_released")).toEqual({ retired: false });
  expect(readFileSync(f.file, "utf8")).toBe(before);
  writeFileSync(f.file, "{", { mode: 0o600 });
  expect(() => f.api.retireRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_B, digest: first.digest }, "resume_unavailable")).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe("{");
});

test("#463 retirement never overwrites unrelated archived evidence at its preferred archive name", async () => {
  const f = await fixture(), wrote = f.api.writeRecoveryContinuity(f.stateDir, f.bookmark);
  expect(typeof f.api.retireRecoveryContinuity).toBe("function");
  const occupied = join(f.stateDir, `recovery-continuity.retired.resume_unavailable.${wrote.digest}.json`);
  writeFileSync(occupied, "unrelated preserved evidence", { mode: 0o600 });
  const retired = f.api.retireRecoveryContinuity(f.stateDir, { ...f.expected, operationId: OP_A, digest: wrote.digest }, "resume_unavailable");
  expect(retired.retired).toBe(true); expect(retired.archive).not.toBe(occupied);
  expect(readFileSync(occupied, "utf8")).toBe("unrelated preserved evidence");
  expect(JSON.parse(readFileSync(retired.archive!, "utf8"))).toEqual(f.bookmark);
});

test("#463 Pi session validation classifies proven unresumable evidence but keeps storage I/O uncertain", async () => {
  const path = "../src/pi/session.ts", module = await import(path);
  expect(typeof module.PiSessionUnresumable).toBe("function");
  const f = await fixture(), sessions = join(f.stateDir, "pi-sessions"); mkdirSync(sessions);
  const invalid = join(sessions, "invalid.jsonl"), mismatch = join(sessions, "mismatch.jsonl"), io = join(sessions, "directory.jsonl"), outside = join(f.root, "outside.jsonl");
  writeFileSync(invalid, "{"); writeFileSync(mismatch, JSON.stringify({ type: "session", id: "another", cwd: f.expected.projectRoot })); mkdirSync(io); writeFileSync(outside, "{}");
  for (const [file, reason] of [[join(sessions, "missing.jsonl"), "missing"], [outside, "outside_managed"], [invalid, "invalid_header"]] as const) {
    let error: unknown; try { module.validatePiSession(f.stateDir, f.expected.projectRoot, file, "expected"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(module.PiSessionUnresumable);
    expect((error as { reason: string }).reason).toBe(reason);
  }
  let mismatchError: unknown;
  try { module.validatePiSession(f.stateDir, f.expected.projectRoot, mismatch, "expected"); } catch (caught) { mismatchError = caught; }
  expect(mismatchError).toBeInstanceOf(module.PiSessionBookmarkMismatch);
  expect(mismatchError).not.toBeInstanceOf(module.PiSessionUnresumable);
  expect((mismatchError as { reason: string }).reason).toBe("bookmark_mismatch");
  expect((mismatchError as Error).message).toBe("Pi continuity bookmark does not match the preserved session");
  expect(module.validatePiSession(f.stateDir, f.expected.projectRoot, mismatch, "another")).toEqual({ sessionFile: mismatch, sessionId: "another" });
  let error: unknown; try { module.validatePiSession(f.stateDir, f.expected.projectRoot, io, "expected"); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(module.PiSessionUnresumable);
});
