import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomStore, RoomStoreError } from "../src/rooms/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-room-open-737-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const stateDir = join(cwd, "state"); mkdirSync(join(stateDir, "rooms"), { recursive: true });
  return { cwd, stateDir };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
test("room open failure reports a closed cause, retries the same store and clears unavailable", async () => {
  const options = fixture(), recovered = signal(); let calls = 0;
  const commands = new RoomCommands({ ...options, retryMs: 1,
    openStore: async input => { if (++calls === 1) throw new RoomStoreError("busy"); return RoomStore.open(input); },
    changed: () => { if (calls > 1 && !commands.unavailable()) recovered.resolve(); },
  });
  cleanups.push(() => commands.stop());
  await expect(commands.start()).rejects.toMatchObject({ code: "busy" });
  expect(commands.statusView()).toBeNull();
  expect(commands.unavailable()).toMatchObject({ code: "busy" });
  expect(commands.unavailable()?.nextStep).toContain("competing room store writer");
  await recovered.promise;
  expect(calls).toBe(2); expect(commands.unavailable()).toBeUndefined();
  expect(commands.statusView()).toEqual([]);
});
test("stop cancels a scheduled room-open retry and waits for an in-flight open", async () => {
  const options = fixture(); let calls = 0;
  const commands = new RoomCommands({ ...options, retryMs: 1, openStore: async () => { calls++; throw new RoomStoreError("busy"); } });
  await expect(commands.start()).rejects.toThrow(); await commands.stop();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toBe(1); expect(commands.statusView()).toBeNull();

  const gate = signal(), entered = signal(); let opened: RoomStore | undefined;
  const inflight = new RoomCommands({ ...options, openStore: async input => { entered.resolve(); await gate.promise; return opened = await RoomStore.open(input); } });
  const opening = inflight.start(); void opening.catch(() => undefined); await entered.promise;
  const stopping = inflight.stop(); gate.resolve(); await stopping; await expect(opening).rejects.toThrow("stopped");
  expect(() => opened!.list()).toThrow("closed");
});
test("room clock rollback is named without writing clock state or leaking a raw open error", async () => {
  const options = fixture(); let now = Date.now();
  const commands = new RoomCommands({ ...options, clock: () => now }); cleanups.push(() => commands.stop());
  const preview = await commands.preview("create", { name: "work", broker: "ws://127.0.0.1:1/" }, () => true); await preview.commit();
  now -= 1;
  expect(commands.statusView()).toBeNull(); expect(commands.unavailable()?.code).toBe("clock_rollback");
  expect(commands.unavailable()?.nextStep).toContain("Correct the system clock");
  now += 1; expect(commands.statusView()).toHaveLength(1); expect(commands.unavailable()).toBeUndefined();

  const bad = new RoomCommands({ ...fixture(), retryMs: 30_000, openStore: async () => { throw new Error("PRIVATE_PATH_CANARY"); } });
  cleanups.push(() => bad.stop()); await expect(bad.start()).rejects.toThrow();
  expect(bad.unavailable()?.code).toBe("unavailable"); expect(JSON.stringify(bad.unavailable())).not.toContain("CANARY");
});

test("an aggregate-only health failure publishes unavailable in the same snapshot and clears on recovery", async () => {
  const options = fixture(); let store: RoomStore | undefined;
  const commands = new RoomCommands({ ...options, openStore: async input => store = await RoomStore.open(input) });
  cleanups.push(() => commands.stop());
  const preview = await commands.preview("create", { name: "work", broker: "ws://127.0.0.1:1/" }, () => true); await preview.commit();
  const health = store!.health.bind(store!);
  store!.health = () => { throw new RoomStoreError("corrupt"); };
  expect(store!.statusMetadata()).toHaveLength(1);
  expect(commands.statusSnapshot()).toMatchObject({ rooms: null, roomsUnavailable: { code: "corrupt" } });
  store!.health = health;
  expect(commands.statusSnapshot().rooms).toHaveLength(1);
  expect(commands.statusSnapshot().roomsUnavailable).toBeUndefined();
});

test("startup enumeration failure retries the already-open store instead of losing all links", async () => {
  const options = fixture(), recovered = signal(); let opens = 0, lists = 0;
  const commands = new RoomCommands({ ...options, retryMs: 1, openStore: async input => {
    opens++; const store = await RoomStore.open(input), list = store.list.bind(store);
    store.list = () => { if (++lists === 1) throw new RoomStoreError("busy"); return list(); };
    return store;
  }, changed: () => { if (lists >= 2 && !commands.unavailable()) recovered.resolve(); } });
  cleanups.push(() => commands.stop());
  await expect(commands.start()).rejects.toMatchObject({ code: "busy" });
  expect(commands.statusSnapshot()).toMatchObject({ rooms: null, roomsUnavailable: { code: "busy" } });
  await recovered.promise;
  expect(opens).toBe(1); expect(lists).toBe(2); expect(commands.statusSnapshot()).toEqual({ rooms: [] });
});
