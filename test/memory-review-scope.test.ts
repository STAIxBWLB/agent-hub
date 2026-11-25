import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { scheduledDetail } from "../src/hub/schedules.ts";
import { Tasks } from "../src/hub/tasks.ts";
import {
  memoryReviewCandidate, memoryReviewConfig, memoryReviewCountLine, memoryReviewEntry, memoryReviewScope, memoryReviewTask,
  reviewBudgetNote, reviewBudgetStop, reviewCheckpointRequest,
} from "../src/hub/memory-review.ts";

// agent-hub #1329 part 2 (hub task 1134): the review card's tool scope (AC3), its proposals as candidates (AC4), the budget
// stop (AC5) and the count-only report.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const CAPS = { max_tokens_run: 4000, max_tokens_week: 20_000 };

class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}

test("a review card refuses every mutation family and allows the review's own calls", () => {
  // AC3: each refused family names its cause and the next step, so the peer knows where the work belongs.
  const refused: [string, string][] = [
    ["memory_promote", "only proposes"], ["memory_demote", "only proposes"], ["memory_forget", "only proposes"],
    ["memory_supersede", "only proposes"], ["memory_accept", "only proposes"], ["amem_review_accept", "only proposes"],
    ["vmem_create", "writes a vault note"], ["vmem_patch", "writes a vault note"],
    ["Edit", "edits code"], ["Write", "edits code"], ["hub_check_start", "edits code"],
    ["hub_peer_start", "starts or holds a peer"], ["hub_peer_hold", "starts or holds a peer"],
    ["hub_task_propose", "outside a memory-review card's scope"], ["hub_review", "outside a memory-review card's scope"],
    ["hub_experiment_record", "outside a memory-review card's scope"],
  ];
  for (const [tool, cause] of refused) {
    const refusal = memoryReviewScope(tool);
    expect(refusal, tool).toBeDefined();
    expect(refusal!, tool).toContain(cause);
    // One sentence, and the continuation is a command or a named place the caller can reach.
    expect(refusal!, tool).toMatch(/outside this review task|ordinary task/);
  }
  // The MCP server prefix is the transport, never part of the rule: the same call arrives under another name.
  expect(memoryReviewScope("mcp__vmem__vmem_create")!.endsWith(memoryReviewScope("vmem_create")!.slice("vmem_create".length))).toBe(true);
  expect(memoryReviewScope("mcp__agent-mem__memory_forget")).toContain("only proposes");
  // Allowed: memory reads, proposal-only writes, the consolidation preview, vault reads, and the card's own lifecycle.
  for (const tool of ["hub_memory_search", "hub_memory_show", "hub_memory_graph", "hub_memory_correct", "hub_remember",
    "amem_consolidate", "amem_consolidate_preview", "vmem_search", "vmem_show", "vmem_report",
    "hub_checkpoint", "hub_task_done", "hub_task_escalate", "hub_send", "hub_task_show", "hub_specs", "hub_permission_request",
    "mcp__agent-hub__hub_task_show"]) expect(memoryReviewScope(tool), tool).toBeUndefined();
  // Nothing here names a tool the hub could mistake for its own: an unprefixed foreign name is left to its own server.
  expect(memoryReviewScope("")).toBeUndefined();
});

test("only the hub's own review card is in scope, never the review class alone", () => {
  const entry = memoryReviewEntry(memoryReviewConfig({ enabled: true, ...CAPS }), "/work/alpha")!;
  expect(memoryReviewTask({ detail: scheduledDetail(entry) })).toBe(true);
  // A `review`-class audit, a code review or a card a peer wrote carries no schedule marker and keeps its tools.
  expect(memoryReviewTask({ detail: "Review the release notes against the checklist." })).toBe(false);
  expect(memoryReviewTask({ detail: "Schedule key: nightly\nScheduled every 1d by the machine-local schedule \"nightly\"." })).toBe(false);
  expect(memoryReviewTask(undefined)).toBe(false);
});

test("a proposal is a candidate attributed to the review task and to the peer that wrote it", () => {
  const proposal = memoryReviewCandidate({ text: "the note names a symbol that moved", title: "stale anchor", noteKind: "finding" }, 42, "claude", new Date("2026-11-25T00:00:00.000Z"));
  expect(proposal.input).toMatchObject({ kind: "memory", text: "the note names a symbol that moved", title: "stale anchor", noteKind: "finding", about: ["task:42"] });
  expect(proposal.origin).toEqual({ peer: "claude", at: "2026-11-25T00:00:00.000Z" });
});

test("both caps stop a run at their reading, and each stop names the checkpoint and the reason", () => {
  expect(reviewBudgetStop({ run: 3999, week: 3999 }, CAPS)).toBeUndefined();
  expect(reviewBudgetStop({ run: 4000, week: 0 }, CAPS)).toEqual({ cap: "run", used: 4000, limit: 4000 });
  expect(reviewBudgetStop({ run: 4000, week: 20_000 }, CAPS)).toEqual({ cap: "run", used: 4000, limit: 4000 });
  expect(reviewBudgetStop({ run: 10, week: 20_000 }, CAPS)).toEqual({ cap: "week", used: 20_000, limit: 20_000 });
  // An unset cap cannot stop anything, and a block missing one is already refused by the config.
  expect(reviewBudgetStop({ run: 1_000_000, week: 1_000_000 }, {})).toBeUndefined();
  const stop = reviewBudgetStop({ run: 0, week: 20_000 }, CAPS)!;
  expect(reviewCheckpointRequest(7, stop)).toContain("First call hub_checkpoint");
  expect(reviewCheckpointRequest(7, stop)).toContain("reason \"budget\"");
  expect(reviewBudgetNote(7, stop, { run: 0, week: 20_000 })).toContain("spent 0 tokens this run and 20000 this week");
  expect(reviewBudgetNote(7, stop, { run: 0, week: 20_000 })).toContain("week cap is 20000");
});

test("the report carries counts only, and a reading this run did not observe stays unknown", () => {
  const line = memoryReviewCountLine({ notes: 3, corrections: 1, remembered: 2, originsFound: 4, originsExpired: 1, tokens: 900 });
  expect(line).toBe("memory review counts: notes checked 3, proposals 1 corrections and 2 notes, origin sessions 4 found and 1 expired, tokens 900");
  expect(line).not.toMatch(/mem:|task:|\.ts/);
  expect(memoryReviewCountLine({ notes: 0 })).toContain("origin sessions unknown found and unknown expired, tokens unknown");
});

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-scope-"));
  const bus = new Bus({ batchMs: 0, rostered: peer => ["claude", "codex", "local"].includes(peer) });
  const board = new Board(join(dir, "hub.db"));
  const claude = new Peer("claude"); bus.add(claude); await claude.start();
  const candidates = new CandidateStore({ memoryDir: join(dir, "candidates") });
  const tasks = new Tasks({
    board, bus, routing: () => loadRouting(dir), cwd: dir, project: "review-scope", candidates,
    store: { project: "review-scope", repo: dir, store: {} as never }, notify: () => {},
    // Two slots so the one peer holds a review card and an ordinary task at once: the point of the scope's turn binding.
    wipLimit: () => 2,
  });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, board, bus, tasks, candidates, claude };
}

test("a peer's live review card scopes its owner's turn on that card, and no other call", async () => {
  const { dir, board, tasks, candidates } = await rig();
  const entry = memoryReviewEntry(memoryReviewConfig({ enabled: true, ...CAPS }), dir)!;
  const card = await tasks.propose(HUB, { title: entry.title, detail: scheduledDetail(entry), class: "review", owner: "claude" });
  // Before the card is accepted there is no review work to scope.
  expect(tasks.reviewCardFor("claude", card.id)).toBeUndefined();
  tasks.accept("claude", card.id);
  // AC3 binds the scope to the card's OWNER and to the TURN bound to that card: the reviewer reviews the card rather than
  // running it, and the owner's work on another task keeps every tool.
  expect(tasks.reviewCardFor("claude", card.id)?.id).toBe(card.id);
  const other = await tasks.propose(HUB, { title: "an ordinary implement task", class: "implement", owner: "claude" });
  tasks.accept("claude", other.id);
  expect(tasks.reviewCardFor("claude", other.id)).toBeUndefined();
  expect(tasks.reviewCardFor("codex", card.id)).toBeUndefined();
  expect(tasks.reviewCardFor("claude", undefined)).toBeUndefined();
  expect(tasks.reviewCardFor(HUB, card.id)).toBeUndefined();

  // AC4: the note never reaches the curated store; it is a candidate that names the card and the peer. A call that passes no
  // card is outside the review's turn, so it files no candidate at all.
  expect(await tasks.rememberOutcome("claude", { text: "a note filed on the owner's other task" })).not.toMatchObject({ outcome: "candidate" });
  expect(candidates.list({ project: "review-scope" })).toHaveLength(0);
  const saved = await tasks.rememberOutcome("claude", { text: "the anchor this note names moved to another file" }, card);
  expect(saved.outcome).toBe("candidate");
  expect(saved.message).toContain(`task #${card.id} changed no note`);
  const [proposal] = candidates.list({ project: "review-scope" });
  expect(proposal).toMatchObject({ input: { kind: "memory", about: [`task:${card.id}`] }, origin: { peer: "claude" } });
  expect(candidates.list({ project: "review-scope" })).toHaveLength(1);

  // A closed card scopes nothing: the same call is ordinary work again.
  await tasks.cancel(card.id, USER, { reason: "the run stopped" });
  expect(board.get(card.id)!.state).toBe("cancelled");
  expect(tasks.reviewCardFor("claude", card.id)).toBeUndefined();
});
