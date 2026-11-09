import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const folder = new URL("../integrations/claude-code/", import.meta.url);
const matrix = JSON.parse(readFileSync(new URL("support-matrix.json", folder), "utf8"));
const names = ["terminal", "desktop", "vscode", "mobile"];
const legs = ["pane", "attentionBand", "compactOriginal", "composerOrigin", "modelInputsOnOff", "disableRemove", "standaloneHub", "statusReadBounds"];
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.exec(value)?.[0] === value;
function earlier(left: string, right: string): boolean {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! < b[i]!; }
  return false;
}
function receipt(text: string | undefined): Record<string, any> | undefined {
  if (!text?.trim()) return undefined;
  try { const value = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? ""); return object(value) ? value : undefined; } catch { return undefined; }
}
/** A data/test gate, not a claim that synthetic receipts are native observations. */
function surfaceErrors(row: any, text: string | undefined): string[] {
  const result: string[] = [], data = receipt(text);
  if (!names.includes(row.name) || row.receipt !== `receipts/${row.name}.md`) result.push("surface path");
  if (!["supported", "fixture_only", "unsupported"].includes(row.verdict)) result.push("verdict");
  if (!data || data.surface !== row.name) result.push("own receipt missing/mismatched");
  if (row.verdict === "supported") {
    if (row.status !== "PASSED" || !data || data.status !== "PASSED" || /NOT RUN|UNKNOWN|TODO|PLACEHOLDER/i.test(text ?? "")) result.push("native evidence incomplete");
    if (!version(row.qualifiedVersion) || data?.claudeCodeVersion !== row.qualifiedVersion) result.push("qualified version");
    if (typeof data?.sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(data.sourceHead) || data.sourceHead.length !== 40 || data.sourceHead !== row.qualifiedSourceHead) result.push("native head");
    if (typeof data?.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt)) || typeof data?.platform !== "string" || !data.platform.trim()) result.push("observation identity");
    if (!legs.every(leg => data?.native?.[leg] === "PASSED")) result.push("native legs");
    if (!Array.isArray(data?.evidenceRefs) || !data.evidenceRefs.length || !data.evidenceRefs.every((value: unknown) => typeof value === "string" && value.trim())) result.push("evidence references");
    if (!["knownNotice", "refresh", "completeConsole"].every(key => Number.isSafeInteger(data?.actionCounts?.[key]) && data!.actionCounts[key] >= 0)) result.push("observed actions");
  } else if (row.qualifiedSourceHead !== null) result.push("unqualified head claim");
  if (row.verdict !== "supported" && row.qualifiedVersion !== null) result.push("unqualified version claim");
  return result;
}
function matrixErrors(data: any, texts: Map<string, string>): string[] {
  const errors: string[] = [], rows = data.surfaces ?? [];
  if (rows.length !== 4 || new Set(rows.map((row: any) => row.name)).size !== 4 || !names.every(name => rows.some((row: any) => row.name === name))) errors.push("four independent surfaces");
  for (const row of rows) errors.push(...surfaceErrors(row, texts.get(row.receipt)));
  const supported = rows.filter((row: any) => row.verdict === "supported"), nativeVersions = [...new Set(supported.map((row: any) => row.qualifiedVersion))].sort();
  if (JSON.stringify([...(data.nativeSupportedVersions ?? [])].sort()) !== JSON.stringify(nativeVersions)) errors.push("native versions require own receipts");
  if (data.minimumSupportedVersion !== null) {
    const proof = data.minimumVersionEvidence, row = rows.find((row: any) => row.name === proof?.surface), evidence = receipt(texts.get(row?.receipt));
    if (!version(data.minimumSupportedVersion) || !row || row.verdict !== "supported" || surfaceErrors(row, texts.get(row.receipt)).length ||
      proof?.receipt !== row.receipt || proof?.minimum !== data.minimumSupportedVersion || row.qualifiedVersion !== data.minimumSupportedVersion || proof?.sourceHead !== row.qualifiedSourceHead || evidence?.minimumVersionEvidence?.minimum !== data.minimumSupportedVersion ||
      evidence?.minimumVersionEvidence?.atMinimum !== "PASSED" || evidence?.minimumVersionEvidence?.belowMinimum !== "UNSUPPORTED" || !version(evidence?.minimumVersionEvidence?.lowerVersion) || !earlier(evidence.minimumVersionEvidence.lowerVersion, data.minimumSupportedVersion)) errors.push("minimum version requires native boundary evidence");
  } else if (data.minimumVersionEvidence !== null) errors.push("unknown minimum has no invented boundary");
  return errors;
}
const actual = new Map<string, string>(names.map(name => [`receipts/${name}.md`, readFileSync(new URL(`receipts/${name}.md`, folder), "utf8")]));
function completedFixture(surface: string) {
  return `# Synthetic test copy only\n\n\`\`\`json\n${JSON.stringify({ schema: 1, surface, status: "PASSED", observedAt: "2026-11-10T00:00:00Z", platform: "fixtureOS", claudeCodeVersion: "9.9.9", sourceHead: "a".repeat(40), native: Object.fromEntries(legs.map(leg => [leg, "PASSED"])), actionCounts: { knownNotice: 0, refresh: 1, completeConsole: 2 }, minimumVersionEvidence: null, evidenceRefs: ["synthetic-test-only"] })}\n\`\`\``;
}

test("committed manual-only matrix has four independent unqualified receipts and unknown minimum", () => {
  expect(matrixErrors(matrix, actual)).toEqual([]);
  expect(matrix.distribution.mode).toBe("manual_session_only"); expect(matrix.distribution.marketplaceCompanionEntry).toBe(false);
  expect(matrix.minimumSupportedVersion).toBeNull(); expect(matrix.nativeSupportedVersions).toEqual([]);
  for (const row of matrix.surfaces) { expect(row.verdict).not.toBe("supported"); expect(receipt(actual.get(row.receipt))?.status).toBe("NOT RUN"); }
  const marketplace = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  expect(marketplace.plugins.some((plugin: any) => plugin.name === "agent-hub-companion")).toBe(false);
});

test("missing, empty, NOT RUN, placeholder or another surface receipt cannot establish support", () => {
  const row = { name: "terminal", status: "PASSED", verdict: "supported", qualifiedSourceHead: "a".repeat(40), qualifiedVersion: "9.9.9", receipt: "receipts/terminal.md" };
  for (const text of [undefined, "", actual.get(row.receipt), "Status: PASSED", completedFixture("terminal") + "\nTODO", completedFixture("desktop")]) expect(surfaceErrors(row, text).length).toBeGreaterThan(0);
  expect(surfaceErrors(row, completedFixture("terminal"))).toEqual([]);
});

test("surface/version/head/native-leg/action identity must all qualify independently", () => {
  const row = { name: "terminal", status: "PASSED", verdict: "supported", qualifiedSourceHead: "a".repeat(40), qualifiedVersion: "9.9.9", receipt: "receipts/terminal.md" };
  for (const change of [
    (data: any) => { data.claudeCodeVersion = "2.1.319"; }, (data: any) => { data.sourceHead = null; }, (data: any) => { data.sourceHead = "b".repeat(40); },
    (data: any) => { data.evidenceRefs = []; }, (data: any) => { data.native.disableRemove = "NOT RUN"; }, (data: any) => { data.actionCounts.refresh = null; },
  ]) {
    const value = receipt(completedFixture("terminal"))!; change(value);
    expect(surfaceErrors(row, `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``).length).toBeGreaterThan(0);
  }
});

test("declared/static version and one tested native version do not establish a minimum boundary", () => {
  const copy = structuredClone(matrix); copy.minimumSupportedVersion = copy.declaredVersion;
  expect(matrixErrors(copy, actual)).toContain("minimum version requires native boundary evidence");
  const row = copy.surfaces.find((value: any) => value.name === "terminal"); row.verdict = "supported"; row.status = "PASSED"; row.qualifiedVersion = "9.9.9"; row.qualifiedSourceHead = "a".repeat(40);
  copy.nativeSupportedVersions = ["9.9.9"]; copy.minimumSupportedVersion = "9.9.9";
  const receipts = new Map(actual); receipts.set(row.receipt, completedFixture("terminal"));
  expect(matrixErrors(copy, receipts)).toContain("minimum version requires native boundary evidence");
});

 test("supported row status and a strictly earlier native boundary are required", () => {
  const copy = structuredClone(matrix), row = copy.surfaces.find((value: any) => value.name === "terminal");
  Object.assign(row, { verdict: "supported", status: "PASSED", qualifiedVersion: "9.9.9", qualifiedSourceHead: "a".repeat(40) });
  copy.nativeSupportedVersions = ["9.9.9"]; copy.minimumSupportedVersion = "9.9.9";
  copy.minimumVersionEvidence = { surface: "terminal", receipt: row.receipt, minimum: "9.9.9", sourceHead: row.qualifiedSourceHead };
  const value = receipt(completedFixture("terminal"))!;
  value.minimumVersionEvidence = { minimum: "9.9.9", atMinimum: "PASSED", belowMinimum: "UNSUPPORTED", lowerVersion: "9.9.8" };
  const texts = () => new Map(actual).set(row.receipt, `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  expect(matrixErrors(copy, texts())).toEqual([]);
  row.status = "NOT RUN"; expect(matrixErrors(copy, texts()).length).toBeGreaterThan(0); row.status = "PASSED";
  for (const lower of ["9.9.9", "9.10.0", "10.0.0"]) { value.minimumVersionEvidence.lowerVersion = lower; expect(matrixErrors(copy, texts())).toContain("minimum version requires native boundary evidence"); }
  value.minimumVersionEvidence.lowerVersion = "9.9.8"; row.qualifiedVersion = "9.9.10"; expect(matrixErrors(copy, texts()).length).toBeGreaterThan(0);
});
