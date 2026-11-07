import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPAT, type CompatId } from "../src/adapters/compat.ts";
import { harnessMatrix, latestVersion, runWatchCli, SOURCES, watch, type AheadCandidate } from "../scripts/agent-compat-watch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const manifest = JSON.parse(readFileSync(new URL("../scripts/compat-receipts/manifest.json", import.meta.url), "utf8"));
const publicIds = (Object.keys(COMPAT) as CompatId[]).filter(id => SOURCES[id].kind !== "none");
const aheadFetch = async (url: string) => ({ json: async () => url.includes("api.github.com") ? { tag_name: "v9.9.9" } : { version: "9.9.9" } });

test("watch emits exact structured candidates independently of report text", async () => {
  const verdict = await watch(aheadFetch);
  expect(verdict.ahead).toEqual(publicIds.map(id => ({ id, version: "9.9.9" })));
  expect(verdict.code).toBe(3); expect(verdict.verified).toEqual([]);
  const matrix = harnessMatrix(verdict.ahead, manifest);
  const supported = publicIds.filter(id => manifest.entries[id].runnerOS.some((os: string) => ["macos", "linux"].includes(os)));
  expect(matrix.include.map(row => row.id)).toEqual(supported);
  expect(matrix.include.every(row => row.runner === "macos-latest" && row.runnerOS === "macos")).toBe(true);
  expect(matrix.include.some(row => row.id === "qwen-dual")).toBe(false);
});

test("unknown or malformed publication versions never become matrix data", async () => {
  for (const version of ["9.9.9; echo no", "../branch", "9.9.9\nahead=false", "latest", "x".repeat(65)]) {
    expect(await latestVersion({ kind: "npm", pkg: "fixture" }, async () => ({ json: async () => ({ version }) }))).toBeUndefined();
  }
  const verdict = await watch(async () => { throw Error("offline"); });
  expect(verdict.code).toBe(3); expect(verdict.ahead).toEqual([]); expect(verdict.verified).toEqual([]);
  expect(verdict.report).toContain("latest unknown, unknown");
});

test("matrix refuses unknown ids, invalid versions, duplicates and more than eight rows", () => {
  for (const rows of [[{ id: "unknown", version: "9.9.9" }], [{ id: "pi", version: "../bad" }],
    [{ id: "pi", version: "9.9.9" }, { id: "pi", version: "9.9.8" }], Array.from({ length: 9 }, () => ({ id: "pi", version: "9.9.9" }))]) {
    expect(() => harnessMatrix(rows as AheadCandidate[], manifest)).toThrow();
  }
});

test("workflow mode writes JSON step outputs and its report without parsing report prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-compat-watch-")); roots.push(root);
  const report = join(root, "report.md"), output = join(root, "watch.json"), step = join(root, "github-output");
  expect(await runWatchCli(["--json", "--report", report, "--output", output, "--github-output", step], aheadFetch)).toBe(0);
  const result = JSON.parse(readFileSync(output, "utf8"));
  expect(result.schemaVersion).toBe(1); expect(result.code).toBe(3);
  const fields = Object.fromEntries(readFileSync(step, "utf8").trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  expect(fields.ahead).toBe("true"); expect(fields.has_runners).toBe("true");
  expect(JSON.parse(fields.ahead_json!)).toEqual(result.ahead);
  expect(JSON.parse(fields.matrix!)).toEqual(result.matrix);
  expect(readFileSync(report, "utf8")).toBe(`${result.report}\n`);
});


test("confirmed verified IDs are structured and disjoint from ahead and unknown IDs", async () => {
  let at = 0;
  const selected = publicIds[0]!;
  const result = await watch(async () => {
    const id = publicIds[at++]!;
    if (id === selected) throw Error("unreadable source");
    const source = SOURCES[id], value = COMPAT[id].verified[0];
    return { json: async () => source.kind === "github" ? { tag_name: `v${value}` } : { version: value } };
  });
  expect(result.verified).toEqual(publicIds.filter(id => id !== selected));
  expect(result.ahead).toEqual([]); expect(result.code).toBe(3);
});
