import { phaseReceipt, type PhaseReceipt, type PhaseView } from "./workflow.ts";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { childEnv, stopOwnedProcess } from "./child-process.ts";

export const SDLC_STAGES = ["spec", "plan", "implement", "review", "verify", "merge", "release"] as const;
export type SdlcBaseStage = typeof SDLC_STAGES[number];
export type SdlcStage = string;
export type StageGate = "issue" | "pr" | "local" | "review" | "checks" | "phase";
export interface StageDefinition { base: SdlcBaseStage; actor: string; entry_gates: StageGate[]; exit_gates: StageGate[]; after: string[]; }
export type SdlcMode = "off" | "advise" | "enforce";
export interface SdlcConfig { workflow?: "gsd-lite"; mode: SdlcMode; requiredChecks: string[]; stages: SdlcStage[]; definitions?: Record<string, StageDefinition>; }
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

const STAGE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const STAGE_GATES: StageGate[] = ["issue", "pr", "local", "review", "checks", "phase"];
const baseActor = (base: SdlcBaseStage) => base === "review" || base === "verify" ? "reviewer" : base === "merge" || base === "release" ? "person" : "owner/planner";
export function stageDefinition(config: SdlcConfig, stage: string): StageDefinition | undefined {
  if (!config.stages.includes(stage)) return undefined;
  if (config.definitions && Object.hasOwn(config.definitions, stage)) return config.definitions[stage];
  if (!(SDLC_STAGES as readonly string[]).includes(stage)) return undefined;
  const base = stage as SdlcBaseStage;
  return { base, actor: baseActor(base), entry_gates: [], exit_gates: [], after: [] };
}
export function lifecycleStage(config: SdlcConfig, base: SdlcBaseStage): string {
  return config.stages.find(stage => stageDefinition(config, stage)?.base === base) ?? base;
}
function definitions(raw: unknown, stages: unknown): { stages: string[]; definitions: Record<string, StageDefinition> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 32) throw new Error("sdlc.definitions: expected at most 32 stage definitions");
  if (!Array.isArray(stages) || !stages.length || stages.length > 32 || stages.some(s => typeof s !== "string" || !STAGE_ID.test(s)) || new Set(stages).size !== stages.length) throw new Error("sdlc.stages: expected 1..32 distinct bounded stage ids");
  const result: Record<string, StageDefinition> = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!STAGE_ID.test(id) || !stages.includes(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc.definitions: invalid or unlisted stage");
    const def = value as Record<string, unknown>;
    if (Object.keys(def).some(k => !["base", "actor", "entry_gates", "exit_gates", "after"].includes(k)) || !(SDLC_STAGES as readonly unknown[]).includes(def.base)) throw new Error("sdlc.definitions: unknown field or base");
    const base = def.base as SdlcBaseStage;
    if ((SDLC_STAGES as readonly string[]).includes(id) && id !== base) throw new Error("sdlc.definitions: built-in stage base cannot change");
    const actor = def.actor ?? baseActor(base);
    if (typeof actor !== "string" || actor !== baseActor(base) && !["owner", "reviewer", "person", "planner"].includes(actor)) throw new Error("sdlc.definitions.actor: unknown actor");
    const gates = (key: string): StageGate[] => {
      const list = def[key] ?? [];
      if (!Array.isArray(list) || list.length > 6 || list.some(g => !STAGE_GATES.includes(g)) || new Set(list).size !== list.length) throw new Error(`sdlc.definitions.${key}: unknown or duplicate gate`);
      return [...list] as StageGate[];
    };
    const after = def.after ?? [];
    if (!Array.isArray(after) || after.length > 8 || after.some(a => typeof a !== "string" || !stages.includes(a) || stages.indexOf(a) >= stages.indexOf(id)) || new Set(after).size !== after.length) throw new Error("sdlc.definitions.after: dependencies must be distinct earlier stages (no missing, self, forward or cyclic edge)");
    result[id] = { base, actor: actor as string, entry_gates: gates("entry_gates"), exit_gates: gates("exit_gates"), after: [...after] as string[] };
  }
  const config = { stages, definitions: result } as SdlcConfig;
  if (stages.some(s => !stageDefinition(config, s)) || !["review", "merge"].every(base => stages.some(s => stageDefinition(config, s)?.base === base))) throw new Error("sdlc.stages: define every custom id and include review and merge base destinations");
  return { stages: [...stages], definitions: result };
}

export function sdlcConfig(value: unknown): SdlcConfig {
  if (value === undefined) return { mode: "off", requiredChecks: [], stages: [...SDLC_STAGES] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc: expected a table");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["mode", "required_checks", "stages", "workflow", "definitions"].includes(key)) throw new Error(`sdlc.${key}: unknown field`);
  const mode = raw.mode ?? "off";
  if (mode !== "off" && mode !== "advise" && mode !== "enforce") throw new Error("sdlc.mode: expected off, advise or enforce");
  const workflow = raw.workflow ?? "none";
  if (workflow !== "none" && workflow !== "gsd-lite") throw new Error("sdlc.workflow: expected none or gsd-lite");
  const checks = raw.required_checks ?? [];
  if (!Array.isArray(checks) || checks.length > 32 || checks.some(c => typeof c !== "string" || !c.trim() || c.length > 120 || /[\r\n\x00-\x1f]/.test(c)) || new Set(checks).size !== checks.length) throw new Error("sdlc.required_checks: expected at most 32 unique nonempty names");
  if (raw.definitions !== undefined) return { mode, requiredChecks: [...checks] as string[], ...definitions(raw.definitions, raw.stages), ...(workflow === "gsd-lite" ? { workflow } : {}) };
  const stages = raw.stages ?? [...SDLC_STAGES];
  if (!Array.isArray(stages) || stages.length !== SDLC_STAGES.length || stages.some((stage, i) => stage !== SDLC_STAGES[i])) throw new Error("sdlc.stages: use spec, plan, implement, review, verify, merge, release in that order; custom stages are not supported yet");
  return { mode, requiredChecks: [...checks] as string[], stages: [...stages] as SdlcStage[], ...(workflow === "gsd-lite" ? { workflow } : {}) };
}

export function loadSdlc(cwd: string): SdlcConfig {
  try {
    const fd = openSync(join(cwd, ".agenthub", "sdlc.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), cap = 64 * 1024;
      if (!before.isFile() || before.nlink !== 1 || before.size > cap) throw new Error("sdlc.toml must be a regular single-link file within 64 KiB");
      const bytes = Buffer.alloc(cap + 1); let length = 0, n = 0;
      while ((n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) { length += n; if (length > cap) throw new Error("sdlc.toml exceeds 64 KiB"); }
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error("sdlc.toml changed during read");
      return sdlcConfig(Bun.TOML.parse(bytes.subarray(0, length).toString("utf8")));
    } finally { closeSync(fd); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sdlcConfig(undefined); throw error; }
}

/** Identities and claimed local receipts only. External facts are read, never accepted as input. */
export function sdlcReceipt(value: unknown, previous: SdlcReceipt | undefined = undefined, config: SdlcConfig = sdlcConfig(undefined)): SdlcReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc receipt: expected an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["stage", "repo", "issue", "pr", "reviewedHead", "localHead", "localResult", "phase"].includes(key)) throw new Error(`sdlc receipt.${key}: unsupported or externally observed field`);
  previous ??= { stage: config.stages[0] ?? "spec" };
  const next = { ...previous };
  if (raw.phase !== undefined) next.phase = phaseReceipt(raw.phase);
  if (raw.stage !== undefined) {
    if (typeof raw.stage !== "string" || !stageDefinition(config, raw.stage)) throw new Error("sdlc receipt.stage: unknown stage");
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

export interface SdlcStatus { workflow?: "gsd-lite"; phase?: PhaseView; mode: SdlcMode; stage: SdlcStage; definition?: StageDefinition; entry?: string[]; exit?: string[]; blockers: string[]; ready: boolean; actor: string; next: string; }
export function sdlcStatus(config: SdlcConfig, receipt: SdlcReceipt | undefined, evidence?: PrEvidence, phase?: PhaseView): SdlcStatus {
  const stage = receipt?.stage ?? config.stages[0] ?? "spec", blockers: string[] = [];
  const definition = stageDefinition(config, stage);
  if (!definition) blockers.push("lifecycle stage definition unknown");
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
  const custom = config.definitions && definition ? stageGates(definition, blockers, receipt, evidence, phase) : undefined;
  if (custom) for (const blocker of [...custom.entry, ...custom.exit]) if (!blockers.includes(blocker)) blockers.push(blocker);
  return { ...(config.workflow ? { workflow: config.workflow, ...(phase ? { phase } : {}) } : {}), ...(custom ? { definition, ...custom } : {}), mode: config.mode, stage, blockers, ready: blockers.length === 0,
    actor: !definition ? "person" : phase?.blockers.length ? "reviewer/person" : config.definitions && definition ? definition.actor : stage === "review" || stage === "verify" ? "reviewer" : stage === "merge" || stage === "release" ? "person" : "owner/planner",
    next: blockers[0] ?? "person may inspect merge readiness; no automatic merge" };
}

function stageGates(def: StageDefinition, blockers: string[], receipt: SdlcReceipt | undefined, evidence: PrEvidence | undefined, phase: PhaseView | undefined): { entry: string[]; exit: string[] } {
  const select = (gates: StageGate[]) => [...new Set(gates.flatMap(gate => {
    if (gate === "phase") return [...(phase?.blockers ?? ["phase board evidence unknown"]), ...(!evidence || receipt?.phase?.head !== evidence.head ? ["phase checklist head missing or stale"] : [])];
    const matching = (text: string) => gate === "issue" ? text === "issue identity missing" : gate === "pr" ? ["PR identity missing", "current PR evidence unknown", "PR is not open"].includes(text) : gate === "local" ? ["current PR evidence unknown", "local gate on current head missing or failed"].includes(text) : gate === "checks" ? text === "current PR evidence unknown" || text === "required check set unknown" || text.startsWith("required check ") : ["current PR evidence unknown", "current head has not been reviewed", "GitHub review approval missing or changes requested", "review requests pending or unknown", "review threads unresolved or unknown"].includes(text);
    return blockers.filter(matching);
  }))];
  return { entry: select(def.entry_gates), exit: select(def.exit_gates) };
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
