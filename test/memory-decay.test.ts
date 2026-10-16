import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey, type NoteInput } from "@staix/agent-mem";
import { memoryCommand } from "../src/cli/memory.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";

const DAY = 24 * 3600_000, NOW = Date.parse("2026-10-20T00:00:00Z");
const dirs: string[] = [], stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), "ahub-decay-"))); dirs.push(path); return path; }
function fixture(clock = { now: NOW }) {
  const cwd = temp(), home = temp(), project = memoryProjectKey(cwd);
  const store = new MemoryStore({ home, now: () => clock.now, deferPromotions: true });
  stores.push(store);
  const note = (text: string, age: number, extra: Partial<NoteInput> = {}) => store.importNote({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "codex", text, about: [], source: "person", ...extra }, new Date(NOW - age * DAY).toISOString()).id;
  return { cwd, home, project, store, note };
}
function logs(store: MemoryStore) {
  return Object.fromEntries(["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).sort().filter(name => name.endsWith(".jsonl")).map(name => [`${dir}/${name}`, readFileSync(join(store.dir, dir, name), "utf8")])));
}

test("decay reviews only old long notes belonging to this project, excluding nonterminal goal links", async () => {
  const { cwd, project, store, note } = fixture();
  const wanted = note("old standalone", 91), atBoundary = note("exactly ninety", 90), recent = note("recent", 89);
  note("foreign shared note", 120, { project: "another-project", scope: "shared" });
  note("short note", 120, { tier: "short" });
  const goal = store.goal({ project, scope: "project", title: "open work", milestones: [], dependsOn: [], actor: "user" });
  const task = `${project}#1@1`;
  store.goalLink(goal, task, "user");
  note("linked through task field", 120, { task });
  note("linked through about task", 120, { about: [`task:${task}`] });
  note("linked directly to goal", 120, { about: [`goal:${goal}`] });
  const completed = store.goal({ project, scope: "project", title: "finished work", milestones: [], dependsOn: [], actor: "user" });
  const doneTask = `${project}#2@1`;
  store.goalLink(completed, doneTask, "user"); store.goalState(completed, "done", "user");
  const doneNote = note("linked to a finished goal", 120, { task: doneTask });
  const before = logs(store);
  const result = JSON.parse(await memoryCommand(["decay", "--json"], cwd, { store, now: () => NOW }));
  expect(result.days).toBe(90);
  expect(result.cutoff).toBe(new Date(NOW - 90 * DAY).toISOString());
  expect(result.candidates.map((v: { id: string }) => v.id).sort()).toEqual([wanted, doneNote].sort());
  expect(logs(store)).toEqual(before);
  const shorter = JSON.parse(await memoryCommand(["--json", "decay", "--days", "88"], cwd, { store, now: () => NOW }));
  expect(shorter.candidates.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining([wanted, atBoundary, recent, doneNote]));
  for (const state of ["active", "blocked"] as const) {
    store.goalState(goal, state, "user");
    expect(JSON.parse(await memoryCommand(["decay", "--json"], cwd, { store, now: () => NOW })).candidates.map((v: { id: string }) => v.id).sort()).toEqual([wanted, doneNote].sort());
  }
});

test("decay screens current policy, rejects malformed days, and never appends held promotions", async () => {
  const clock = { now: NOW - 120 * DAY };
  const { cwd, project, store, note } = fixture(clock);
  const safe = note("safe old decision", 120);
  note("patient 900101-1234567", 120);
  note("private record", 120, { about: ["path:clients/records.csv"] });
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ pii: { paths: ["clients/**"] } }));
  const task = `${project}#3@1`;
  const held = store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "codex", text: "held source", task, about: [], source: "person" });
  const replacement = note("temporary replacement", 120);
  store.supersede(held, replacement, "user", project);
  store.settle(task, "claude"); store.demote(replacement, "user", project);
  clock.now = NOW;
  const before = logs(store);
  const result = JSON.parse(await memoryCommand(["decay", "--json"], cwd, { store, now: () => NOW }));
  expect(result.candidates.map((v: { id: string }) => v.id)).toEqual([safe]);
  expect(logs(store)).toEqual(before);
  const text = await memoryCommand(["decay"], cwd, { store, now: () => NOW });
  expect(text).toContain("review only"); expect(text).not.toContain("900101-1234567"); expect(text).not.toContain("private record");
  for (const args of [["--days"], ["--days", "0"], ["--days", "-1"], ["--days", "1.5"], ["--days", "NaN"], ["--days", "Infinity"], ["--days", "9999999999999999999"], ["--days", "1", "--days", "2"], ["--apply"]]) {
    await expect(memoryCommand(["decay", ...args], cwd, { store, now: () => NOW })).rejects.toThrow();
  }
  expect(logs(store)).toEqual(before);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ pii: { paths: ["clients/**"] }, memory: { short_ttl_days: "invalid" } }));
  await expect(memoryCommand(["decay"], cwd, { store, now: () => NOW })).rejects.toThrow("does not load");
});

test("decay is refused at the real CLI boundary for native and hub agents, including live-test delegation", async () => {
  const root = temp(), cli = join(import.meta.dir, "../src/cli/main.ts");
  const markerNames = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
  for (const args of [["decay"], ["--json", "decay"], ["decay", "--days", "30"], ["decay", "--as-user"]]) {
    expect(classifyPeerCommand("memory", args)).toBe("console");
    expect(liveTestRefusal("memory", args)).toBe(true);
    expect(cliCommandLabel("memory", args)).toBe("memory decay");
  }
  for (const [markers, prefix] of [
    [{ CODEX_THREAD_ID: "fixture-thread" }, []],
    [{ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "fixture-session" }, []],
    [{ AGENTHUB_PEER_ID: "pi" }, []],
    [{ AGENTHUB_PEER_ID: "codex" }, ["--live-test"]],
  ] as [Record<string, string>, string[]][]) {
    const wrapper = join(root, `decay-${crypto.randomUUID()}.ts`);
    writeFileSync(wrapper, `for (const key of ${JSON.stringify(markerNames)}) delete process.env[key];\nObject.assign(process.env, ${JSON.stringify(markers)}, {AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))}});\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify([...prefix, "memory", "decay"])}];\nawait import(${JSON.stringify(cli)});\n`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(1); expect(stdout).toBe("");
      expect(stderr).toMatch(/cannot run ahub memory decay|live-test.*(?:refus|person|memory)/i);
    } finally { clearTimeout(timer); }
  }
}, 25_000);
