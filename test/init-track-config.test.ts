import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { ROLES_TRACKED, ROLES_UNTRACKED, ignoreRule, sharedConfigRow } from "../src/cli/init.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { ALL_MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { realPath } from "../src/hub/project.ts";

// #1411 T1: `ahub init --track-config | --no-track-config`, the block's role sentence, ignore entries through git check-ignore, and "config.local.json wins".
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const made = mkdtempSync(join(tmpdir(), "ahub-init-track-")); roots.push(made);
  const root = realPath(made), user = join(root, "user"), home = join(root, "hub"), scratch = join(root, "tmp"); mkdirSync(user); mkdirSync(scratch);
  const globalConfig = join(user, "gitconfig"); writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  // GIT_CONFIG_GLOBAL keeps the person's own global ignore file out of the verdicts.
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: globalConfig, TMPDIR: scratch });
  const cwd = join(root, "project"); mkdirSync(cwd);
  expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0);
  const run = (args: string[], workingDirectory = cwd) => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "init", ...args], { cwd: workingDirectory, env, stdin: "ignore" });
    expect(readdirSync(scratch).filter(name => name.startsWith("ahub-init-ignore-"))).toEqual([]);
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };
  const ignored = (path: string) => hubGitSync(["check-ignore", "-q", "--no-index", "--", path], { cwd, env, encoding: "utf8", timeout: 3000 }).status === 0;
  const text = (path: string) => existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : "";
  const git = (args: string[]) => hubGitSync(args, { cwd, env, encoding: "utf8", timeout: 3000 });
  return { root, env, globalConfig, scratch, cwd, run, ignored, text, git };
}
const SHARED = [".agenthub/config.json", ".agenthub/routing.toml", ".agenthub/sdlc.toml"];
const PRIVATE = [".agenthub/state/", ".agenthub/state/fixture.json", ".agenthub/config.local.json", ".agenthub/routing.local.toml"];
const REINCLUDE = ["!/.agenthub/", "/.agenthub/*", ...SHARED.map(path => `!/${path}`)];
function filesUnder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name); else files[name] = readFileSync(join(root, name)).toString("base64");
    }
  };
  walk(""); return files;
}
function outsideRule(p: ReturnType<typeof fixture>, kind: "global excludes" | "info/exclude") {
  const location = kind === "global excludes" ? join(p.root, "user", "excludes") : join(p.cwd, ".git/info/exclude");
  const contents = "# outside-rule-content-canary\n.agenthub/\n";
  writeFileSync(location, contents);
  if (kind === "global excludes") expect(p.git(["config", "--global", "core.excludesFile", location]).status).toBe(0);
  return { location, contents, global: readFileSync(p.globalConfig, "utf8") };
}

test("--track-config leaves the shared files visible to git and names them; --no-track-config ignores them; the role sentence follows (AC1)", () => {
  const tracked = fixture();
  const on = tracked.run(["--track-config"]);
  expect(on.code, on.out).toBe(0);
  for (const path of SHARED) expect(tracked.ignored(path)).toBe(false);
  expect(on.out).toContain("commit AGENTS.md and .agenthub/config.json, .agenthub/routing.toml");
  expect(on.out).toContain("it wins over config.json");
  expect(tracked.text("AGENTS.md")).toContain(ROLES_TRACKED);
  expect(tracked.text("AGENTS.md")).not.toContain(ROLES_UNTRACKED);

  const untracked = fixture();
  const off = untracked.run(["--no-track-config"]);
  expect(off.code, off.out).toBe(0);
  for (const path of SHARED) expect(untracked.ignored(path)).toBe(true);
  expect(off.out).toContain("stay untracked: each checkout and each machine holds its own roles");
  expect(untracked.text("AGENTS.md")).toContain(ROLES_UNTRACKED);
  expect(untracked.text("AGENTS.md")).not.toContain(ROLES_TRACKED);
});

test("init with neither flag on an existing project changes neither the ignore state nor the role sentence (AC2)", () => {
  for (const choice of ["--track-config", "--no-track-config"]) {
    const p = fixture();
    expect(p.run([choice]).code).toBe(0);
    const before = { ignore: p.text(".gitignore"), agents: p.text("AGENTS.md") };
    const again = p.run([]);
    expect(again.code, again.out).toBe(0);
    expect(p.text(".gitignore")).toBe(before.ignore);
    expect(p.text("AGENTS.md")).toBe(before.agents);
  }
});

test("--track-config appends a reinclude block after a project root directory rule without rewriting that rule (#1496)", () => {
  const p = fixture();
  writeFileSync(join(p.cwd, ".gitignore"), "node_modules/\n.agenthub/\n");
  const done = p.run(["--track-config", "--yes"]);
  expect(done.code, done.out).toBe(0);
  expect(p.text(".gitignore").startsWith("node_modules/\n.agenthub/\n")).toBe(true);
  expect(p.text(".gitignore")).toContain(REINCLUDE.join("\n"));
  for (const path of SHARED) expect(p.ignored(path), path).toBe(false);
  for (const path of PRIVATE) expect(p.ignored(path), path).toBe(true);
  expect(existsSync(join(p.cwd, "AGENTS.md"))).toBe(true);
  expect(p.text("AGENTS.md")).toContain(ROLES_TRACKED);
  expect(done.out).toContain("Next steps:");
});

for (const kind of ["global excludes", "info/exclude"] as const) {
  test(`--track-config overrides ${kind} in one project-local write, stays idempotent, and no-track removes its reincludes (#1496)`, () => {
    const p = fixture(), external = outsideRule(p, kind);
    expect(p.ignored(".agenthub/config.json")).toBe(true);
    const done = p.run(["--track-config", "--yes"]);
    expect(done.code, done.out).toBe(0);
    expect(p.text(".gitignore")).toContain(REINCLUDE.join("\n"));
    for (const path of SHARED) expect(p.ignored(path), path).toBe(false);
    for (const path of PRIVATE) expect(p.ignored(path), path).toBe(true);
    expect(done.out).toContain(".gitignore");
    expect(done.out).toMatch(/re-includ|reinclude/);
    expect(done.out.toLowerCase()).toContain(kind === "global excludes" ? "global" : "info/exclude");
    expect(done.out).not.toContain("outside-rule-content-canary");
    expect(readFileSync(external.location, "utf8")).toBe(external.contents);
    expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
    const before = filesUnder(p.cwd), again = p.run(["--track-config", "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(filesUnder(p.cwd)).toEqual(before);
    for (const line of REINCLUDE) expect(p.text(".gitignore").split("\n").filter(item => item === line)).toHaveLength(1);
    const off = p.run(["--no-track-config", "--yes"]);
    expect(off.code, off.out).toBe(0);
    for (const path of [...SHARED, ...PRIVATE]) expect(p.ignored(path), path).toBe(true);
    expect(p.text(".gitignore").split("\n").filter(line => line.startsWith("!/.agenthub"))).toEqual([]);
    expect(p.text("AGENTS.md")).toContain(ROLES_UNTRACKED);
    expect(readFileSync(external.location, "utf8")).toBe(external.contents);
    expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
  });

  test(`--dry-run previews the reinclude lines and reason for ${kind} without writing project or outside rules (#1496)`, () => {
    const p = fixture(), external = outsideRule(p, kind);
    writeFileSync(join(p.cwd, ".gitignore"), "# project-owned rule\nnode_modules/\n");
    const before = filesUnder(p.cwd), dry = p.run(["--track-config", "--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(".gitignore");
    expect(dry.out).toMatch(/re-includ|reinclude/);
    for (const line of REINCLUDE) expect(dry.out).toContain(line);
    expect(dry.out.toLowerCase()).toContain(kind === "global excludes" ? "global" : "info/exclude");
    expect(dry.out).not.toContain("outside-rule-content-canary");
    expect(filesUnder(p.cwd)).toEqual(before);
    expect(existsSync(join(p.cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(p.cwd, ".agenthub"))).toBe(false);
    expect(readFileSync(external.location, "utf8")).toBe(external.contents);
    expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
  });
}

test("a nested project ignore still winning after the root reinclude refuses before any writes (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".agenthub/.gitignore"), "config.json\n");
  writeFileSync(join(p.cwd, ".gitignore"), "# keep project rules\n");
  const before = filesUnder(p.cwd), refused = p.run(["--track-config", "--yes"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(".agenthub/.gitignore:1:config.json");
  expect(refused.out).toContain(".agenthub/config.json");
  expect(refused.out).toContain("nothing was written");
  expect(refused.out).toContain("ahub init");
  expect(refused.out).not.toContain("Next steps:");
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(existsSync(join(p.cwd, "AGENTS.md"))).toBe(false);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("an outside directory ignore never makes machine routing trackable while shared config is reincluded (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".agenthub/routing.toml"), '[hub_routes."hub/decision"]\ntype = "stage"\nefficient = "fast"\ncapable = "coding"\ndecision_backend = "adec"\nadec_endpoint = "http://127.0.0.1:8740/v1/route"\n');
  const routing = p.text(".agenthub/routing.toml"), done = p.run(["--track-config", "--yes"]);
  expect(done.code, done.out).toBe(0);
  expect(p.ignored(".agenthub/config.json")).toBe(false);
  expect(p.ignored(".agenthub/sdlc.toml")).toBe(false);
  expect(p.ignored(".agenthub/routing.toml")).toBe(true);
  expect(p.text(".gitignore")).not.toContain("!/.agenthub/routing.toml");
  for (const path of PRIVATE) expect(p.ignored(path), path).toBe(true);
  expect(done.out).toContain(".agenthub/routing.toml stays untracked");
  expect(p.text(".agenthub/routing.toml")).toBe(routing);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
});

test("a Git preview error removes the scratch directory and leaves every project and outside rule untouched (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes"), before = filesUnder(p.cwd);
  const bin = join(p.root, "bin"), trace = join(p.root, "preview-work-tree"); mkdirSync(bin);
  const realGit = Bun.which("git", { PATH: p.env.PATH });
  if (!realGit) throw new Error("fixture requires Git");
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  writeFileSync(join(bin, "git"), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --work-tree=*) printf '%s\\n' "$arg" > ${quote(trace)}; exit 128 ;;
  esac
done
exec ${quote(realGit)} "$@"
`, { mode: 0o700 });
  p.env.PATH = `${bin}:${p.env.PATH ?? ""}`;
  expect(p.git(["--version"]).status).toBe(0);
  const refused = p.run(["--track-config", "--yes"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("git could not evaluate the planned ignore rules");
  expect(refused.out).toContain("nothing was written");
  expect(existsSync(trace)).toBe(true);
  const argument = readFileSync(trace, "utf8").trim();
  expect(argument).toContain("ahub-init-ignore-");
  expect(existsSync(argument.slice("--work-tree=".length))).toBe(false);
  expect(readdirSync(p.scratch)).toEqual([]);
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("an unknown preliminary shared-config verdict cannot skip verification of a nested machine-file exposure (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  mkdirSync(join(p.cwd, ".agenthub"));
  // These user-owned rules already reinclude the other shared files. Only config.json's verdict is unknown.
  writeFileSync(join(p.cwd, ".gitignore"), "!/.agenthub/\n/.agenthub/*\n!/.agenthub/routing.toml\n!/.agenthub/sdlc.toml\n");
  writeFileSync(join(p.cwd, ".agenthub/.gitignore"), "!config.local.json\n");
  expect(p.ignored(".agenthub/config.json")).toBe(true);
  expect(p.ignored(".agenthub/config.local.json")).toBe(false);
  const before = filesUnder(p.cwd), bin = join(p.root, "bin"), trace = join(p.root, "preliminary-ignore-failure"); mkdirSync(bin);
  const realGit = Bun.which("git", { PATH: p.env.PATH });
  if (!realGit) throw new Error("fixture requires Git");
  writeFileSync(join(bin, "git"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let input = "inherit";
if (args.includes("check-ignore") && args.includes("--stdin") && !args.some(arg => arg.startsWith("--work-tree="))) {
  input = Buffer.from(await Bun.stdin.arrayBuffer());
  if (input.toString() === ".agenthub/config.json\\0") {
    appendFileSync(${JSON.stringify(trace)}, "preliminary config.json refused\\n");
    process.exit(128);
  }
}
const result = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: input, stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`, { mode: 0o700 });
  p.env.PATH = `${bin}:${p.env.PATH ?? ""}`;
  expect(p.git(["--version"]).status).toBe(0);
  const refused = p.run(["--track-config", "--yes"]);
  expect(refused.code).toBe(1);
  expect(existsSync(trace)).toBe(true);
  expect(refused.out).toContain("nothing was written");
  expect(refused.out).toContain("git status");
  expect(refused.out).toContain("ahub init");
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(readdirSync(p.scratch)).toEqual([]);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("a user rule appended after the owned reinclude block remains authoritative on refresh (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  const first = p.run(["--track-config", "--yes"]);
  expect(first.code, first.out).toBe(0);
  const ignore = `${p.text(".gitignore")}.agenthub/config.json\n`;
  writeFileSync(join(p.cwd, ".gitignore"), ignore);
  const ruleLine = ignore.trimEnd().split("\n").length, before = filesUnder(p.cwd);
  expect(p.ignored(".agenthub/config.json")).toBe(true);
  const refused = p.run(["--track-config", "--yes"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`.gitignore:${ruleLine}:.agenthub/config.json`);
  expect(refused.out).toContain("nothing was written");
  expect(refused.out).toContain("ahub init");
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(p.text(".gitignore")).toBe(ignore);
  expect(readdirSync(p.scratch)).toEqual([]);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("a nested negation exposing config.local.json refuses the real planned ignore preview (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".agenthub/.gitignore"), "!config.local.json\n");
  const before = filesUnder(p.cwd), refused = p.run(["--track-config", "--yes"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(".agenthub/config.local.json would be exposed");
  expect(refused.out).toContain("nothing was written");
  expect(refused.out).toContain("ahub init");
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(readdirSync(p.scratch)).toEqual([]);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("a configured subproject can track its already-visible shared files without moving init to the Git root (#1496)", () => {
  const p = fixture(), sub = join(p.cwd, "sub");
  mkdirSync(join(sub, ".agenthub"), { recursive: true });
  writeFileSync(join(sub, ".agenthub/config.json"), "{}\n");
  const done = p.run(["--track-config", "--yes"], sub);
  expect(done.code, done.out).toBe(0);
  expect(existsSync(join(sub, "AGENTS.md"))).toBe(true);
  expect(readFileSync(join(sub, "AGENTS.md"), "utf8")).toContain(ROLES_TRACKED);
  for (const path of SHARED) expect(p.ignored(`sub/${path}`), path).toBe(false);
  for (const path of PRIVATE) expect(p.ignored(`sub/${path}`), path).toBe(true);
  expect(existsSync(join(p.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(p.cwd, ".gitignore"))).toBe(false);
  expect(existsSync(join(p.cwd, ".agenthub"))).toBe(false);
});

test("a subproject needing an outside-directory reinclude keeps the manual refusal and writes nothing (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes"), sub = join(p.cwd, "sub");
  mkdirSync(join(sub, ".agenthub"), { recursive: true });
  writeFileSync(join(sub, ".agenthub/config.json"), "{}\n");
  const before = filesUnder(p.cwd), refused = p.run(["--track-config", "--yes"], sub);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`.agenthub/config.json is ignored by ${external.location}:2:.agenthub/`);
  expect(refused.out).toContain("!/.agenthub/");
  expect(refused.out).toContain("/.agenthub/*");
  expect(refused.out).toContain("!/.agenthub/config.json");
  expect(refused.out).toContain("ahub init");
  expect(refused.out).toContain("nothing was written");
  expect(filesUnder(p.cwd)).toEqual(before);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

test("CRLF owned ignore block refresh and removal preserve surrounding project bytes (#1496)", () => {
  const p = fixture(), external = outsideRule(p, "global excludes");
  expect(p.run(["--track-config", "--yes"]).code).toBe(0);
  const begin = "# agent-hub shared config (managed by ahub init)", end = "# end agent-hub shared config";
  const prefix = "# project prefix\r\nuser-cache/\r\n", suffix = "# project suffix\r\nuser-output/\r\n";
  const block = `${begin}\r\n${REINCLUDE.join("\r\n")}\r\n${end}\r\n`, before = prefix + block + suffix;
  writeFileSync(join(p.cwd, ".gitignore"), before);
  const refreshed = p.run(["--track-config", "--yes"]);
  expect(refreshed.code, refreshed.out).toBe(0);
  expect(p.text(".gitignore")).toBe(before);
  for (const path of SHARED) expect(p.ignored(path), path).toBe(false);
  const off = p.run(["--no-track-config", "--yes"]);
  expect(off.code, off.out).toBe(0);
  const after = p.text(".gitignore");
  expect(after.startsWith(prefix + suffix)).toBe(true);
  expect(after).not.toContain(begin); expect(after).not.toContain(end);
  expect(after.split(/\r?\n/).filter(line => line.startsWith("!/.agenthub"))).toEqual([]);
  for (const path of [...SHARED, ...PRIVATE]) expect(p.ignored(path), path).toBe(true);
  expect(readFileSync(external.location, "utf8")).toBe(external.contents);
  expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
});

for (const missing of ["begin", "end"] as const) test(`an unmatched owned ignore ${missing === "begin" ? "end" : "begin"} marker refuses both track choices without appending a second block (#1496)`, () => {
  for (const flag of ["--track-config", "--no-track-config"]) {
    const p = fixture(), external = outsideRule(p, "global excludes");
    const marker = missing === "begin" ? "# end agent-hub shared config" : "# agent-hub shared config (managed by ahub init)";
    writeFileSync(join(p.cwd, ".gitignore"), `# project prefix\n${marker}\n!/.agenthub/config.json\n# project suffix\n`);
    const before = filesUnder(p.cwd), refused = p.run([flag, "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/block|marker/);
    expect(refused.out).toContain("nothing was written");
    expect(refused.out).toContain("ahub init");
    expect(filesUnder(p.cwd)).toEqual(before);
    expect(p.text(".gitignore").split("\n").filter(line => line === marker)).toHaveLength(1);
    expect(readFileSync(external.location, "utf8")).toBe(external.contents);
    expect(readFileSync(p.globalConfig, "utf8")).toBe(external.global);
  }
});

test("a ! rule that re-includes a file is not an ignore rule; a directory rule is", () => {
  const p = fixture();
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".gitignore"), "/.agenthub/*\n!/.agenthub/config.json\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // this process's own global ignore file stays out of the verdict
  try {
    expect(ignoreRule(p.cwd, ".agenthub/config.json")).toBeNull();
    expect(ignoreRule(p.cwd, ".agenthub/routing.toml")).toBe(".gitignore:1:/.agenthub/*");
    const plain = mkdtempSync(join(tmpdir(), "ahub-init-norepo-")); roots.push(plain);
    expect(ignoreRule(realPath(plain), ".agenthub/config.json")).toBeUndefined();
  } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
});

test("init adds no .gitignore line for a path git already ignores (AC6)", () => {
  const p = fixture();
  writeFileSync(join(p.cwd, ".gitignore"), ".agenthub/\n");
  const done = p.run([]);
  expect(done.code, done.out).toBe(0);
  expect(p.text(".gitignore")).toBe(".agenthub/\n");
  // with neither flag the block follows what git says, and the next steps say the same as the block
  expect(p.text("AGENTS.md")).toContain(ROLES_UNTRACKED);
  expect(done.out).toContain("stay untracked: each checkout and each machine holds its own roles");
  expect(done.out).not.toContain("commit AGENTS.md, .agenthub/config.json");
  const fresh = fixture();
  expect(fresh.run([]).code).toBe(0);
  expect(fresh.text(".gitignore")).toBe(".agenthub/state/\n.agenthub/config.local.json\n.agenthub/routing.local.toml\n");
});

test("--track-config keeps a routing.toml that names a machine endpoint out of git and reports personal values in config.json", () => {
  const p = fixture();
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".agenthub/routing.toml"), '[hub_routes."hub/decision"]\ntype = "stage"\nefficient = "fast"\ncapable = "coding"\ndecision_backend = "adec"\nadec_endpoint = "http://127.0.0.1:8740/v1/route"\n');
  writeFileSync(join(p.cwd, ".agenthub/config.json"), JSON.stringify({ kimi_cmd: ["/opt/kimi/bin/kimi", "acp"] }, null, 2) + "\n");
  const done = p.run(["--track-config"]);
  expect(done.code, done.out).toBe(0);
  expect(p.ignored(".agenthub/routing.toml")).toBe(true);
  expect(p.ignored(".agenthub/config.json")).toBe(false);
  expect(done.out).toContain('.agenthub/routing.toml stays untracked: hub_routes."hub/decision".adec_endpoint');
  expect(done.out).not.toContain("commit AGENTS.md and .agenthub/config.json, .agenthub/routing.toml");
  expect(done.out).toContain("move kimi_cmd from .agenthub/config.json to .agenthub/config.local.json");
});

test("config.local.json wins over config.json key by key, for a key of every top-level block and per peer in roles (#1411 owner comment)", () => {
  const p = fixture();
  const exceptions = new Set<string>(["release", "action_policy", "rooms", "research.runners", ...ALL_MACHINE_LOCAL]);
  const shared: Record<string, Record<string, unknown>> = {}, local: Record<string, Record<string, unknown>> = {};
  const expected: [string, string, unknown][] = [];
  for (const [block, value] of Object.entries(DEFAULT_CONFIG as unknown as Record<string, unknown>)) {
    if (exceptions.has(block) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const leaf = Object.entries(value as Record<string, unknown>).find(([key, item]) => !exceptions.has(`${block}.${key}`) && (typeof item === "boolean" || typeof item === "number" && Number.isInteger(item) && item > 2));
    if (!leaf) continue;
    const [key, item] = leaf;
    const [mine, theirs] = typeof item === "boolean" ? [!item, item] : [(item as number) - 1, (item as number) - 2];
    (shared[block] ??= {})[key] = theirs; (local[block] ??= {})[key] = mine;
    expected.push([block, key, mine]);
  }
  expect(expected.length).toBeGreaterThan(5);
  const config = loadConfig(p.cwd, [
    { name: "config.json", raw: { ...shared, roles: { claude: ["planner"], codex: ["implementer"] } } },
    { name: "config.local.json", raw: { ...local, roles: { claude: ["reviewer"] } } },
  ] as never) as unknown as Record<string, Record<string, unknown>>;
  for (const [block, key, mine] of expected) expect({ [`${block}.${key}`]: config[block]![key] }).toEqual({ [`${block}.${key}`]: mine });
  expect(config.roles!.claude).toEqual(["reviewer"]);
  expect(config.roles!.codex).toEqual(["implementer"]);
});

test("--no-track-config on a project that already committed its config names the command that stops tracking it", () => {
  const p = fixture();
  expect(p.run(["--track-config"]).code).toBe(0);
  expect(p.git(["add", "AGENTS.md", ".gitignore", ".agenthub/config.json", ".agenthub/routing.toml"]).status).toBe(0);
  expect(p.git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init"]).status).toBe(0);
  const off = p.run(["--no-track-config"]);
  expect(off.code, off.out).toBe(0);
  expect(off.out).toContain(".agenthub/config.json, .agenthub/routing.toml are still committed: run git rm --cached .agenthub/config.json .agenthub/routing.toml and commit");
  expect(p.text("AGENTS.md")).toContain(ROLES_UNTRACKED);
});

test("doctor's shared config row: quiet for both deliberate states, a warning with the fixing command for each mismatch (#1411 T2, AC5)", () => {
  const global = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  try {
    const commit = (f: ReturnType<typeof fixture>) => expect(f.git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c"]).status).toBe(0);
    // tracked by choice, then committed: quiet; before the commit it says to commit
    const tracked = fixture(); expect(tracked.run(["--track-config"]).code).toBe(0);
    expect(sharedConfigRow(tracked.cwd)).toMatchObject({ ok: undefined, detail: expect.stringContaining(`git add .agenthub/config.json`) });
    expect(tracked.git(["add", "AGENTS.md", ".agenthub/config.json"]).status).toBe(0); commit(tracked);
    expect(sharedConfigRow(tracked.cwd)).toEqual({ ok: true, detail: expect.stringContaining("tracked:") });
    // then a rule ignores it: git keeps the copy, doctor names the rule
    writeFileSync(join(tracked.cwd, ".gitignore"), "/.agenthub/\n");
    expect(sharedConfigRow(tracked.cwd)).toMatchObject({ ok: undefined, detail: expect.stringContaining(".gitignore:1:/.agenthub/") });
    // untracked by choice: quiet; committed anyway: a warning naming both ways out
    const untracked = fixture(); expect(untracked.run(["--no-track-config"]).code).toBe(0);
    expect(sharedConfigRow(untracked.cwd)).toEqual({ ok: true, detail: expect.stringContaining("untracked (by choice)") });
    expect(untracked.git(["add", "-f", ".agenthub/config.json"]).status).toBe(0); commit(untracked);
    const both = sharedConfigRow(untracked.cwd)!;
    expect(both.ok).toBeUndefined(); expect(both.detail).toContain("ahub init --track-config --yes"); expect(both.detail).toContain("git rm --cached .agenthub/config.json");
    // the block points at a config a rule ignores and git never had: keep it per checkout or remove the rule
    const mismatch = fixture(); expect(mismatch.run(["--track-config"]).code).toBe(0);
    writeFileSync(join(mismatch.cwd, ".gitignore"), "/.agenthub/\n");
    const row = sharedConfigRow(mismatch.cwd)!;
    expect(row.ok).toBeUndefined(); expect(row.detail).toContain(".gitignore:1:/.agenthub/"); expect(row.detail).toContain("ahub init --no-track-config --yes");
    // no managed sentence, or no config: nothing to compare
    writeFileSync(join(mismatch.cwd, "AGENTS.md"), "# notes\n"); expect(sharedConfigRow(mismatch.cwd)).toBeNull();
  } finally { if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = global; }
});
