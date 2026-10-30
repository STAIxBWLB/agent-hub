import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, planInit } from "../src/cli/init.ts";
import { loadPacks, packOverrides } from "../src/hub/packs.ts";
import { SHIPPED_PACKS } from "../src/hub/shipped-packs.ts";
import { SHIPPED_ROLES } from "../src/hub/shipped-roles.ts";
import { loadRoleCatalog } from "../src/hub/roles.ts";
import { resolveProfile } from "../src/hub/profiles.ts";

const root = resolve(import.meta.dir, ".."), dirs: string[] = [];
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const cases = [
  { name: "writing-pack", profile: "writing", data: "../templates/packs/writing-pack.pack.json", script: "../templates/checks/writing.mjs", args: ["../templates/checks/fixtures/writing.json", "../templates/checks/fixtures/writing-rules.json"], ids: ["writing-metadata", "writing-terms", "writing-style"], domain: "writing" },
  { name: "analysis", profile: "research", data: "../templates/packs/analysis.pack.json", script: "../templates/checks/analysis.mjs", args: ["../templates/checks/fixtures/analysis.mjs", "../templates/checks/fixtures/analysis-input.json", "../templates/checks/fixtures/analysis-expected.json"], ids: ["analysis-reproduce"], domain: "analysis" },
  { name: "ops", profile: "general", data: "../templates/packs/ops.pack.json", script: "../templates/checks/ops.mjs", args: ["../templates/checks/fixtures/ops.json"], ids: ["ops-records"], domain: "ops" },
] as const;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "ahub-domain-pack-")); dirs.push(dir); return dir; }
function json(dir: string, name: string, value: unknown) { const file = join(dir, name); writeFileSync(file, JSON.stringify(value)); return file; }
function run(script: string, args: readonly string[]) {
  // Each example receives only fixture paths. No real peer, repository service or personal home is used.
  const home = temp();
  const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home }, stdout: "pipe", stderr: "pipe", timeout: 12_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

for (const item of cases) test(`${item.name} loads its roles/rubric, previews and applies data only, and its shipped check is deterministic`, () => {
  const catalog = loadRoleCatalog(), loaded = loadPacks();
  expect(catalog.errors).toEqual([]); expect(loaded.errors).toEqual([]);
  const pack = loaded.packs.get(item.name)!;
  expect(pack).toMatchObject({ name: item.name, profile: item.profile, layer: "shipped" });
  expect(readFileSync(path(item.data), "utf8")).toBe(SHIPPED_PACKS[item.name]);
  expect(pack.roles.length).toBeGreaterThan(0);
  for (const id of pack.roles) expect(catalog.roles.get(id)?.layer).toBe("shipped");
  expect(pack.checks).toHaveLength(1);
  for (const id of item.ids) expect(pack.rubric.some(criterion => criterion.id === id && criterion.required)).toBe(true);
  const overrides = packOverrides(pack);
  expect(Object.keys(overrides).sort()).toEqual(["example_checks", "review_checklist"]);
  expect(resolveProfile(pack.profile, overrides).review_checklist).toEqual(overrides.review_checklist as string[]);
  const dir = temp(); mkdirSync(join(dir, ".agenthub/roles"), { recursive: true });
  const preview = planInit(dir, item.name);
  expect(preview.some(change => change.reason.includes(`pack ${item.name}`))).toBe(true);
  expect(existsSync(join(dir, ".agenthub/config.json"))).toBe(false);
  init(dir, item.name);
  const config = JSON.parse(readFileSync(join(dir, ".agenthub/config.json"), "utf8"));
  expect(config.profile).toBe(item.profile); expect(config.profile_overrides).toEqual(overrides);
  expect(config.checks).toEqual(JSON.parse(readFileSync(path("../templates/config.json"), "utf8")).checks); expect(config.catalog_roles).toBeUndefined();
  expect(init(dir, item.name)).toEqual([]);
  expect(existsSync(join(dir, "templates/checks"))).toBe(false);
  const first = run(path(item.script), item.args.map(path)), second = run(path(item.script), item.args.map(path));
  expect(first).toEqual(second); expect(first.code).toBe(0); expect(first.err).toBe("");
  for (const id of item.ids) expect(first.out).toContain(`${id}: OK\n`);
  expect(first.out.endsWith(`${item.domain}: OK\n`)).toBe(true);
});

test("shipped role lint covers every template group and the whole bundled registry", () => {
  const result = run(path("../scripts/check-roles.ts"), []);
  expect(result.code).toBe(0); expect(result.out).toBe(`roles: OK (${Object.keys(SHIPPED_ROLES).length} bounded definitions)\n`);
});

test("writing check refuses missing metadata, absent terms, banned phrases and mechanical style violations without echoing text", () => {
  const dir = temp(), script = path(cases[0].script), rules = json(dir, "rules.json", { requiredTerms: ["approved term"], bannedPhrases: ["PRIVATE_WRITING_CANARY"] });
  for (const [document, criterion] of [
    [{ language: "en", text: "approved term" }, "writing-metadata"],
    [{ title: "Draft", language: "en", text: "missing terminology" }, "writing-terms"],
    [{ title: "Draft", language: "en", text: "approved term PRIVATE_WRITING_CANARY" }, "writing-terms"],
    [{ title: "Draft", language: "en", text: "approved term TODO" }, "writing-style"],
    [{ title: "Draft", language: "en", text: "approved term  \n" }, "writing-style"],
  ] as const) {
    const result = run(script, [json(dir, "draft.json", document), rules]);
    expect(result.code).toBe(1); expect(result.out).toContain(`${criterion}: FAIL\n`); expect(result.out).not.toContain("PRIVATE_WRITING_CANARY"); expect(result.err).toBe("");
  }
});

test("ops check refuses missing owners, impossible dates, unknown status and duplicate ids; empty is structure only", () => {
  const dir = temp(), script = path(cases[2].script), action = { id: "action-1", owner: "owner-role", due: "2030-01-02", status: "open" };
  for (const actions of [[{ ...action, owner: "" }], [{ ...action, due: "2030-02-30" }], [{ ...action, status: "invented" }], [action, action], [{ ...action, extra: "PRIVATE_ACTION_CANARY" }]]) {
    const result = run(script, [json(dir, "actions.json", actions)]);
    expect(result.code).toBe(1); expect(result.out).toBe("ops-records: FAIL\nops: FAIL\n"); expect(result.err).toBe("");
  }
  expect(run(script, [json(dir, "actions.json", [])])).toEqual({ code: 0, out: "ops-records: OK\nops: OK\n", err: "" });
});

test("analysis reruns an explicitly selected program twice against unchanged declared files and exact expected bytes", () => {
  const dir = temp(), program = join(dir, "program.mjs"), input = json(dir, "input.json", [2]), expected = join(dir, "expected.txt"), count = join(dir, "count.txt");
  writeFileSync(expected, "2\n");
  writeFileSync(program, `import {readFileSync,writeFileSync,existsSync} from 'node:fs'; const count=${JSON.stringify(count)};writeFileSync(count,String((existsSync(count)?Number(readFileSync(count,'utf8')):0)+1));process.stdout.write(String(JSON.parse(readFileSync(process.argv[2],'utf8'))[0])+'\\n');`);
  const before = [program, input, expected].map(file => readFileSync(file));
  expect(run(path(cases[1].script), [program, input, expected])).toEqual({ code: 0, out: "analysis-reproduce: OK\nanalysis: OK\n", err: "" });
  expect(readFileSync(count, "utf8")).toBe("2"); expect([program, input, expected].map(file => readFileSync(file))).toEqual(before);
  writeFileSync(expected, "2"); expect(run(path(cases[1].script), [program, input, expected]).code).toBe(1);
});

test("analysis refuses failed programs and changed declared files even when stdout matches; stderr stays private", () => {
  const dir = temp(), program = join(dir, "program.mjs"), input = json(dir, "input.json", [2]), expected = join(dir, "expected.txt"), count = join(dir, "count.txt"), script = path(cases[1].script);
  writeFileSync(expected, "2\n"); writeFileSync(program, "console.error('PRIVATE_PROGRAM_CANARY');process.exit(1);");
  expect(run(script, [program, input, expected])).toEqual({ code: 1, out: "analysis-reproduce: FAIL\nanalysis: FAIL\n", err: "" });
  writeFileSync(program, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';writeFileSync(process.argv[2],'[]');const count=${JSON.stringify(count)};writeFileSync(count,String((existsSync(count)?Number(readFileSync(count,'utf8')):0)+1));process.stdout.write('2\\n');`);
  expect(run(script, [program, input, expected]).code).toBe(1); expect(readFileSync(count, "utf8")).toBe("1");
});

test("example checks refuse malformed, linked, oversized and missing input files with stable diagnostics", () => {
  const dir = temp(), malformed = join(dir, "malformed.json"), large = join(dir, "large.json"), linked = join(dir, "linked.json");
  writeFileSync(malformed, Buffer.from([255])); writeFileSync(large, " ".repeat(1024 * 1024 + 1)); symlinkSync(path(cases[2].args[0]), linked);
  for (const file of [malformed, large, linked, join(dir, "missing.json")]) {
    const result = run(path(cases[2].script), [file]); expect(result).toEqual({ code: 1, out: "ops-records: FAIL\nops: FAIL\n", err: "" });
  }
  for (const item of cases) { const result = run(path(item.script), []); expect(result.code).toBe(2); expect(result.out).toBe(`${item.domain}: FAIL\n`); expect(result.err).toStartWith("usage: "); }
});
