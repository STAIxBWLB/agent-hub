import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, type NoteInput } from "@staix/agent-mem";
import { MemoryClient } from "../src/memory/client.ts";
import { withoutPii } from "../src/hub/memory-policy.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { projectChain } from "@staix/agent-mem";
import { recallFor, trimToTokens, nativeRecall, recallDisplayText, recallMemoryLine, recallMemoryLines, RECALL_LINE_CHARS } from "../src/memory/recall.ts";

test("every peer receives one project context call without author-platform filtering", async () => {
  const calls: unknown[][] = [];
  const client = { contextInject: async (...args: unknown[]) => {
    calls.push(args); return "# [amem] recent curated context\n\n### Curated short-term notes\nclaude-own-note\ncodex-own-note\nlocal-note\njcode-note";
  } } as unknown as MemoryClient;
  for (const peer of ["claude", "codex", "kimi", "local", "jcode", "claude-worker", "jcode-worker"]) {
    const block = await recallFor(peer, client, ["work", "agent-hub"], 2000);
    for (const note of ["claude-own-note", "codex-own-note", "local-note", "jcode-note"]) expect(block).toContain(note);
    expect(block).not.toContain("## from");
  }
  expect(calls).toHaveLength(7);
  expect(calls.every(args => args.length === 1 && JSON.stringify(args[0]) === '["work","agent-hub"]')).toBe(true);
});

test("empty or unavailable project context means no preface for any peer", async () => {
  for (const text of [undefined, "", "# amem unavailable", "# [amem] empty context"]) {
    const client = { contextInject: async () => text } as unknown as MemoryClient;
    for (const peer of ["claude", "codex", "local", "jcode"]) expect(await recallFor(peer, client, ["agent-hub"], 2000)).toBeUndefined();
  }
  expect(await recallFor("claude", new MemoryClient(), ["agent-hub"], 2000)).toBeUndefined();
});

test("trim cuts at a line boundary; the project chain ends with this repo", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const cut = trimToTokens(text, 10);
  expect(cut.length).toBeLessThanOrEqual(30 + "\n(trimmed)".length);
  expect(cut).toEndWith("\n(trimmed)");
  expect(cut.split("\n").at(-2)).toMatch(/^line \d+$/);
  expect(trimToTokens("short", 10)).toBe("short");
  // whatever the checkout directory is called (a CI workspace, a worktree, a renamed clone)
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).stdout.toString().trim();
  expect(projectChain(import.meta.dir).at(-1)).toBe(top.split("/").at(-1)!);
});

test("worktrees use the native parent and parent/worktree aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-hub-recall-"));
  const worktree = join(root, "feature-checkout");
  try {
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root }).exitCode;
    expect(git(["init", "-q"])).toBe(0);
    expect(git(["config", "user.email", "test@example.invalid"])).toBe(0);
    expect(git(["config", "user.name", "agent-hub test"])).toBe(0);
    writeFileSync(join(root, "README"), "initial\n");
    expect(git(["add", "README"])).toBe(0);
    expect(git(["commit", "-qm", "initial"])).toBe(0);
    expect(Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "feature-checkout", worktree], { cwd: root }).exitCode).toBe(0);
    const parent = basename(root);
    expect(projectChain(worktree)).toEqual([parent, `${parent}/${basename(worktree)}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one project budget retains coverage notices before trimming the curated block", async () => {
  const notice = "Coverage: recent curated notes are partial; additional rows were omitted.";
  let calls = 0;
  const client = { contextInject: async () => {
    calls++; return `# [amem] recent curated context\n${notice}\n### Curated short-term notes\n${Array.from({ length: 200 }, (_, i) => `curated filler line ${i}`).join("\n")}`;
  } } as unknown as MemoryClient;
  const block = await recallFor("claude", client, ["agent-hub"], 100);
  expect(calls).toBe(1); expect(block).toContain(notice); expect(block).toContain("### Curated short-term notes");
  expect(block).toContain("(trimmed)"); expect(block).not.toContain("curated filler line 199");
});

test("published amem recall includes local and jcode authors plus Claude and Codex own notes, screened within one project", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-recall-project-context-"));
  let now = Date.now();
  const store = new MemoryStore({ home, now: () => now++ }), project = "recall-project";
  const baseline = loadRouting(home);
  const routing = { ...baseline, signals: { ...baseline.signals, pii_patterns: ["private\\s+marker"] } };
  const note = (peer: string, text: string, key = project) => store.note({ op: "note", project: key, scope: "project", tier: "short", kind: "contract", peer, source: "hub", text, about: [] });
  try {
    const ids = [note("claude", "claude own curated note"), note("codex", "codex own curated note"), note("local", "local authored curated note"), note("jcode", "jcode authored curated note")];
    note("local", "private marker withheld note"); note("jcode", "foreign project note", "another-project");
    let reads = 0;
    const client = new MemoryClient({ project, store, check() {},
      screen: rows => { reads++; return withoutPii(rows, routing, home); },
      publicText: text => withoutPii([{ title: null, text }], routing, home).length === 1 });
    for (const peer of ["claude", "codex", "local", "jcode", "claude-worker"]) {
      const before = reads, block = await recallFor(peer, client, ["caller-label-cannot-select-foreign-project"], 2000);
      for (const id of ids) expect(block).toContain(`mem:${id}`);
      for (const text of ["claude own curated note", "codex own curated note", "local authored curated note", "jcode authored curated note"]) expect(block).toContain(text);
      expect(block).not.toContain("private marker"); expect(block).not.toContain("foreign project note");
      expect(reads - before).toBe(1);
    }
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});


test("recall outcome classification keeps reasons, contracts and fails without treating ordinary mentions as outcomes (#412)", () => {
  const auto = { peer: "claude", task: "agent-hub#7@1792000000000", title: "agent-hub task #7: title" };
  const display = (text: string, kind: "decision" | "contract" | "fail" = "decision", meta: { peer: string; task: string | null; title: string | null } = auto) => recallDisplayText({ text, kind, ...meta });
  expect(display("Task #7 approved by claude: title\naccepted")).toBeUndefined();
  // An agent's own decision that starts like an outcome header is not an automatic note (PR #419 review).
  const own = "Task #7 approved by claude: so we keep the transport";
  expect(display(own, "decision", { peer: "codex", task: "agent-hub#7@1792000000000", title: null })).toBe(own);
  expect(display(own, "decision", { ...auto, task: null })).toBe(own);
  expect(display(own, "decision", { ...auto, task: "agent-hub#8@1792000000000" })).toBe(own);
  expect(display(own, "decision", { ...auto, title: "my decision" })).toBe(own);
  expect(display("Task #7 changes requested by claude: title\n  \n")).toBeUndefined();
  expect(display("Task #7 changes requested by claude: title\r\n  Fix the privacy screen.\r\nKeep the contract.  ")).toBe("Fix the privacy screen.\nKeep the contract.");
  expect(display("Task #7 approved bystander is not an outcome")).toBe("Task #7 approved bystander is not an outcome");
  expect(display("An explicit decision\nTask #7 approved by claude: context")).toBe("An explicit decision\nTask #7 approved by claude: context");
  expect(display("Task #7 approved by claude: a contract", "contract")).toBe("Task #7 approved by claude: a contract");
  expect(display("Task #7 approved by claude: a failed approach", "fail")).toBe("Task #7 approved by claude: a failed approach");
});

test("recall selection from a noisy store retains the exact fail, contract, decision and rejection ids without changing notes (#412)", () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-recall-display-"));
  let now = Date.parse("2026-10-16T00:00:00Z");
  const store = new MemoryStore({ home, now: () => now++ });
  const base: NoteInput = { op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "decision", peer: "codex", text: "", about: [], source: "hub" };
  try {
    const fail = store.note({ ...base, kind: "fail", text: "Do not retry the discarded approach." });
    const contract = store.note({ ...base, kind: "contract", text: "Preserve the privacy boundary." });
    const decision = store.note({ ...base, text: "Keep the existing transport." });
    const outcome = (n: number) => ({ ...base, peer: "claude", task: `agent-hub#${n}@1792000000000`, title: `agent-hub task #${n}: automatic outcome title` });
    for (let i = 0; i < 35; i++) store.note({ ...outcome(i + 1), text: `Task #${i + 1} approved by claude: outcome\nApproved.` });
    store.note({ ...outcome(40), text: "Task #40 changes requested by claude: empty\n " });
    const rejection = store.note({ ...outcome(41), text: "Task #41 changes requested by claude: task title\nAdd the missing guard." });
    const log = join(home, "memory", "log", `${store.machine.id}.jsonl`);
    const before = readFileSync(log, "utf8");
    const notes = store.list({ project: "agent-hub", tier: "long", limit: Number.MAX_SAFE_INTEGER });
    const lines = recallMemoryLines([...notes, ...notes]);
    expect(lines.map(line => /^mem:([a-f0-9]+)/.exec(line)![1])).toEqual([rejection, decision, contract, fail].map(id => id.slice(0, 8)));
    expect(lines[0]).toEndWith("Add the missing guard.");
    expect(lines.join("\n")).not.toContain("approved by");
    expect(lines.join("\n")).not.toContain("automatic outcome title");
    expect(store.get(rejection)!.text).toBe("Task #41 changes requested by claude: task title\nAdd the missing guard.");
    expect(readFileSync(log, "utf8")).toBe(before);
    const block = nativeRecall(lines, 2000, line => line)!;
    expect(block).toContain(contract.slice(0, 8)); expect(block).toContain(fail.slice(0, 8));
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test("recall excerpts keep complete words and Unicode characters under a hard cap with intact memory headers (#412)", () => {
  const note = { id: "1234abcd".repeat(4), kind: "contract" as const, tier: "long" as const, title: null, text: "preserve 한국어 😀 words ".repeat(30) };
  const line = recallMemoryLine(note)!;
  expect(line).toStartWith("mem:1234abcd contract long: ");
  expect(Array.from(line).length).toBeLessThanOrEqual(RECALL_LINE_CHARS);
  expect(line).toEndWith(" ...");
  const excerpt = line.slice("mem:1234abcd contract long: ".length, -4);
  expect(note.text.startsWith(excerpt + " ")).toBe(true);
  expect(recallMemoryLine({ ...note, text: "x".repeat(500) })).toBe("mem:1234abcd contract long: ...");
  expect(trimToTokens("one-indivisible-line".repeat(10), 2)).toBe("\n(trimmed)");
  const capped = nativeRecall([line], 65, value => value)!;
  expect(capped).not.toContain("mem:1234");
});
