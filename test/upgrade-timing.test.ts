import { expect, test } from "bun:test";
import { publicOperation, type RecoveryOperation } from "../src/cli/upgrade.ts";

test("#466 preservation errors expose a closed typed comparison without parsing their legacy message", async () => {
  const path = "../src/cli/upgrade-presentation-data.ts", module = await import(path).catch(() => undefined);
  expect(typeof module?.RecoveryPreservationError).toBe("function");
  for (const check of ["queues", "manualPaused", "boardDigest", "budgetDigest"] as const) {
    const error = new module.RecoveryPreservationError(check, "fixture-project");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("queue, manual pause, task board or budget preservation was not verified");
    expect(error.presentationCause).toEqual({ kind: "preservation", check, projectId: "fixture-project" });
  }
});

test("#466 public receipts add actual timing and typed presentation data only when recorded", () => {
  const op = { id: "fixture", phase: "completed", step: "completed", updatedAt: 0, plan: { version: "0.0.0", projects: [] }, projects: [] } as unknown as RecoveryOperation;
  const old = publicOperation(op);
  expect(Object.hasOwn(old, "waits")).toBe(false); expect(Object.hasOwn(old, "presentationCause")).toBe(false);
  const waits = { "prepare:fixture": { waitStartedAt: new Date(1000).toISOString(), deadlineAt: new Date(601000).toISOString(), waitEndedAt: new Date(2000).toISOString() } };
  const cause = { kind: "preservation", check: "queues", projectId: "fixture" };
  Object.assign(op, { waits, presentationCause: cause });
  expect((publicOperation(op) as any).waits).toEqual(waits);
  expect((publicOperation(op) as any).presentationCause).toEqual(cause);
  const { waits: _waits, presentationCause: _cause, ...unchanged } = publicOperation(op) as any;
  expect(unchanged).toEqual(old);
});
