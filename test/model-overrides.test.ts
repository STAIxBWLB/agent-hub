import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelOverrides, ModelOverrideLatches } from "../src/hub/model-overrides.ts";
import { isNativeModelToken } from "../src/hub/instances.ts";
import { openHubDatabase } from "../src/hub/db-schema.ts";
import { planReset, resetRuntime } from "../src/cli/reset.ts";
const roots: string[] = [], stores = new Set<ModelOverrides>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "ahub-model-")); roots.push(root); const file = join(root, "hub.db"), store = new ModelOverrides(file); stores.add(store); return { root, file, store }; }
const fallback = { model: "instance-model", source: "instance" as const };

test("runtime model tokens reuse the unchanged native word contract", () => {
  for (const value of ["gpt-6.1", "provider/model:variant@account+suffix", "a".repeat(128)]) expect(isNativeModelToken(value)).toBe(true);
  for (const value of ["", "-model", "two words", "bad\nvalue", "é", "a".repeat(129), 1, null]) expect(isNativeModelToken(value)).toBe(false);
});
test("person overrides persist independently of adapter/configuration state and clear restores absence", () => {
  const f = fixture(); expect(f.store.list()).toEqual([]);
  expect(f.store.set("codex", "provider/model", 10)).toEqual({ peer: "codex", model: "provider/model", setAt: 10, by: "person" });
  const before = f.store.integrity(); f.store.close(); stores.delete(f.store);
  const reopened = new ModelOverrides(f.file); stores.add(reopened);
  expect(reopened.get("codex")?.model).toBe("provider/model"); expect(reopened.integrity()).toEqual(before);
  expect(reopened.clear("codex")).toBe(true); expect(reopened.clear("codex")).toBe(false); expect(reopened.hasRecords()).toBe(false);
});
test("invalid model/peer/timestamp inputs write no row", () => {
  const { store } = fixture();
  for (const model of ["bad model", "--help", "a".repeat(129)]) expect(() => store.set("codex", model)).toThrow();
  for (const peer of ["../other", "codex@remote", "user space"]) expect(() => store.set(peer, "model")).toThrow();
  for (const at of [-1, NaN, Infinity, 0.5]) expect(() => store.set("codex", "model", at)).toThrow();
  expect(store.list()).toEqual([]);
});
test("invalid persisted rows refuse reads and inventory without exposing row content", () => {
  const f = fixture(), db = openHubDatabase(f.file);
  try {
    db.query('INSERT INTO model_overrides(peer,model,set_at,"by") VALUES(?,?,?,?)').run("codex", "PRIVATE_BAD_MODEL ".repeat(100), 1, "person");
    for (const read of [() => f.store.get("codex"), () => f.store.list(), () => f.store.integrity()]) {
      let error: unknown; try { read(); } catch (value) { error = value; }
      expect(String(error)).toContain("model override state is invalid"); expect(String(error)).not.toContain("PRIVATE_BAD_MODEL");
    }
    // Person clear remains available for a retained invalid row; it never needs the invalid model body.
    expect(f.store.clear("codex")).toBe(true); expect(f.store.list()).toEqual([]);
  } finally { db.close(); }
});
test("selection stays captured during an open turn and only an ACK changes effective status", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {}, turn = {};
  store.set("codex", "first", 1); const first = latches.capture("codex", owner, turn, () => true);
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "instance-model", source: "instance", desiredModel: "first", pendingNextTurn: true });
  store.set("codex", "second", 2); store.set("codex", "last", 3);
  expect(latches.capture("codex", owner, turn, () => true)).toBe(first); expect(first.model).toBe("first");
  first.applied(); expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "first", source: "override", desiredModel: "last", pendingNextTurn: true });
  const next = latches.capture("codex", owner, {}, () => true); expect(next.model).toBe("last"); next.applied();
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "last", pendingNextTurn: false });
});
test("clear waits for a new boundary and restores the baseline without mutating the running selection", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {}, turn = {};
  store.set("codex", "override", 1); const selection = latches.capture("codex", owner, turn, () => true); selection.applied(); store.clear("codex");
  expect(selection.model).toBe("override"); expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "override", desiredModel: null, pendingNextTurn: true });
  const next = latches.capture("codex", owner, {}, () => true); expect(next.model).toBeUndefined(); next.applied();
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "instance-model", source: "instance", pendingNextTurn: false });
});
test("same-model writes have distinct revisions and stale owner/turn ACKs never settle a newer selection", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), oldOwner = {}, owner = {};
  store.set("codex", "same", 1); const previous = latches.capture("codex", oldOwner, {}, () => true);
  store.set("codex", "same", 1); const current = latches.capture("codex", owner, {}, () => true); previous.applied();
  expect(latches.status("codex", owner, fallback).pendingNextTurn).toBe(true); current.applied();
  expect(latches.status("codex", owner, fallback).pendingNextTurn).toBe(false);
  let admitted = false; store.set("codex", "new", 2); const late = latches.capture("codex", owner, {}, () => admitted); late.applied();
  expect(latches.status("codex", owner, fallback).effectiveModel).toBe("same"); admitted = true;
  latches.capture("codex", owner, {}, () => true); late.applied(); expect(latches.status("codex", owner, fallback).pendingNextTurn).toBe(true);
});
test("unsupported retained state is clearable and never represented as an applied override", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {};
  store.set("codex", "old", 1); latches.capture("codex", owner, {}, () => true).applied();
  expect(latches.status("codex", owner, { source: "native default" }, { reasonCode: "unverified_setter", reason: "unsupported live", nextStep: "ahub restart codex" })).toMatchObject({ effectiveModel: null, source: "native default", desiredModel: "old", pendingNextTurn: false });
  expect(store.clear("codex")).toBe(true); latches.forget("codex"); expect(latches.status("codex", owner, { source: "native default" }).desiredModel).toBeNull();
});

test("native explicit choice supersedes stale effective override without acknowledging the pending desired selection", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {};
  store.set("codex", "hub-x", 1); latches.capture("codex", owner, {}, () => true).applied();
  latches.observeNative("codex", owner, "native-y");
  expect(latches.status("codex", owner, { source: "native default" })).toMatchObject({ effectiveModel: "native-y", source: "native default", desiredModel: "hub-x", pendingNextTurn: true });
  store.clear("codex"); latches.capture("codex", owner, {}, () => true).applied("native-y");
  expect(latches.status("codex", owner, { source: "native default" })).toMatchObject({ effectiveModel: "native-y", source: "native default", desiredModel: null, pendingNextTurn: false });
});
test("ended turns reject late ACKs but retain the last acknowledged model for idle status", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {};
  store.set("codex", "first", 1); latches.capture("codex", owner, {}, () => true).applied(); latches.end("codex");
  expect(latches.status("codex", owner, fallback).effectiveModel).toBe("first");
  store.set("codex", "next", 2); const late = latches.capture("codex", owner, {}, () => true); latches.end("codex"); late.applied();
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "first", desiredModel: "next", pendingNextTurn: true });
});
test("oversized peer and actor columns are rejected by bounded SQL metadata projections", () => {
  const f = fixture(), db = openHubDatabase(f.file);
  try {
    for (const [peer, by] of [["p".repeat(10000), "person"], ["codex", "a".repeat(10000)]]) {
      db.query('INSERT INTO model_overrides(peer,model,set_at,"by") VALUES(?,?,?,?)').run(peer!, "valid", 1, by!);
      expect(() => f.store.list()).toThrow("model override state is invalid"); expect(() => f.store.integrity()).toThrow("model override state is invalid");
      db.run("DELETE FROM model_overrides");
    }
  } finally { db.close(); }
});
test("runtime reset clears retained override rows", () => {
  const f = fixture(); f.store.set("codex", "reset-me", 1); f.store.close(); stores.delete(f.store);
  expect(planReset(f.root, "model-reset")).toBeDefined();
  resetRuntime(f.root, { id: "model-reset", root: f.root, stateDir: f.root, basePort: 0, pid: null, instanceId: null });
  const reopened = new ModelOverrides(f.file); stores.add(reopened); expect(reopened.list()).toEqual([]);
});

test("clear before the first ACK stays pending while the captured override remains in the current turn", () => {
  // Pure latch state only; this does not qualify native owner identity or transport acknowledgement.
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {};
  const ordinary = latches.capture("codex", owner, {}, () => true);
  expect(ordinary.model).toBeUndefined(); expect(latches.status("codex", owner, fallback).pendingNextTurn).toBe(false);
  store.set("codex", "captured-x", 1); const running = latches.capture("codex", owner, {}, () => true);
  store.clear("codex");
  expect(running.model).toBe("captured-x");
  expect(latches.status("codex", owner, fallback)).toMatchObject({ desiredModel: null, pendingNextTurn: true });
  running.applied();
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "captured-x", desiredModel: null, pendingNextTurn: true });
  latches.end("codex"); const next = latches.capture("codex", owner, {}, () => true);
  expect(next.model).toBeUndefined(); next.applied();
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "instance-model", source: "instance", desiredModel: null, pendingNextTurn: false });
});

test("failed capture retirement is token-specific and cannot retire ACKed or native-start-superseded selections", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {}, rejectedToken = {};
  store.set("codex", "rejected", 1); latches.capture("codex", owner, rejectedToken, () => true);
  store.set("codex", "corrected", 2); expect(latches.end("codex", rejectedToken, true)).toBe(true);
  const currentToken = {}, current = latches.capture("codex", owner, currentToken, () => true);
  expect(current.model).toBe("corrected"); expect(latches.end("codex", rejectedToken, true)).toBe(false);
  expect(latches.capture("codex", owner, currentToken, () => true)).toBe(current);
  current.applied(); expect(latches.end("codex", currentToken, true)).toBe(false);
  const nativeToken = {}; latches.capture("codex", owner, nativeToken, () => true); latches.observeNative("codex", owner, "native-choice");
  expect(latches.end("codex", nativeToken, true)).toBe(false);
  expect(latches.status("codex", owner, fallback)).toMatchObject({ effectiveModel: "native-choice", source: "native default", desiredModel: "corrected", pendingNextTurn: true });
});
test("sticky clear provenance requires the same owner's prior override ACK and an exact native hint", () => {
  const { store } = fixture(), latches = new ModelOverrideLatches(store), owner = {};
  store.set("codex", "owned-x", 1); latches.capture("codex", owner, {}, () => true).applied();
  store.clear("codex"); latches.capture("codex", owner, {}, () => true).applied("owned-x");
  expect(latches.status("codex", owner, { source: "native default" })).toMatchObject({ effectiveModel: "owned-x", source: "native thread default (was override)", desiredModel: null, pendingNextTurn: false });
  latches.end("codex"); latches.capture("codex", owner, {}, () => true).applied("owned-x");
  expect(latches.status("codex", owner, fallback).source).toBe("native thread default (was override)");
  latches.observeNative("codex", owner, "owned-x");
  latches.capture("codex", owner, {}, () => true).applied("owned-x");
  expect(latches.status("codex", owner, fallback).source).toBe("native default");
  store.set("codex", "owned-x", 2); latches.capture("codex", owner, {}, () => true).applied(); store.clear("codex");
  const replacement = {}; latches.capture("codex", replacement, {}, () => true).applied("owned-x");
  expect(latches.status("codex", replacement, fallback).source).toBe("native default");
  latches.capture("codex", replacement, {}, () => true).applied("unrelated");
  expect(latches.status("codex", replacement, fallback)).toMatchObject({ effectiveModel: "unrelated", source: "native default" });
});
