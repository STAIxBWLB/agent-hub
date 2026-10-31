import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomyOwnership, autonomyOwnershipDigest, autonomyUndoKeys, undoSetting, writeAutonomyPreset } from "../src/hub/settings.ts";
import { createAutonomyConsent } from "../src/hub/autonomy-consent.ts";
import { validateRawConfig } from "../src/hub/config-apply.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(local: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-autonomy-write-")); roots.push(cwd);
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), "{}\n");
  const file = join(cwd, ".agenthub/config.local.json"), state = join(cwd, "state");
  writeFileSync(file, JSON.stringify(local));
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const validate = (scratch: string) => validateRawConfig(JSON.parse(readFileSync(join(scratch, ".agenthub/config.local.json"), "utf8")));
  const witness = createAutonomyConsent(join(cwd, "private-witness"), "fixture-project", "ownership");
  const values = (digest: string) => ({ ownership: { digest } });
  const authorize = (metadata: unknown) => { const digest = autonomyOwnershipDigest(metadata); return !!digest && witness.confirmed(values(digest), true).has("ownership"); };
  const seal = (metadata: unknown) => { const digest = autonomyOwnershipDigest(metadata); if (digest) witness.confirm(values(digest)); else witness.clear(); };
  return { cwd, file, state, read, validate, authorize, seal };
}
function apply(p: ReturnType<typeof fixture>, enabled: boolean, operations: { key: string; value: unknown }[], validate = p.validate) {
  const result = writeAutonomyPreset(p.cwd, p.state, enabled, operations, validate, p.authorize);
  if (result.changed) p.seal(result.ownership);
  return result;
}
const operations = [{ key: "permission_modes.codex", value: "never-ask" }, { key: "tasks.auto_pull", value: true }];

test("on retains precise originals for undo; off removes fixed keys including prior manual values", () => {
  const p = fixture({ permission_modes: { codex: "ask-when-needed" }, tasks: { auto_pull: true }, approvals: { notify: false } });
  const before = readFileSync(p.file, "utf8");
  expect(apply(p, true, operations, p.validate).keys).toEqual(["permission_modes.codex"]);
  expect(autonomyOwnership(p.read()._autonomy)).toHaveLength(1);
  expect(autonomyUndoKeys(p.state)).toEqual(["permission_modes.codex"]);
  undoSetting(p.cwd, p.state, p.validate);
  expect(readFileSync(p.file, "utf8")).toBe(before);
  apply(p, true, operations, p.validate);
  expect(apply(p, true, operations, p.validate).changed).toBe(false);
  apply(p, false, operations, p.validate);
  expect(p.read()).toEqual({ approvals: { notify: false } });
  undoSetting(p.cwd, p.state, p.validate);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(p.read()._autonomy).toBeDefined();
});

test("off removes requested preset leaves despite later manual edits and preserves unrelated fields", () => {
  const p = fixture();
  apply(p, true, operations, p.validate);
  const edited = p.read(); edited.permission_modes.codex = "ask"; edited.approvals = { notify: false };
  writeFileSync(p.file, JSON.stringify(edited));
  const result = apply(p, false, operations, p.validate);
  expect(result.preserved).toEqual([]);
  expect(result.keys).toEqual(["permission_modes.codex", "tasks.auto_pull"]);
  expect(p.read()).toEqual({ approvals: { notify: false } });
});

test("a failed validation or changed input writes no preset and never offers an undo for a partial write", () => {
  const p = fixture(), before = readFileSync(p.file, "utf8");
  expect(() => apply(p, true, operations, () => { throw new Error("refused"); })).toThrow("refused");
  expect(readFileSync(p.file, "utf8")).toBe(before);
  expect(() => autonomyUndoKeys(p.state)).toThrow();
  expect(() => apply(p, true, operations, () => { writeFileSync(p.file, '{"approvals":{"notify":false}}'); })).toThrow("changed during");
  expect(p.read()).toEqual({ approvals: { notify: false } });
});

test("undo after a hand edit refuses; off ignores forged ownership keys", () => {
  const p = fixture();
  apply(p, true, operations, p.validate);
  writeFileSync(p.file, JSON.stringify({ ...p.read(), approvals: { notify: false } }));
  expect(() => undoSetting(p.cwd, p.state, p.validate)).toThrow("changed since");
  expect(() => autonomyOwnership({ version: 1, owned: [{ key: "constructor.prototype", previous: null, written: true }] })).toThrow();
  const edited = p.read(); edited._autonomy.owned[0].key = "research.enabled";
  writeFileSync(p.file, JSON.stringify(edited));
  edited.research = { enabled: false }; writeFileSync(p.file, JSON.stringify(edited));
  apply(p, false, operations, p.validate);
  expect(p.read()).toEqual({ approvals: { notify: false }, research: { enabled: false } });
});

test("reapplying on admits new targets and changed environment defaults without losing originals or later edits", () => {
  const p = fixture({ permission_modes: { codex: "ask" } });
  apply(p, true, operations, p.validate);
  const extra = [...operations, { key: "permission_modes.pi", value: "never-ask" }];
  apply(p, true, extra, p.validate);
  expect(p.read().permission_modes.pi).toBe("never-ask");
  expect(autonomyOwnership(p.read()._autonomy).find(row => row.key === "permission_modes.codex")!.previous).toBe("ask");
  const edited = p.read(); edited.permission_modes.codex = "ask-when-needed"; writeFileSync(p.file, JSON.stringify(edited));
  expect(apply(p, true, extra, p.validate).preserved).toEqual(["permission_modes.codex"]);
  // The host supplies its full removal list, including former instance defaults.
  apply(p, false, extra, p.validate);
  expect(p.read()).toEqual({});
});


test("off ignores missing, forged, malformed and stale receipts and deletes only host-supplied keys", () => {
  const receipts = [undefined, { version: 99 }, { version: 1, owned: [{ key: "research.enabled", previous: true, written: false }] }];
  for (const metadata of receipts) {
    const p = fixture({ permission_modes: { codex: "ask", pi: "ask" }, tasks: { auto_pull: false }, research: { enabled: false }, ...(metadata === undefined ? {} : { _autonomy: metadata }) });
    apply(p, false, operations);
    expect(p.read()).toEqual({ permission_modes: { pi: "ask" }, research: { enabled: false } });
  }
  const p = fixture();
  apply(p, true, operations);
  const stale = p.read(); stale._autonomy.owned[0].previous = "ask"; stale.research = { enabled: false };
  writeFileSync(p.file, JSON.stringify(stale));
  apply(p, false, operations);
  expect(p.read()).toEqual({ research: { enabled: false } });
});

test("on starts a fresh receipt for missing, forged, malformed or stale ownership and overwrites requested keys", () => {
  for (const metadata of [undefined, { version: 99 }, { version: 1, owned: [{ key: "permission_modes.codex", previous: "never-ask", written: "ask-when-needed" }] }]) {
    const p = fixture({ permission_modes: { codex: "ask" }, approvals: { notify: false }, ...(metadata === undefined ? {} : { _autonomy: metadata }) });
    apply(p, true, operations);
    expect(p.read().permission_modes.codex).toBe("never-ask");
    expect(p.read().approvals).toEqual({ notify: false });
    expect(autonomyOwnership(p.read()._autonomy).find(row => row.key === "permission_modes.codex")).toEqual({ key: "permission_modes.codex", previous: "ask", written: "never-ask" });
  }
  const p = fixture();
  apply(p, true, operations);
  const stale = p.read(); stale._autonomy.owned[0].previous = "ask"; stale.permission_modes.codex = "ask-when-needed";
  writeFileSync(p.file, JSON.stringify(stale));
  expect(apply(p, true, operations).preserved).toEqual([]);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(autonomyOwnership(p.read()._autonomy).find(row => row.key === "permission_modes.codex")!.previous).toBe("ask-when-needed");
});

test("off never calls the ownership authorizer and a repeated empty off does not write", () => {
  const p = fixture({ permission_modes: { codex: "never-ask" }, _autonomy: { malformed: true } });
  const result = writeAutonomyPreset(p.cwd, p.state, false, operations, p.validate, () => { throw new Error("must not inspect ownership"); });
  expect(result.changed).toBe(true);
  expect(p.read()).toEqual({});
  expect(apply(p, false, operations).changed).toBe(false);
});
