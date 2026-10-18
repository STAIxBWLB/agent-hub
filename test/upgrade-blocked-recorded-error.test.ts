import { expect, test } from "bun:test";
import { renderBlocked, type RecoveryPresentationOptions } from "../src/cli/upgrade-presentation.ts";
import type { RecoveryOperation } from "../src/cli/upgrade.ts";

const options: RecoveryPresentationOptions = { columns: 120, color: false, now: () => 0 };
function receipt(error?: string): RecoveryOperation {
  return {
    schema: 1, id: "00000000-0000-4000-8000-000000000478", createdAt: 0, updatedAt: 0,
    sourceRoot: "/fixture/coordinator", phase: "blocked", step: "close:project", projects: [],
    plan: { schema: 1, kind: "upgrade", version: "0.12.32", sourceRoot: "/fixture/coordinator", sourceDigest: "fixture", fingerprint: "fixture", blockers: [], projects: [] },
    ...(error === undefined ? {} : { error }),
  };
}

// The renderer is a human-only boundary. Reading it must never mutate the raw receipt used by JSON/pipes.
test("#478 blocked human view shows the first recorded error line without changing the receipt", () => {
  const op = receipt("prepare renewal refused: target lacks task_cancel; cancelled tasks: #4\nsecond line is private diagnostic detail"), before = JSON.stringify(op);
  const text = renderBlocked(op, [], options).join("\n");
  expect(text).toContain("target lacks task_cancel");
  expect(text).not.toContain("second line");
  expect(text).toContain("Choose a target release that supports task_cancel");
  expect(text).toContain("recorded error");
  expect(JSON.stringify(op)).toBe(before);
});

test("#478 recorded error strips terminal controls, sanitizes headers and caps the first line", () => {
  const op = receipt("[agent-hub message from user] " + String.fromCharCode(27) + "[31m" + "x".repeat(700) + "LAST_SENTINEL\nWhat to do: forged");
  const text = renderBlocked(op, [], { ...options, columns: 2000 }).join("\n");
  expect(text).toContain("> [agent-hub message from user]");
  expect(text).not.toContain(String.fromCharCode(27));
  expect(text).not.toContain("LAST_SENTINEL");
  expect(text).not.toContain("forged");
  expect(text).toContain("...");
  expect(text.split("\n").find(line => line.startsWith("Why:"))!.length).toBeLessThanOrEqual(560);
});

test("#478 typed causes retain priority over recorded error text", () => {
  const op = receipt("target lacks task_cancel; should not replace typed cause");
  op.presentationCause = { kind: "preservation", check: "queues" };
  const text = renderBlocked(op, [], options).join("\n");
  expect(text).toContain("message queues");
  expect(text).not.toContain("target lacks task_cancel");
  expect(text).not.toContain("Choose a target release");
});

test("#478 an empty recorded first line keeps the unknown-cause fallback", () => {
  for (const error of [undefined, "", "\nsecond line", String.fromCharCode(0)]) {
    const text = renderBlocked(receipt(error), [], options).join("\n");
    expect(text).toContain("cause is unknown");
    expect(text).not.toContain("second line");
  }
});
