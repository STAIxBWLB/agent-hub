import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { initNextSteps } from "../src/cli/init.ts";
import { HELP } from "../src/cli/help.ts";
import { parseInitSettings } from "../src/cli/init-settings.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const NOTICE = "- GSD planning state found: see docs/sdlc.md#moving-from-gsd before migrating; archive .planning/ and retain its evidence.";
function fixture(name: string, state?: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-gsd-migration-")); roots.push(root);
  const cwd = join(root, name), user = join(root, "user"); mkdirSync(cwd); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key.startsWith("ORCA_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key === "CI") delete env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: join(root, "hub"), CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0);
  const planning = join(cwd, ".planning");
  if (state !== undefined) {
    mkdirSync(join(planning, "phases"), { recursive: true });
    writeFileSync(join(planning, "STATE.md"), state);
    writeFileSync(join(planning, "phases", "PLAN.md"), "Historical D-01 and GATE-01 evidence.\n");
  }
  const snapshot = () => Object.fromEntries(readdirSync(planning, { recursive: true }).map(String).sort().map(name => {
    const file = join(planning, name), st = statSync(file);
    return [name, st.isFile() ? { text: readFileSync(file, "utf8"), modified: st.mtimeMs } : "directory"];
  }));
  const run = (mode: string, extra: string[] = []) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "init", "--sdlc", mode, "--autonomy", "off", "--agents", "none", "--yes", ...(mode === "enforce" ? ["--required-checks", "unit"] : []), ...extra], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return { stdout: result.stdout.toString().replaceAll(cwd, "<project>"), stderr: result.stderr.toString().replaceAll(cwd, "<project>") };
  };
  return { cwd, planning, snapshot, run };
}

for (const mode of ["advise", "enforce"]) test(`#1431 ${mode} init prints one GSD notice and preserves every planning artifact`, () => {
  const ordinary = fixture("ordinary"), gsd = fixture("gsd", "---\ngsd_state_version: 1.0\nstatus: executing\n---\n# State\nD-01 and GATE-01 stay archived.\n" + "evidence\n".repeat(1000));
  const before = gsd.snapshot(), baseline = ordinary.run(mode), result = gsd.run(mode);
  expect(result.stdout.split(NOTICE)).toHaveLength(2);
  expect(result.stdout.replace(NOTICE + "\n", "")).toBe(baseline.stdout);
  expect(result.stderr).toBe(baseline.stderr);
  expect(gsd.snapshot()).toEqual(before);
  const preview = gsd.run(mode, ["--dry-run", "--json"]);
  expect(preview.stdout).not.toContain(NOTICE); expect(() => JSON.parse(preview.stdout)).not.toThrow();
  expect(gsd.snapshot()).toEqual(before);
});

test("#1431 absent and non-GSD state preserve init output byte for byte", () => {
  const ordinary = fixture("ordinary"), other = fixture("other", "---\nstatus: executing\n---\ngsd_state_version: 1.0\n");
  const before = other.snapshot();
  expect(other.run("advise")).toEqual(ordinary.run("advise"));
  expect(other.snapshot()).toEqual(before);
});

test("#1431 off, implicit enablement, malformed and symlinked state produce no notice", () => {
  const f = fixture("modes", "---\ngsd_state_version: '1.0'\n---\n");
  expect(f.run("off").stdout).not.toContain(NOTICE);
  expect(initNextSteps(f.cwd)).not.toContain(NOTICE);
  const request = parseInitSettings(["--sdlc", "advise"]).request;
  for (const text of ["gsd_state_version: 1.0\n", "---\ngsd_state_version: 1.0\n" + "x".repeat(5000) + "\n---\n", "---\ngsd_state_version:\n---\n"]) {
    writeFileSync(join(f.planning, "STATE.md"), text);
    expect(initNextSteps(f.cwd, request)).not.toContain(NOTICE);
  }
  rmSync(join(f.planning, "STATE.md"));
  writeFileSync(join(f.cwd, "outside-state.md"), "---\ngsd_state_version: 1.0\n---\n");
  symlinkSync(join(f.cwd, "outside-state.md"), join(f.planning, "STATE.md"));
  expect(initNextSteps(f.cwd, request)).not.toContain(NOTICE);
});

test("#1431 GSD migration documentation maps artifacts and keeps person command forms aligned with help", () => {
  const document = readFileSync(join(import.meta.dir, "../docs/sdlc.md"), "utf8");
  const section = document.split("## Moving from GSD\n")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  for (const term of ["Milestone", "Phase and plan", "Requirements and acceptance", ".planning/STATE.md", "D-xx", "GATE-xx", "criteria", "AGENTS.md", "README", "Archive `.planning/`; do not delete it.", "release.version", "release.notesPath", "release.docs", "docs/verified.json", "committed", "person-owned terminal"]) expect(section).toContain(term);
  const settings = HELP.find(row => row.usage.startsWith("ahub settings edit "))!.usage;
  expect(section).toContain(settings);
  for (const [prefix, suffix] of [["ahub release new ", " | list"], ["ahub goal new ", " | link"]] as const) {
    const form = HELP.find(row => row.usage.startsWith(prefix!))!.usage.split(suffix)[0]!;
    expect(section).toContain(form);
  }
  const initHelp = HELP.find(row => row.usage.startsWith("ahub init "))!.usage;
  expect(initHelp).toContain("[--sdlc off|advise|enforce]");
  expect(section).toContain("ahub init --sdlc advise");
  expect(section!.indexOf("ahub init --sdlc advise")).toBeLessThan(section!.indexOf("ahub goal new"));
  expect(section!.indexOf("ahub goal new")).toBeLessThan(section!.indexOf("ahub release new"));
});
