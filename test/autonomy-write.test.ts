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

test("on/off retain prior manual values, leave equal hand-set keys unowned, and settings undo restores the complete transaction", () => {
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
  expect(p.read()).toEqual(JSON.parse(before));
  undoSetting(p.cwd, p.state, p.validate);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(p.read()._autonomy).toBeDefined();
});

test("off preserves edits made after on and removes only its untouched owned leaves", () => {
  const p = fixture();
  apply(p, true, operations, p.validate);
  const edited = p.read(); edited.permission_modes.codex = "ask"; edited.approvals = { notify: false };
  writeFileSync(p.file, JSON.stringify(edited));
  const result = apply(p, false, operations, p.validate);
  expect(result.preserved).toEqual(["permission_modes.codex"]);
  expect(p.read()).toEqual({ permission_modes: { codex: "ask" }, approvals: { notify: false } });
});

test("a failed validation or changed input writes no preset and never offers an undo for a partial write", () => {
  const p = fixture(), before = readFileSync(p.file, "utf8");
  expect(() => apply(p, true, operations, () => { throw new Error("refused"); })).toThrow("refused");
  expect(readFileSync(p.file, "utf8")).toBe(before);
  expect(() => autonomyUndoKeys(p.state)).toThrow();
  expect(() => apply(p, true, operations, () => { writeFileSync(p.file, '{"approvals":{"notify":false}}'); })).toThrow("changed during");
  expect(p.read()).toEqual({ approvals: { notify: false } });
});

test("undo after a hand edit refuses rather than discarding it; malformed ownership never restores arbitrary keys", () => {
  const p = fixture();
  apply(p, true, operations, p.validate);
  writeFileSync(p.file, JSON.stringify({ ...p.read(), approvals: { notify: false } }));
  expect(() => undoSetting(p.cwd, p.state, p.validate)).toThrow("changed since");
  expect(() => autonomyOwnership({ version: 1, owned: [{ key: "constructor.prototype", previous: null, written: true }] })).toThrow();
  const edited = p.read(); edited._autonomy.owned[0].key = "terminal.open";
  writeFileSync(p.file, JSON.stringify(edited));
  expect(() => apply(p, false, operations, p.validate)).toThrow("not authenticated");
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
  // Off does not need the current roster to contain the old Pi target.
  apply(p, false, operations, p.validate);
  expect(p.read()).toEqual({ permission_modes: { codex: "ask-when-needed" } });
});
