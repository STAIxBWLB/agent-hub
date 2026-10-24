import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey, type View } from "@staix/agent-mem";
import { CodeFacts } from "../src/hub/code-facts.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { memoryStaleAnchorsCommand } from "../src/cli/memory.ts";
import { formatMemoryStaleAnchors, memoryStaleAnchors, unavailableMemoryStaleAnchors, type MemoryStaleAnchorOptions } from "../src/hub/memory-stale-anchors.ts";
const HEAD = "a".repeat(40), cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "ahub-stale-followup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const absent = async () => ({ state: "known" as const, value: { exists: false, ambiguous: false } });
function options(names: string[]) {
  const rows: View[] = names.map((name, index) => ({ id: String(index + 1).padStart(32, "0"), at: "2026-10-24T00:00:00.000Z", machine: "fixture", project: "fixture", scope: "project", tier: "long", kind: "finding", peer: "person", title: null, text: "public note", task: null, about: [`symbol:${name}@src/a.ts`], source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false }));
  const result: MemoryStaleAnchorOptions = { cwd: "/fixture", project: "fixture", store: { readPage: () => ({ rows }), withDeferredPromotions: run => run() }, context: () => ({ cwd: "/fixture", project: "fixture", repo: "owner/repo", allowed: () => true }), publicMetadataText: () => true, head: () => HEAD, now: () => 0, exists: absent };
  return result;
}
test("#411 unsupported host qualification stays unknown before any negative lookup", async () => {
  const input = options(["Tasks#complete", "Tasks->complete", "Tasks:complete", "Tasks::complete"]); let calls = 0;
  input.exists = async () => { calls++; return absent(); };
  const report = await memoryStaleAnchors(input);
  expect(calls).toBe(0); expect(report).toMatchObject({ queried: 0, stale: 0, unknown: 4 });
  expect(report.rows.every(row => row.state === "unknown" && row.label === undefined)).toBe(true);
});
test("#411 indexed-definition absence is labelled without asserting an imported API is gone", async () => {
  const input = options(["ImportedStore", "A.run"]);
  const report = await memoryStaleAnchors(input);
  expect(report).toMatchObject({ stale: 2, queried: 2 }); // The injected port's qualified-name contract remains intact.
  expect(report.rows.every(row => row.reason === "absent" && row.label === "absent from indexed definitions")).toBe(true);
  expect(formatMemoryStaleAnchors(report)).toContain("absent from indexed definitions");
  expect(JSON.stringify(report)).not.toContain("API gone");
  input.finishQueries = async () => { input.publicMetadataText = () => false; };
  const withheld = await memoryStaleAnchors(input);
  expect(withheld.stale).toBe(0); expect(withheld.rows.every(row => row.label === undefined && row.anchor === undefined)).toBe(true);
  input.publicMetadataText = () => true; input.finishQueries = async () => { input.head = () => "b".repeat(40); };
  const moved = await memoryStaleAnchors(input);
  expect(moved.stale).toBe(0); expect(moved.rows.every(row => row.label === undefined)).toBe(true);
});
test("#411 repeated owned code-facts close failure returns neutral report; borrowed facts are never closed", async () => {
  const cwd = temp(), store = new MemoryStore({ home: temp() }); cleanup.push(() => store.close());
  const project = memoryProjectKey(cwd);
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "public imported type note", about: ["symbol:ImportedStore@src/a.ts"] });
  let closes = 0;
  const report = await memoryStaleAnchorsCommand(cwd, { store, head: () => HEAD, now: () => 0, createFacts: () => ({ exists: absent, close: async () => { closes++; throw Error("private cleanup detail"); } }) });
  expect(closes).toBe(2); expect(report).toEqual({ ...unavailableMemoryStaleAnchors(), scanned: 1, queried: 1 });
  const borrowed = { exists: absent, close: async () => { closes++; throw Error("borrowed"); } };
  expect(await memoryStaleAnchorsCommand(cwd, { store, head: () => HEAD, now: () => 0, facts: borrowed })).toMatchObject({ stale: 1 });
  expect(closes).toBe(2);
});
test("#411 real CodeFacts does not treat unindexed qualification as known negative evidence", async () => {
  const root = temp(), repo = join(root, "repo"), bin = join(root, "bin"); mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => { const r = hubGitSync(["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); expect(r.status).toBe(0); return r.stdout.trim(); };
  git("init", "-q"); writeFileSync(join(repo, "a.ts"), "export function retained() {}\n"); git("add", "."); git("commit", "-qm", "fixture"); const head = git("rev-parse", "HEAD");
  const fake = join(root, "fake.ts"), executable = join(bin, "ripwire"), quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(fake, `if(process.argv.includes("--version")){console.log("ripwire 0.6.7");process.exit(0);}const arg=process.argv.find(a=>a.startsWith("--callers="));const name=arg?.slice(10);console.log('<callers schema="ripwire.callers/v1" of="'+name+'" found="0"/>');process.exit(1);`);
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`); chmodSync(executable, 0o755);
  const facts = new CodeFacts({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  try {
    for (const name of ["Tasks#complete", "Tasks:complete", "Tasks->complete", "Tasks.complete", "Tasks::complete"]) expect(await facts.exists(repo, head, name)).toEqual({ state: "unknown" });
    expect(await facts.exists(repo, head, "ImportedStore")).toEqual({ state: "known", value: { exists: false, ambiguous: false } });
  } finally { await facts.close(); }
}, 20000);
