import { expect, test } from "bun:test";
import { checkFrozenConsumerParity, checkInstalledConsumerParity, legacyInstallation } from "../scripts/check-memory-consumer-parity.ts";

test("package consumer CLI matches frozen installed 0.12.29 JSON on a copied synthetic home", () => {
  expect(checkFrozenConsumerParity()).toMatchObject({ legacyVersion: "0.12.29", authoredFilesUnchanged: true, sourceFixtureUnchanged: true, derivedIndexWritesAllowed: true });
}, 20_000);

const legacy = legacyInstallation();
test.skipIf(!legacy.available)(`installed legacy/new package reciprocal library writes and CLI reads${legacy.available ? "" : ` (skip: ${legacy.reason}; run scripts/check-memory-consumer-parity.ts locally)`}`, async () => {
  const receipt = await checkInstalledConsumerParity();
  expect(receipt.legacyVersion).toBe("0.12.29");
  expect(receipt.directions.map(direction => [direction.writer, direction.reader])).toEqual([
    ["@staix/agent-mem MemoryStore", "installed legacy CLI"], ["installed legacy MemoryStore", "new source CLI"],
  ]);
  expect(receipt.directions.every(direction => direction.authoredFilesUnchanged)).toBe(true);
  expect(receipt.sourceFixtureUnchanged).toBe(true);
  expect(receipt.derivedIndexWritesAllowed).toBe(true);
}, 20_000);
