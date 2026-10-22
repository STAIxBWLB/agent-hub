import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #713 (task #382): completed-change notices. One per recipient per done naming all its accepted overlapping tasks; a repeat done leaves exactly one queued;
// none for a task the recipient only holds an offer for; after it accepts, the next done notifies it. Driven through the real Tasks and Bus.
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-completed-notice-"));
  const journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: "notice", instanceId: "i1" });
  const board = new Board(join(cwd, "board.db")), bus = new Bus({ batchMs: 0, journal });
  cleanup.push(() => { board.close(); bus.closeJournal(); rmSync(cwd, { recursive: true, force: true }); });
  // agy is busy (a pull-only TUI), so everything addressed to it stays queued.
  class Peer extends BasePeer { readonly pullOnly = true; async start() { this.setState("busy"); } async stop() { this.setState("offline"); } async deliver(_envs: Envelope[]) { return; } }
  class Pusher extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(_envs: Envelope[]) { return; } }
  const agy = new Peer("agy", 60000), codex = new Pusher("codex", 60000), claude = new Pusher("claude", 60000);
  for (const peer of [agy, codex, claude]) { bus.add(peer); await peer.start(); cleanup.push(() => peer.stop()); }
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", notify: () => {}, routing: () => loadRouting(cwd) });
  /** An open task of `owner` on `path`, accepted (in_progress, with its own accepted entry) unless `offered`. */
  const open = (owner: string, path: string, offered = false) => {
    const t = board.propose("user", { title: `work on ${path}`, class: "implement", refs: { paths: [path] } });
    return offered ? board.update(t.id, "user", "assigned", { owner, state: "proposed" }) : board.update(t.id, owner, "accepted", { state: "in_progress", owner, reviewer: "claude" });
  };
  const noticesFor = (peer: string) => bus.queueList(peer).filter(r => r.state === "queued").flatMap(r => r.originals).filter(e => e.from === "hub" && /is done and touches/.test(e.body));
  return { tasks, board, bus, journal, open, noticesFor };
}

test("three repeat dones of one task that overlaps two of agy's accepted tasks leave exactly one queued notice naming both (#713 acceptance)", async () => {
  const f = await rig();
  const a = f.open("agy", "src/a.ts"), b = f.open("agy", "src/a.ts");
  const mine = f.open("codex", "src/a.ts");
  for (const summary of ["first", "after review 1", "after CI fix"]) {
    await f.tasks.done("codex", mine.id, summary);
    f.board.update(mine.id, "claude", "changes_requested", { state: "changes_requested" });       // the review sends it back, as in R1, R2, the CI fix
    f.board.update(mine.id, "codex", "accepted", { state: "in_progress" });
  }
  const queued = f.noticesFor("agy");
  expect(queued).toHaveLength(1);                                                               // not 3 dones x 2 tasks = 6
  expect(queued[0]!.body).toContain(`Task #${mine.id} (owner codex) is done and touches your open tasks`);
  expect(queued[0]!.body).toContain(`#${a.id} on `); expect(queued[0]!.body).toContain(`#${b.id} on `);   // both of the recipient's tasks in one message
  expect(queued[0]!.body).toContain("after CI fix");                                           // the newest summary: the older notices were superseded
  expect(f.journal.list("agy").filter(r => r.state === "discarded" && /superseded completed-change notice/.test(String(r.reason)))).toHaveLength(2);   // through the stale/discard path
});

test("a recipient whose overlapping task is only offered or proposed gets no notice; after it accepts, the next done notifies it (#713 acceptance)", async () => {
  const f = await rig();
  const offered = f.open("agy", "src/b.ts", true);
  expect(f.board.get(offered.id)!.state).toBe("proposed");
  const mine = f.open("codex", "src/b.ts");
  await f.tasks.done("codex", mine.id, "done once");
  expect(f.noticesFor("agy")).toHaveLength(0);                                                  // nothing to check yet: its offer already shows the board
  f.board.update(offered.id, "agy", "accepted", { state: "in_progress" });                      // agy accepts
  f.board.update(mine.id, "claude", "changes_requested", { state: "changes_requested" });
  f.board.update(mine.id, "codex", "accepted", { state: "in_progress" });
  await f.tasks.done("codex", mine.id, "done twice");
  const notice = f.noticesFor("agy");
  expect(notice).toHaveLength(1); expect(notice[0]!.body).toContain(`your open #${offered.id} on `);   // one task: the singular wording
});

test("each recipient gets its own notice, and a recipient with an accepted and an offered task hears only about the accepted one (#713)", async () => {
  const f = await rig();
  const agyAccepted = f.open("agy", "src/c.ts"), agyOffered = f.open("agy", "src/c.ts", true), claudeTask = f.open("claude", "src/c.ts");
  const mine = f.open("codex", "src/c.ts");
  await f.tasks.done("codex", mine.id, "done");
  const forAgy = f.noticesFor("agy"), forClaude = f.noticesFor("claude");
  expect(forAgy).toHaveLength(1); expect(forAgy[0]!.body).toContain(`#${agyAccepted.id} on `); expect(forAgy[0]!.body).not.toContain(`#${agyOffered.id} on `);
  expect(forAgy[0]!.body).not.toContain("your open tasks");                                     // only one of agy's tasks counts, so the singular form
  // claude is a push peer that is idle, so its notice is delivered at once instead of queued: the proof is that agy's notice does not mention claude's task and the
  // two recipients are not folded into one message.
  expect(forClaude).toHaveLength(0);
  expect(forAgy[0]!.body).not.toContain(`#${claudeTask.id} on `);
});

test("a grouped notice stays relevant while any one of its tasks is still open, and is dropped when none is (#713)", async () => {
  const f = await rig();
  const a = f.open("agy", "src/d.ts"), b = f.open("agy", "src/d.ts"), mine = f.open("codex", "src/d.ts");
  await f.tasks.done("codex", mine.id, "done");
  const env = f.noticesFor("agy")[0]!;
  expect(f.tasks.relevant("agy", env)).toBe(true);
  f.board.update(a.id, "agy", "done", { state: "in_review" }); f.board.update(a.id, "claude", "approved", { state: "approved" });
  expect(f.tasks.relevant("agy", env)).toBe(true);                                              // #b is still open for agy
  f.board.update(b.id, "agy", "done", { state: "in_review" }); f.board.update(b.id, "claude", "approved", { state: "approved" });
  expect(f.tasks.relevant("agy", env)).toBe(false);                                             // nothing left to check
});
