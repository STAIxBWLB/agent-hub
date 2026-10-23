import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { deliverableId } from "../src/hub/deliverables.ts";

// #509a end to end through Tasks, in a plain folder: no git, no PR, no lifecycle receipt, no snapshot.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
class Peer extends BasePeer {
  readonly got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function rig(opts: { piiPaths?: string[]; deny?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-deliverable-tasks-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const peers = { claude: new Peer("claude"), codex: new Peer("codex") };
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ board, bus, cwd: dir, project: "deliverables", routing: () => loadRouting(dir), roles: { claude: ["planner", "reviewer"] }, notify: (text: string) => notices.push(text), piiScreen: async () => ({ label: "clear", ms: 0 }),
    ...(opts.piiPaths ? { piiPaths: opts.piiPaths } : {}), ...(opts.deny ? { deny: opts.deny } : {}) } as never);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  const propose = (extra: object = {}) => tasks.propose("claude", { title: "write the report", class: "implement", owner: "codex", ...extra });
  const review = (id: number) => peers.claude.got.filter(e => e.kind === "review" && e.refs?.task === String(id)).at(-1)?.body;
  return { dir, board, tasks, peers, notices, write, propose, review };
}
const doc = (path = "report.md", format = "md", version?: string) => [{ path, format, ...(version ? { version } : {}) }];

test("done records the files the hub hashed, in a plain folder, and the review request lists them by id, hash and size", async () => {
  const r = await rig(); r.write("report.md", "# Findings\nv1\n");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "wrote it", undefined, doc("report.md", "md", "v1"));
  await Bun.sleep(5);
  const done = r.board.get(t.id)!.history.find(h => h.event === "done")!;
  expect(done.deliverables).toEqual([{ id: deliverableId("report.md", "md"), path: "report.md", format: "md", version: "v1", sha256: sha("# Findings\nv1\n"), bytes: 14 }]);
  const body = r.review(t.id)!;
  expect(body).toContain(`Deliverables (the hub hashed these files when the task was done; approval binds these hashes):\n- ${deliverableId("report.md", "md")}: report.md [md v1] sha256 ${sha("# Findings\nv1\n").slice(0, 16)}, 14 bytes\n`);
  expect(r.board.get(t.id)!.sdlc).toBeUndefined(); // no lifecycle receipt was needed
});

test("approval binds the hashes it was given, and approving unchanged files records them", async () => {
  const r = await rig(); r.write("report.md", "final text");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done", undefined, doc());
  await r.tasks.review("claude", t.id, "approved", "good");
  const task = r.board.get(t.id)!;
  expect(task.state).toBe("approved");
  expect(task.history.find(h => h.event === "approved")!.deliverables).toEqual(task.history.find(h => h.event === "done")!.deliverables);
  const status = await r.tasks.deliverableStatus(task);
  expect(status).toMatchObject({ state: "approved", changedSinceReview: false, files: [{ id: deliverableId("report.md", "md"), sha256: sha("final text"), state: "unchanged", path: "report.md" }] });
});

test("a file edited after delivery blocks a reviewer's approval before any write, and says what changed", async () => {
  const r = await rig(); r.write("report.md", "reviewed text");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done", undefined, doc());
  r.write("report.md", "reviewed text, then quietly edited");
  const before = JSON.stringify(r.board.get(t.id));
  await expect(r.tasks.review("claude", t.id, "approved", "ok")).rejects.toThrow(`deliverable changed since it was delivered: ${deliverableId("report.md", "md")} (changed)`);
  expect(JSON.stringify(r.board.get(t.id))).toBe(before); // a refused approval changed nothing
  expect(r.board.get(t.id)!.state).toBe("in_review");
  expect(await r.tasks.deliverableStatus(r.board.get(t.id)!)).toMatchObject({ state: "delivered", changedSinceReview: true });
  // changes_requested is not blocked: asking for a redo needs no binding
  await r.tasks.review("claude", t.id, "changes_requested", "redo it");
  expect(r.board.get(t.id)!.state).not.toBe("approved");
});

test("the owner redelivers, the new bytes are what the next approval binds", async () => {
  const r = await rig(); r.write("report.md", "v1 text");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "first", undefined, doc());
  r.write("report.md", "v2 text");
  await r.tasks.review("claude", t.id, "changes_requested", "update it");
  await r.tasks.done("codex", t.id, "second", undefined, doc("report.md", "md", "v2"));
  await r.tasks.review("claude", t.id, "approved", "now good");
  const approved = r.board.get(t.id)!.history.findLast(h => h.event === "approved")!;
  expect(approved.deliverables![0]).toMatchObject({ sha256: sha("v2 text"), version: "v2" });
});

test("an edit after approval reads as changed since review, and a missing file as missing", async () => {
  const r = await rig(); r.write("report.md", "approved text"); r.write("keep.md", "k");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done", undefined, [...doc(), ...doc("keep.md")]);
  await r.tasks.review("claude", t.id, "approved", "ok");
  expect((await r.tasks.deliverableStatus(r.board.get(t.id)!))!.changedSinceReview).toBe(false);
  r.write("report.md", "approved text, changed later");
  rmSync(join(r.dir, "keep.md"));
  const status = (await r.tasks.deliverableStatus(r.board.get(t.id)!))!;
  expect(status.changedSinceReview).toBe(true);
  expect(status.files.map(f => f.state)).toEqual(["changed", "missing"]);
  expect(r.board.get(t.id)!.history.findLast(h => h.event === "approved")!.deliverables![0]!.sha256).toBe(sha("approved text")); // the approval keeps the bytes it approved
});

test("the person may approve files that changed: the current bytes are measured and bound, and the verdict says so", async () => {
  const r = await rig(); r.write("report.md", "before");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done", undefined, doc());
  r.write("report.md", "after, as the person wants it");
  await r.tasks.review(USER, t.id, "approved", "fine as it is");
  const approved = r.board.get(t.id)!.history.findLast(h => h.event === "approved")!;
  expect(approved.deliverables![0]!.sha256).toBe(sha("after, as the person wants it"));
  expect(approved.note).toContain(`Approved with the deliverable files changed since delivery: ${deliverableId("report.md", "md")} (changed)`);
  expect((await r.tasks.deliverableStatus(r.board.get(t.id)!))!.changedSinceReview).toBe(false);
});

test("a claimed hash, a denied path, a path outside the project and a missing file are refused with nothing recorded", async () => {
  const r = await rig({ deny: ["secret"] }); r.write("report.md", "x"); r.write("notes/secret.txt", "s"); r.write(".agenthub/state/x", "t");
  const t = await r.propose();
  const start = r.board.get(t.id)!.history.map(h => h.event);
  const refuse = async (deliverables: unknown, why: RegExp) => {
    const before = JSON.stringify(r.board.get(t.id));
    await expect(r.tasks.done("codex", t.id, "done", undefined, deliverables)).rejects.toThrow(why);
    expect(JSON.stringify(r.board.get(t.id))).toBe(before);
  };
  await refuse([{ path: "report.md", format: "md", sha256: sha("x") }], /a claimed hash is not used/);
  await refuse(doc("notes/secret.txt", "txt"), /denylist/);
  await refuse(doc(".agenthub/state/x", "txt"), /denylist/); // the hub's state is on the secrets denylist; config files are refused as hub state (test/deliverables.test.ts)
  await refuse(doc("../outside.md"), /no empty, \. or \.\. segments/);
  await refuse(doc("/etc/passwd", "txt"), /relative path/);
  await refuse(doc("absent.md"), /does not exist/);
  await refuse([], /1 to 16 entries/);
  await refuse("report.md", /expected a list/);
  expect(r.board.get(t.id)!.history.map(h => h.event)).toEqual(start); // no refusal wrote an entry, accept included
});

test("a task with no deliverables behaves exactly as before: no block in the request, no record, approval unchanged", async () => {
  const r = await rig();
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done");
  await Bun.sleep(5);
  expect(r.review(t.id)).not.toContain("Deliverables");
  expect(r.board.get(t.id)!.history.some(h => h.deliverables !== undefined)).toBe(false);
  expect(await r.tasks.deliverableStatus(r.board.get(t.id)!)).toBeUndefined();
  await r.tasks.review("claude", t.id, "approved", "ok");
  expect(r.board.get(t.id)!.state).toBe("approved");
});

test("hub_sdlc_record records deliverables beside a receipt, or alone, through the same hashing", async () => {
  const r = await rig(); r.write("deck.pptx", "slides v1");
  const t = await r.propose();
  const recorded = await r.tasks.recordSdlc("codex", t.id, { deliverables: doc("deck.pptx", "pptx", "v1") });
  const entry = recorded.history.findLast(h => h.event === "lifecycle")!;
  expect(entry.deliverables).toEqual([{ id: deliverableId("deck.pptx", "pptx"), path: "deck.pptx", format: "pptx", version: "v1", sha256: sha("slides v1"), bytes: 9 }]);
  await expect(r.tasks.recordSdlc("codex", t.id, { deliverables: [{ path: "deck.pptx", format: "pptx", sha256: "0".repeat(64) }] })).rejects.toThrow(/a claimed hash is not used/);
  await expect(r.tasks.recordSdlc("kimi", t.id, { deliverables: doc("deck.pptx", "pptx") })).rejects.toThrow(/only the task owner, reviewer or console user/); // a peer with no role on the task records nothing
  // without `deliverables` it is the old recordLifecycle, untouched
  const plain = await r.tasks.recordSdlc("codex", t.id, { stage: "implement" });
  expect(plain.history.findLast(h => h.event === "lifecycle")!.deliverables).toBeUndefined();
  // records from the lifecycle call are what the approval binds, when nothing was delivered through done
  await r.tasks.done("codex", t.id, "done");
  await r.tasks.review("claude", t.id, "approved", "ok");
  expect(r.board.get(t.id)!.history.findLast(h => h.event === "approved")!.deliverables![0]!.sha256).toBe(sha("slides v1"));
});

test("a PII task, or a path under pii.paths, keeps ids and hashes only in every view", async () => {
  const r = await rig({ piiPaths: ["patients/**"] });
  r.write("patients/2026.csv", "id,dx\n1,flu\n"); r.write("report.md", "ordinary");
  const t = await r.propose();
  await r.tasks.done("codex", t.id, "done", undefined, [...doc("report.md"), ...doc("patients/2026.csv", "csv")]);
  await Bun.sleep(5);
  const task = r.board.get(t.id)!;
  const stored = task.history.find(h => h.event === "done")!.deliverables!;
  expect(stored.map(d => !!d.private)).toEqual([false, true]);
  expect(stored[1]!.path).toBe("patients/2026.csv"); // the board keeps it so the file can be found again
  const body = r.review(t.id)!;
  expect(body).toContain("report.md");
  expect(body).toContain("(path withheld)");
  expect(body).not.toContain("patients"); expect(body).not.toContain("flu");
  const view = JSON.stringify(r.tasks.publicView(task, true));
  expect(view).toContain(sha("id,dx\n1,flu\n")); expect(view).not.toContain("patients");
  const status = (await r.tasks.deliverableStatus(task))!;
  expect(JSON.stringify(status)).not.toContain("patients");
  expect(status.files[1]).toMatchObject({ id: deliverableId("patients/2026.csv", "csv"), private: true, state: "unchanged" });
  expect(r.notices.join("\n")).not.toContain("patients");
});

test("a PII task's own files are private whatever their path", async () => {
  const r = await rig();
  r.write("memo.md", "about a patient");
  const task = r.board.propose("claude", { title: "ordinary title", class: "implement", signals: ["pii_path"] });
  r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: USER });
  expect(r.tasks.isPii(r.board.get(task.id)!)).toBe(true);
  await r.tasks.done("codex", task.id, "done", undefined, doc("memo.md"));
  const stored = r.board.get(task.id)!.history.find(h => h.event === "done")!.deliverables!;
  expect(stored[0]).toMatchObject({ private: true, sha256: sha("about a patient") });
  const status = (await r.tasks.deliverableStatus(r.board.get(task.id)!))!;
  expect(status.files[0]!.path).toBeUndefined(); expect(status.files[0]!.private).toBe(true);
});

test("the board refuses deliverables on an event that cannot carry them, and damaged records", async () => {
  const r = await rig(); r.write("report.md", "x");
  const t = await r.propose();
  const record = { id: deliverableId("report.md", "md"), path: "report.md", format: "md", sha256: sha("x"), bytes: 1 };
  expect(() => r.board.update(t.id, "claude", "answer", {}, undefined, { deliverables: [record] } as never)).toThrow("deliverable records require a done, a lifecycle record or an approval");
  expect(() => r.board.update(t.id, "claude", "lifecycle", {}, undefined, { deliverables: [{ ...record, sha256: "nope" }] } as never)).toThrow("expected a sha256");
  expect(r.board.get(t.id)!.history.some(h => h.deliverables)).toBe(false);
});
