import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecs } from "../src/cli/specs.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";
import { configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { configTier } from "../src/hub/config-tier.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { checkSettingValue, settingDef } from "../src/hub/settings.ts";
import { parseSpecsConfig } from "../src/hub/specs-config.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-specs-cli-"))); roots.push(root);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
    return result.stdout.trim();
  };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  mkdirSync(join(root, ".agenthub")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, specs: {} }));
  writeFileSync(join(root, "src/core.ts"), "export const value = 1;\n");
  git("add", "."); git("commit", "-qm", "fixture baseline");
  return { root, git };
}
function invoke(root: string, args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = runSpecs(args, root, parseSpecsConfig(undefined), { out: line => stdout.push(line), error: line => stderr.push(line) });
  return { code, stdout, stderr };
}

test("specs check is silent without specs and JSON is explicit", () => {
  const { root } = fixture();
  expect(invoke(root, ["check"])).toEqual({ code: 0, stdout: [], stderr: [] });
  const result = invoke(root, ["check", "--json"]);
  expect(result.code).toBe(0); expect(result.stderr).toEqual([]);
  expect(JSON.parse(result.stdout.join("\n")).specCount).toBe(0);
});

test("specs CLI freshness exit policy and base notices retain read-only behavior", () => {
  const { root, git } = fixture(), stamp = git("rev-parse", "HEAD");
  writeFileSync(join(root, "design.md"), `---\nid: core\ntype: goal\ntitle: Core\nstatus: active\npaths: [src/core.ts]\nverified-against: ${stamp}\n---\nDesign.\n`);
  git("add", "."); git("commit", "-qm", "fixture spec");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/core.ts"), "export const value = 2;\n");
  git("add", "."); git("commit", "-qm", "fixture source change");
  const before = readFileSync(join(root, "design.md"));
  expect(invoke(root, ["check"]).code).toBe(0);
  expect(invoke(root, ["check", "--require-fresh"]).code).toBe(1);
  const report = invoke(root, ["check", "--base", base, "--json"]);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.stdout.join("\n")).stale).toBe(1);
  expect(invoke(root, ["covers", "src/core.ts"]).stdout.join("\n")).toContain("core (design.md)");
  expect(invoke(root, ["list"]).stdout.join("\n")).toContain("Core");
  expect(readFileSync(join(root, "design.md"))).toEqual(before);
  expect(git("diff", "--name-only", "--no-ext-diff", "--no-textconv")).toBe("");
});

test("specs CLI rejects malformed flags with a cause and next step", () => {
  const { root } = fixture();
  const missing = invoke(root, ["check", "--base"]);
  expect(missing.code).toBe(1); expect(missing.stderr.join("\n")).toContain("name a commit or branch");
  for (const args of [["stamp", "core"], ["check", "--unknown"], ["covers"], ["list", "file.md"]]) {
    const result = invoke(root, args); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain("usage:");
  }
});

test("warning-only spec checks succeed while malformed specs fail", () => {
  const { root } = fixture();
  writeFileSync(join(root, "design.md"), "---\nid: product\ntype: goal\ntitle: Product\nstatus: active\n---\nDesign.\n");
  const warning = invoke(root, ["check"]);
  expect(warning.code).toBe(0); expect(warning.stdout.join("\n")).toContain("active-without-paths");
  writeFileSync(join(root, "design.md"), "---\nid: product\ntype: unknown\ntitle: Product\n---\nDesign.\n");
  const invalid = invoke(root, ["check"]);
  expect(invalid.code).toBe(1); expect(invalid.stdout.join("\n")).toContain("unknown-type");
});

test("specs reads are open to peers while unshipped writes remain person-only", () => {
  for (const args of [["list"], ["list", "--json"], ["check", "--base", "main", "--require-fresh", "--json"], ["covers", "src/core.ts"]]) {
    expect(classifyPeerCommand("specs", args)).toBe("allowed");
  }
  for (const args of [["stamp", "core"], ["check", "--yes"], ["covers", "--as-user"]]) expect(classifyPeerCommand("specs", args)).toBe("console");
  expect(cliCommandLabel("specs", ["covers", "private/path"])).toBe("specs covers");
});

test("specs loader defaults, layer overrides, tier 2 settings and schema agree", () => {
  const { root } = fixture();
  expect(loadConfig(root).specs).toEqual({ enabled: true, review: "report", roots: [], stamps_file: "" });
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ specs: { enabled: false, review: "off" } }));
  expect(loadConfig(root).specs.enabled).toBe(false); expect(loadConfig(root).specs.review).toBe("off");
  for (const key of ["enabled", "review", "roots", "stamps_file"]) {
    expect(configTier("config.local.json", ["specs", key])).toEqual({ tier: 2 });
    expect(configApply(`specs.${key}`).applies).toBe("live");
  }
  for (const key of ["enabled", "review"]) {
    const def = settingDef(`specs.${key}`); expect(typeof def).toBe("object");
    if (typeof def === "string") throw new Error(def);
    expect(def.group).toBe("Switches"); expect(def.store).toBe("config");
    expect(() => checkSettingValue(def, key === "enabled" ? false : "require")).not.toThrow();
    expect(() => checkSettingValue(def, "invalid")).toThrow();
  }
  expect(() => validateRawConfig({ specs: { roots: ["../escape"] } })).toThrow();
});

test("actual agent-shell specs check succeeds offline without daemon output", () => {
  const { root } = fixture();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_") && !key.startsWith("AGENTHUB_") && !["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)));
  const home = join(root, "home"); mkdirSync(home);
  Object.assign(env, { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), AGENTHUB_PEER_ID: "codex" });
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "specs", "check"], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(""); expect(result.stderr.toString()).toBe("");
});
