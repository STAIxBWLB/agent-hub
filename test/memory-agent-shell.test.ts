import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey, type NoteInput } from "@staix/agent-mem";
import { memoryCommand } from "../src/cli/memory.ts";
import { withAgentAttribution } from "../src/cli/agent-attribution.ts";
import { AGENT_MEMORY_RECORDING_SUBS, AGENT_MEMORY_SUBS, classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";

// #1522 (hub task 969): an agent shell runs the memory family as itself. These tests read amem's own append-only log, so "recorded as the agent" is
// what the store holds, not what a message says.
const dirs: string[] = [], stores: MemoryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), "ahub-memory-agent-"))); dirs.push(path); return path; };
let clock = Date.parse("2026-10-20T00:00:00Z");
function fixture() {
  const cwd = temp(), home = temp(), project = memoryProjectKey(cwd);
  const store = new MemoryStore({ home, now: () => clock++ });
  stores.push(store);
  const make = (text: string, over: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "kimi", text, about: [], source: "person", ...over });
  return { cwd, home, project, store, make };
}
/** Every operation row the store wrote, from its append-only segments. */
function ops(store: MemoryStore): { op: string; actor?: string; by?: string }[] {
  return ["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).filter(name => name.endsWith(".jsonl")).flatMap(name => readFileSync(join(store.dir, dir, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { op: string; actor?: string; by?: string })));
}
const lastOp = (store: MemoryStore, op: string) => ops(store).filter(row => row.op === op).at(-1);

test("AC1: every named memory form is allowed for an agent shell, and the closed list is exactly the spec's plus the existing reads", () => {
  const forms: string[][] = [["sync"], ["sync", "--remote", "git@example.com:o/r.git"], ["machine"], ["machine", "--label", "office"], ["import", "claude-mem"], ["dedupe", "--apply"], ["promote", "x"],
    ["demote", "x"], ["forget", "x"], ["supersede", "a", "b"], ["rebuild"], ["decay"], ["declined"], ["list"], ["search", "x"], ["show", "x"], ["suggestions"], ["--json"], []];
  for (const args of forms) expect(classifyPeerCommand("memory", args), args.join(" ")).toBe("allowed");
  expect(new Set(AGENT_MEMORY_SUBS)).toEqual(new Set(["list", "search", "show", "suggestions", "machine", "sync", "import", "dedupe", "promote", "demote", "forget", "supersede", "rebuild", "decay", "declined"]));
  // The recording forms are a subset of the allowed ones: nothing records an actor without going through the agent scope below.
  for (const sub of AGENT_MEMORY_RECORDING_SUBS) expect(AGENT_MEMORY_SUBS).toContain(sub);
});

test("AC3: one memory command is allowed while non-memory person-only commands and the rest of the memory family keep their refusals", () => {
  expect(classifyPeerCommand("memory", ["forget", "x"])).toBe("allowed");
  for (const [command, args] of [["permission", ["claude", "never-ask", "--yes"]], ["budget", ["set", "claude", "1"]], ["agents", ["trust", "codex-review", "0.165.0"]], ["role", ["assign", "claude", "backend-engineer"]],
    ["task", ["cancel", "1", "--reason", "x", "--as-user"]], ["say", ["--as-user", "hello"]], ["goal", ["new", "a goal"]], ["learn", ["accept", "1"]], ["queue", ["discard", "--peer", "codex"]], ["init", []], ["up", []], ["stop", []]] as [string, string[]][])
    expect(classifyPeerCommand(command, args), `${command} ${args.join(" ")}`).not.toBe("allowed");
  // Left to the person inside the family: the unscreened graph, the judgments of suggested links, the profile check and any unknown form.
  for (const args of [["graph", "x"], ["confirm", "x"], ["reject", "x"], ["profile-check"], ["--json", "profile-check"], ["nonsense"], ["forget", "x", "--as-user"]]) expect(classifyPeerCommand("memory", args), args.join(" ")).toBe("console");
  // live-test still never delegates a memory write to the person.
  for (const args of [["forget", "x"], ["sync"], ["decay"], ["promote", "x"], ["import", "claude-mem"]]) expect(liveTestRefusal("memory", args), args.join(" ")).toBe(true);
});

test("AC2: a change run for an agent is recorded as the agent, never as the person, for each recording form", async () => {
  const f = fixture();
  const a = f.make("alpha long note"), b = f.make("beta long note"), c = f.make("gamma long note");
  // forget
  await memoryCommand(["forget", a], f.cwd, { store: f.store, person: false, agent: "codex" });
  expect(lastOp(f.store, "forget")?.actor).toBe("agent");
  // supersede
  await memoryCommand(["supersede", b, c], f.cwd, { store: f.store, person: false, agent: "codex" });
  expect(lastOp(f.store, "supersede")?.actor).toBe("agent");
  // demote, then promote
  const d = f.make("delta long note");
  await memoryCommand(["demote", d], f.cwd, { store: f.store, person: false, agent: "codex" });
  expect(lastOp(f.store, "demote")?.actor).toBe("agent");
  const written = ops(f.store);
  expect(written.some(row => row.actor === "person" || row.actor === "user" || row.by === "user")).toBe(false);
});

test("the same command run as the person still records the person, so the two are told apart in the log", async () => {
  const f = fixture();
  const a = f.make("person forgets this");
  await memoryCommand(["forget", a], f.cwd, { store: f.store, person: true });
  expect(lastOp(f.store, "forget")?.actor).toBe("user");
});

test("an agent change with no identifiable agent is refused and writes nothing, never recorded as the person", async () => {
  const f = fixture();
  const a = f.make("must stay");
  const before = JSON.stringify(ops(f.store));
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[key];
  await expect(memoryCommand(["forget", a], f.cwd, { store: f.store, person: false })).rejects.toThrow("needs an identified agent or the person");
  expect(JSON.stringify(ops(f.store))).toBe(before);
});

test("reads and the two review listings run for an agent without the agent scope and write no operation", async () => {
  const f = fixture();
  f.make("readable note");
  const before = JSON.stringify(ops(f.store));
  expect(await memoryCommand(["list"], f.cwd, { store: f.store, person: false, agent: "codex" })).toContain("readable note");
  expect(await memoryCommand(["decay"], f.cwd, { store: f.store, person: false, agent: "codex" })).toMatch(/decay candidates?/);
  expect(await memoryCommand(["decay", "--json"], f.cwd, { store: f.store, person: false, agent: "codex" })).toContain("candidates");
  expect(JSON.stringify(ops(f.store))).toBe(before);
});

test("the attribution seam sets and clears amem's scope, and refuses cleanly when amem's module cannot be reached", async () => {
  const f = fixture();
  const seen = await withAgentAttribution("codex", f.cwd, async () => {
    const note = f.make("inside the scope");
    await memoryCommand(["forget", note], f.cwd, { store: f.store, person: false, agent: "codex" });
    return lastOp(f.store, "forget")?.actor;
  });
  expect(seen).toBe("agent");
  // Outside the scope amem's library default holds, so a library caller keeps its existing contract.
  const outside = f.make("outside the scope");
  f.store.forget(outside, "user", f.project);
  expect(lastOp(f.store, "forget")?.actor).toBe("user");
});

test("the real CLI runs an agent-shell memory change and the audit names the agent, while a non-memory person-only command is still refused", async () => {
  const cwd = temp(), home = temp(), cli = join(import.meta.dir, "../src/cli/main.ts");
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub/config.json"), "{}");
  const run = async (args: string[], markers: Record<string, string>) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, AGENTHUB_HOME: join(home, "hub"), NO_COLOR: "1", ...markers };
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); }
  };
  for (const markers of [{ CODEX_THREAD_ID: "fixture-thread" }, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "fixture-session" }, { AGENTHUB_PEER_ID: "kimi" }] as Record<string, string>[]) {
    const allowed = await run(["memory", "machine"], markers);
    expect(allowed.code, allowed.stderr).toBe(0); expect(allowed.stdout).toContain("this machine:");
    const forgetMissing = await run(["memory", "forget", "deadbeef"], markers);
    // It reaches amem (and says there is no such entry) instead of being refused at the identity gate.
    expect(forgetMissing.stderr).not.toMatch(/cannot run ahub memory|person-only|console user/i);
    expect(forgetMissing.stderr + forgetMissing.stdout).toMatch(/no memory entry|unavailable|refused/i);
    const personOnly = await run(["permission", "claude", "never-ask", "--yes"], markers);
    expect(personOnly.code).not.toBe(0); expect(personOnly.stderr).toMatch(/cannot run ahub permission|person/i);
    const graph = await run(["memory", "graph", "x"], markers);
    expect(graph.code).not.toBe(0); expect(graph.stderr).toMatch(/cannot run ahub memory graph|person/i);
  }
}, 120_000);
