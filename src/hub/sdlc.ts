import { criteriaReceipt, type CriteriaReceipt, type CriteriaView, type LegacyPhaseReceipt } from "./workflow.ts";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { childEnv, stopOwnedProcess } from "./child-process.ts";
import { hostExecutable } from "./host-executable.ts";

/** The off-mode default (#257). Off output, receipts and schemas keep this shape. */
export const SDLC_STAGES = ["spec", "plan", "implement", "review", "verify", "merge", "release"] as const;
/** The enabled default (#481 S0): the AI-Native SDLC Playbook stage model. */
export const PLAYBOOK_STAGES = ["intent", "spec", "plan", "build", "test", "review", "merge", "release", "maintain"] as const;
export type SdlcBaseStage = typeof SDLC_STAGES[number] | typeof PLAYBOOK_STAGES[number];
const BASES: readonly string[] = [...new Set<string>([...SDLC_STAGES, ...PLAYBOOK_STAGES])];
/** Legacy ids read as their playbook stage; a receipt written with one stores the canonical id. */
const ALIASES: Record<string, string> = { implement: "build", verify: "test" };
export const canonicalStage = (stage: string): string => ALIASES[stage] ?? stage;
const PLAYBOOK_LABEL: Record<string, string> = { intent: "Plan", spec: "Design", plan: "Build", build: "Build", test: "Test", review: "Deploy", merge: "Deploy", release: "Deploy", maintain: "Maintain" };
export const playbookStage = (base: string): string | undefined => PLAYBOOK_LABEL[canonicalStage(base)];
/** #481 S8: `workflow` and the `phase` gate/receipt name load with a warning before this hub version and refuse from it. */
export const RETIRED_WORKFLOW_FROM = "0.13.0";
const olderThan = (version: string, limit: string): boolean => {
  const a = version.split(/[.-]/).slice(0, 3).map(Number), b = limit.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};
export type SdlcStage = string;
export type StageGate = "issue" | "pr" | "local" | "review" | "checks" | "criteria";
export interface StageDefinition { base: SdlcBaseStage; actor: string; entry_gates: StageGate[]; exit_gates: StageGate[]; after: string[]; }
export type SdlcMode = "off" | "advise" | "enforce";
/** `workflow: "gsd-lite"` marks the retired setting during its window (#481 S8): every task then needs a criteria checklist. */
export interface SdlcConfig { workflow?: "gsd-lite"; mode: SdlcMode; requiredChecks: string[]; stages: SdlcStage[]; definitions?: Record<string, StageDefinition>; deprecations?: string[]; }
export interface SdlcReceipt {
  stage: SdlcStage;
  criteria?: CriteriaReceipt;
  /** Stored before #481 S8 and read as `criteria`; never written again. */
  phase?: LegacyPhaseReceipt;
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
  pathsComplete?: boolean;
  draft?: boolean;
  base?: string;
  baseHead?: string;
  mergeCommit?: string;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const repo = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-");
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const STAGE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
// #451 froze this literal as non-peer gate names ("local" is the local-check gate). "phase" is read as criteria (#481 S8).
const STAGE_GATES = ["issue", "pr", "local", "review", "checks", "phase"];
const GATES = STAGE_GATES.map(gate => gate === "phase" ? "criteria" : gate) as StageGate[];
const baseActor = (base: string) => base === "review" || canonicalStage(base) === "test" ? "reviewer" : base === "merge" || base === "release" ? "person" : "owner/planner";
/** A receipt's checklist under either stored name. */
export const checklistOf = (receipt: SdlcReceipt | undefined): CriteriaReceipt | undefined => receipt?.criteria ?? receipt?.phase;
export function stageDefinition(config: SdlcConfig, stage: string): StageDefinition | undefined {
  if (!config.stages.includes(stage)) return stage !== canonicalStage(stage) ? stageDefinition(config, canonicalStage(stage)) : undefined;
  if (config.definitions && Object.hasOwn(config.definitions, stage)) return config.definitions[stage];
  if (!BASES.includes(stage)) return undefined;
  const base = stage as SdlcBaseStage;
  return { base, actor: baseActor(base), entry_gates: [], exit_gates: [], after: [] };
}
export function lifecycleStage(config: SdlcConfig, base: SdlcBaseStage): string {
  return config.stages.find(stage => stageDefinition(config, stage)?.base === base) ?? base;
}
function definitions(raw: unknown, stages: unknown, phaseAlias: { allowed: boolean; used: boolean }): { stages: string[]; definitions: Record<string, StageDefinition> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 32) throw new Error("sdlc.definitions: expected at most 32 stage definitions");
  if (!Array.isArray(stages) || !stages.length || stages.length > 32 || stages.some(s => typeof s !== "string" || !STAGE_ID.test(s)) || new Set(stages).size !== stages.length) throw new Error("sdlc.stages: expected 1..32 distinct bounded stage ids");
  const result: Record<string, StageDefinition> = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!STAGE_ID.test(id) || !stages.includes(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc.definitions: invalid or unlisted stage");
    const def = value as Record<string, unknown>;
    if (Object.keys(def).some(k => !["base", "actor", "entry_gates", "exit_gates", "after"].includes(k)) || !BASES.includes(def.base as string)) throw new Error("sdlc.definitions: unknown field or base");
    const base = def.base as SdlcBaseStage;
    if ((SDLC_STAGES as readonly string[]).includes(id) && id !== base) throw new Error("sdlc.definitions: built-in stage base cannot change");
    if (!(SDLC_STAGES as readonly string[]).includes(id) && (PLAYBOOK_STAGES as readonly string[]).includes(id) && canonicalStage(id) !== canonicalStage(base)) throw new Error("sdlc.definitions: built-in playbook stage base cannot change");
    const actor = def.actor ?? baseActor(base);
    if (typeof actor !== "string" || actor !== baseActor(base) && !["owner", "reviewer", "person", "planner"].includes(actor)) throw new Error("sdlc.definitions.actor: unknown actor");
    const gates = (key: string): StageGate[] => {
      const given = def[key] ?? [];
      const retired = Array.isArray(given) && given.includes("phase");
      if (retired && !phaseAlias.allowed) throw new Error(`sdlc.definitions.${key}: the phase gate was retired in ${RETIRED_WORKFLOW_FROM} (#481); name it criteria`);
      if (retired) phaseAlias.used = true;
      const list = Array.isArray(given) ? given.map(g => g === "phase" ? "criteria" : g) : given;
      if (!Array.isArray(list) || list.length > 6 || list.some(g => !GATES.includes(g)) || new Set(list).size !== list.length) throw new Error(`sdlc.definitions.${key}: unknown or duplicate gate`);
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

/** `version` is the running hub's, which closes the #481 S8 window; the daemon and Tasks pass it. Without one the window is open. */
export function sdlcConfig(value: unknown, version?: string): SdlcConfig {
  if (value === undefined) return { mode: "off", requiredChecks: [], stages: [...SDLC_STAGES] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc: expected a table");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["mode", "required_checks", "stages", "workflow", "definitions"].includes(key)) throw new Error(`sdlc.${key}: unknown field`);
  const mode = raw.mode ?? "off";
  if (mode !== "off" && mode !== "advise" && mode !== "enforce") throw new Error("sdlc.mode: expected off, advise or enforce");
  // ponytail: the #481 S8 window is a fixed version; delete `workflow`, the phase aliases and their tests once it passes.
  const window = version === undefined || olderThan(version, RETIRED_WORKFLOW_FROM);
  if (raw.workflow !== undefined && !window) throw new Error(`sdlc.workflow: retired in ${RETIRED_WORKFLOW_FROM} (#481); remove it and record a criteria checklist instead`);
  const workflow = raw.workflow ?? "none";
  if (workflow !== "none" && workflow !== "gsd-lite") throw new Error("sdlc.workflow: expected none or gsd-lite");
  const notes = workflow === "gsd-lite" ? [`sdlc.workflow = "gsd-lite" is deprecated and stops loading in ${RETIRED_WORKFLOW_FROM} (#481): remove it; every task then needs a criteria checklist recorded with hub_sdlc_record`] : [];
  const phaseAlias = { allowed: window, used: false };
  const checks = raw.required_checks ?? [];
  if (!Array.isArray(checks) || checks.length > 32 || checks.some(c => typeof c !== "string" || !c.trim() || c.length > 120 || /[\r\n\x00-\x1f]/.test(c)) || new Set(checks).size !== checks.length) throw new Error("sdlc.required_checks: expected at most 32 unique nonempty names");
  if (raw.definitions !== undefined) {
    const custom = definitions(raw.definitions, raw.stages, phaseAlias);
    if (phaseAlias.used) notes.push(`the sdlc phase gate is deprecated and stops loading in ${RETIRED_WORKFLOW_FROM} (#481): name it criteria`);
    return { mode, requiredChecks: [...checks] as string[], ...custom, ...(workflow === "gsd-lite" ? { workflow } : {}), ...(notes.length ? { deprecations: notes } : {}) };
  }
  // Off keeps the #257 seven stages byte for byte; an enabled lifecycle defaults to the playbook (#481 S0).
  const given = raw.stages ?? (mode === "off" ? [...SDLC_STAGES] : [...PLAYBOOK_STAGES]);
  const exactly = (list: readonly string[]) => Array.isArray(given) && given.length === list.length && given.every((stage, i) => stage === list[i]);
  // An enabled #257 list keeps its order under canonical ids, so implement/verify stay read-only aliases there too.
  const stages = mode !== "off" && exactly(SDLC_STAGES) ? SDLC_STAGES.map(canonicalStage) : given;
  if (!exactly(SDLC_STAGES) && !exactly(PLAYBOOK_STAGES)) throw new Error(`sdlc.stages: use ${PLAYBOOK_STAGES.join(", ")} in that order (or the #257 list ${SDLC_STAGES.join(", ")}); other lists need definitions`);
  return { mode, requiredChecks: [...checks] as string[], stages: [...stages as string[]], ...(workflow === "gsd-lite" ? { workflow } : {}), ...(notes.length ? { deprecations: notes } : {}) };
}

export function loadSdlc(cwd: string, version?: string): SdlcConfig {
  try {
    const fd = openSync(join(cwd, ".agenthub", "sdlc.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), cap = 64 * 1024;
      if (!before.isFile() || before.nlink !== 1 || before.size > cap) throw new Error("sdlc.toml must be a regular single-link file within 64 KiB");
      const bytes = Buffer.alloc(cap + 1); let length = 0, n = 0;
      while ((n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) { length += n; if (length > cap) throw new Error("sdlc.toml exceeds 64 KiB"); }
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error("sdlc.toml changed during read");
      return sdlcConfig(Bun.TOML.parse(bytes.subarray(0, length).toString("utf8")), version);
    } finally { closeSync(fd); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sdlcConfig(undefined); throw error; }
}

/** Identities and claimed local receipts only. External facts are read, never accepted as input. */
export function sdlcReceipt(value: unknown, previous: SdlcReceipt | undefined = undefined, config: SdlcConfig = sdlcConfig(undefined), version?: string): SdlcReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc receipt: expected an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["stage", "repo", "issue", "pr", "reviewedHead", "localHead", "localResult", "criteria", "phase"].includes(key)) throw new Error(`sdlc receipt.${key}: unsupported or externally observed field`);
  if (raw.criteria !== undefined && raw.phase !== undefined) throw new Error("sdlc receipt: give criteria only; phase is its retired name");
  if (raw.phase !== undefined && version !== undefined && !olderThan(version, RETIRED_WORKFLOW_FROM)) throw new Error(`sdlc receipt.phase: retired in ${RETIRED_WORKFLOW_FROM} (#481); use criteria`);
  previous ??= { stage: config.stages[0] ?? "spec" };
  const next = { ...previous };
  const checklist = raw.criteria ?? raw.phase;
  // Off keeps the #257 receipt bytes for a phase write (task import stays retired); everything else stores criteria.
  if (raw.phase !== undefined && config.mode === "off" && !config.workflow) { const legacy = criteriaReceipt(raw.phase); next.phase = { id: legacy.id, ...(legacy.head ? { head: legacy.head } : {}), tasks: [], criteria: legacy.criteria }; delete next.criteria; }
  else if (checklist !== undefined) { next.criteria = criteriaReceipt(checklist); delete next.phase; }
  if (raw.stage !== undefined) {
    if (typeof raw.stage !== "string" || !stageDefinition(config, raw.stage)) throw new Error("sdlc receipt.stage: unknown stage");
    // A legacy id is accepted from older clients but stored under the stage the config actually lists (#481 S0).
    next.stage = (config.stages.includes(raw.stage) ? raw.stage : canonicalStage(raw.stage)) as SdlcStage;
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
    if (checklist === undefined) { delete next.criteria; delete next.phase; }
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
  return { head: p.headRefOid, state: p.state, checks, paths, pathsComplete: Number.isSafeInteger(p.changedFiles) && p.changedFiles >= 0 && p.changedFiles === paths.length, ...(typeof p.isDraft === "boolean" ? { draft: p.isDraft } : {}), ...(typeof p.baseRefName === "string" && p.baseRefName && p.baseRefName.length <= 200 && !/[\x00-\x1f\x7f]/.test(p.baseRefName) ? { base: p.baseRefName } : {}), ...(sha(p.baseRefOid) ? { baseHead: p.baseRefOid } : {}),
    review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : "unknown",
    pendingReviews: Array.isArray(p.reviewRequests) && p.reviewRequests.length <= 100 && p.reviewRequests.every((r: unknown) => !!r && typeof r === "object") ? p.reviewRequests.length : null,
    unresolved: Number.isSafeInteger(p.unresolvedThreads) && p.unresolvedThreads >= 0 ? p.unresolvedThreads : null,
    ...(sha(p.mergeCommit?.oid) ? { mergeCommit: p.mergeCommit.oid } : {}) };
}

export interface SdlcStatus { playbook?: string; criteria?: CriteriaView; mode: SdlcMode; stage: SdlcStage; definition?: StageDefinition; entry?: string[]; exit?: string[]; blockers: string[]; ready: boolean; actor: string; next: string; }
/** The acceptance-criteria checklist (#481 S8, Compliance pass) counts once recorded, and on every task under the retired gsd-lite setting. Off keeps #257's output. */
export const criteriaRequired = (config: SdlcConfig, receipt: SdlcReceipt | undefined): boolean => config.workflow === "gsd-lite" || (config.mode !== "off" && !!checklistOf(receipt));
export function sdlcStatus(config: SdlcConfig, receipt: SdlcReceipt | undefined, evidence?: PrEvidence, criteria?: CriteriaView): SdlcStatus {
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
  const viewBlockers = criteria?.blockers ?? ["criteria board evidence unknown"];
  const staleHead = !evidence || checklistOf(receipt)?.head !== evidence.head ? ["criteria checklist head missing or stale"] : [];
  if (criteriaRequired(config, receipt)) { blockers.unshift(...viewBlockers); blockers.push(...staleHead); }
  const custom = config.definitions && definition ? stageGates(definition, blockers, [...viewBlockers, ...staleHead]) : undefined;
  if (custom) for (const blocker of [...custom.entry, ...custom.exit]) if (!blockers.includes(blocker)) blockers.push(blocker);
  const shown = criteria && (criteriaRequired(config, receipt) || definition && [...definition.entry_gates, ...definition.exit_gates].includes("criteria"));
  return { ...(config.mode !== "off" && definition && playbookStage(definition.base) ? { playbook: playbookStage(definition.base) } : {}), ...(shown ? { criteria } : {}), ...(custom ? { definition, ...custom } : {}), mode: config.mode, stage, blockers, ready: blockers.length === 0,
    actor: !definition ? "person" : shown && criteria.blockers.length ? "reviewer/person" : config.definitions ? definition.actor : baseActor(definition.base),
    next: blockers[0] ?? "person may inspect merge readiness; no automatic merge" };
}

function stageGates(def: StageDefinition, blockers: string[], checklist: string[]): { entry: string[]; exit: string[] } {
  const select = (gates: StageGate[]) => [...new Set(gates.flatMap(gate => {
    if (gate === "criteria") return checklist;
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

export type SdlcGh = (args: string[], timeoutMs?: number, cwd?: string, maxOutputBytes?: number) => Promise<{ code: number; stdout: string }>;
/** Read-only, fixed argv. Output and time are bounded; diagnostics never expose credentials or remote text. */
export const sdlcGh: SdlcGh = (args, timeoutMs = 10_000, cwd, maxOutputBytes = 256 * 1024) => new Promise((resolve) => {
  const outputLimit = Number.isSafeInteger(maxOutputBytes) ? Math.min(2 * 1024 * 1024, Math.max(1, maxOutputBytes)) : 256 * 1024;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(hostExecutable("gh", cwd ?? process.cwd()), args, { ...(cwd ? { cwd } : {}), env: childEnv(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch { resolve({ code: 1, stdout: "" }); return; }
  let stdout = "", failed = false;
  const stop = () => { failed = true; void stopOwnedProcess(child, { group: true }).catch(() => {}); };
  const timer = setTimeout(stop, Math.max(1, Math.min(10_000, timeoutMs)));
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { if (failed) return; stdout += chunk.toString(); if (Buffer.byteLength(stdout) > outputLimit) { stdout = ""; stop(); } });
  child.once("error", () => { failed = true; clearTimeout(timer); resolve({ code: 1, stdout: "" }); });
  child.once("close", code => { clearTimeout(timer); resolve({ code: failed ? 1 : code ?? 1, stdout: failed ? "" : stdout }); });
});

export async function readSdlcPr(receipt: SdlcReceipt, run: SdlcGh = sdlcGh): Promise<PrEvidence | undefined> {
  if (!repo(receipt.repo) || !id(receipt.pr)) return undefined;
  try {
    const view = await run(["pr", "view", String(receipt.pr), "--repo", receipt.repo, "--json", "headRefOid,state,statusCheckRollup,reviewDecision,reviewRequests,files,changedFiles,mergeCommit,isDraft,baseRefName,baseRefOid"]);
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
