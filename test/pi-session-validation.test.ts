import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PiSessionUnresumable, validatePiSession } from "../src/pi/session.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-pi-session-validation-")));
  roots.push(cwd);
  const stateDir = join(cwd, ".agenthub", "state"), directory = join(stateDir, "pi-sessions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "preserved.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "preserved-id", cwd }) + "\n", { mode: 0o600 });
  return { cwd, stateDir, file };
}

test("#166 a valid session with another recorded id is a bookmark mismatch, not an unresumable conversation", () => {
  const f = fixture();
  let failure: unknown;
  try { validatePiSession(f.stateDir, f.cwd, f.file, "stale-bookmark-id"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(PiSessionUnresumable);
  expect(failure).toMatchObject({ code: "pi_session_bookmark_mismatch", reason: "bookmark_mismatch" });
  expect(validatePiSession(f.stateDir, f.cwd, f.file, "preserved-id")).toEqual({ sessionId: "preserved-id", sessionFile: f.file });
});

test("#166 malformed session evidence remains unresumable instead of becoming a bookmark mismatch", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ type: "message", id: "preserved-id", cwd: f.cwd }) + "\n");
  expect(() => validatePiSession(f.stateDir, f.cwd, f.file, "other-id")).toThrow(PiSessionUnresumable);
});

test("#166 an uncertain session read remains an ordinary storage failure", () => {
  const f = fixture();
  rmSync(f.file); mkdirSync(f.file);
  let failure: unknown;
  try { validatePiSession(f.stateDir, f.cwd, f.file, "preserved-id"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(PiSessionUnresumable);
  expect(failure).not.toMatchObject({ code: "pi_session_bookmark_mismatch" });
});
