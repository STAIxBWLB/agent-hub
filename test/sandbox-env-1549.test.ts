import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { sandboxCommandEnvironment } from "../src/local/shell-environment.ts";

test("cache defaults stay under owned temp and explicit values, including empty ones, win", () => {
  expect(sandboxCommandEnvironment({ HOME: "/fixture" }, "/owned")).toEqual({ HOME: "/fixture", TMPDIR: "/owned/", BUN_INSTALL_CACHE_DIR: "/owned/bun-cache", NPM_CONFIG_CACHE: "/owned/npm-cache" });
  expect(sandboxCommandEnvironment({ BUN_INSTALL_CACHE_DIR: "", NPM_CONFIG_CACHE: "/custom", TMPDIR: "/untrusted" }, "/owned")).toEqual({ BUN_INSTALL_CACHE_DIR: "", NPM_CONFIG_CACHE: "/custom", TMPDIR: "/owned/" });
});

const fixture = () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-sandbox-cache-"))), home = join(cwd, "home");
  mkdirSync(home); writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture-cache", version: "1.0.0" }));
  return { cwd, home };
};

test.skipIf(!sandboxAvailable())("sandboxed package managers use writable per-command caches and leave the fake home untouched", async () => {
  const { cwd, home } = fixture();
  try {
    const npm = Bun.which("npm"), node = Bun.which("node");
    expect(npm).toBeDefined(); expect(node).toBeDefined();
    const tools = [dirname(realPath(node!)), dirname(dirname(dirname(realPath(npm!))))];
    const script = join(cwd, "fixture.ts");
    writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
for (const key of ["BUN_INSTALL_CACHE_DIR", "NPM_CONFIG_CACHE"]) { const dir=process.env[key]; if(!dir) throw Error("missing cache"); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,"proof"),"ok"); }
const install=Bun.spawnSync([process.execPath,"install","--offline"],{stdout:"pipe",stderr:"pipe"});
const npm=Bun.spawnSync(["npm","install","--offline","--no-audit","--no-fund"],{stdout:"pipe",stderr:"pipe"});
console.log(JSON.stringify({tmp:process.env.TMPDIR,bun:process.env.BUN_INSTALL_CACHE_DIR,npm:process.env.NPM_CONFIG_CACHE,install:install.exitCode,stderr:install.stderr.toString(),npmInstall:npm.exitCode,npmError:npm.stderr.toString()}));`);
    const result = await sandboxedExec([process.execPath, script], { cwd, profile: profile(cwd, false, tools), env: { HOME: home }, timeoutMs: 10_000 });
    expect(result.code, result.output).toBe(0);
    const row = JSON.parse(result.output.trim()) as { tmp: string; bun: string; npm: string; install: number | null; stderr: string; npmInstall: number | null; npmError: string };
    expect(row.install, row.stderr).toBe(0);
    expect(row.npmInstall, row.npmError).toBe(0);
    expect(row.bun.startsWith(row.tmp)).toBe(true); expect(row.npm.startsWith(row.tmp)).toBe(true);
    expect(existsSync(row.tmp)).toBe(false);
    expect(existsSync(join(home, ".bun"))).toBe(false); expect(existsSync(join(home, ".npm"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!sandboxAvailable())("sandbox cache defaults never override caller-provided values", async () => {
  const { cwd, home } = fixture();
  try {
    const bun = join(cwd, "chosen-bun"), npm = join(cwd, "chosen-npm");
    const result = await sandboxedExec(["/usr/bin/env"], { cwd, profile: profile(cwd, false), env: { HOME: home, BUN_INSTALL_CACHE_DIR: bun, NPM_CONFIG_CACHE: npm } });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`BUN_INSTALL_CACHE_DIR=${bun}\n`); expect(result.output).toContain(`NPM_CONFIG_CACHE=${npm}\n`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test.skipIf(!sandboxAvailable())("a caller-provided cache does not bypass a denied path", async () => {
  const { cwd, home } = fixture(), blocked = join(cwd, "private-cache");
  try {
    mkdirSync(blocked);
    const result = await sandboxedExec(["/bin/sh", "-c", 'echo x > "$BUN_INSTALL_CACHE_DIR/escape"'], {
      cwd, profile: profile(cwd, false, [], ["private-cache"]), env: { HOME: home, BUN_INSTALL_CACHE_DIR: blocked },
    });
    expect(result.code).not.toBe(0);
    expect(existsSync(join(blocked, "escape"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
