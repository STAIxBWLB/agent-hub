import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyMemorySyncFailure, initialMemorySyncState, memorySyncDeclinedDetails, memorySyncFailureDetailHash, memorySyncView, reduceMemorySync } from "../src/hub/memory-sync-state.ts";
import { memorySyncLine } from "../src/cli/status-lines.ts";

test("memory sync status distinguishes disabled, unavailable, not run, success and a safe declined failure", () => {
  let state = initialMemorySyncState();
  expect(memorySyncView(state, "disabled")).toEqual({ state: "disabled" });
  expect(memorySyncView(state, "unavailable")).toEqual({ state: "unavailable" });
  expect(memorySyncView(state, "enabled")).toEqual({ state: "notrun" });
  state = reduceMemorySync(state, { type: "success", at: 10 }).state;
  expect(memorySyncView(state, "enabled")).toEqual({ state: "ok", at: 10 });
  const error = "the configured privacy policy declines 12 long-term entries (aaaaaaaa, bbbbbbbb, cccccccc, dddddddd, eeeeeeee, ffffffff, 11111111, 22222222, ...); fix the entry or the policy, then sync again";
  const parsed = classifyMemorySyncFailure(error);
  expect(parsed).toEqual({ cause: "declined", declinedCount: 12 });
  state = reduceMemorySync(state, { type: "failure", at: 20, ...parsed, declinedIdsFingerprint: "a".repeat(64) }).state;
  expect(memorySyncView(state, "enabled")).toEqual({ state: "failed", at: 20, cause: "declined", declinedCount: 12, nextStep: "ahub memory declined" });
  expect(JSON.stringify(memorySyncView(state, "enabled"))).not.toContain("aaaaaaaa");
});

test("memory sync failure logging dedupes the full declined-ID fingerprint and success starts a new episode", () => {
  let state = initialMemorySyncState();
  const failure = { type: "failure" as const, at: 1, cause: "declined" as const, declinedCount: 9, declinedIdsFingerprint: "first-full-set" };
  const first = reduceMemorySync(state, failure); state = first.state;
  expect(first.logFailure).toBe(true);
  const same = reduceMemorySync(state, { ...failure, at: 2 }); state = same.state;
  expect(same.logFailure).toBe(false);
  const changedAfterEight = reduceMemorySync(state, { ...failure, at: 3, declinedIdsFingerprint: "different-full-set" }); state = changedAfterEight.state;
  expect(changedAfterEight.logFailure).toBe(true);
  const success = reduceMemorySync(state, { type: "success", at: 4 }); state = success.state;
  expect(success.logFailure).toBe(false);
  expect(reduceMemorySync(state, { ...failure, at: 5 }).logFailure).toBe(true);
});

test("quiet missing-remote and stopped outcomes stay neutral and clear the prior failure episode", () => {
  let state = initialMemorySyncState();
  state = reduceMemorySync(state, { type: "failure", at: 1, cause: "transport", failureDetailHash: "private" }).state;
  const missingRemote = reduceMemorySync(state, { type: "quiet", at: 2, state: "not-configured" });
  state = missingRemote.state;
  expect(missingRemote.logFailure).toBe(false);
  expect(memorySyncView(state, "enabled")).toEqual({ state: "not-configured", at: 2, nextStep: "configure a private sync remote" });
  expect(memorySyncLine(memorySyncView(state, "enabled"))).toContain("not-configured; automatic, last");
  expect(memorySyncLine(memorySyncView(state, "enabled"))).toContain("next: configure a private sync remote");
  const stopped = reduceMemorySync(state, { type: "quiet", at: 3, state: "stopped" });
  state = stopped.state;
  expect(stopped.logFailure).toBe(false);
  expect(memorySyncView(state, "enabled")).toEqual({ state: "stopped", at: 3, nextStep: "retry after hub restart" });
  expect(reduceMemorySync(state, { type: "failure", at: 4, cause: "transport", failureDetailHash: "private" }).logFailure).toBe(true);
});

test("declined sync dedupe uses the complete inspected ID set across targets, not the first-target result count", () => {
  const idA = "a".repeat(32), idB = "b".repeat(32), idC = "c".repeat(32);
  const fingerprint = (ids: string[]) => createHash("sha256").update(ids.sort().join("\n")).digest("hex");
  const firstFullSet = memorySyncDeclinedDetails({ cause: "declined", declinedCount: 1 }, {
    rows: [{ id: idA }, { id: idB }], declinedIdsFingerprint: fingerprint([idA, idB]), complete: true,
  });
  expect(firstFullSet.declinedCount).toBe(2);
  let state = initialMemorySyncState();
  const first = reduceMemorySync(state, { type: "failure", at: 1, ...firstFullSet }); state = first.state;
  expect(first.logFailure).toBe(true);
  const changedSet = memorySyncDeclinedDetails({ cause: "declined", declinedCount: 1 }, {
    rows: [{ id: idA }, { id: idC }], declinedIdsFingerprint: fingerprint([idA, idC]), complete: true,
  });
  expect(reduceMemorySync(state, { type: "failure", at: 2, ...changedSet }).logFailure).toBe(true);
});

test("declined inspection fallback keeps the canonical count and marks IDs unknown; other failures hash private details", () => {
  const fallback = memorySyncDeclinedDetails({ cause: "declined", declinedCount: 1 }, {
    rows: [], declinedIdsFingerprint: "0".repeat(64), complete: false,
  });
  expect(fallback).toEqual({ cause: "declined", declinedCount: 1, declinedIdsKnown: false });
  const fallbackState = reduceMemorySync(initialMemorySyncState(), { type: "failure", at: 1, ...fallback }).state;
  expect(memorySyncView(fallbackState, "enabled")).toMatchObject({ state: "failed", declinedCount: 1, declinedIdsKnown: false });
  let state = initialMemorySyncState();
  const privateErrorOne = "push failed: https://secret.invalid/one";
  const privateErrorTwo = "push failed: https://secret.invalid/two";
  const hashOne = memorySyncFailureDetailHash(privateErrorOne);
  const hashTwo = memorySyncFailureDetailHash(privateErrorTwo);
  const first = reduceMemorySync(state, { type: "failure", at: 1, cause: "transport", failureDetailHash: hashOne }); state = first.state;
  expect(reduceMemorySync(state, { type: "failure", at: 2, cause: "transport", failureDetailHash: hashOne }).logFailure).toBe(false);
  expect(reduceMemorySync(state, { type: "failure", at: 3, cause: "transport", failureDetailHash: hashTwo }).logFailure).toBe(true);
  expect(JSON.stringify(state)).not.toContain("secret.invalid");
});

test("memory sync failure classification is closed and excludes upstream error text", () => {
  expect(classifyMemorySyncFailure("no sync remote: a person sets one with `amem sync --remote <private git url>`")).toEqual({ cause: "remote" });
  expect(classifyMemorySyncFailure("push failed: remote rejected https://secret.invalid/private token=secret")).toEqual({ cause: "transport" });
  expect(JSON.stringify(classifyMemorySyncFailure("push failed: remote rejected https://secret.invalid/private token=secret"))).not.toContain("secret");
  expect(classifyMemorySyncFailure("https://secret.invalid/private token=secret")).toEqual({ cause: "unknown" });
  expect(classifyMemorySyncFailure("aborted by git: generation profile changed; token=secret")).toEqual({ cause: "unknown" });
  expect(JSON.stringify(classifyMemorySyncFailure("aborted by git: generation profile changed; token=secret"))).not.toContain("secret");
  expect(classifyMemorySyncFailure("the configured privacy policy declines 20001 long-term entries (ids); fix the entry or the policy, then sync again")).toEqual({ cause: "unknown" });
  expect(classifyMemorySyncFailure("the configured privacy policy declines 12 long-term entries (ids) token=secret")).toEqual({ cause: "unknown" });
});

test("memory sync human status treats out-of-range timestamps as unknown", () => {
  expect(memorySyncLine({ state: "ok", at: Number.MAX_SAFE_INTEGER })).toContain("last unknown");
  expect(memorySyncLine({ state: "failed", cause: "unknown", at: Number.MAX_SAFE_INTEGER, nextStep: "inspect ahub logs, then retry sync" })).toContain("last unknown");
});
