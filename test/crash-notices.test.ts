import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { openCrashNotices, writeSessions, type CrashNotice } from "../src/hub/crash.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

// #1082: a crash-recovery notice stays in `ahub status` only while its condition holds. A line about a peer goes when that peer is attached again; the in-flight headline counts the crash's own
// deliveries that are still in needs_review, read when status is asked, so it matches `ahub queue list` and clears when the operator has resolved them. What recovery found or did stays as history.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (ok: () => boolean | Promise<boolean>, what: string) => { for (let i = 0; i < 400 && !(await ok()); i++) await Bun.sleep(10); if (!(await ok())) throw new Error(`timed out waiting for ${what}`); };

const HEADLINE = "the previous hub run stopped without shutting down";
const CODEX = "codex: its app-server died with the hub; run ahub codex again (its conversation was thread th-42)";
const CLAUDE = "claude: the Claude Code plugin reconnects by itself while that session is still open";

/** A peer the hub holds: attached means its state is anything but offline, which is what an adapter does when its client connects or its process starts. */
class AttachedPeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

/** A hub that finds a crashed run: its session record names codex and claude, and `inFlight` deliveries to claude were mid-delivery when it died. */
async function crashedHub(inFlight = 2) {
  const made = mkdtempSync(join(tmpdir(), "agenthub-crash-notices-")); cleanup.push(() => rmSync(made, { recursive: true, force: true })); // registered before anything that can throw
  const stateDir = realPath(made), projectId = "crash-notices";
  // the dead run's journal: deliveries it had dispatched to claude and never settled. Opening the journal marks them needs_review, as a real crash recovery does.
  const dead = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: stateDir, projectId, instanceId: "dead" });
  for (let i = 0; i < inFlight; i++) { const env = newEnvelope("user", `in flight ${i}`, { to: ["claude"] }); dead.createDelivery({ id: `lost-${i}`, peer: "claude", state: "dispatching", createdAt: env.ts, originals: [env], out: [env] }); }
  dead.close();
  writeSessions(stateDir, { instanceId: "dead", at: Date.now(), peers: [{ peer: "codex", meta: { threadId: "th-42" } }, { peer: "claude", meta: {} }] });
  const daemon = await startDaemon({ cwd: stateDir, projectId, instanceId: "after-crash", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const crash = async () => ((await person.request({ t: "status" })).status.crash ?? []) as string[];
  const queue = async (peer: string) => ((await person.request({ t: "queue", op: "list", peer })).deliveries ?? []) as { id: string; state: string; revision: number }[];
  const attach = async (peer: string) => { const attached = new AttachedPeer(peer); daemon.bus.add(attached); await attached.start(); expect(daemon.bus.stateOf(peer)).toBe("idle"); return attached; };
  return { daemon, person, stateDir, crash, queue, attach };
}

test("right after a crash the report holds the headline with its count, the codex action and the claude reconnect note, exactly as before (#1082)", async () => {
  const h = await crashedHub(2);
  await until(async () => (await h.crash()).length >= 3, "the crash report");
  expect(await h.crash()).toEqual([`${HEADLINE}; 2 deliveries it had in flight are in needs_review (ahub queue list)`, CODEX, CLAUDE]);
});

test("a notice about a peer clears once that peer is attached again, and the others stay (#1082 AC1)", async () => {
  const h = await crashedHub(0);
  await until(async () => (await h.crash()).length >= 3, "the crash report");
  expect(await h.crash()).toContain(CLAUDE);
  await h.attach("claude");
  const after = await h.crash();
  expect(after).not.toContain(CLAUDE);                  // claude is back: its line is gone
  expect(after).toContain(CODEX);                       // codex is not: its line still asks for `ahub codex`
  expect(after).toContain(HEADLINE);                    // the headline stands as the record that a crash was found
  // codex coming back clears its line too, and then only the headline is left
  await h.attach("codex");
  expect(await h.crash()).toEqual([HEADLINE]);
});

test("the in-flight count is read live and matches `ahub queue list`: it falls as each row is resolved and the clause is gone at zero (#1082 AC2)", async () => {
  const h = await crashedHub(3);
  await until(async () => (await h.crash()).length >= 3, "the crash report");
  const count = async () => (await h.queue("claude")).filter(row => row.state === "needs_review").length;
  expect(await count()).toBe(3);
  expect((await h.crash())[0]).toBe(`${HEADLINE}; 3 deliveries it had in flight are in needs_review (ahub queue list)`);
  for (const [done, expected] of [[1, 2], [2, 1]] as const) {
    const row = (await h.queue("claude")).find(r => r.state === "needs_review")!;
    expect((await h.person.request({ t: "queue", op: "resolve", id: row.id, revision: row.revision, action: "completed", reason: "checked by hand" })).ok, `resolve ${done}`).toBe(true);
    expect(await count()).toBe(expected);
    expect((await h.crash())[0], `after ${done} resolved`).toBe(`${HEADLINE}; ${expected} deliveries it had in flight are in needs_review (ahub queue list)`);
  }
  const last = (await h.queue("claude")).find(r => r.state === "needs_review")!;
  expect((await h.person.request({ t: "queue", op: "resolve", id: last.id, revision: last.revision, action: "discard", reason: "not needed" })).ok).toBe(true);
  expect(await count()).toBe(0);
  expect((await h.crash())[0]).toBe(HEADLINE);          // nothing in flight any more: no count, no queue pointer
  expect((await h.crash()).join("\n")).not.toContain("in needs_review");
});

test("a needs_review row that is not from the crash is never counted in its headline (#1082 AC2)", async () => {
  const h = await crashedHub(1);
  await until(async () => (await h.crash()).length >= 3, "the crash report");
  // a row that becomes needs_review later in this run (not a crash casualty) shows in the queue list, and not in the crash line
  const env = newEnvelope("user", "later", { to: ["claude"] });
  const journal = (h.daemon.bus as unknown as { journal: DeliveryJournal }).journal;
  journal.createDelivery({ id: "later-1", peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env], reason: "an operator held it" });
  expect((await h.queue("claude")).filter(row => row.state === "needs_review")).toHaveLength(2);
  expect((await h.crash())[0]).toBe(`${HEADLINE}; 1 deliveries it had in flight are in needs_review (ahub queue list)`);
});

test("openCrashNotices: a peer line goes when its peer is attached, history stays, the headline count is exactly what is passed (#1082)", () => {
  const notices: CrashNotice[] = [
    { text: HEADLINE, inFlight: true },
    { text: CODEX, peer: "codex" },
    { text: "kimi resumed: kimi: session s1 can be loaded again (ACP session/load)" },
    { text: "pi not resumed (gone); pi: its session file can be resumed", peer: "pi" },
  ];
  const show = (attached: string[], inFlight: number) => openCrashNotices(notices, { attached: new Set(attached), inFlight });
  expect(show([], 7)).toEqual([`${HEADLINE}; 7 deliveries it had in flight are in needs_review (ahub queue list)`, CODEX, notices[2]!.text, notices[3]!.text]);
  expect(show(["codex"], 7)).not.toContain(CODEX);
  expect(show(["codex", "pi"], 0)).toEqual([HEADLINE, notices[2]!.text]);              // history stays, the count clause is gone at zero
  expect(show(["kimi"], 0)).toContain(notices[2]!.text);                                // an attached peer does not erase a line that is history, not an action
  expect(show([], 0)[0]).toBe(HEADLINE);
});

test("the Jcode headless hint still follows a crash report even after every notice cleared (#1085 and #1082)", async () => {
  // the hint reads whether a crash was reported this run, not whether a line is still showing
  const h = await crashedHub(0);
  await until(async () => (await h.crash()).length >= 3, "the crash report");
  await h.attach("claude"); await h.attach("codex");
  expect(await h.crash()).toEqual([HEADLINE]);
  const source = await Bun.file(join(import.meta.dir, "../src/hub/daemon.ts")).text();
  expect(source).toContain("afterCrash: crashReported");
  expect(source).not.toContain("afterCrash: crashNotices.length");
});

test("a Pi whose resume failed and whose fresh start worked leaves history only, but one that never comes back keeps its action line until it attaches (#1082)", async () => {
  const history = (await Bun.file(join(import.meta.dir, "../src/hub/daemon.ts")).text());
  const branch = history.slice(history.indexOf("if (!declarations[step.peer] && definitionOf(step.peer)?.session.restoreOnStart && piAutoStart()) {"), history.indexOf("if (!step.resume || !autoResume()) {"));
  // the lines about what happened carry no peer; each way Pi stays down carries it, and the success line is history
  expect(branch).toContain("report(`pi not resumed (${String(r.error)}); ${step.how}`);");
  expect(branch).toContain("} else report(step.how);");
  expect(branch).toContain('or set peers.pi.start_mode to headless", { peer: step.peer }); continue; }');
  expect(branch).toContain("fresh.ok ? {} : { peer: step.peer }");
  // the pure rule those two tags rely on: an action line follows its peer, a history line does not
  const notices: CrashNotice[] = [{ text: "pi not resumed (gone); pi: its session file can be resumed" }, { text: "pi.auto_start could not start Pi either (boom)", peer: "pi" }];
  expect(openCrashNotices(notices, { attached: new Set(["pi"]), inFlight: 0 })).toEqual([notices[0]!.text]);
  expect(openCrashNotices(notices, { attached: new Set(), inFlight: 0 })).toEqual([notices[0]!.text, notices[1]!.text]);
});
