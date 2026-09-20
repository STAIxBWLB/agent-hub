import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

function open() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-journal-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  return { dir, journal };
}

test("journal survives a reopen and marks unsettled delivery for review", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "private work", { private: true });
  journal.createDelivery({ id: "d1", peer: "codex", state: "dispatching", createdAt: env.ts, originals: [env], out: [env] });
  journal.close();
  const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "j" });
  expect(reopened.get("d1")).toMatchObject({ state: "needs_review", peer: "codex" });
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("resolution requires the observed revision and is idempotent", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "work");
  const row = journal.createDelivery({ id: "d2", peer: "kimi", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  const done = journal.resolve("d2", row.revision, "completed", "verified no side effect");
  expect(journal.resolve("d2", done.revision, "completed", "verified no side effect").state).toBe("completed");
  expect(() => journal.resolve("d2", row.revision, "discard", "wrong revision")).toThrow("stale delivery revision");
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

test("terminal history is bounded without pruning an unresolved receipt", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "history fixture");
  journal.createDelivery({ id: "pending", peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  journal.transaction(() => {
    for (let n = 0; n < 2050; n++) journal.createDelivery({ id: `terminal-${n}`, peer: "claude", state: "failed", createdAt: env.ts + n, originals: [env], out: [] });
  });
  expect(journal.list().filter((row) => row.state === "failed").length).toBeLessThanOrEqual(2048);
  expect(journal.get("pending")?.state).toBe("needs_review");
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});
