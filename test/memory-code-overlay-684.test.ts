import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@staix/agent-mem";
import { CodeFacts, type CodeSymbol } from "../src/hub/code-facts.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { deriveMemoryCodeOverlay, MEMORY_CODE_EDGES, MEMORY_CODE_NEIGHBOURS, MEMORY_CODE_SEEDS, type CodeNeighbourhood, type MemoryCodeOverlayOptions } from "../src/hub/memory-code-overlay.ts";
const HEAD = "a".repeat(40), cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "ahub-code-overlay-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const symbol = (name: string, path = "src/n.ts", ambiguous = false): CodeSymbol => ({ name, path, kind: "fn", line: 1, ambiguous, change: "unknown" });
const neighbourhood = (callers: CodeSymbol[] = [], callees: CodeSymbol[] = []): CodeNeighbourhood => ({ callers, callees, hiddenAmbiguous: 0, countsFloor: true });
function setup() {
  const calls: string[] = [];
  let head: string | undefined = HEAD, valid = true, privateTask = false, allowed = (_: string) => true, cwd = "/fixture";
  const options: MemoryCodeOverlayOptions = { context: () => ({ cwd, project: "fixture", repo: "owner/repo" }), head: () => head, valid: () => valid, private: () => privateTask, publicMetadataText: value => allowed(value), now: () => 0,
    neighbours: async (repo, at, selector, depth) => { expect(repo).toBe("/fixture"); expect(at).toBe(HEAD); expect(depth).toBe(1); calls.push(selector); return { state: "known", value: neighbourhood([symbol("caller")], [symbol("callee")]) }; };
  return { options, calls, head(value: string | undefined) { head = value; }, valid(value: boolean) { valid = value; }, private(value: boolean) { privateTask = value; }, allowed(value: typeof allowed) { allowed = value; }, cwd(value: string) { cwd = value; } };
}
test("#367 path-qualified one-hop derived calls keep canonical identity, direction and SHA", async () => {
  const f = setup();
  const out = await deriveMemoryCodeOverlay(["symbol:target(input)@src/./a.ts", "symbol:target@src/b.ts"], f.options);
  expect(f.calls).toEqual(["src/a.ts:target", "src/b.ts:target"]);
  expect(out).toMatchObject({ state: "known", head: HEAD, queried: 2, countsFloor: true });
  expect(out.edges).toContainEqual({ from: "symbol:caller@src/n.ts", to: "symbol:target@src/a.ts", rel: "calls", derived: true, head: HEAD });
  expect(out.edges).toContainEqual({ from: "symbol:target@src/a.ts", to: "symbol:callee@src/n.ts", rel: "calls", derived: true, head: HEAD });
  expect(out.nodes.every(node => node.type === "symbol" && node.derived && node.head === HEAD)).toBe(true);
  expect(out.edges.some(edge => edge.from === "symbol:caller@src/n.ts" && edge.to === "symbol:callee@src/n.ts")).toBe(false);
});
test("#367 private, noncanonical and denied seeds make no code queries", async () => {
  const f = setup(); f.private(true);
  expect((await deriveMemoryCodeOverlay(["symbol:target@src/a.ts"], f.options)).nodes).toEqual([]); expect(f.calls).toEqual([]);
  f.private(false); f.allowed(value => !value.includes("private"));
  f.options.context = () => ({ cwd: "/fixture", project: "fixture", repo: "owner/repo", deny: ["denied/**"] });
  const out = await deriveMemoryCodeOverlay(["symbol:bare", "symbol:target@../a.ts", "symbol:target@denied/a.ts", "symbol:target@private/a.ts"], f.options);
  expect(out.state).toBe("unknown"); expect(f.calls).toEqual([]); expect(out.nodes).toEqual([]);
});
test("#367 name-only neighbours are hidden and seed or query unavailability is explicit unknown", async () => {
  const f = setup(); f.options.neighbours = async () => ({ state: "known", value: { ...neighbourhood([symbol("guessed", "secret.ts", true)], [symbol("retained")]), hiddenAmbiguous: 1 } });
  const out = await deriveMemoryCodeOverlay(["symbol:target@src/a.ts"], f.options);
  expect(out.state).toBe("unknown"); expect(JSON.stringify(out)).not.toContain("guessed"); expect(JSON.stringify(out)).not.toContain("secret.ts");
  f.options.neighbours = async () => ({ state: "unknown" });
  expect(await deriveMemoryCodeOverlay(["symbol:target@src/a.ts"], f.options)).toMatchObject({ state: "unknown", nodes: [], edges: [], unknown: 1 });
});
test("#367 head, binding and PII drift across awaited code facts withhold all derived metadata", async () => {
  for (const drift of ["head", "binding", "private", "cwd"] as const) {
    const f = setup(); f.options.neighbours = async () => { if (drift === "head") f.head("b".repeat(40)); if (drift === "binding") f.valid(false); if (drift === "private") f.private(true); if (drift === "cwd") f.cwd("/other"); return { state: "known", value: neighbourhood([symbol("privatePayload")]) }; };
    const out = await deriveMemoryCodeOverlay(["symbol:target@src/a.ts"], f.options);
    expect(out).toMatchObject({ state: "unknown", nodes: [], edges: [], notes: [] }); expect(out.head).toBeUndefined();
  }
});
test("#367 later awaited facts and note lookup cannot expose newly denied earlier anchors", async () => {
  const f = setup(); let calls = 0;
  f.options.neighbours = async () => { if (++calls === 2) f.allowed(value => !value.includes("earlier")); return { state: "known", value: neighbourhood([symbol("earlier")]) }; };
  let out = await deriveMemoryCodeOverlay(["symbol:target@a.ts", "symbol:other@b.ts"], f.options);
  expect(JSON.stringify(out)).not.toContain("earlier"); expect(out.state).toBe("unknown");
  const g = setup(); g.options.related = () => { g.allowed(value => !value.includes("caller")); return []; };
  out = await deriveMemoryCodeOverlay(["symbol:target@a.ts"], g.options);
  expect(JSON.stringify(out)).not.toContain("caller");
});
test("#367 seed, neighbour, edge and query-start bounds are shared across the overlay", async () => {
  const f = setup();
  f.options.neighbours = async () => ({ state: "known", value: neighbourhood(Array.from({ length: 40 }, (_, i) => symbol(`N${i}`)), Array.from({ length: 40 }, (_, i) => symbol(`N${i}`))) });
  const out = await deriveMemoryCodeOverlay(Array.from({ length: 6 }, (_, i) => `symbol:S${i}@a.ts`), f.options);
  expect(out.queried).toBe(MEMORY_CODE_SEEDS); expect(out.nodes.length).toBeLessThanOrEqual(MEMORY_CODE_SEEDS + MEMORY_CODE_NEIGHBOURS); expect(out.edges).toHaveLength(MEMORY_CODE_EDGES); expect(out.truncated).toBe(true);
  let clock = 0; f.options.now = () => clock;
  f.options.neighbours = async () => { clock = 2001; return { state: "known", value: neighbourhood() }; };
  expect(await deriveMemoryCodeOverlay(["symbol:S0@a.ts", "symbol:S1@a.ts"], f.options)).toMatchObject({ queried: 1, truncated: true, state: "unknown" });
});
test("#367 neighbour-attached notes are fails-first, bounded and read-only", async () => {
  const f = setup(), home = temp(), store = new MemoryStore({ home }); cleanup.push(() => store.close());
  const caller = "symbol:caller@src/n.ts";
  store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "finding", source: "person", peer: "person", text: "finding", about: [caller] });
  const fail = store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", source: "person", peer: "person", text: "failure", about: [caller] });
  const logs = () => ["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).sort().map(file => readFileSync(join(store.dir, dir, file), "utf8")));
  const before = logs();
  f.options.related = (nodes, limit) => store.related("fixture", [...nodes], limit).map(row => ({ id: `mem:${row.id}`, line: row.text, kind: row.kind, about: row.about }));
  const out = await deriveMemoryCodeOverlay(["symbol:target@a.ts"], f.options);
  expect(out.notes[0]?.id).toBe(`mem:${fail}`); expect(out.notes).toHaveLength(2); expect(logs()).toEqual(before);
  f.options.related = () => Array.from({ length: 20 }, (_, index) => ({ id: `mem:${String(index + 1).padStart(32, "0")}`, line: "public note", kind: index === 19 ? "fail" : "finding", about: [caller] }));
  const capped = await deriveMemoryCodeOverlay(["symbol:target@a.ts"], f.options);
  expect(capped.notes).toHaveLength(16); expect(capped.notes[0]?.kind).toBe("fail"); expect(capped.truncated).toBe(true); expect(logs()).toEqual(before);
});
test("#367 CodeFacts refuses ambiguous or name-only seeds, including empty relation lists", async () => {
  const root = temp(), repo = join(root, "repo"), bin = join(root, "bin"); mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => { const r = hubGitSync(["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); expect(r.status).toBe(0); return r.stdout.trim(); };
  git("init", "-q"); writeFileSync(join(repo, "a.ts"), "export function target() {}\n"); git("add", "."); git("commit", "-qm", "fixture"); const head = git("rev-parse", "HEAD");
  const fake = join(root, "fake.ts"), executable = join(bin, "ripwire"), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(fake, `if(process.argv.includes("--version")){console.log("ripwire 0.6.7");process.exit(0);}const arg=process.argv.find(a=>a.startsWith("--callers=")||a.startsWith("--callees="));const at=arg.indexOf("="),kind=arg.slice(2,at),name=arg.slice(at+1);console.log(JSON.stringify({of:name,defs:name.includes("duplicate")?2:1,...(name.includes("nameOnly")?{via:"name"}:{}),count:0,root:process.cwd(),hop_tested:0,hop_untested:0,graph_ambiguous:0,graph_unresolved:0,counts_floor:true,[kind]:[]}));`);
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`); chmodSync(executable, 0o755);
  const facts = new CodeFacts({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  try {
    expect(await facts.neighbours(repo, head, "a.ts:target")).toMatchObject({ state: "known", value: { callers: [], callees: [] } });
    expect(await facts.neighbours(repo, head, "a.ts:duplicate")).toEqual({ state: "unknown" });
    expect(await facts.neighbours(repo, head, "a.ts:nameOnly")).toEqual({ state: "unknown" });
  } finally { await facts.close(); }
}, 20000);
