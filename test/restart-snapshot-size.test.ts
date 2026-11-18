import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactRestartBus, expandRestartBus, pruneRestartArchives, RESTART_ARCHIVES_KEPT } from "../src/hub/restart.ts";

const env = (id: string, body: string) => ({ id, trace: id, hop: 0, from: "a", kind: "chat", priority: "status", body, ts: 1 }) as any;
const fixture = () => {
  const seen = Array.from({ length: 2048 }, (_, i) => env(`s${i}`, "x".repeat(200)));
  const deliveries = Array.from({ length: 2048 }, (_, i) => ({ id: `d${i}`, peer: "b", state: i === 0 ? "queued" : "completed", revision: 1, createdAt: 1, updatedAt: 1, originals: [env(`o${i}`, "y".repeat(4000))], out: [env(`r${i}`, "z".repeat(4000))] }));
  const inner = { schemaVersion: 1, queues: {}, prefaces: {}, seen, attempts: {}, withdrawn: [] };
  return { ...inner, journal: { schemaVersion: 1, revision: 2, instanceId: "i", bus: inner, deliveries, manualPaused: [] } } as any;
};
test("restart bus is compacted, seen stored once, pending untouched, round trip", () => {
  const bus = fixture();
  const before = JSON.stringify(bus).length;
  const compact: any = compactRestartBus(bus);
  const after = JSON.stringify(compact).length;
  console.log(`restart bus bytes before=${before} after=${after}`);
  expect(after).toBeLessThan(before / 5);
  expect(after).toBeLessThan(20 * 1024 * 1024 / 4);
  expect(compact.journal.bus.seen).toEqual([]);
  expect(compact.journal.deliveries[0].originals[0].body.length).toBe(4000);
  expect(compact.journal.deliveries[1].originals[0].body.length).toBe(256);
  expect((expandRestartBus(compact) as any).journal.bus.seen.length).toBe(2048);
});
test("archives are bounded, newest kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-"));
  for (let i = 0; i < RESTART_ARCHIVES_KEPT + 3; i++) {
    for (const k of ["released", "abandoned"]) { const f = join(dir, `restart.${k}.${i}.json`); writeFileSync(f, "{}"); utimesSync(f, 1000 + i, 1000 + i); }
  }
  pruneRestartArchives(dir);
  expect(readdirSync(dir).length).toBe(RESTART_ARCHIVES_KEPT * 2);
  expect(existsSync(join(dir, `restart.released.${RESTART_ARCHIVES_KEPT + 2}.json`))).toBe(true);
  expect(existsSync(join(dir, "restart.released.0.json"))).toBe(false);
});
