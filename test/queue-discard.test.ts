import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL, PROTOCOL_MIN } from "../src/hub/control-client.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { realPath } from "../src/hub/project.ts";
import { reduceConsole, initialConsoleState, renderConsole, keyTable, commandNeedsConfirmation } from "../src/cli/console-state.ts";
import { HELP } from "../src/cli/help.ts";
import { frame, newEnvelope, type Envelope } from "../src/hub/envelope.ts";

// #713 (task #382): the pull-only peer catches up through the real `inbox` request, and the person's bulk `ahub queue discard --peer` through the real control path and CLI.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { COLUMNS: "200", AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); }

async function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-queue-discard-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(join(root, ".agenthub"), { recursive: true }); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  cleanup.push(async () => { person.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, daemon, person };
}
const queueRows = (f: { daemon: { bus: { queueList(peer?: string): any[] } } }, peer: string, state = "queued") => f.daemon.bus.queueList(peer).filter(r => r.state === state);

test("a real pull-only peer with 45 queued items reads them in one hub_inbox request, oldest first, and `waiting` is 0 (#713 acceptance)", async () => {
  const f = await rig();
  const agy = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false });     // claude without channel pushes: a pull-only peer
  cleanup.push(() => agy.close());
  await until(() => f.daemon.bus.peers.get("claude")?.pullOnly === true);
  (f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void }).nativeStarted("fixture");   // busy: nothing is pushed
  const ids: string[] = [];
  for (let i = 0; i < 45; i++) {
    const important = i === 3 || i === 22 || i === 40;
    const env = newEnvelope("user", important ? `[IMPORTANT] item ${i}` : `item ${i}`, { to: ["claude"], ...(important ? { priority: "important" as const } : {}) });
    ids.push(env.id); f.daemon.bus.publish(env);
  }
  expect(f.daemon.bus.queued("claude")).toBe(45);
  const read = await agy.request({ t: "inbox" });
  expect(read.ok).toBe(true);
  expect(read.envs.filter((e: Envelope) => e.kind !== "presence").map((e: Envelope) => e.id)).toEqual(ids);   // all of them, oldest ordinary item first
  expect(read.envs.filter((e: Envelope) => e.priority === "important")).toHaveLength(3);
  expect(read.waiting).toBe(0); expect(read.waitingImportant).toBe(0);
  expect(read.envs.every((e: Envelope) => frame(e).startsWith("[agent-hub message from"))).toBe(true);
  const completed = f.daemon.bus.queueList("claude").filter(r => r.state === "completed");
  expect(completed).toHaveLength(1);                                                                       // one completed pull delivery for the call
});

test("a queue over the budget says how many are waiting, and the plugin tells the agent to call hub_inbox again (#713 acceptance)", async () => {
  const f = await rig();
  const agy = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false });
  cleanup.push(() => agy.close());
  await until(() => f.daemon.bus.peers.get("claude")?.pullOnly === true);
  (f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void }).nativeStarted("fixture");
  for (let i = 0; i < 30; i++) f.daemon.bus.publish(newEnvelope("user", `big ${i} ${"x".repeat(4000)}`, { to: ["claude"] }));
  const first = await agy.request({ t: "inbox" });
  const got = first.envs.filter((e: Envelope) => e.kind !== "presence").length;
  expect(got).toBeGreaterThan(10); expect(got).toBeLessThan(30);
  expect(first.waiting).toBe(30 - got);                                                                    // the reply's `waiting` counts what is left
  const second = await agy.request({ t: "inbox" });
  expect(got + second.envs.filter((e: Envelope) => e.kind !== "presence").length).toBe(30); expect(second.waiting).toBe(0);
});

test("ahub queue discard: the count without --yes, every queued delivery of that peer with --yes and the reason, push peers untouched (#713 acceptance)", async () => {
  const f = await rig();
  const agy = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false });
  cleanup.push(() => agy.close());
  await until(() => f.daemon.bus.peers.get("claude")?.pullOnly === true);
  (f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void }).nativeStarted("fixture");
  for (let i = 0; i < 12; i++) f.daemon.bus.publish(newEnvelope("user", `for the pull-only peer ${i}`, { to: ["claude"] }));
  // another peer with queued work: codex is offline in this rig, so its messages are retained in its queue
  for (let i = 0; i < 3; i++) f.daemon.bus.publish(newEnvelope("user", `for codex ${i}`, { to: ["codex"] }));
  const codexBefore = f.daemon.bus.queued("codex");
  // without --yes: a count, nothing discarded
  const dry = await cli(f.root, ["queue", "discard", "--peer", "claude", "--reason", "cleaning"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("12 queued deliveries for claude; nothing discarded");
  expect(f.daemon.bus.queued("claude")).toBe(12);
  // --yes without a reason is refused
  const noReason = await cli(f.root, ["queue", "discard", "--peer", "claude", "--yes"]);
  expect(noReason.code).toBe(1); expect(noReason.stderr).toContain("needs --reason");
  // with --yes: every queued delivery is discarded with the reason, each recorded
  const real = await cli(f.root, ["queue", "discard", "--peer", "claude", "--reason", "agy backlog cleared by the person", "--yes"]);
  expect(real.code, real.stderr).toBe(0);
  expect(real.stdout).toContain("discarded 12 of 12 queued deliveries for claude");
  expect(f.daemon.bus.queued("claude")).toBe(0);
  const discarded = f.daemon.bus.queueList("claude").filter(r => r.state === "discarded");
  expect(discarded.length).toBeGreaterThanOrEqual(12);
  expect(discarded.every(r => /agy backlog cleared by the person/.test(String(r.reason)))).toBe(true);
  expect(f.daemon.bus.queued("codex")).toBe(codexBefore);                                                  // another peer's queue is untouched
  expect((await agy.request({ t: "inbox" })).envs.filter((e: Envelope) => e.kind !== "presence")).toEqual([]);   // nothing left to read
});

test("a busy pull-only peer's queued deliveries can be discarded one by one, and a refusal names its cause on the wire (#713 items 7 and 8)", async () => {
  const f = await rig();
  const agy = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false });
  cleanup.push(() => agy.close());
  await until(() => f.daemon.bus.peers.get("claude")?.pullOnly === true);
  (f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void }).nativeStarted("fixture");
  expect(f.daemon.bus.stateOf("claude")).toBe("busy");
  f.daemon.bus.publish(newEnvelope("user", "one", { to: ["claude"] })); f.daemon.bus.publish(newEnvelope("user", "two", { to: ["claude"] }));
  const [row] = queueRows(f, "claude");
  const ok = await f.person.request({ t: "queue", op: "resolve", id: row.id, revision: row.revision, action: "discard", reason: "busy peer, queued work" });
  expect(ok.ok, JSON.stringify(ok)).toBe(true);                                                            // the old code refused this with the generic sentence
  const stale = await f.person.request({ t: "queue", op: "resolve", id: queueRows(f, "claude")[0].id, revision: 999999, action: "discard", reason: "x" });
  expect(stale).toMatchObject({ ok: false }); expect(stale.error).toMatch(/^stale revision:/);
  const unknown = await f.person.request({ t: "queue", op: "resolve", id: "q:claude:nope", revision: 1, action: "discard", reason: "x" });
  expect(unknown.error).toMatch(/^unknown delivery:|^stale revision:/);
  expect(JSON.stringify([stale, unknown])).not.toContain("resolution refused: refresh the delivery revision");   // the old generic sentence is gone
});

test("queue discard requires the configured conductor or person, stays validated, and refuses other agents (#713 acceptance)", async () => {
  const f = await rig();
  expect(classifyPeerCommand("queue", ["discard"])).toBe("conductor");
  const agent = await cli(f.root, ["queue", "discard", "--peer", "claude", "--reason", "x", "--yes"], { AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1" });
  expect(agent.code).toBe(1); expect(agent.stderr).toContain("cannot run ahub queue"); expect(agent.stdout).toBe("");
  const bad = await f.person.request({ t: "queue", op: "discard", peer: "../etc", confirmed: true, reason: "x" });
  expect(bad).toMatchObject({ ok: false }); expect(bad.error).toContain("peer must be a peer id");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "claude", state: "completed" })).error).toContain("state is queued or needs_review");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "claude", confirmed: true })).error).toContain("needs a reason");
  for (const args of [["queue", "discard"], ["queue", "discard", "--peer"], ["queue", "discard", "--peer", "claude", "--state", "nope"], ["queue", "discard", "--peer", "claude", "stray"]]) {
    const out = await cli(f.root, args); expect(out.code).toBe(1);
  }
});

test("the help row matches the parser and the Queue panel's D asks for a reason, then a y that names the count (#713 change 5, 6)", () => {
  expect(HELP.some(entry => entry.usage.startsWith("ahub queue discard --peer <id> --reason <text> [--state queued|needs_review|failed] [--yes]"))).toBe(true);
  expect(commandNeedsConfirmation(["queue", "discard", "--peer", "claude", "--reason", "x", "--yes"])).toBe(true);
  const s = initialConsoleState(true); s.panel = 4; s.project = "agent-hub";
  s.queue = [...Array.from({ length: 5 }, (_, i) => ({ id: `q:agy:${i}`, peer: "agy", state: "queued", revision: 1, createdAt: 1000 + i })), { id: "q:codex:1", peer: "codex", state: "queued", revision: 1, createdAt: 1 }];
  s.selection = 0;
  const opened = reduceConsole(s, "D", 5000).state;
  expect(opened.editing).toBe(true); expect(opened.input).toBe("queue discard --peer agy --reason ");
  const empty = reduceConsole(opened, "\r", 5000);
  expect(empty.effects).toEqual([]); expect(empty.state.notice).toContain("needs --peer and --reason");        // no reason, no run
  let typed = opened; for (const ch of "agy backlog") typed = reduceConsole(typed, ch, 5000).state;
  const asked = reduceConsole(typed, "\r", 5000);
  expect(asked.effects).toEqual([]);                                                                          // nothing runs before y
  expect(asked.state.confirm).toMatchObject({ type: "command" });
  expect((asked.state.confirm as { prompt: string }).prompt).toContain("discard all 5 queued deliveries of agy");
  const confirmed = reduceConsole(asked.state, "y", 5000);
  expect(confirmed.effects).toEqual([{ type: "command", args: ["queue", "discard", "--peer", "agy", "--reason", "agy backlog", "--yes"] }]);
  expect(reduceConsole(asked.state, "n", 5000).effects).toEqual([]);                                          // n cancels
  expect(keyTable(120).flat().map(c => c.text).join("")).toContain("D discard the peer's whole queued backlog");
  expect(renderConsole(s, 100, 24, 5000).join("\n")).not.toContain("D discard");                              // the 80-column footer keeps its j/k, D lives in the key table
});

// #1096 (rest): the bulk discard also clears a peer's unsettled failed rows, and `queue list` stops showing rows a resolution already settled.
type Rig = Awaited<ReturnType<typeof rig>>;
// The bus keeps its journal private; a test that needs to plant a row or read a resolution reaches it the way test/delivery-retry.test.ts does.
const journalOf = (f: Rig) => (f.daemon.bus as unknown as { journal: { createDelivery(row: object): unknown; resolution(id: string): { action: string; reason: string; actor: string } | undefined; db: { run(sql: string, ...params: unknown[]): void }; projectId: string } }).journal;
function failedRow(f: Rig, id: string, peer: string, body: string) {
  const env = newEnvelope("user", body, { to: [peer] });
  journalOf(f).createDelivery({ id, peer, state: "failed", createdAt: env.ts, originals: [env], out: [env], reason: "peer refused it before running it" });
  return env;
}
const deliveries = async (f: Rig, peer: string, all = false) => (await f.person.request({ t: "queue", op: "list", peer, ...(all ? { all: true } : {}) })) as { ok: boolean; deliveries: { id: string; state: string }[]; hiddenSettled?: number };

test("queue discard --peer clears the peer's unsettled failed rows in one call, with a recorded reason, and leaves other peers alone (#1096)", async () => {
  const f = await rig();
  for (let i = 0; i < 4; i++) failedRow(f, `failed-codex-${i}`, "codex", `refused ${i}`);
  failedRow(f, "failed-kimi", "kimi", "another peer's failure");
  for (let i = 0; i < 2; i++) f.daemon.bus.publish(newEnvelope("user", `queued for codex ${i}`, { to: ["codex"] }));
  // count only: nothing changes, and the kinds are named
  const dry = await cli(f.root, ["queue", "discard", "--peer", "codex", "--reason", "clearing"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("6 deliveries for codex (2 queued and 4 failed); nothing discarded");
  expect(f.daemon.bus.queueList("codex").filter(r => r.state === "failed")).toHaveLength(4);
  // with --yes: every queued and failed row of that peer is discarded with the reason
  const real = await cli(f.root, ["queue", "discard", "--peer", "codex", "--reason", "failed backlog cleared by the person", "--yes"]);
  expect(real.code, real.stderr).toBe(0);
  expect(real.stdout).toContain("discarded 6 of 6 deliveries for codex (2 queued and 4 failed)");
  const after = f.daemon.bus.queueList("codex");
  expect(after.filter(r => r.state === "failed")).toHaveLength(0);
  expect(after.filter(r => r.state === "discarded").length).toBeGreaterThanOrEqual(6);
  expect(after.filter(r => r.id.startsWith("failed-codex-")).every(r => r.state === "discarded" && /failed backlog cleared by the person/.test(String(r.reason)))).toBe(true);
  // the same record `queue resolve --action discard` writes, so the row is now settled history
  expect(journalOf(f).resolution("failed-codex-0")).toMatchObject({ action: "discard", reason: "failed backlog cleared by the person", actor: "user" });
  expect(f.daemon.bus.queueList("kimi").find(r => r.id === "failed-kimi")?.state).toBe("failed"); // another peer's failed row is untouched
  // a second run finds nothing left to clear
  const again = await cli(f.root, ["queue", "discard", "--peer", "codex", "--reason", "again", "--yes"]);
  expect(again.stdout).toContain("discarded 0 of 0 queued or failed deliveries for codex");
});

test("a failed row that a retry or a resolution already settled is not discarded again, and --state selects exactly one kind (#1096)", async () => {
  const f = await rig();
  failedRow(f, "failed-open", "codex", "unsettled");
  failedRow(f, "failed-settled", "codex", "settled by a retry");
  const settled = f.daemon.bus.queueShow("failed-settled")!;
  // mark it settled the way a retry does: a resolution row, state stays failed
  journalOf(f).db.run("INSERT INTO resolution_history (project_id, delivery_id, observed_revision, action, reason, result_revision, result_state, actor, peer, original_ids) VALUES (?, ?, ?, 'retry', 'redelivered once', ?, 'failed', 'user', 'codex', '[]')", journalOf(f).projectId, "failed-settled", settled.revision, settled.revision);
  const dry = await f.person.request({ t: "queue", op: "discard", peer: "codex", states: ["failed"] });
  expect(dry).toMatchObject({ ok: true, count: 1, byState: { failed: 1 } }); // only the unsettled one
  const real = await f.person.request({ t: "queue", op: "discard", peer: "codex", states: ["failed"], confirmed: true, reason: "only the open one" });
  expect(real).toMatchObject({ ok: true, discarded: 1, refused: 0 });
  expect(f.daemon.bus.queueShow("failed-open")!.state).toBe("discarded");
  expect(f.daemon.bus.queueShow("failed-settled")!.state).toBe("failed"); // the retry's parent is left as history
  // an explicit single kind never takes another: --state needs_review leaves failed rows alone
  failedRow(f, "failed-again", "codex", "another");
  const only = await cli(f.root, ["queue", "discard", "--peer", "codex", "--state", "needs_review", "--reason", "x", "--yes"]);
  expect(only.stdout).toContain("discarded 0 of 0 needs_review deliveries for codex");
  expect(f.daemon.bus.queueShow("failed-again")!.state).toBe("failed");
  // the old single-state wire form keeps its meaning, and a bad kind names the allowed ones
  expect(await f.person.request({ t: "queue", op: "discard", peer: "codex", state: "queued" })).toMatchObject({ ok: true, state: "queued", count: 0 });
  expect((await f.person.request({ t: "queue", op: "discard", peer: "codex", state: "failed" })).error).toBe("state is queued or needs_review");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "codex", states: ["completed"] })).error).toBe("states is a list of queued, needs_review, failed");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "codex", states: [] })).error).toBe("states is a list of queued, needs_review, failed");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "codex", states: ["failed", "failed"] })).error).toBe("states is a list of queued, needs_review, failed");
  expect((await f.person.request({ t: "queue", op: "discard", peer: "codex", states: ["failed"], state: "queued" })).error).toBe("give state or states, not both");
});

test("a failed row can be discarded while its peer is busy, because it ran nothing (#1096)", async () => {
  const f = await rig();
  const agy = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false });
  cleanup.push(() => agy.close());
  await until(() => f.daemon.bus.peers.get("claude")?.pullOnly === true);
  (f.daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void }).nativeStarted("fixture");
  expect(f.daemon.bus.stateOf("claude")).toBe("busy");
  failedRow(f, "failed-claude", "claude", "refused while busy");
  const row = f.daemon.bus.queueShow("failed-claude")!;
  const ok = await f.person.request({ t: "queue", op: "resolve", id: row.id, revision: row.revision, action: "discard", reason: "busy peer, failed row" });
  expect(ok.ok, JSON.stringify(ok)).toBe(true);
  expect(f.daemon.bus.queueShow("failed-claude")!.state).toBe("discarded");
  // the busy fence still holds for the other resolutions of a failed row
  failedRow(f, "failed-claude-2", "claude", "second");
  const second = f.daemon.bus.queueShow("failed-claude-2")!;
  const completed = await f.person.request({ t: "queue", op: "resolve", id: second.id, revision: second.revision, action: "completed", reason: "x" });
  expect(completed.ok).toBe(false); expect(completed.error).toMatch(/^peer busy:/);
});

test("queue list hides rows a resolution already settled, counts them, and --all shows them (#1096)", async () => {
  const f = await rig();
  failedRow(f, "failed-open", "codex", "still open");
  failedRow(f, "failed-discarded", "codex", "to be discarded");
  const row = f.daemon.bus.queueShow("failed-discarded")!;
  expect((await f.person.request({ t: "queue", op: "resolve", id: row.id, revision: row.revision, action: "discard", reason: "settled" })).ok).toBe(true);
  const shown = await deliveries(f, "codex");
  expect(shown.deliveries.map(r => r.id)).toEqual(["failed-open"]);
  expect(shown.hiddenSettled).toBe(1);
  const all = await deliveries(f, "codex", true);
  expect(all.deliveries.map(r => r.id).sort()).toEqual(["failed-discarded", "failed-open"]);
  expect(all.hiddenSettled).toBeUndefined();
  // through the CLI: the table has the open row only, the count and the way to see the rest are on stderr, and --all prints both
  const plain = await cli(f.root, ["queue", "list", "--peer", "codex"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).toContain("failed-open"); expect(plain.stdout).not.toContain("failed-discarded");
  expect(plain.stderr).toContain("1 settled delivery hidden (already resolved); ahub queue list --all shows them");
  const everything = await cli(f.root, ["queue", "list", "--peer", "codex", "--all"]);
  expect(everything.stdout).toContain("failed-open"); expect(everything.stdout).toContain("failed-discarded");
  expect(everything.stderr).not.toContain("hidden");
  // an unresolved queued or needs_review row is never hidden
  f.daemon.bus.publish(newEnvelope("user", "still queued", { to: ["codex"] }));
  expect((await deliveries(f, "codex")).deliveries.some(r => r.state === "queued")).toBe(true);
  // a bad flag value is refused with the allowed values
  expect((await f.person.request({ t: "queue", op: "list", peer: "codex", all: "yes" })).error).toBe("all is true or false");
});

test("an agent shell may read queue list --all, and the help rows match the parser (#1096)", () => {
  expect(classifyPeerCommand("queue", ["list", "--all"])).toBe("allowed");
  expect(classifyPeerCommand("queue", ["list", "--all", "--peer", "codex", "--json"])).toBe("allowed");
  expect(classifyPeerCommand("queue", ["discard", "--peer", "codex", "--yes"])).toBe("conductor"); // the bulk clear is still the person's or the conductor's
  const list = HELP.find(entry => entry.usage.startsWith("ahub queue list"))!, discard = HELP.find(entry => entry.usage.startsWith("ahub queue discard"))!;
  expect(list.usage).toContain("[--all]"); expect(list.description).toContain("--all shows them");
  expect(discard.usage).toContain("[--state queued|needs_review|failed]"); expect(discard.description).toContain("unsettled failed");
});

// A hub from before `queue_discard_states` ignores `states` and defaults an absent `state` to queued, so a CLI that sent the new form to it would discard queued rows when the person asked for failed ones.
function oldHub(features: string[]) {
  const made = mkdtempSync(join(tmpdir(), "ahub-old-hub-"));
  cleanup.push(() => rmSync(made, { recursive: true, force: true })); // registered before anything that can throw
  const root = realPath(made), stateDir = join(root, ".agenthub/state"); // realPath, never realpathSync (AGENTS.md "Real paths")
  mkdirSync(stateDir, { recursive: true });
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, owner) { if (request.headers.has("origin")) return new Response("forbidden", { status: 403 }); return owner.upgrade(request) ? undefined : new Response("not websocket"); },
    websocket: { message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") return void ws.send(JSON.stringify({ rid: message.rid, t: "welcome", projectId: "project", instanceId: "instance", cwd: root, protocol: message.v, features }));
      requests.push(message);
      // what an old hub answers: it reads `state` (default queued) and ignores `states`
      ws.send(JSON.stringify({ rid: message.rid, ok: true, t: message.t, peer: message.peer, state: message.state ?? "queued", count: 3, discarded: message.confirmed ? 3 : 0, refused: 0 }));
    } } });
  writeFileSync(join(stateDir, "control-token"), "fixture-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, cwd: root, projectId: "project", instanceId: "instance", protocol: PROTOCOL, protocolMin: PROTOCOL_MIN, protocolMax: PROTOCOL, features }));
  cleanup.push(() => { server.stop(true); });
  return { root, requests };
}

test("against a hub without queue_discard_states the CLI never sends the new wire form, names the cause and the next step, and the legacy single state still works (#1096)", async () => {
  const old = oldHub(["schema_guard"]);
  const bulk = (...extra: string[]) => cli(old.root, ["queue", "discard", "--peer", "codex", "--reason", "x", "--yes", ...extra]);
  // the default (queued and failed) and --state failed both need the new form: refused before anything is sent
  for (const extra of [[], ["--state", "failed"]]) {
    const refused = await bulk(...extra);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("the running hub predates failed-row discard and would discard queued rows instead");
    expect(refused.stderr).toContain("nothing was sent");
    expect(refused.stderr).toContain("Upgrade and restart it first, or run ahub queue discard --peer codex --state queued");
  }
  expect(old.requests.filter(r => r.op === "discard")).toEqual([]);
  // a single legacy kind goes in the `state` field that every hub reads, with no `states`
  for (const kind of ["queued", "needs_review"]) {
    const ok = await bulk("--state", kind);
    expect(ok.code, ok.stderr).toBe(0);
    const sent = old.requests.filter(r => r.op === "discard").at(-1)!;
    expect(sent.state).toBe(kind); expect(sent.states).toBeUndefined();
  }
  // a hub that has the feature gets the list form for the default
  const current = oldHub(["schema_guard", "queue_discard_states"]);
  const ok = await cli(current.root, ["queue", "discard", "--peer", "codex", "--reason", "x", "--yes"]);
  expect(ok.code, ok.stderr).toBe(0);
  expect(current.requests.find(r => r.op === "discard")).toMatchObject({ states: ["queued", "failed"] });
});

test("the daemon advertises queue_discard_states, and the console's D command counts what the CLI will clear (#1096)", async () => {
  const f = await rig();
  expect(f.person.features).toContain("queue_discard_states");
  const typed = (features: readonly string[] | undefined, input: string) => {
    const s = initialConsoleState();
    if (features) s.features = features;
    s.queue = [{ id: "q1", peer: "codex", state: "queued", revision: 1 }, { id: "q2", peer: "codex", state: "failed", revision: 1 }, { id: "q3", peer: "codex", state: "failed", revision: 1 }, { id: "q4", peer: "kimi", state: "failed", revision: 1 }] as never;
    s.input = input; s.editing = true;
    return reduceConsole(s, "\r", 1).state.confirm as { type: string; args: string[]; prompt: string };
  };
  const base = "queue discard --peer codex --reason cleaning up";
  // a hub that has the feature: the default clears queued and failed rows, the command leaves --state off, and the count names both kinds
  const current = typed(["queue_discard_states"], base);
  expect(current.args).toEqual(["queue", "discard", "--peer", "codex", "--reason", "cleaning up", "--yes"]);
  expect(current.prompt).toContain("discard all 1 queued and 2 failed deliveries of codex");
  // a hub that predates it: the command names queued, so the old hub clears exactly what the count shows
  const old = typed(["schema_guard"], base);
  expect(old.args).toEqual(["queue", "discard", "--peer", "codex", "--state", "queued", "--reason", "cleaning up", "--yes"]);
  expect(old.prompt).toContain("discard all 1 queued delivery of codex");
  // an explicit kind is kept as typed, and its count follows it
  const failed = typed(["queue_discard_states"], `${base} --state failed`);
  expect(failed.args).toEqual(["queue", "discard", "--peer", "codex", "--state", "failed", "--reason", "cleaning up", "--yes"]);
  expect(failed.prompt).toContain("discard all 2 failed deliveries of codex");
  // features not yet known: the command is unchanged from before
  expect(typed(undefined, base).args).toEqual(["queue", "discard", "--peer", "codex", "--reason", "cleaning up", "--yes"]);
});
