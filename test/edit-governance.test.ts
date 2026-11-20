import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnEdits, type StampedEvent } from "../src/hub/events.ts";
import { Facts } from "../src/hub/facts.ts";
import { editGovernanceBlock } from "../src/hub/research-record.ts";
import { buildResearchQuality } from "../src/hub/research-quality.ts";
import { taskRecords } from "../src/hub/research.ts";

// #1556 T2: turn_end.edits counts and the text-free EditGovernanceBlock.
let clock = Date.parse("2026-11-01T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const task = (id: number, event: string, state: string, owner: string | null = null): StampedEvent =>
  ({ v: 1, at: at(), type: "task", id, event, by: "hub", state, owner, reviewer: "claude", class: "implement", pii: false } as StampedEvent);
const turn = (id: number, extra: Record<string, unknown> = {}): StampedEvent =>
  ({ v: 1, at: at(), type: "turn_end", peer: "codex", turn: `codex#1.${id}.${clock}`, ms: 1000, task: id, attribution: "delivery", ...extra } as StampedEvent);
const life = (id: number, between: StampedEvent[]): StampedEvent[] => [task(id, "proposed", "proposed"), task(id, "assigned", "in_progress", "codex"), ...between, task(id, "done", "in_review", "codex"), task(id, "approved", "approved", "codex")];
const writer = { version: "test", source: "backfill" as const };
const rec = (events: StampedEvent[]) => taskRecords(events, "p-1", writer);

test("turnEdits rebuilds only the closed shape and drops anything else whole", () => {
  expect(turnEdits({ obs: "hook", e: [2, 1, 0, 1, 0], path: "/etc/passwd", cmd: "rm -rf" })).toEqual({ obs: "hook", e: [2, 1, 0, 1, 0] });
  expect(turnEdits({ obs: "tree", u: 3 })).toEqual({ obs: "tree", u: 3 });
  for (const bad of [undefined, null, [], "x", { obs: "nope" }, { e: [1, 0, 0, 0, 0] }]) expect(turnEdits(bad)).toBeUndefined();
  expect(turnEdits({ obs: "hook", e: [1, 2, 3], s: [1, -1, 0, 0, 0], arm: "bogus", u: 1.5 })).toEqual({ obs: "hook" });
});

test("a task whose turns carry no edits has the all-unknown block; hook turns give bounded counts", () => {
  expect(rec(life(1, [turn(1)]))[0]!.edits).toEqual({ observability: "unknown", policyArm: "unknown", editTool: null, shellRoute: null, unattributedTreeWrites: null, postEdit: { editsWhileCheckFailing: null, revertedWrites: null } });
  const r = rec(life(2, [turn(2, { edits: { obs: "hook", arm: "baseline", e: [3, 1, 1, 1, 0], s: [1, 0, 0, 1, 0] } }), turn(2, { edits: { obs: "hook", e: [1, 1, 0, 0, 0] } })]))[0]!;
  expect(r.edits).toMatchObject({ observability: "hook_and_tree", policyArm: "baseline", editTool: { total: 4, verifiedFullRead: 2, partialReadOnly: 1, blindOrStale: 1, occRejected: 0 }, shellRoute: { total: 1, blindOrStale: 1, blockedByGuard: 0 }, unattributedTreeWrites: 0 });
});

test("tree_only surfaces record null for editTool and shellRoute, never 0, and quality counts them unknown", () => {
  const events = [...life(3, [turn(3, { edits: { obs: "tree", u: 2 } })]), ...life(4, [turn(4, { edits: { obs: "hook", e: [1, 1, 0, 0, 0] } })])];
  const records = rec(events);
  expect(records.find(r => r.task === 3)!.edits).toMatchObject({ observability: "tree_only", editTool: null, shellRoute: null, unattributedTreeWrites: 2 });
  const q = buildResearchQuality(records, events);
  expect(q.fields["edits.editTool.total"]).toEqual({ n: 2, unknown: 1 });
  expect(q.fields["edits.shellRoute.blockedByGuard"]).toEqual({ n: 2, unknown: 1 });
  expect(q.fields["edits.observability"]).toEqual({ n: 2, unknown: 0 });
  expect(q.fields["edits.editTool"]).toBeUndefined();
});

test("a PII turn contributes nothing and live and backfill agree byte for byte", () => {
  const events = life(5, [turn(5, { edits: { obs: "hook", e: [9, 9, 0, 0, 0] }, pii: true }), turn(5, { edits: { obs: "hook", e: [1, 0, 0, 1, 0] } })]);
  const a = rec(events), b = rec(structuredClone(events));
  expect(JSON.stringify(a[0]!.edits)).toBe(JSON.stringify(b[0]!.edits));
  expect(a[0]!.edits!.editTool!.total).toBe(1);
  expect(editGovernanceBlock([{ obs: "hook", e: [1, 0, 0, 1, 0] }])).toEqual(a[0]!.edits!);
});

test("Facts counts hook writes per turn: a read-only turn has no edits, a mutating turn has bounded counts, takeEdits clears", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-editgov-"));
  try {
    writeFileSync(join(root, "a.txt"), "one\n"); writeFileSync(join(root, "b.txt"), "two\n");
    const facts = new Facts({ root, tmp: join(root, ".t"), instance: "t", scope: () => ({ task: { id: 7 } }) as never, peers: () => ["codex"], nameable: () => true } as never);
    facts.preTool("codex", "r0", "Read", { file_path: join(root, "a.txt") }); facts.postTool("codex", "r0", "Read", { file_path: join(root, "a.txt") });
    expect(facts.takeEdits("codex")).toBeUndefined();
    facts.preTool("codex", "w1", "Write", { file_path: join(root, "a.txt"), content: "x" }); writeFileSync(join(root, "a.txt"), "x");
    facts.postTool("codex", "w1", "Write", { file_path: join(root, "a.txt"), content: "x" });
    facts.preTool("codex", "w2", "Write", { file_path: join(root, "b.txt"), content: "y" }); writeFileSync(join(root, "b.txt"), "y");
    facts.postTool("codex", "w2", "Write", { file_path: join(root, "b.txt"), content: "y" });
    facts.preTool("codex", "b1", "Bash", { command: "sed -i s/x/z/ a.txt" }); facts.postTool("codex", "b1", "Bash", { command: "sed -i s/x/z/ a.txt" });
    const t = facts.takeEdits("codex")!;
    expect(t).toEqual({ obs: "hook", e: [2, 1, 0, 1, 0], s: [1, 0, 0, 1, 0] });
    expect(facts.takeEdits("codex")).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
