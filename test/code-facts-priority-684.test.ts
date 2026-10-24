import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodeFacts, OPTIONAL_CODE_UNKNOWN_TTL_MS } from "../src/hub/code-facts.ts";
import { hubGitSync } from "../src/hub/git.ts";
function fixture(mode?: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-facts-priority-")), repo = join(root, "repo"), bin = join(root, "bin"), entered = join(root, "entered"), release = join(root, "release"), record = join(root, "record"), inventory = join(root, "inventory");
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => { const result = hubGitSync(["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); expect(result.status).toBe(0); return result.stdout.trim(); };
  git("init", "-qb", "main"); writeFileSync(join(repo, "a.ts"), "export function retained() {}\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.ts"), "export function retained() {}\nexport function added() {}\n"); git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
  const wrapper = join(root, "wrapper.ts"), executable = join(bin, "ripwire"), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);const trees=spawnSync('git',['worktree','list','--porcelain'],{encoding:'utf8'});appendFileSync(${JSON.stringify(inventory)},JSON.stringify({args,count:(trees.stdout.match(/^worktree /gm)||[]).length})+'\\n');if(args.some(arg=>arg.includes('blocked'))&&!existsSync(${JSON.stringify(release)})){writeFileSync(${JSON.stringify(entered)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);}await import(${JSON.stringify(join(import.meta.dir, "fakes/fake-ripwire.ts"))});`);
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} "$@"\n`); chmodSync(executable, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RIPWIRE_RECORD: record, ...(mode ? { FAKE_RIPWIRE_MODE: mode } : {}) };
  let clock = 0;
  const facts = new CodeFacts({ env, now: () => clock, timeoutMs: 4000 });
  const calls = (): Array<{ cwd: string; args: string[] }> => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const wait = async () => { for (let i = 0; i < 400 && !existsSync(entered); i++) await Bun.sleep(5); expect(existsSync(entered)).toBe(true); return JSON.parse(readFileSync(entered, "utf8")) as { pid: number; cwd: string }; };
  const close = async () => { await facts.close(); rmSync(root, { recursive: true, force: true }); };
  return { facts, repo, base, head, git, env, calls, wait, inventory: () => readFileSync(inventory, "utf8").trim().split("\n").map(line => JSON.parse(line) as { count: number }), release: () => writeFileSync(release, "release"), clock(value: number) { clock = value; }, close };
}
function gone(pid: number) { const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 }); const stat = result.stdout.trim(); expect(stat === "" || stat.startsWith("Z")).toBe(true); }
test("#367 review priority cancels optional CLI, awaits cleanup and obtains real changed-symbol evidence", async () => {
  const f = fixture();
  try {
    const optional = f.facts.neighbours(f.repo, f.head, "a.ts:blocked", 1, { priority: "optional" });
    const child = await f.wait();
    const priority = f.facts.changedSymbols(f.repo, f.base, f.head);
    expect(await f.facts.neighbours(f.repo, f.head, "a.ts:probe", 1, { priority: "optional" })).toEqual({ state: "unknown" });
    expect(await optional).toEqual({ state: "unknown" });
    expect(await priority).toMatchObject({ state: "known", value: [{ name: "retained" }, { name: "added" }] });
    gone(child.pid); expect(existsSync(child.cwd)).toBe(false); expect(f.inventory().every(event => event.count <= 2)).toBe(true); expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(f.calls().some(call => call.args.includes("--pr-context=" + f.base))).toBe(true);
    expect(f.calls().some(call => call.args.some(arg => arg.includes("probe") || arg.includes("--callees=a.ts:blocked")))).toBe(false);
  } finally { await f.close(); }
}, 20000);
test("#367 same-key priority query does not inherit a cancelled optional unknown promise", async () => {
  const f = fixture();
  try {
    const optional = f.facts.neighbours(f.repo, f.head, "a.ts:blocked", 1, { priority: "optional" }); await f.wait();
    const priority = f.facts.neighbours(f.repo, f.head, "a.ts:blocked");
    expect(await optional).toEqual({ state: "unknown" }); f.release();
    expect(await priority).toMatchObject({ state: "known", value: { callers: [{ name: "caller" }], callees: [{ name: "callee" }] } });
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);
test("#367 optional queries skip priority work even with cached advice; default contention stays unchanged", async () => {
  const f = fixture();
  try {
    expect(await f.facts.neighbours(f.repo, f.head, "retained", 1, { priority: "optional" })).toMatchObject({ state: "known" });
    const priority = f.facts.exists(f.repo, f.head, "blocked"); await f.wait(); const before = f.calls();
    expect(await f.facts.neighbours(f.repo, f.head, "retained", 1, { priority: "optional" })).toEqual({ state: "unknown" });
    expect(await f.facts.neighbours(f.repo, f.head, "not-started", 1, { priority: "optional" })).toEqual({ state: "unknown" });
    expect(await f.facts.exists(f.repo, f.head, "another-default")).toEqual({ state: "unknown" }); expect(f.calls()).toEqual(before);
    f.release(); expect(await priority).toEqual({ state: "known", value: { exists: true, ambiguous: false } });
  } finally { await f.close(); }
}, 20000);
test("#367 optional unknown TTL avoids rebuilds, expires, and is scoped by head and selector", async () => {
  const f = fixture("json-schema");
  try {
    const query = (head = f.head, name = "a.ts:retained") => f.facts.neighbours(f.repo, head, name, 1, { priority: "optional" });
    expect(await query()).toEqual({ state: "unknown" }); const count = f.calls().length; expect(count).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) expect(await query()).toEqual({ state: "unknown" }); expect(f.calls()).toHaveLength(count);
    f.clock(OPTIONAL_CODE_UNKNOWN_TTL_MS - 1); expect(await query()).toEqual({ state: "unknown" }); expect(f.calls()).toHaveLength(count);
    expect(await query(f.head, "a.ts:added")).toEqual({ state: "unknown" }); expect(f.calls().length).toBeGreaterThan(count);
    const other = f.calls().length; expect(await query(f.base)).toEqual({ state: "unknown" }); expect(f.calls().length).toBeGreaterThan(other);
    const previous = f.calls().length; f.clock(OPTIONAL_CODE_UNKNOWN_TTL_MS); expect(await query()).toEqual({ state: "unknown" }); expect(f.calls().length).toBeGreaterThan(previous);
  } finally { await f.close(); }
}, 20000);
test("#367 optional negative cache never poisons default queries or bypasses private/closed preflight", async () => {
  const f = fixture("json-schema");
  try {
    expect(await f.facts.neighbours(f.repo, f.head, "retained", 1, { priority: "optional" })).toEqual({ state: "unknown" });
    delete f.env.FAKE_RIPWIRE_MODE;
    expect(await f.facts.neighbours(f.repo, f.head, "retained")).toMatchObject({ state: "known" }); const before = f.calls();
    expect(await f.facts.neighbours(f.repo, f.head, "retained", 1, { priority: "optional", private: true })).toEqual({ state: "unknown" }); expect(f.calls()).toEqual(before);
    await f.facts.close(); expect(await f.facts.neighbours(f.repo, f.head, "retained", 1, { priority: "optional" })).toEqual({ state: "unknown" }); expect(f.calls()).toEqual(before);
  } finally { await f.close(); }
}, 20000);
test("#367 closing during optional preemption starts no queued priority tree", async () => {
  const f = fixture();
  try {
    const optional = f.facts.neighbours(f.repo, f.head, "a.ts:blocked", 1, { priority: "optional" }); const child = await f.wait();
    const priority = f.facts.changedSymbols(f.repo, f.base, f.head); await f.facts.close();
    expect(await optional).toEqual({ state: "unknown" }); expect(await priority).toEqual({ state: "unknown" }); gone(child.pid);
    expect(f.calls().some(call => call.args.some(arg => arg.startsWith("--pr-context=")))).toBe(false); expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);
