import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableColumnProblems } from "@staix/agent-console/conformance";
import type { VisualPayload } from "@staix/agent-console/contract";
import cases from "./fixtures/visual/cases.json";
import { validateVisualPayload, VISUAL_LIMITS } from "../src/hub/visual.ts";

// Candidate hub fixtures, with actual upstream provenance. The package has no shared visual producer yet.
for (const value of cases.valid) test(`acon contract candidate round-trip: ${value.id}`, () => {
  const payload: VisualPayload = validateVisualPayload(value.payload, () => true);
  expect<unknown>(payload).toEqual(value.payload);
  if (payload.kind === "table") expect(tableColumnProblems(payload.columns)).toEqual([]);
});
for (const value of cases.invalid) test(`visual candidate refusal: ${value.id}`, () => {
  expect(() => validateVisualPayload(value.payload, () => true)).toThrow();
});

test("candidate provenance binds the actual published contract/conformance/shell, without inventing shared visual status", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.resolve("@staix/agent-console/contract"))));
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(cases.provenance.version);
  for (const relative of ["src/contract.ts", "src/conformance.ts", "shell/shell.js"] as const) {
    const data = readFileSync(join(root, relative));
    const gitBlob = createHash("sha1").update(`blob ${data.length}${String.fromCharCode(0)}`).update(data).digest("hex");
    expect(gitBlob, relative).toBe(cases.provenance.sources[relative]);
  }
  expect(cases.provenance.ownership).toBe("hub-owned candidate, not an upstream shared visual fixture");
  expect(readFileSync(join(root, "shell/shell.js"), "utf8")).toContain("rows: 500, columns: 12");
  expect(VISUAL_LIMITS.rows).toBe(500); expect(VISUAL_LIMITS.columns).toBe(12);
  expect(tableColumnProblems(Array.from({ length: 13 }, (_, i) => ({ key: String(i), label: String(i) })))).not.toEqual([]);
});
