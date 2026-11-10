import { describe, expect, test } from "bun:test";
import { ScopeStore } from "../src/models/route/turn-state.ts";

describe("owned route scope storage", () => {
  test("isolates values, refreshes LRU order and bounds entries", () => {
    const store = new ScopeStore<number>({ maxEntries: 2, now: () => 0 });
    store.set("one", 1); store.set("two", 2);
    expect(store.get("one")).toBe(1);
    store.set("three", 3);
    expect(store.get("two")).toBeUndefined();
    expect(store.get("one")).toBe(1);
    expect(store.get("three")).toBe(3);
    store.delete("one");
    expect(store.get("one")).toBeUndefined();
  });

  test("a read does not prolong expiry; a write establishes a fresh lifetime", () => {
    let time = 0;
    const store = new ScopeStore<string>({ ttlMs: 10, now: () => time });
    store.set("scope", "old"); time = 9;
    expect(store.get("scope")).toBe("old"); time = 10;
    expect(store.get("scope")).toBeUndefined();
    store.set("scope", "new"); time = 19;
    expect(store.get("scope")).toBe("new"); time = 20;
    expect(store.get("scope")).toBeUndefined();
  });

  test("defaults are explicit 512 entries and one hour, not inferred old defaults", () => {
    let time = 0;
    const store = new ScopeStore<number>({ now: () => time });
    for (let index = 0; index <= 512; index++) store.set(`scope-${index}`, index);
    expect(store.get("scope-0")).toBeUndefined();
    expect(store.get("scope-1")).toBe(1);
    time = 3_600_000;
    expect(store.get("scope-512")).toBeUndefined();
  });

  test("clock rollback cannot resurrect retained state and invalid clocks refuse", () => {
    let time = 10;
    const store = new ScopeStore<number>({ now: () => time });
    store.set("scope", 1); time = 9;
    expect(store.get("scope")).toBeUndefined();
    time = Number.NaN;
    expect(() => store.set("scope", 2)).toThrow();
  });

  test("rollback above write timestamps invalidates all scopes, and undefined refuses", () => {
    let time = 10;
    const store = new ScopeStore<number | undefined>({ now: () => time });
    store.set("one", 1); store.set("two", 2);
    time = 30;
    expect(store.get("one")).toBe(1);
    time = 20;
    expect(store.get("one")).toBeUndefined();
    expect(store.get("two")).toBeUndefined();
    store.set("fresh", 3);
    expect(store.get("fresh")).toBe(3);
    expect(() => store.set("ambiguous", undefined)).toThrow();
  });

  test("invalid resource options and oversized opaque keys refuse", () => {
    expect(() => new ScopeStore({ maxEntries: 513 })).toThrow();
    expect(() => new ScopeStore({ ttlMs: 3_600_001 })).toThrow();
    const store = new ScopeStore();
    expect(() => store.set("", 1)).toThrow();
    expect(() => store.set("한".repeat(1366), 1)).toThrow();
    expect(() => store.get("a".repeat(4097))).toThrow();
  });
});
