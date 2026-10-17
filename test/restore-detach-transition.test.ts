import { expect, test } from "bun:test";
import { restoreTransition, type RestoreEvidence, type RestoreReceipt } from "../src/cli/upgrade-restore-state.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";

const launch = { packageEntrypoint: "fixture", command: "fixture", argv: [], env: {} };
const binding: TerminalBinding = { peer: "pi", handle: "saved", incarnationId: "saved-inc", worktreeId: "wt", projectRoot: "/fixture", sessionId: "recorded", sessionFile: "/fixture/recorded.jsonl", launch, launchMetadata: launch };

test("#463 done proposes a recorded-session repair only with positive terminal and launcher disappearance", () => {
  const receipt: RestoreReceipt = { state: "done", binding };
  const evidence = { target: "running", launcher: "gone", session: "none", allowOther: false, terminal: "gone" } as const;
  expect(restoreTransition(receipt, evidence)).toEqual({ next: { state: "failed" }, action: "reattach" });
  expect(restoreTransition(receipt, { ...evidence, terminal: "unknown" })).toEqual({ next: receipt, action: "block" });
  expect(restoreTransition(receipt, { ...evidence, terminal: "changed" })).toEqual({ next: receipt, action: "block" });
  expect(restoreTransition(receipt, { ...evidence, launcher: "unknown" })).toEqual({ next: receipt, action: "block" });
  expect(restoreTransition(receipt, { ...evidence, launcher: "older-instance" })).toEqual({ next: receipt, action: "block" });
  expect(restoreTransition(receipt, { ...evidence, session: "other", allowOther: true })).toEqual({ next: receipt, action: "block" });
});

test("#463 supplemental evidence changes only its explicit cell family; the original 540-cell domain stays intact", () => {
  const receipts: RestoreReceipt[] = [{ state: "pending" }, { state: "failed" }, { state: "waiting", origin: "pending", binding }, { state: "waiting", origin: "failed", binding }, { state: "done", binding }];
  let count = 0, changed = 0;
  for (const receipt of receipts) for (const target of ["running", "stopped", "changed"] as const)
    for (const launcher of ["live", "gone", "unknown", "no-record-yet", "replaced", "older-instance"] as const)
      for (const session of ["planned", "other", "none"] as const) for (const allowOther of [false, true]) {
        const evidence: RestoreEvidence = { target, launcher, session, allowOther, binding };
        const withTerminal = { ...evidence, terminal: "gone" as const };
        const result = restoreTransition(receipt, withTerminal);
        const eligible = receipt.state === "done" && target === "running" && launcher === "gone" && session === "none";
        if (eligible) { expect(result).toEqual({ next: { state: "failed" }, action: "reattach" }); changed++; }
        else expect(result).toEqual(restoreTransition(receipt, evidence));
        count++;
      }
  expect(count).toBe(540); expect(changed).toBe(2);
});
