import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PiPeer } from "../src/adapters/pi.ts";
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

test("#166 ordinary recorded Pi starts report a neutral header mismatch without claiming a bookmark exists", async () => {
  const f = fixture();
  let failure: unknown;
  const peer = new PiPeer("pi", { cwd: f.cwd, stateDir: f.stateDir, sessionFile: f.file, sessionId: "ordinary-requested-id", mode: "headless", backend: "dgx",
    cmd: ["must-never-spawn-for-invalid-session"], relay: { url: "http://127.0.0.1:9", token: "fixture", models: [] }, tools: [], executeTool: async () => "fixture" });
  try { await peer.start(); } catch (error) { failure = error; }
  expect(peer.state).toBe("offline");
  expect((failure as Error).message).toBe("Pi session header id does not match the requested session");
  expect((failure as Error).message).not.toContain("bookmark");
  expect(failure).toMatchObject({ code: "pi_session_bookmark_mismatch", reason: "bookmark_mismatch" });
});
