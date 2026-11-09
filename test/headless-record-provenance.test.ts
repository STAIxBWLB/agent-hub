import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@staix/agent-mem";
import { GeneratedNoteRegistry, GENERATED_NOTE_LIMITS, generatedRecordAnchors, type GeneratedNoteProof } from "../src/memory/record-provenance.ts";
import { Board, type Task } from "../src/hub/board.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const id = (value: number) => value.toString(16).padStart(32, "0");
test("registry accepts full ids only, normalizes prefix and clones both input and returned metadata", () => {
  const registry = new GeneratedNoteRegistry(), anchors = ["src/run.ts#run"];
  registry.record({ id: id(1), anchors }); anchors[0] = "changed.ts";
  expect(registry.get(`mem:${id(1)}`)).toEqual({ id: `mem:${id(1)}`, anchors: ["src/run.ts#run"] });
  const copy = registry.get(id(1))!; (copy.anchors as string[]).push("injected.ts");
  expect(registry.get(id(1))!.anchors).toEqual(["src/run.ts#run"]);
  for (const invalid of [id(1).slice(0, 12), `mem:${id(1).slice(0, 12)}`, `${id(1)}suffix`, "A".repeat(32)]) expect(registry.get(invalid)).toBeUndefined();
  registry.clear(); expect(registry.get(id(1))).toBeUndefined();
});
test("source nodes map to exact raw anchors through the package grammar, with unknown or incomplete mappings unavailable", () => {
  expect(generatedRecordAnchors(["task:project#1", "issue:owner/repo#2", "path:src/run.ts", "symbol:run@src/run.ts"])).toEqual(["src/run.ts", "src/run.ts#run"]);
  for (const nodes of [[], ["task:project#1"], ["symbol:unbound"], ["symbol:run@"], ["symbol:run@ambiguous@src/run.ts"], ["path:../outside.ts"],
    ["path:/absolute.ts"], ["path:src/literal#part.ts"], ["path:src/literal,part.ts"], ["path:src/literal|part.ts"], ["symbol:run@src/literal#part.ts"], ["path:src/run.ts", "unknown:body"], ["path:bad,split"], Array.from({ length: 65 }, (_, n) => `path:src/${n}.ts`)]) expect(generatedRecordAnchors(nodes)).toBeUndefined();
});
test("oversized, duplicate, accessor or invalid metadata is declined whole and invalidation cannot retain an old proof", () => {
  const registry = new GeneratedNoteRegistry(); let reads = 0;
  const invalid: unknown[] = [[], ["src/run.ts", "src/run.ts"], ["src/run.ts", "../bad"], ["x".repeat(513)], ["한".repeat(180)],
    Array.from({ length: 65 }, (_, i) => `src/${i}.ts`), Object.defineProperty(["src/run.ts"], "0", { get() { reads++; throw Error("accessor"); } })];
  for (const anchors of invalid) {
    registry.record({ id: id(1), anchors: ["src/run.ts"] });
    registry.record({ id: id(1), anchors } as GeneratedNoteProof);
    expect(registry.get(id(1))).toBeUndefined();
  }
  registry.record(new Proxy({ id: id(2), anchors: ["src/run.ts"] }, { get() { reads++; throw Error("proxy"); } }));
  expect(reads).toBe(0); expect(registry.get(id(2))).toBeUndefined();
});
test("matching is a bounded exact-anchor shortlist, never prefix, basename or unanchored equivalence", () => {
  const registry = new GeneratedNoteRegistry();
  for (let n = 1; n <= 40; n++) registry.record({ id: id(n), anchors: ["src/run.ts#run", `src/${n}.ts`] });
  expect(registry.matching(["src/run.ts#run", "src/run.ts#run"])).toHaveLength(32);
  expect(registry.matching(["src/run.ts#run"], 2).map(proof => proof.id)).toEqual([`mem:${id(40)}`, `mem:${id(39)}`]);
  for (const anchors of [[], ["run.ts#run"], ["src/run.ts"], ["src/run.ts#ru"], ["../src/run.ts#run"]]) expect(registry.matching(anchors)).toEqual([]);
  expect(registry.matching(["src/run.ts#run"], 33)).toEqual([]);
});
test("fixed bounded LRU evicts only old proof and restart/clear falls back to no proof", () => {
  const registry = new GeneratedNoteRegistry();
  for (let n = 1; n <= GENERATED_NOTE_LIMITS.notes; n++) registry.record({ id: id(n), anchors: ["src/run.ts"] });
  expect(registry.get(id(1))).toBeDefined(); registry.record({ id: id(GENERATED_NOTE_LIMITS.notes + 1), anchors: ["src/new.ts"] });
  expect(registry.get(id(2))).toBeUndefined(); expect(registry.get(id(1))).toBeDefined();
  expect(new GeneratedNoteRegistry().get(id(1))).toBeUndefined(); registry.clear(); expect(registry.matching(["src/run.ts"])).toEqual([]);
});

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
async function fixture(privateTurn: (() => boolean) | null = () => false, observer?: (proof: GeneratedNoteProof) => void, onNote?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "ahub-generated-note-")), cwd = join(root, "project"); mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, "src/run.ts"), "export const run = 1;\n");
  const board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 }), store = new MemoryStore({ home: join(root, "home"), deferPromotions: true });
  cleanup.push(() => { bus.closeJournal(); board.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const id of ["codex", "claude"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const proofs: GeneratedNoteProof[] = [];
  const tasks = new Tasks({ board, bus, cwd, project: "synthetic-project", repository: "owner/project", routing: () => loadRouting(cwd), notify: () => {},
    roles: { claude: ["planner", "reviewer"], codex: ["implementer"] }, privateTurn: privateTurn ? () => privateTurn() : undefined,
    piiScreen: async () => ({ label: "clear", ms: 0 }), store: { store, project: "synthetic-project", repo: "owner/project", onNote,
      onGeneratedNote: proof => { proofs.push(proof); observer?.(proof); } } });
  // This calls the actual production method on real Board/MemoryStore owners; no note/parser implementation is mirrored.
  const note = (task: Task, text = "synthetic generated finding", withheld = false) =>
    (tasks as unknown as { note(task: Task, by: string, kind: "finding", text: string, withheld: boolean): void }).note(task, "codex", "finding", text, withheld);
  return { root, cwd, board, tasks, store, proofs, note };
}
test("public done emits proof only for a successfully saved generated note, with no body in the callback", async () => {
  const f = await fixture(), task = await f.tasks.propose("claude", { title: "synthetic change", class: "implement", owner: "codex", refs: { repo: "owner/project", paths: ["src/run.ts"] } });
  await f.tasks.done("codex", task.id, "synthetic completion");
  expect(f.proofs).toHaveLength(1); expect(f.proofs[0]!.anchors).toContain("src/run.ts"); expect(Object.keys(f.proofs[0]!).sort()).toEqual(["anchors", "id"]);
  expect(f.store.get(f.proofs[0]!.id)).toBeDefined(); expect(f.board.get(task.id)!.history.some(entry => entry.event === "done")).toBe(true);
});
test("manual remember is not generated-note provenance", async () => {
  const f = await fixture();
  const result = await f.tasks.rememberOutcome(USER, { kind: "finding", text: "synthetic manual note", horizon: "short" });
  expect(result.outcome).toBe("saved"); expect(f.store.list()).toHaveLength(1); expect(f.proofs).toEqual([]);
});
test("withheld/PII/failed notes never emit proof; private or unknown current context cannot emit it either", async () => {
  const f = await fixture(), task = f.board.propose(USER, { title: "synthetic note", class: "implement", refs: { paths: ["src/run.ts"] } });
  f.note(task, "synthetic withheld", true); f.note({ ...task, signals: ["pii"] }); expect(f.store.list()).toEqual([]); expect(f.proofs).toEqual([]);
  const original = f.store.note; f.store.note = () => { throw Error("synthetic storage failure"); };
  try { f.note(task); } finally { f.store.note = original; }
  expect(f.proofs).toEqual([]);
  for (const check of [null, () => true, () => { throw Error("unknown privacy"); }]) {
    const privateFixture = await fixture(check), t = privateFixture.board.propose(USER, { title: "synthetic note", class: "implement", refs: { paths: ["src/run.ts"] } });
    privateFixture.note(t); expect(privateFixture.proofs).toEqual([]);
  }
});
test("foreign repositories get no same-path proof; observer errors cannot undo saved notes or done", async () => {
  const f = await fixture(), foreign = f.board.propose(USER, { title: "foreign", class: "implement", refs: { repo: "other/project", paths: ["src/run.ts"] } });
  f.note(foreign); expect(f.store.list()).toHaveLength(1); expect(f.proofs).toEqual([]);
  const observed = await fixture(() => false, () => { throw Error("generated observer failed"); }, () => { throw Error("legacy observer failed"); });
  const task = await observed.tasks.propose("claude", { title: "synthetic completion", class: "implement", owner: "codex", refs: { paths: ["src/run.ts"] } });
  await observed.tasks.done("codex", task.id, "synthetic completion"); expect(observed.proofs).toHaveLength(1);
  expect(observed.store.get(observed.proofs[0]!.id)).toBeDefined(); expect(observed.board.get(task.id)!.history.some(entry => entry.event === "done")).toBe(true);
});
