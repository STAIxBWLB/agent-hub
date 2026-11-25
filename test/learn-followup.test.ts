import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { CHECKLIST_MAX_LINES, checklistLineMarker, overridesDiff, parseRemovalCard, removalCard, removalKey, withoutChecklistLine } from "../src/hub/learning.ts";
import { acceptanceSuffix, outcomeOf, rateIn, readAcceptance, removalDue, weakest, type AcceptanceRecord } from "../src/hub/learn-followup.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { resolveProfile } from "../src/hub/profiles.ts";
import { renderLearnChange, renderLearnList } from "../src/cli/learn-output.ts";

// #1642 T1-T4: an accepted checklist line is followed by outcome, and a line that stopped helping earns ONE removal card a person may accept.
// The counts are the hub's own review records: same profile and class, the criterion named unmet, on both sides of the acceptance.
const DAY = 86_400_000;
const NOW = 20 * DAY;
const KEY = { profile: "dev", class: "implement", criterion: "AC1" };
const LINE = overridesDiff({ ...KEY, tasks: [1, 2, 3] }).profile_overrides.review_checklist[0]!;
type Entry = { at: number; event: string; unmetCriteria?: string[]; withheld?: boolean; evidenceOnly?: boolean };
const verdict = (at: number, unmet: string[] = []): Entry => ({ at, event: "changes_requested", ...(unmet.length ? { unmetCriteria: unmet } : {}) });
/** A board row as the learning counts read it; `never` because only the picked fields are built. */
const learnRow = (id: number, history: Entry[], opts: { profile?: string; cls?: string; profileClass?: string } = {}) => ({
  id, class: opts.cls ?? "implement", profile: opts.profile ?? "dev", ...(opts.profileClass ? { profileClass: opts.profileClass } : {}), history,
}) as never;
const recordOf = (before: { reviewed: number; unmet: number }, acceptedAt = NOW - 5 * DAY): AcceptanceRecord => ({ ...KEY, card: 1, acceptedAt, before });

test("outcomeOf reads the four statuses from the reviews on each side of the acceptance, and a task reviewed twice counts once", () => {
  const status = (before: { reviewed: number; unmet: number }, rows: unknown[]) => outcomeOf(recordOf(before), rows as never, { now: NOW, windowStart: NOW - 5 * DAY });
  // 5 reviewed, 4 naming it unmet: 0.8 against 1.0 before
  const helping = status({ reviewed: 3, unmet: 3 }, [1, 2, 3, 4, 5].map(id => learnRow(id, [verdict(NOW - DAY, id < 5 ? ["AC1"] : [])])));
  expect(helping.since).toEqual({ reviewed: 5, unmet: 4 });
  expect(helping.before).toEqual({ reviewed: 3, unmet: 3 });
  expect(helping.status).toBe("helping");
  // 5 reviewed and all 5 naming it unmet: equal, so no change
  expect(status({ reviewed: 3, unmet: 3 }, [1, 2, 3, 4, 5].map(id => learnRow(id, [verdict(NOW - DAY, ["AC1"])]))).status).toBe("no-change");
  // 2 of 6 is the same rate as 1 of 3: no change; 3 of 6 is higher: worse
  const six = (met: number) => [1, 2, 3, 4, 5, 6].map(id => learnRow(id, [verdict(NOW - DAY, id <= met ? ["AC1"] : [])]));
  expect(status({ reviewed: 3, unmet: 1 }, six(2)).status).toBe("no-change");
  expect(status({ reviewed: 3, unmet: 1 }, six(3)).status).toBe("worse");
  // one task per denominator, however many verdicts it carried in the window
  const twice = status({ reviewed: 1, unmet: 1 }, [learnRow(7, [verdict(NOW - 2 * DAY), verdict(NOW - DAY, ["AC1"])]), learnRow(8, [verdict(NOW - DAY)])]);
  expect(twice.since).toEqual({ reviewed: 2, unmet: 1 });
  // fewer than 5 reviewed since is insufficient, whatever the rate
  expect(status({ reviewed: 3, unmet: 3 }, [1, 2, 3, 4].map(id => learnRow(id, [verdict(NOW - DAY)]))).status).toBe("insufficient");
  // the window is 30 days from its start, so an older verdict is not counted
  expect(status({ reviewed: 3, unmet: 3 }, [1, 2, 3, 4, 5].map(id => learnRow(id, [verdict(NOW - 40 * DAY, ["AC1"])]))).since.reviewed).toBe(0);
});

test("rateIn counts neither a withheld review nor an evidence-only verdict on either side, and refuses no class or profile the task does not hold", () => {
  const rows = [
    learnRow(1, [verdict(NOW - DAY, ["AC1"])]),
    learnRow(2, [{ at: NOW - DAY, event: "approved", withheld: true }]),
    learnRow(3, [{ at: NOW - DAY, event: "changes_requested", evidenceOnly: true }]),
    learnRow(4, [verdict(NOW - DAY, ["AC1"])], { cls: "review" }),
    learnRow(5, [verdict(NOW - DAY, ["AC1"])], { profile: "writing" }),
    learnRow(6, [verdict(NOW - DAY, ["AC1"])], { cls: "implement", profileClass: "review" }),
  ];
  expect(rateIn(rows, KEY, NOW - 5 * DAY, NOW)).toEqual({ reviewed: 1, unmet: 1 });
});

test("removalDue needs 5 reviewed tasks and a criterion that did not get rarer; weakest ranks worse, then no-change, then too few samples, then helping", () => {
  const view = (status: string, reviewed: number) => ({ ...recordOf({ reviewed: 3, unmet: 3 }), since: { reviewed, unmet: 0 }, status });
  expect(removalDue(outcomeOf(recordOf({ reviewed: 3, unmet: 0 }), [1, 2, 3, 4, 5].map(id => learnRow(id, [verdict(NOW - DAY)])) as never, { now: NOW, windowStart: NOW - 5 * DAY }))).toBe(true);
  expect(removalDue(view("no-change", 4) as never)).toBe(false);
  expect(removalDue(view("helping", 9) as never)).toBe(false);
  expect(removalDue(view("worse", 5) as never)).toBe(true);
  const named = [{ criterion: "B", status: "no-change", since: { reviewed: 5, unmet: 0 }, acceptedAt: 1 }, { criterion: "A", status: "worse", since: { reviewed: 5, unmet: 1 }, acceptedAt: 1 }, { criterion: "C", status: "helping", since: { reviewed: 5, unmet: 0 }, acceptedAt: 1 }];
  expect(weakest(named as never)?.criterion).toBe("A");
});

test("the acceptance record is a fixed suffix on the card's own note: read back exactly, and absent on a card accepted before it existed", () => {
  expect(readAcceptance(`candidate accepted by the person: its review checklist line was written to config.local.json${acceptanceSuffix({ unmet: 2, reviewed: 7 })}`)).toEqual({ unmet: 2, reviewed: 7 });
  expect(readAcceptance("candidate accepted by the person: its review checklist line was written to config.local.json")).toBeUndefined();
  expect(readAcceptance(undefined)).toBeUndefined();
  expect(readAcceptance("candidate accepted; before 2/7 in 30 days and more")).toBeUndefined(); // only the end of the note, never inside prose
  expect(acceptanceSuffix({ unmet: 0, reviewed: 0 })).toBe("; before 0/0 in 30 days");
});

test("a removal card is read from its key line only, and a counterfeit or mismatched one is refused with a reason", () => {
  const subject = { ...KEY, acceptedAt: NOW, windowStart: NOW, before: { reviewed: 3, unmet: 3 }, since: { reviewed: 5, unmet: 5 }, status: "no-change" };
  const card = removalCard(subject, 30);
  expect(card.detail.split("\n")[0]).toBe(removalKey(subject));
  expect(card.title).toBe("Review checklist removal for dev/implement criterion AC1");
  const hub = { class: "plan", detail: card.detail, title: card.title, history: [{ by: "hub" }] };
  expect(parseRemovalCard(hub as never)).toEqual({ ...KEY, windowStart: NOW });
  expect(parseRemovalCard({ ...hub, title: "Review checklist removal for dev/review criterion AC1" } as never)).toMatchObject({ refused: expect.stringContaining("title") });
  expect(parseRemovalCard({ ...hub, class: "implement" } as never)).toMatchObject({ refused: expect.stringContaining("hub filed") });
  expect(parseRemovalCard({ ...hub, detail: `x\n${card.detail}` } as never)).toMatchObject({ refused: expect.stringContaining("removal key line first") });
  expect(parseRemovalCard({ ...hub, detail: card.detail.replace(":AC1:", ":AC!1:") } as never)).toMatchObject({ refused: expect.stringContaining("criterion") });
});

test("withoutChecklistLine removes exactly the generated line its marker names, and refuses to guess when none or two match", () => {
  const other = overridesDiff({ ...KEY, criterion: "AC2", tasks: [1, 2, 3] }).profile_overrides.review_checklist[0]!;
  const removed = withoutChecklistLine(["hand written", LINE, other], checklistLineMarker("AC1"));
  expect(removed).toEqual({ list: ["hand written", other], removed: LINE });
  // read as a string, not through toMatchObject: Bun 1.4.4 writes the asymmetric matcher into the received object, so the refusal would read back empty
  const zero = withoutChecklistLine(["hand written"], checklistLineMarker("AC1")) as { refused?: string };
  expect(zero.refused).toContain("nothing was removed");
  // the card id is not knowable in this module, so the pure refusal names no command and no unnamed action; the daemon adds `ahub learn reject <id>` (#1642)
  expect(zero.refused).not.toContain("ahub learn");
  expect(zero.refused).not.toContain("reject the card");
  expect(withoutChecklistLine([LINE, LINE], checklistLineMarker("AC1"))).toMatchObject({ refused: expect.stringContaining("2 checklist lines") });
  // a line whose criterion merely starts the same way is not this line
  expect(withoutChecklistLine([`AC10: confirm this first; it was unmet on 3 implement tasks`], checklistLineMarker("AC1"))).toMatchObject({ refused: expect.stringContaining("no checklist line") });
});

// ---- the board itself: the acceptance record, the outcome view and the one removal card ----
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const criterion = (id: string) => ({ id, required: true, result: "unverified" as const, refs: [] as string[] });
const SHIPPED_DEV = resolveProfile("dev").review_checklist!;

async function rig(checklist: string[] = [...SHIPPED_DEV, LINE]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-learn-followup-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const config = sdlcConfig({ mode: "advise", required_checks: [] }, "0.14.0");
  const tasks = new Tasks({ board, bus, cwd: dir, project: "learn-followup", routing: () => loadRouting(dir), roles: { claude: ["planner", "reviewer"] }, notify: () => {}, piiScreen: async () => ({ label: "clear", ms: 0 }),
    sdlc: { config: () => config }, profileData: { ...resolveProfile("dev"), review_checklist: checklist } } as never);
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const rejected = async (title: string, criteria: string[]) => {
    const task = await tasks.propose("claude", { title, class: "implement", owner: "codex" });
    tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: "a".repeat(40), criteria: ["AC1"].map(criterion) } });
    await tasks.done("codex", task.id, "finished");
    await Bun.sleep(5);
    await tasks.review("claude", task.id, "changes_requested", "gaps", criteria.map(id => `${id}: a gap`));
    board.update(task.id, USER, "cancelled", { state: "cancelled" }, "closed so the owner's WIP slot is free; the verdict stays in history");
    return task.id;
  };
  const reviewed = async (title: string, unmet: string[] = []) => {
    const task = await tasks.propose("claude", { title, class: "implement", owner: "codex" });
    tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: "a".repeat(40), criteria: ["AC1"].map(criterion) } });
    await tasks.done("codex", task.id, "finished");
    await Bun.sleep(5);
    await tasks.review("claude", task.id, "changes_requested", "gaps", unmet.map(id => `${id}: a gap`));
    board.update(task.id, USER, "cancelled", { state: "cancelled" }, "closed so the owner's WIP slot is free; the verdict stays in history");
    return task.id;
  };
  const file = async () => { for (const title of ["first piece", "second piece", "third piece"]) await rejected(title, ["AC1"]); return board.list("backlog").filter(t => t.detail.includes("Criterion candidate key:")); };
  return { dir, board, tasks, rejected, reviewed, file };
}
const refusal = async (call: () => unknown): Promise<string> => { let error: unknown; try { await call(); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(PreEffectToolRefusal); return (error as Error).message; };
const removalCards = (board: Board) => board.list().filter(task => task.class === "plan" && (task.detail ?? "").startsWith("Checklist removal key: "));

test("the acceptance record is read back from the closed card, so a record made at acceptance outranks the counts the board would give now", async () => {
  const r = await rig(), [card] = await r.file();
  await r.tasks.learnClose(USER, card!.id, "accepted", { unmet: 2, reviewed: 7 });
  const followed = r.tasks.learnFollowed(USER, [...SHIPPED_DEV, LINE]);
  expect(followed.checklist).toEqual({ lines: SHIPPED_DEV.length + 1, max: CHECKLIST_MAX_LINES, characters: [...SHIPPED_DEV, LINE].reduce((sum, entry) => sum + entry.length, 0) });
  expect(followed.followed).toMatchObject([{ ...KEY, card: card!.id, before: { unmet: 2, reviewed: 7 }, since: { reviewed: 0, unmet: 0 }, status: "insufficient" }]);
  expect(followed.untracked).toBe(SHIPPED_DEV.length);
  // a card accepted before the record existed still reads: the before rate is recomputed from the board's own history
  const old = await rig(), [c2] = await old.file();
  await old.tasks.learnClose(USER, c2!.id, "accepted");
  expect(old.tasks.learnFollowed(USER, [...SHIPPED_DEV, LINE]).followed[0]!.before).toEqual({ unmet: 3, reviewed: 3 });
  // a hand-written line is untracked, and so is one that was edited past the generated prefix
  expect(old.tasks.learnFollowed(USER, [...SHIPPED_DEV]).followed).toEqual([]);
  expect(old.tasks.learnFollowed(USER, [...SHIPPED_DEV]).untracked).toBe(SHIPPED_DEV.length);
});

test("a no-change line with 5 reviewed tasks earns exactly one removal card, a second review files nothing, and the plan names the line's marker", async () => {
  const r = await rig(), [card] = await r.file();
  await r.tasks.learnClose(USER, card!.id, "accepted", { unmet: 3, reviewed: 3 });
  for (const title of ["fourth piece", "fifth piece", "sixth piece", "seventh piece"]) await r.reviewed(title, ["AC1"]);
  expect(removalCards(r.board)).toEqual([]); // 4 reviewed: not yet
  await r.reviewed("eighth piece", ["AC1"]);
  const cards = removalCards(r.board);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.title).toBe("Review checklist removal for dev/implement criterion AC1");
  expect(cards[0]!.detail).toContain(removalKey({ ...KEY, windowStart: r.board.get(card!.id)!.history.findLast(entry => entry.event === "cancelled")!.at }));
  expect(cards[0]!.detail).toContain("Since then 5 task(s)");
  await r.reviewed("ninth piece", ["AC1"]);
  expect(removalCards(r.board)).toHaveLength(1); // one card per line per window
  const plan = r.tasks.learnAcceptPlan(USER, cards[0]!.id);
  expect(plan).toMatchObject({ ...KEY, marker: checklistLineMarker("AC1") });
  expect(r.tasks.learnFollowed(USER, [...SHIPPED_DEV, LINE]).followed[0]!.removal).toMatchObject({ id: cards[0]!.id, state: "backlog" });
  // the person's removal accept closes the card through the same marker the plan named
  const closed = await r.tasks.learnClose(USER, cards[0]!.id, "accepted");
  expect(closed.state).toBe("cancelled");
  expect(r.tasks.learnAccepted(USER, cards[0]!.id)).toMatchObject({ ...KEY });
  expect(await refusal(() => r.tasks.learnAcceptPlan(USER, cards[0]!.id))).toContain("already closed");
  // nothing was removed from a file: this level composes the decision, the daemon writes the checklist
});

test("rejecting a removal card starts the follow-up window again, so the line is not followed as 'due' until new reviews arrive", async () => {
  const r = await rig(), [card] = await r.file();
  await r.tasks.learnClose(USER, card!.id, "accepted", { unmet: 3, reviewed: 3 });
  for (const title of ["fourth piece", "fifth piece", "sixth piece", "seventh piece", "eighth piece"]) await r.reviewed(title, ["AC1"]);
  const [removal] = removalCards(r.board);
  await r.tasks.learnClose(USER, removal!.id, "rejected");
  const view = r.tasks.learnFollowed(USER, [...SHIPPED_DEV, LINE]).followed[0]!;
  expect(view.status).toBe("insufficient");
  expect(view.removal).toBeUndefined();
  // a new window can file again once it has its own 5 reviewed tasks
  for (const title of ["ninth piece", "tenth piece", "eleventh piece"]) await r.reviewed(title, ["AC1"]);
  expect(removalCards(r.board)).toHaveLength(1);
  await r.reviewed("twelfth piece", ["AC1"]);
  await r.reviewed("thirteenth piece", ["AC1"]);
  expect(removalCards(r.board)).toHaveLength(2);
});

test("a task marked PII, and a withheld or evidence-only verdict, change no count on either side", async () => {
  const r = await rig(), [card] = await r.file();
  await r.tasks.learnClose(USER, card!.id, "accepted", { unmet: 3, reviewed: 3 });
  await r.reviewed("a", ["AC1"]); await r.reviewed("b", ["AC1"]); await r.reviewed("c", ["AC1"]);
  const pii = await r.reviewed("d", ["AC1"]);
  // the hub's own exclusion: a task that turns private stops being evidence, in the numerator and the denominator alike
  const task = r.board.get(pii)!, private_ = { ...task, signals: [...task.signals, "pii_path"] };
  r.board.update(pii, USER, "pii marked", { signals: private_.signals });
  await r.reviewed("e", ["AC1"]);
  const view = r.tasks.learnFollowed(USER, [...SHIPPED_DEV, LINE]).followed[0]!;
  expect(view.since).toEqual({ reviewed: 4, unmet: 4 }); // a,b,c,e; d is excluded from both sides
});

test("the printers show the sample size, the checklist's own size and the untracked count, and a removal accept says what it removed", () => {
  const text = (spans: unknown) => (spans as { text: string }[][]).map(line => line.map(span => span.text).join(" ")).join("\n");
  const shown = text(renderLearnList({ view: "accepted", minReviewed: 5, checklist: { lines: 4, max: 16, characters: 150 }, untracked: 1,
    followed: [{ ...KEY, status: "no-change", since: { reviewed: 5, unmet: 5 }, before: { reviewed: 3, unmet: 3 }, removal: { id: 9, state: "backlog" } }] }, 120));
  expect(shown).toContain("4/16 lines, 150 characters"); expect(shown).toContain("no-change"); expect(shown).toContain("5/5"); expect(shown).toContain("3/3"); expect(shown).toContain("#9"); expect(shown).toContain("1 checklist line(s)");
  expect(shown).toContain("insufficient until 5 reviewed tasks");
  expect(text(renderLearnList({ view: "accepted", checklist: { lines: 3, max: 16, characters: 90 }, untracked: 3, followed: [] }, 120))).toContain("no accepted line is followed");
  const removed = text(renderLearnChange("accept", { card: { id: 9 }, accepted: { kind: "removal", profile: "dev", class: "implement", criterion: "AC1", removed: true, lines: 3, file: ".agenthub/config.local.json", applies: "after a restart (profile contracts are bound at startup)", undo: "ahub settings undo" } }, 120));
  expect(removed).toContain("1 checklist line"); expect(removed).toContain("3 lines in the checklist"); expect(removed).toContain("ahub settings undo");
});

// ---- a real daemon: the removal accept writes the checklist without that one line, and the undo puts the file back ----
function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-learn-followup-daemon-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  return { cwd, shared: join(cwd, ".agenthub/config.json"), local: join(cwd, ".agenthub/config.local.json"), state: join(cwd, ".agenthub/state") };
}
const BASE = { memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { auto_start: false }, research: { enabled: false }, snapshots: { enabled: false } };
const bytes = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const parse = (reply: { ok: boolean; text?: string; error?: string }) => { expect(reply.ok, reply.error).toBe(true); return JSON.parse(reply.text!); };

test("a real daemon: accepting a removal card takes only that line out of config.local.json, the shared file stays byte for byte, and the undo restores the earlier file", async () => {
  const seed = await rig(), [card] = await seed.file();
  await seed.tasks.learnClose(USER, card!.id, "accepted", { unmet: 3, reviewed: 3 });
  for (const title of ["fourth piece", "fifth piece", "sixth piece", "seventh piece", "eighth piece"]) await seed.reviewed(title, ["AC1"]);
  const [removal] = removalCards(seed.board);
  expect(removal).toBeDefined();
  const f = project();
  writeFileSync(f.shared, JSON.stringify(BASE));
  writeFileSync(f.local, JSON.stringify({ profile_overrides: { review_checklist: [...SHIPPED_DEV, LINE] } }));
  const before = bytes(f.local), shared = bytes(f.shared);
  mkdirSync(f.state, { recursive: true });
  const hubDb = join(seed.dir, "hub.db");
  seed.board.close();
  writeFileSync(join(f.state, "hub.db"), readFileSync(hubDb));
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
  cleanup.push(() => person.close());
  const listed = parse(await person.request({ t: "task", op: "learn_list", args: { accepted: true } }));
  expect(listed).toMatchObject({ view: "accepted", checklist: { lines: SHIPPED_DEV.length + 1, max: CHECKLIST_MAX_LINES }, followed: [{ ...KEY, removal: { id: removal!.id } }] });
  const reply = parse(await person.request({ t: "task", op: "learn_accept", args: { id: removal!.id } }));
  expect(reply.accepted).toMatchObject({ kind: "removal", ...KEY, removed: true, lines: SHIPPED_DEV.length, undo: "ahub settings undo" });
  expect(reply.card).toMatchObject({ id: removal!.id, state: "cancelled" });
  expect(JSON.parse(bytes(f.local)!)).toEqual({ profile_overrides: { review_checklist: [...SHIPPED_DEV] } });
  expect(bytes(f.shared)).toBe(shared);
  // the line is no longer followed, and the accepted card is a decided one rather than a new candidate
  expect(parse(await person.request({ t: "task", op: "learn_list", args: { accepted: true } })).followed).toEqual([]);
  const undone = await person.request({ t: "settings_undo" });
  expect(undone.ok, String(undone.error)).toBe(true);
  expect(bytes(f.local)).toBe(before);
  // a repeat of the removal accept writes nothing and says what happened before
  const again = parse(await person.request({ t: "task", op: "learn_accept", args: { id: removal!.id } }));
  expect(again.accepted).toMatchObject({ alreadyAccepted: true, ...KEY });
  expect(bytes(f.local)).toBe(before);
}, 30_000);

test("a real daemon: with no line carrying the marker the removal accept refuses and names ahub learn reject with that card's id", async () => {
  const seed = await rig(), [card] = await seed.file();
  await seed.tasks.learnClose(USER, card!.id, "accepted", { unmet: 3, reviewed: 3 });
  for (const title of ["fourth piece", "fifth piece", "sixth piece", "seventh piece", "eighth piece"]) await seed.reviewed(title, ["AC1"]);
  const [removal] = removalCards(seed.board);
  expect(removal).toBeDefined();
  const f = project();
  writeFileSync(f.shared, JSON.stringify(BASE));
  // the person removed the generated line by hand, so the card names a line the checklist no longer carries
  writeFileSync(f.local, JSON.stringify({ profile_overrides: { review_checklist: [...SHIPPED_DEV] } }));
  const before = bytes(f.local);
  mkdirSync(f.state, { recursive: true });
  const hubDb = join(seed.dir, "hub.db");
  seed.board.close();
  writeFileSync(join(f.state, "hub.db"), readFileSync(hubDb));
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
  cleanup.push(() => person.close());
  const reply = await person.request({ t: "task", op: "learn_accept", args: { id: removal!.id } });
  expect(reply.ok).toBe(false);
  const text = String(reply.error);
  expect(text).toContain("nothing was removed");
  expect(text).toContain(`ahub learn reject ${removal!.id}`);
  expect(text).toContain("ahub learn list --all");
  expect(bytes(f.local)).toBe(before);
  // the card the refusal names is still open, so the command it names really closes it: a second accept refuses the same way rather than closing it
  const again = await person.request({ t: "task", op: "learn_accept", args: { id: removal!.id } });
  expect(again.ok).toBe(false);
  expect(String(again.error)).toContain(`ahub learn reject ${removal!.id}`);
}, 30_000);

