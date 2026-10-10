import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hubHome } from "./project.ts";
import { processLiveness } from "../pi/process-signature.ts";

/**
 * #251: benchmark suites, runs and their comparison. A run's records hold ids, outcomes, exit codes, counts, tokens
 * and times, never the suite's text, a command's output or anything an agent wrote.
 */
export const BENCH_SCHEMA = "agent-hub.bench/v1";

export interface SuiteTask { id: string; title: string; detail?: string; class?: string; owner?: string; ref: string; setup?: string; verify: string; timeout_s: number }
export interface Suite { name: string; tasks: SuiteTask[] }

const TASK_FIELDS = new Set(["id", "title", "detail", "class", "owner", "ref", "setup", "verify", "timeout_s"]);
const CLASSES = new Set(["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"]);
/** A suite file, checked field by field; every refusal names the task and the field. */
export function parseSuite(text: string): Suite {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("suite: not valid JSON"); }
  const suite = raw as Record<string, unknown>;
  if (!suite || typeof suite !== "object" || Array.isArray(suite)) throw new Error("suite: expected an object with name and tasks");
  for (const key of Object.keys(suite)) if (key !== "name" && key !== "tasks") throw new Error(`suite: unknown field ${key}`);
  if (typeof suite.name !== "string" || !suite.name.trim()) throw new Error("suite: name is required");
  if (!Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error("suite: tasks must be a non-empty list");
  const ids = new Set<string>();
  const tasks = suite.tasks.map((item, i): SuiteTask => {
    const t = item as Record<string, unknown>;
    const where = `suite task ${typeof t?.id === "string" ? t.id : `#${i + 1}`}`;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`${where}: expected an object`);
    for (const key of Object.keys(t)) if (!TASK_FIELDS.has(key)) throw new Error(`${where}: unknown field ${key}`);
    for (const key of ["id", "title", "ref", "verify"]) if (typeof t[key] !== "string" || !(t[key] as string).trim()) throw new Error(`${where}: ${key} is required`);
    for (const key of ["detail", "class", "owner", "setup"]) if (t[key] !== undefined && typeof t[key] !== "string") throw new Error(`${where}: ${key} must be text`);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(t.id as string)) throw new Error(`${where}: id may hold letters, digits, dot, dash and underscore`);
    if (ids.has(t.id as string)) throw new Error(`${where}: duplicate id`);
    ids.add(t.id as string);
    if (t.class !== undefined && !CLASSES.has(t.class as string)) throw new Error(`${where}: class must be one of ${[...CLASSES].join(", ")}`);
    if (typeof t.timeout_s !== "number" || !Number.isFinite(t.timeout_s) || t.timeout_s < 10 || t.timeout_s > 86_400) throw new Error(`${where}: timeout_s must be a number of seconds from 10 to 86400`);
    return t as unknown as SuiteTask;
  });
  return { name: suite.name, tasks };
}
export const suiteHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface Fingerprint { peers: { id: string; state: string; model?: string; permissionMode?: string }[]; routingHash: string | null; hubVersion: string }
export interface RunHeader {
  schema: typeof BENCH_SCHEMA; kind: "run"; run: string; suite: string; suiteHash: string; arm: string; fingerprint: Fingerprint;
  version: string; startedAt: string; tasks: number; repeats: number; runner: { pid: number; signature: string | null };
  /** Task ids in run order, so a running run can name the attempt in progress. */
  order: string[];
}
export type Outcome = "pass" | "fail" | "timeout" | "error";
/** Closed list: a reason never quotes a command or its output. */
export type AttemptError = "setup failed" | "setup timeout" | "propose refused" | "hub stopped" | "verify timeout" | "reset failed" | "interrupted";
export interface AttemptMetrics {
  tokens: number; wallMs: number | null; activeMs: number; reviewRounds: number; changesRequested: number; checkFailed: number;
  firstPass: boolean; turns: number; filesChanged: number; models: string[];
}
export interface Attempt {
  schema: typeof BENCH_SCHEMA; kind: "attempt"; run: string; task: string; repeat: number; outcome: Outcome; error?: AttemptError;
  verifyExit: number | null; hubTask: number | null; startedAt: string; endedAt: string; ms: number; metrics: AttemptMetrics | null;
}
export interface RunEnd { schema: typeof BENCH_SCHEMA; kind: "end"; run: string; endedAt: string; stopped?: "timeout" | "interrupted" | "error" }
export type BenchRecord = RunHeader | Attempt | RunEnd;
export interface BenchRun { header: RunHeader; attempts: Attempt[]; end?: RunEnd; state: "running" | "finished" | "stopped" | "interrupted" | "unknown" }

export const benchDir = (home = hubHome()): string => join(home, "bench");
export const runFile = (run: string, home = hubHome()): string => join(benchDir(home), `${run}.jsonl`);
export function appendBench(record: BenchRecord, home = hubHome()): void {
  mkdirSync(benchDir(home), { recursive: true, mode: 0o700 });
  chmodSync(benchDir(home), 0o700); // mkdir's mode applies only when it creates the directory
  const file = runFile(record.run, home);
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Every run on this machine, newest first. A run with no end record is running while its runner lives. */
export function readRuns(home = hubHome()): BenchRun[] {
  const dir = benchDir(home);
  if (!existsSync(dir)) return [];
  const runs: BenchRun[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    let header: RunHeader | undefined, end: RunEnd | undefined;
    const attempts: Attempt[] = [];
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: BenchRecord;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.schema !== BENCH_SCHEMA) continue;
      if (r.kind === "run") header = r; else if (r.kind === "attempt") attempts.push(r); else if (r.kind === "end") end = r;
    }
    if (!header) continue;
    const owner = end ? undefined : processLiveness(header.runner.pid, header.runner.signature);
    const state = end ? (end.stopped ? "stopped" : "finished") : owner === "live" ? "running" : owner === "gone" ? "interrupted" : "unknown";
    runs.push({ header, attempts, ...(end ? { end } : {}), state });
  }
  return runs.sort((a, b) => b.header.startedAt.localeCompare(a.header.startedAt));
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export interface Measures {
  attempts: number; pass: number; fail: number; timeout: number; error: number;
  passRate: number | null; firstPassRate: number | null; tokensMedian: number | null; wallMsMedian: number | null; reworkMean: number | null;
}
export function measures(attempts: Attempt[]): Measures {
  const count = (o: Outcome) => attempts.filter((a) => a.outcome === o).length;
  const scored = attempts.filter((a) => a.outcome !== "error");
  const withMetrics = attempts.flatMap((a) => a.metrics ? [a.metrics] : []);
  return { attempts: attempts.length, pass: count("pass"), fail: count("fail"), timeout: count("timeout"), error: count("error"),
    passRate: scored.length ? count("pass") / scored.length : null,
    firstPassRate: withMetrics.length ? withMetrics.filter((m) => m.firstPass).length / withMetrics.length : null,
    tokensMedian: median(withMetrics.map((m) => m.tokens)), wallMsMedian: median(attempts.map((a) => a.ms)),
    reworkMean: withMetrics.length ? withMetrics.reduce((n, m) => n + m.changesRequested, 0) / withMetrics.length : null };
}
export interface RunSummary extends Measures { run: string; suite: string; arm: string; state: BenchRun["state"]; startedAt: string; done: number; total: number; current?: string }
export function runSummary(r: BenchRun): RunSummary {
  const total = r.header.tasks * r.header.repeats;
  const current = r.state === "running" && r.attempts.length < total ? r.header.order?.[r.attempts.length % r.header.order.length] : undefined;
  return { run: r.header.run, suite: r.header.suite, arm: r.header.arm, state: r.state, startedAt: r.header.startedAt, done: r.attempts.length, total, ...(current ? { current } : {}), ...measures(r.attempts) };
}
/** Per task and overall for one run (or several runs of one arm). */
export function benchReport(runs: BenchRun[]): { overall: Measures; tasks: Record<string, Measures> } {
  const attempts = runs.flatMap((r) => r.attempts);
  const tasks: Record<string, Attempt[]> = {};
  for (const a of attempts) (tasks[a.task] ??= []).push(a);
  return { overall: measures(attempts), tasks: Object.fromEntries(Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, measures(v)])) };
}

/** A seeded generator, so a comparison prints the same interval every time for the same records. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const MIN_ATTEMPTS = 5;
type MeasureName = "passRate" | "firstPassRate" | "tokensMedian" | "wallMsMedian";
export interface Comparison {
  arms: { arm: string; runs: number; measures: Measures }[];
  /** Each other arm against the first: the difference and its 95% bootstrap interval; inconclusive below MIN_ATTEMPTS. */
  differences: { arm: string; measure: MeasureName; diff: number | null; low: number | null; high: number | null; inconclusive: boolean }[];
}
export function benchCompare(groups: { arm: string; runs: BenchRun[] }[], resamples = 1000, seed = 251): Comparison {
  const arms = groups.map((g) => ({ arm: g.arm, runs: g.runs.length, attempts: g.runs.flatMap((r) => r.attempts) }));
  const base = arms[0];
  const differences: Comparison["differences"] = [];
  const names: MeasureName[] = ["passRate", "firstPassRate", "tokensMedian", "wallMsMedian"];
  if (base) for (const other of arms.slice(1)) {
    const random = mulberry32(seed);
    const pick = (xs: Attempt[]) => Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]!);
    const samples: Record<MeasureName, number[]> = { passRate: [], firstPassRate: [], tokensMedian: [], wallMsMedian: [] };
    if (base.attempts.length && other.attempts.length) for (let i = 0; i < resamples; i++) {
      const a = measures(pick(base.attempts)), b = measures(pick(other.attempts));
      for (const n of names) if (a[n] !== null && b[n] !== null) samples[n].push(b[n]! - a[n]!);
    }
    const ma = measures(base.attempts), mb = measures(other.attempts);
    for (const n of names) {
      const s = samples[n].sort((x, y) => x - y);
      const diff = ma[n] !== null && mb[n] !== null ? mb[n]! - ma[n]! : null;
      differences.push({ arm: other.arm, measure: n, diff, low: s.length ? s[Math.floor(0.025 * s.length)]! : null, high: s.length ? s[Math.min(s.length - 1, Math.floor(0.975 * s.length))]! : null,
        inconclusive: base.attempts.length < MIN_ATTEMPTS || other.attempts.length < MIN_ATTEMPTS || diff === null });
    }
  }
  return { arms: arms.map((a) => ({ arm: a.arm, runs: a.runs, measures: measures(a.attempts) })), differences };
}

const pct = (v: number | null) => v === null ? "-" : `${Math.round(v * 100)}%`;
const num = (v: number | null) => v === null ? "-" : String(Math.round(v));
const dur = (ms: number | null) => ms === null ? "-" : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
const row = (name: string, m: Measures) => `${name.padEnd(28)} ${String(m.attempts).padStart(8)}  ${pct(m.passRate).padStart(5)}  ${`${m.pass}/${m.fail}/${m.timeout}/${m.error}`.padStart(11)}  ${pct(m.firstPassRate).padStart(10)}  ${num(m.tokensMedian).padStart(10)}  ${dur(m.wallMsMedian).padStart(8)}`;
const HEAD = `${"".padEnd(28)} ${"attempts".padStart(8)}  ${"pass".padStart(5)}  ${"p/f/t/e".padStart(11)}  ${"first pass".padStart(10)}  ${"tokens p50".padStart(10)}  ${"wall p50".padStart(8)}`;
export function formatRuns(runs: BenchRun[]): string[] {
  if (!runs.length) return ["no benchmark runs on this machine (ahub bench run <suite.json> --arm <label>)"];
  return runs.map(runSummary).map((s) => `${s.run}  ${s.state.padEnd(11)} ${s.suite} [${s.arm}]  ${s.done}/${s.total}  pass ${pct(s.passRate)}  tokens p50 ${num(s.tokensMedian)}  wall p50 ${dur(s.wallMsMedian)}  ${s.startedAt}`);
}
export function formatReport(r: ReturnType<typeof benchReport>): string[] {
  return [HEAD, row("all tasks", r.overall), ...Object.entries(r.tasks).map(([k, m]) => row(k, m))];
}
export function formatCompare(c: Comparison): string[] {
  const lines = [HEAD, ...c.arms.map((a) => row(`${a.arm} (${a.runs} run${a.runs === 1 ? "" : "s"})`, a.measures))];
  const fmt = (n: MeasureName, v: number | null) => v === null ? "-" : n.endsWith("Rate") ? `${v >= 0 ? "+" : ""}${Math.round(v * 100)}pt` : n === "wallMsMedian" ? `${v >= 0 ? "+" : "-"}${dur(Math.abs(v))}` : `${v >= 0 ? "+" : ""}${Math.round(v)}`;
  for (const d of c.differences) lines.push(`${d.arm} vs ${c.arms[0]!.arm}: ${d.measure} ${fmt(d.measure, d.diff)} (95% ${fmt(d.measure, d.low)} to ${fmt(d.measure, d.high)})${d.inconclusive ? `, inconclusive: fewer than ${MIN_ATTEMPTS} attempts in an arm` : ""}`);
  return lines;
}
export const CSV_COLUMNS = ["run", "suite", "arm", "task", "repeat", "outcome", "error", "verifyExit", "hubTask", "startedAt", "endedAt", "ms", "tokens", "wallMs", "activeMs",
  "reviewRounds", "changesRequested", "checkFailed", "firstPass", "turns", "filesChanged", "models"] as const;
export function benchCsv(runs: BenchRun[]): string {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = runs.flatMap((r) => r.attempts.map((a) => [r.header.run, r.header.suite, r.header.arm, a.task, a.repeat, a.outcome, a.error, a.verifyExit, a.hubTask, a.startedAt, a.endedAt, a.ms,
    a.metrics?.tokens, a.metrics?.wallMs, a.metrics?.activeMs, a.metrics?.reviewRounds, a.metrics?.changesRequested, a.metrics?.checkFailed, a.metrics?.firstPass, a.metrics?.turns,
    a.metrics?.filesChanged, a.metrics?.models.join(" ")].map(cell).join(",")));
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
