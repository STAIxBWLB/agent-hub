/**
 * Repo-only diagnostic preload for the unchanged AC1 test:
 * bun test --preload ./scripts/diagnose-presence-cost-742.ts test/rooms-delivery.test.ts --test-name-pattern "1000 presence flips" --timeout 20000
 * Timings are inclusive wall time, not additive CPU time. No argument text or ids are reported.
 */
import "../test/hub-home.ts";
import { afterAll } from "bun:test";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { RoomLink } from "../src/rooms/link.ts";
import { RoomChat } from "../src/rooms/service.ts";

interface Metric { calls: number; totalMs: number; maxMs: number }
type Metrics = Record<string, Metric>;
const total: Metrics = Object.create(null), duringFlips: Metrics = Object.create(null);
let flips = 0, phaseStarted: number | undefined, phaseEnded: number | undefined;
let waitedForIdle = false;
const idleEntry = process.env.AHUB_PRESENCE_DIAG_IDLE_ENTRY === "1";
const began = performance.now(), wrappedStores = new WeakSet<object>();
function metric(rows: Metrics, label: string): Metric {
  return rows[label] ??= { calls: 0, totalMs: 0, maxMs: 0 };
}
function measure(label: string): () => void {
  const overall = metric(total, label), phase = phaseStarted !== undefined && phaseEnded === undefined ? metric(duringFlips, label) : undefined;
  overall.calls++; if (phase) phase.calls++;
  const start = performance.now();
  return () => {
    const elapsed = performance.now() - start;
    overall.totalMs += elapsed; overall.maxMs = Math.max(overall.maxMs, elapsed);
    if (phase) { phase.totalMs += elapsed; phase.maxMs = Math.max(phase.maxMs, elapsed); }
  };
}
function wrap(target: object, key: string, label: string, asynchronous = false, resolved?: (value: unknown) => void): void {
  const original = Reflect.get(target, key);
  if (typeof original !== "function") throw new Error(`presence diagnostic cannot find ${label}; update the diagnostic for this source version`);
  Object.defineProperty(target, key, { configurable: true, writable: true, value: function(this: unknown, ...args: unknown[]) {
    if ((label === "bus.pause" || label === "bus.resume") && args[0] === "codex" && phaseEnded === undefined) {
      phaseStarted ??= performance.now(); flips++;
    }
    const finish = measure(label);
    let result: unknown;
    try {
      // Controlled scheduling probe, reported separately from the unchanged run:
      // finish the already queued seal before the first state-change publication.
      if (idleEntry && label === "link.publishPresence" && flips === 1 && !waitedForIdle) {
        waitedForIdle = true;
        result = Promise.resolve(Reflect.get(this as object, "sendTail")).then(() => Reflect.apply(original, this, args));
      } else result = Reflect.apply(original, this, args);
    } catch (error) { finish(); throw error; }
    if (!asynchronous) { finish(); return result; }
    return Promise.resolve(result).then(value => {
      resolved?.(value); finish();
      if (label === "link.publishPresence" && flips >= 1000 && phaseEnded === undefined) phaseEnded = performance.now();
      return value;
    }, error => { finish(); throw error; });
  } });
}
wrap(Bus.prototype, "pause", "bus.pause");
wrap(Bus.prototype, "resume", "bus.resume");
wrap(Bus.prototype, "persist", "bus.persist");
wrap(DeliveryJournal.prototype, "persistBus", "journal.persistBus");
wrap(DeliveryJournal.prototype, "pendingPeers", "journal.pendingPeers");
wrap(RoomStore.prototype, "transaction", "store.transaction");
wrap(RoomStore.prototype, "get", "store.get");
wrap(RoomChat.prototype, "queueChanged", "chat.queueChanged");
wrap(RoomLink.prototype, "publishPresence", "link.publishPresence", true);
wrap(RoomStore, "open", "store.open", true, value => {
  if (!(value instanceof RoomStore) || wrappedStores.has(value)) return;
  wrappedStores.add(value); wrap(value.sequence, "reserve", "store.sequence.reserve", true);
});
function rounded(rows: Metrics): Metrics {
  return Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, { calls: row.calls, totalMs: Math.round(row.totalMs), maxMs: Math.round(row.maxMs) }]));
}
afterAll(() => {
  const elapsed = (phaseEnded ?? performance.now()) - (phaseStarted ?? began);
  console.error("PRESENCE_COST_742 " + JSON.stringify({
    platform: process.platform, arch: process.arch, bun: Bun.version, mode: idleEntry ? "awaited-idle-entry" : "natural",
    flips, phaseCompleted: phaseEnded !== undefined, phaseWallMs: Math.round(elapsed), totalWallMs: Math.round(performance.now() - began),
    duringFlips: rounded(duringFlips), total: rounded(total),
  }));
});
