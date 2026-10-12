import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNeedsSummary, petView, readPet, renderPet } from "../src/cli/pet.ts";

const none = { lock: () => undefined, runner: () => undefined };
test("pet summary parsing excludes private fields and rejects unknown or inconsistent metadata", () => {
  const secret = () => { throw new Error("private source read"); };
  const raw = { act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7, get title() { return secret(); } }, get body() { return secret(); } };
  expect(parseNeedsSummary(raw)).toEqual({ act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7 } });
  expect(parseNeedsSummary({ act: raw.act, watch: raw.watch, first: raw.first, state: { toString: secret } })).toBeUndefined();
  expect(parseNeedsSummary({ act: 0, watch: 0, state: "waiting" })).toBeUndefined();
  expect(parseNeedsSummary({ act: 1, watch: 0, state: "idle", first: raw.first })).toBeUndefined();
  expect(parseNeedsSummary({ act: 1, watch: 0, state: "review", first: { kind: "message", level: "act", id: "message" } })).toBeUndefined();
});

test("recovery overlay replaces a reported watch once and never treats unknown as absent", () => {
  const status = { needs: { act: 1, watch: 2, state: "review", first: { kind: "review", level: "act", id: 7 } }, recovery: { operationId: "operation" } };
  const absent = petView(status, { lock: () => "operation", runner: () => undefined });
  expect(absent.summary).toEqual({ act: 2, watch: 1, state: "blocked", first: { kind: "recovery", level: "act", id: "operation" } });
  const unknown = petView(status, { lock: () => "operation", runner: () => "unknown" });
  expect(unknown.summary?.act).toBe(1); expect(unknown.summary?.watch).toBe(2); expect(unknown.summary?.state).toBe("review");
  expect(unknown.runnerUnknown).toBe(true);
  const waiting = petView({ needs: { act: 1, watch: 0, state: "waiting", first: { kind: "approval", level: "act", id: "request", until: 2000 } } }, { lock: () => "operation", runner: () => undefined });
  expect(waiting.summary?.state).toBe("waiting"); expect(waiting.summary?.first?.kind).toBe("approval");
});

test("pet reads only a confirmed status owner and binds the process signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pet-read-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ pid: 12, pidSignature: "signed-owner", needs: { act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7 } } }));
    let observed: unknown;
    const view = readPet(dir, none, (pid, signature) => { observed = [pid, signature]; return "live"; });
    expect(observed).toEqual([12, "signed-owner"]); expect(renderPet(view, true)).toBe("ahub!1");
    for (const state of ["gone", "unknown"] as const) expect(renderPet(readPet(dir, none, () => state))).toBe("attention unavailable");
    writeFileSync(join(dir, "status.json"), "invalid"); expect(renderPet(readPet(dir, none))).toBe("attention unavailable");
  } finally { rmSync(dir, { recursive: true }); }
});

test("pet output is static ASCII without console keys and empty short output is actually empty", () => {
  const view = petView({ needs: { act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7 } } }, none);
  expect(renderPet(view)).toBe("(O O) ? 1 for review"); expect(renderPet(view)).toMatch(/^[ -~]*$/);
  expect(renderPet(petView({ needs: { act: 0, watch: 0, state: "idle" } }, none), true)).toBe("");
  expect(renderPet(petView(undefined, none), true)).toBe("");
  const blocked = petView(undefined, { lock: () => "operation", runner: () => undefined });
  expect(renderPet(blocked)).toContain("blocked (1)"); expect(renderPet(blocked)).toContain("status unavailable");
});
