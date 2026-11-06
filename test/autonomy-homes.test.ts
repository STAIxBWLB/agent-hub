import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { autonomyHomeStatus, usedClaudeHomes } from "../src/cli/autonomy-homes.ts";
import { installClaudeProfileHook } from "../src/cli/claude-profile-hook.ts";
import type { ClaudeHomeProbe } from "../src/cli/claude-homes.ts";
import type { Registry } from "../src/hub/registry.ts";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const registry = { list: () => [] } as unknown as Registry;
const packageRoot = resolve(import.meta.dir, "..");
function fixture(defaultPresent = true) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-autonomy-homes-"))); roots.push(root);
  const home = join(root, "user"), selected = join(root, "selected"), fallback = join(home, ".claude");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(selected, { mode: 0o700 });
  if (defaultPresent) mkdirSync(fallback, { mode: 0o700 });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: selected };
  const calls: string[] = [];
  const probe: ClaudeHomeProbe = (_argv, options) => {
    calls.push(options.env.CLAUDE_CONFIG_DIR!);
    return { status: 0, stdout: "[]" };
  };
  return { root, home, selected, fallback, env, calls, probe };
}

test("doctor inspects a stale existing default hook without adding that home to setup's write selection", async () => {
  const f = fixture(), unused = join(f.home, "unused-profile"); mkdirSync(unused, { mode: 0o700 });
  expect(installClaudeProfileHook({ path: f.selected, exists: true, sources: ["environment"] }).state).toBe("installed");
  const fallbackFile = join(f.fallback, "settings.json"), selectedFile = join(f.selected, "settings.json");
  writeFileSync(fallbackFile, JSON.stringify({ statusLine: { type: "command", command: "keep-status" }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command",
    command: `${shellQuote(process.execPath)} ${shellQuote(join(f.root, "removed-package", "src/cli/claude-profile-hook.ts"))} --run`, timeout: 5 }] }] } }), { mode: 0o600 });
  const before = [readFileSync(fallbackFile, "utf8"), readFileSync(selectedFile, "utf8")];
  const listing = [readdirSync(f.fallback), readdirSync(f.selected), readdirSync(f.home)];
  expect((await usedClaudeHomes(registry, f.home, f.env)).homes.map(row => row.path)).toEqual([f.selected]);
  const status = await autonomyHomeStatus(registry, f.home, f.env, packageRoot, f.probe);
  expect(status.complete).toBe(true);
  expect(status.homes.map(row => row.home.path)).toEqual([f.selected, f.fallback]);
  expect(status.homes.find(row => row.home.path === f.selected)?.hook.state).toBe("installed");
  expect(status.homes.find(row => row.home.path === f.fallback)?.hook).toMatchObject({ state: "missing", reason: expect.stringContaining("missing") });
  expect(new Set(f.calls)).toEqual(new Set([f.selected, f.fallback]));
  expect([readFileSync(fallbackFile, "utf8"), readFileSync(selectedFile, "utf8")]).toEqual(before);
  expect([readdirSync(f.fallback), readdirSync(f.selected), readdirSync(f.home)]).toEqual(listing);
  expect((await usedClaudeHomes(registry, f.home, f.env)).homes.map(row => row.path)).toEqual([f.selected]);
});

test("doctor deduplicates a selected default-home alias without expanding setup's source selection", async () => {
  const f = fixture(), alias = join(f.root, "default-alias"); symlinkSync(f.fallback, alias);
  const env = { ...f.env, CLAUDE_CONFIG_DIR: alias };
  const status = await autonomyHomeStatus(registry, f.home, env, packageRoot, f.probe);
  expect(status.homes.map(row => row.home)).toEqual([{ path: f.fallback, exists: true, sources: ["environment", "default"] }]);
  expect(f.calls).toEqual([f.fallback, f.fallback]);
  expect((await usedClaudeHomes(registry, f.home, env)).homes).toEqual([{ path: f.fallback, exists: true, sources: ["environment"] }]);
});

test("doctor does not select or create an absent default while another home is selected", async () => {
  const f = fixture(false);
  const status = await autonomyHomeStatus(registry, f.home, f.env, packageRoot, f.probe);
  expect(status.complete).toBe(true);
  expect(status.homes.map(row => row.home.path)).toEqual([f.selected]);
  expect(existsSync(f.fallback)).toBe(false);
  expect(readdirSync(f.home)).toEqual([]);
});
