import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReceiptOutput, RECEIPT_OUTPUT_MS } from "../scripts/compat-receipts/output.ts";
import type { ReceiptSummary } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "ahub-output-")); roots.push(root); return root; }
const summary: ReceiptSummary = { schemaVersion: 1, id: "pi", version: "9.8.7", runnerOS: "fixture", architecture: "fixture", procedureReceipt: "fixture.md",
  generatedAt: "2026-11-07T00:00:00.000Z", bounds: { totalMs: 10, legMs: 10, cleanupMs: 10, outputMs: RECEIPT_OUTPUT_MS }, ownedStopConfirmed: true,
  processCleanup: "unproven", processCleanupReason: "fixture", containment: "disposable-runner-lifetime",
  installation: { status: "not-run", cause: "producer-not-committed", reason: "fixture", nextStep: "fixture" }, artifact: null, integrity: null,
  autoAdmit: false, eligible: false, outcome: "not-run", elapsedMs: 0, legs: [] };

test("retained output FD writes only the original directory after its parent is swapped for a symlink", () => {
  const root = fixture(), parent = join(root, "parent"), out = join(parent, "out"), moved = join(root, "moved"), external = join(root, "external");
  mkdirSync(out, { recursive: true }); mkdirSync(join(external, "out"), { recursive: true });
  writeFileSync(join(external, "out", "keep"), "external-untouched");
  const output = openReceiptOutput(out);
  try {
    renameSync(parent, moved); symlinkSync(external, parent);
    output.write(summary, "# Fixture receipt\n");
    expect(readdirSync(join(external, "out"))).toEqual(["keep"]);
    expect(readFileSync(join(external, "out", "keep"), "utf8")).toBe("external-untouched");
    expect(JSON.parse(readFileSync(join(moved, "out", "summary.json"), "utf8"))).toEqual(summary);
    expect(readFileSync(join(moved, "out", "receipt.md"), "utf8")).toBe("# Fixture receipt\n");
    expect(statSync(join(moved, "out", "summary.json")).mode & 0o777).toBe(0o600);
  } finally { output.close(); output.close(); }
});

test("pre-existing output leaves, including dangling symlinks, are refused before a run", () => {
  for (const name of ["summary.json", "receipt.md"]) {
    const root = fixture(), out = join(root, "out"); mkdirSync(out);
    symlinkSync(join(root, "absent"), join(out, name));
    expect(() => openReceiptOutput(out)).toThrow();
    expect(readdirSync(out)).toEqual([name]);
  }
});

test("a caller-owned symlink ancestor or non-sticky shared ancestor cannot redirect output acquisition", () => {
  const root = fixture(), external = join(root, "external"), alias = join(root, "alias"); mkdirSync(external); symlinkSync(external, alias);
  expect(() => openReceiptOutput(join(alias, "out"))).toThrow(); expect(readdirSync(external)).toEqual([]);
  const unsafe = join(root, "shared"); mkdirSync(unsafe); chmodSync(unsafe, 0o777);
  expect(() => openReceiptOutput(join(unsafe, "out"))).toThrow(); expect(readdirSync(unsafe)).toEqual([]);
});

test("a late occupied output is never overwritten and a closed handle cannot write", () => {
  const root = fixture(), out = join(root, "out"), output = openReceiptOutput(out);
  writeFileSync(join(out, "receipt.md"), "keep-late");
  try { expect(() => output.write(summary, "replace")).toThrow(); expect(readFileSync(join(out, "receipt.md"), "utf8")).toBe("keep-late"); }
  finally { output.close(); }
  expect(() => output.write(summary, "after-close")).toThrow();
  expect(readdirSync(out)).toEqual(["receipt.md"]);
  expect(RECEIPT_OUTPUT_MS).toBe(4000);
});


test("missing trusted Python refuses before creating the output directory", () => {
  const root = fixture(), out = join(root, "out"), which = spyOn(Bun, "which").mockReturnValue(null);
  try { expect(() => openReceiptOutput(out)).toThrow(); expect(existsSync(out)).toBe(false); }
  finally { which.mockRestore(); }
});
