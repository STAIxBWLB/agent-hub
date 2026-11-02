import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function rig(limit = 2) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-urgent-wip-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => { bus.closeJournal(); board.close(); });
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: line => { notices.push(line); }, wipLimit: () => limit, sdlc: { config: () => sdlcConfig({ mode: "off" }) } });
  const running = (title: string) => { const row = board.propose("user", { title, class: "implement" }); return board.update(row.id, "user", "accepted", { owner: "codex", state: "in_progress" }); };
  const offered = (title: string, urgent = false) => {
    const row = board.propose("user", { title, class: "implement" });
    return board.update(row.id, "user", "assigned", { owner: "codex", ...(urgent ? { signals: [...row.signals, "urgent"] } : {}) });
  };
  return { board, tasks, notices, running, offered };
}

test("an urgent accept at the limit takes back the newest unaccepted offer and tells the planner (#1080 AC1)", () => {
  const { board, tasks, notices, running, offered } = rig(2);
  const active = running("accepted work");
  const older = offered("older offer");
  const urgent = offered("urgent work", true);
  expect(() => tasks.accept("codex", urgent.id)).not.toThrow(); // limit 2: the active task plus this one, once the offer is taken back
  expect(board.get(urgent.id)).toMatchObject({ state: "in_progress", owner: "codex" });
  expect(board.get(active.id)).toMatchObject({ state: "in_progress", owner: "codex" });
  expect(board.get(older.id)).toMatchObject({ state: "proposed", owner: null });
  expect(board.get(older.id)!.history.at(-1)).toMatchObject({ event: "unassigned", by: "hub" });
  expect(board.get(older.id)!.history.at(-1)!.note).toContain(`urgent task #${urgent.id}`);
  expect(notices.join("\n")).toContain(`Task #${older.id} was taken back from codex`);
});

test("only as many offers as needed are taken back, newest first (#1080)", () => {
  const { board, tasks, running, offered } = rig(3);
  running("accepted one");
  const older = offered("older offer");
  const newer = offered("newer offer");
  const urgent = offered("urgent work", true);
  // limit 3: one accepted plus two offers fills it, so the urgent accept needs exactly one slot and takes the newest offer only
  tasks.accept("codex", urgent.id);
  expect(board.get(urgent.id)!.state).toBe("in_progress");
  expect(board.get(newer.id)!.owner).toBeNull();
  expect(board.get(older.id)!.owner).toBe("codex");
});

test("a non-urgent accept at the limit is still refused and the refusal separates accepted from offered tasks (#1080 AC2)", () => {
  const { board, tasks, running, offered } = rig(2);
  const active = running("accepted work");
  const offer = offered("offered, not accepted");
  const plain = offered("plain work");
  const before = JSON.stringify(board.get(plain.id));
  let failure: unknown;
  try { tasks.accept("codex", plain.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  const text = (failure as Error).message;
  expect(text).toContain("limit 2");
  expect(text).toContain(`accepted #${active.id}`);
  expect(text).toContain(`offered, not yet accepted #${offer.id}`);
  expect(text).toContain("decline an offered task");
  expect(JSON.stringify(board.get(plain.id))).toBe(before);
  expect(board.get(offer.id)).toMatchObject({ owner: "codex" });
});

test("an urgent accept never takes back another urgent offer (#1080)", () => {
  const { board, tasks, running, offered } = rig(2);
  const active = running("accepted one");
  const otherUrgent = offered("other urgent offer", true);
  const urgent = offered("urgent work", true);
  // limit 2: the only offer in the way is itself urgent, so the only way to make room is refused
  let failure: unknown;
  try { tasks.accept("codex", urgent.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain(`accepted #${active.id}`);
  expect((failure as Error).message).toContain(`offered, not yet accepted #${otherUrgent.id}`);
  expect(board.get(otherUrgent.id)!.owner).toBe("codex");
  expect(board.get(urgent.id)!.state).toBe("proposed");
});

test("an urgent accept never takes back a person-pinned offer (#1080)", () => {
  const { board, tasks, running, offered } = rig(2);
  running("accepted one");
  const pinned = offered("pinned offer");
  board.plan(pinned.id, "user", { pinned: true }, 0, "person pinned it");
  expect(board.get(pinned.id)!.pinned).toBe(true);
  const urgent = offered("urgent work", true);
  expect(() => tasks.accept("codex", urgent.id)).toThrow(PreEffectToolRefusal);
  expect(board.get(pinned.id)!.owner).toBe("codex");
  expect(board.get(urgent.id)!.state).toBe("proposed");
});

test("displacing a planner-pulled offer releases its counted reservation, so the owner ends within its limit (#1080)", () => {
  const { board, tasks, notices, running, offered } = rig(2);
  const active = running("accepted one");
  const card = board.propose("user", { title: "pulled offer", class: "implement", backlog: true });
  board.pullAssigned(card.id, "claude", "codex", 0, "planner pull", false, null, "to codex", {}, board.get(card.id)!.history.length);
  expect(board.get(card.id)).toMatchObject({ owner: "codex", reserved: "codex", state: "proposed" });
  const urgent = offered("urgent work", true);
  expect(board.plannerWip("codex")).toBe(3); // active + pulled offer + urgent offer: over the limit of 2
  tasks.accept("codex", urgent.id);
  expect(board.get(urgent.id)).toMatchObject({ state: "in_progress", owner: "codex" });
  expect(board.get(card.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  expect(board.plannerWip("codex")).toBe(2); // the accepted task and the urgent one, never 3
  expect(board.get(active.id)!.owner).toBe("codex");
  expect(notices.join("\n")).toContain("(priority 0 or marked urgent)");
  expect(notices.join("\n")).not.toContain("person-prioritized");
});

test("an urgent accept never takes back accepted work (#1080)", () => {
  const { board, tasks, running, offered } = rig(1);
  const active = running("accepted one");
  const urgent = offered("urgent work", true);
  expect(() => tasks.accept("codex", urgent.id)).toThrow(PreEffectToolRefusal);
  expect(board.get(active.id)).toMatchObject({ owner: "codex", state: "in_progress" });
});

test("a refused urgent accept changes nothing, not even an offer it could have taken (#1080)", () => {
  const { board, tasks, running, offered } = rig(1);
  running("accepted one");
  const offer = offered("an offer");
  const urgent = offered("urgent work", true);
  // limit 1 with an accepted task: taking back the offer would still leave the owner over the limit
  const snapshot = JSON.stringify([board.get(offer.id), board.get(urgent.id)]);
  expect(() => tasks.accept("codex", urgent.id)).toThrow(PreEffectToolRefusal);
  expect(JSON.stringify([board.get(offer.id), board.get(urgent.id)])).toBe(snapshot);
});
