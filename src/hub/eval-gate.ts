import type { PrEvidence, SdlcConfig, SdlcGh } from "./sdlc.ts";
import { completePlanInventory } from "./plan-conformance.ts";

/**
 * #481 S5: the gate MECHANISM for agent-configuration PRs. A PR whose changed paths match `config_paths` needs the one check named by `eval_check`.
 * The hub chooses, creates and defaults to no suite: `eval_check` has no default, and the person names it (suite choice pending the person).
 */
export const DEFAULT_CONFIG_PATHS: readonly string[] = [
  "AGENTS.md", "docs/agent-notes/**", "templates/**", ".agenthub/roles/**", ".agenthub/routing.toml", "routing.toml", "src/hub/hub-tools.ts",
];
const MAX_PATTERNS = 32;

/** Repository-relative patterns: literal names, `*` and `?` inside one segment, and a whole-segment `**`. Anything else is refused at load. */
export function configPathList(value: unknown, what: string): string[] {
  const bad = () => new Error(`${what}: expected at most ${MAX_PATTERNS} unique repository-relative patterns (literal names, * and ? inside a segment, whole-segment **)`);
  if (!Array.isArray(value) || value.length > MAX_PATTERNS || new Set(value).size !== value.length) throw bad();
  for (const pattern of value) {
    if (typeof pattern !== "string" || !pattern || pattern.length > 200 || /[\p{Cc}\p{Cf}\\]/u.test(pattern) || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) throw bad();
    const parts = pattern.split("/");
    if (parts.some(part => part === "" || part === "." || part === ".." || (part.includes("**") && part !== "**"))) throw bad();
  }
  return [...value] as string[];
}

const segmentRegex = (part: string) => new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
/** Pure, lexical, no filesystem. `dir/**` matches everything under `dir`, never `dir` itself. */
export function matchConfigPath(pattern: string, path: string): boolean {
  const p = pattern.split("/"), s = path.split("/");
  const walk = (i: number, j: number): boolean => {
    if (i === p.length) return j === s.length;
    if (p[i] === "**") { for (let k = j + 1; k <= s.length; k++) if (walk(i + 1, k)) return true; return false; }
    return j < s.length && segmentRegex(p[i]!).test(s[j]!) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

export type EvalApplies = "config" | "code" | "unknown";
export const configPathsOf = (config: Pick<SdlcConfig, "configPaths">): readonly string[] => config.configPaths ?? DEFAULT_CONFIG_PATHS;

/** `unknown` when the file inventory is not complete (never a clean code-only claim); `code` for a PR touching no configured path, an empty `config_paths` included. */
export function evalApplies(config: Pick<SdlcConfig, "configPaths">, evidence: PrEvidence | undefined): { applies: EvalApplies; matched: string[] } {
  const paths = configPathsOf(config);
  if (!paths.length) return { applies: "code", matched: [] };
  const inventory = completePlanInventory(evidence);
  if (inventory === undefined) return { applies: "unknown", matched: [] };
  const matched = inventory.filter(path => paths.some(pattern => matchConfigPath(pattern, path))).sort();
  return { applies: matched.length ? "config" : "code", matched };
}

/** The extra required check for this reading of the PR: the configured eval check, only for a configuration PR. */
export function evalRequiredChecks(config: Pick<SdlcConfig, "configPaths" | "evalCheck" | "mode">, evidence: PrEvidence | undefined): string[] {
  if (config.mode === "off" || !config.evalCheck) return [];
  return evalApplies(config, evidence).applies === "config" ? [config.evalCheck] : [];
}

/** What the eval check run reported, never its text: two bounded values read from a fixed marker (`eval_pass_rate=<0..1>`, `eval_suite=<version>`). */
export interface EvalResult { check: string; head: string; passRate?: number; suite?: string; read: boolean }
export interface EvalGate {
  applies: "config" | "unknown";
  /** How many changed files matched `config_paths`; names stay out of the view (counts and identities only). */
  files: number;
  check?: string;
  state: "not_configured" | "coverage_unknown" | "passed" | "failed" | "pending" | "missing" | "unknown";
  passRate?: number;
  suite?: string;
  /** Gaps in the evidence, each shown in every enabled mode; only enforce counts them as blockers. */
  gaps: string[];
}
export const EVAL_NOT_CONFIGURED = "eval check not configured: the person names one with eval_check in sdlc.toml (suite choice pending the person)";
export const EVAL_COVERAGE_UNKNOWN = "eval gate: PR file coverage incomplete or unknown";
const reported = (check: string) => `eval gate: pass rate or suite version not reported by ${check}`;

/** Undefined for off mode and for a code-only PR: those outputs stay byte-identical. */
export function evalGateView(config: Pick<SdlcConfig, "configPaths" | "evalCheck" | "mode">, evidence: PrEvidence | undefined, result?: EvalResult): EvalGate | undefined {
  if (config.mode === "off") return undefined;
  const { applies, matched } = evalApplies(config, evidence);
  if (applies === "code") return undefined;
  if (applies === "unknown") return { applies, files: 0, state: "coverage_unknown", gaps: [EVAL_COVERAGE_UNKNOWN] };
  const check = config.evalCheck;
  if (!check) return { applies, files: matched.length, state: "not_configured", gaps: [EVAL_NOT_CONFIGURED] };
  const found = evidence!.checks.filter(c => c.name === check);
  const state = !found.length ? "missing" : found.some(c => c.state === "failed") ? "failed" : found.some(c => c.state === "pending") ? "pending" : found.every(c => c.state === "passed") ? "passed" : "unknown";
  const view: EvalGate = { applies, files: matched.length, check, state, gaps: [] };
  // The record is read only for a passed check at this head; a result read for another head or check is never shown.
  if (result && result.read && result.check === check && result.head === evidence!.head) {
    if (result.passRate !== undefined) view.passRate = result.passRate;
    if (result.suite !== undefined) view.suite = result.suite;
  }
  if (state === "passed" && result && (view.passRate === undefined || view.suite === undefined)) view.gaps.push(reported(check));
  return view;
}
/** Evidence gaps that block in enforce. The state of the check itself is an ordinary required-check blocker. */
export const evalGapBlockers = (view: EvalGate | undefined): string[] => view?.gaps ?? [];

const MARK_RATE = /(?:^|\s)eval_pass_rate=(0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?)(?=\s|$)/;
const MARK_SUITE = /(?:^|\s)eval_suite=([A-Za-z0-9][A-Za-z0-9._-]{0,39})(?=\s|$)/;
const SHA = /^[a-f0-9]{40}$/;
/** Pure: the two markers, or nothing. The rest of the text is never kept. */
export function parseEvalMarkers(text: string): { passRate?: number; suite?: string } {
  const rate = MARK_RATE.exec(text.slice(0, 2000))?.[1], suite = MARK_SUITE.exec(text.slice(0, 2000))?.[1];
  return { ...(rate === undefined ? {} : { passRate: Number(rate) }), ...(suite === undefined ? {} : { suite }) };
}

/** Read-only, fixed argv, bounded output and time. One completed check run of that exact name at that exact head, else `read: false`. */
export async function readEvalResult(repository: string, head: string, check: string, run: SdlcGh): Promise<EvalResult> {
  const none: EvalResult = { check, head, read: false };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.startsWith("-") || !SHA.test(head) || !check || check.length > 120 || /[\x00-\x1f]/.test(check)) return none;
  try {
    const reply = await run(["api", `repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(check)}&per_page=10`, "--jq",
      '{total_count,check_runs:[.check_runs[]|{name,status,conclusion,head_sha,text:(((.output.title // "")+" "+(.output.summary // ""))|.[0:1000])}]}'], 10_000, undefined, 32 * 1024);
    if (reply.code !== 0) return none;
    const parsed = JSON.parse(reply.stdout), runs = parsed?.check_runs;
    if (!Array.isArray(runs) || runs.length > 10 || parsed.total_count !== runs.length) return none;
    const same = runs.filter((r: { name?: string }) => r?.name === check);
    const only = same[0];
    if (same.length !== 1 || only.head_sha !== head || only.status !== "completed" || typeof only.text !== "string") return none;
    return { check, head, read: true, ...parseEvalMarkers(only.text) };
  } catch { return none; }
}

/** The read happens only where it can matter: an enabled mode, a configured eval check and a configuration PR. */
export async function readEvalFor(config: Pick<SdlcConfig, "configPaths" | "evalCheck" | "mode">, evidence: PrEvidence | undefined, repository: string | undefined, run: SdlcGh): Promise<EvalResult | undefined> {
  if (!evidence || !repository || !config.evalCheck || evalRequiredChecks(config, evidence).length === 0) return undefined;
  return readEvalResult(repository, evidence.head, config.evalCheck, run);
}
