import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBlock, continuationOf, splitCommand, type StepRun } from "../../scripts/benchmarks/friction/classify.ts";
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
