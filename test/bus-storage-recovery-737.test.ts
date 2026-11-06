import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-storage-edge-737-")); close.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "fixture", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal }); close.push(() => bus.closeJournal()); return { bus, journal };
}
test("only a verified journal recovery edge notifies once and observer failures cannot undo it", async () => {
  const { bus, journal } = fixture(); let calls = 0, failing = true;
  const persist = journal.persistBus.bind(journal);
  journal.persistBus = (...args) => { if (failing) throw new Error("fixture storage failure"); return persist(...args); };
  bus.onStorageRecovered = () => { calls++; throw new Error("fixture observer failure"); };
  expect(() => bus.setManualPaused([])).toThrow("delivery journal unavailable"); await Promise.resolve(); expect(calls).toBe(0);
  failing = false; bus.setManualPaused([]); expect(calls).toBe(0); await Promise.resolve();
  expect(calls).toBe(1); expect(bus.storageError).toBeUndefined();
  bus.setManualPaused([]); await Promise.resolve(); expect(calls).toBe(1);
  bus.storageError = "delivery journal unavailable"; bus.setManualPaused([]); bus.closeJournal();
  await Promise.resolve(); expect(calls).toBe(1);
});
