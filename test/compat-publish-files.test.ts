import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPAT } from "../src/adapters/compat.ts";
import { patchCompatSource, readCompatVerified, renderPublishedReceipt, CompatPublishFilesError } from "../scripts/compat-publish-files.ts";
import type { PublishedReceipt } from "../scripts/compat-publish.ts";

const source = readFileSync(new URL("../src/adapters/compat.ts", import.meta.url), "utf8");
const receiptPath = "docs/verification/2026-11-07-candidate-9.8.7.md";
for (const [id, policy] of Object.entries(COMPAT)) {
  test(`patches only ${id} verified and receipt bytes`, () => {
    expect(readCompatVerified(source, id)).toEqual([...policy.verified]);
    const patched = patchCompatSource(source, id, "9.8.7", receiptPath);
    expect(readCompatVerified(patched, id)).toEqual([...policy.verified, "9.8.7"]);
    // Build the byte-level expected delta independently from the production parser.
    const key = source.includes(`  "${id}": {`) ? `  "${id}": {` : `  ${id}: {`;
    const rowStart = source.indexOf(key);
    const arrayStart = source.indexOf("verified: ", rowStart) + "verified: ".length;
    const oldArray = JSON.stringify(policy.verified);
    // The committed arrays use comma-space separators.
    const oldLiteral = `[${policy.verified.map(value => JSON.stringify(value)).join(", ")}]`;
    expect(source.slice(arrayStart, arrayStart + oldLiteral.length)).toBe(oldLiteral);
    expect(JSON.parse(oldLiteral)).toEqual(JSON.parse(oldArray));
    const receiptStart = source.indexOf(JSON.stringify(policy.receipt), arrayStart + oldLiteral.length);
    const expected = source.slice(0, arrayStart) + oldLiteral.slice(0, -1) + ', "9.8.7"]'
      + source.slice(arrayStart + oldLiteral.length, receiptStart) + JSON.stringify(receiptPath)
      + source.slice(receiptStart + JSON.stringify(policy.receipt).length);
    expect(patched).toBe(expected);
    expect(patchCompatSource(patched, id, "9.8.7", receiptPath)).toBe(patched);
    for (const other of Object.keys(COMPAT).filter(key => key !== id)) expect(readCompatVerified(patched, other)).toEqual(readCompatVerified(source, other));
  });
}
function fixture(key = '"sample-id"', versions = '["1.0.0"]'): string {
  return `// retained comment\nexport const COMPAT = {\n  ${key}: { label: "Sample", verified: ${versions}, line: { min: "1.0.0", below: "2.0.0" }, gate: "contract", probe: ["sample", "--version"],\n    parse: out => out,\n    trustNote: "Keep this exact text.",\n    receipt: "docs/verification/2026-11-07-sample-1.0.0.md" },\n} as const satisfies Record<string, CompatPolicy>;\n// retained footer\n`;
}
test("bare keys and spaced empty arrays retain surrounding bytes", () => {
  const text = fixture("sample", "[  ]");
  const patched = patchCompatSource(text, "sample", "1.2.3-rc.1", receiptPath);
  expect(patched).toBe(text.replace("[  ]", '["1.2.3-rc.1"  ]').replace("docs/verification/2026-11-07-sample-1.0.0.md", receiptPath));
});
test("existing verified version is not duplicated when receipt changes", () => {
  const text = fixture();
  expect(patchCompatSource(text, "sample-id", "1.0.0", receiptPath)).toBe(text.replace("docs/verification/2026-11-07-sample-1.0.0.md", receiptPath));
  const detached = readCompatVerified(text, "sample-id"); detached.push("9.9.9");
  expect(readCompatVerified(text, "sample-id")).toEqual(["1.0.0"]);
});
for (const version of ["1.0", "01.2.3", "1.2.3-01", "1.2.3+build", '1.2.3"]; attack()', "1.2.3\n"]) {
  test(`refuses unsafe or non-exact version ${JSON.stringify(version)}`, () => expect(() => patchCompatSource(source, "pi", version, receiptPath)).toThrow(CompatPublishFilesError));
}
for (const path of ["../receipt.md", "docs/verification/../../receipt.md", "docs/verification/2026-11-07-a..b.md", "docs/verification/2026-11-07-a.md\n", "docs/verification/2026-11-07-a](https://outside).md", "/tmp/receipt.md"]) {
  test(`refuses unsafe receipt path ${JSON.stringify(path)}`, () => expect(() => patchCompatSource(source, "pi", "1.2.3", path)).toThrow(CompatPublishFilesError));
}
for (const id of ["unknown", "pi\n", 'pi"', "__proto__", "Pi"]) {
  test(`refuses unknown or unsafe id ${JSON.stringify(id)}`, () => expect(() => readCompatVerified(source, id)).toThrow(CompatPublishFilesError));
}
for (const array of ["VERSIONS", "['1.0.0']", '["1.0.0",]', '["1.0.0", "1.0.0"]', '["1.0.0", ...other]', '["1.0.0", /* code */ "1.2.0"]']) {
  test(`refuses unexpected verified grammar ${array}`, () => expect(() => readCompatVerified(fixture('"sample-id"', array), "sample-id")).toThrow(CompatPublishFilesError));
}
test("refuses duplicate policy declarations and duplicate row properties", () => {
  expect(() => readCompatVerified(fixture() + fixture(), "sample-id")).toThrow(CompatPublishFilesError);
  expect(() => readCompatVerified(fixture().replace("parse: out => out,", 'verified: ["2.0.0"],'), "sample-id")).toThrow(CompatPublishFilesError);
});

function projection(): PublishedReceipt {
  return { schemaVersion: 1, id: "pi", version: "1.5.1", procedureReceipt: "docs/verification/2026-11-03-pi-150-compat.md", runnerOS: "linux", architecture: "x64",
    artifact: { method: "npm-exact", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, installation: { status: "pass", cause: "ok" },
    ownedStopConfirmed: true, processCleanup: "proven", containment: "disposable-runner-lifetime", outcome: "pass", autoAdmit: true,
    legs: [{ id: "extension", category: "linux-ci", requiredForAdmission: true, status: "pass", cause: "ok" }, { id: "model", category: "account-or-model", requiredForAdmission: false, status: "not-run", cause: "model-required" }] };
}
test("renders closed validated projection as deterministic Markdown", () => {
  const data = projection(); const before = JSON.stringify(data);
  const text = renderPublishedReceipt(data);
  expect(text).toContain("# Compatibility receipt: pi 1.5.1");
  expect(text).toContain("| model | account-or-model | no | not-run | model-required |");
  expect(text).toContain("Process cleanup: proven.");
  expect(text).toContain("](2026-11-03-pi-150-compat.md)");
  expect(text).toBe(renderPublishedReceipt(data)); expect(JSON.stringify(data)).toBe(before);
});
test("renderer refuses extra artifact prose instead of publishing it", () => {
  const data = { ...projection(), nativeOutput: "SECRET PROSE" };
  expect(() => renderPublishedReceipt(data)).toThrow(CompatPublishFilesError);
});
test("renderer refuses Markdown injection and accessor properties", () => {
  const data = projection(); data.legs[0]!.id = "row | injected";
  expect(() => renderPublishedReceipt(data)).toThrow(CompatPublishFilesError);
  let getterRead = false; const accessor = projection();
  Object.defineProperty(accessor, "id", { get() { getterRead = true; return "pi"; } });
  expect(() => renderPublishedReceipt(accessor)).toThrow(CompatPublishFilesError); expect(getterRead).toBe(false);
});
test("pure helper has no runtime policy/package imports or evaluation", () => {
  const helper = readFileSync(new URL("../scripts/compat-publish-files.ts", import.meta.url), "utf8");
  expect(helper.match(/^import (?!type\b).*$/gm) ?? []).toEqual([]);
  expect(helper).not.toMatch(/\b(?:eval|Function)\s*\(/);
});

test("bare hyphenated keys are unexpected TypeScript grammar", () => {
  expect(() => readCompatVerified(fixture("sample-id"), "sample-id")).toThrow(CompatPublishFilesError);
});
