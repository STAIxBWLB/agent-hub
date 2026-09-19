import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryClient } from "../src/memory/client.ts";
import { projectChain, recallFor, trimToTokens } from "../src/memory/recall.ts";
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
