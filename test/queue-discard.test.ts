import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
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

test("queue discard is person only, validated, and refused for an agent identity (#713 acceptance)", async () => {
  const f = await rig();
  expect(classifyPeerCommand("queue", ["discard"])).toBe("console");
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
  expect(HELP.some(entry => entry.usage.startsWith("ahub queue discard --peer <id> --reason <text> [--state queued|needs_review] [--yes]"))).toBe(true);
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
