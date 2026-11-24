// Friction runner (#1644 T1). Drives a built `ahub` entry as a subprocess in a throwaway HOME, state dir and git repository,
// offline and with no model call. It never instruments the product: a binary path is an argument, so an old release and
// the current build run the same corpus.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realPath } from "../../../src/hub/project.ts";
import { classifyBlock, isBlock, type Classification, type FrictionClass, type StepRun } from "./classify.ts";

/** A CLI step runs `ahub <argv>`. A tool step calls a hub tool as `peer` through the measured binary'"'"'s own control client and counts a refusal envelope as a block. */
export type Step = ({ argv: string[] } | { tool: string; peer: string; args?: Record<string, unknown> }) & { /** the step is expected to be blocked; an unexpected block or an unexpected success is a corpus error */ expectBlock?: boolean; /** text the block must contain: a step that is blocked by something else guards nothing, so it is a corpus error */ expectText?: string };
export const stepArgv = (step: Step): string[] => "argv" in step ? step.argv : [`tool:${step.peer}:${step.tool}`];
/** A journey's own preparation, never classified: a CLI command, a tool call, a file written into the project (before `up` reads it), a fake `gh` for the hub's GitHub reads, or a no-model peer attached until the journey ends. */
export type Setup = { argv: string[] } | { tool: string; peer: string; args?: Record<string, unknown> } | { write: string; content: string } | { patchConfig: (config: Record<string, any>) => void } | { gh: string } | { attach: string };
export interface Journey { id: string; guards: string; /** the refusal this journey would guard cannot be reached offline with the surface of today: why, in one line. Listed in the report, never counted, never a silent pass */ skip?: string; steps: Step[]; /** steps run once before the journey, never classified */ setup?: Setup[] }
export interface StepResult { argv: string[]; exitCode: number; class?: FrictionClass; continuation?: string; namesTool?: string; unexpected?: string }
export interface JourneyResult { id: string; guards: string; blocks: Record<FrictionClass, number>; steps: StepResult[]; skipped?: string }
export interface Report { corpusVersion: number; binary: { path: string; version: string; digest: string }; totals: Record<FrictionClass, number>; journeys: JourneyResult[] }

export const CORPUS_VERSION = 1;
const CLASSES: FrictionClass[] = ["in_band", "out_of_band", "dead_end", "by_design"];
const zero = (): Record<FrictionClass, number> => ({ in_band: 0, out_of_band: 0, dead_end: 0, by_design: 0 });
const STEP_TIMEOUT_MS = 30_000;
const UNEXPECTED_EXCERPT_CHARS = 160;
const TOOL_CALL = join(import.meta.dir, "tool-call.ts"), ATTACH = join(import.meta.dir, "attach.ts");

export interface Sandbox { root: string; home: string; project: string; prepare(setup: Setup): Promise<void>; run(argv: string[]): Promise<StepRun>; tool(peer: string, tool: string, args?: Record<string, unknown>): Promise<StepRun>; cleanup(): Promise<void> }

/** A clean environment: nothing inherited from the person's shell except what a CLI needs to start. */
export function sandboxEnv(root: string, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, AGENTHUB_HOME: join(home, "hub"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", NO_COLOR: "1", TERM: "dumb", TMPDIR: root };
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

export function createSandbox(binary: string): Sandbox {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-friction-")));
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
  const attached: ReturnType<typeof Bun.spawn>[] = [];
  let fakeGhBin: string | undefined;
  const spawnStep = async (command: string[], argv: string[]): Promise<StepRun> => {
    const child = Bun.spawn([process.execPath, ...command], { cwd: project, env: { ...sandboxEnv(root, home), ...(fakeGhBin ? { PATH: `${fakeGhBin}:${process.env.PATH ?? ""}` } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { argv, exitCode: code, output: `${out}${err}`.trim() };
    } finally { clearTimeout(timer); }
  };
  return {
    root, home, project,
    async prepare(setup) {
      if ("argv" in setup) await spawnStep([entry, ...setup.argv], setup.argv);
      else if ("tool" in setup) await spawnStep([TOOL_CALL, entry, setup.peer, setup.tool, JSON.stringify(setup.args ?? {})], [`tool:${setup.peer}:${setup.tool}`]);
      else if ("write" in setup) { const target = join(project, setup.write); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, setup.content); }
      else if ("patchConfig" in setup) { const file = join(project, ".agenthub/config.json"), config = JSON.parse(readFileSync(file, "utf8")); setup.patchConfig(config); writeFileSync(file, JSON.stringify(config)); }
      else if ("gh" in setup) { // outside the project: the hub trusts only a host `gh`, never a shim the repository could carry
        const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst args = process.argv.slice(2);\n${setup.gh}\n`, { mode: 0o755 }); fakeGhBin = bin;
      } else {
        const child = Bun.spawn([process.execPath, ATTACH, entry, setup.attach], { cwd: project, env: sandboxEnv(root, home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        attached.push(child);
        const reader = child.stdout.getReader(); const { value } = await reader.read(); reader.releaseLock();
        if (!new TextDecoder().decode(value).includes("attached")) throw new Error(`peer ${setup.attach} did not attach`);
      }
    },
    run: argv => spawnStep([entry, ...argv], argv),
    tool: (peer, tool, args) => spawnStep([TOOL_CALL, entry, peer, tool, JSON.stringify(args ?? {})], [`tool:${peer}:${tool}`]),
    // A journey may start a hub: stop it before the tree goes, or it outlives the run.
    async cleanup() { try { for (const child of attached) child.kill(); await this.run(["kill"]); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

export async function runJourney(journey: Journey, binary: string): Promise<JourneyResult> {
  const result: JourneyResult = { id: journey.id, guards: journey.guards, blocks: zero(), steps: [], ...(journey.skip ? { skipped: journey.skip } : {}) };
  if (journey.skip) return result;
  const sandbox = createSandbox(binary);
  try {
    for (const setup of journey.setup ?? []) await sandbox.prepare(setup);
    for (const step of journey.steps) {
      const once = () => "argv" in step ? sandbox.run(step.argv) : sandbox.tool(step.peer, step.tool, step.args);
      const run = await once();
      const entry: StepResult = { argv: stepArgv(step), exitCode: run.exitCode };
      if (!isBlock(run)) {
        if (step.expectBlock) entry.unexpected = "expected a block, the step succeeded";
        result.steps.push(entry); continue;
      }
      const verdict: Classification = await classifyBlock(run, argv => sandbox.run(argv), once);
      entry.class = verdict.class; if (verdict.continuation) entry.continuation = verdict.continuation; if (verdict.namesTool) entry.namesTool = verdict.namesTool;
      if (!step.expectBlock) entry.unexpected = "unexpected block";
      else if (step.expectText && !run.output.includes(step.expectText)) entry.unexpected = `blocked, but not by the refusal this journey guards (expected "${step.expectText}"): ${run.output.replace(/\s+/g, " ").slice(0, UNEXPECTED_EXCERPT_CHARS)}`;
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
