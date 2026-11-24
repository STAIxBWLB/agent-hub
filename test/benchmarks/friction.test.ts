import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBlock, continuationOf, namedTool, splitCommand, type StepRun } from "../../scripts/benchmarks/friction/classify.ts";
import { JOURNEYS } from "../../scripts/benchmarks/friction/journeys.ts";
import { runCorpus, sandboxEnv } from "../../scripts/benchmarks/friction/run.ts";

const run = (exitCode: number, output: string, argv: string[] = ["x"]): StepRun => ({ argv, exitCode, output });
const never = async (): Promise<StepRun> => { throw new Error("must not run"); };

test("a continuation is read from a run-in word, a backtick span or a line, and prose after it is cut", () => {
  expect(continuationOf("ahub: no hub running (run: ahub up)")?.argv).toEqual(["up"]);
  expect(continuationOf("project is not initialized; run ahub init there first")?.argv).toEqual(["init"]);
  expect(continuationOf("try `ahub task claim 7 1 supported` to continue")?.argv).toEqual(["task", "claim", "7", "1", "supported"]);
  expect(continuationOf("nothing to run here")).toBeUndefined();
});

test("a continuation with a placeholder, a shell metacharacter or an unbalanced quote never parses", () => {
  expect(continuationOf("run ahub task claim <id>")).toBeUndefined();
  expect(continuationOf("run ahub up && rm -rf x")).toBeUndefined();
  expect(splitCommand("ahub say 'unclosed")).toBeUndefined();
  expect(splitCommand("ahub say 'two words'")).toEqual(["ahub", "say", "two words"]);
});

test("a block whose continuation clears it is in_band, and one that does not is a dead_end", async () => {
  const block = run(1, "refused; run ahub fix");
  let ran: string[] | undefined;
  const clears = await classifyBlock(block, async argv => { ran = argv; return run(0, "ok", argv); }, async () => run(0, "ok"));
  expect(clears.class).toBe("in_band"); expect(ran).toEqual(["fix"]);
  // the seeded dead end of AC3: the refusal names a command that does not clear the block
  const seeded = await classifyBlock(block, async argv => run(0, "did nothing", argv), async () => run(1, "refused; run ahub fix"));
  expect(seeded.class).toBe("dead_end"); expect(seeded.continuation).toBe("ahub fix");
});

test("a block with no continuation is out_of_band, and one that says it is closed on purpose is by_design", async () => {
  expect((await classifyBlock(run(1, "it did not work"), never, never)).class).toBe("out_of_band");
  expect((await classifyBlock(run(1, "closed by design; person only"), never, never)).class).toBe("by_design");
});

test("a block that names a hub tool is reported with it and never runs it", async () => {
  expect(namedTool("call hub_task_done with the head")).toBe("hub_task_done");
  expect(namedTool("nothing here")).toBeUndefined();
  expect((await classifyBlock(run(1, "call hub_task_done with the head"), never, never)).namesTool).toBe("hub_task_done");
});

test("every journey has a guard reference, and a skipped one says why", () => {
  expect(JOURNEYS.length).toBeGreaterThanOrEqual(10);
  for (const j of JOURNEYS) {
    expect(j.guards.length).toBeGreaterThan(0);
    if (j.skip !== undefined) expect(j.skip.length).toBeGreaterThan(20);
  }
  expect(JOURNEYS.filter(j => j.skip !== undefined).length).toBeGreaterThan(0);
});

test("the sandbox environment inherits nothing from the person's shell except PATH", () => {
  const env = sandboxEnv("/r", "/r/home");
  expect(Object.keys(env).sort()).toEqual(["AGENTHUB_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "HOME", "NO_COLOR", "PATH", "TERM", "TMPDIR"].filter(key => key in env).sort());
  expect(env.HOME).toBe("/r/home"); expect(env.AGENTHUB_HOME).toBe("/r/home/hub");
});

test("a corpus run is offline, isolated and deterministic: two runs of the same binary give identical class counts (AC1, AC4)", async () => {
  const entry = join(import.meta.dir, "../../src/cli/main.js");
  const first = await runCorpus(JOURNEYS, entry), second = await runCorpus(JOURNEYS, entry);
  expect(first.totals).toEqual(second.totals);
  expect(first.journeys.flatMap(row => row.steps.filter(step => step.unexpected))).toEqual([]);
  expect(first.binary.version).toMatch(/^\d+\.\d+\.\d+/); expect(first.binary.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(first.journeys)).not.toContain(process.env.HOME ?? "\0");
}, 120_000);

test("a binary that does not run fails the run instead of falling back to another one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "friction-bad-"));
  try {
    const bad = join(dir, "ahub.js"); writeFileSync(bad, "process.exit(3);");
    await expect(runCorpus(JOURNEYS, bad)).rejects.toThrow("does not run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const report = (corpusVersion: number, blocks: Record<string, Partial<Record<"in_band" | "out_of_band" | "dead_end" | "by_design", number>>>, digest = "d".repeat(64)) => {
  const zero = { in_band: 0, out_of_band: 0, dead_end: 0, by_design: 0 }, totals = { ...zero };
  const journeys = Object.entries(blocks).map(([id, row]) => { const full = { ...zero, ...row }; for (const name of Object.keys(zero) as (keyof typeof zero)[]) totals[name] += full[name]; return { id, guards: "g", blocks: full, steps: [] }; });
  return { corpusVersion, binary: { path: "/x", version: "1.0.0", digest }, totals, journeys };
};

test("compare reports the class deltas per journey and names both binaries (AC5)", async () => {
  const { compareReports, renderComparison } = await import("../../scripts/benchmarks/friction/compare.ts");
  const a = report(1, { alpha: { dead_end: 2 }, beta: { in_band: 1 }, old: { out_of_band: 1 } }, "a".repeat(64));
  const b = report(1, { alpha: { dead_end: 1, in_band: 1 }, beta: { in_band: 1 }, fresh: { dead_end: 1 } }, "b".repeat(64));
  const result = compareReports(a, b);
  expect(result.totals).toEqual({ in_band: 1, out_of_band: -1, dead_end: 0, by_design: 0 });
  expect(result.journeys.map(row => row.id)).toEqual(["alpha", "beta", "fresh", "old"]);
  const text = renderComparison(result);
  expect(text).toContain("a: 1.0.0 (aaaaaaaaaaaa)"); expect(text).toContain("b: 1.0.0 (bbbbbbbbbbbb)");
  expect(text).toContain("alpha: in_band +1, dead_end -1"); expect(text).toContain("beta: no change");
  expect(text).toContain("fresh (new in b): dead_end +1"); expect(text).toContain("old (gone in b): out_of_band -1");
});

test("compare refuses reports of different corpus versions", async () => {
  const { compareReports } = await import("../../scripts/benchmarks/friction/compare.ts");
  expect(() => compareReports(report(1, { alpha: {} }), report(2, { alpha: {} }))).toThrow("refusing to compare corpus version 1 with 2");
});

test("the nightly workflow has read-only permissions, no secret and an uploaded report", () => {
  const text = readFileSync(join(import.meta.dir, "../../.github/workflows/friction.yml"), "utf8");
  expect(text).toMatch(/^permissions:\n  contents: read\n/m);
  expect(text).not.toMatch(/secrets\.|contents: write|issues: write|pull-requests: write|id-token/);
  expect(text).toContain("upload-artifact"); expect(text).toContain("scripts/benchmarks/friction/run.ts --binary src/cli/main.js");
});
