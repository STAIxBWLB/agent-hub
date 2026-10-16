import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type Kind, type NoteInput } from "@staix/agent-mem";
import { planGuardNodes, matchingPlanFails } from "../src/hub/memory-plan-guard.ts";
import { Briefs, type BriefTask, type NativeItem } from "../src/memory/brief.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { type Envelope, type PeerId, USER } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "ahub-plan-guard-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const context = { cwd: "/fixture", project: "fixture", repo: "o/r" };
const fake = (kind: Kind, about: string[], supersededBy: string | null = null) => ({ kind, about, supersededBy });
const item = (id: string, kind = "fail"): NativeItem => ({ id: `mem:${id}`, kind, line: `mem:${id} ${kind} long: ${id} advice` });

test("plan guard matches whole path scope, refs and exact qualified symbols without promoting unrelated fails", () => {
  const task: BriefTask = { title: "ordinary title", refs: { paths: ["src/shared.ts"] }, plan: { paths: ["src/parser"], symbols: ["parse@src/codec.ts"] } };
  const refs = fake("fail", ["path:src/shared.ts"]), directory = fake("fail", ["path:src/parser/nested/file.ts"]), symbol = fake("fail", ["symbol:parse@src/codec.ts"]);
  const wrongPath = fake("fail", ["path:src/parser-other/file.ts"]), wrongSymbol = fake("fail", ["symbol:other@src/codec.ts"]), wrongFile = fake("fail", ["symbol:parse@src/other.ts"]);
  const obsolete = fake("fail", ["path:src/parser/file.ts"], "replaced"), contract = fake("contract", ["path:src/parser/file.ts"]);
  expect(matchingPlanFails(task, [wrongPath, wrongSymbol, symbol, obsolete, refs, wrongFile, contract, directory], context)).toEqual([symbol, refs, directory]);
  expect(planGuardNodes({ title: "src/ignored.ts", refs: {}, plan: { paths: ["../outside.ts", ".maru/secrets/key.ts", "src/allowed.ts"] } }, context)).toEqual(["path:src/allowed.ts"]);
  expect(matchingPlanFails({ title: "src/shared.ts", refs: {} }, [refs], context)).toEqual([]);
});

test("plan guard consumes only live store fails and leaves authored evidence unchanged", () => {
  const dir = temp(), store = new MemoryStore({ home: dir }); cleanup.push(() => store.close());
  const note = (text: string, kind: NoteInput["kind"] = "fail") => store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind, peer: "codex", text, about: ["path:src/a.ts"], source: "person" });
  const live = note("live fail"), old = note("replaced fail"), replacement = note("replacement decision", "decision"), forgotten = note("forgotten fail");
  expect(store.supersede(old, replacement, "user")).toBe(true); store.forget(forgotten, "user");
  const log = join(store.dir, "log", `${store.machine.id}.jsonl`), before = readFileSync(log, "utf8");
  expect(matchingPlanFails({ title: "task", refs: { paths: ["src/a.ts"] } }, store.list({ project: "fixture", kind: "fail", limit: Number.MAX_SAFE_INTEGER }), context).map(row => row.id)).toEqual([live]);
  expect(readFileSync(log, "utf8")).toBe(before);
});

test("matching plan fails head capped owner briefs, dedupe native entries and remain task-specific after earlier exposure", async () => {
  const matching = item("match"), unrelated = item("unrelated"), contract = item("contract", "contract");
  const briefs = new Briefs(undefined, "fixture", 2, () => [contract, unrelated, matching]);
  const task: BriefTask = { id: 1, title: "task", refs: {} };
  const guarded = await briefs.forTask("codex", task, [matching, matching]);
  expect(guarded?.split("\n").slice(1)).toEqual([matching.line, contract.line]);
  expect(guarded).not.toContain(unrelated.line);
  const repeated = await briefs.forTask("codex", { ...task, id: 2 }, [matching]);
  expect(repeated?.split("\n")[1]).toBe(matching.line);
  const ordinary = new Briefs(undefined, "fixture", 2, () => [contract, unrelated]);
  expect((await ordinary.forTask("codex", task))?.split("\n").slice(1)).toEqual([contract.line, unrelated.line]);
});

class FakePeer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
async function rig(planFails: NonNullable<TasksDeps["planFails"]>) {
  const dir = temp(), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }); cleanup.push(() => board.close());
  const peers: Record<string, FakePeer> = {};
  for (const id of ["claude", "codex", "local"]) { const peer = new FakePeer(id); peers[id] = peer; bus.add(peer); await peer.start(); cleanup.push(() => peer.stop()); }
  const briefs = new Briefs(undefined, "fixture", 2, () => [item("ordinary", "decision")]);
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), briefs, planFails, notify: () => {} });
  return { tasks, peers };
}
async function delivered(peers: Record<string, FakePeer>, peer: PeerId, kind: Envelope["kind"]): Promise<Envelope> {
  for (let i = 0; i < 200; i++) { const found = peers[peer]?.got.find(env => env.kind === kind); if (found) return found; await Bun.sleep(1); }
  throw new Error(`fixture ${kind} delivery was not observed`);
}

test("owner task brief and reviewer's first checklist item carry matching fail advice without blocking workflow", async () => {
  const matching = item("matched"), { tasks, peers } = await rig(() => [matching]);
  const task = await tasks.propose(USER, { title: "guarded work", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] }, plan: { paths: ["src/a.ts"] } });
  const owner = await delivered(peers, "codex", "task");
  expect(owner.body.slice(owner.body.indexOf("Memory brief")).split("\n")[1]).toBe(matching.line);
  tasks.accept("codex", task.id, { paths: ["src/a.ts"] });
  expect(tasks.planGuardText(task)).toContain(matching.line);
  expect((await tasks.done("codex", task.id, "implemented"))?.state).toBe("in_review");
  const review = await delivered(peers, "claude", "review"), checklist = review.body.slice(review.body.indexOf("Checklist:"));
  expect(checklist.split("\n")[1]).toContain(matching.line);
  expect(checklist.indexOf(matching.line)).toBeLessThan(checklist.indexOf("Map the changed signatures"));
});

test("PII task delivery and review never invoke plan memory or include its advice", async () => {
  let calls = 0;
  const { tasks, peers } = await rig(() => { calls++; return [item("must-not-leak")]; });
  const task = await tasks.propose(USER, { title: "patient 900101-1234567 follow-up", class: "implement", owner: "local", refs: { paths: ["src/a.ts"] }, plan: { paths: ["src/a.ts"] } });
  const owner = await delivered(peers, "local", "task");
  expect(tasks.isPii(task)).toBe(true); expect(owner.private).toBe(true); expect(owner.body).not.toContain("must-not-leak");
  expect(tasks.planGuardText(task)).toBe("");
  tasks.accept("local", task.id); await tasks.done("local", task.id, "private outcome");
  expect(calls).toBe(0);
  expect(Object.values(peers).flatMap(peer => peer.got).some(env => env.body.includes("must-not-leak"))).toBe(false);
});

test("plan guard retains a late explicit symbol beyond the v1 64-node extraction cap", () => {
  const task: BriefTask = { title: "large valid plan", refs: { paths: Array.from({ length: 50 }, (_, i) => `src/ref-${i}.ts`) }, plan: {
    paths: Array.from({ length: 50 }, (_, i) => `src/plan-${i}.ts`),
    symbols: [...Array.from({ length: 49 }, (_, i) => `earlier-${i}@src/symbol-${i}.ts`), "late@src/late.ts"],
  } };
  const late = fake("fail", ["symbol:late@src/late.ts"]);
  expect(matchingPlanFails(task, [late], context)).toEqual([late]);
  const nodes = planGuardNodes(task, context);
  expect(nodes).toHaveLength(150); expect(new Set(nodes).size).toBe(150); expect(nodes).toEqual([...nodes].sort());
  const qualified = planGuardNodes({ title: "duplicates", refs: { paths: ["./src/a.ts"] }, plan: { paths: ["src/a.ts"], symbols: ["parse", "parse"] } }, context);
  expect(qualified).toEqual(["path:src/a.ts", "symbol:parse@src/a.ts"]);
});
