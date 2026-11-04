import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { CompletionStore } from "../src/hub/completions-store.ts";
import { needs, summarizeNeeds } from "../src/ui/needs.ts";
import { attentionCommand, attentionResults, consoleNeeds } from "../src/cli/attention.ts";
import { parseResultsArgs } from "../src/cli/results-args.ts";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

// #1054 T4 and T5: receipts, `result_seen`, mark read and unread, `ahub results`, and the `result` need. AC6 and AC7.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean, label: string) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

// --- the store ---------------------------------------------------------------------------------------------------------------------------------------------------------
function store() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-receipts-"));
  const s = new CompletionStore(join(dir, "hub.db"));
  cleanup.push(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const settled = (s: CompletionStore, n: number, peer = "codex") => {
  const run = { peer, runTurn: `${peer}#r.${n}`, lastTurn: `${peer}#r.${n}`, startedAt: n * 10, private: false };
  s.openRun({ ...run, evidence: {}, signalled: false });
  return s.settle(run, "done", n * 10 + 5, `cmp-${String(n).padStart(12, "0")}`)!;
};

test("marking one result read writes exactly one receipt, refuses a second mark and an unknown id, and leaves the others unread", () => {
  const s = store();
  const [a, b] = [settled(s, 1), settled(s, 2)];
  expect(s.unread().map(c => c.id)).toEqual([b.id, a.id]);
  expect(s.markSeen(a.id, 100, "terminal")).toEqual({ ok: true });
  expect(s.markSeen(a.id, 101, "terminal")).toEqual({ ok: false, error: "that result is already read" });
  expect(s.markSeen("cmp-ffffffffffff", 100, "terminal")).toEqual({ ok: false, error: "no such result" });
  expect(s.unread().map(c => c.id)).toEqual([b.id]);
  expect(s.listWithState().find(row => row.id === a.id)).toMatchObject({ seenAt: 100, surface: "terminal" });
  expect(s.listWithState().find(row => row.id === b.id)!.seenAt).toBeUndefined();
});

test("mark-all-read clears every unread result once, and mark-unread relights the most recent read one by deleting its receipt", () => {
  const s = store();
  const [a, b, c] = [settled(s, 1), settled(s, 2), settled(s, 3)];
  s.markSeen(b.id, 50, "console");
  expect(s.markAllSeen(60, "terminal").sort()).toEqual([a.id, c.id].sort());       // b already had its own receipt
  expect(s.unread()).toEqual([]);
  expect(s.markAllSeen(70, "terminal")).toEqual([]);                                // nothing left to mark
  // by when they were READ: a and c share the latest seen_at (60), so the newer settle (c) breaks the tie; b was read first (50), so it relights last
  expect(s.unmarkLast()).toBe(c.id);
  expect(s.unread().map(x => x.id)).toEqual([c.id]);
  expect(s.unmarkLast()).toBe(a.id);
  expect(s.unmarkLast()).toBe(b.id);
  expect(s.unmarkLast()).toBeUndefined();                                           // nothing is read any more
  expect(s.unread()).toHaveLength(3);
});

test("two callers racing to mark one result read produce one receipt", () => {
  const s = store();
  const a = settled(s, 1);
  const results = [s.markSeen(a.id, 1, "terminal"), s.markSeen(a.id, 2, "console")];
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(s.listWithState()[0]).toMatchObject({ seenAt: 1, surface: "terminal" });
});

test("retention bounds the table: past the keep line the oldest READ completions go with their receipts, and an unread one or an open run is never deleted", () => {
  const s = store();
  const made = Array.from({ length: 8 }, (_, i) => settled(s, i + 1));
  // read the five oldest, leave the three newest unread
  for (const c of made.slice(0, 5)) s.markSeen(c.id, 1000, "terminal");
  expect(s.prune(2)).toBe(3);                                                       // the three oldest read ones beyond the two kept
  const left = s.listWithState().map(row => row.id).sort();
  expect(left).toEqual([...made.slice(3).map(c => c.id)].sort());                    // 2 read + 3 unread remain
  expect(s.unread().map(c => c.id).sort()).toEqual(made.slice(5).map(c => c.id).sort());
  expect(s.prune(2)).toBe(0);                                                       // nothing more to prune
  expect(s.prune(0)).toBe(2);                                                       // keep zero read ones: the two read go, the unread stay
  expect(s.unread()).toHaveLength(3);
  // an open run is untouched by retention
  s.openRun({ peer: "pi", runTurn: "pi#r.1", lastTurn: "pi#r.1", startedAt: 1, private: false, evidence: {}, signalled: false });
  s.prune(0);
  expect(s.openRuns()).toHaveLength(1);
});

test("unread results are filtered in the query before the limit: an old unread one behind 100 newer read ones is listed, and a listing shorter than the truth says how many it left out", () => {
  const s = store();
  const old = settled(s, 1);                                                          // the oldest, and the only unread one
  const newer = Array.from({ length: 100 }, (_, i) => settled(s, i + 2));
  for (const c of newer) s.markSeen(c.id, 5000, "terminal");
  expect(s.listWithState(100, false).map(row => row.id)).not.toContain(old.id);      // an unfiltered newest-100 listing really does hide it ...
  expect(s.listWithState(100, true).map(row => row.id)).toEqual([old.id]);           // ... and the unread query does not
  expect(s.unreadCount()).toBe(1);
  // more unread than the bound: the listing is the newest 100 unread, and the count says how many exist
  const many = store();
  for (let i = 0; i < 105; i++) settled(many, i + 1);
  expect(many.listWithState(100, true)).toHaveLength(100);
  expect(many.unreadCount()).toBe(105);
});

test("mark-unread relights the result READ last, not the newest settled: read A (newer) then B (older), and unread-last relights B", () => {
  const s = store();
  const older = settled(s, 1), newer = settled(s, 2);
  s.markSeen(newer.id, 100, "terminal");                                              // A, the newer result, read first
  s.markSeen(older.id, 200, "terminal");                                              // B, the older result, read last
  expect(s.unmarkLast()).toBe(older.id);                                              // the latest receipt is B's
  expect(s.unread().map(c => c.id)).toEqual([older.id]);
  expect(s.unmarkLast()).toBe(newer.id);
  expect(s.unmarkLast()).toBeUndefined();
  // many rows with one seen_at (read-all): settle time and id break the tie, newest first
  const t = store();
  const [a, b, c] = [settled(t, 1), settled(t, 2), settled(t, 3)];
  t.markAllSeen(300, "terminal");
  expect([t.unmarkLast(), t.unmarkLast(), t.unmarkLast()]).toEqual([c.id, b.id, a.id]);
});

// --- the pure parts ----------------------------------------------------------------------------------------------------------------------------------------------------
test("ahub results parses one closed request and refuses a malformed or combined one", () => {
  expect(parseResultsArgs([])).toEqual({ ok: true, value: { action: "list", unread: false } });
  expect(parseResultsArgs(["--unread"])).toEqual({ ok: true, value: { action: "list", unread: true } });
  expect(parseResultsArgs(["--read", "cmp-0123456789ab"])).toEqual({ ok: true, value: { action: "read", id: "cmp-0123456789ab" } });
  expect(parseResultsArgs(["--read=cmp-0123456789ab"])).toEqual({ ok: true, value: { action: "read", id: "cmp-0123456789ab" } });
  expect(parseResultsArgs(["--read-all"])).toEqual({ ok: true, value: { action: "read-all" } });
  expect(parseResultsArgs(["--unread-last"])).toEqual({ ok: true, value: { action: "unread-last" } });
  for (const bad of [["--read"], ["--read", "nope"], ["--read", "cmp-0123456789ab", "--read-all"], ["--read-all", "--unread-last"], ["--unread", "--read-all"], ["--bogus"], ["stray"]]) expect(parseResultsArgs(bad), bad.join(" ")).toMatchObject({ ok: false });
});

test("the help line matches the command, which is the person's and never an agent shell's", () => {
  expect(HELP.flatMap(helpCommands)).toContain("results");
  expect(classifyPeerCommand("results", [])).toBe("console");
  expect(classifyPeerCommand("results", ["--read-all"])).toBe("console");
  expect(cliCommandLabel("results", ["--read", "cmp-0123456789ab"])).toBe("results read");     // the audit never names the id
  expect(cliCommandLabel("results", ["--read-all"])).toBe("results read-all");
  expect(cliCommandLabel("results", [])).toBe("results");
});

test("an unread result is a watch need: it never makes the state waiting, blocked or review, and carries ids only", () => {
  const result = needs({ results: [{ id: "cmp-0123456789ab", peer: "codex", since: 5 }, { id: "bad id with spaces", peer: "codex" }] }, 1000);
  expect(result.items).toEqual([{ kind: "result", level: "watch", peer: "codex", id: "cmp-0123456789ab", since: 5 }]);
  expect(result).toMatchObject({ act: 0, watch: 1 });
  expect(["waiting", "blocked", "review"]).not.toContain(result.state);
  // it ranks after a message and before a budget pause, and never ahead of anything the person must act on
  const mixed = needs({ results: [{ id: "cmp-0123456789ab" }], approvals: [{ id: "p1", peer: "kimi", expiresAt: 5000 }], budget: { claude: { paused: { since: 1 } } } }, 1000);
  expect(mixed.items.map(item => item.kind)).toEqual(["approval", "result", "budget"]);
  expect(summarizeNeeds({ results: [{ id: "cmp-0123456789ab" }] }, 1000)).toMatchObject({ act: 0, watch: 1, first: { kind: "result" } });
  expect(consoleNeeds({ approvals: [], permissionDefaults: [], peers: {}, budget: {}, results: [{ id: "cmp-0123456789ab", peer: "codex" }] }, 1000).items[0]).toMatchObject({ kind: "result", level: "watch" });
  expect(attentionCommand({ kind: "result", level: "watch", id: "cmp-0123456789ab" })).toBe("ahub results --read cmp-0123456789ab");
});

test("the console reads results from the status attention items by shape, dropping anything else", () => {
  expect(attentionResults([{ kind: "result", level: "watch", id: "cmp-0123456789ab", peer: "codex", since: 7, body: "SECRET" }, { kind: "result", level: "act", id: "cmp-0123456789ab" }, { kind: "result", level: "watch", id: "x" }, null, { kind: "offer", id: 3, level: "act" }]))
    .toEqual([{ id: "cmp-0123456789ab", peer: "codex", since: 7 }]);
  expect(attentionResults(undefined)).toEqual([]);
});

// --- the daemon --------------------------------------------------------------------------------------------------------------------------------------------------------
class Manual extends BasePeer {
  readonly got: Envelope[] = [];
  private pending: string | undefined;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(...envs); this.pending = id; if (id) this.onDelivery?.({ id, state: "accepted" }); this.setState("busy"); }
  end() { const id = this.pending; this.pending = undefined; this.setState("idle"); if (id) this.onDelivery?.({ id, state: "completed" }); }
}

async function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-receipts-d-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const daemon = await startDaemon({ cwd, stateDir, projectId: "receipts-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const codex = new Manual("codex"); daemon.bus.add(codex); await codex.start();
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const agent = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
  cleanup.push(async () => { person.close(); agent.close(); await daemon.stop(); });
  const finish = async (body = "do it") => {
    const before = readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "completion").length;
    await person.request({ t: "send", body, to: ["codex"] });
    await until(() => codex.state === "busy", "the turn");
    codex.end();
    await until(() => readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "completion").length === before + 1, "a completion");
  };
  const events = () => readEvents(join(stateDir, "events.jsonl"));
  // the CLI as a person runs it: no agent markers, this project's state (the same wrapper the question tests use)
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const wrapper = join(cwd, `cli-${crypto.randomUUID()}.ts`), entry = join(import.meta.dir, "../src/cli/main.ts");
    const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED"];
    writeFileSync(wrapper, `for(const key of ${JSON.stringify(markers)})delete process.env[key];Object.assign(process.env,${JSON.stringify({ AGENTHUB_HOME: join(cwd, "home"), ...env })});process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); rmSync(wrapper, { force: true }); }
  };
  return { cwd, stateDir, daemon, codex, person, agent, finish, events, cli };
}

test("AC6 snapshot and status reads never create a receipt, result_seen from a peer-role connection is refused, and the console marks exactly that result read", async () => {
  const f = await rig();
  await f.finish(); await f.finish();
  const status = async () => (await f.person.request({ t: "status" })).status;
  const listed = async (unread = false) => (await f.person.request({ t: "results", unread })).results as { id: string; read: boolean; title: string }[];
  expect(await listed()).toHaveLength(2);
  expect((await status()).needs).toMatchObject({ act: 0, watch: 2, first: { kind: "result", level: "watch" } });
  // reads of every kind leave both unread
  for (let i = 0; i < 3; i++) { await f.person.request({ t: "ui_snapshot", after: 0 }); await status(); await listed(); }
  expect((await listed(true))).toHaveLength(2);
  expect(f.events().filter(e => e.type === "completion_seen")).toEqual([]);
  const [newer, older] = await listed();
  // a peer-role connection is refused with a reply, and the row is unchanged
  const refused = await f.agent.request({ t: "result_seen", id: older!.id });
  expect(refused).toMatchObject({ ok: false });
  expect(String(refused.error)).toContain("console command");
  expect((await listed(true))).toHaveLength(2);
  // the console marks exactly that completion
  const marked = await f.person.request({ t: "result_seen", id: older!.id, surface: "console" });
  expect(marked).toMatchObject({ ok: true, id: older!.id });
  expect((await listed(true)).map(row => row.id)).toEqual([newer!.id]);
  expect((await status()).needs).toMatchObject({ watch: 1 });
  expect(f.events().filter(e => e.type === "completion_seen").map(e => [e.id, e.surface])).toEqual([[older!.id, "console"]]);
  // a second mark, an unknown id and a missing id each get a reply that names why
  expect(await f.person.request({ t: "result_seen", id: older!.id })).toMatchObject({ ok: false, error: "that result is already read" });
  expect(await f.person.request({ t: "result_seen", id: "cmp-ffffffffffff" })).toMatchObject({ ok: false, error: "no such result" });
  expect(await f.person.request({ t: "result_seen" })).toMatchObject({ ok: false });
  // a tools-role `results` read, read-all and unread-last are the person's too
  for (const action of [undefined, "read-all", "unread-last"]) expect(await f.agent.request({ t: "results", ...(action ? { action } : {}) }), String(action)).toMatchObject({ ok: false });
  expect((await listed(true))).toHaveLength(1);
});

test("AC7 read-all marks every unread result once and unread-last relights the most recent read one, in the order the spec gives", async () => {
  const f = await rig();
  await f.finish(); await f.finish(); await f.finish();
  const listed = async (unread = false) => (await f.person.request({ t: "results", unread })).results as { id: string; read: boolean }[];
  const all = await listed();
  const all3 = await f.person.request({ t: "results", action: "read-all", surface: "terminal" });
  expect(all3).toMatchObject({ ok: true, marked: 3 });
  expect(await listed(true)).toEqual([]);
  expect((await f.person.request({ t: "status" })).status.needs).toMatchObject({ act: 0, watch: 0 });
  expect(await f.person.request({ t: "results", action: "read-all" })).toMatchObject({ ok: true, marked: 0 });
  const relit = await f.person.request({ t: "results", action: "unread-last" });
  expect(relit).toMatchObject({ ok: true, unread: all[0]!.id });                    // the newest settled one
  expect((await listed(true)).map(row => row.id)).toEqual([all[0]!.id]);
  expect((await f.person.request({ t: "status" })).status.needs).toMatchObject({ watch: 1 });
  expect(f.events().filter(e => e.type === "completion_seen")).toHaveLength(3);
});

test("the recovery refusal for a target without the completions feature names the step for an open run and for an unread result, and reading them clears the unread case", async () => {
  const { DAEMON_FEATURES } = await import("../src/hub/control-client.ts");
  const without = DAEMON_FEATURES.filter(feature => feature !== "completions");
  const f = await rig();
  await f.finish();
  const instanceId = ((await f.person.request({ t: "status" })).status as { instanceId: string }).instanceId;
  const inspect = async () => String((await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId, targetFeatures: without })).error ?? "");
  const unread = await inspect();
  expect(unread).toContain("unread results");
  expect(unread).toContain("ahub results --read-all");                               // the step that actually clears it
  expect(unread).not.toContain("let them settle");
  await f.person.request({ t: "results", action: "read-all" });
  expect(await inspect()).not.toContain("completions");                                // nothing left that an older daemon would orphan
});

test("a result's title is computed at display: a private run shows a stub, and no prompt or reply text reaches a read, a need, the events or the log", async () => {
  const f = await rig();
  await f.finish("TOPSECRET-PROMPT-TEXT");
  const view = (await f.person.request({ t: "results" })).results[0];
  expect(view).toMatchObject({ peer: "codex", outcome: "done", private: false, title: "codex: finished" });
  expect(JSON.stringify(await f.person.request({ t: "status" }))).not.toContain("TOPSECRET-PROMPT-TEXT");
  expect(JSON.stringify(view)).not.toContain("TOPSECRET-PROMPT-TEXT");
  await f.person.request({ t: "result_seen", id: view.id });
  expect(readFileSync(join(f.stateDir, "events.jsonl"), "utf8")).not.toContain("TOPSECRET-PROMPT-TEXT");
  expect(Object.keys(f.events().find(e => e.type === "completion_seen")!).sort()).toEqual(["at", "id", "surface", "type", "v"]);
  // a private completion is a stub with no outcome word
  const probe = new CompletionStore(join(f.stateDir, "hub.db"));
  try {
    const run = { peer: "codex", runTurn: "codex#p.1", lastTurn: "codex#p.1", startedAt: 1, private: true };
    probe.openRun({ ...run, evidence: {}, signalled: false });
    probe.settle(run, "failed", 9, "cmp-aaaaaaaaaaaa");
  } finally { probe.close(); }
  const rows = (await f.person.request({ t: "results", unread: true })).results as { title: string; private: boolean }[];
  expect(rows.find(row => row.private)).toMatchObject({ title: "codex: a private result" });
});

test("the real ahub process lists, marks read, marks all read and relights, prints nothing but ids and the computed title, and an agent shell is refused before the hub", async () => {
  const f = await rig();
  await f.finish("TOPSECRET-PROMPT-TEXT"); await f.finish("TOPSECRET-PROMPT-TEXT");
  const listed = await f.cli(["results"]);
  expect(listed.code, listed.stderr).toBe(0);
  const ids = listed.stdout.split("\n").filter(Boolean).map(line => /^\* (cmp-[a-f0-9]{12}) /.exec(line)![1]!);   // one row per result, newest first
  expect(new Set(ids).size).toBe(2);
  expect(listed.stdout).toContain("* ");                                           // unread ones are marked
  expect(listed.stdout).toContain("codex: finished");
  expect(listed.stdout).not.toContain("TOPSECRET-PROMPT-TEXT");
  expect((await f.cli(["results"])).stdout).toBe(listed.stdout);                    // reading again changed nothing
  const one = await f.cli(["results", "--read", ids[1]!]);                          // the older one
  expect(one.code, one.stderr).toBe(0); expect(one.stdout).toContain(`marked ${ids[1]} read`);
  expect((await f.cli(["results", "--unread"])).stdout).toContain(ids[0]!);
  expect((await f.cli(["results", "--unread"])).stdout).not.toContain(ids[1]!);
  const again = await f.cli(["results", "--read", ids[1]!]);
  expect(again.code).toBe(1); expect(again.stderr).toContain("already read");
  const all = await f.cli(["results", "--read-all"]);
  expect(all.code, all.stderr).toBe(0); expect(all.stdout).toContain("marked 1 result read");
  expect((await f.cli(["results", "--unread"])).stdout).toContain("no unread results");
  const relit = await f.cli(["results", "--unread-last"]);
  expect(relit.code, relit.stderr).toBe(0); expect(relit.stdout).toContain("unread again");
  const json = await f.cli(["results", "--unread", "--json"]);
  expect(JSON.parse(json.stdout)).toHaveLength(1);
  const usage = await f.cli(["results", "--read", "nope"]);
  expect(usage.code).toBe(1); expect(usage.stderr).toContain("usage: ahub results");
  // an agent shell is refused before it reaches the hub, and nothing it passed is written
  const before = JSON.stringify((await f.person.request({ t: "results" })).results);
  const refused = await f.cli(["results", "--read-all"], { AGENTHUB_PEER_ID: "codex" });
  expect(refused.code).toBe(1);
  expect(JSON.stringify((await f.person.request({ t: "results" })).results)).toBe(before);
});

// --- the console ---------------------------------------------------------------------------------------------------------------------------------------------------------
import { initialConsoleState, renderConsoleLines, paint } from "../src/cli/console-state.ts";

test("the console state carries unread results as watch needs, and its status line shows them without changing the state words", () => {
  const state = { ...initialConsoleState(false), results: [{ id: "cmp-0123456789ab", peer: "codex", since: 3 }] };
  const attention = consoleNeeds(state, 1000);
  expect(attention.items).toEqual([{ kind: "result", level: "watch", peer: "codex", id: "cmp-0123456789ab", since: 3 }]);
  expect(attention).toMatchObject({ act: 0, watch: 1 });
  expect(["waiting", "blocked", "review"]).not.toContain(attention.state);
  const text = renderConsoleLines(state, 120, 30).map(line => paint(line, false)).join("\n");
  expect(text).not.toContain("TOPSECRET");
});
