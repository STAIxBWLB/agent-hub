// Friction runner (#1644 T1). Drives a built `ahub` entry as a subprocess in a throwaway HOME, state dir and git repository,
// offline and with no model call. It never instruments the product: a binary path is an argument, so an old release and
// the current build run the same corpus.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyBlock, isBlock, type Classification, type FrictionClass, type StepRun } from "./classify.ts";

export interface Step { argv: string[]; /** the step is expected to be blocked; an unexpected block or an unexpected success is a corpus error */ expectBlock?: boolean }
export interface Journey { id: string; guards: string; steps: Step[]; /** commands run once before the steps in the isolated project */ setup?: string[][] }
export interface StepResult { argv: string[]; exitCode: number; class?: FrictionClass; continuation?: string; unexpected?: string }
export interface JourneyResult { id: string; guards: string; blocks: Record<FrictionClass, number>; steps: StepResult[] }
export interface Report { corpusVersion: number; binary: { path: string; version: string; digest: string }; totals: Record<FrictionClass, number>; journeys: JourneyResult[] }

export const CORPUS_VERSION = 1;
const CLASSES: FrictionClass[] = ["in_band", "out_of_band", "dead_end", "by_design"];
const zero = (): Record<FrictionClass, number> => ({ in_band: 0, out_of_band: 0, dead_end: 0, by_design: 0 });
const STEP_TIMEOUT_MS = 30_000;

export interface Sandbox { root: string; home: string; project: string; run(argv: string[]): Promise<StepRun>; cleanup(): Promise<void> }

/** A clean environment: nothing inherited from the person's shell except what a CLI needs to start. */
export function sandboxEnv(root: string, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, AGENTHUB_HOME: join(home, "hub"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", NO_COLOR: "1", TERM: "dumb", TMPDIR: root };
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

export function createSandbox(binary: string): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-friction-")));
  const home = join(root, "home"), project = join(root, "project"), remote = join(root, "remote.git");
  for (const dir of [home, project, remote]) mkdirSync(dir);
  const git = (cwd: string, ...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd, env: sandboxEnv(root, home), stdout: "pipe", stderr: "pipe" });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr.toString()}`);
  };
  git(remote, "init", "-q", "--bare");
  git(project, "init", "-q"); git(project, "remote", "add", "origin", remote);
  git(project, "-c", "user.name=friction", "-c", "user.email=friction@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  const entry = resolve(binary);
  return {
    root, home, project,
    async run(argv) {
      const child = Bun.spawn([process.execPath, entry, ...argv], { cwd: project, env: sandboxEnv(root, home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { argv, exitCode: code, output: `${out}${err}`.trim() };
      } finally { clearTimeout(timer); }
    },
    // A journey may start a hub: stop it before the tree goes, or it outlives the run.
    async cleanup() { try { await this.run(["kill"]); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

export async function runJourney(journey: Journey, binary: string): Promise<JourneyResult> {
  const sandbox = createSandbox(binary);
  const result: JourneyResult = { id: journey.id, guards: journey.guards, blocks: zero(), steps: [] };
  try {
    for (const setup of journey.setup ?? []) await sandbox.run(setup);
    for (const step of journey.steps) {
      const run = await sandbox.run(step.argv);
      const entry: StepResult = { argv: step.argv, exitCode: run.exitCode };
      if (!isBlock(run)) {
        if (step.expectBlock) entry.unexpected = "expected a block, the step succeeded";
        result.steps.push(entry); continue;
      }
      const verdict: Classification = await classifyBlock(run, argv => sandbox.run(argv), () => sandbox.run(step.argv));
      entry.class = verdict.class; if (verdict.continuation) entry.continuation = verdict.continuation;
      if (!step.expectBlock) entry.unexpected = "unexpected block";
      result.blocks[verdict.class]++;
      result.steps.push(entry);
    }
  } finally { await sandbox.cleanup(); }
  return result;
}

export async function binaryIdentity(binary: string): Promise<{ path: string; version: string; digest: string }> {
  const entry = resolve(binary);
  const probe = Bun.spawn([process.execPath, entry, "--version"], { env: { PATH: process.env.PATH ?? "", HOME: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  if (code !== 0) throw new Error(`the binary at ${entry} does not run: exit ${code}`);
  return { path: entry, version: out.trim(), digest: createHash("sha256").update(readFileSync(entry)).digest("hex") };
}

export async function runCorpus(journeys: Journey[], binary: string): Promise<Report> {
  const identity = await binaryIdentity(binary);
  const results: JourneyResult[] = [];
  for (const journey of journeys) results.push(await runJourney(journey, binary));
  const totals = zero();
  for (const row of results) for (const name of CLASSES) totals[name] += row.blocks[name];
  return { corpusVersion: CORPUS_VERSION, binary: identity, totals, journeys: results };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  const binary = take("--binary"), out = take("--out") ?? "results.json";
  if (!binary) { console.error("usage: bun scripts/benchmarks/friction/run.ts --binary <path to the ahub entry> [--out results.json]"); process.exit(2); }
  const { JOURNEYS } = await import("./journeys.ts");
  const report = await runCorpus(JOURNEYS, binary);
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`friction: binary ${report.binary.version} (${report.binary.digest.slice(0, 12)}), corpus v${report.corpusVersion}`);
  console.log(`friction: in_band ${report.totals.in_band}, out_of_band ${report.totals.out_of_band}, dead_end ${report.totals.dead_end}, by_design ${report.totals.by_design}`);
  const bad = report.journeys.flatMap(row => row.steps.filter(step => step.unexpected).map(step => `${row.id}: ${step.argv.join(" ")} (${step.unexpected})`));
  if (bad.length) { for (const line of bad) console.error(`friction: corpus error: ${line}`); process.exit(1); }
}
