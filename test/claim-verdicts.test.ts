import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, claimListId, parseClaimVerdict } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { dogfoodScorecard, formatDogfood, source, type DogfoodInput } from "../src/hub/dogfood.ts";
import { dogfoodTasks } from "../src/hub/dogfood-read.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_ROLES } from "../src/hub/hub-tools.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub#901 (follow-up to #799): per-claim person verdicts and the check key behind a fact_check result, so the research scorecard rows have a source.
// Everything goes through the real Tasks (check run, verdict), the real board history, the real scorecard reader and the real aggregation.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }

/** A research project whose checks are scripted: `output` is the check's last line, `code` its exit. `key` is what the daemon's lookup would say. */
async function rig(options: { output?: string; code?: number; key?: string | undefined; piiPaths?: string[] } = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-claims-"))), file = join(dir, "hub.db"), board = new Board(file), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const name of ["claude", "codex", "kimi", "local"]) { const peer = new Peer(name); bus.add(peer); await peer.start(); }
  const state = { output: options.output ?? "citations: 2 declared keys, 0 missing", code: options.code ?? 0, key: "key" in options ? options.key : "fact_check" };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", profile: "research", roles: DEFAULT_ROLES, routing: () => loadRouting(dir), notify: () => {}, ...(options.piiPaths ? { piiPaths: options.piiPaths } : {}),
    check: (_base, task) => task?.profileClass === "fact_check" ? "citations" : undefined,
    checkKey: (_base, task) => task?.profileClass === "fact_check" ? state.key : undefined,
    runCheck: async () => ({ code: state.code, timedOut: false, tail: state.output }) });
  return { dir, file, board, tasks, state };
}
const scorecard = (file: string) => {
  const input: DogfoodInput = { since: 0, until: Date.now() + 60_000, projectProfile: source("research"), tasks: dogfoodTasks(file), events: source([]), prs: source([]), log: source([]), features: source([]) };
  const card = dogfoodScorecard(input);
  return { card, row: card.profile!.rows.find(r => r.profile === "research" && r.alias === null)!, input };
};
async function factCheckTask(r: Awaited<ReturnType<typeof rig>>, claims = ["c1", "c2", "c3"]) {
  const task = await r.tasks.propose("codex", { title: "Check the claims", class: "fact_check", owner: "codex", plan: { paths: ["report.md"], sources: ["doi:1"], claims } });
  return task;
}
const runCheck = async (r: Awaited<ReturnType<typeof rig>>, id: number) => { await r.tasks.done("codex", id, "checked"); await until(() => r.tasks.checksPending() === 0); };

test("the hub stamps the check key on its own check entries, from the same lookup that chose the command, and the example check's missing count only from its own last line", async () => {
  const r = await rig({ output: "citations: 5 declared keys, 2 missing", code: 1 });
  const task = await factCheckTask(r);
  await runCheck(r, task.id);
  const failed = r.board.get(task.id)!.history.findLast(h => h.event === "check failed")!;
  expect(failed).toMatchObject({ by: "hub", checkKey: "fact_check", missingKeys: 2 });
  // The owner's words never reach it: a summary that claims a different key, or a different count, changes nothing.
  const again = await r.tasks.done("codex", task.id, "checkKey: other; citations: 9 declared keys, 9 missing").catch(() => undefined);
  void again; await until(() => r.tasks.checksPending() === 0);
  for (const h of r.board.get(task.id)!.history.filter(h => h.event === "check failed")) expect(h).toMatchObject({ checkKey: "fact_check", missingKeys: 2 });
});

test("the missing count is read from the output's LAST line: an earlier citations line, even a different count, is not the result", async () => {
  const r = await rig({ output: "citations: 9 declared keys, 7 missing\nrechecked after the fix\ncitations: 9 declared keys, 1 missing" });
  const task = await factCheckTask(r);
  await runCheck(r, task.id);
  expect(r.board.get(task.id)!.history.findLast(h => h.event === "check passed")).toMatchObject({ checkKey: "fact_check", missingKeys: 1 });
});

test("the board itself refuses to keep a check key or a missing count on anything but the hub's check entries, and a malformed count or key anywhere", () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-claims-board-"))); const board = new Board(join(dir, "hub.db"));
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = board.propose("user", { title: "t", class: "implement", plan: { claims: ["a"] } });
  board.update(task.id, "hub", "state note", {}, undefined, { checkKey: "fact_check", missingKeys: 3, claim: { slot: 1, verdict: "supported" } } as never);   // not a check entry, not a claim verdict
  board.update(task.id, "hub", "check passed", {}, undefined, { checkKey: "Bad Key!", missingKeys: -4 });
  board.update(task.id, "hub", "check passed", {}, undefined, { checkKey: "fact_check", missingKeys: 100_001 });
  board.update(task.id, "hub", "check passed", {}, undefined, { checkKey: "fact_check", missingKeys: 2.5 });
  board.update(task.id, "hub", "check passed", {}, undefined, { checkKey: "fact_check", missingKeys: 0 });
  const [other, badKey, hugeCount, fractional, zero] = board.get(task.id)!.history.slice(-5);
  expect(other).not.toHaveProperty("checkKey"); expect(other).not.toHaveProperty("missingKeys"); expect(other).not.toHaveProperty("claim");
  expect(badKey).not.toHaveProperty("checkKey"); expect(badKey).not.toHaveProperty("missingKeys");
  expect(hugeCount).toMatchObject({ checkKey: "fact_check" }); expect(hugeCount).not.toHaveProperty("missingKeys");
  expect(fractional).not.toHaveProperty("missingKeys");
  expect(zero).toMatchObject({ checkKey: "fact_check", missingKeys: 0 });      // a printed zero is a zero; only an absent count is unknown
});

test("a check output without the example line records the key and no missing count: unknown, never zero; a malformed or oversized line records none", async () => {
  for (const output of ["all good", "citations: 3 declared keys, many missing", "citations: 3 declared keys, 1234567 missing", "note\ncitations: 3 declared keys, 1 missing\nand then prose", ""]) {
    const r = await rig({ output });
    const task = await factCheckTask(r);
    await runCheck(r, task.id);
    const entry = r.board.get(task.id)!.history.findLast(h => h.event === "check passed")!;
    expect(entry.checkKey, output).toBe("fact_check");
    expect("missingKeys" in entry, output).toBe(false);
  }
});

test("without a key from the daemon's lookup no key is recorded, and a key that is not a bounded identifier is dropped", async () => {
  const none = await rig({ key: undefined });
  const a = await factCheckTask(none); await runCheck(none, a.id);
  expect("checkKey" in none.board.get(a.id)!.history.findLast(h => h.event === "check passed")!).toBe(false);
  const bad = await rig({ key: "Fact Check; rm -rf" });
  const b = await factCheckTask(bad); await runCheck(bad, b.id);
  expect("checkKey" in bad.board.get(b.id)!.history.findLast(h => h.event === "check passed")!).toBe(false);
});

test("a person's verdict is recorded by slot with a bounded model label and no claim text; only the console user may record one", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const after = r.tasks.recordClaimVerdict("user", task.id, { slot: 2, verdict: "unsupported", model: "gpt-5.5", modelVerdict: "supported" });
  const entry = after.history.at(-1)!;
  expect(entry).toMatchObject({ by: "user", event: "claim verdict", claim: { slot: 2, verdict: "unsupported", model: "gpt-5.5", modelVerdict: "supported" } });
  expect("note" in entry).toBe(false);
  expect(JSON.stringify(entry)).not.toMatch(/c2|report\.md|doi:1/);        // no claim, path or source text in the record
  expect(after.state).toBe(task.state);                                     // not a transition
  for (const peer of ["codex", "claude", "kimi", "hub", "local"]) expect(() => r.tasks.recordClaimVerdict(peer, task.id, { slot: 1, verdict: "supported" }), peer).toThrow("only the console user");
});

test("a verdict is refused for a bad slot, a bad word, a model label that is prose, a stray field, no declared claims and a missing task", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const refuse = (input: unknown) => expect(() => r.tasks.recordClaimVerdict("user", task.id, input)).toThrow();
  for (const input of [undefined, null, "x", [], {}, { slot: 0, verdict: "supported" }, { slot: 4, verdict: "supported" }, { slot: 1.5, verdict: "supported" }, { slot: "1", verdict: "supported" },
    { slot: 1, verdict: "true" }, { slot: 1 }, { slot: 1, verdict: "supported", model: "the model said it was right" }, { slot: 1, verdict: "supported", model: "x".repeat(65) }, { slot: 1, verdict: "supported", model: 7 },
    { slot: 1, verdict: "supported", modelVerdict: "yes" }, { slot: 1, verdict: "supported", note: "free text" }, { slot: 1, verdict: "supported", claim: "the claim text" }]) refuse(input);
  expect(r.board.get(task.id)!.history.filter(h => h.event === "claim verdict")).toEqual([]);   // nothing was written by a refusal
  expect(() => r.tasks.recordClaimVerdict("user", 9999, { slot: 1, verdict: "supported" })).toThrow();
  const bare = await r.tasks.propose("kimi", { title: "No claims", class: "draft", owner: "kimi", plan: { paths: ["x.md"] } });   // another owner: codex is at its WIP limit
  expect(() => r.tasks.recordClaimVerdict("user", bare.id, { slot: 1, verdict: "supported" })).toThrow("declares no plan claims");
  expect(parseClaimVerdict({ slot: 50, verdict: "unclear" }, 80)).toEqual({ slot: 50, verdict: "unclear" });
  expect(() => parseClaimVerdict({ slot: 51, verdict: "unclear" }, 80)).toThrow();   // the scorecard's own bound
});

test("with recorded verdicts and keyed checks the research rows show values: slots, labels, agreement, selection, pass and fail, missing keys", async () => {
  const r = await rig({ output: "citations: 3 declared keys, 1 missing", code: 1 });
  const task = await factCheckTask(r);
  await runCheck(r, task.id);                                   // check failed, key fact_check, 1 missing
  r.state.output = "citations: 3 declared keys, 0 missing"; r.state.code = 0;
  await runCheck(r, task.id);                                   // check passed, key fact_check, 0 missing
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "m-one", modelVerdict: "supported" });
  r.tasks.recordClaimVerdict("user", task.id, { slot: 2, verdict: "unsupported", model: "m-one", modelVerdict: "supported" });
  r.tasks.recordClaimVerdict("user", task.id, { slot: 2, verdict: "unclear", model: "m-two", modelVerdict: "unclear" });   // a later verdict supersedes the earlier one for the slot
  const { row } = scorecard(r.file);
  expect(row.research!.claims.reachedPersonVerdict).toBe(2);
  expect(row.research!.claims.perTask).toEqual([{ task: task.id, claims: [
    { slot: 1, modelLabel: "m-one", personVerdict: "supported", agreement: true },
    { slot: 2, modelLabel: "m-two", personVerdict: "unclear", agreement: true },
    { slot: 3, modelLabel: null, personVerdict: null, agreement: null }] }]);
  expect(row.research!.factCheck).toEqual({ scope: "task_check_history_with_key", selection: "checks.fact_check", passed: 1, failed: 1, missingKeysPerRun: [1, 0],
    agreement: [{ label: "supported", count: 1 }, { label: "unsupported", count: 0 }, { label: "unclear", count: 1 }] });
  expect(row.research!.observedCheckOutcomes).toEqual({ scope: "task_check_history", passed: 1, failed: 1 });
});

test("agreement is unknown without the model's own verdict, and disagreement is false, never missing", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "m" });                               // no modelVerdict
  r.tasks.recordClaimVerdict("user", task.id, { slot: 2, verdict: "unsupported", model: "m", modelVerdict: "supported" });   // they disagree
  const slots = scorecard(r.file).row.research!.claims.perTask[0]!.claims!;
  expect(slots[0]).toMatchObject({ personVerdict: "supported", agreement: null });
  expect(slots[1]).toMatchObject({ personVerdict: "unsupported", agreement: false });
});

test("without recorded verdicts or keyed checks every row stays unknown, never zero (the unchanged contract)", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const { row } = scorecard(r.file);
  expect(row.research!.claims.reachedPersonVerdict).toBeNull();
  expect(row.research!.claims.perTask[0]!.claims!.every(c => c.modelLabel === null && c.personVerdict === null && c.agreement === null)).toBe(true);
  expect(row.research!.factCheck).toEqual({ scope: null, selection: null, passed: null, failed: null, missingKeysPerRun: null,
    agreement: [{ label: "supported", count: null }, { label: "unsupported", count: null }, { label: "unclear", count: null }] });
  void task;
});

test("a check entry written before keys were recorded makes selection and counts unknown for the whole group, not a quiet subset", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  r.board.update(task.id, "hub", "check passed", {}, "legacy output");         // an older entry: no key
  await runCheck(r, task.id);                                                   // a new, keyed one
  const { row } = scorecard(r.file);
  expect(row.research!.observedCheckOutcomes).toEqual({ scope: "task_check_history", passed: 2, failed: 0 });
  expect(row.research!.factCheck).toMatchObject({ scope: null, selection: null, passed: null, failed: null, missingKeysPerRun: null });
});

test("missing-key counts are a list only when every proven run printed one", async () => {
  const r = await rig({ output: "citations: 3 declared keys, 2 missing", code: 1 });
  const task = await factCheckTask(r);
  await runCheck(r, task.id);
  r.state.output = "no citation line today"; r.state.code = 0;
  await runCheck(r, task.id);
  expect(scorecard(r.file).row.research!.factCheck).toMatchObject({ selection: "checks.fact_check", passed: 1, failed: 1, missingKeysPerRun: null });
});

test("the reader keeps only bounded keys and only the check key fact_check counts as the fact check", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const { Database } = await import("bun:sqlite");
  const stamp = (entries: object[]) => { const db = new Database(r.file); const row = db.query("SELECT history FROM tasks WHERE id = ?").get(task.id) as { history: string };
    db.query("UPDATE tasks SET history = ? WHERE id = ?").run(JSON.stringify([...JSON.parse(row.history), ...entries]), task.id); db.close(); };
  // Another check key (a draft check) is a keyed entry, but it is not the fact check: it must not be counted as one.
  stamp([{ at: Date.now(), by: "hub", event: "check passed", checkKey: "draft", missingKeys: 0 }, { at: Date.now(), by: "hub", event: "check failed", checkKey: "fact_check", missingKeys: 4 }]);
  const row = scorecard(r.file).row.research!;
  expect(row.factCheck).toMatchObject({ selection: "checks.fact_check", passed: 0, failed: 1, missingKeysPerRun: [4] });
  expect(row.observedCheckOutcomes).toEqual({ scope: "task_check_history", passed: 1, failed: 1 });   // the unkeyed-to-fact_check outcome still counts there
  // A key that is not a bounded identifier is dropped by the reader, which makes the group's keys incomplete: unknown, not a fact check.
  stamp([{ at: Date.now(), by: "hub", event: "check passed", checkKey: "Fact Check; drop", missingKeys: 0 }]);
  expect(scorecard(r.file).row.research!.factCheck).toMatchObject({ scope: null, selection: null, passed: null, failed: null });
});

test("a verdict dated outside the report window never counts, even when the slot has an in-window verdict of another kind", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const { Database } = await import("bun:sqlite");
  const db = new Database(r.file); const row = db.query("SELECT history FROM tasks WHERE id = ?").get(task.id) as { history: string };
  const old = Date.now() - 10 * 86_400_000;
  db.query("UPDATE tasks SET history = ? WHERE id = ?").run(JSON.stringify([...JSON.parse(row.history), { at: old, by: "user", event: "claim verdict", claim: { slot: 1, verdict: "unsupported", model: "old-model", modelVerdict: "unsupported", list: claimListId(["c1", "c2", "c3"]) } }]), task.id); db.close();
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "new-model", modelVerdict: "supported" });
  const week = (since: number, until: number) => { const s = scorecard(r.file); return dogfoodScorecard({ ...s.input, since, until }).profile!.rows.find(x => x.profile === "research" && x.alias === null)!; };
  const recent = week(Date.now() - 86_400_000, Date.now() + 60_000);
  expect(recent.research!.claims.perTask[0]!.claims![0]).toMatchObject({ modelLabel: "new-model", personVerdict: "supported" });
  const older = week(old - 1000, old + 1000);
  expect(older.research!.claims.perTask[0]!.claims![0]).toMatchObject({ modelLabel: "old-model", personVerdict: "unsupported" });   // the window picks the verdict in force within it, not the newest ever
});

test("recording a verdict while the completion check runs does not discard the check's result (review of #937: claim verdict is quiet history)", async () => {
  const r = await rig({ output: "citations: 2 declared keys, 0 missing" });
  const task = await factCheckTask(r);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  // The check blocks until released; the person records a verdict in the meantime.
  (r.tasks as unknown as { d: { runCheck: () => Promise<unknown> } }).d.runCheck = async () => { await held; return { code: 0, timedOut: false, tail: "citations: 2 declared keys, 0 missing" }; };
  await r.tasks.done("codex", task.id, "checked");
  expect(r.tasks.checksPending()).toBe(1);
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "m", modelVerdict: "supported" });
  release();
  await until(() => r.tasks.checksPending() === 0);
  const history = r.board.get(task.id)!.history;
  expect(history.some(h => h.event === "check finished late")).toBe(false);
  expect(history.findLast(h => h.event === "check passed")).toMatchObject({ checkKey: "fact_check", missingKeys: 0 });
  expect(r.board.get(task.id)!.state).toBe("in_review");                  // the check's result decided what came next, as without a verdict
});

test("a verdict belongs to the claim list it evaluated: replacing or reordering the plan's claims leaves it naming no claim of the new list (review of #937)", async () => {
  const r = await rig();
  const task = await factCheckTask(r, ["alpha", "beta", "gamma"]);
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "m", modelVerdict: "supported" });
  const slot1 = () => scorecard(r.file).row.research!.claims.perTask[0]!.claims![0]!;
  expect(slot1()).toMatchObject({ personVerdict: "supported", agreement: true });
  // The owner replaces the claim in slot 1 with an unrelated one: the old verdict must not be reported for it.
  const accept = (claims: string[]) => r.tasks.accept("codex", task.id, { paths: ["report.md"], sources: ["doi:1"], claims });
  accept(["something else entirely", "beta", "gamma"]);
  expect(slot1()).toEqual({ slot: 1, modelLabel: null, personVerdict: null, agreement: null });
  expect(scorecard(r.file).row.research!.claims.reachedPersonVerdict).toBeNull();
  expect(scorecard(r.file).row.research!.factCheck.agreement.every(a => a.count === null)).toBe(true);
  // A new verdict on the new list counts; reordering the claims invalidates it again.
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "unsupported", model: "m", modelVerdict: "supported" });
  expect(slot1()).toMatchObject({ personVerdict: "unsupported", agreement: false });
  accept(["beta", "something else entirely", "gamma"]);
  expect(slot1()).toMatchObject({ personVerdict: null });
  // Restoring the exact list makes the earlier verdict the one in force again (same ordered list, same id).
  accept(["something else entirely", "beta", "gamma"]);
  expect(slot1()).toMatchObject({ personVerdict: "unsupported" });
  // The record holds an opaque id, never a claim.
  const entry = r.board.get(task.id)!.history.findLast(h => h.event === "claim verdict")!;
  expect(entry.claim!.list).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify(entry)).not.toMatch(/alpha|beta|gamma|something else/);
});

test("a verdict recorded before claim lists were bound cannot be attributed to any list, so it does not count", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  const { Database } = await import("bun:sqlite");
  const db = new Database(r.file); const row = db.query("SELECT history FROM tasks WHERE id = ?").get(task.id) as { history: string };
  db.query("UPDATE tasks SET history = ? WHERE id = ?").run(JSON.stringify([...JSON.parse(row.history), { at: Date.now(), by: "user", event: "claim verdict", claim: { slot: 1, verdict: "supported", model: "m", modelVerdict: "supported" } }]), task.id); db.close();
  expect(scorecard(r.file).row.research!.claims.reachedPersonVerdict).toBeNull();
});

test("a PII task: its verdicts count but name no model, its history entry is a stub, and no claim, key or label text reaches the scorecard", async () => {
  const r = await rig({ piiPaths: ["PRIVATE_PATH_CANARY.md"] });   // a declared path under the PII policy makes the task private
  const task = await r.tasks.propose("codex", { title: "PRIVATE_TITLE_CANARY", class: "fact_check", owner: "codex", plan: { paths: ["PRIVATE_PATH_CANARY.md"], sources: ["PRIVATE_SOURCE"], claims: ["PRIVATE_CLAIM_1", "PRIVATE_CLAIM_2"] } });
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "PRIVATE_MODEL_LABEL", modelVerdict: "supported" });
  expect(r.tasks.isPii(r.board.get(task.id)!)).toBe(true);
  const entry = r.board.get(task.id)!.history.at(-1)!;
  expect("note" in entry).toBe(false);
  const { card, row } = scorecard(r.file);
  expect(row.research!.claims.perTask[0]!.claims![0]).toEqual({ slot: 1, modelLabel: null, personVerdict: "supported", agreement: true });
  const text = JSON.stringify(card) + formatDogfood(card).join("\n");
  expect(text).not.toMatch(/PRIVATE_/);
  // The verdict reply to the console names the slot and verdict only.
  expect(JSON.stringify(r.tasks.recordClaimVerdict("user", task.id, { slot: 2, verdict: "unclear" }).history.at(-1))).not.toMatch(/PRIVATE_/);
});

test("a verdict outside the report window, and an entry with an unbounded or malformed field, never count", async () => {
  const r = await rig();
  const task = await factCheckTask(r);
  r.tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported", model: "m", modelVerdict: "supported" });
  const wide = scorecard(r.file);
  expect(wide.row.research!.claims.reachedPersonVerdict).toBe(1);
  const narrow = { ...wide.input, since: Date.now() + 10_000, until: Date.now() + 20_000 };
  expect(dogfoodScorecard(narrow).profile!.rows.find(row => row.profile === "research" && row.alias === null)?.research?.claims.reachedPersonVerdict ?? null).toBeNull();
  // A hand-edited stored entry that breaks the closed shape is dropped by the reader, not trusted.
  const { Database } = await import("bun:sqlite");
  const db = new Database(r.file);
  const row = db.query("SELECT history FROM tasks WHERE id = ?").get(task.id) as { history: string };
  const history = JSON.parse(row.history) as any[];
  history.push({ at: Date.now(), by: "user", event: "claim verdict", claim: { slot: 3, verdict: "definitely", model: "m" } }, { at: Date.now(), by: "user", event: "claim verdict", claim: { slot: 99, verdict: "supported" } },
    { at: Date.now(), by: "hub", event: "check passed", checkKey: "Bad Key!", missingKeys: -4 });
  db.query("UPDATE tasks SET history = ? WHERE id = ?").run(JSON.stringify(history), task.id); db.close();
  const after = scorecard(r.file).row.research!;
  expect(after.claims.reachedPersonVerdict).toBe(1);                                  // still only the valid slot 1
  expect(after.claims.perTask[0]!.claims![2]).toMatchObject({ personVerdict: null });  // the malformed slot-3 entry is not a verdict
  expect(after.factCheck.selection).toBeNull();                                       // a keyless check entry makes the group unknown
});
