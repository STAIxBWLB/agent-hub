import { phaseReceipt, type PhaseReceipt, type PhaseView } from "./workflow.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { childEnv, stopOwnedProcess } from "./child-process.ts";

export const SDLC_STAGES = ["spec", "plan", "implement", "review", "verify", "merge", "release"] as const;
export type SdlcStage = typeof SDLC_STAGES[number];
export type SdlcMode = "off" | "advise" | "enforce";
export interface SdlcConfig { workflow?: "gsd-lite"; mode: SdlcMode; requiredChecks: string[]; stages: SdlcStage[]; }
export interface SdlcReceipt {
  stage: SdlcStage;
  phase?: PhaseReceipt;
  repo?: string;
  issue?: number;
  pr?: number;
  head?: string;
  reviewedHead?: string;
  localHead?: string;
  localResult?: "passed" | "failed" | "unknown";
  observed?: number;
}
export interface PrEvidence {
  head: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: { name: string; state: "passed" | "failed" | "pending" | "unknown" }[];
  review: "approved" | "changes_requested" | "unknown";
  unresolved: number | null;
  pendingReviews: number | null;
  paths: string[];
  mergeCommit?: string;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const repo = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-");
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function sdlcConfig(value: unknown): SdlcConfig {
  if (value === undefined) return { mode: "off", requiredChecks: [], stages: [...SDLC_STAGES] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc: expected a table");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["mode", "required_checks", "stages", "workflow"].includes(key)) throw new Error(`sdlc.${key}: unknown field`);
  const mode = raw.mode ?? "off";
  if (mode !== "off" && mode !== "advise" && mode !== "enforce") throw new Error("sdlc.mode: expected off, advise or enforce");
  const workflow = raw.workflow ?? "none";
  if (workflow !== "none" && workflow !== "gsd-lite") throw new Error("sdlc.workflow: expected none or gsd-lite");
  const checks = raw.required_checks ?? [];
  if (!Array.isArray(checks) || checks.length > 32 || checks.some(c => typeof c !== "string" || !c.trim() || c.length > 120 || /[\r\n\x00-\x1f]/.test(c)) || new Set(checks).size !== checks.length) throw new Error("sdlc.required_checks: expected at most 32 unique nonempty names");
  const stages = raw.stages ?? [...SDLC_STAGES];
  if (!Array.isArray(stages) || stages.length !== SDLC_STAGES.length || stages.some((stage, i) => stage !== SDLC_STAGES[i])) throw new Error("sdlc.stages: use spec, plan, implement, review, verify, merge, release in that order; custom stages are not supported yet");
  return { mode, requiredChecks: [...checks] as string[], stages: [...stages] as SdlcStage[], ...(workflow === "gsd-lite" ? { workflow } : {}) };
}

export function loadSdlc(cwd: string): SdlcConfig {
  try { return sdlcConfig(Bun.TOML.parse(readFileSync(join(cwd, ".agenthub", "sdlc.toml"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sdlcConfig(undefined); throw error; }
}

/** Identities and claimed local receipts only. External facts are read, never accepted as input. */
export function sdlcReceipt(value: unknown, previous: SdlcReceipt = { stage: "spec" }): SdlcReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc receipt: expected an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["stage", "repo", "issue", "pr", "reviewedHead", "localHead", "localResult", "phase"].includes(key)) throw new Error(`sdlc receipt.${key}: unsupported or externally observed field`);
  const next = { ...previous };
  if (raw.phase !== undefined) next.phase = phaseReceipt(raw.phase);
  if (raw.stage !== undefined) {
    if (!(SDLC_STAGES as readonly unknown[]).includes(raw.stage)) throw new Error("sdlc receipt.stage: unknown stage");
    next.stage = raw.stage as SdlcStage;
  }
  if (raw.repo !== undefined) { if (!repo(raw.repo)) throw new Error("sdlc receipt.repo: expected owner/repository"); next.repo = raw.repo; }
  for (const key of ["issue", "pr"] as const) if (raw[key] !== undefined) { if (!id(raw[key])) throw new Error(`sdlc receipt.${key}: expected a positive integer`); next[key] = raw[key]; }
  for (const key of ["reviewedHead", "localHead"] as const) if (raw[key] !== undefined) { if (!sha(raw[key])) throw new Error(`sdlc receipt.${key}: expected a full lowercase SHA`); next[key] = raw[key]; }
  if (raw.localResult !== undefined) {
    if (!["passed", "failed", "unknown"].includes(String(raw.localResult))) throw new Error("sdlc receipt.localResult: expected passed, failed or unknown");
    next.localResult = raw.localResult as SdlcReceipt["localResult"];
  }
  // A new artifact cannot inherit another PR's review or local gate.
  if (next.repo !== previous.repo || next.pr !== previous.pr) {
    delete next.head; delete next.observed;
    if (raw.phase === undefined) delete next.phase;
    if (raw.reviewedHead === undefined) delete next.reviewedHead;
    if (raw.localHead === undefined) delete next.localHead;
    if (raw.localResult === undefined) delete next.localResult;
  }
  return next;
}

export function parsePrEvidence(value: unknown): PrEvidence {
  const p = value as Record<string, any>;
  if (!p || !sha(p.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(p.state) || !Array.isArray(p.statusCheckRollup) || !Array.isArray(p.files) || p.files.length > 1000) throw new Error("PR readback: invalid or incomplete structured evidence");
  const checks = p.statusCheckRollup.map((c: Record<string, unknown>) => {
    const name = c.name ?? c.context;
    if (typeof name !== "string" || !name || name.length > 120) throw new Error("PR readback: invalid check identity");
    const native = c.conclusion ?? c.state;
    const state = native === "SUCCESS" ? "passed" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(String(native)) ? "failed" : ["PENDING", "QUEUED", "IN_PROGRESS"].includes(String(c.status ?? native)) ? "pending" : "unknown";
    return { name, state } as PrEvidence["checks"][number];
  });
  const paths = p.files.map((f: Record<string, unknown>) => { if (typeof f.path !== "string" || !f.path || f.path.length > 1000) throw new Error("PR readback: invalid file identity"); return f.path; });
  return { head: p.headRefOid, state: p.state, checks, paths,
    review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : "unknown",
    pendingReviews: Array.isArray(p.reviewRequests) && p.reviewRequests.length <= 100 && p.reviewRequests.every((r: unknown) => !!r && typeof r === "object") ? p.reviewRequests.length : null,
    unresolved: Number.isSafeInteger(p.unresolvedThreads) && p.unresolvedThreads >= 0 ? p.unresolvedThreads : null,
    ...(sha(p.mergeCommit?.oid) ? { mergeCommit: p.mergeCommit.oid } : {}) };
}

export interface SdlcStatus { workflow?: "gsd-lite"; phase?: PhaseView; mode: SdlcMode; stage: SdlcStage; blockers: string[]; ready: boolean; actor: string; next: string; }
export function sdlcStatus(config: SdlcConfig, receipt: SdlcReceipt | undefined, evidence?: PrEvidence, phase?: PhaseView): SdlcStatus {
  const stage = receipt?.stage ?? "spec", blockers: string[] = [];
  if (!receipt?.repo || !receipt.issue) blockers.push("issue identity missing");
  if (!receipt?.pr) blockers.push("PR identity missing");
  if (!evidence) blockers.push("current PR evidence unknown");
  else {
    if (evidence.state !== "OPEN") blockers.push("PR is not open");
    if (receipt?.reviewedHead !== evidence.head) blockers.push("current head has not been reviewed");
    if (receipt?.localHead !== evidence.head || receipt.localResult !== "passed") blockers.push("local gate on current head missing or failed");
    if (!config.requiredChecks.length) blockers.push("required check set unknown");
    for (const name of config.requiredChecks) {
      const matches = evidence.checks.filter(c => c.name === name);
      if (!matches.length || matches.some(c => c.state !== "passed")) blockers.push(`required check ${name}: not successful on current head`);
    }
    if (evidence.review !== "approved") blockers.push("GitHub review approval missing or changes requested");
    if (evidence.pendingReviews !== 0) blockers.push("review requests pending or unknown");
    if (evidence.unresolved !== 0) blockers.push("review threads unresolved or unknown");
  }
  if (config.workflow === "gsd-lite") {
    blockers.unshift(...(phase?.blockers ?? ["phase board evidence unknown"]));
    if (!evidence || receipt?.phase?.head !== evidence.head) blockers.push("phase checklist head missing or stale");
  }
  return { ...(config.workflow ? { workflow: config.workflow, ...(phase ? { phase } : {}) } : {}), mode: config.mode, stage, blockers, ready: blockers.length === 0,
    actor: phase?.blockers.length ? "reviewer/person" : stage === "review" || stage === "verify" ? "reviewer" : stage === "merge" || stage === "release" ? "person" : "owner/planner",
    next: blockers[0] ?? "person may inspect merge readiness; no automatic merge" };
}

export function touchingPrs(prs: { pr: number; paths: string[] }[]): { before: number; after: number; paths: string[] }[] {
  const conflicts: ReturnType<typeof touchingPrs> = [];
  for (let i = 0; i < prs.length; i++) for (const right of prs.slice(i + 1)) {
    const left = prs[i]!, paths = [...new Set(left.paths.filter(path => right.paths.includes(path)))].sort();
    if (paths.length) conflicts.push({ before: left.pr, after: right.pr, paths });
  }
  return conflicts;
}

export type SdlcGh = (args: string[]) => Promise<{ code: number; stdout: string }>;
/** Read-only, fixed argv. Output and time are bounded; diagnostics never expose credentials or remote text. */
export const sdlcGh: SdlcGh = args => new Promise((resolve) => {
  const child = spawn("gh", args, { env: childEnv(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "", failed = false;
  const stop = () => { failed = true; void stopOwnedProcess(child, { group: true }).catch(() => {}); };
  const timer = setTimeout(stop, 10_000);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { if (failed) return; stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 256 * 1024) { stdout = ""; stop(); } });
  child.once("error", () => { failed = true; clearTimeout(timer); resolve({ code: 1, stdout: "" }); });
  child.once("close", code => { clearTimeout(timer); resolve({ code: failed ? 1 : code ?? 1, stdout: failed ? "" : stdout }); });
});

export async function readSdlcPr(receipt: SdlcReceipt, run: SdlcGh = sdlcGh): Promise<PrEvidence | undefined> {
  if (!repo(receipt.repo) || !id(receipt.pr)) return undefined;
  try {
    const view = await run(["pr", "view", String(receipt.pr), "--repo", receipt.repo, "--json", "headRefOid,state,statusCheckRollup,reviewDecision,reviewRequests,files,mergeCommit"]);
    if (view.code !== 0) return undefined;
    const [owner, name] = receipt.repo.split("/");
    const threads = await run(["api", "graphql", "-f", "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${receipt.pr}`]);
    const p = JSON.parse(view.stdout);
    delete p.unresolvedThreads; // only the complete thread query can establish this fact
    if (threads.code === 0) {
      const current = JSON.parse(threads.stdout)?.data?.repository?.pullRequest;
      const nodes = current?.reviewThreads?.nodes;
      // Paginated or malformed thread data is unknown, never a clean review.
      if (current?.headRefOid === p.headRefOid && current?.reviewThreads?.pageInfo?.hasNextPage === false && Array.isArray(nodes) && nodes.every(n => typeof n?.isResolved === "boolean")) p.unresolvedThreads = nodes.filter(n => !n.isResolved).length;
      else if (current?.headRefOid && current.headRefOid !== p.headRefOid) return undefined;
    }
    return parsePrEvidence(p);
  } catch { return undefined; }
}
