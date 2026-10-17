import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { canChooseFresh, decodeRestoreReceipt, restoreReceiptStatus, restoreTransition, renderRestoreTransitionTable, RESTORE_TRANSITION_TABLE, type RestoreAction, type RestoreEvidence, type RestoreReceipt, type RestoreReceiptStatus } from "../src/cli/upgrade-restore-state.ts";

const launch = { packageEntrypoint: "/fixture/main.js", command: "bun /fixture/main.js", argv: ["bun", "/fixture/main.js"], env: {} };
const original: TerminalBinding = { peer: "codex", handle: "original-handle", incarnationId: "original-incarnation", worktreeId: "worktree", projectRoot: "/fixture", sessionId: "planned", launch, launchMetadata: launch };
const selected: TerminalBinding = { ...original, handle: "selected-handle", incarnationId: "selected-incarnation" };
const launchers = ["live", "gone", "unknown", "no-record-yet", "replaced", "older-instance"] as const;
const statuses = ["pending", "waiting:pending", "waiting:failed", "done", "failed"] as const;
type Status = typeof statuses[number];
type Cell = readonly [RestoreAction, RestoreReceiptStatus];
const receipts: Record<Status, RestoreReceipt> = {
  pending: { state: "pending" }, "waiting:pending": { state: "waiting", origin: "pending", binding: original },
  "waiting:failed": { state: "waiting", origin: "failed", binding: original }, done: { state: "done", binding: original }, failed: { state: "failed" },
};
// Independent specification oracle. Column order is the six launcher observations above, never production branches.
const noSession: Record<Status, readonly Cell[]> = {
  pending: [["poll", "waiting:pending"], ["fail", "failed"], ["block", "pending"], ["fail", "failed"], ["block", "pending"], ["block", "pending"]],
  "waiting:pending": [["poll", "waiting:pending"], ["fail", "failed"], ["block", "waiting:pending"], ["poll", "waiting:pending"], ["block", "waiting:pending"], ["block", "waiting:pending"]],
  "waiting:failed": [["poll", "waiting:failed"], ["create", "failed"], ["block", "waiting:failed"], ["poll", "waiting:failed"], ["block", "waiting:failed"], ["block", "waiting:failed"]],
  done: [["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"]],
  failed: [["poll", "waiting:failed"], ["create", "failed"], ["block", "failed"], ["create", "failed"], ["block", "failed"], ["block", "failed"]],
};
const appropriateSession: Record<Status, readonly Cell[]> = {
  pending: [["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"]],
  "waiting:pending": [["settle", "done"], ["settle", "done"], ["block", "waiting:pending"], ["settle", "done"], ["block", "waiting:pending"], ["block", "waiting:pending"]],
  "waiting:failed": [["settle", "done"], ["settle", "done"], ["block", "waiting:failed"], ["settle", "done"], ["block", "waiting:failed"], ["block", "waiting:failed"]],
  done: [["revalidate", "done"], ["revalidate", "done"], ["revalidate", "done"], ["revalidate", "done"], ["revalidate", "done"], ["revalidate", "done"]],
  failed: [["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"], ["settle", "done"]],
};
const allowedOtherSession: Record<Status, readonly Cell[]> = {
  ...appropriateSession,
  done: [["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"], ["block", "done"]],
};
const fresh: Record<RestoreReceiptStatus, boolean> = { unstarted: false, pending: false, "waiting:pending": false, "waiting:failed": true, done: false, failed: true };

test("restore transition Cartesian table checks all 540 cells including next receipt, choices and status (#433)", () => {
  let count = 0;
  for (const state of statuses) for (const target of ["running", "stopped", "changed"] as const)
    for (const [column, launcher] of launchers.entries()) for (const session of ["planned", "other", "none"] as const) for (const allowOther of [false, true]) {
      const evidence: RestoreEvidence = { target, launcher, session, allowOther, binding: selected };
      const expected: Cell = target !== "running" || session === "other" && !allowOther ? ["block", state]
        : session === "none" ? noSession[state][column]! : session === "other" ? allowedOtherSession[state][column]! : appropriateSession[state][column]!;
      const beforeReceipt = JSON.stringify(receipts[state]), beforeEvidence = JSON.stringify(evidence);
      const result = restoreTransition(receipts[state], evidence);
      const label = `${state}/${target}/${launcher}/${session}/allowOther=${allowOther}`;
      expect(result.action, label).toBe(expected[0]);
      expect(restoreReceiptStatus(result.next), label).toBe(expected[1]);
      expect(canChooseFresh(result.next), label).toBe(fresh[expected[1]]);
      const input = receipts[state];
      const binding = input.state === "waiting" || input.state === "done" ? original : selected;
      if (result.next.state === "done") expect(result.next, label).toEqual({ state: "done", binding });
      else if (result.next.state === "waiting") expect(result.next, label).toEqual({ state: "waiting", origin: expected[1] === "waiting:failed" ? "failed" : "pending", binding });
      else {
        const status = expected[1];
        if (status !== "pending" && status !== "failed") throw new Error(`invalid oracle terminal status: ${status}`);
        expect(result.next, label).toEqual({ state: status });
      }
      expect(JSON.stringify(receipts[state]), label).toBe(beforeReceipt);
      expect(JSON.stringify(evidence), label).toBe(beforeEvidence);
      count++;
    }
  expect(count).toBe(540);
});

test("PROBE-A: a chosen new terminal with no launch record yet keeps its pending-origin wait (#433)", () => {
  const waiting: RestoreReceipt = { state: "waiting", origin: "pending", binding: selected };
  const result = restoreTransition(waiting, { target: "running", launcher: "no-record-yet", session: "none", allowOther: false });
  expect(result).toEqual({ next: waiting, action: "poll" });
  expect(restoreReceiptStatus(result.next)).toBe("waiting:pending"); expect(canChooseFresh(result.next)).toBe(false);
});

test("PROBE-B: a done restoration never becomes failed or offers fresh after its launcher exits (#433)", () => {
  const done: RestoreReceipt = { state: "done", binding: selected };
  expect(restoreTransition(done, { target: "running", launcher: "gone", session: "planned", allowOther: false })).toEqual({ next: done, action: "revalidate" });
  const absent = restoreTransition(done, { target: "running", launcher: "gone", session: "none", allowOther: false });
  expect(absent).toEqual({ next: done, action: "block" }); expect(canChooseFresh(absent.next)).toBe(false);
  expect(restoreTransition(done, { target: "running", launcher: "live", session: "other", allowOther: true })).toEqual({ next: done, action: "block" });
});

test("bare receipts cannot poll or settle without their original verified binding (#433)", () => {
  for (const state of ["pending", "failed"] as const) for (const session of ["none", "planned", "other"] as const) {
    expect(restoreTransition({ state }, { target: "running", launcher: "live", session, allowOther: true })).toEqual({ next: { state }, action: "block" });
  }
});

test("restore receipt decoder isolates legacy representations and preserves absent/unstarted (#433)", () => {
  expect(decodeRestoreReceipt(undefined)).toBeUndefined(); expect(restoreReceiptStatus(undefined)).toBe("unstarted"); expect(canChooseFresh(undefined)).toBe(false);
  for (const origin of ["pending", "failed"] as const) {
    expect(decodeRestoreReceipt(origin)).toEqual({ state: origin });
  }
  expect(decodeRestoreReceipt(original)).toEqual({ state: "done", binding: original });
  const permissiveMetadata = { ...launch, argv: [], env: { AGENTHUB_LAUNCH: "saved-metadata" } };
  expect(decodeRestoreReceipt({ ...original, launch: permissiveMetadata, launchMetadata: permissiveMetadata })).toMatchObject({ state: "done", binding: { launch: permissiveMetadata } });
  for (const state of statuses) expect(decodeRestoreReceipt(receipts[state])).toEqual(receipts[state]);
  const { launchMetadata: _alias, ...old } = original;
  expect(decodeRestoreReceipt(old)).toEqual({ state: "done", binding: original });
});

test("unreleased attachmentReceipt markers are not accepted as restoration receipts (#143)", () => {
  for (const marker of ["pending", "failed", "other"]) {
    const value = { ...original, attachmentReceipt: marker };
    expect(() => decodeRestoreReceipt(value)).toThrow("invalid restore receipt");
    expect(() => restoreReceiptStatus(value)).toThrow("invalid restore receipt");
    expect(() => canChooseFresh(value)).toThrow("invalid restore receipt");
  }
});

test("malformed receipts refuse instead of inferring done, pending or failed (#433)", () => {
  for (const value of [null, true, false, 0, "", "done", [], {}, { state: "waiting", origin: "other", binding: original },
    { state: "done" }, { state: "pending", binding: original }, { ...original, attachmentReceipt: "other" },
    { ...original, handle: "" }, { ...original, peer: "unknown" }, { ...original, launch: {} }, { ...original, launch: { ...launch, env: { malformed: 1 } } }]) {
    expect(() => decodeRestoreReceipt(value)).toThrow("invalid restore receipt");
  }
});


test("the recovery spec contains the exact generated restore transition table (#433)", () => {
  const spec = readFileSync(join(import.meta.dir, "../docs/specs/2026-09-20-upgrade-recovery-design.md"), "utf8");
  const start = "Restore transition table (generated).", end = "End of generated restore transition table.";
  const startAt = spec.indexOf(start), endAt = spec.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0); expect(endAt).toBeGreaterThan(startAt);
  expect(spec.slice(startAt + start.length, endAt).trim()).toBe(renderRestoreTransitionTable());
  expect(RESTORE_TRANSITION_TABLE).toBe(renderRestoreTransitionTable());
});
