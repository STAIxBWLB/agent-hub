import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPAT, assessVersion } from "../src/adapters/compat.ts";
import { agyVersionGate } from "../src/adapters/agy/entry.ts";

// #843 AC5: agy 1.4.7 is receipt-verified, and the receipt names every leg it repeated.
test("agy 1.4.7 is receipt-verified next to 1.4.2, and other 1.4.x patches stay unverified (#843 AC5)", () => {
  expect(COMPAT.agy.verified).toEqual(["1.4.2", "1.4.7"]);
  expect(COMPAT.agy.line).toEqual({ min: "1.4.0", below: "1.5.0" });
  for (const version of ["1.4.2", "1.4.7"]) expect(assessVersion("agy", version, []), version).toMatchObject({ ok: true, state: "verified", version });
  for (const version of ["1.4.3", "1.4.8", "1.4.0"]) expect(assessVersion("agy", version, []), version).toMatchObject({ ok: true, state: "in-line" });
  for (const version of ["1.5.0", "1.3.9", "2.0.0"]) expect(assessVersion("agy", version, []).ok, version).toBe(false);
  // The launcher gate: a verified version launches without a warning, an unverified patch with one.
  expect(agyVersionGate("1.4.7\n")).toEqual({ ok: true });
  const patch = agyVersionGate("1.4.8\n");
  expect(patch.ok).toBe(true); expect(patch.ok && patch.message).toContain("agy 1.4.8");
});

test("the agy 1.4.7 receipt records the exact binary, the isolation and every repeated leg (#843 AC5)", () => {
  const receipt = readFileSync(join(import.meta.dir, "../docs/verification/2026-10-26-agy-1.4.7.md"), "utf8");
  expect(receipt).toMatch(/[0-9a-f]{64}/); // the exact binary: agy self-updates
  for (const leg of ["--acp", "--new", "agy mcp list", "hub_inbox", "SessionStart", "PreToolUse", "PostToolUse", "Stop", "read_file", "call_mcp_tool", "Normal close", "Not verified", "ahub agy"]) expect(receipt, leg).toContain(leg);
  expect(receipt).toContain("No real account"); // account-free: a leg that needs an account is named, never faked
});
