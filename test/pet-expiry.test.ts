import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPet, renderPet } from "../src/cli/pet.ts";

test("expired first approval makes file counts unavailable rather than guessing a remaining count", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-pet-expiry-"));
  const reader = { lock: () => undefined, runner: () => undefined };
  try {
    writeFileSync(join(root, "status.json"), JSON.stringify({ pid: 12, needs: { act: 3, watch: 1, state: "waiting", first: { kind: "approval", level: "act", id: "expired", until: Date.now() - 1 } } }));
    const result = readPet(root, reader, () => "live");
    expect(result.summary).toBeUndefined(); expect(result.unavailable).toBe(true);
    expect(renderPet(result, true)).toBe(""); expect(renderPet(result)).toBe("attention unavailable");
  } finally { rmSync(root, { recursive: true }); }
});
