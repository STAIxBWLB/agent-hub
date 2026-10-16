import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, type NoteInput } from "@staix/agent-mem";
import { MemoryClient } from "../src/memory/client.ts";
import { projectChain } from "@staix/agent-mem";
import { recallFor, trimToTokens, nativeRecall, recallDisplayText, recallMemoryLine, recallMemoryLines, RECALL_LINE_CHARS } from "../src/memory/recall.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";

const OBS = { claude: ["1 claude-line"], codex: ["2 codex-line"], kimi: ["3 kimi-line"] };

test("kimi gets every platform in one call; codex gets the other platforms only, without the repeated legend", async () => {
  const fake = startFakeMemWorker(OBS);
  const client = new MemoryClient(fake.url);

  const kimi = await recallFor("kimi", client, ["work", "agent-hub"], 2000);
  expect(kimi).toContain("claude-line");
  expect(kimi).toContain("kimi-line");
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.query).toBe("?projects=work%2Cagent-hub");

  const codex = (await recallFor("codex", client, ["agent-hub"], 2000))!;
  expect(codex).toContain("## from claude sessions");
  expect(codex).toContain("kimi-line");
  expect(codex).not.toContain("codex-line");
  expect(codex).not.toContain("Legend");
  fake.stop();
});

test("no context, an unknown project and a stopped worker all mean no preface", async () => {
  const empty = startFakeMemWorker();
  expect(await recallFor("kimi", new MemoryClient(empty.url), ["agent-hub"], 2000)).toBeUndefined();
  empty.stop();
  const fake = startFakeMemWorker(OBS);
  expect(await recallFor("kimi", new MemoryClient(fake.url), ["nonexistent"], 2000)).toBeUndefined();
  fake.stop();
  expect(await recallFor("claude", new MemoryClient(fake.url, 100), ["agent-hub"], 2000)).toBeUndefined();
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

test("the token budget is split per platform so the first one cannot crowd out the rest", async () => {
  const fake = startFakeMemWorker({
    codex: Array.from({ length: 200 }, (_, i) => `9${i} codex filler line ${i}`),
    kimi: ["3 kimi-line"],
  });
  const block = (await recallFor("claude", new MemoryClient(fake.url), ["agent-hub"], 100))!;
  expect(block).toContain("(trimmed)");
  expect(block).toContain("## from kimi sessions\n### Sep 19, 2026\n3 kimi-line");
  fake.stop();
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
