import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInitChecks, withInitChecks, workflowCheckNames } from "../src/cli/init-required-checks.ts";
import { init } from "../src/cli/init.ts";
import { parseInitSettings } from "../src/cli/init-settings.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { loadSdlc, readReviewReadiness, reviewReadinessFromEvidence, parsePrEvidence, requiredCheckNames } from "../src/hub/sdlc.ts";
import { pollCi } from "../src/hub/ci-watch.ts";
import { requiredChecksFor } from "../src/hub/sdlc-merge.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const names = ["check (ubuntu-latest)", "check (macos-latest)", "ci-ok"];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-check-discovery-")); roots.push(cwd);
  mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
  writeFileSync(join(cwd, ".github/workflows/check.yml"), 'on: push\njobs:\n  linux:\n    name: check (ubuntu-latest)\n    runs-on: ubuntu-latest\n  mac:\n    name: check (macos-latest)\n    runs-on: macos-latest\n  ci-ok:\n    runs-on: ubuntu-latest\n');
  return cwd;
}
test("bounded fake gh reads latest completed default-branch jobs, then init writes exactly those names (#1328)", async () => {
  const cwd = fixture();
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  expect(hubGitSync(["config", "remote.origin.url", "https://github.com/example/project.git"], { cwd }).status).toBe(0);
  const calls: string[][] = [];
  const result = await discoverInitChecks(cwd, async (args, timeout, root, cap) => {
    calls.push(args); expect(timeout).toBeLessThanOrEqual(5000); expect(root).toBe(cwd); expect(cap).toBe(512 * 1024);
    return { code: 0, stdout: JSON.stringify(calls.length === 1 ? { default_branch: "main" } : calls.length === 2 ? { workflow_runs: [{ id: 7, status: "completed", head_branch: "main" }] } : { total_count: names.length, jobs: names.map(name => ({ name })) }) };
  });
  expect(calls).toHaveLength(3); expect(calls[1]).toContain("per_page=1"); expect(calls[2]).toContain("per_page=100");
  expect(result).toEqual({ source: "CI", names });
  const request = await withInitChecks(cwd, parseInitSettings(["--sdlc", "enforce"]).request, async () => result);
  init(cwd, undefined, false, false, request);
  expect(loadSdlc(cwd).requiredChecks).toEqual(names);
});
test("fallback reads literal workflows, rejects dynamic names and linked workflows (#1328)", async () => {
  const cwd = fixture();
  expect((await discoverInitChecks(cwd)).names).toEqual(names);
  expect(workflowCheckNames('jobs:\n  build:\n    name: check (${{ matrix.os }})\n    strategy:\n      matrix:\n        os: [linux, mac]\n')).toBeUndefined();
  expect(workflowCheckNames('jobs:\n  build:\n    uses: example/repo/.github/workflows/ci.yml@main\n')).toBeUndefined();
  const other = join(cwd, "other.yml"); writeFileSync(other, 'jobs:\n  secret:\n    runs-on: linux\n');
  symlinkSync(other, join(cwd, ".github/workflows/linked.yml"));
  expect((await discoverInitChecks(cwd)).names).toEqual([]);
});
test("enforce with no names refuses before writes; explicit override skips discovery (#1328)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-empty-checks-")); roots.push(cwd);
  const before = readdirSync(cwd);
  await expect(withInitChecks(cwd, parseInitSettings(["--sdlc", "enforce"]).request)).rejects.toThrow("nothing was written");
  expect(() => init(cwd, undefined, false, false, parseInitSettings(["--sdlc", "enforce"]).request)).toThrow("required CI checks");
  expect(readdirSync(cwd)).toEqual(before);
  const request = parseInitSettings(["--sdlc", "enforce", "--required-checks", "custom gate"]).request;
  expect(await withInitChecks(cwd, request, async () => { throw new Error("must not discover"); })).toBe(request);
});
test("non-native readiness and watcher never request the native floor without configuration (#1328)", async () => {
  const head = "a".repeat(40); let reads = 0;
  const run = async () => { reads++; return { code: 1, stdout: "" }; };
  const receipt = { stage: "build", repo: "other/project", pr: 1 };
  expect((await readReviewReadiness(receipt, head, run)).blockers).toEqual(["required checks unknown: set required_checks in .agenthub/sdlc.toml"]);
  expect(await pollCi({ repo: receipt.repo, pr: 1 }, head, [], run)).toBe("incomplete");
  const evidence = parsePrEvidence({ headRefOid: head, state: "OPEN", files: [], changedFiles: 0, statusCheckRollup: [], reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } });
  evidence.unresolved = 0;
  expect(reviewReadinessFromEvidence(evidence, head, [], receipt.repo)?.blockers[0]).toContain("required checks unknown");
  expect(reads).toBe(0);
  expect(requiredCheckNames("STAIxBWLB/agent-hub", [])).toContain("seeded guards");
  expect(requiredChecksFor(sdlcConfig({ mode: "enforce", repos: { "other/project": { required_checks: ["custom"] } } }), "other/project")).toEqual(["custom"]);
});

test("local origin/HEAD saves one gh read; truncated and failed inventories fall back as a whole (#1328)", async () => {
  const cwd = fixture();
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  expect(hubGitSync(["config", "remote.origin.url", "https://github.com/example/project.git"], { cwd }).status).toBe(0);
  expect(hubGitSync(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd }).status).toBe(0);
  expect(hubGitSync(["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd }).status).toBe(0);
  expect(hubGitSync(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd }).status).toBe(0);
  for (const fail of [false, true]) {
    const calls: string[][] = [];
    const found = await discoverInitChecks(cwd, async args => {
      calls.push(args);
      if (calls.length === 1) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 9, status: "completed", head_branch: "main" }] }) };
      if (fail) return { code: 1, stdout: "" };
      return { code: 0, stdout: JSON.stringify({ total_count: 101, jobs: [{ name: "partial" }] }) };
    });
    expect(calls).toHaveLength(2); expect(found).toEqual({ source: "workflows", names });
  }
});

test("quoted literal workflow names strip comments without changing their value (#1328)", () => {
  expect(workflowCheckNames("jobs:\n  build:\n    name: 'Build job' # comment\n")).toEqual(["Build job"]);
  expect(workflowCheckNames('jobs:\n  build:\n    name: "Build job" # comment\n')).toEqual(["Build job"]);
  expect(workflowCheckNames("jobs:\n  build:\n    name: 'Builder''s job' # comment\n")).toEqual(["Builder's job"]);
  expect(workflowCheckNames("jobs:\n  build:\n    name: 'Build job' trailing\n")).toBeUndefined();
});

test("dangling local origin/HEAD is unknown and fetches the default branch (#1328)", async () => {
  const cwd = fixture();
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  expect(hubGitSync(["config", "remote.origin.url", "https://github.com/example/project.git"], { cwd }).status).toBe(0);
  expect(hubGitSync(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/absent"], { cwd }).status).toBe(0);
  const calls: string[][] = [];
  const found = await discoverInitChecks(cwd, async args => { calls.push(args); return { code: 1, stdout: "" }; });
  expect(calls).toEqual([["api", "repos/example/project"]]); expect(found.names).toEqual(names);
});

test("existing matching per-repo checks permit enforce with no discovery; a foreign table grants nothing (#1328)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-repo-checks-")); roots.push(cwd);
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  expect(hubGitSync(["config", "remote.origin.url", "https://github.com/example/project.git"], { cwd }).status).toBe(0);
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/sdlc.toml"), 'mode = "advise"\n[repos."example/project"]\nrequired_checks = ["project gate"]\n');
  const request = parseInitSettings(["--sdlc", "enforce"]).request;
  expect(await withInitChecks(cwd, request, async () => { throw new Error("no discovery"); })).toBe(request);
  init(cwd, undefined, false, false, request);
  expect(loadSdlc(cwd).mode).toBe("enforce"); expect(loadSdlc(cwd).requiredChecks).toEqual([]);
  writeFileSync(join(cwd, ".agenthub/sdlc.toml"), 'mode = "advise"\n[repos."foreign/project"]\nrequired_checks = ["foreign gate"]\n');
  await expect(withInitChecks(cwd, request, async () => ({ source: "unknown", names: [], reason: "no CI" }))).rejects.toThrow("nothing was written");
  expect(() => init(cwd, undefined, false, false, request)).toThrow("required CI checks");
  expect(loadSdlc(cwd).mode).toBe("advise");
});

test("CI and literal workflow jobs apply the 32-check schema to distinct names (#1328)", async () => {
  const cwd = fixture();
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  expect(hubGitSync(["config", "remote.origin.url", "https://github.com/example/project.git"], { cwd }).status).toBe(0);
  const jobs = Array.from({ length: 33 }, () => ({ name: "unit" }));
  let reads = 0;
  const result = await discoverInitChecks(cwd, async () => ({ code: 0, stdout: JSON.stringify(++reads === 1 ? { default_branch: "main" } : reads === 2 ? { workflow_runs: [{ id: 7, status: "completed", head_branch: "main" }] } : { total_count: jobs.length, jobs }) }));
  expect(result).toEqual({ source: "CI", names: ["unit"] }); expect(reads).toBe(3);
  const workflow = (distinct: boolean) => `jobs:\n${Array.from({ length: 33 }, (_, i) => `  job${i}:\n    name: ${distinct ? `unit${i}` : "unit"}\n    runs-on: linux\n`).join("")}`;
  expect(workflowCheckNames(workflow(false))).toEqual(["unit"]);
  expect(workflowCheckNames(workflow(true))).toBeUndefined();
});
