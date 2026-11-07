import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareCompatArtifacts, type CompatBuildContext, type PreparedBundleDescriptor } from "../scripts/compat-prepare.ts";
import { readCompatVerified } from "../scripts/compat-publish-files.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SOURCE = "src/adapters/compat.ts", SERVER = "plugins/agent-hub/server.js", PLUGIN = "plugins/agent-hub/.claude-plugin/plugin.json", NOTICE = "plugins/agent-hub/ROLE-NOTICE.md";
const head = "a".repeat(40), date = "2026-11-07", integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fixture(ids = ["pi"]) {
  const root = mkdtempSync(join(tmpdir(), "ahub-prepare-test-")); roots.push(root);
  const out = join(root, "prepared"), summariesDir = join(root, "receipts"), watchFile = join(root, "watch.json"); mkdirSync(summariesDir);
  const source = 'export const COMPAT = {\n' + ["pi", "qwen"].map(id => `  ${id}: { label: "Fixture ${id}", verified: ["1.0.0"], gate: "contract",\n    receipt: "docs/verification/2026-11-03-${id}-fixture.md" },\n`).join("") + '} as const satisfies Record<string, CompatPolicy>;\n';
  const put = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text, { mode: 0o644 }); };
  put(SOURCE, source); put(SERVER, "// original bundle\n"); put(PLUGIN, '{"name":"agent-hub","version":"0.34.1"}\n'); put(NOTICE, "original notice\n"); put(".bun-version", "1.4.2\n");
  const entries = Object.fromEntries(["pi", "qwen"].map(id => [id, { receipt: `docs/verification/2026-11-03-${id}-fixture.md`, autoAdmit: true,
    nativePlatform: "macos-arm64", runnerOS: ["macos"], install: { method: "npm-exact" },
    legs: [{ id: "native-identity", category: "macos-runner", runnerOS: ["macos"], requiredForAdmission: true }] }]));
  put("scripts/compat-receipts/manifest.json", JSON.stringify({ schemaVersion: 1, entries }));
  const candidates = ids.map(id => ({ id, version: "1.1.0" }));
  const report = ['Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).', "", ...ids.map(id => `- **${id}** (npm @fixture/${id}): latest 1.1.0, refused; verified 1.0.0; repeat the receipt in docs/verification/2026-11-03-${id}-fixture.md before adding the version.`), "", `Checked ${date} by .github/workflows/agent-compat.yml.`].join("\n");
  writeFileSync(watchFile, JSON.stringify({ schemaVersion: 1, code: 3, report, ahead: candidates, matrix: { include: [] } }));
  for (const candidate of candidates) {
    const dir = join(summariesDir, `compat-receipt-${candidate.id}-${candidate.version}`); mkdirSync(dir);
    const summary = { schemaVersion: 1, ...candidate, runnerOS: "macos", architecture: "arm64", procedureReceipt: entries[candidate.id]!.receipt,
      generatedAt: `${date}T00:00:00.000Z`, bounds: { totalMs: 100, legMs: 50, cleanupMs: 10, outputMs: 10 }, elapsedMs: 1,
      ownedStopConfirmed: true, processCleanup: "unproven", processCleanupReason: "NATIVE_UNTRUSTED_TEXT", containment: "disposable-runner-lifetime",
      autoAdmit: true, eligible: true, outcome: "pass", artifact: { method: "npm-exact", integrity }, integrity,
      installation: { status: "pass", cause: "ok", reason: "NATIVE_UNTRUSTED_TEXT", nextStep: "NATIVE_UNTRUSTED_TEXT" },
      legs: [{ id: "native-identity", requiredForAdmission: true, status: "pass", cause: "ok", reason: "NATIVE_UNTRUSTED_TEXT", nextStep: "NATIVE_UNTRUSTED_TEXT" }] };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
    writeFileSync(join(dir, "server.js"), "NATIVE_CODE_MUST_NOT_COPY"); writeFileSync(join(dir, "receipt.md"), "NATIVE_MARKDOWN_MUST_NOT_COPY");
  }
  const originals = Object.fromEntries([SOURCE, SERVER, PLUGIN, NOTICE].map(file => [file, { bytes: readFileSync(join(root, file)), mode: lstatSync(join(root, file)).mode }]));
  const calls: CompatBuildContext[] = [];
  const build = async (context: CompatBuildContext) => {
    calls.push(context);
    const patched = readFileSync(join(root, SOURCE), "utf8");
    const current = candidates.find(candidate => readCompatVerified(patched, candidate.id).includes(candidate.version));
    expect(current).toBeDefined();
    expect(candidates.filter(candidate => readCompatVerified(patched, candidate.id).includes(candidate.version))).toHaveLength(1);
    writeFileSync(join(root, SERVER), `// trusted fake build ${current!.id}\n`);
    writeFileSync(join(root, PLUGIN), '{"name":"agent-hub","version":"0.34.1"}\n'); writeFileSync(join(root, NOTICE), "generated notice\n");
    expect(context.env.AHUB_BUILD_PINNED_BUN).toBe("1"); expect(context.env.OPENAI_API_KEY).toBeUndefined(); expect(context.env.GITHUB_TOKEN).toBeUndefined();
  };
  const restored = () => { for (const [file, original] of Object.entries(originals)) {
    expect(readFileSync(join(root, file))).toEqual(original.bytes); expect(lstatSync(join(root, file)).mode).toBe(original.mode);
  } };
  const input = { root, out, watchFile, summariesDir, sourceBaseSha: head, date };
  return { root, out, watchFile, summariesDir, input, originals, calls, build, restored, report };
}

test("preparation binds each trusted per-ID bundle to its source and restores all checkout bytes", async () => {
  const f = fixture(["pi", "qwen"]), result = await prepareCompatArtifacts(f.input, { head: () => head, build: f.build });
  expect(f.calls).toHaveLength(2); expect(result.bundles).toHaveLength(2); f.restored();
  expect(result.watch.code).toBe(3); expect(result.watch.report).toBe(f.report);
  expect(JSON.parse(readFileSync(join(f.out, "index.json"), "utf8"))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("NATIVE_UNTRUSTED_TEXT");
  for (const bundle of result.bundles) {
    const dir = join(f.out, bundle.directory), bytes = readFileSync(join(dir, "descriptor.json"));
    expect(hash(bytes)).toBe(bundle.descriptorSha256); expect(bytes.length).toBe(bundle.descriptorSize);
    const descriptor = JSON.parse(bytes.toString()) as PreparedBundleDescriptor;
    expect(descriptor.sourceBaseSha).toBe(head); expect(descriptor.id).toBe(bundle.id); expect(descriptor.version).toBe(bundle.version);
    expect(descriptor.originalSourceSha256).toBe(hash(f.originals[SOURCE]!.bytes));
    expect(descriptor.receiptPath).toBe(`docs/verification/${date}-compat-${bundle.id}-${bundle.version}.md`);
    expect(Object.keys(descriptor.files).sort()).toEqual(["compat.ts", "plugin.json", "receipt.md", "server.js"]);
    for (const [name, bound] of Object.entries(descriptor.files)) { const file = readFileSync(join(dir, name)); expect(hash(file)).toBe(bound.sha256); expect(file.length).toBe(bound.size); }
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(`// trusted fake build ${bundle.id}\n`);
    expect(readFileSync(join(dir, "receipt.md"), "utf8")).not.toContain("NATIVE_MARKDOWN");
    expect(readCompatVerified(readFileSync(join(dir, "compat.ts"), "utf8"), bundle.id)).toEqual(["1.0.0", "1.1.0"]);
  }
});

test("a failed trusted build restores source, both plugin assets and the role notice, publishing no index", async () => {
  const f = fixture();
  await expect(prepareCompatArtifacts(f.input, { head: () => head, build: async context => { await f.build(context); throw Error("BUILD_PRIVATE_CANARY"); } })).rejects.toMatchObject({ cause: "build" });
  f.restored(); expect(existsSync(join(f.out, "index.json"))).toBe(false);
});

test("dry run still prepares read-only-job artifacts while retaining a dry publisher plan", async () => {
  const f = fixture(), result = await prepareCompatArtifacts({ ...f.input, dryRun: true }, { head: () => head, build: f.build });
  expect(result.dryRun).toBe(true); expect(result.plan.dryRun).toBe(true); expect(result.bundles).toHaveLength(1); expect(f.calls).toHaveLength(1); f.restored();
});

test("unknown drift without a version retains watcher code3/report and never builds or implies all verified", async () => {
  const f = fixture([]), report = ['Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).', "", '- **pi** (npm @fixture/pi): latest unknown, unknown; verified 1.0.0; repeat the receipt in docs/verification/2026-11-03-pi-fixture.md before adding the version.', "", `Checked ${date} by .github/workflows/agent-compat.yml.`].join("\n");
  writeFileSync(f.watchFile, JSON.stringify({ schemaVersion: 1, code: 3, report, ahead: [], matrix: { include: [] } }));
  const result = await prepareCompatArtifacts(f.input, { head: () => head, build: f.build });
  expect(result.watch).toEqual({ code: 3, report, candidates: [] }); expect(result.bundles).toEqual([]); expect(f.calls).toEqual([]); f.restored();
});

test("oversized generated bundle refuses before copying and restores the original sparse leaf", async () => {
  const f = fixture();
  await expect(prepareCompatArtifacts(f.input, { head: () => head, build: async context => { await f.build(context); truncateSync(join(f.root, SERVER), 64 * 1024 * 1024 + 1); } })).rejects.toThrow();
  f.restored(); expect(existsSync(join(f.out, "index.json"))).toBe(false);
});

test("head mismatch and symlinked native summaries are refused before build or output creation", async () => {
  const f = fixture();
  await expect(prepareCompatArtifacts(f.input, { head: () => "b".repeat(40), build: f.build })).rejects.toMatchObject({ cause: "input" });
  expect(f.calls).toEqual([]); expect(existsSync(f.out)).toBe(false);
  const file = join(f.summariesDir, "compat-receipt-pi-1.1.0", "summary.json"), moved = join(f.root, "summary-copy.json");
  writeFileSync(moved, readFileSync(file)); rmSync(file); symlinkSync(moved, file);
  await expect(prepareCompatArtifacts(f.input, { head: () => head, build: f.build })).rejects.toMatchObject({ cause: "input" });
  expect(f.calls).toEqual([]); expect(existsSync(f.out)).toBe(false); f.restored();
});

test("malformed native summary generates drift-only preparation without using native code or building", async () => {
  const f = fixture(); writeFileSync(join(f.summariesDir, "compat-receipt-pi-1.1.0", "summary.json"), '{"id":"pi","version":"1.1.0","eligible":true}');
  const result = await prepareCompatArtifacts(f.input, { head: () => head, build: f.build });
  expect(result.plan.actions[0]).toMatchObject({ kind: "update-drift", cause: "malformed-artifact" }); expect(result.bundles).toEqual([]); expect(f.calls).toEqual([]); f.restored();
});
