import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeFacts } from "../src/hub/code-facts.ts";
import { planGuardNodes } from "../src/hub/memory-plan-guard.ts";
import { expect, test } from "bun:test";
import { canonicalMemorySymbolNode, normalizeMemorySymbolInput, MEMORY_SYMBOL_LIMIT, resolveMemorySymbolNodes } from "../src/hub/memory-symbols.ts";
const context = { cwd: "/fixture", project: "fixture", repo: "owner/repo", deny: ["denied/**"], allowed: (value: string) => !value.includes("private") };
const present = async () => ({ state: "known" as const, value: { exists: true, ambiguous: false } });

test("#684 canonical memory symbols use the existing name normalizer and safe explicit path identity", () => {
  expect(normalizeMemorySymbolInput("A.run(input: string)@src/a.ts")).toBe("A.run@src/a.ts");
  expect(canonicalMemorySymbolNode("symbol:A.run(input: string)@src/./a.ts", context)).toBe("symbol:A.run@src/a.ts");
  for (const node of ["symbol:run", "symbol:run@../a.ts", "symbol:run@/tmp/a.ts", "symbol:run@denied/a.ts", "symbol:run@private/a.ts", "symbol:section intro@a.ts", "symbol:A.run(private)@a.ts"]) {
    expect(canonicalMemorySymbolNode(node, context)).toBeUndefined();
  }
});

test("#684 memory symbol storage requires positive unambiguous exists evidence, with privacy before queries", async () => {
  const calls: string[] = [];
  const result = await resolveMemorySymbolNodes(["symbol:A.run(x)@a.ts", "symbol:A.run@a.ts", "symbol:B.run@b.ts", "symbol:C.run@c.ts", "symbol:D.run@d.ts", "symbol:private@e.ts"], context, async name => {
    calls.push(name);
    if (name === "A.run") return present();
    if (name === "B.run") return { state: "known", value: { exists: true, ambiguous: true } };
    if (name === "C.run") return { state: "known", value: { exists: false, ambiguous: false } };
    return { state: "unknown" };
  });
  expect(calls).toEqual(["A.run", "B.run", "C.run", "D.run"]);
  expect(result).toEqual({ state: "unknown", nodes: ["symbol:A.run@a.ts"], unknown: 4, truncated: false });
});

test("#684 symbol checks have an explicit count and scheduling bound and fail open", async () => {
  let count = 0;
  const nodes = Array.from({ length: MEMORY_SYMBOL_LIMIT + 2 }, (_, index) => `symbol:S${index}@a.ts`);
  const capped = await resolveMemorySymbolNodes(nodes, context, async () => { count++; return present(); });
  expect(count).toBe(MEMORY_SYMBOL_LIMIT); expect(capped.nodes).toHaveLength(MEMORY_SYMBOL_LIMIT); expect(capped.truncated).toBe(true);
  count = 0; let clock = 0;
  const timed = await resolveMemorySymbolNodes(nodes, context, async () => { count++; return present(); }, () => clock++ === 0 ? 0 : 2001);
  expect(count).toBe(0); expect(timed.nodes).toEqual([]); expect(timed.state).toBe("unknown"); expect(timed.truncated).toBe(true);
  expect((await resolveMemorySymbolNodes([nodes[0]!], context, async () => { throw Error("private raw output"); })).nodes).toEqual([]);
});


test("#684 plan guard query normalization preserves explicit file qualification among multiple paths", () => {
  const task = { id: 1, title: "plan", detail: "", class: "implement", refs: { paths: ["src/a.ts", "src/b.ts"] }, plan: { symbols: ["A.run(input: string)@src/a.ts"] } };
  expect(planGuardNodes(task, context)).toContain("symbol:A.run@src/a.ts");
});


test("#684 fake ripwire observed symbols and exists evidence yield canonical memory nodes without querying the owner tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-memory-symbol-cli-")), cwd = join(root, "repo"), bin = join(root, "bin"), record = join(root, "calls");
  mkdirSync(cwd); mkdirSync(bin);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
    expect(result.status).toBe(0); return result.stdout.trim();
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const facts = new CodeFacts({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RIPWIRE_RECORD: record } });
  try {
    git("init", "-qb", "main"); writeFileSync(join(cwd, "a.ts"), "export function retained() {}\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "a.ts"), "export function retained() {}\nexport function added() {}\n"); git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
    const executable = join(bin, "ripwire");
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fakes/fake-ripwire.ts"))} "$@"\n`); chmodSync(executable, 0o755);
    const observed = await facts.changedSymbols(cwd, base, head);
    expect(observed.state).toBe("known"); if (observed.state !== "known") return;
    const result = await resolveMemorySymbolNodes(observed.value.map(symbol => `symbol:${symbol.name}@${symbol.path}`), { ...context, cwd }, name => facts.exists(cwd, head, name), () => 0);
    expect(result).toMatchObject({ state: "known", nodes: ["symbol:retained@a.ts", "symbol:added@a.ts"] });
    const calls = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(call => call.args.includes("--callers=retained"))).toBe(true);
    expect(calls.every(call => call.cwd !== cwd)).toBe(true);
    expect(git("rev-parse", "HEAD")).toBe(head);
  } finally { await facts.close(); rmSync(root, { recursive: true, force: true }); }
}, 20000);
