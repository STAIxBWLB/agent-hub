import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_HEADER, Facts, MAX_LINES, type FactScope } from "../src/hub/facts.ts";

// issue #108: what other agents changed in an owner's files since it last looked, at its tool calls.
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
  const facts = new Facts({ root, tmp: join(root, ".facts"), scope, peers: () => ["claude", "codex"], nameable });
  const write = (file: string, text: string) => writeFileSync(join(root, file), text);
  return { root, facts, write };
}

test("a Codex patch reaches Claude once, as a diff naming codex and its task; then nothing until the next change", () => {
  const { root, facts, write } = rig();
  facts.sawPlans("claude");
  expect(facts.due("claude", false)).toBeUndefined(); // the first look only records the view
  write("a.txt", "one\nTWO\nthree\n");
  facts.wrote("codex", join(root, "a.txt"));
  const due = facts.due("claude", false)!;
  expect(due.files).toBe(1);
  expect(due.text).toBe([FACTS_HEADER, 'a.txt, changed by codex for task #2 "multi-file edit":', "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"));
  expect(facts.due("claude", false)).toBeUndefined();
});

test("a Claude edit and a Claude shell write each reach Codex as Claude's; Codex's own unreported change is its own", () => {
  const { root, facts, write } = rig();
  facts.sawPlans("codex");
  facts.due("codex", true);
  write("a.txt", "one\ntwo\nthree\nfour\n");
  facts.wrote("claude", join(root, "a.txt"));
  expect(facts.due("codex", true)!.text).toContain('a.txt, changed by claude for task #1 "priority":');
  facts.beforeShell("claude");
  write("a.txt", "one\ntwo\nthree\nfour\nfive\n");
  facts.afterShell("claude");
  expect(facts.due("codex", true)!.text).toContain("+five");
  // Codex changes the file through a shell command nobody reports: from its side that is its own change.
  write("a.txt", "zero\n");
  expect(facts.due("codex", true)).toBeUndefined();
  // From Claude's side the same change is another agent's.
  facts.due("claude", false); // claude's first look (and the plan it has not seen)
  write("a.txt", "zero\nmore\n");
  expect(facts.due("claude", false)!.text).toContain("a.txt, changed by another agent:");
});

test("an agent's own writes, unchanged files and files outside its scope give no fact", () => {
  const { root, facts, write } = rig();
  facts.sawPlans("claude");
  facts.due("claude", false);
  write("a.txt", "mine\n");
  facts.wrote("claude", join(root, "a.txt"));
  expect(facts.due("claude", false)).toBeUndefined();
  write("other.txt", "changed by someone\n");
  expect(facts.due("claude", false)).toBeUndefined(); // other.txt is in nobody's scope
  facts.read("claude", join(root, "other.txt")); // reading it brings it into scope at its current content
  expect(facts.due("claude", false)).toBeUndefined();
  write("other.txt", "changed again\n");
  expect(facts.due("claude", false)!.text).toContain("other.txt, changed by another agent:");
  expect(facts.rel("/definitely/outside")).toBeUndefined();
});

test("plans of overlapping tasks are reported once, and not at all after an accept already showed them", () => {
  const { facts } = rig();
  const first = facts.due("claude", false)!;
  expect(first.plans).toBe(1);
  expect(first.text).toContain("task #2 (owner codex) plan: paths: a.txt");
  expect(facts.due("claude", false)).toBeUndefined();
  facts.sawPlans("codex");
  expect(facts.due("codex", true)).toBeUndefined();
});

test("a long change is cut at the line budget and the rest is counted", () => {
  const { root, facts, write } = rig();
  facts.sawPlans("claude");
  facts.due("claude", false);
  write("a.txt", Array.from({ length: MAX_LINES + 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
  facts.wrote("codex", join(root, "a.txt"));
  const text = facts.due("claude", false)!.text;
  expect(text.split("\n").filter((l) => /^[+-]/.test(l))).toHaveLength(MAX_LINES);
  expect(text).toMatch(/\(\d+ more changed line\(s\) not shown; read the file\)$/);
});

test("no scope means no facts, and a file whose name matches a PII pattern is never named", () => {
  const off = rig({ claude: undefined });
  expect(off.facts.due("claude", false)).toBeUndefined();
  const hidden = rig({}, (s) => !s.includes("a.txt"));
  hidden.facts.sawPlans("claude");
  hidden.facts.due("claude", false);
  hidden.write("a.txt", "secret change\n");
  hidden.facts.wrote("codex", join(hidden.root, "a.txt"));
  expect(hidden.facts.due("claude", false)).toBeUndefined();
});

test("the two sides of a diff do not outlive it", () => {
  const { root, facts, write } = rig();
  facts.sawPlans("claude");
  facts.due("claude", false);
  write("a.txt", "changed\n");
  facts.wrote("codex", join(root, "a.txt"));
  facts.due("claude", false);
  expect(readdirSync(join(root, ".facts"))).toEqual([]);
});
