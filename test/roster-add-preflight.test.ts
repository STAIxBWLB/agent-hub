import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { rosterPreflight, rosterPreflightLines } from "../src/adapters/definitions/native-cli-jcode-home-init.ts";

// #1627 B: the preflight before `ahub roster add`. Fixture homes only.
const roots: string[] = [];
const savedPath = process.env.PATH;
beforeEach(() => { process.env.PATH = "/nonexistent"; }); // the CLI probe reads the process PATH: no real CLI is run
afterEach(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-preflight-"))); roots.push(root);
  const user = join(root, "user"), project = join(root, "project");
  mkdirSync(join(user, ".jcode"), { recursive: true }); mkdirSync(join(project, ".agenthub"), { recursive: true });
  writeFileSync(join(project, ".agenthub", "config.json"), "{}");
  return { user, project, env: { PATH: "/nonexistent", HOME: user } as NodeJS.ProcessEnv };
}

const config = (f: ReturnType<typeof fixture>) => ({ ...loadConfig(f.project), jcode_home: join(f.user, ".jcode"), jcode_cmd: ["/nonexistent/jcode"] }) as ReturnType<typeof loadConfig>; // never the real home

test("a jcode roster add preflight names the missing CLI with its fix and shows which home it would use", () => {
  const f = fixture();
  const findings = rosterPreflight("jcode", "jcode", f.project, config(f), f.env, f.user);
  const lines = rosterPreflightLines("jcode", findings);
  expect(lines.join("\n")).toContain("not found on PATH");
  expect(lines.join("\n")).toContain("is your own"); // the default home is the person's: init is the fix
  expect(lines.some(line => /fix|install/i.test(line))).toBe(true);
});

test("a peer without a native CLI gets a preflight that says so and never throws", () => {
  const f = fixture();
  const lines = rosterPreflightLines("pi", rosterPreflight("pi", "pi", f.project, config(f), f.env, f.user));
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]).toContain("pi");
});
