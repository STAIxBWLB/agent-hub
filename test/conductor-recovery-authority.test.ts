import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { issueConductorRecoveryAuthority, authorizeConductorRecovery, assertConductorRecovery, retireConductorRecovery, RecoveryAuthorityError, type ConductorRecoveryBinding, type VerifiedRecoveryAuthority } from "../src/hub/recovery-authority.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-recovery-"))); roots.push(root);
  const stateDir = join(root, "state"), targetRoot = join(root, "target"); mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(targetRoot, { mode: 0o700 });
  const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "builder", kind: "restart", projectId: "p_fixture", projectRoot: root,
    stateDir, sourceInstanceId: crypto.randomUUID(), targetRoot, targetDigest: "a".repeat(64), planFingerprint: "b".repeat(64), policyDigest: "c".repeat(64), boardDigest: "d".repeat(64) };
  const key = join(stateDir, "conductor-recovery.key"), record = join(stateDir, `conductor-recovery.${binding.operationId}.json`);
  return { root, stateDir, targetRoot, binding, key, record };
}
function issued() { const f = fixture(); issueConductorRecoveryAuthority(f.stateDir, f.binding, () => true); return f; }
const refuses = (work: () => unknown) => expect(work).toThrow(RecoveryAuthorityError);

test("source issuance creates private sealed continuity and verification still requires current host authority", () => {
  const f = issued(); let valid = true, checks = 0;
  const authority = authorizeConductorRecovery(f.stateDir, f.binding, value => { checks++; expect(value).toEqual(f.binding); return valid; });
  expect(Object.keys(authority)).toEqual(["binding"]); expect(Object.isFrozen(authority)).toBe(true); expect(Object.isFrozen(authority.binding)).toBe(true);
  expect(authority.binding).toEqual(f.binding); assertConductorRecovery(authority); expect(checks).toBe(2);
  valid = false; refuses(() => assertConductorRecovery(authority));
  expect(readdirSync(f.stateDir).sort()).toEqual([`conductor-recovery.${f.binding.operationId}.json`, "conductor-recovery.key"].sort());
  const stored = JSON.parse(readFileSync(f.record, "utf8"));
  expect(Object.keys(stored).sort()).toEqual(["binding", "retired", "seal"]); expect(stored.retired).toBe(false); expect(stored.seal).toMatch(/^[a-f0-9]{64}$/);
});

test("a verifier never provisions missing authority and source issue refuses before writing without proof", () => {
  const f = fixture();
  refuses(() => authorizeConductorRecovery(f.stateDir, f.binding, () => true));
  refuses(() => issueConductorRecoveryAuthority(f.stateDir, f.binding, () => false));
  expect(readdirSync(f.stateDir)).toEqual([]);
});

test("the same source binding is idempotent but a different actor or operation binding cannot overwrite it", () => {
  const f = issued(), before = readFileSync(f.record);
  issueConductorRecoveryAuthority(f.stateDir, f.binding, () => true); expect(readFileSync(f.record)).toEqual(before);
  refuses(() => issueConductorRecoveryAuthority(f.stateDir, { ...f.binding, peer: "foreign" }, () => true));
  expect(readFileSync(f.record)).toEqual(before);
});

for (const field of ["peer", "operationId", "kind", "projectId", "projectRoot", "stateDir", "sourceInstanceId", "targetRoot", "targetDigest", "planFingerprint", "policyDigest", "boardDigest"] as const) {
  test(`continuity verification refuses a changed ${field} before the host policy callback`, () => {
    const f = issued(), replacement = field === "operationId" || field === "sourceInstanceId" ? crypto.randomUUID()
      : field === "kind" ? "upgrade" : field === "projectRoot" ? f.targetRoot : field === "stateDir" ? f.targetRoot : field === "targetRoot" ? f.root
      : ["targetDigest", "planFingerprint", "policyDigest", "boardDigest"].includes(field) ? "e".repeat(64) : "foreign";
    let checks = 0;
    refuses(() => authorizeConductorRecovery(f.stateDir, { ...f.binding, [field]: replacement }, () => { checks++; return true; }));
    expect(checks).toBe(0); expect(existsSync(f.key)).toBe(true);
  });
}

test("public actor/audit claims, a carried key and an invented opaque object grant no continuity", () => {
  const f = issued(), value = JSON.parse(readFileSync(f.record, "utf8"));
  value.binding.peer = "foreign"; writeFileSync(f.record, JSON.stringify(value));
  refuses(() => authorizeConductorRecovery(f.stateDir, { ...f.binding, peer: "foreign" }, () => true));
  value.key = "not-a-trust-pin"; writeFileSync(f.record, JSON.stringify(value));
  refuses(() => authorizeConductorRecovery(f.stateDir, { ...f.binding, peer: "foreign" }, () => true));
  refuses(() => assertConductorRecovery({ binding: f.binding } as VerifiedRecoveryAuthority));
});

for (const file of ["key", "record"] as const) for (const change of ["symlink", "hardlink", "mode", "size"] as const) {
  test(`${file} ${change} substitution fails closed without trusting payload-selected files`, () => {
    const f = issued(), path = f[file];
    if (change === "symlink") { renameSync(path, `${path}.original`); symlinkSync(`${path}.original`, path); }
    if (change === "hardlink") linkSync(path, `${path}.alias`);
    if (change === "mode") chmodSync(path, 0o644);
    if (change === "size") writeFileSync(path, Buffer.alloc(file === "key" ? 33 : 16385));
    refuses(() => authorizeConductorRecovery(f.stateDir, f.binding, () => true));
  });
}

test("same bytes at a replaced private-key inode revoke an already verified continuation", () => {
  const f = issued(), authority = authorizeConductorRecovery(f.stateDir, f.binding, () => true), key = readFileSync(f.key);
  renameSync(f.key, `${f.key}.old`); writeFileSync(f.key, key, { mode: 0o600 });
  refuses(() => assertConductorRecovery(authority));
});

test("changing private state during the fresh host policy check is fenced before an effect", () => {
  const f = issued(), authority = authorizeConductorRecovery(f.stateDir, f.binding, () => true);
  refuses(() => authorizeConductorRecovery(f.stateDir, f.binding, () => { renameSync(f.record, `${f.record}.old`); writeFileSync(f.record, readFileSync(`${f.record}.old`), { mode: 0o600 }); return true; }));
  refuses(() => assertConductorRecovery(authority));
});

test("sealed retirement is terminal even if an old operation receipt or original actor is replayed", () => {
  const f = issued(), authority = authorizeConductorRecovery(f.stateDir, f.binding, () => true);
  retireConductorRecovery(authority);
  expect(JSON.parse(readFileSync(f.record, "utf8")).retired).toBe(true);
  refuses(() => assertConductorRecovery(authority));
  refuses(() => authorizeConductorRecovery(f.stateDir, f.binding, () => true));
  refuses(() => issueConductorRecoveryAuthority(f.stateDir, f.binding, () => true));
});

test("callback errors never expose private diagnostics or turn unknown policy into a proof", () => {
  const f = issued(); let failure: unknown;
  try { authorizeConductorRecovery(f.stateDir, f.binding, () => { throw new Error("PRIVATE_ROLE_CANARY"); }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RecoveryAuthorityError); expect(String(failure)).not.toContain("PRIVATE_ROLE_CANARY");
  refuses(() => authorizeConductorRecovery(f.stateDir, f.binding, () => undefined as unknown as boolean));
});
