import { expect, test } from "bun:test";
import { negotiateProtocol, protocolWindow, type ProtocolWindow } from "../src/hub/protocol-window.ts";

test("legacy versions without a minimum remain singleton windows", () => {
  expect(protocolWindow(16)).toEqual({ v: 16, vMin: 16 });
  expect(protocolWindow(16, undefined)).toEqual({ v: 16, vMin: 16 });
  expect(protocolWindow(17, 16)).toEqual({ v: 17, vMin: 16 });
});

test("protocol windows reject malformed versions without numeric coercion", () => {
  for (const value of [undefined, null, "16", "", true, false, {}, [], NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(protocolWindow(value), String(value)).toBeUndefined();
  }
  for (const minimum of [null, "16", "", true, false, {}, [], NaN, Infinity, -Infinity, 0, -1, 1.5, 18, Number.MAX_SAFE_INTEGER + 1]) {
    expect(protocolWindow(17, minimum), String(minimum)).toBeUndefined();
  }
});

test("positive safe-integer versions have no arbitrary protocol ceiling", () => {
  expect(protocolWindow(1)).toEqual({ v: 1, vMin: 1 });
  expect(protocolWindow(Number.MAX_SAFE_INTEGER, 1)).toEqual({ v: Number.MAX_SAFE_INTEGER, vMin: 1 });
  expect(protocolWindow(Number.MAX_SAFE_INTEGER)).toEqual({ v: Number.MAX_SAFE_INTEGER, vMin: Number.MAX_SAFE_INTEGER });
});

test("negotiation chooses the symmetric highest common version, including adjacent overlap", () => {
  const cases: [ProtocolWindow, ProtocolWindow, number][] = [
    [{ v: 17, vMin: 16 }, { v: 16, vMin: 15 }, 16],
    [{ v: 20, vMin: 16 }, { v: 19, vMin: 17 }, 19],
    [{ v: 16, vMin: 16 }, { v: 17, vMin: 16 }, 16],
    [{ v: 17, vMin: 17 }, { v: 17, vMin: 17 }, 17],
    [{ v: Number.MAX_SAFE_INTEGER, vMin: 1 }, { v: Number.MAX_SAFE_INTEGER, vMin: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER],
  ];
  for (const [local, remote, expected] of cases) {
    const before = JSON.stringify([local, remote]);
    expect(negotiateProtocol(local, remote)).toBe(expected); expect(negotiateProtocol(remote, local)).toBe(expected);
    expect(JSON.stringify([local, remote])).toBe(before);
  }
});

test("disjoint windows and different legacy singletons refuse symmetrically", () => {
  for (const [local, remote] of [
    [{ v: 17, vMin: 17 }, { v: 16, vMin: 15 }],
    [{ v: 16, vMin: 16 }, { v: 15, vMin: 15 }],
    [{ v: 30, vMin: 25 }, { v: 24, vMin: 20 }],
  ] as [ProtocolWindow, ProtocolWindow][]) {
    expect(negotiateProtocol(local, remote)).toBeUndefined(); expect(negotiateProtocol(remote, local)).toBeUndefined();
  }
});

test("negotiation revalidates typed interval values instead of accepting reversed or malformed numbers", () => {
  const valid: ProtocolWindow = { v: 17, vMin: 16 };
  for (const invalid of [{ v: 16, vMin: 17 }, { v: 0, vMin: 0 }, { v: NaN, vMin: 1 }, { v: 17, vMin: Infinity }, { v: 17, vMin: 1.5 }]) {
    expect(negotiateProtocol(valid, invalid)).toBeUndefined(); expect(negotiateProtocol(invalid, valid)).toBeUndefined();
  }
  for (const input of [null, undefined, [], "17"]) {
    const invalid = input as unknown as ProtocolWindow;
    expect(negotiateProtocol(valid, invalid)).toBeUndefined(); expect(negotiateProtocol(invalid, valid)).toBeUndefined();
  }
});
