import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableColumnProblems } from "@staix/agent-console/conformance";
import type { VisualPayload } from "@staix/agent-console/contract";
import { VISUAL_CASES } from "@staix/agent-console/visual-cases";
import cases from "./fixtures/visual/cases.json";
import { validateVisualPayload, VisualValidationError, VISUAL_LIMITS } from "../src/hub/visual.ts";

// Historical hub-owned candidates remain extra coverage; the published canonical cases below are imported, never copied.
for (const value of cases.valid) test(`acon contract candidate round-trip: ${value.id}`, () => {
  const payload: VisualPayload = validateVisualPayload(value.payload, () => true);
  expect<unknown>(payload).toEqual(value.payload);
  if (payload.kind === "table") expect(tableColumnProblems(payload.columns)).toEqual([]);
});
for (const value of cases.invalid) test(`visual candidate refusal: ${value.id}`, () => {
  expect(() => validateVisualPayload(value.payload, () => true)).toThrow();
});

test("extra hub candidate provenance distinguishes its historical source from the current published recheck", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.resolve("@staix/agent-console/contract"))));
  expect(cases.provenance.version).toBe("0.1.3");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(cases.provenance.recheckedAgainst.version);
  for (const relative of ["src/contract.ts", "src/conformance.ts", "shell/shell.js", "src/visual-cases.ts"] as const) {
    const data = readFileSync(join(root, relative));
    const gitBlob = createHash("sha1").update(`blob ${data.length}${String.fromCharCode(0)}`).update(data).digest("hex");
    expect(gitBlob, relative).toBe(cases.provenance.recheckedAgainst.sources[relative]);
  }
  expect(cases.provenance.ownership).toBe("hub-owned candidate, not an upstream shared visual fixture");
  expect(readFileSync(join(root, "shell/shell.js"), "utf8")).toContain("rows: 500, columns: 12");
  expect(VISUAL_LIMITS.rows).toBe(500); expect(VISUAL_LIMITS.columns).toBe(12);
  expect(tableColumnProblems(Array.from({ length: 13 }, (_, i) => ({ key: String(i), label: String(i) })))).not.toEqual([]);
});

// Hub admission ceilings are deliberately stricter than acon's renderable shape. These six named differences
// are fixed expectations, not inferred from the validator's current outcome. They do not exempt any shape error.
const HUB_CAP_DIFFERENCES: Readonly<Record<string, { field: string; rationale: string }>> = Object.freeze({
  "mermaid-source-multibyte": { field: "source", rationale: "acon admits 20 * 1024 UTF-16 code units; the hub admits at most 20 * 1024 UTF-8 bytes" },
  "mermaid-source-emoji-at-limit": { field: "source", rationale: "acon admits 20 * 1024 UTF-16 code units; the hub admits at most 20 * 1024 UTF-8 bytes" },
  "table-caption-unbounded": { field: "caption", rationale: "acon captions have no length ceiling; the hub admits at most 2000 UTF-8 bytes" },
  "before-after-caption-unbounded": { field: "caption", rationale: "acon captions have no length ceiling; the hub admits at most 2000 UTF-8 bytes" },
  "asset-id-at-limit": { field: "before.asset", rationale: "acon accepts 512-code-unit asset IDs; the hub admits at most 256 UTF-8 bytes" },
  "after-asset-id-at-limit": { field: "after.asset", rationale: "acon accepts 512-code-unit asset IDs; the hub admits at most 256 UTF-8 bytes" },
});
function refusalField(payload: unknown): string {
  try { validateVisualPayload(payload, () => true); }
  catch (error) {
    expect(error).toBeInstanceOf(VisualValidationError);
    if (!(error instanceof VisualValidationError)) throw error;
    return error.field.replace(/^payload\./, "");
  }
  throw Error("canonical case expected a visual refusal");
}
for (const value of VISUAL_CASES) test(`published acon visual case: ${value.id}`, () => {
  const difference = HUB_CAP_DIFFERENCES[value.id];
  if (!value.expected.valid) {
    expect(difference).toBeUndefined();
    expect(refusalField(value.payload)).toBe(value.expected.field);
  } else if (difference) {
    expect(difference.rationale.length).toBeGreaterThan(0);
    expect(refusalField(value.payload)).toBe(difference.field);
  } else {
    expect<unknown>(validateVisualPayload(value.payload, () => true)).toEqual(value.payload);
  }
});
test("every published canonical case is exercised and cap exceptions name only published valid cases", () => {
  expect(VISUAL_CASES).toHaveLength(42);
  expect(new Set(VISUAL_CASES.map(value => value.id)).size).toBe(VISUAL_CASES.length);
  expect(Object.isFrozen(VISUAL_CASES)).toBe(true);
  expect(Object.keys(HUB_CAP_DIFFERENCES)).toHaveLength(6);
  for (const id of Object.keys(HUB_CAP_DIFFERENCES)) expect(VISUAL_CASES.find(value => value.id === id)?.expected.valid).toBe(true);
  expect(VISUAL_LIMITS.source).toBe(20 * 1024); expect(VISUAL_LIMITS.caption).toBe(2000); expect(VISUAL_LIMITS.asset).toBe(256);
});
