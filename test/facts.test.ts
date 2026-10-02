import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyEdit, codexEffect, Facts, MAX_LINES, type FactScope } from "../src/hub/facts.ts";

// issue #108: facts are offered at boundaries and move a peer's view only once acknowledged; a change is someone's only
// with effect evidence.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(scopes: Record<string, FactScope | undefined> = {}, nameable = (_: string) => true) {
  const root = mkdtempSync(join(tmpdir(), "agenthub-facts-"));
  dirs.push(root);
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "other.txt"), "x\n");
  const plans = { claude: [{ task: 2, owner: "codex", text: "paths: a.txt" }], codex: [{ task: 1, owner: "claude", text: "paths: a.txt" }] };
  const scope = (peer: string): FactScope | undefined =>
    peer in scopes ? scopes[peer] : { paths: ["a.txt"], plans: plans[peer as keyof typeof plans] ?? [], task: peer === "claude" ? { id: 1, title: "priority" } : { id: 2, title: "multi-file edit" } };
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope, peers: () => ["claude", "codex"], nameable });
  const write = (file: string, text: string) => writeFileSync(join(root, file), text);
  /** One whole boundary of `peer`: the offer, acknowledged at once (the readback found it). */
  const look = (peer: string) => {
    const o = facts.due(peer);
    if (o) facts.ack(peer, o.id);
    return o;
  };
  /** A Claude Edit through both hooks. */
  const edit = (id: string, file: string, from: string, to: string) => {
    const input = { file_path: join(root, file), old_string: from, new_string: to };
    facts.preTool("claude", id, "Edit", input);
    write(file, readFileSync(join(root, file), "utf8").replace(from, to));
    facts.postTool("claude", id, "Edit", input);
  };
  return { root, facts, write, look, edit };
}

test("a verified Codex patch reaches Claude once, attributed, and only an acknowledgement moves Claude's view", async () => {
  const { root, facts, write, look } = rig();
  look("claude"); // the plan, and a first look at a.txt
  look("codex");
  write("a.txt", "one\nTWO\nthree\n");
  facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: join(root, "a.txt"), kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three" }] });
  const first = facts.due("claude")!;
  expect(first.text.split("\n").slice(1)).toEqual(['a.txt, changed by codex for task #2 "multi-file edit":', "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"]);
  expect(first.unknown).toBe(0);
  // Not acknowledged (a lost hook response, say): the next boundary offers it again.
  const again = facts.due("claude")!;
  expect(again.id).not.toBe(first.id);
  expect(again.text).toContain("+TWO");
  facts.ack("claude", again.id);
  expect(facts.due("claude")).toBeUndefined(); // an acknowledged, unchanged boundary says nothing
  expect(look("codex")).toBeUndefined(); // codex's own verified patch never comes back to it
});

test("a Claude Edit whose result is exactly its input is Claude's; its view moves, and Codex is told who wrote it", async () => {
  const { facts, look, edit } = rig();
  look("claude");
  look("codex");
  edit("t1", "a.txt", "two", "zwei");
  expect(look("claude")).toBeUndefined(); // its own verified edit: nothing to say
  const toCodex = look("codex")!;
  expect(toCodex.text).toContain('a.txt, changed by claude for task #1 "priority":');
  expect(toCodex.text).toContain("+zwei");
  expect(facts.current("codex")).toBe(true);
});

test("Codex's patch to a file another agent changed first does not absorb that change (same file)", async () => {
  const { root, facts, write, look, edit } = rig();
  look("claude");
  look("codex");
  edit("t1", "a.txt", "one", "uno"); // Claude's verified edit at line 1
  write("a.txt", "uno\ntwo\nthree\nfour\n"); // then Codex patches line 4, cleanly
  facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: join(root, "a.txt"), kind: { type: "update" }, diff: "@@ -3 +3,2 @@\n three\n+four" }] });
  const toCodex = look("codex")!;
  expect(toCodex.text).toContain("-one");
  expect(toCodex.text).toContain("+uno");
  expect(toCodex.text).toContain("changed by claude");
});

test("changes during a Bash command, an unreported write and an unverified edit keep their attribution unknown, and nothing is skipped", async () => {
  const { root, facts, write, look, edit } = rig();
  look("claude");
  look("codex");
  // Claude runs a shell command; a change lands meanwhile. Nobody gets the credit, and both see it.
  facts.preTool("claude", "b1", "Bash", { command: "bun test" });
  write("a.txt", "one\ntwo\nthree\nshell\n");
  facts.postTool("claude", "b1", "Bash", { command: "bun test" });
  for (const peer of ["claude", "codex"]) {
    const o = look(peer)!;
    expect(o.unknown).toBe(1);
    expect(o.text).toContain("changed, attribution unknown (concurrent or unreported writes)");
    expect(o.text).toContain("+shell");
  }
  // An edit whose result is not its input applied (someone else wrote in between): unknown, and Claude sees it too.
  const input = { file_path: join(root, "a.txt"), old_string: "shell", new_string: "SHELL" };
  facts.preTool("claude", "t2", "Edit", input);
  write("a.txt", "one\ntwo\nthree\nsomething else\n");
  facts.postTool("claude", "t2", "Edit", input);
  const toClaude = look("claude")!;
  expect(toClaude.text).toContain("attribution unknown");
  // A Codex shell command (an opaque action) is never Codex's by elimination: Codex is shown the change too.
  write("a.txt", "one\n");
  facts.codexItem("codex", { type: "commandExecution", commandActions: [{ type: "unknown", command: "sed -i ..." }], status: "completed" });
  expect(look("codex")!.text).toContain("attribution unknown");
  expect(readdirSync(join(root, ".facts"))).toEqual([]); // the two sides of every diff are gone
});

test("a concurrent write by two agents is shown to both as concurrent, naming the other writer", async () => {
  const { root, facts, write, look, edit } = rig();
  look("claude");
  look("codex");
  edit("t1", "a.txt", "one", "uno"); // verified claude
  write("a.txt", "uno\ntwo\nthree\nfour\n");
  facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: join(root, "a.txt"), kind: { type: "update" }, diff: "@@ -3 +3,2 @@\n three\n+four" }] }); // verified codex
  write("a.txt", "uno\ntwo\nthree\nfour\nfive\n"); // and someone unreported
  const o = look("claude")!;
  expect(o.text).toContain("a.txt, changed, attribution unknown (concurrent or unreported writes; codex also wrote it):");
  expect(o.text).not.toContain("-one"); // its own verified edit moved its view already: not shown again
  expect(o.text).toContain("+five");
});

test("a Codex read action, which may be partial, never counts as having seen a change", async () => {
  const { root, facts, look, edit } = rig();
  look("claude");
  look("codex");
  edit("t1", "a.txt", "three", "drei");
  facts.codexItem("codex", { type: "commandExecution", status: "completed", commandActions: [{ type: "read", command: "sed -n 1,1p a.txt", path: join(root, "a.txt") }] });
  expect(facts.current("codex")).toBe(false);
  expect(look("codex")!.text).toContain("+drei");
});

test("plans are offered until acknowledged, and an accept that showed them needs none, for exactly the tasks it showed", async () => {
  const { facts } = rig();
  const first = facts.due("claude")!;
  expect(first.plans).toBe(1);
  expect(first.text).toContain("task #2 (owner codex) plan: paths: a.txt");
  expect(facts.due("claude")!.plans).toBe(1); // not acknowledged yet
  facts.ack("claude", first.id);
  expect(facts.due("claude")).toBeUndefined(); // acknowledging an older offer still covers its plans
  facts.sawPlans("codex", [7]); // an accept that showed another task's plan
  expect(facts.due("codex")!.plans).toBe(1);
  facts.sawPlans("codex", [1]);
  expect(facts.due("codex")?.plans ?? 0).toBe(0);
});

test("a long change is cut at the line budget, the cut files are named, and acknowledging moves the view past them", async () => {
  const { facts, write, look } = rig();
  look("claude");
  look("codex");
  write("a.txt", Array.from({ length: MAX_LINES + 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
  facts.codexItem("codex", { type: "commandExecution", commandActions: [{ type: "unknown" }] });
  const o = look("claude")!;
  expect(o.text.split("\n").filter((l) => /^[+-]/.test(l))).toHaveLength(MAX_LINES);
  expect(o.text).toMatch(/\(\d+ more changed line\(s\) not shown; read a\.txt\)$/);
  expect(look("claude")).toBeUndefined();
});

test("no scope means no facts; a file whose name matches a PII pattern is never named", async () => {
  const off = rig({ claude: undefined });
  expect(off.facts.due("claude")).toBeUndefined();
  const hidden = rig({}, (s) => !s.includes("a.txt"));
  hidden.look("claude");
  hidden.look("codex");
  hidden.write("a.txt", "secret change\n");
  hidden.facts.codexItem("codex", { type: "commandExecution", commandActions: [{ type: "unknown" }] });
  const o = hidden.facts.due("claude");
  expect(o?.text ?? "").not.toContain("a.txt");
  expect(o?.text ?? "").not.toContain("secret");
});

test("only regular files inside the project are read: no path out of it, no symlink, no fifo, no large file's contents", async () => {
  const outside = mkdtempSync(join(tmpdir(), "agenthub-outside-"));
  dirs.push(outside);
  writeFileSync(join(outside, "secret.env"), "TOKEN=1\n");
  const root = mkdtempSync(join(tmpdir(), "agenthub-facts-"));
  dirs.push(root);
  symlinkSync(join(outside, "secret.env"), join(root, "link.env"));
  spawnSync("mkfifo", [join(root, "pipe")]);
  writeFileSync(join(root, "big.bin"), "x".repeat(300 * 1024));
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["../" + outside.split("/").pop() + "/secret.env", "link.env", "pipe", "big.bin"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  expect(facts.rel(join(outside, "secret.env"))).toBeUndefined();
  expect(facts.rel(join(root, "link.env"))).toBeUndefined(); // it resolves outside the project
  facts.due("claude");
  writeFileSync(join(outside, "secret.env"), "TOKEN=2\n");
  writeFileSync(join(root, "big.bin"), "y".repeat(300 * 1024));
  const o = facts.due("claude");
  expect(o?.text ?? "").not.toContain("TOKEN");
  expect(o?.text ?? "").toContain("big.bin");
  expect(o?.text ?? "").toContain("too large to show; read the file");
  expect(o?.text ?? "").not.toContain("yyyy");
});

test("reset (a PII task opened and closed) never shows a diff across it; work from before tracking is named as not covered", async () => {
  const { facts, write, look } = rig({ claude: { paths: ["a.txt"], plans: [], since: Date.now() - 60_000 } });
  look("claude");
  facts.reset(); // tracking stopped while PII was open
  write("a.txt", "patient record\n");
  const o = facts.due("claude")!;
  expect(o.coverage).toBe(true);
  expect(o.text).toContain("changes before that are not covered; read a.txt");
  expect(o.text).not.toContain("patient");
  facts.ack("claude", o.id);
  expect(facts.due("claude")).toBeUndefined();
});

test("a new native session starts its views over; an acknowledgement from another run, or an older offer, moves nothing back", async () => {
  const { facts, write, look } = rig();
  facts.session("claude", "s1");
  look("claude");
  look("codex");
  write("a.txt", "changed\n");
  facts.codexItem("codex", { type: "commandExecution", commandActions: [{ type: "unknown" }] });
  const older = facts.due("claude")!;
  write("a.txt", "changed twice\n");
  facts.codexItem("codex", { type: "commandExecution", commandActions: [{ type: "unknown" }] });
  const newer = facts.due("claude")!;
  expect(facts.ack("claude", "other-run-1")).toBeUndefined();
  facts.ack("claude", newer.id);
  expect(facts.ack("claude", older.id)).toBeUndefined(); // covered by the newer one
  expect(facts.due("claude")).toBeUndefined();
  facts.session("claude", "s2"); // a new session: what s1 saw says nothing
  const fresh = facts.due("claude")!;
  expect(fresh.plans).toBe(1);
});

test("applyEdit and codexEffect compute effects exactly or not at all", () => {
  expect(applyEdit("a b a", "Edit", { old_string: "a", new_string: "c" })).toBeUndefined(); // ambiguous
  expect(applyEdit("a b a", "Edit", { old_string: "a", new_string: "c", replace_all: true })).toBe("c b c");
  expect(applyEdit("a b", "MultiEdit", { edits: [{ old_string: "a", new_string: "x" }, { old_string: "b", new_string: "y" }] })).toBe("x y");
  expect(applyEdit(undefined, "Write", { content: "new" })).toBe("new");
  expect(applyEdit("x", "NotebookEdit", {})).toBeUndefined();
  const diff = (a: string, b: string) => (a === "one\n" && b === "two\n" ? ["@@ -1 +1 @@", "-one", "+two"] : []);
  expect(codexEffect("one\n", { hash: "h", text: "two\n" }, { kind: { type: "update" }, diff: "@@ -1 +1 @@\n-one\n+two" }, diff)).toBe(true);
  expect(codexEffect("one\n", { hash: "h", text: "two\n" }, { kind: { type: "update" }, diff: "@@ -1 +1 @@\n-one\n+three" }, diff)).toBe(false);
  expect(codexEffect(undefined, { hash: "h", text: "new\n" }, { kind: { type: "add" }, diff: "new" }, diff)).toBe(true);
  expect(codexEffect("x", { hash: "missing" }, { kind: { type: "delete" } }, diff)).toBe(true);
});

test("the tree hash covers only contained files and changes with them", () => {
  const { facts, write } = rig();
  const before = facts.tree(["a.txt", "../escape.txt"]);
  expect(facts.tree(["../escape.txt", "a.txt"])).toBe(before);
  write("a.txt", "changed\n");
  expect(facts.tree(["a.txt"])).not.toBe(before);
});

test("a directory swapped for a link out of the project after a file in it was recorded is never followed", async () => {
  const outside = mkdtempSync(join(tmpdir(), "agenthub-outside-"));
  dirs.push(outside);
  writeFileSync(join(outside, "f.txt"), "SECRET=1\n");
  const root = mkdtempSync(join(tmpdir(), "agenthub-facts-"));
  dirs.push(root);
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "d", "f.txt"), "inside\n");
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["d/f.txt"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  facts.due("claude"); // its first look at d/f.txt
  rmSync(join(root, "d"), { recursive: true });
  symlinkSync(outside, join(root, "d"));
  const o = facts.due("claude");
  expect(o?.text ?? "").not.toContain("SECRET");
});

test("a directory a task names stands for git's changed and new files under it, in facts and in the integration target", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-facts-"));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "x.ts"), "x\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["src"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  const before = facts.tree(["src"]);
  writeFileSync(join(root, "src", "x.ts"), "x changed\n");
  expect(facts.tree(["src"])).not.toBe(before);
  writeFileSync(join(root, "src", "new.ts"), "n\n");
  // Files that stand in for the directory are compared with HEAD on their first look: another agent's first change
  // there is shown, not absorbed.
  const o = facts.due("claude")!;
  expect(o.text).toContain("src/x.ts, changed, attribution unknown");
  expect(o.text).toContain("+x changed");
  expect(o.text).toContain("src/new.ts (created)");
  facts.ack("claude", o.id);
  writeFileSync(join(root, "src", "new.ts"), "n2\n");
  const next = facts.due("claude")!;
  expect(next.text).toContain("src/new.ts, changed, attribution unknown");
  expect(next.text).not.toContain("src/x.ts");
  // Put back to HEAD's bytes: git may stop listing it, but whoever saw the change is shown the way back.
  facts.ack("claude", next.id);
  writeFileSync(join(root, "src", "x.ts"), "x\n");
  git("status", "--short");
  expect(facts.due("claude")!.text).toContain("-x changed");
});

test("history beyond the cap is attribution unknown, and a file that falls out of the touched list is named once", async () => {
  const { root, facts, write, look, edit } = rig();
  look("claude");
  look("codex");
  for (let i = 0; i < 70; i++) edit(`e${i}`, "a.txt", i ? `v${i - 1}` : "one", `v${i}`); // claude's own verified edits
  const o = look("codex")!;
  expect(o.text).toContain("attribution unknown"); // the cap dropped the start of what codex has not seen
  for (let i = 0; i < 70; i++) {
    write(`f${i}.txt`, "x\n");
    facts.preTool("claude", `r${i}`, "Read", { file_path: join(root, `f${i}.txt`) });
    facts.postTool("claude", `r${i}`, "Read", { file_path: join(root, `f${i}.txt`) });
  }
  const told = facts.due("claude")!;
  expect(told.text).toContain("no longer tracked (more than 64 files touched): a.txt");
  expect(told.coverage).toBe(true);
});

test("a default Claude Read moves the view only when Read returns the whole file", async () => {
  const { root, facts, write, look } = rig();
  look("claude");
  const read = (id: string, input: Record<string, unknown> = {}) => {
    facts.preTool("claude", id, "Read", { file_path: join(root, "a.txt"), ...input });
    facts.postTool("claude", id, "Read", { file_path: join(root, "a.txt"), ...input });
  };
  write("a.txt", "one\ntwo\nthree\nfour\n");
  read("r1");
  expect(facts.due("claude")).toBeUndefined(); // a whole read of the change: seen
  // Read stops at 2000 lines, and cuts lines at 2000 characters: neither read says what the peer saw.
  write("a.txt", Array.from({ length: 2400 }, (_, i) => `line ${i}`).join("\n"));
  read("r2");
  expect(facts.due("claude")?.text).toContain("more changed line(s) not shown; read a.txt");
  write("a.txt", `${"x".repeat(2500)}\n`);
  read("r3");
  expect(facts.due("claude")?.text).toContain("a.txt");
  read("r4", { offset: 1, limit: 10 });
  expect(facts.due("claude")?.text).toContain("a.txt");
});

test("a diff that matches a PII pattern is not shown, and a file whose name does is counted, not named", async () => {
  const secret = /900101-1234567|secret\.txt/;
  const { facts, write, look } = rig({ claude: { paths: ["a.txt", "secret.txt"], plans: [] } }, (t) => !secret.test(t));
  write("secret.txt", "x\n");
  look("claude");
  write("a.txt", "one\ntwo\nthree\n900101-1234567\n");
  write("secret.txt", "y\n");
  const o = facts.due("claude")!;
  expect(o.text).toContain("a.txt, changed, attribution unknown");
  expect(o.text).toContain("(not shown: the change matches a private-data pattern; read the file)");
  expect(o.text).toContain("1 more changed file(s) in your scope, not named here");
  expect(o.text).not.toMatch(secret);
  facts.ack("claude", o.id);
  expect(facts.current("claude")).toBe(true); // what it was told of counts as seen, the unnamed file too
});

test("a change landing between a partial read and the next boundary is shown, not absorbed into a first look", async () => {
  const { root, facts, write, look } = rig();
  look("claude");
  look("codex");
  write("other.txt", "x\ny\n");
  const input = { file_path: join(root, "other.txt"), offset: 1, limit: 1 }; // a partial read: no view of other.txt
  facts.preTool("claude", "r1", "Read", input);
  facts.postTool("claude", "r1", "Read", input);
  write("other.txt", "x\ny\ncodex\n");
  facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: join(root, "other.txt"), kind: { type: "update" }, diff: "@@ -2 +2,2 @@\n y\n+codex" }] });
  const o = look("claude")!;
  expect(o.text).toContain("other.txt, changed by codex");
  expect(o.text).toContain("+codex");
  expect(facts.current("claude")).toBe(true);
});

test("a directory's staged changes count, more than the cap are said to be cut, and denylisted files are never read or shown", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-facts-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "x.ts"), "x\n");
  writeFileSync(join(root, "src", ".env"), "TOKEN=one\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["src", ".env", ".git/config"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  expect(facts.rel(".git/config")).toBeUndefined();
  expect(facts.rel("src/.env")).toBeUndefined();
  const staged = facts.tree(["src"]);
  writeFileSync(join(root, "src", "x.ts"), "x staged\n");
  git("add", "src/x.ts");
  expect(facts.tree(["src"])).not.toBe(staged); // staged, not only worktree changes, move the target
  facts.due("claude"); // first looks
  writeFileSync(join(root, "src", "x.ts"), "x again\n");
  writeFileSync(join(root, "src", ".env"), "TOKEN=two\n");
  const o = facts.due("claude")!;
  expect(o.text).toContain("src/x.ts");
  expect(o.text).not.toContain("TOKEN");
  expect(o.text).not.toContain(".env");
  for (let i = 0; i < 205; i++) writeFileSync(join(root, "src", `n${i}.ts`), "n\n");
  expect(facts.due("claude")!.text).toContain("more than 200 files changed under src: the rest are not shown");
});

test("the integration target counts the files the members touched, a symbol-only overlap too", async () => {
  const { root, facts, write } = rig();
  const input = { file_path: join(root, "other.txt"), old_string: "x", new_string: "y" };
  facts.preTool("claude", "e1", "Edit", input);
  write("other.txt", "y\n");
  facts.postTool("claude", "e1", "Edit", input);
  const window = [{ peer: "claude", since: 0 }];
  const before = facts.tree([], window);
  expect(facts.tree([], [])).not.toBe(before); // other.txt is in it only through what claude wrote
  write("other.txt", "z\n");
  expect(facts.tree([], window)).not.toBe(before);
  // Writes outside a member's window (before it joined, after it settled) are not the cohort's.
  expect(facts.tree([], [{ peer: "claude", since: Date.now() + 1000 }])).toBe(facts.tree([], []));
  expect(facts.tree([], [{ peer: "claude", since: 0, until: 1 }])).toBe(facts.tree([], []));
});

test("reading a file never moves an integration target; a cut is said once; a nested .git is never read; a staged move shows both names", async () => {
  const { root, facts, write } = rig();
  const read = (id: string, file: string) => {
    facts.preTool("claude", id, "Read", { file_path: join(root, file) });
    facts.postTool("claude", id, "Read", { file_path: join(root, file) });
  };
  const before = facts.tree(["a.txt"], [{ peer: "claude", since: 0 }]);
  read("r1", "other.txt");
  facts.codexItem("codex", { type: "commandExecution", status: "completed", commandActions: [{ type: "read", path: join(root, "other.txt") }] });
  expect(facts.tree(["a.txt"], [{ peer: "claude", since: 0 }, { peer: "codex", since: 0 }])).toBe(before); // what they only looked at is not their work
  mkdirSync(join(root, "vendor", "lib", ".git"), { recursive: true });
  writeFileSync(join(root, "vendor", "lib", ".git", "config"), "[remote]\n");
  expect(facts.rel("vendor/lib/.git/config")).toBeUndefined();
  write("other.txt", "x\n");
  expect(facts.pending("claude")).toEqual([]);
  const integration = facts.due("claude", undefined, true);
  expect(integration).toBeDefined();
  expect(facts.pending("claude").at(-1)).toMatchObject({ id: integration!.id, done: true }); // waits for the next done, not a readback
  facts.drop("claude", integration!.id);
  expect(facts.pending("claude")).toEqual([]);
});

test("a directory cut at the cap is said once per peer, and a staged move lists the old name as well as the new", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-facts-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "old.ts"), "o\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["src"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  git("mv", "src/old.ts", "src/new.ts");
  const moved = facts.tree(["src"]);
  writeFileSync(join(root, "src", "old.ts"), "again\n"); // the old name exists again: only a hash that covers it changes
  expect(facts.tree(["src"])).not.toBe(moved);
  for (let i = 0; i < 205; i++) writeFileSync(join(root, "src", `n${i}.ts`), "n\n");
  const first = facts.due("claude")!;
  expect(first.text).toContain("more than 200 files changed under src");
  facts.drop("claude", first.id); // a refused steer: it never went in, so it is said again
  const again = facts.due("claude")!;
  expect(again.text).toContain("more than 200 files changed under src");
  facts.ack("claude", again.id);
  expect(facts.due("claude")?.text ?? "").not.toContain("more than 200 files changed"); // said once it was read back
  facts.session("claude", "s1");
  facts.session("claude", "s2"); // a new session never heard it
  expect(facts.due("claude")?.text ?? "").toContain("more than 200 files changed under src");
});

test("a tracked file edited and put back is no change, whatever git's stat data says", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-facts-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "x.ts"), "x\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const facts = new Facts({ root, tmp: join(root, ".facts"), instance: "i1", scope: () => ({ paths: ["src"], plans: [] }), peers: () => ["claude"], nameable: () => true });
  const clean = facts.tree(["src"]);
  writeFileSync(join(root, "src", "x.ts"), "edited\n");
  writeFileSync(join(root, "src", "x.ts"), "x\n"); // put back: same bytes, new stat data, index not refreshed
  expect(facts.tree(["src"])).toBe(clean);
  git("status", "--short"); // an agent's own git command refreshes the index
  expect(facts.tree(["src"])).toBe(clean);
});
