import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { AUTONOMY_CONSENT_DIR, AUTONOMY_CONSENT_FILE, AUTONOMY_CONSENT_KEY_FILE, createAutonomyConsent, type AutonomyConsentValues } from "../src/hub/autonomy-consent.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-autonomy-consent-")); roots.push(root);
  const state = join(root, "state"), privateDir = join(state, AUTONOMY_CONSENT_DIR), file = join(privateDir, AUTONOMY_CONSENT_FILE), key = join(privateDir, AUTONOMY_CONSENT_KEY_FILE);
  return { root, state, privateDir, file, key, consent: createAutonomyConsent(state, "project-one") };
}
const values = (): AutonomyConsentValues => ({
  codex: { "permission_modes.codex": "never-ask" },
  kimi: { "permission_modes.kimi": "never-ask", "permission.kimi": "never-ask" },
});
const peers = (set: Set<string>) => [...set].sort();

test("missing state or a bare forged row never issues a key or an approval", () => {
  const p = fixture();
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  expect(existsSync(p.state)).toBe(false);
  mkdirSync(p.state, { mode: 0o755 }); mkdirSync(p.privateDir, { mode: 0o700 });
  writeFileSync(p.file, JSON.stringify({ version: 1, project: "project-one", peers: [{ peer: "codex", digest: "a".repeat(64), mac: "b".repeat(64) }] }), { mode: 0o600 });
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  expect(existsSync(p.key)).toBe(false);
});

test("console confirmation persists across restart, binds project and canonical key order, and stores no raw values", () => {
  const p = fixture(); p.consent.confirm(values());
  const reordered = { kimi: { "permission.kimi": "never-ask", "permission_modes.kimi": "never-ask" }, codex: { "permission_modes.codex": "never-ask" } };
  expect(peers(createAutonomyConsent(p.state, "project-one").confirmed(reordered, true))).toEqual(["codex", "kimi"]);
  expect(peers(createAutonomyConsent(p.state, "project-two").confirmed(values(), true))).toEqual([]);
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["codex", "kimi"]); // Another project did not erase this one.
  expect(readFileSync(p.file, "utf8")).not.toContain("never-ask");
  expect(lstatSync(p.file).mode & 0o777).toBe(0o600);
  expect(lstatSync(p.key).mode & 0o777).toBe(0o600);
  expect(lstatSync(p.key).nlink).toBe(1);
});

test("one hand-edited peer loses consent while unchanged peers retain it; reverting needs a new confirmation", () => {
  const p = fixture(); p.consent.confirm(values());
  const edited = values(); edited.codex!["permission_modes.codex"] = "ask-when-needed";
  expect(peers(p.consent.confirmed(edited, true))).toEqual(["kimi"]);
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["kimi"]);
  p.consent.confirm(values());
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["codex", "kimi"]);
});

test("untrusted config revokes records and key, so restoring trust cannot revive old consent", () => {
  const p = fixture(); p.consent.confirm(values());
  const old = readFileSync(p.file), edited = values(); edited.codex!["permission_modes.codex"] = "ask";
  expect(peers(p.consent.confirmed(edited, false))).toEqual([]);
  expect(existsSync(p.file)).toBe(false); expect(existsSync(p.key)).toBe(false);
  writeFileSync(p.file, old, { mode: 0o600 });
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  expect(existsSync(p.key)).toBe(false);
});

test("a truthy non-boolean trust claim is not host trust", () => {
  const p = fixture(); p.consent.confirm(values());
  expect(peers(p.consent.confirmed(values(), "true" as unknown as boolean))).toEqual([]);
  expect(existsSync(p.key)).toBe(false);
});

test("a forged row cannot reuse another peer's or project's MAC", () => {
  const p = fixture(); p.consent.confirm(values());
  const doc = JSON.parse(readFileSync(p.file, "utf8"));
  doc.peers[0].digest = doc.peers[1].digest; doc.peers[0].mac = doc.peers[1].mac;
  writeFileSync(p.file, JSON.stringify(doc));
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["kimi"]);
  p.consent.confirm(values());
  const moved = JSON.parse(readFileSync(p.file, "utf8")); moved.project = "project-two"; writeFileSync(p.file, JSON.stringify(moved));
  expect(peers(createAutonomyConsent(p.state, "project-two").confirmed(values(), true))).toEqual([]);
});

test("unsafe directory, file/key modes, symlinks and hardlinks fail closed without following a target", () => {
  for (const kind of ["directory-mode", "private-directory-mode", "file-mode", "key-mode", "file-symlink", "key-symlink", "file-hardlink", "key-hardlink"]) {
    const p = fixture(); p.consent.confirm(values());
    const target = kind.startsWith("key") ? p.key : p.file;
    if (kind === "directory-mode") chmodSync(p.state, 0o777);
    else if (kind === "private-directory-mode") chmodSync(p.privateDir, 0o755);
    else if (kind.endsWith("mode")) chmodSync(target, 0o644);
    else if (kind.endsWith("symlink")) {
      const copy = join(p.root, "target"); writeFileSync(copy, readFileSync(target), { mode: 0o600 }); rmSync(target); symlinkSync(copy, target);
    } else linkSync(target, join(p.root, "alias"));
    expect(peers(p.consent.confirmed(values(), true)), kind).toEqual([]);
    expect(() => p.consent.confirm(values()), kind).toThrow("autonomy consent is unavailable");
  }
});

test("bounded and malformed state never grants consent or reflects raw state data in an error", () => {
  const p = fixture(); p.consent.confirm(values());
  writeFileSync(p.file, "private-canary-".repeat(6000));
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  expect(() => p.consent.confirm(values())).toThrow("autonomy consent is unavailable");
  rmSync(p.file);
  const malformed = { codex: { "arbitrary.secret-key": "private-canary" } };
  try { p.consent.confirm(malformed); throw new Error("expected refusal"); }
  catch (error) { expect((error as Error).message).toBe("autonomy consent is unavailable"); }
});

test("off or whole-preset undo can clear approvals; reads after clear cannot recreate them", () => {
  const p = fixture(); p.consent.confirm(values()); p.consent.clear();
  expect(existsSync(p.file)).toBe(false);
  expect(existsSync(p.key)).toBe(false);
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  expect(existsSync(p.file)).toBe(false);
  p.consent.clear(); // Idempotent, without creating approval records.
  expect(peers(createAutonomyConsent(p.state, "project-one").confirmed(values(), true))).toEqual([]);
});


test("clear retires a key without a row, and a replay after fresh confirmation cannot authenticate", () => {
  const p = fixture(); p.consent.confirm(values());
  const old = readFileSync(p.file), originalKey = readFileSync(p.key);
  rmSync(p.file); p.consent.clear();
  expect(existsSync(p.key)).toBe(false);
  writeFileSync(p.file, old, { mode: 0o600 });
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
  p.consent.confirm(values());
  expect(readFileSync(p.key).equals(originalKey)).toBe(false);
  writeFileSync(p.file, old);
  expect(peers(p.consent.confirmed(values(), true))).toEqual([]);
});

test("permission consent rejects kind, start and policy fields rather than coupling them to approval", () => {
  const p = fixture();
  for (const key of ["kind", "peers.codex.start_mode", "action_policy"]) {
    const unrelated = values(); unrelated.codex![key] = "private-canary";
    expect(() => p.consent.confirm(unrelated)).toThrow("autonomy consent is unavailable");
  }
  expect(existsSync(p.key)).toBe(false);
});

test("ownership and undo are separate authenticated purposes with exactly one digest payload", () => {
  const p = fixture(), own = createAutonomyConsent(p.state, "project-one", "ownership"), undo = createAutonomyConsent(p.state, "project-one", "undo");
  const metadata = { ownership: { digest: "a".repeat(64) } }, record = { undo: { digest: "a".repeat(64) } };
  own.confirm(metadata);
  expect(peers(own.confirmed(metadata, true))).toEqual(["ownership"]);
  expect(peers(undo.confirmed(record, true))).toEqual([]);
  expect(peers(p.consent.confirmed({ ownership: { "permission_modes.ownership": "never-ask" } }, true))).toEqual([]);
  expect(peers(own.confirmed(metadata, true))).toEqual(["ownership"]); // A mismatched purpose cannot erase this namespace.
  const doc = JSON.parse(readFileSync(p.file, "utf8")), row = doc.peers[0], secret = readFileSync(p.key);
  const signature = (purpose: string) => createHmac("sha256", secret).update(JSON.stringify(["agent-hub.autonomy-consent/v1", purpose, "project-one", row.peer, row.digest])).digest("hex");
  expect(row.mac).toBe(signature("ownership"));
  expect(row.mac).not.toBe(signature("permission"));
  doc.purpose = "undo"; row.peer = "undo"; writeFileSync(p.file, JSON.stringify(doc));
  expect(peers(undo.confirmed(record, true))).toEqual([]);
  undo.confirm(record);
  expect(peers(undo.confirmed(record, true))).toEqual(["undo"]);
  expect(peers(own.confirmed(metadata, true))).toEqual([]);
  expect(() => own.confirm(values())).toThrow("autonomy consent is unavailable");
  expect(() => undo.confirm(metadata)).toThrow("autonomy consent is unavailable");
});

test("an existing owner0755 hub state stays0755 while consent uses a private child", () => {
  const p = fixture(); mkdirSync(p.state, { mode: 0o755 });
  const before = lstatSync(p.state).mode & 0o777;
  p.consent.confirm(values());
  expect(lstatSync(p.state).mode & 0o777).toBe(before);
  expect(lstatSync(p.privateDir).mode & 0o777).toBe(0o700);
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["codex", "kimi"]);
});


test.skipIf(typeof process.getuid !== "function")("a host UID that does not own the existing state cannot read or confirm consent", () => {
  const p = fixture(); p.consent.confirm(values());
  const ownUid = process.getuid!(), uid = spyOn(process, "getuid").mockReturnValue(ownUid + 1);
  let other: ReturnType<typeof createAutonomyConsent>;
  try { other = createAutonomyConsent(p.state, "project-one"); } finally { uid.mockRestore(); }
  expect(peers(other!.confirmed(values(), true))).toEqual([]);
  expect(() => other!.confirm(values())).toThrow("autonomy consent is unavailable");
  expect(peers(p.consent.confirmed(values(), true))).toEqual(["codex", "kimi"]);
});
