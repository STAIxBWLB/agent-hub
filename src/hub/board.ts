import { canonicalJson } from "./packs.ts";
import { parseComparisonPlan, comparisonPlanHash, evaluatorIdentityHash, parseExperimentProtocol, protocolHash, parseExperimentAttempt, parseExperimentEvent, parseExperimentHostEvidence, experimentStatus, projectExperimentWithObservations,
  type ComparisonPlanV1, type ExperimentProtocolRecord, type ExperimentAttemptRecord, type ExperimentEventRecord, type ExperimentWriteFence, type DeclaredExperimentEventInput, type ExperimentHostEvidence, type ExperimentStatus } from "./research-experiments.ts";
import type { InvocationRow } from "./invocations.ts";
import { HOST_CODE_SYMBOLS, parseTaskCodeSymbols, type TaskCodeSymbols } from "./task-code-symbols.ts";
import { createHash } from "node:crypto";
import { planFingerprint } from "./plan-conformance.ts";
import type { PlannerReason } from "./routing.ts";
import type { ReviewerPoolReason } from "./reviewer-pool.ts";
import type { GitHubSource } from "./github-import.ts";
import type { Database } from "bun:sqlite";
import { openHubDatabase } from "./db-schema.ts";
import { planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import { HUB, USER, type PeerId } from "./envelope.ts";
import type { SweepRecord } from "./task-sweep.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import type { SdlcReceipt } from "./sdlc.ts";
import { parseReviewFindings, type ReviewFindingSet } from "./review-findings.ts";
import { parseDeliverableRecords, type DeliverableRecord } from "./deliverables.ts";
import type { CostPlan, ReviewCost } from "./cost-governance.ts";
import { campaignHash, parseResearchCampaign, parseResearchHandoff, type ResearchCampaignContract, type ResearchCampaignStatus, type ResearchUnit, type ResearchHandoffV1, type ResearchHandoffRecord } from "./research-campaign.ts";

export interface ResearchCampaignRecord {
  id: string;
  project: string;
  parentTaskId: number;
  revision: number;
  status: ResearchCampaignStatus;
  contract: ResearchCampaignContract;
  hash: string;
  private: boolean;
  createdBy: PeerId;
  createdAt: number;
  approvedBy?: PeerId;
  approvedAt?: number;
  closedBy?: PeerId;
  closedAt?: number;
  closedReason?: string;
  dispatchVersion?: 1;
  eligibleOwners?: string[];
}
export interface ResearchUnitBinding {
  campaignId: string;
  revision: number;
  unitId: string;
  taskId: number;
  round: number;
  purpose: ResearchUnit["purpose"];
  adopted: boolean;
}
export interface PreparedResearchUnit {
  unitId: string;
  create?: Parameters<Board["propose"]>[1];
  adopt?: { taskId: number; flowRevision: number };
  reuse?: { taskId: number; flowRevision: number };
}

interface ResearchCampaignRow {
  id: string; project: string; parent_task_id: number; revision: number; status: string; body: string | null; body_sha256: string; private: number;
  created_by: string; created_at: number; approved_by: string | null; approved_at: number | null;
  closed_by: string | null; closed_at: number | null; closed_reason: string | null;
}
interface ResearchHandoffRow { campaign_id: string; unit_id: string; seq: number; revision: number; task_id: number; body: string | null; by_peer: string; at: number; private: number }
interface ResearchUnitRow { campaign_id: string; revision: number; unit_id: string; task_id: number; round: number; purpose: string; adopted: number }
const RESEARCH_CAMPAIGN_SELECT = "SELECT id,project,parent_task_id,revision,status,CASE WHEN length(CAST(body AS BLOB)) <= 65536 THEN body END AS body,body_sha256,private,created_by,created_at,approved_by,approved_at,closed_by,closed_at,closed_reason FROM research_campaigns";
const researchFailure = (): Error => new Error("research campaign state is invalid, changed or corrupt");
const researchId = (value: unknown): value is string => typeof value === "string" && value.length === 15 && /^rc-[0-9a-f]{12}$/.test(value);
const researchInteger = (value: unknown, minimum = 1): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const researchText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max && Buffer.byteLength(value, "utf8") <= max && Buffer.from(value, "utf8").toString("utf8") === value;
function checkedResearchCampaign(record: ResearchCampaignRecord): ResearchCampaignRecord {
  if (!researchId(record.id) || !researchText(record.project) || !researchInteger(record.parentTaskId) || !researchInteger(record.revision) ||
    !["draft", "approved", "superseded", "closed"].includes(record.status) || typeof record.private !== "boolean" || !researchText(record.createdBy) || !researchInteger(record.createdAt, 0)) throw researchFailure();
  const contract = parseResearchCampaign(record.contract), hash = campaignHash(contract);
  if (record.hash !== hash || (record.approvedBy === undefined) !== (record.approvedAt === undefined) ||
    record.approvedBy !== undefined && (!researchText(record.approvedBy) || !researchInteger(record.approvedAt, 0)) ||
    (record.closedBy === undefined) !== (record.closedAt === undefined) || (record.closedBy === undefined) !== (record.closedReason === undefined) ||
    record.closedBy !== undefined && (!researchText(record.closedBy) || !researchInteger(record.closedAt, 0) || !researchText(record.closedReason, 4096)) ||
    ["approved", "superseded"].includes(record.status) && record.approvedBy === undefined || record.status === "closed" && record.closedBy === undefined ||
    record.status !== "closed" && record.closedBy !== undefined || record.status === "draft" && record.approvedBy !== undefined) throw researchFailure();
  return { ...record, contract, hash };
}
function researchCampaignFromRow(row: ResearchCampaignRow): ResearchCampaignRecord {
  try {
    if (typeof row.body !== "string" || ![0, 1].includes(row.private)) throw researchFailure();
    return checkedResearchCampaign({ id: row.id, project: row.project, parentTaskId: row.parent_task_id, revision: row.revision, status: row.status as ResearchCampaignStatus,
      contract: JSON.parse(row.body) as ResearchCampaignContract, hash: row.body_sha256, private: row.private === 1, createdBy: row.created_by, createdAt: row.created_at,
      ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}), ...(row.approved_at !== null ? { approvedAt: row.approved_at } : {}),
      ...(row.closed_by !== null ? { closedBy: row.closed_by } : {}), ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}), ...(row.closed_reason !== null ? { closedReason: row.closed_reason } : {}) });
  } catch { throw researchFailure(); }
}

export interface ExperimentComparisonPlanRecord {
  hash: string;
  project: string;
  recordedForTaskId: number;
  plan: ComparisonPlanV1;
  by: PeerId;
  at: number;
  private: boolean;
}
export interface ExperimentProtocolApproval { protocolHash: string; evaluatorHash: string; approvedBy: PeerId; at: number }
export type ExperimentProtocolContext = { state: "unknown" } | { state: "predeclared" } | { state: "post-hoc"; priorFinal: { attemptId: string; endSeq: number } };
interface ExperimentComparisonPlanRow { row_id?: number; hash: string; project: string; campaign_id: string; campaign_revision: number; task_id: number; body: string | null; by_peer: string; at: number; private: number }
interface ExperimentProtocolApprovalRow { protocol_hash: string; evaluator_hash: string; approved_by: string; at: number }
interface ExperimentProtocolContextRow { protocol_hash: string; prior_attempt_id: string | null; prior_end_seq: number | null; context_sha256: string }
const EXPERIMENT_PLAN_SELECT = "SELECT rowid AS row_id,hash,project,campaign_id,campaign_revision,task_id,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,by_peer,at,private FROM research_plans";

interface ExperimentProtocolRow { hash: string; project: string; campaign_id: string; campaign_revision: number; task_id: number; body: string | null; by_peer: string; at: number; private: number }
interface ExperimentAttemptRow { row_id?: number; attempt_id: string; project: string; campaign_id: string; campaign_revision: number; protocol_hash: string; task_id: number; idempotency_key: string; body: string | null; body_sha256: string; by_peer: string; at: number; private: number }
interface ExperimentEventRow { attempt_id: string; project: string; seq: number; idempotency_key: string; kind: string; body: string | null; body_sha256: string; by_peer: string; at: number; private: number }
interface ExperimentObservationRow { attempt_id: string; event_seq: number; body: string | null; body_sha256: string }
const EXPERIMENT_PROTOCOL_SELECT = "SELECT hash,project,campaign_id,campaign_revision,task_id,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,by_peer,at,private FROM research_protocols";
const EXPERIMENT_ATTEMPT_SELECT = "SELECT rowid AS row_id,attempt_id,project,campaign_id,campaign_revision,protocol_hash,task_id,idempotency_key,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,body_sha256,by_peer,at,private FROM research_attempts";
const EXPERIMENT_EVENT_SELECT = "SELECT attempt_id,project,seq,idempotency_key,kind,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,body_sha256,by_peer,at,private FROM research_attempt_events";
const experimentFailure = (): Error => new Error("experiment state is invalid, changed or corrupt");
const experimentHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const experimentHashValid = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const experimentIdValid = (value: unknown): value is string => typeof value === "string" && /^ra-[0-9a-f]{12}$/.test(value);
const experimentPage = (after: number, limit: number): void => {
  if (!researchInteger(after, 0) || !researchInteger(limit) || limit > 50) throw experimentFailure();
};

export const CLASSES = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] as const;
export type TaskClass = (typeof CLASSES)[number];
export type TaskState = "backlog" | "proposed" | "in_progress" | "in_review" | "approved" | "changes_requested" | "cancelled";

export const isClosedTaskState = (state: string): boolean => state === "approved" || state === "cancelled";
export interface TaskOffer { envelopeId: string; owner: PeerId; assignmentFlowRevision: number; pullOnly?: boolean }
export interface TaskCancellation { reason: string; supersededBy?: string; flowRevision: number; withheld?: true }
export const TASK_STALL_CODES = ["tests", "spec", "roster", "pull-only", "not-attached", "excluded", "owner-admission", "offline", "paused", "failing", "pii", "policy", "cancelled", "unavailable", "no-writes", "queue-count", "queue-age", "queue-age-unknown"] as const;
export type TaskStallCode = (typeof TASK_STALL_CODES)[number];
export interface TaskStall { task: number; signature: string; replanRevision: number; cause: { kind: "reservation" | "no-eligible-peer" | "cancelled-dependency" | "no-writes"; peer?: string; dependency?: number; code: TaskStallCode; turns?: number; acceptance?: number; refusals?: { peer: string; code: TaskStallCode }[] }; at: number }

const QUEUE_PRESSURE_STALL = "CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN CASE WHEN json_valid(payload) THEN json_extract(payload,'$.cause.kind')='no-eligible-peer' AND json_extract(payload,'$.cause.code') IN ('queue-count','queue-age','queue-age-unknown') ELSE 0 END ELSE 0 END";
export interface QueuePressureStallPage { rows: TaskStall[]; afterTask: number; done: boolean }
function parseStall(payload: string, task?: number): TaskStall | undefined {
  try {
    const value = JSON.parse(payload) as TaskStall, cause = value.cause;
    const peer = (id: unknown) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(id);
    if (task !== undefined && value.task !== task || Object.keys(value).some(key => !["task", "signature", "replanRevision", "cause", "at"].includes(key)) || !Number.isSafeInteger(value.task) || value.task < 1 || !Number.isSafeInteger(value.replanRevision) || value.replanRevision < 0 || !Number.isFinite(value.at)
      || !cause || !["reservation", "no-eligible-peer", "cancelled-dependency", "no-writes"].includes(cause.kind) || !TASK_STALL_CODES.includes(cause.code)
      || cause.kind === "no-writes" && (cause.code !== "no-writes" || !peer(cause.peer) || !Number.isSafeInteger(cause.turns) || cause.turns! < 1 || !Number.isSafeInteger(cause.acceptance) || cause.acceptance! < 0)
      || cause.peer !== undefined && !peer(cause.peer) || cause.dependency !== undefined && (!Number.isSafeInteger(cause.dependency) || cause.dependency < 1)
      || cause.refusals !== undefined && (!Array.isArray(cause.refusals) || cause.refusals.length > 64 || cause.refusals.some(row => Object.keys(row).some(key => !["peer", "code"].includes(key)) || !peer(row.peer) || !TASK_STALL_CODES.includes(row.code)))
      || Object.keys(cause).some(key => !["kind", "peer", "dependency", "code", "refusals", ...(cause.kind === "no-writes" ? ["turns", "acceptance"] : [])].includes(key)) || value.signature !== JSON.stringify(cause)) return undefined;
    return value;
  } catch { return undefined; }
}

export interface TaskRefs {
  repo?: string;
  branch?: string;
  commit?: string;
  paths?: string[];
}
/** What an owner says it will change, before it starts (issue #31). Each list holds short free-text items. */
export const PLAN_KEYS = ["paths", "symbols", "signatures", "insertion_points"] as const;
export const DOCUMENT_PLAN_KEYS = ["paths", "sections", "sources", "claims"] as const;
export const ALL_PLAN_KEYS = [...PLAN_KEYS, "sections", "sources", "claims", "proof", "risks"] as const;
export type TaskPlan = Partial<Record<(typeof ALL_PLAN_KEYS)[number], string[]>> & CostPlan;
/** Task outcomes older than this are pruned: demotion (issue #36) reads one week, seven half-lives. */
export const OUTCOMES_KEPT_MS = 7 * 24 * 3_600_000;

export const TASK_MOVE_REASONS = ["manual", "budget", "offline", "idle", "rejections", "declined", "inference_failed", "delivery_failed"] as const;
export type TaskMoveReason = (typeof TASK_MOVE_REASONS)[number];
export type InvocationHistory = Pick<InvocationRow, "id" | "caller" | "target" | "capability" | "digest" | "class" | "approval" | "argsSha256" | "outcome">;

export interface HistoryEntry {
  /** Host-owned invocation metadata only, never arguments or results. */
  invocation?: InvocationHistory;
  at: number;
  by: PeerId;
  event: string; // proposed | assigned | accepted | declined | done | approved | changes_requested | escalated | reassigned
  note?: string;
  supersededBy?: string;
  /** The owner an event that set it left the task with (#67); absent in rows written before 0.11. */
  owner?: PeerId | null;
  /** Host-selected planner at this transition; absent in legacy history. */
  planner?: PeerId | null;
  plannerReason?: PlannerReason;
  /** Saved plan-review author/self-review evidence, retained if the current receipt changes. */
  planAuthor?: PeerId | null;
  selfReview?: true;
  /** On a decline or an escalation: the owner it was declined for or taken from (#207); later reroutes leave it out. */
  from?: PeerId;
  /** On a decline: the owner had no capacity right now (#531). Absent on older rows and on a plain refusal, which read as lasting. */
  capacity?: true;
  /** Host-observed explicit conductor assignment/removal, retained independently of later role changes. */
  conductorManual?: true;
  /** On a hand-over: the new owner's split profile then (#109); absent when it was unknown. */
  profile?: string;
  /** Structured cause recorded at the operation source, never inferred from note text. */
  reason?: TaskMoveReason;
  /** Persisted task-idle ladder; never counted as fresh task activity (#186). */
  sweep?: SweepRecord;
  /** The PII screen did not clear this entry's note (#198): only the console reads it. */
  withheld?: true;
  /** Host evidence at done, never inferred from the owner's summary. */
  noWrites?: true;
  /** Host-recorded expected cost and exact review head, never narrative. */
  reviewCost?: ReviewCost;
  /** #901: on the hub's own `check passed` / `check failed`: the check key (task class or profile class alias) whose command ran. Set by the hub from its own selection, never from output or an owner's words. */
  checkKey?: string;
  /** #901: on such an entry, the number of unresolved citation keys the example citation check printed (`citations: N declared keys, M missing`); absent when the check printed no such line. */
  missingKeys?: number;
  /** #901: a person's verdict on one declared claim of a document plan. `slot` is the claim's 1-based position in the current plan; no claim text, no source and no path is stored. */
  claim?: ClaimVerdict;
  /** #223 R4: on a verdict, whether the reviewer's context was new for it; set by the hub, never by the reviewer. */
  reviewContext?: "fresh" | "continuing";
  /** #852: a verdict by a `code`-scope reviewer says so; a `full` reviewer's verdict carries nothing, so existing rows are unchanged. */
  reviewScope?: "code";
  /** #852 AC3: a `code`-scope reviewer's changes_requested with no open finding. It is recorded, returns the task to its owner and counts toward nothing. */
  evidenceOnly?: true;
  /** Structured review report bound to the reviewed artifact, stored in the existing history JSON. */
  reviewFindings?: ReviewFindingSet;
  /**
   * #509a: the files a `done`, a lifecycle record or an approval bound, with the content hashes the hub computed. An approval carries the hashes
   * it was given at review time, so a later edit reads as "deliverable changed since review". Full paths live here; every view goes through
   * `publicDeliverables`.
   */
  deliverables?: DeliverableRecord[];
  /** #507b: the recorded acceptance criteria (S8 checklist ids) a verdict's unmet items named; derived by the hub from the checklist, never free text. */
  unmetCriteria?: string[];
  /** Host-authored plan content revision, separate from backlog planningRevision. */
  planRevision?: { revision: number; fingerprint: string };
  planObservation?: { repo: string; pr: number; head: string; revision: number; fingerprint: string };
  planDepartureInvalidated?: true;
  planDeparture?: { generation: string; scope?: string; repo: string; pr: number; head: string; revision: number; fingerprint: string; paths: string[] };
  reviewerFamily?: string;
  reviewerReason?: ReviewerPoolReason;
  reviewBlocked?: true;
  /** Host-only temporary automatic review hold caused by queue admission, never a reviewer failure. */
  queueReviewHeld?: true;
  /** Opaque artifact identity captured by the host at the queue-held role write. */
  queueReviewBinding?: string;
  reviewerFailure?: { peer: string; head?: string; cause: "start_failed" | "quota" | "no_verdict" };
  planning?: { revision: number; fields: (keyof PlanningFields)[]; previous: PlanningFields; pull?: true; split?: { children: { id: number; revision: number; history: number }[] } };
}
/** #901: one person verdict on a plan claim, with the model label the person says produced the claim. All closed or bounded; nothing here is claim text. */
export const CLAIM_VERDICTS = ["supported", "unsupported", "unclear"] as const;
/** `modelVerdict` is what the model's own fact check said of the claim, as the person enters it: with it the scorecard can say whether person and model agree; without it agreement is unknown. */
export interface ClaimVerdict { slot: number; verdict: (typeof CLAIM_VERDICTS)[number]; model?: string; modelVerdict?: (typeof CLAIM_VERDICTS)[number]; /** `claimListId` of the plan's claims when the verdict was entered: the list it evaluated, as a hash. Set by the hub, never by the person. */ list?: string }
/** A short opaque identity of an ordered claim list (a sha-256 prefix of its canonical form): equal lists, in order, give equal ids; it reveals nothing of the claims. Absent list: the empty list's id. */
export function claimListId(claims: readonly string[] | undefined): string {
  return createHash("sha256").update(planFingerprint({ claims: [...(claims ?? [])] })).digest("hex").slice(0, 16);
}
/** A claim slot is a position in the plan's claim list (at most 50, as the scorecard's own bound); a model label is a bounded token, never prose. */
export function parseClaimVerdict(value: unknown, slots: number): ClaimVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("claim verdict must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["slot", "verdict", "model", "modelVerdict"].includes(key))) throw new Error("claim verdict carries only slot, verdict, model and modelVerdict");
  if (!Number.isSafeInteger(v.slot) || (v.slot as number) < 1 || (v.slot as number) > Math.min(50, slots)) throw new Error(`claim slot must name one of the task's ${slots} declared claim${slots === 1 ? "" : "s"}`);
  if (typeof v.verdict !== "string" || !(CLAIM_VERDICTS as readonly string[]).includes(v.verdict)) throw new Error(`claim verdict must be one of ${CLAIM_VERDICTS.join(", ")}`);
  if (v.model !== undefined && (typeof v.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/.test(v.model))) throw new Error("model label must be a short identifier (letters, digits and . _ : / @ + -)");
  if (v.modelVerdict !== undefined && (typeof v.modelVerdict !== "string" || !(CLAIM_VERDICTS as readonly string[]).includes(v.modelVerdict))) throw new Error(`model verdict must be one of ${CLAIM_VERDICTS.join(", ")}`);
  return { slot: v.slot as number, verdict: v.verdict as ClaimVerdict["verdict"], ...(v.model === undefined ? {} : { model: v.model }), ...(v.modelVerdict === undefined ? {} : { modelVerdict: v.modelVerdict as ClaimVerdict["verdict"] }) };
}
/** The ids a stored verdict may carry (#507b): bounded criterion identifiers in the S8 checklist's own format, at most its 32, each once. */
function criterionIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(id)) || new Set(value).size !== value.length) throw new Error("unmet criteria: expected up to 32 distinct criterion ids");
  return [...value] as string[];
}
export type ReviewerHistory = Pick<HistoryEntry, "reviewerFamily" | "reviewerReason" | "reviewBlocked" | "queueReviewHeld" | "queueReviewBinding" | "reviewerFailure">;
function reviewerHistory(extra: ReviewerHistory): ReviewerHistory {
  const id = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  if (extra.reviewerFamily !== undefined && !id(extra.reviewerFamily) || extra.reviewerReason !== undefined && !["rotation", "implementer skip", "unavailable skip", "same-family fallback"].includes(extra.reviewerReason) || extra.reviewBlocked !== undefined && extra.reviewBlocked !== true || extra.queueReviewHeld !== undefined && extra.queueReviewHeld !== true) throw new Error("invalid reviewer metadata");
  if (extra.queueReviewHeld && (typeof extra.queueReviewBinding !== "string" || !/^[0-9a-f]{64}$/.test(extra.queueReviewBinding)) || extra.queueReviewBinding !== undefined && extra.queueReviewHeld !== true) throw new Error("invalid queue-held review binding");
  const failure = extra.reviewerFailure;
  if (failure && (!id(failure.peer) || !["start_failed", "quota", "no_verdict"].includes(failure.cause) || failure.head !== undefined && (typeof failure.head !== "string" || !failure.head.trim() || failure.head.length > 300 || Buffer.byteLength(failure.head) > 1200 || /\p{Cc}/u.test(failure.head)))) throw new Error("invalid reviewer failure metadata");
  return { ...(extra.reviewerFamily ? { reviewerFamily: extra.reviewerFamily } : {}), ...(extra.reviewerReason ? { reviewerReason: extra.reviewerReason } : {}), ...(extra.reviewBlocked ? { reviewBlocked: true } : {}), ...(extra.queueReviewHeld ? { queueReviewHeld: true, ...(extra.queueReviewBinding !== undefined ? { queueReviewBinding: extra.queueReviewBinding } : {}) } : {}), ...(failure ? { reviewerFailure: { peer: failure.peer, cause: failure.cause, ...(failure.head ? { head: failure.head } : {}) } } : {}) };
}
export interface PlannerBinding { planner: PeerId | null; plannerReason: PlannerReason }
function plannerValue(value: unknown): PeerId | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error("invalid planner id");
  return value;
}
function plannerMetadata(planner: unknown, reason?: PlannerReason): Pick<HistoryEntry, "planner" | "plannerReason"> {
  if (reason !== undefined && !["rotation", "named", "kept", "none"].includes(reason)) throw new Error("invalid planner reason");
  return { planner: plannerValue(planner), ...(reason === undefined ? {} : { plannerReason: reason }) };
}
/** #604: what this project handed to another project, and the last state that project reported (agent-hub#1030 design 4). */
export interface HandoffOutboundRow { remoteProject: string; remoteTask: number; originPeer: string; localTask: number | null; title: string; state: string; pr: number | null; head: string | null; updatedAt: number }
const handoffOutboundFromRow = (row: Record<string, unknown>): HandoffOutboundRow => ({ remoteProject: String(row.remote_project), remoteTask: Number(row.remote_task), originPeer: String(row.origin_peer),
  localTask: row.local_task === null ? null : Number(row.local_task), title: String(row.title), state: String(row.last_state), pr: row.pr === null ? null : Number(row.pr), head: row.head === null ? null : String(row.head), updatedAt: Number(row.updated_at) });

export interface Task extends PlanningFields {
  offer?: TaskOffer;
  cancelled?: TaskCancellation;
  external?: GitHubSource;
  planningRevision?: number;
  /** #334: an intake draft. Backlog work that is never offered or pulled until the person approves it; split children inherit it. */
  draft?: true;
  id: number;
  title: string;
  detail: string;
  class: TaskClass;
  profile?: import("./profiles.ts").ProfileName;
  profileClass?: string;
  /** Catalog guidance id only, never an authority role (#295). */
  role?: string;
  owner: PeerId | null;
  /** Null for legacy rows; only Tasks chooses or changes a planner. */
  planner?: PeerId | null;
  reviewer: PeerId | null;
  state: TaskState;
  refs: TaskRefs;
  /** Absent only on tasks built outside the board (tests); the board always returns one, `{}` when none was given. */
  plan?: TaskPlan;
  /** Artifact identities and bounded evidence, owned by Tasks (#257). */
  sdlc?: SdlcReceipt;
  /** Host-derived observation for one head, never accepted from task tool arguments. */
  codeSymbols?: TaskCodeSymbols;
  /** Tasks that must be approved before this one is offered; planning edits are limited to unstarted backlog. */
  deps?: number[];
  /** Who routing offers the task first once nothing is left to wait for (issue #207); null when nobody was named. */
  reserved?: PeerId | null;
  signals: string[];
  /** consecutive changes_requested verdicts */
  rejections: number;
  history: HistoryEntry[];
  created: number;
  updated: number;
}

/** Structured execution evidence, including legacy rows whose owner was later cleared. */
export function taskHasStarted(task: Pick<Task, "history">): boolean {
  return task.history.some(entry => ["accepted", "done", "done (checking)", "check passed", "check failed", "changes_requested", "approved", "reopened", "integration requested", "integrated"].includes(entry.event));
}
/** S9 return eligibility never erases the historical acceptance used by cancellation and undo. */
export function taskHasWorkEvidence(task: Pick<Task, "history" | "refs" | "sdlc">): boolean {
  return !!(task.refs.branch || task.refs.commit || task.sdlc?.localHead || task.sdlc?.localResult || task.sdlc?.reviewedHead || task.sdlc?.pr)
    || task.history.some(entry => entry.event === "done" || entry.event.startsWith("done (") || entry.event.startsWith("check ")
      || ["changes_requested", "approved", "reopened", "integration requested", "integration unresolved", "integrated"].includes(entry.event));
}
/** A successful untouched return permits replanning, without changing historical start evidence. */
export function taskCanPlan(task: Pick<Task, "history" | "refs" | "sdlc">): boolean {
  if (!taskHasStarted(task)) return true;
  const returned = task.history.findLastIndex(entry => entry.event === "backlog returned untouched");
  const accepted = task.history.findLastIndex(entry => entry.event === "accepted");
  return returned > accepted && !taskHasWorkEvidence(task);
}
/** First offer boundary; staged work has none until it is pulled. */
export function taskProposalAt(task: Pick<Task, "history">): number | undefined {
  return task.history.find(entry => entry.event === "proposed" || entry.event === "backlog pulled")?.at;
}
/** Readiness carries out a pending pull; ownership or other later changes still fence undo. */
export function planningUndoEntry(task: Pick<Task, "history">): HistoryEntry | undefined {
  return task.history.findLast(item => item.event !== "memory reference started" && (item.by !== HUB || item.event !== "ready"));
}

/** The moves the state machine allows. `accept` and `done` are transitions, not states: they carried no behaviour of their own. */
const MOVES: Record<TaskState, TaskState[]> = {
  backlog: ["proposed", "cancelled"],
  proposed: ["in_progress", "backlog", "cancelled"],
  in_progress: ["in_review", "approved", "proposed", "cancelled"], // approved: class without a reviewer; proposed: owner declined or was taken off
  in_review: ["approved", "changes_requested", "cancelled"],
  changes_requested: ["in_progress", "proposed", "cancelled"], // proposed: declined redo waits for reassignment
  approved: [],
  cancelled: [],
};

const JSON_COLS = ["refs", "plan", "deps", "signals", "history", "sdlc"] as const;
// Separate storage keeps older SELECT * readers from exporting unscreened derived metadata.
const TASK_SELECT = "SELECT tasks.*, (SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload END FROM task_code_symbols WHERE task=tasks.id) AS code_symbols FROM tasks";

/** Task board in `.agenthub/state/hub.db`. It outlives the hub process: `ahub kill` leaves the file. */
export class Board {
  private readonly db: Database;
  private pendingChanges: { task: Task; entry: HistoryEntry }[] | undefined;
  /** Every recorded change, as it lands (telemetry, issue #40). */
  onChange?: (task: Task, entry: HistoryEntry) => void;
  /** Host lifecycle policy, installed by Tasks; off projects keep their original history shape. */
  trackPlanRevisions?: () => boolean;
  /** Fixed host-owned pure selection; no model, network or asynchronous work is admitted inside the insert. */
  proposalPlanner?: (task: Task) => PlannerBinding;
  private changed(task: Task, entry: HistoryEntry): void {
    if (this.pendingChanges) { this.pendingChanges.push({ task, entry }); return; }
    try { this.onChange?.(task, entry); } catch { /* never throw after a board write */ }
  }
  /** Multi-row changes become observable only once their transaction commits. */
  private atomic<T>(write: () => T): T {
    if (this.pendingChanges) throw new Error("nested board transaction is not supported");
    const changes: { task: Task; entry: HistoryEntry }[] = [];
    this.pendingChanges = changes;
    let result: T;
    try { result = this.db.transaction(write)(); }
    finally { this.pendingChanges = undefined; }
    for (const change of changes) this.changed(change.task, change.entry);
    return result;
  }

  /** Keep the generation and business write atomic without changing Bun's reported row count. */
  private taskWrite<T extends { changes: number }>(write: () => T): T {
    return this.db.transaction(() => {
      const result = { ...write() };
      if (result.changes) this.db.run("UPDATE board_status_revision SET revision=revision+1 WHERE id=1");
      return result;
    })();
  }

  statusRevision(): number {
    return (this.db.query("SELECT revision FROM board_status_revision WHERE id=1").get() as { revision: number }).revision;
  }

  constructor(path: string) {
    this.db = openHubDatabase(path, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', class TEXT NOT NULL,
      owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]',
      rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    // Who did well or badly at which class, for demotion (issue #36). Only peers, classes and times: no task text.
    this.db.run("CREATE TABLE IF NOT EXISTS outcomes (peer TEXT NOT NULL, class TEXT NOT NULL, ok INTEGER NOT NULL, at INTEGER NOT NULL)");
    this.db.run("CREATE INDEX IF NOT EXISTS outcomes_class_at ON outcomes (class, at)");
    // How reviews turned out, per (implementer, reviewer, class) (issue #35): approved, contradicted later, caught, escalated.
    this.db.run("CREATE TABLE IF NOT EXISTS reviews (implementer TEXT NOT NULL, reviewer TEXT NOT NULL, class TEXT NOT NULL, kind TEXT NOT NULL, task INTEGER NOT NULL, at INTEGER NOT NULL)");
    // ponytail: kept for good (a record is the whole history); prune by age if it ever grows large.
    this.db.run("CREATE INDEX IF NOT EXISTS reviews_class ON reviews (class)");
    this.db.run("CREATE INDEX IF NOT EXISTS reviews_task ON reviews (task)");
    // Boards from before issues #31 and #34 lack these columns; existing rows get the defaults.
    const have = new Set((this.db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, empty] of [["plan", "{}"], ["deps", "[]"]] as const) {
      if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${empty}'`);
    }
    // And from before issue #207: existing rows reserve nobody.
    for (const col of ["offer", "cancelled"]) if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
    this.db.run("CREATE TABLE IF NOT EXISTS task_stalls (task INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    this.db.run(`CREATE INDEX IF NOT EXISTS task_stalls_queue_pressure ON task_stalls(task) WHERE ${QUEUE_PRESSURE_STALL}`);
    this.db.run("CREATE INDEX IF NOT EXISTS tasks_human_reviews ON tasks(id) WHERE state='in_review' AND reviewer='user'");
    // #481 S7: one row per log-tier band breach episode already announced, so a restart never repeats the notice.
    this.db.run("CREATE TABLE IF NOT EXISTS band_notices (marker TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // #481 S7: one row per scheduled security scan. Counts only (no alert text); `total` is null when a named source could not be read completely.
    this.db.run("CREATE TABLE IF NOT EXISTS security_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, repo TEXT NOT NULL, sources TEXT NOT NULL, counts TEXT NOT NULL, total INTEGER)");
    // #843 AC3: one row per (agent id, installed version, planner) already queued, so a restart never repeats it.
    this.db.run("CREATE TABLE IF NOT EXISTS agent_drift_notices (marker TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // Derived status-cache generation: only Board task/stall writes advance it, never journal writes.
    this.db.run("CREATE TABLE IF NOT EXISTS board_status_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)");
    this.db.run("INSERT OR IGNORE INTO board_status_revision VALUES (1,0)");
    if (!have.has("planner")) this.db.run("ALTER TABLE tasks ADD COLUMN planner TEXT");
    this.db.run("CREATE INDEX IF NOT EXISTS tasks_planner_present ON tasks(planner) WHERE planner IS NOT NULL");
    if (!have.has("reserved")) this.db.run("ALTER TABLE tasks ADD COLUMN reserved TEXT");
    if (!have.has("external_repo")) this.db.run("ALTER TABLE tasks ADD COLUMN external_repo TEXT");
    if (!have.has("external_issue")) this.db.run("ALTER TABLE tasks ADD COLUMN external_issue INTEGER");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_issue ON tasks(external_repo,external_issue) WHERE external_repo IS NOT NULL AND external_issue IS NOT NULL");
    if (!have.has("sdlc")) this.db.run("ALTER TABLE tasks ADD COLUMN sdlc TEXT");
    this.db.run("CREATE TABLE IF NOT EXISTS task_code_symbols (task INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    this.db.run("DELETE FROM task_code_symbols WHERE task NOT IN (SELECT id FROM tasks) OR task IN (SELECT id FROM tasks WHERE json_valid(signals) AND EXISTS (SELECT 1 FROM json_each(signals) WHERE value IN ('pii','pii_path')))");
    if (!have.has("task_role")) this.db.run("ALTER TABLE tasks ADD COLUMN task_role TEXT");
    if (!have.has("project_profile")) this.db.run("ALTER TABLE tasks ADD COLUMN project_profile TEXT");
    for (const col of ["rank", "priority", "release", "planned_start", "due"]) {
      if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN "${col}" INTEGER`);
    }
    if (!have.has("pinned")) this.db.run("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    if (!have.has("draft")) this.db.run("ALTER TABLE tasks ADD COLUMN draft INTEGER NOT NULL DEFAULT 0");
    if (!have.has("planning_revision")) this.db.run("ALTER TABLE tasks ADD COLUMN planning_revision INTEGER NOT NULL DEFAULT 0");
    this.db.run(`CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
      release_order INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'planning', planned_start INTEGER, cut INTEGER, ship INTEGER,
      activated_at INTEGER, frozen_at INTEGER, shipped_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0)`);
    if (!(this.db.query("PRAGMA table_info(releases)").all() as { name: string }[]).some(row => row.name === "planner")) this.db.run("ALTER TABLE releases ADD COLUMN planner TEXT");
    this.db.run("CREATE INDEX IF NOT EXISTS releases_planner_present ON releases(planner) WHERE planner IS NOT NULL");
    if (!(this.db.query("PRAGMA table_info(releases)").all() as { name: string }[]).some(row => row.name === "train")) this.db.run("ALTER TABLE releases ADD COLUMN train TEXT");

    this.db.run(`CREATE TABLE IF NOT EXISTS research_campaigns (
      id TEXT NOT NULL, project TEXT NOT NULL, parent_task_id INTEGER NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, private INTEGER NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, approved_by TEXT, approved_at INTEGER,
      closed_by TEXT, closed_at INTEGER, closed_reason TEXT, PRIMARY KEY(id,revision))`);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS research_campaigns_active_parent ON research_campaigns(project,parent_task_id) WHERE status='approved'");
    this.db.run(`CREATE TABLE IF NOT EXISTS research_units (
      campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, unit_id TEXT NOT NULL, task_id INTEGER NOT NULL,
      round INTEGER NOT NULL, purpose TEXT NOT NULL, adopted INTEGER NOT NULL, PRIMARY KEY(campaign_id,revision,unit_id))`);
    this.db.run("CREATE INDEX IF NOT EXISTS research_units_task ON research_units(task_id)");
    this.db.run(`CREATE TABLE IF NOT EXISTS research_dispatch (
      campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL, eligible_owners TEXT,
      PRIMARY KEY(campaign_id,revision))`);
    // #603: the owner whose queued offer a study hold made the bus discard, kept so approving the study offers the retained task again after a restart.
    this.db.run("CREATE TABLE IF NOT EXISTS research_dropped_offers (task_id INTEGER PRIMARY KEY, owner TEXT NOT NULL)");
    // #604 (agent-hub#1030): cross-project handoff. `task_handoff_origin` is the TARGET's record of where a task came from (one row per task it created for another project); `task_handoff_outbound`
    // is the ORIGIN's record of what it handed to another project and the last state that project reported. Both are additive: a daemon without `task_handoff` never reads them, so a target
    // lacking the feature is refused at recovery while either holds a row.
    this.db.run("CREATE TABLE IF NOT EXISTS task_handoff_origin (task_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, peer TEXT NOT NULL, origin_task INTEGER, at INTEGER NOT NULL)");
    this.db.run(`CREATE TABLE IF NOT EXISTS task_handoff_outbound (remote_project TEXT NOT NULL, remote_task INTEGER NOT NULL, origin_peer TEXT NOT NULL, local_task INTEGER,
      title TEXT NOT NULL, last_state TEXT NOT NULL, pr INTEGER, head TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(remote_project, remote_task))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS research_handoffs (
      campaign_id TEXT NOT NULL, unit_id TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL,
      task_id INTEGER NOT NULL, body TEXT NOT NULL, by_peer TEXT NOT NULL, at INTEGER NOT NULL, private INTEGER NOT NULL,
      PRIMARY KEY(campaign_id,unit_id,seq))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS research_protocols (
      hash TEXT PRIMARY KEY, project TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_revision INTEGER NOT NULL, task_id INTEGER NOT NULL, body TEXT NOT NULL,
      by_peer TEXT NOT NULL, at INTEGER NOT NULL, private INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS research_attempts (
      attempt_id TEXT PRIMARY KEY, project TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_revision INTEGER NOT NULL, protocol_hash TEXT NOT NULL, task_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, by_peer TEXT NOT NULL,
      at INTEGER NOT NULL, private INTEGER NOT NULL, UNIQUE(project,idempotency_key))`);
    this.db.run("CREATE INDEX IF NOT EXISTS research_attempts_campaign ON research_attempts(project,campaign_id)");
    this.db.run(`CREATE TABLE IF NOT EXISTS research_attempt_events (
      attempt_id TEXT NOT NULL, project TEXT NOT NULL, seq INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, by_peer TEXT NOT NULL,
      at INTEGER NOT NULL, private INTEGER NOT NULL, PRIMARY KEY(attempt_id,seq), UNIQUE(project,idempotency_key))`);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS research_attempt_one_end ON research_attempt_events(attempt_id) WHERE kind='end'");
    this.db.run("CREATE INDEX IF NOT EXISTS research_attempt_private_event ON research_attempt_events(attempt_id) WHERE private=1");
    this.db.run(`CREATE TABLE IF NOT EXISTS research_attempt_observations (
      attempt_id TEXT NOT NULL, event_seq INTEGER NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
      PRIMARY KEY(attempt_id,event_seq))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS research_plans (
      hash TEXT PRIMARY KEY, project TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_revision INTEGER NOT NULL,
      task_id INTEGER NOT NULL, body TEXT NOT NULL, by_peer TEXT NOT NULL, at INTEGER NOT NULL, private INTEGER NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS research_plans_campaign ON research_plans(project,campaign_id)");
    this.db.run(`CREATE TABLE IF NOT EXISTS research_protocol_approvals (
      protocol_hash TEXT PRIMARY KEY, evaluator_hash TEXT NOT NULL, approved_by TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS research_protocol_context (
      protocol_hash TEXT PRIMARY KEY, prior_attempt_id TEXT, prior_end_seq INTEGER, context_sha256 TEXT NOT NULL)`);

  }

  /** #604: a handoff row exists in either direction, so a recovery target must know `task_handoff`. */
  hasHandoffState(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM task_handoff_origin) OR EXISTS(SELECT 1 FROM task_handoff_outbound) AS present").get() as { present: number }).present === 1;
  }

  /** TARGET side: where one of this project's tasks came from. The origin peer is a record, never a roster peer or an actor. */
  handoffOrigin(taskId: number): { projectId: string; peer: string; originTask: number | null; at: number } | undefined {
    const row = this.db.query("SELECT project_id, peer, origin_task, at FROM task_handoff_origin WHERE task_id=?").get(taskId) as { project_id: string; peer: string; origin_task: number | null; at: number } | null;
    return row ? { projectId: row.project_id, peer: row.peer, originTask: row.origin_task, at: row.at } : undefined;
  }
  setHandoffOrigin(taskId: number, origin: { projectId: string; peer: string; originTask?: number }): void {
    this.db.query("INSERT INTO task_handoff_origin(task_id, project_id, peer, origin_task, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING").run(taskId, origin.projectId, origin.peer, origin.originTask ?? null, Date.now());
  }

  /** ORIGIN side: what this project handed to another one. Keyed by the target project and its task id, so a repeated event updates one row. */
  handoffOutbound(): HandoffOutboundRow[] {
    return (this.db.query("SELECT remote_project, remote_task, origin_peer, local_task, title, last_state, pr, head, updated_at FROM task_handoff_outbound ORDER BY updated_at DESC, remote_project, remote_task LIMIT 200").all() as Record<string, unknown>[]).map(handoffOutboundFromRow);
  }
  handoffOutboundFor(remoteProject: string, remoteTask: number): HandoffOutboundRow | undefined {
    const row = this.db.query("SELECT remote_project, remote_task, origin_peer, local_task, title, last_state, pr, head, updated_at FROM task_handoff_outbound WHERE remote_project=? AND remote_task=?").get(remoteProject, remoteTask) as Record<string, unknown> | null;
    return row ? handoffOutboundFromRow(row) : undefined;
  }
  recordHandoffOutbound(row: { remoteProject: string; remoteTask: number; originPeer: string; localTask?: number; title: string; state: string; pr?: number; head?: string }): void {
    this.db.query(`INSERT INTO task_handoff_outbound(remote_project, remote_task, origin_peer, local_task, title, last_state, pr, head, updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(remote_project, remote_task) DO UPDATE SET last_state=excluded.last_state, pr=COALESCE(excluded.pr, pr), head=COALESCE(excluded.head, head), updated_at=excluded.updated_at`)
      .run(row.remoteProject, row.remoteTask, row.originPeer, row.localTask ?? null, row.title, row.state, row.pr ?? null, row.head ?? null, Date.now());
  }
  /** A digest over both tables, so a recovery that restores or loses a row is seen. */
  handoffIntegrity(): { origins: number; outbound: number; digest: string } {
    return this.db.transaction(() => {
      const digest = createHash("sha256").update("agent-hub.handoff-integrity/v1\n");
      let origins = 0, outbound = 0;
      for (const row of this.db.query("SELECT task_id, project_id, peer, origin_task, at FROM task_handoff_origin ORDER BY task_id").iterate()) { digest.update(JSON.stringify(row)).update("\n"); origins++; }
      for (const row of this.db.query("SELECT remote_project, remote_task, origin_peer, local_task, title, last_state, pr, head, updated_at FROM task_handoff_outbound ORDER BY remote_project, remote_task").iterate()) { digest.update(JSON.stringify(row)).update("\n"); outbound++; }
      return { origins, outbound, digest: digest.digest("hex") };
    })();
  }

  /** #601: the ids of a project's campaigns, oldest first, for `ahub study show` with no id. A read: no row is written. */
  researchCampaignIds(project: string): string[] {
    if (!researchText(project)) throw researchFailure();
    return (this.db.query("SELECT DISTINCT id FROM research_campaigns WHERE project=? ORDER BY id").all(project) as { id: string }[]).map(row => row.id);
  }

  /**
   * One page of a project's campaign ids, in id order: at most `limit` (never more than 50, the spec's readback bound) strictly after the cursor `after`. `next` is the last id of a full page that
   * has more behind it, to pass as the next `after`; absent when this is the last page. The query itself carries the bound, so a project with many drafts costs one page, not all of them.
   */
  researchCampaignPage(project: string, after?: string, limit = 50): { ids: string[]; next?: string } {
    if (!researchText(project) || after !== undefined && !researchId(after) || !Number.isSafeInteger(limit) || limit < 1) throw researchFailure();
    const size = Math.min(limit, 50);
    const rows = this.db.query("SELECT DISTINCT id FROM research_campaigns WHERE project=? AND id>? ORDER BY id LIMIT ?").all(project, after ?? "", size + 1) as { id: string }[];
    const ids = rows.slice(0, size).map(row => row.id);
    return rows.length > size ? { ids, next: ids[ids.length - 1]! } : { ids };
  }

  researchCampaign(id: string, revision?: number): ResearchCampaignRecord | undefined {
    if (!researchId(id) || revision !== undefined && !researchInteger(revision)) throw researchFailure();
    const row = (revision === undefined
      ? this.db.query(`${RESEARCH_CAMPAIGN_SELECT} WHERE id=? ORDER BY revision DESC LIMIT 1`).get(id)
      : this.db.query(`${RESEARCH_CAMPAIGN_SELECT} WHERE id=? AND revision=?`).get(id, revision)) as ResearchCampaignRow | null;
    if (!row) return undefined;
    const campaign = researchCampaignFromRow(row);
    const dispatch = this.db.query("SELECT version,CASE WHEN length(CAST(eligible_owners AS BLOB))<=32768 OR eligible_owners IS NULL THEN eligible_owners ELSE '!' END AS eligible_owners FROM research_dispatch WHERE campaign_id=? AND revision=?")
      .get(id, campaign.revision) as { version: number; eligible_owners: string | null } | null;
    if (!dispatch) return campaign;
    if (dispatch.version !== 1 || campaign.approvedBy === undefined) throw researchFailure();
    let owners: string[] | undefined;
    if (dispatch.eligible_owners !== null) {
      try { owners = JSON.parse(dispatch.eligible_owners) as string[]; } catch { throw researchFailure(); }
      if (!Array.isArray(owners) || owners.length < 1 || owners.length > 256 || owners.some(owner => !researchText(owner, 64) || !/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) || new Set(owners).size !== owners.length) throw researchFailure();
    }
    if (!!campaign.contract.budget?.hardCap.length !== !!owners?.length) throw researchFailure();
    return { ...campaign, dispatchVersion: 1, ...(owners ? { eligibleOwners: owners } : {}) };
  }

  private researchBindings(campaign: ResearchCampaignRecord): ResearchUnitBinding[] {
    const rows = this.db.query("SELECT campaign_id,revision,unit_id,task_id,round,purpose,adopted FROM research_units WHERE campaign_id=? AND revision=? ORDER BY unit_id LIMIT 33").all(campaign.id, campaign.revision) as ResearchUnitRow[];
    const expected = new Map(campaign.contract.units.map(unit => [unit.id, unit]));
    if (rows.length > 32 || rows.length !== (campaign.approvedBy === undefined ? 0 : expected.size)) throw researchFailure();
    const tasks = new Set<number>();
    return rows.map(row => {
      const unit = expected.get(row.unit_id);
      if (!unit || row.campaign_id !== campaign.id || row.revision !== campaign.revision || !researchInteger(row.task_id) || tasks.has(row.task_id) ||
        row.round !== unit.round || row.purpose !== unit.purpose || ![0, 1].includes(row.adopted) || (row.adopted === 1) !== (unit.adoptTaskId !== undefined) ||
        unit.adoptTaskId !== undefined && unit.adoptTaskId !== row.task_id) throw researchFailure();
      tasks.add(row.task_id);
      return { campaignId: row.campaign_id, revision: row.revision, unitId: row.unit_id, taskId: row.task_id, round: row.round, purpose: unit.purpose, adopted: row.adopted === 1 };
    });
  }

  researchCampaignBindings(id: string, revision: number): ResearchUnitBinding[] {
    const campaign = this.researchCampaign(id, revision);
    return campaign ? this.researchBindings(campaign) : [];
  }

  /** Most recent persisted association, including a unit omitted from intervening revisions. */
  researchLatestUnitBinding(campaignId: string, unitId: string): ResearchUnitBinding | undefined {
    if (!researchId(campaignId) || typeof unitId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(unitId)) throw researchFailure();
    const row = this.db.query("SELECT revision FROM research_units WHERE campaign_id=? AND unit_id=? ORDER BY revision DESC LIMIT 1")
      .get(campaignId, unitId) as { revision: number } | null;
    if (!row) return undefined;
    const campaign = this.researchCampaign(campaignId, row.revision);
    if (!campaign) throw researchFailure();
    const binding = this.researchBindings(campaign).find(unit => unit.unitId === unitId);
    if (!binding) throw researchFailure();
    return binding;
  }

  /** Lifetime unit association, including superseded/closed revisions; never reinterpret a task as another unit. */
  researchTaskBinding(taskId: number): ResearchUnitBinding | undefined {
    if (!researchInteger(taskId)) throw researchFailure();
    const row = this.db.query("SELECT campaign_id,revision FROM research_units WHERE task_id=? ORDER BY campaign_id,revision,unit_id LIMIT 1").get(taskId) as { campaign_id: string; revision: number } | null;
    if (!row) return undefined;
    const campaign = this.researchCampaign(row.campaign_id, row.revision);
    if (!campaign) throw researchFailure();
    const binding = this.researchBindings(campaign).find(unit => unit.taskId === taskId);
    if (!binding) throw researchFailure();
    return binding;
  }

  /** Resolve lifetime membership against the latest revision; an omitted unit or a draft never inherits old dispatch approval. */
  researchDispatchBinding(taskId: number): { campaign: ResearchCampaignRecord; binding?: ResearchUnitBinding } | undefined {
    if (!researchInteger(taskId)) throw researchFailure();
    const rows = this.db.query("SELECT DISTINCT campaign_id FROM research_units WHERE task_id=? ORDER BY campaign_id LIMIT 2").all(taskId) as { campaign_id: string }[];
    if (!rows.length) return undefined;
    if (rows.length !== 1) throw researchFailure();
    const campaign = this.researchCampaign(rows[0]!.campaign_id);
    if (!campaign) throw researchFailure();
    const binding = this.researchBindings(campaign).find(unit => unit.taskId === taskId);
    return { campaign, ...(binding ? { binding } : {}) };
  }

  private researchHandoffFromRow(row: ResearchHandoffRow): ResearchHandoffRecord {
    try {
      if (typeof row.body !== "string" || Buffer.byteLength(row.body, "utf8") > 65536 || !researchInteger(row.seq) || !researchInteger(row.at, 0) || !researchText(row.by_peer) || ![0, 1].includes(row.private)) throw researchFailure();
      const handoff = parseResearchHandoff(JSON.parse(row.body)), campaign = this.researchCampaign(row.campaign_id, row.revision);
      const unit = campaign?.contract.units.find(value => value.id === row.unit_id);
      const binding = campaign && this.researchBindings(campaign).find(value => value.unitId === row.unit_id);
      if (!campaign || !unit || !binding || handoff.campaignId !== row.campaign_id || handoff.revision !== row.revision || handoff.unitId !== row.unit_id || handoff.taskId !== row.task_id || binding.taskId !== row.task_id ||
        handoff.evidence.some(entry => !unit.sourceIds.includes(entry.sourceId)) || handoff.contradictions.some(entry => entry.sourceIds.some(source => !unit.sourceIds.includes(source)))) throw researchFailure();
      return { handoff, seq: row.seq, by: row.by_peer, at: row.at, private: row.private === 1 || campaign.private };
    } catch { throw researchFailure(); }
  }

  /** At most one latest handoff per unit; history remains append-only and older stable-unit evidence survives a revision. */
  researchHandoffs(campaignId: string, revision?: number): ResearchHandoffRecord[] {
    const campaign = this.researchCampaign(campaignId, revision);
    if (!campaign) return [];
    const rows = this.db.query(`SELECT campaign_id,unit_id,seq,revision,task_id,
      CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,by_peer,at,private
      FROM research_handoffs AS h WHERE campaign_id=? AND revision<=? AND unit_id IN (${campaign.contract.units.map(() => "?").join(",")}) AND seq=(SELECT MAX(seq) FROM research_handoffs AS old WHERE old.campaign_id=h.campaign_id AND old.unit_id=h.unit_id AND old.revision<=?) ORDER BY unit_id LIMIT 33`)
      .all(campaignId, campaign.revision, ...campaign.contract.units.map(unit => unit.id), campaign.revision) as ResearchHandoffRow[];
    if (rows.length > 32) throw researchFailure();
    return rows.map(row => this.researchHandoffFromRow(row)).filter(row => campaign.contract.units.some(unit => unit.id === row.handoff.unitId));
  }

  /** Caller authority/privacy screening belongs to Tasks; the transaction re-checks every persisted binding and ownership fact. */
  recordResearchHandoff(input: ResearchHandoffV1, project: string, by: PeerId, at: number, expectedTaskFlow: number): ResearchHandoffRecord {
    const handoff = parseResearchHandoff(input);
    if (!researchText(project) || !researchText(by) || !researchInteger(at, 0) || !researchInteger(expectedTaskFlow, 0)) throw researchFailure();
    return this.atomic(() => {
      const current = this.researchDispatchBinding(handoff.taskId), campaign = current?.campaign, binding = current?.binding;
      const task = this.get(handoff.taskId), unit = campaign?.contract.units.find(value => value.id === handoff.unitId);
      if (!campaign || campaign.id !== handoff.campaignId || campaign.revision !== handoff.revision || campaign.status !== "approved" || campaign.project !== project || !binding || binding.unitId !== handoff.unitId || !unit ||
        !task || task.owner !== by || task.state !== "in_progress" || task.history.length !== expectedTaskFlow ||
        handoff.evidence.some(entry => !unit.sourceIds.includes(entry.sourceId)) || handoff.contradictions.some(entry => entry.sourceIds.some(source => !unit.sourceIds.includes(source)))) throw researchFailure();
      const last = this.db.query("SELECT MAX(seq) AS seq FROM research_handoffs WHERE campaign_id=? AND unit_id=?").get(campaign.id, unit.id) as { seq: number | null };
      const seq = (last.seq ?? 0) + 1;
      if (!researchInteger(seq)) throw researchFailure();
      const privateRecord = campaign.private || task.signals.some(signal => signal === "pii" || signal === "pii_path");
      this.taskWrite(() => this.db.query("INSERT INTO research_handoffs(campaign_id,unit_id,seq,revision,task_id,body,by_peer,at,private) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(campaign.id, unit.id, seq, campaign.revision, task.id, JSON.stringify(handoff), by, at, privateRecord ? 1 : 0));
      this.update(task.id, by, "study handoff", {}, `${campaign.id} revision ${campaign.revision}; evidence ${handoff.evidence.length}`, {}, expectedTaskFlow);
      return { handoff, seq, by, at, private: privateRecord };
    });
  }

  hasResearchDispatchState(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM research_campaigns) OR EXISTS(SELECT 1 FROM research_units) OR EXISTS(SELECT 1 FROM research_dispatch) OR EXISTS(SELECT 1 FROM research_handoffs) AS present").get() as { present: number }).present === 1;
  }

  /** #603: a persisted study re-offer needs a target that knows `research_dropped_offers`; `research_dispatch` alone does not (the additive floor rule). */
  hasResearchDroppedOffers(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM research_dropped_offers) AS present").get() as { present: number }).present === 1;
  }

  researchDispatchIntegrity(): { activations: number; handoffs: number; digest: string } {
    return this.db.transaction(() => {
      const digest = createHash("sha256").update("agent-hub.research-dispatch-integrity/v1\n");
      let activations = 0, handoffs = 0;
      for (const row of this.db.query("SELECT campaign_id,revision,version,eligible_owners FROM research_dispatch ORDER BY campaign_id,revision").iterate() as Iterable<{ campaign_id: string; revision: number; version: number; eligible_owners: string | null }>) {
        const campaign = this.researchCampaign(row.campaign_id, row.revision);
        if (!campaign || campaign.dispatchVersion !== 1) throw researchFailure();
        digest.update(JSON.stringify(row)).update("\n"); activations++;
      }
      for (const row of this.db.query("SELECT campaign_id,unit_id,seq,revision,task_id,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,by_peer,at,private FROM research_handoffs ORDER BY campaign_id,unit_id,seq").iterate() as Iterable<ResearchHandoffRow>) {
        const record = this.researchHandoffFromRow(row);
        digest.update(JSON.stringify(record)).update("\n"); handoffs++;
      }
      // Dropped-offer rows join the digest only when there are any, so a project without one keeps the digest it always had.
      for (const row of this.db.query("SELECT task_id,owner FROM research_dropped_offers ORDER BY task_id").iterate() as Iterable<{ task_id: number; owner: string }>) {
        this.droppedOfferRow(row);
        digest.update("dropped-offer\n").update(JSON.stringify(row)).update("\n");
      }
      return { activations, handoffs, digest: digest.digest("hex") };
    })();
  }

  /** A row names a task bound to a research unit in some revision (the drop happens while a newer draft has no binding yet) and a peer id; anything else is corrupt state. */
  private droppedOfferRow(row: { task_id: number; owner: string }): { taskId: number; owner: string } {
    if (!researchInteger(row.task_id) || !researchText(row.owner, 64) || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.owner) || !this.db.query("SELECT 1 FROM research_units WHERE task_id=? LIMIT 1").get(row.task_id)) throw researchFailure();
    return { taskId: row.task_id, owner: row.owner };
  }

  /** #603: remember that a study hold discarded this owner's queued offer for the task. One row per task; a later drop replaces it. */
  recordResearchDroppedOffer(taskId: number, owner: string): void {
    this.droppedOfferRow({ task_id: taskId, owner });
    this.db.query("INSERT INTO research_dropped_offers(task_id,owner) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner").run(taskId, owner);
  }

  researchDroppedOffer(taskId: number): string | undefined {
    if (!researchInteger(taskId)) throw researchFailure();
    const row = this.db.query("SELECT task_id,owner FROM research_dropped_offers WHERE task_id=?").get(taskId) as { task_id: number; owner: string } | null;
    return row ? this.droppedOfferRow(row).owner : undefined;
  }

  clearResearchDroppedOffer(taskId: number): void {
    if (!researchInteger(taskId)) throw researchFailure();
    this.db.query("DELETE FROM research_dropped_offers WHERE task_id=?").run(taskId);
  }

  /** Bodies are append-only; a new revision cannot change its project's or parent's identity or lower privacy. */
  saveResearchCampaignDraft(record: ResearchCampaignRecord, expectedLatest: number | undefined, expectedParentFlow: number): ResearchCampaignRecord {
    const checked = checkedResearchCampaign(record);
    if (checked.status !== "draft" || checked.approvedBy !== undefined || checked.closedBy !== undefined ||
      expectedLatest !== undefined && !researchInteger(expectedLatest) || checked.revision !== (expectedLatest ?? 0) + 1 || !researchInteger(expectedParentFlow, 0)) throw researchFailure();
    return this.atomic(() => {
      const parent = this.get(checked.parentTaskId), latest = this.researchCampaign(checked.id);
      if (!parent || parent.history.length !== expectedParentFlow || latest?.revision !== expectedLatest || latest &&
        (latest.project !== checked.project || latest.parentTaskId !== checked.parentTaskId || latest.status === "closed")) throw researchFailure();
      const stored = { ...checked, private: checked.private || latest?.private === true };
      this.taskWrite(() => this.db.query("INSERT INTO research_campaigns(id,project,parent_task_id,revision,status,body,body_sha256,private,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(stored.id, stored.project, stored.parentTaskId, stored.revision, "draft", JSON.stringify(stored.contract), stored.hash, stored.private ? 1 : 0, stored.createdBy, stored.createdAt));
      this.update(parent.id, stored.createdBy, latest ? "study revised" : "study drafted", {}, `${stored.id} revision ${stored.revision}`, {}, expectedParentFlow);
      return this.researchCampaign(stored.id, stored.revision)!;
    });
  }

  /** An approved replay recreates nothing; only monotone privacy tightening may write, without task history or approval changes. */
  activateCampaign(id: string, revision: number, project: string, by: PeerId, at: number, prepared: readonly PreparedResearchUnit[], expectedParentFlow: number, privateRecord = false, dispatch?: { eligibleOwners?: readonly string[] }): { campaign: ResearchCampaignRecord; bindings: ResearchUnitBinding[]; children: Task[] } {
    if (!researchText(project) || !researchText(by) || !researchInteger(at, 0) || typeof privateRecord !== "boolean") throw researchFailure();
    return this.atomic(() => {
      const campaign = this.researchCampaign(id, revision);
      if (!campaign || campaign.project !== project) throw researchFailure();
      if (campaign.status === "approved") {
        const bindings = this.researchBindings(campaign);
        if (privateRecord && !campaign.private) this.taskWrite(() => this.db.query("UPDATE research_campaigns SET private=1 WHERE id=? AND revision=? AND private=0").run(id, revision));
        return { campaign: this.researchCampaign(id, revision)!, bindings, children: [] };
      }
      const owners = dispatch?.eligibleOwners === undefined ? undefined : [...dispatch.eligibleOwners];
      if (owners && (owners.length < 1 || owners.length > 256 || owners.some(owner => !researchText(owner, 64) || !/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) || new Set(owners).size !== owners.length) ||
        dispatch !== undefined && !!campaign.contract.budget?.hardCap.length !== !!owners?.length) throw researchFailure();
      const parent = this.get(campaign.parentTaskId), latest = this.researchCampaign(id);
      const activeRow = this.db.query("SELECT revision FROM research_campaigns WHERE id=? AND status='approved' LIMIT 1").get(id) as { revision: number } | null;
      const active = activeRow ? this.researchCampaign(id, activeRow.revision) : undefined;
      if (campaign.status !== "draft" || latest?.revision !== revision || !researchInteger(expectedParentFlow, 0) || !parent || parent.history.length !== expectedParentFlow) throw researchFailure();
      if (this.db.query("SELECT 1 FROM research_campaigns WHERE project=? AND parent_task_id=? AND status='approved' AND id<>? LIMIT 1").get(project, campaign.parentTaskId, id)) throw new Error("another research campaign is active for this parent");
      if (this.researchBindings(campaign).length || prepared.length !== campaign.contract.units.length) throw researchFailure();
      const inputs = new Map<string, PreparedResearchUnit>(), units = new Map(campaign.contract.units.map(unit => [unit.id, unit]));
      const mapped = new Map<string, number>(), retained = new Map<string, Task>(), children: Task[] = [];
      const isPrivate = campaign.private || privateRecord;
      for (const entry of prepared) {
        const unit = units.get(entry.unitId);
        if (!unit || inputs.has(entry.unitId) || [entry.create, entry.adopt, entry.reuse].filter(value => value !== undefined).length !== 1) throw researchFailure();
        inputs.set(entry.unitId, entry);
        const prior = this.researchLatestUnitBinding(id, unit.id);
        if (prior) {
          const previous = this.researchCampaign(id, prior.revision), previousUnit = previous?.contract.units.find(value => value.id === unit.id);
          if (!entry.reuse || entry.reuse.taskId !== prior.taskId || !researchInteger(entry.reuse.flowRevision, 0) || prior.revision >= revision ||
            !previous || previous.project !== project || previous.parentTaskId !== campaign.parentTaskId || JSON.stringify(previousUnit) !== JSON.stringify(unit))
            throw new Error("a bound research unit must retain its task and definition; changed work requires a fresh unit id");
          const task = this.get(prior.taskId);
          if (!task || task.history.length !== entry.reuse.flowRevision || isPrivate && !task.signals.some(signal => signal === "pii" || signal === "pii_path")) throw researchFailure();
          mapped.set(unit.id, task.id); retained.set(unit.id, task);
        } else if (entry.reuse) {
          throw researchFailure();
        } else if (entry.adopt) {
          if (unit.adoptTaskId !== entry.adopt.taskId || !researchInteger(entry.adopt.flowRevision, 0)) throw researchFailure();
          const task = this.get(entry.adopt.taskId);
          if (!task || task.history.length !== entry.adopt.flowRevision || task.draft || !task.history.some(history => history.event === "draft approved") ||
            isPrivate && !task.signals.some(signal => signal === "pii" || signal === "pii_path")) throw researchFailure();
          if (this.db.query("SELECT 1 FROM research_units WHERE task_id=? AND (campaign_id<>? OR unit_id<>?) LIMIT 1").get(task.id, id, unit.id)) throw new Error("intake task is already bound to another research unit");
          mapped.set(unit.id, task.id); retained.set(unit.id, task);
        } else {
          const create = entry.create!;
          if (unit.adoptTaskId !== undefined || typeof create.title !== "string" || !create.title.trim() || create.title.length > 300 || !CLASSES.includes(create.class) || create.draft ||
            isPrivate && !create.signals?.includes("pii")) throw researchFailure();
        }
      }
      const pending = campaign.contract.units.filter(unit => !mapped.has(unit.id));
      while (pending.length) {
        const next = pending.findIndex(unit => unit.dependsOn.every(dependency => mapped.has(dependency)));
        if (next < 0) throw researchFailure();
        const unit = pending.splice(next, 1)[0]!, create = inputs.get(unit.id)!.create!;
        const deps = [...new Set([...(create.deps ?? []), ...unit.dependsOn.map(dependency => mapped.get(dependency)!)])];
        if (deps.some(dependency => !researchInteger(dependency) || !this.get(dependency))) throw researchFailure();
        const child = this.propose(by, { ...create, deps, backlog: true, draft: false });
        mapped.set(unit.id, child.id); children.push(child);
      }
      for (const [unitId, task] of retained) if (units.get(unitId)!.dependsOn.some(dependency => !task.deps?.includes(mapped.get(dependency)!))) throw new Error("retained research task dependencies differ from the campaign");
      for (const unit of campaign.contract.units) {
        const taskId = mapped.get(unit.id)!;
        if (this.db.query("SELECT 1 FROM research_units WHERE task_id=? AND (campaign_id<>? OR unit_id<>?) LIMIT 1").get(taskId, id, unit.id)) throw researchFailure();
        this.taskWrite(() => this.db.query("INSERT INTO research_units(campaign_id,revision,unit_id,task_id,round,purpose,adopted) VALUES(?,?,?,?,?,?,?)")
          .run(id, revision, unit.id, taskId, unit.round, unit.purpose, unit.adoptTaskId !== undefined ? 1 : 0));
      }
      this.taskWrite(() => this.db.query("UPDATE research_campaigns SET status='superseded',private=MAX(private,?) WHERE id=? AND project=? AND status='approved'").run(isPrivate ? 1 : 0, id, project));
      this.taskWrite(() => this.db.query("UPDATE research_campaigns SET status='approved',approved_by=?,approved_at=?,private=? WHERE id=? AND revision=? AND status='draft'")
        .run(by, at, isPrivate ? 1 : 0, id, revision));
      if (dispatch !== undefined) this.taskWrite(() => this.db.query("INSERT INTO research_dispatch(campaign_id,revision,version,eligible_owners) VALUES(?,?,1,?)")
        .run(id, revision, owners === undefined ? null : JSON.stringify(owners)));
      const nextUnits = new Set(campaign.contract.units.map(unit => unit.id));
      const nextEdges = new Set(campaign.contract.units.flatMap(unit => unit.dependsOn.map(dependency => `${unit.id}:${dependency}`)));
      const omittedUnits = active?.contract.units.filter(unit => !nextUnits.has(unit.id)).length ?? 0;
      const omittedEdges = active?.contract.units.flatMap(unit => unit.dependsOn.map(dependency => `${unit.id}:${dependency}`)).filter(edge => !nextEdges.has(edge)).length ?? 0;
      this.update(parent.id, by, "study approved", {}, `${id} revision ${revision}; omitted units ${omittedUnits}, dependencies ${omittedEdges}`, {}, expectedParentFlow);
      const approved = this.researchCampaign(id, revision)!;
      return { campaign: approved, bindings: this.researchBindings(approved), children };
    });
  }

  closeCampaign(id: string, revision: number, project: string, by: PeerId, at: number, reason: string, expectedParentFlow: number, privateRecord = false): ResearchCampaignRecord {
    if (!researchText(project) || !researchText(by) || !researchInteger(at, 0) || !researchText(reason, 4096) || typeof privateRecord !== "boolean") throw researchFailure();
    return this.atomic(() => {
      const campaign = this.researchCampaign(id, revision), latest = this.researchCampaign(id);
      if (!campaign || campaign.project !== project || latest?.revision !== revision) throw researchFailure();
      if (campaign.status === "closed") {
        if (privateRecord && !campaign.private) this.taskWrite(() => this.db.query("UPDATE research_campaigns SET private=1 WHERE id=? AND revision=? AND private=0").run(id, revision));
        return this.researchCampaign(id, revision)!;
      }
      const parent = this.get(campaign.parentTaskId);
      if (!researchInteger(expectedParentFlow, 0) || !parent || parent.history.length !== expectedParentFlow) throw researchFailure();
      this.taskWrite(() => this.db.query("UPDATE research_campaigns SET status='closed',closed_by=?,closed_at=?,closed_reason=?,private=MAX(private,?) WHERE id=? AND project=? AND (revision=? OR status='approved')")
        .run(by, at, reason, campaign.private || privateRecord ? 1 : 0, id, project, revision));
      this.update(parent.id, by, "study closed", {}, `${id} revision ${revision}`, {}, expectedParentFlow);
      return this.researchCampaign(id, revision)!;
    });
  }

  hasResearchState(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM research_campaigns) OR EXISTS(SELECT 1 FROM research_units) OR EXISTS(SELECT 1 FROM research_protocols) OR EXISTS(SELECT 1 FROM research_attempts) OR EXISTS(SELECT 1 FROM research_attempt_events) OR EXISTS(SELECT 1 FROM research_attempt_observations) AS present").get() as { present: number }).present === 1;
  }

  /** A consistent, streaming digest includes metadata and body hashes, not merely row counts. */
  researchIntegrity(): { campaigns: number; units: number; revision: number; digest: string } {
    return this.db.transaction(() => {
      const digest = createHash("sha256").update("agent-hub.research-integrity/v1\n");
      let campaigns = 0, units = 0, revision = 0;
      for (const row of this.db.query(`${RESEARCH_CAMPAIGN_SELECT} ORDER BY id,revision`).iterate() as Iterable<ResearchCampaignRow>) {
        const campaign = researchCampaignFromRow(row), bindings = this.researchBindings(campaign);
        const { contract: _body, ...metadata } = campaign;
        digest.update(JSON.stringify(metadata)).update("\n");
        for (const binding of bindings) digest.update(JSON.stringify(binding)).update("\n");
        campaigns++; units += bindings.length; revision = Math.max(revision, campaign.revision);
      }
      if ((this.db.query("SELECT COUNT(*) AS count FROM research_units").get() as { count: number }).count !== units) throw researchFailure();
      return { campaigns, units, revision, digest: digest.digest("hex") };
    })();
  }

  private experimentFence(fence: ExperimentWriteFence): { task: Task; campaign: ResearchCampaignRecord } {
    if (!researchText(fence.project) || !researchInteger(fence.taskId) || !researchInteger(fence.taskFlowRevision, 0) || !researchText(fence.owner) ||
      !researchId(fence.campaignId) || !researchInteger(fence.campaignRevision) || !experimentHashValid(fence.campaignHash)) throw experimentFailure();
    const task = this.get(fence.taskId), current = this.researchDispatchBinding(fence.taskId), campaign = current?.campaign;
    if (!task || task.owner !== fence.owner || task.state !== "in_progress" || task.history.length !== fence.taskFlowRevision || !campaign || !current?.binding ||
      campaign.project !== fence.project || campaign.id !== fence.campaignId || campaign.revision !== fence.campaignRevision || campaign.hash !== fence.campaignHash || campaign.status !== "approved") throw experimentFailure();
    return { task, campaign };
  }

  experimentProtocol(hash: string): ExperimentProtocolRecord | undefined {
    if (!experimentHashValid(hash)) throw experimentFailure();
    const row = this.db.query(`${EXPERIMENT_PROTOCOL_SELECT} WHERE hash=?`).get(hash) as ExperimentProtocolRow | null;
    if (!row) return undefined;
    try {
      if (typeof row.body !== "string" || !researchText(row.project) || !researchInteger(row.task_id) || !researchText(row.by_peer) || !researchInteger(row.at, 0) || ![0, 1].includes(row.private)) throw experimentFailure();
      const protocol = parseExperimentProtocol(JSON.parse(row.body));
      if (protocolHash(protocol) !== row.hash || protocol.campaignId !== row.campaign_id || protocol.campaignRevision !== row.campaign_revision) throw experimentFailure();
      const campaign = this.researchCampaign(protocol.campaignId, protocol.campaignRevision), task = this.get(row.task_id);
      if (!campaign || campaign.project !== row.project || !task || !this.researchCampaignBindings(campaign.id, campaign.revision).some(binding => binding.taskId === task.id) ||
        protocol.inputs.some(input => !campaign.contract.sourceIds.includes(input.sourceId))) throw experimentFailure();
      return { hash: row.hash, project: row.project, recordedForTaskId: row.task_id, protocol, by: row.by_peer, at: row.at, private: row.private === 1 || campaign.private || task.signals.some(signal => signal === "pii" || signal === "pii_path") };
    } catch { throw experimentFailure(); }
  }

  saveExperimentProtocol(record: ExperimentProtocolRecord, fence: ExperimentWriteFence): ExperimentProtocolRecord {
    const protocol = parseExperimentProtocol(record.protocol), hash = protocolHash(protocol);
    if (hash !== record.hash || record.project !== fence.project || record.recordedForTaskId !== fence.taskId || record.by !== fence.owner || !researchInteger(record.at, 0) || typeof record.private !== "boolean") throw experimentFailure();
    return this.atomic(() => {
      const { task, campaign } = this.experimentFence(fence);
      if (protocol.campaignId !== campaign.id || protocol.campaignRevision !== campaign.revision || protocol.inputs.some(input => !campaign.contract.sourceIds.includes(input.sourceId))) throw experimentFailure();
      if (protocol.variantOf !== undefined) {
        const baseline = this.experimentProtocol(protocol.variantOf);
        if (!baseline || baseline.project !== record.project || baseline.protocol.campaignId !== campaign.id || baseline.protocol.campaignRevision !== campaign.revision || baseline.protocol.role !== "baseline") throw experimentFailure();
      }
      if (protocol.supersedes !== undefined) {
        const previous = this.experimentProtocol(protocol.supersedes);
        if (!previous || previous.project !== record.project || previous.protocol.campaignId !== campaign.id || previous.protocol.lineage !== protocol.lineage) throw experimentFailure();
      }
      const priv = record.private || campaign.private || task.signals.some(signal => signal === "pii" || signal === "pii_path");
      const previous = this.experimentProtocol(hash);
      if (previous) {
        if (previous.project !== record.project || previous.recordedForTaskId !== record.recordedForTaskId || canonicalJson(previous.protocol) !== canonicalJson(protocol)) throw experimentFailure();
        if (priv) this.taskWrite(() => this.db.query("UPDATE research_protocols SET private=1 WHERE hash=? AND private=0").run(hash));
        return this.experimentProtocol(hash)!;
      }
      // Capture recording order in this transaction, never from caller or wall-clock timestamps. Legacy rows are not backfilled.
      const priorFinal = this.experimentPriorFinal(record.project, campaign.id, protocol.lineage);
      this.taskWrite(() => this.db.query("INSERT INTO research_protocols(hash,project,campaign_id,campaign_revision,task_id,body,by_peer,at,private) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(hash, record.project, campaign.id, campaign.revision, task.id, canonicalJson(protocol), record.by, record.at, priv ? 1 : 0));
      this.taskWrite(() => this.db.query("INSERT INTO research_protocol_context(protocol_hash,prior_attempt_id,prior_end_seq,context_sha256) VALUES(?,?,?,?)")
        .run(hash, priorFinal?.attemptId ?? null, priorFinal?.endSeq ?? null, experimentHash({ protocolHash: hash, priorFinal: priorFinal ?? null })));
      return this.experimentProtocol(hash)!;
    });
  }

  experimentComparisonPlan(hash: string): ExperimentComparisonPlanRecord | undefined {
    if (!experimentHashValid(hash)) throw experimentFailure();
    const row = this.db.query(`${EXPERIMENT_PLAN_SELECT} WHERE hash=?`).get(hash) as ExperimentComparisonPlanRow | null;
    return row ? this.experimentComparisonPlanFromRow(row) : undefined;
  }

  private experimentComparisonPlanFromRow(row: ExperimentComparisonPlanRow): ExperimentComparisonPlanRecord {
    try {
      if (typeof row.body !== "string" || !researchText(row.project) || !researchInteger(row.task_id) || !researchText(row.by_peer) || !researchInteger(row.at, 0) || ![0, 1].includes(row.private)) throw experimentFailure();
      const plan = parseComparisonPlan(JSON.parse(row.body)), campaign = this.researchCampaign(row.campaign_id, row.campaign_revision), task = this.get(row.task_id);
      if (comparisonPlanHash(plan) !== row.hash || plan.campaignId !== row.campaign_id || !campaign || campaign.project !== row.project || !task ||
        !this.researchCampaignBindings(campaign.id, campaign.revision).some(binding => binding.taskId === task.id) || plan.fixed.inputs.some(input => !campaign.contract.sourceIds.includes(input.sourceId))) throw experimentFailure();
      return { hash: row.hash, project: row.project, recordedForTaskId: row.task_id, plan, by: row.by_peer, at: row.at,
        private: row.private === 1 || campaign.private || task.signals.some(signal => signal === "pii" || signal === "pii_path") };
    } catch { throw experimentFailure(); }
  }

  saveExperimentComparisonPlan(record: ExperimentComparisonPlanRecord, fence: ExperimentWriteFence): ExperimentComparisonPlanRecord {
    const plan = parseComparisonPlan(record.plan), hash = comparisonPlanHash(plan);
    if (hash !== record.hash || record.project !== fence.project || record.recordedForTaskId !== fence.taskId || record.by !== fence.owner || !researchInteger(record.at, 0) || typeof record.private !== "boolean") throw experimentFailure();
    return this.atomic(() => {
      const { task, campaign } = this.experimentFence(fence);
      if (plan.campaignId !== campaign.id || plan.fixed.inputs.some(input => !campaign.contract.sourceIds.includes(input.sourceId))) throw experimentFailure();
      const priv = record.private || campaign.private || task.signals.some(signal => signal === "pii" || signal === "pii_path"), previous = this.experimentComparisonPlan(hash);
      if (previous) {
        if (previous.project !== record.project || previous.recordedForTaskId !== record.recordedForTaskId || canonicalJson(previous.plan) !== canonicalJson(plan)) throw experimentFailure();
        if (priv) this.taskWrite(() => this.db.query("UPDATE research_plans SET private=1 WHERE hash=? AND private=0").run(hash));
        return this.experimentComparisonPlan(hash)!;
      }
      this.taskWrite(() => this.db.query("INSERT INTO research_plans(hash,project,campaign_id,campaign_revision,task_id,body,by_peer,at,private) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(hash, record.project, campaign.id, campaign.revision, task.id, canonicalJson(plan), record.by, record.at, priv ? 1 : 0));
      return this.experimentComparisonPlan(hash)!;
    });
  }

  experimentComparisonPlans(project: string, campaignId: string, afterRow = 0, limit = 50): { rows: ExperimentComparisonPlanRecord[]; afterRow: number; done: boolean } {
    if (!researchText(project) || !researchId(campaignId)) throw experimentFailure(); experimentPage(afterRow, limit);
    const campaign = this.researchCampaign(campaignId); if (!campaign || campaign.project !== project) throw experimentFailure();
    const page = this.db.query(`${EXPERIMENT_PLAN_SELECT} WHERE project=? AND campaign_id=? AND rowid>? ORDER BY rowid LIMIT ?`).all(project, campaignId, afterRow, limit + 1) as ExperimentComparisonPlanRow[];
    return { rows: page.slice(0, limit).map(row => this.experimentComparisonPlanFromRow(row)), afterRow: page.slice(0, limit).at(-1)?.row_id ?? afterRow, done: page.length <= limit };
  }

  experimentProtocolApproval(hash: string): ExperimentProtocolApproval | undefined {
    const protocol = this.experimentProtocol(hash); if (!protocol) throw experimentFailure();
    const row = this.db.query("SELECT protocol_hash,evaluator_hash,approved_by,at FROM research_protocol_approvals WHERE protocol_hash=?").get(hash) as ExperimentProtocolApprovalRow | null;
    if (!row) return undefined;
    if (row.protocol_hash !== hash || row.evaluator_hash !== evaluatorIdentityHash(protocol.protocol) || row.approved_by !== USER || !researchInteger(row.at, 0)) throw experimentFailure();
    return { protocolHash: hash, evaluatorHash: row.evaluator_hash, approvedBy: row.approved_by, at: row.at };
  }

  /** Explicit approval names one immutable historical or current protocol; nothing copies to a changed protocol. */
  approveExperimentProtocol(project: string, hash: string, evaluatorHash: string, by: PeerId, at: number): ExperimentProtocolApproval {
    if (by !== USER || !researchText(project) || !experimentHashValid(hash) || !experimentHashValid(evaluatorHash) || !researchInteger(at, 0)) throw experimentFailure();
    return this.atomic(() => {
      const protocol = this.experimentProtocol(hash);
      if (!protocol || protocol.project !== project || evaluatorIdentityHash(protocol.protocol) !== evaluatorHash) throw experimentFailure();
      const previous = this.experimentProtocolApproval(hash); if (previous) return previous;
      this.taskWrite(() => this.db.query("INSERT INTO research_protocol_approvals(protocol_hash,evaluator_hash,approved_by,at) VALUES(?,?,?,?)").run(hash, evaluatorHash, by, at));
      return this.experimentProtocolApproval(hash)!;
    });
  }

  // ponytail: first insertion streams ended attempts until a matching lineage is found; index lineage/phase if campaign histories become large.
  private experimentPriorFinal(project: string, campaignId: string, lineage: string): { attemptId: string; endSeq: number } | undefined {
    const ends = this.db.query("SELECT e.attempt_id,e.seq FROM research_attempt_events AS e JOIN research_attempts AS a ON a.attempt_id=e.attempt_id WHERE a.project=? AND a.campaign_id=? AND e.kind='end' ORDER BY e.rowid DESC").iterate(project, campaignId) as Iterable<{ attempt_id: string; seq: number }>;
    for (const end of ends) {
      const attempt = this.experimentAttempt(end.attempt_id), protocol = attempt && this.experimentProtocol(attempt.attempt.protocolHash);
      if (!attempt || !protocol || attempt.project !== project || protocol.protocol.campaignId !== campaignId) throw experimentFailure();
      const event = this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND seq=?`).get(end.attempt_id, end.seq) as ExperimentEventRow | null;
      if (!event || this.experimentEventFromRow(event).event.kind !== "end") throw experimentFailure();
      if (attempt.attempt.phase === "final" && protocol.protocol.lineage === lineage) return { attemptId: attempt.attemptId, endSeq: end.seq };
    }
    return undefined;
  }

  experimentProtocolContext(hash: string): ExperimentProtocolContext {
    const protocol = this.experimentProtocol(hash); if (!protocol) throw experimentFailure();
    const row = this.db.query("SELECT protocol_hash,prior_attempt_id,prior_end_seq,context_sha256 FROM research_protocol_context WHERE protocol_hash=?").get(hash) as ExperimentProtocolContextRow | null;
    if (!row) return { state: "unknown" };
    if (row.protocol_hash !== hash || (row.prior_attempt_id === null) !== (row.prior_end_seq === null)) throw experimentFailure();
    if (row.prior_attempt_id === null) {
      if (row.context_sha256 !== experimentHash({ protocolHash: hash, priorFinal: null })) throw experimentFailure();
      return { state: "predeclared" };
    }
    if (!experimentIdValid(row.prior_attempt_id) || !researchInteger(row.prior_end_seq)) throw experimentFailure();
    const attempt = this.experimentAttempt(row.prior_attempt_id), previous = attempt && this.experimentProtocol(attempt.attempt.protocolHash);
    const event = this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND seq=?`).get(row.prior_attempt_id, row.prior_end_seq) as ExperimentEventRow | null;
    const priorFinal = { attemptId: row.prior_attempt_id, endSeq: row.prior_end_seq };
    if (!attempt || !previous || !event || attempt.project !== protocol.project || attempt.attempt.phase !== "final" || previous.protocol.campaignId !== protocol.protocol.campaignId ||
      previous.protocol.lineage !== protocol.protocol.lineage || this.experimentEventFromRow(event).event.kind !== "end" || row.context_sha256 !== experimentHash({ protocolHash: hash, priorFinal })) throw experimentFailure();
    return { state: "post-hoc", priorFinal };
  }

  hasResearchComparisonState(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM research_plans) OR EXISTS(SELECT 1 FROM research_protocol_approvals) OR EXISTS(SELECT 1 FROM research_protocol_context) AS present").get() as { present: number }).present === 1;
  }

  researchComparisonIntegrity(): { plans: number; approvals: number; contexts: number; digest: string } {
    return this.db.transaction(() => {
      const digest = createHash("sha256").update("agent-hub.research-comparison-integrity/v1\n");
      let plans = 0, approvals = 0, contexts = 0;
      for (const row of this.db.query(`${EXPERIMENT_PLAN_SELECT} ORDER BY hash`).iterate() as Iterable<ExperimentComparisonPlanRow>) {
        digest.update(canonicalJson({ record: this.experimentComparisonPlanFromRow(row), campaignRevision: row.campaign_revision })).update("\n"); plans++;
      }
      for (const row of this.db.query("SELECT protocol_hash,evaluator_hash,approved_by,at FROM research_protocol_approvals ORDER BY protocol_hash").iterate() as Iterable<ExperimentProtocolApprovalRow>) {
        digest.update(canonicalJson(this.experimentProtocolApproval(row.protocol_hash))).update("\n"); approvals++;
      }
      for (const row of this.db.query("SELECT protocol_hash FROM research_protocol_context ORDER BY protocol_hash").iterate() as Iterable<{ protocol_hash: string }>) {
        digest.update(canonicalJson({ protocolHash: row.protocol_hash, context: this.experimentProtocolContext(row.protocol_hash) })).update("\n"); contexts++;
      }
      return { plans, approvals, contexts, digest: digest.digest("hex") };
    })();
  }

  experimentAttempt(id: string): ExperimentAttemptRecord | undefined {
    if (!experimentIdValid(id)) throw experimentFailure();
    const row = this.db.query(`${EXPERIMENT_ATTEMPT_SELECT} WHERE attempt_id=?`).get(id) as ExperimentAttemptRow | null;
    return row ? this.experimentAttemptFromRow(row) : undefined;
  }

  private experimentAttemptFromRow(row: ExperimentAttemptRow): ExperimentAttemptRecord {
    try {
      if (!experimentIdValid(row.attempt_id) || typeof row.body !== "string" || !researchText(row.project) || !researchText(row.by_peer) || !researchInteger(row.at, 0) || ![0, 1].includes(row.private)) throw experimentFailure();
      const attempt = parseExperimentAttempt(JSON.parse(row.body)), protocol = this.experimentProtocol(row.protocol_hash);
      if (experimentHash(attempt) !== row.body_sha256 || attempt.protocolHash !== row.protocol_hash || attempt.taskId !== row.task_id || attempt.idempotencyKey !== row.idempotency_key ||
        !protocol || protocol.project !== row.project || protocol.protocol.campaignId !== row.campaign_id || protocol.protocol.campaignRevision !== row.campaign_revision ||
        !this.researchCampaignBindings(row.campaign_id, row.campaign_revision).some(binding => binding.taskId === attempt.taskId)) throw experimentFailure();
      const privateEvent = !!this.db.query("SELECT 1 FROM research_attempt_events WHERE attempt_id=? AND private=1 LIMIT 1").get(row.attempt_id);
      return { attemptId: row.attempt_id, project: row.project, attempt, bodyHash: row.body_sha256, by: row.by_peer, at: row.at, private: row.private === 1 || protocol.private || privateEvent };
    } catch { throw experimentFailure(); }
  }

  createExperimentAttempt(record: ExperimentAttemptRecord, fence: ExperimentWriteFence): ExperimentAttemptRecord {
    const attempt = parseExperimentAttempt(record.attempt), bodyHash = experimentHash(attempt);
    if (!experimentIdValid(record.attemptId) || record.bodyHash !== bodyHash || record.project !== fence.project || attempt.taskId !== fence.taskId || record.by !== fence.owner || !researchInteger(record.at, 0) || typeof record.private !== "boolean") throw experimentFailure();
    return this.atomic(() => {
      const { campaign } = this.experimentFence(fence), protocol = this.experimentProtocol(attempt.protocolHash);
      const origin = protocol && this.researchDispatchBinding(protocol.recordedForTaskId);
      if (!protocol || protocol.project !== record.project || protocol.protocol.campaignId !== campaign.id || protocol.protocol.campaignRevision !== campaign.revision ||
        !origin?.binding || origin.campaign.id !== campaign.id || origin.campaign.revision !== campaign.revision || origin.campaign.status !== "approved") throw experimentFailure();
      const previous = this.db.query(`${EXPERIMENT_ATTEMPT_SELECT} WHERE project=? AND idempotency_key=?`).get(record.project, attempt.idempotencyKey) as ExperimentAttemptRow | null;
      if (previous) {
        const stored = this.experimentAttemptFromRow(previous);
        if (stored.bodyHash !== bodyHash || canonicalJson(stored.attempt) !== canonicalJson(attempt)) throw new Error("attempt idempotency key already records different data");
        if (record.private || protocol.private) this.taskWrite(() => this.db.query("UPDATE research_attempts SET private=1 WHERE attempt_id=? AND private=0").run(stored.attemptId));
        return this.experimentAttempt(stored.attemptId)!;
      }
      for (const linked of [attempt.retryOf, attempt.reproducesAttemptId]) if (linked !== undefined) {
        const prior = this.experimentAttempt(linked), priorProtocol = prior && this.experimentProtocol(prior.attempt.protocolHash);
        if (!prior || !priorProtocol || prior.project !== record.project || priorProtocol.protocol.campaignId !== campaign.id) throw experimentFailure();
      }
      this.taskWrite(() => this.db.query("INSERT INTO research_attempts(attempt_id,project,campaign_id,campaign_revision,protocol_hash,task_id,idempotency_key,body,body_sha256,by_peer,at,private) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(record.attemptId, record.project, campaign.id, campaign.revision, attempt.protocolHash, attempt.taskId, attempt.idempotencyKey, canonicalJson(attempt), bodyHash, record.by, record.at, record.private || protocol.private ? 1 : 0));
      return this.experimentAttempt(record.attemptId)!;
    });
  }

  private experimentEventFromRow(row: ExperimentEventRow): ExperimentEventRecord {
    try {
      if (typeof row.body !== "string" || !researchInteger(row.seq) || !researchInteger(row.at, 0) || !researchText(row.by_peer) || ![0, 1].includes(row.private) || !researchText(row.idempotency_key, 64)) throw experimentFailure();
      const attempt = this.experimentAttempt(row.attempt_id), protocol = attempt && this.experimentProtocol(attempt.attempt.protocolHash);
      if (!attempt || !protocol || row.project !== attempt.project) throw experimentFailure();
      const input = parseExperimentEvent(JSON.parse(row.body), protocol.protocol);
      if (input.kind !== row.kind || experimentHash(input) !== row.body_sha256) throw experimentFailure();
      const event = { ...input, seq: row.seq, at: row.at, provenance: "declared" as const };
      const observations = (this.db.query("SELECT attempt_id,event_seq,CASE WHEN length(CAST(body AS BLOB))<=65536 THEN body END AS body,body_sha256 FROM research_attempt_observations WHERE attempt_id=? AND event_seq=?").all(row.attempt_id, row.seq) as ExperimentObservationRow[]).map(observed => {
        if (typeof observed.body !== "string" || observed.attempt_id !== row.attempt_id || observed.event_seq !== row.seq) throw experimentFailure();
        const observation = parseExperimentHostEvidence(JSON.parse(observed.body));
        if (experimentHash(observation) !== observed.body_sha256) throw experimentFailure();
        return { eventSeq: row.seq, observation };
      });
      projectExperimentWithObservations(protocol.protocol, [event], observations);
      return { attemptId: row.attempt_id, idempotencyKey: row.idempotency_key, event, bodyHash: row.body_sha256, by: row.by_peer, private: row.private === 1 || attempt.private, observations };
    } catch { throw experimentFailure(); }
  }

  appendExperimentEvent(attemptId: string, key: string, input: DeclaredExperimentEventInput, hostEvidence: readonly ExperimentHostEvidence[], by: PeerId, at: number, priv: boolean, expectedLastSeq: number, fence: ExperimentWriteFence): ExperimentEventRecord {
    if (!experimentIdValid(attemptId) || !researchText(key, 64) || by !== fence.owner || !researchInteger(at, 0) || typeof priv !== "boolean" || !researchInteger(expectedLastSeq, 0) || !Array.isArray(hostEvidence) || hostEvidence.length > 1) throw experimentFailure();
    return this.atomic(() => {
      const { campaign } = this.experimentFence(fence), attempt = this.experimentAttempt(attemptId), protocol = attempt && this.experimentProtocol(attempt.attempt.protocolHash);
      if (!attempt || !protocol || attempt.project !== fence.project || attempt.attempt.taskId !== fence.taskId || protocol.protocol.campaignId !== campaign.id || protocol.protocol.campaignRevision !== campaign.revision) throw experimentFailure();
      const value = parseExperimentEvent(input, protocol.protocol), bodyHash = experimentHash(value);
      const previous = this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE project=? AND idempotency_key=?`).get(fence.project, key) as ExperimentEventRow | null;
      if (previous) {
        const stored = this.experimentEventFromRow(previous);
        if (stored.attemptId !== attemptId || stored.bodyHash !== bodyHash || canonicalJson({ kind: stored.event.kind, body: stored.event.body }) !== canonicalJson(value)) throw new Error("event idempotency key already records different data");
        if (priv || attempt.private) {
          this.taskWrite(() => this.db.query("UPDATE research_attempt_events SET private=1 WHERE attempt_id=? AND seq=? AND private=0").run(attemptId, stored.event.seq));
          this.taskWrite(() => this.db.query("UPDATE research_attempts SET private=1 WHERE attempt_id=? AND private=0").run(attemptId));
        }
        return this.experimentEventFromRow(this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND seq=?`).get(attemptId, stored.event.seq) as ExperimentEventRow);
      }
      if (this.experimentLastSeq(attemptId) !== expectedLastSeq || !researchInteger(expectedLastSeq + 1)) throw new Error("experiment event sequence changed");
      if (value.kind === "end" && this.db.query("SELECT 1 FROM research_attempt_events WHERE attempt_id=? AND kind='end'").get(attemptId)) throw new Error("an experiment attempt has at most one end event");
      const seq = expectedLastSeq + 1, observations = hostEvidence.map(observation => ({ eventSeq: seq, observation: parseExperimentHostEvidence(observation) }));
      projectExperimentWithObservations(protocol.protocol, [{ ...value, seq, at, provenance: "declared" }], observations);
      this.taskWrite(() => this.db.query("INSERT INTO research_attempt_events(attempt_id,project,seq,idempotency_key,kind,body,body_sha256,by_peer,at,private) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(attemptId, fence.project, seq, key, value.kind, canonicalJson(value), bodyHash, by, at, priv || attempt.private ? 1 : 0));
      for (const observed of observations) this.taskWrite(() => this.db.query("INSERT INTO research_attempt_observations(attempt_id,event_seq,body,body_sha256) VALUES(?,?,?,?)")
        .run(attemptId, seq, canonicalJson(observed.observation), experimentHash(observed.observation)));
      if (priv || attempt.private) this.taskWrite(() => this.db.query("UPDATE research_attempts SET private=1 WHERE attempt_id=? AND private=0").run(attemptId));
      return this.experimentEventFromRow(this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND seq=?`).get(attemptId, seq) as ExperimentEventRow);
    });
  }

  experimentLastSeq(attemptId: string): number {
    if (!this.experimentAttempt(attemptId)) throw experimentFailure();
    const last = this.db.query("SELECT MAX(seq) AS seq,COUNT(*) AS count FROM research_attempt_events WHERE attempt_id=?").get(attemptId) as { seq: number | null; count: number };
    const seq = last.seq ?? 0;
    if (!researchInteger(seq, 0) || last.count !== seq) throw experimentFailure();
    return seq;
  }

  experimentEvents(attemptId: string, afterSeq = 0, limit = 50): { rows: ExperimentEventRecord[]; afterSeq: number; done: boolean } {
    if (!this.experimentAttempt(attemptId)) throw experimentFailure(); experimentPage(afterSeq, limit);
    const page = this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND seq>? ORDER BY seq LIMIT ?`).all(attemptId, afterSeq, limit + 1) as ExperimentEventRow[];
    const rows = page.slice(0, limit).map(row => this.experimentEventFromRow(row));
    return { rows, afterSeq: rows.at(-1)?.event.seq ?? afterSeq, done: page.length <= limit };
  }

  experimentAttempts(project: string, campaignId: string, afterRow = 0, limit = 50): { rows: ExperimentAttemptRecord[]; afterRow: number; done: boolean } {
    if (!researchText(project) || !researchId(campaignId)) throw experimentFailure(); experimentPage(afterRow, limit);
    const campaign = this.researchCampaign(campaignId); if (!campaign || campaign.project !== project) throw experimentFailure();
    const page = this.db.query(`${EXPERIMENT_ATTEMPT_SELECT} WHERE project=? AND rowid>? AND campaign_id=? ORDER BY rowid LIMIT ?`)
      .all(project, afterRow, campaignId, limit + 1) as ExperimentAttemptRow[];
    return { rows: page.slice(0, limit).map(row => this.experimentAttemptFromRow(row)), afterRow: page.slice(0, limit).at(-1)?.row_id ?? afterRow, done: page.length <= limit };
  }

  experimentAttemptStatus(attemptId: string): ExperimentStatus {
    const attempt = this.experimentAttempt(attemptId);
    if (!attempt) throw experimentFailure();
    const endRows = this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND kind='end' ORDER BY seq LIMIT 2`).all(attemptId) as ExperimentEventRow[];
    if (endRows.length > 1) throw experimentFailure();
    const end = endRows[0], start = !end && this.db.query(`${EXPERIMENT_EVENT_SELECT} WHERE attempt_id=? AND kind='start' ORDER BY seq LIMIT 1`).get(attemptId) as ExperimentEventRow | null;
    const events = end ? [this.experimentEventFromRow(end).event] : start ? [this.experimentEventFromRow(start).event] : [];
    return experimentStatus(events, this.get(attempt.attempt.taskId)?.state);
  }

  // ponytail: exact counts validate all campaign attempts on each show (linear in attempt count). Upgrade to a transactional status projection maintained on event and task-state changes.
  experimentSummary(project: string, campaignId: string): { total: number; statuses: Record<ExperimentStatus, number> } {
    const campaign = this.researchCampaign(campaignId); if (!campaign || campaign.project !== project) throw experimentFailure();
    const statuses: Record<ExperimentStatus, number> = { declared: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 };
    let total = 0;
    for (const row of this.db.query(`${EXPERIMENT_ATTEMPT_SELECT} WHERE project=? AND campaign_id=? ORDER BY rowid`).iterate(project, campaignId) as Iterable<ExperimentAttemptRow>) {
      const attempt = this.experimentAttemptFromRow(row);
      // Status needs only the unique terminal event or presence of a start, not an unbounded event read.
      statuses[this.experimentAttemptStatus(attempt.attemptId)]++; total++;
    }
    return { total, statuses };
  }

  hasResearchExperimentState(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM research_protocols) OR EXISTS(SELECT 1 FROM research_attempts) OR EXISTS(SELECT 1 FROM research_attempt_events) OR EXISTS(SELECT 1 FROM research_attempt_observations) AS present").get() as { present: number }).present === 1;
  }

  researchExperimentsIntegrity(): { protocols: number; attempts: number; events: number; observations: number; digest: string } {
    return this.db.transaction(() => {
      const digest = createHash("sha256").update("agent-hub.research-experiments-integrity/v1\n");
      let protocols = 0, attempts = 0, events = 0, observations = 0;
      for (const row of this.db.query(`${EXPERIMENT_PROTOCOL_SELECT} ORDER BY hash`).iterate() as Iterable<ExperimentProtocolRow>) {
        digest.update(canonicalJson(this.experimentProtocol(row.hash))).update("\n"); protocols++;
      }
      for (const row of this.db.query(`${EXPERIMENT_ATTEMPT_SELECT} ORDER BY attempt_id`).iterate() as Iterable<ExperimentAttemptRow>) {
        digest.update(canonicalJson(this.experimentAttemptFromRow(row))).update("\n"); attempts++;
      }
      let currentAttempt = "", nextSeq = 0, ended = false;
      for (const row of this.db.query(`${EXPERIMENT_EVENT_SELECT} ORDER BY attempt_id,seq`).iterate() as Iterable<ExperimentEventRow>) {
        if (row.attempt_id !== currentAttempt) { currentAttempt = row.attempt_id; nextSeq = 1; ended = false; }
        if (row.seq !== nextSeq++ || row.kind === "end" && ended) throw experimentFailure();
        if (row.kind === "end") ended = true;
        const record = this.experimentEventFromRow(row);
        digest.update(canonicalJson(record)).update("\n"); events++; observations += record.observations.length;
      }
      if ((this.db.query("SELECT COUNT(*) AS count FROM research_attempt_observations").get() as { count: number }).count !== observations) throw experimentFailure();
      return { protocols, attempts, events, observations, digest: digest.digest("hex") };
    })();
  }

  propose(by: PeerId, t: { title: string; detail?: string; class: TaskClass; planner?: PeerId | null; plannerReason?: PlannerReason; profile?: import("./profiles.ts").ProfileName; profileClass?: string; customProfile?: true; role?: string; refs?: TaskRefs; plan?: TaskPlan; deps?: number[]; reserved?: PeerId; signals?: string[]; backlog?: boolean; draft?: boolean; external?: GitHubSource }): Task {
    const now = Date.now(), planner = plannerValue(t.planner);
    const chosen = Object.hasOwn(t, "planner") || t.plannerReason !== undefined ? plannerMetadata(planner, t.plannerReason) : {};
    const history: HistoryEntry[] = [{ at: now, by, ...chosen, event: t.backlog ? "backlogged" : "proposed", ...(this.trackPlanRevisions?.() && t.plan && Object.keys(t.plan).length ? { planRevision: { revision: 1, fingerprint: planFingerprint(t.plan) } } : {}) }];
    const { lastInsertRowid } = this.taskWrite(() => {
      const inserted = this.db
      .query("INSERT INTO tasks (title, detail, class, state, refs, plan, deps, reserved, signals, history, created, updated, project_profile, task_role, external_repo, external_issue, planner, draft) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.title, t.detail ?? "", t.class, t.backlog ? "backlog" : "proposed", JSON.stringify(t.refs ?? {}), JSON.stringify(t.plan ?? {}), JSON.stringify(t.deps ?? []), t.reserved ?? null, JSON.stringify(t.signals ?? []), JSON.stringify(history), now, now, t.profile && (t.profile !== "dev" || t.customProfile || t.profileClass !== undefined && t.profileClass !== t.class) ? JSON.stringify({ profile: t.profile, profileClass: t.profileClass ?? t.class }) : null, t.role ?? null, t.external?.repo.toLowerCase() ?? null, t.external?.issue ?? null, planner, t.draft && t.backlog ? 1 : 0);
      if (this.proposalPlanner && !Object.hasOwn(t, "planner") && t.plannerReason === undefined) {
        const selected = this.proposalPlanner(this.get(Number(inserted.lastInsertRowid))!);
        const binding = plannerMetadata(selected.planner, selected.plannerReason);
        Object.assign(history[0]!, binding);
        this.db.query("UPDATE tasks SET planner=?,history=? WHERE id=?").run(binding.planner ?? null, JSON.stringify(history), inserted.lastInsertRowid);
      }
      return inserted;
    });
    const task = this.get(Number(lastInsertRowid))!;
    this.changed(task, history[0]!);
    return task;
  }

  imported(repo: string, issue: number): Task | undefined {
    const row = this.db.query(`${TASK_SELECT} WHERE external_repo=? AND external_issue=?`).get(repo.toLowerCase(), issue) as Record<string, unknown> | null;
    return row ? parse(row) : undefined;
  }

  get(id: number): Task | undefined {
    const row = this.db.query(`${TASK_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? parse(row) : undefined;
  }

  list(state?: TaskState): Task[] {
    const rows = state ? this.db.query(`${TASK_SELECT} WHERE state = ? ORDER BY id`).all(state) : this.db.query(`${TASK_SELECT} ORDER BY id`).all();
    return (rows as Record<string, unknown>[]).map(parse);
  }

  /** Structural status facts only; avoid decoding text, plans and growing history on each status write. */
  statusTasks(): Pick<Task, "id" | "state" | "owner" | "reviewer">[] {
    return this.db.query("SELECT id, state, owner, reviewer FROM tasks WHERE state NOT IN ('approved','cancelled') ORDER BY id").all() as Pick<Task, "id" | "state" | "owner" | "reviewer">[];
  }
  statusReservations(): string[] {
    return (this.db.query("SELECT DISTINCT reserved FROM tasks WHERE state NOT IN ('approved', 'cancelled', 'backlog') AND reserved IS NOT NULL ORDER BY reserved").all() as { reserved: string }[]).map(row => row.reserved);
  }
  plannerWip(peer: string, except?: number): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE state NOT IN ('approved', 'cancelled', 'backlog') AND (? IS NULL OR id != ?) AND
      (owner = ? OR (owner IS NULL AND state = 'proposed' AND reserved = ? AND
        json_extract((SELECT value FROM json_each(tasks.history) WHERE json_extract(value, '$.event') IN ('backlog pulled', 'backlog returned') ORDER BY CAST(key AS INTEGER) DESC LIMIT 1), '$.planning.pull') = 1))`).get(except ?? null, except ?? null, peer, peer) as { n: number };
    return row.n;
  }

  /**
   * #784 AC3: what `plannerWip` counts, split per peer in ONE grouped query (no per-peer or per-task reads on the status hot path). `active` is owned work that is not
   * waiting for review, `reviewWait` is owned work in `in_review`, `reserved` is unowned proposed work a planner pull reserved. For every peer the three add up to
   * `plannerWip(peer)`: this is a read-only view, admission keeps using `plannerWip` unchanged.
   */
  plannerWipBreakdown(): Record<string, { active: number; reviewWait: number; reserved: number }> {
    const rows = this.db.query(`SELECT peer, kind, COUNT(*) AS n FROM (
      SELECT owner AS peer, CASE WHEN state = 'in_review' THEN 'reviewWait' ELSE 'active' END AS kind FROM tasks WHERE state NOT IN ('approved', 'cancelled', 'backlog') AND owner IS NOT NULL
      UNION ALL
      SELECT reserved AS peer, 'reserved' AS kind FROM tasks WHERE state = 'proposed' AND owner IS NULL AND reserved IS NOT NULL AND
        json_extract((SELECT value FROM json_each(tasks.history) WHERE json_extract(value, '$.event') IN ('backlog pulled', 'backlog returned') ORDER BY CAST(key AS INTEGER) DESC LIMIT 1), '$.planning.pull') = 1
    ) GROUP BY peer, kind`).all() as { peer: string; kind: "active" | "reviewWait" | "reserved"; n: number }[];
    const result: Record<string, { active: number; reviewWait: number; reserved: number }> = {};
    for (const row of rows) (result[row.peer] ??= { active: 0, reviewWait: 0, reserved: 0 })[row.kind] = row.n;
    return result;
  }

  recordTaskOffer(id: number, offer: TaskOffer, expectedFlowRevision: number): void {
    const task = this.get(id);
    if (!task || task.owner !== offer.owner || isClosedTaskState(task.state) || task.history.length !== expectedFlowRevision || offer.assignmentFlowRevision !== expectedFlowRevision) throw new Error("task offer changed");
    const changed = this.taskWrite(() => this.db.query("UPDATE tasks SET offer=? WHERE id=? AND owner=? AND history=?").run(JSON.stringify(offer), id, offer.owner, JSON.stringify(task.history)));
    if (!changed.changes) throw new Error("task offer changed");
  }
  recordStall(stall: TaskStall): boolean {
    const old = this.stalls().find(row => row.task === stall.task);
    if (old?.signature === stall.signature && old.replanRevision === stall.replanRevision) return false;
    this.taskWrite(() => this.db.query("INSERT INTO task_stalls(task,payload) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET payload=excluded.payload").run(stall.task, JSON.stringify(stall)));
    return true;
  }
  /** #481 S7: the scan history of one repository and source set, oldest first. Counts and times only. */
  /** `knownOnly` filters unknown totals in SQL, before the limit, so rows with no total never use up the rows a series needs. */
  securityScans(repo: string, sources: string, limit = 200, knownOnly = false): { id: number; at: number; total: number | null }[] {
    const rows = this.db.query(`SELECT id, at, total FROM security_scans WHERE repo=? AND sources=?${knownOnly ? " AND total IS NOT NULL" : ""} ORDER BY id DESC LIMIT ?`).all(repo.toLowerCase(), sources, Math.max(1, Math.min(1000, limit))) as { id: number; at: number; total: number | null }[];
    return rows.reverse();
  }
  recordSecurityScan(row: { repo: string; sources: string; counts: Record<string, number | null>; total: number | null }): number {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repo) || !/^[a-z_,]{1,80}$/.test(row.sources) || (row.total !== null && (!Number.isSafeInteger(row.total) || row.total < 0))) throw new Error("invalid security scan row");
    return Number(this.db.query("INSERT INTO security_scans(at, repo, sources, counts, total) VALUES(?,?,?,?,?)").run(Date.now(), row.repo.toLowerCase(), row.sources, JSON.stringify(row.counts), row.total).lastInsertRowid);
  }
  /** True when the marker was new (and is now recorded), false when it was announced before. Ids, metric names and task numbers only. */
  recordBandNotice(marker: string): boolean {
    if (!/^[a-z_]{1,64}:#[1-9][0-9]{0,9}:log$/.test(marker)) throw new Error("invalid band notice marker");
    return this.db.query("INSERT OR IGNORE INTO band_notices(marker, at) VALUES(?, ?)").run(marker, Date.now()).changes > 0;
  }
  /** True when the (id, version, planner) marker was new and is now recorded; false when it was announced before. */
  recordAgentDriftNotice(marker: string): boolean {
    if (!/^[a-z][a-z0-9-]{0,31}:[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}@[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(marker)) throw new Error("invalid agent drift marker");
    return this.db.query("INSERT OR IGNORE INTO agent_drift_notices(marker, at) VALUES(?, ?)").run(marker, Date.now()).changes > 0;
  }
  forgetAgentDriftNotice(marker: string): void { this.db.query("DELETE FROM agent_drift_notices WHERE marker=?").run(marker); }
  clearStall(task: number): void { this.taskWrite(() => this.db.query("DELETE FROM task_stalls WHERE task=?").run(task)); }
  /** One bounded primary-key metadata read for a retry's saved replacement cause. */
  stall(task: number): TaskStall | undefined {
    if (!Number.isSafeInteger(task) || task < 1) return undefined;
    const saved = this.db.query<{ payload: string | null }, [number]>("SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload END AS payload FROM task_stalls WHERE task=?").get(task);
    return saved?.payload == null ? undefined : parseStall(saved.payload, task);
  }
  stalls(): TaskStall[] {
    return (this.db.query("SELECT task,payload FROM task_stalls ORDER BY task").all() as { task: number; payload: string }[]).flatMap(row => {
      const value = parseStall(row.payload, row.task); return value ? [value] : [];
    });
  }
  /** Bounded ids/hold metadata only; a corrupt skipped payload still advances the cursor. */
  queuePressureStallPage(afterTask = 0, limit = 64): QueuePressureStallPage {
    if (!Number.isSafeInteger(afterTask) || afterTask < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("invalid queue pressure stall page");
    const saved = this.db.query<{ task: number; payload: string }, [number, number]>(`SELECT task,payload FROM task_stalls WHERE task>? AND ${QUEUE_PRESSURE_STALL} ORDER BY task LIMIT ?`).all(afterTask, limit);
    return { rows: saved.flatMap(row => { const value = parseStall(row.payload, row.task); return value ? [value] : []; }), afterTask: saved.at(-1)?.task ?? afterTask, done: saved.length < limit };
  }
  /** Current human-review candidates, by indexed state/role/id metadata without opening task history. */
  humanReviewPage(afterId = 0, limit = 64): number[] {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("invalid human review page");
    return this.db.query<{ id: number }, [number, number]>("SELECT id FROM tasks WHERE id>? AND state='in_review' AND reviewer='user' ORDER BY id LIMIT ?").all(afterId, limit).map(row => row.id);
  }

  /** Tasks per state, without parsing a single row: `status.json` is rewritten on every bus event and the board only grows. */
  counts(): Record<string, number> {
    const rows = this.db.query("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** The only way a task changes. Validates the move, records who did what, returns the new row. */
  /** A `plan` in the patch replaces the old one whole: a new plan is the owner's current intent, not an addition. */
  update(id: number, by: PeerId, event: string, patch: Partial<Pick<Task, "state" | "owner" | "planner" | "reviewer" | "reserved" | "refs" | "plan" | "rejections" | "signals" | "sdlc" | "role" | "cancelled" | "codeSymbols">>, note?: string, extra: Pick<HistoryEntry, "invocation" | "plannerReason" | "planAuthor" | "selfReview" | "profile" | "sweep" | "reason" | "from" | "capacity" | "conductorManual" | "withheld" | "noWrites" | "reviewCost" | "reviewContext" | "reviewScope" | "evidenceOnly" | "reviewFindings" | "unmetCriteria" | "deliverables" | "checkKey" | "missingKeys" | "claim" | "planObservation" | "planDeparture" | "planDepartureInvalidated" | keyof ReviewerHistory> = {}, expectedFlowRevision?: number, codeSymbolsAuthority?: typeof HOST_CODE_SYMBOLS): Task {
    const task = this.get(id);
    if (!task) throw new Error(`no task #${id}`);
    if (expectedFlowRevision !== undefined && (!Number.isSafeInteger(expectedFlowRevision) || expectedFlowRevision < 0 || task.history.length !== expectedFlowRevision)) throw new Error("task flow revision changed");
    const untouchedReturn = event === "backlog returned untouched" && patch.state === "backlog" && patch.owner === null && patch.reviewer === null
      && ["proposed", "in_progress"].includes(task.state) && expectedFlowRevision !== undefined && !!note?.trim() && !taskHasWorkEvidence(task);
    // A new delivered head with a configured check is owner work again until that check finishes.
    const reviewCheck = event === "done (checking)" && task.state === "in_review" && patch.state === "in_progress"
      && expectedFlowRevision !== undefined && (by === task.owner || by === "user") && patch.owner === undefined && patch.reviewer === undefined
      && typeof patch.refs?.commit === "string" && /^[a-f0-9]{40}$/.test(patch.refs.commit)
      && patch.refs.commit !== (task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead);
    if (task.draft && patch.state && patch.state !== "backlog" && patch.state !== "cancelled") throw new Error(`task #${id} is an intake draft; the person approves it first`);
    if (patch.state && patch.state !== task.state && !MOVES[task.state].includes(patch.state) && !untouchedReturn && !reviewCheck) {
      throw new Error(`task #${id} is ${task.state}: cannot move to ${patch.state}`);
    }
    const planner = Object.hasOwn(patch, "planner") ? plannerValue(patch.planner) : task.planner ?? null;
    const plannerHistory = Object.hasOwn(patch, "planner") || extra.plannerReason !== undefined ? plannerMetadata(planner, extra.plannerReason) : {};
    const authorHistory = Object.hasOwn(extra, "planAuthor") ? { planAuthor: plannerValue(extra.planAuthor) } : {};
    if (extra.selfReview !== undefined && extra.selfReview !== true) throw new Error("invalid self-review metadata");
    if (extra.conductorManual !== undefined && (extra.conductorManual !== true || by === "user" || by === "hub" || extra.reason !== "manual"
      || !["assigned", "reassigned", "reserved", "unassigned", "reviewer changed"].includes(event))) throw new Error("invalid conductor manual metadata");
    if (extra.invocation && (by !== HUB || event !== "invocation")) throw new Error("invocation audit is host-only");
    const next = { ...task, ...patch, planner, refs: { ...task.refs, ...patch.refs } };
    const headOf = (row: Task) => row.refs.commit ?? row.sdlc?.head ?? row.sdlc?.localHead;
    const privateSymbols = next.signals.includes("pii") || next.signals.includes("pii_path");
    if (Object.hasOwn(patch, "codeSymbols")) {
      if (codeSymbolsAuthority !== HOST_CODE_SYMBOLS) throw new Error("code symbols require host authority");
      const observation = patch.codeSymbols === undefined ? undefined : parseTaskCodeSymbols(patch.codeSymbols);
      if (patch.codeSymbols !== undefined && !observation) throw new Error("invalid task code symbols");
      if (observation && (privateSymbols || observation.head !== headOf(next))) throw new Error("code symbol head or privacy differs from task");
      next.codeSymbols = observation;
    } else if (privateSymbols || headOf(task) !== headOf(next) || task.refs.repo !== next.refs.repo || JSON.stringify(task.refs.paths) !== JSON.stringify(next.refs.paths) || task.sdlc?.repo !== next.sdlc?.repo) {
      next.codeSymbols = undefined;
    }
    if (next.state === "backlog" && (next.owner || next.reviewer)) throw new Error(`task #${id}: backlog cannot have an owner or reviewer`);
    if (!untouchedReturn) {
      if (patch.state === "backlog" && task.owner) throw new Error(`task #${id}: owned work cannot return to backlog`);
    }
    if (patch.state === "backlog" && taskHasStarted(task) && !untouchedReturn) throw new Error(`task #${id}: started work cannot return to backlog`);
    const reviewMetadata = reviewerHistory(extra);
    let reviewFindings: ReviewFindingSet | undefined;
    if (extra.reviewFindings !== undefined) {
      if (!["approved", "changes_requested"].includes(event) || patch.state !== event) throw new Error("finding metadata requires a saved review verdict");
      const head = extra.reviewFindings.head;
      if (head !== undefined && !/^[a-f0-9]{40}$/.test(head)) throw new Error("finding metadata requires a full reviewed head");
      reviewFindings = { ...(head ? { head } : {}), items: parseReviewFindings(extra.reviewFindings.items, { person: by === "user", maxNits: 64 }) };
    }
    let deliverables: DeliverableRecord[] | undefined;
    if (extra.deliverables !== undefined) {
      if (!["done", "done (checking)", "lifecycle", "approved"].includes(event)) throw new Error("deliverable records require a done, a lifecycle record or an approval");
      deliverables = parseDeliverableRecords(extra.deliverables);
    }
    let unmetCriteria: string[] | undefined;
    if (extra.unmetCriteria !== undefined) {
      if (!["approved", "changes_requested"].includes(event) || patch.state !== event) throw new Error("unmet criteria require a saved review verdict");
      unmetCriteria = criterionIdList(extra.unmetCriteria);
    }
    if (extra.planDeparture && (by !== "user" || event !== "plan departure accepted")) throw new Error("plan departure acceptance is person-only");
    const trackPlan = this.trackPlanRevisions?.() === true, hasDeparture = task.history.some(h => h.planDeparture);
    const fingerprint = patch.plan && (trackPlan || hasDeparture) ? planFingerprint(next.plan ?? {}) : undefined;
    const planChanged = fingerprint !== undefined && fingerprint !== planFingerprint(task.plan ?? {});
    const planRevision = trackPlan && planChanged ? { revision: (task.history.findLast(h => h.planRevision)?.planRevision?.revision ?? 0) + 1, fingerprint: fingerprint! } : undefined;
    // Disabling reporting must not let plan or repository refs edits/reverts resurrect prior consent.
    const repositoryRefsChanged = patch.refs !== undefined && JSON.stringify([task.refs.repo, task.refs.paths]) !== JSON.stringify([next.refs.repo, next.refs.paths]);
    const departureInvalidated = extra.planDepartureInvalidated === true || hasDeparture && (planChanged || repositoryRefsChanged);
    const history = [...task.history, { at: Date.now(), by, event, ...(extra.invocation ? { invocation: extra.invocation } : {}), ...plannerHistory, ...authorHistory, ...(extra.selfReview === true ? { selfReview: true as const } : {}), ...(planRevision ? { planRevision } : {}), ...(extra.planObservation ? { planObservation: extra.planObservation } : {}), ...(extra.planDeparture ? { planDeparture: extra.planDeparture } : {}), ...(departureInvalidated ? { planDepartureInvalidated: true as const } : {}), ...reviewMetadata, ...(note ? { note } : {}), ...(patch.cancelled?.supersededBy ? { supersededBy: patch.cancelled.supersededBy } : {}), ...("owner" in patch ? { owner: next.owner } : {}), ...(extra.profile ? { profile: extra.profile } : {}), ...(extra.sweep ? { sweep: extra.sweep } : {}), ...(extra.reason && TASK_MOVE_REASONS.includes(extra.reason) ? { reason: extra.reason } : {}), ...(extra.from ? { from: extra.from } : {}), ...(extra.capacity === true ? { capacity: true as const } : {}), ...(extra.conductorManual === true ? { conductorManual: true as const } : {}), ...(extra.withheld && (note || reviewFindings) ? { withheld: true as const } : {}), ...(reviewFindings ? { reviewFindings } : {}), ...(unmetCriteria?.length ? { unmetCriteria } : {}), ...(deliverables ? { deliverables } : {}), ...(extra.reviewContext === "fresh" || extra.reviewContext === "continuing" ? { reviewContext: extra.reviewContext } : {}), ...(extra.reviewScope === "code" ? { reviewScope: "code" as const } : {}), ...(extra.evidenceOnly === true && event === "changes_requested" ? { evidenceOnly: true as const } : {}), ...(extra.reviewCost ? { reviewCost: extra.reviewCost } : {}), ...(event === "done" && extra.noWrites === true ? { noWrites: true as const } : {}), ...(["check passed", "check failed"].includes(event) && typeof extra.checkKey === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(extra.checkKey) ? { checkKey: extra.checkKey } : {}), ...(["check passed", "check failed"].includes(event) && Number.isSafeInteger(extra.missingKeys) && extra.missingKeys! >= 0 && extra.missingKeys! <= 100_000 ? { missingKeys: extra.missingKeys } : {}), ...(event === "claim verdict" && extra.claim ? { claim: extra.claim } : {}) }];
    this.taskWrite(() => {
      const result = this.db.query("UPDATE tasks SET state = ?, owner = ?, reviewer = ?, reserved = ?, refs = ?, plan = ?, rejections = ?, signals = ?, history = ?, sdlc = ?, task_role = ?, cancelled = ?, updated = ?, planner = ? WHERE id = ?")
        .run(next.state, next.owner, next.reviewer, next.reserved ?? null, JSON.stringify(next.refs), JSON.stringify(next.plan ?? {}), next.rejections, JSON.stringify(next.signals), JSON.stringify(history), next.sdlc ? JSON.stringify(next.sdlc) : null, next.role ?? null, next.cancelled ? JSON.stringify(next.cancelled) : null, Date.now(), planner, id);
      if (result.changes) {
        if (next.codeSymbols) this.db.query("INSERT INTO task_code_symbols(task,payload) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET payload=excluded.payload").run(id, JSON.stringify(next.codeSymbols));
        else this.db.query("DELETE FROM task_code_symbols WHERE task=?").run(id);
      }
      return result;
    });
    const updated = this.get(id)!;
    this.changed(updated, history.at(-1)!);
    return updated;
  }

  /** Internal persistence; caller authority and frozen scope are owned by Tasks. */
  plan(id: number, by: PeerId, input: PlanningFields, revision: number, note?: string, withheld = false, receipt?: SdlcReceipt): Task {
    const patch = planningPatch(input);
    const task = this.get(id);
    if (!task || (task.planningRevision ?? 0) !== revision) throw new Error("planning revision changed");
    if ((patch.sdlc !== undefined) !== (receipt !== undefined)) throw new Error("planning issue identity requires a normalized host receipt");
    const next = { ...task, ...patch, sdlc: receipt ?? task.sdlc };
    if (next.plannedStart != null && next.due != null && next.plannedStart > next.due) throw new Error("planned start must not follow due");
    if (next.release != null && !this.release(next.release)) throw new Error("no such release");
    const fields = Object.keys(patch) as (keyof PlanningFields)[], previous = Object.fromEntries(fields.map(key => [key, key === "sdlc" ? { repo: task.sdlc?.repo ?? null, issue: task.sdlc?.issue ?? null } : task[key] ?? (key === "pinned" ? false : key === "deps" ? [] : null)])) as PlanningFields;
    const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "planned", planning: { revision: revision + 1, fields, previous }, ...(note ? { note } : {}), ...(withheld && note ? { withheld: true as const } : {}) };
    const result = this.taskWrite(() => this.db.query(`UPDATE tasks SET rank=?, priority=?, "release"=?, planned_start=?, due=?, pinned=?, deps=?, reserved=?, planning_revision=planning_revision+1, history=?, updated=?, sdlc=? WHERE id=? AND planning_revision=?`)
      .run(next.rank ?? null, next.priority ?? null, next.release ?? null, next.plannedStart ?? null, next.due ?? null, next.pinned ? 1 : 0, JSON.stringify(next.deps ?? []), next.reserved ?? null, JSON.stringify([...task.history, entry]), now, next.sdlc === undefined ? null : JSON.stringify(next.sdlc), id, revision));
    if (result.changes !== 1) throw new Error("planning revision changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  /** A planner reserves a routing slot without claiming or dispatching the work. */
  pullPlanned(id: number, by: PeerId, reserved: PeerId, revision: number, note: string, withheld = false, binding?: PlannerBinding): Task {
    const task = this.get(id);
    if (!task || (task.planningRevision ?? 0) !== revision || task.state !== "backlog" || task.owner || !taskCanPlan(task)) throw new Error("planner pull changed or already started");
    if (task.draft) throw new Error(`task #${id} is an intake draft; the person approves it first`);
    const selected = binding ? plannerMetadata(binding.planner, binding.plannerReason) : {};
    const now = Date.now(), entry: HistoryEntry = { at: now, by, ...selected, event: "backlog pulled", planning: { revision: revision + 1, fields: ["reserved"], previous: { reserved: task.reserved ?? null }, pull: true }, note, ...(withheld ? { withheld: true as const } : {}) };
    const result = this.taskWrite(() => this.db.query("UPDATE tasks SET state='proposed',owner=NULL,reviewer=NULL,offer=NULL,reserved=?,planning_revision=planning_revision+1,history=?,updated=?,planner=? WHERE id=? AND planning_revision=? AND state='backlog' AND owner IS NULL")
      .run(reserved, JSON.stringify([...task.history, entry]), now, binding ? selected.planner ?? null : task.planner ?? null, id, revision));
    if (result.changes !== 1) throw new Error("planner pull changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  /** Publish no intermediate ownerless pull: Tasks has already admitted the exact reserved peer. */
  pullAssigned(id: number, by: PeerId, owner: PeerId, revision: number, note: string, withheld: boolean,
    reviewer: PeerId | null, assignmentNote: string, extra: Parameters<Board["update"]>[5], expectedFlowRevision: number, binding?: PlannerBinding): Task {
    return this.atomic(() => {
      const current = this.get(id);
      if (!current || current.history.length !== expectedFlowRevision) throw new Error("task flow revision changed");
      const pulled = this.pullPlanned(id, by, owner, revision, note, withheld, binding);
      const assigned = this.update(id, by, "assigned", { owner, reviewer, ...(binding ? { planner: binding.planner } : {}) }, assignmentNote, { ...extra, ...(binding ? { plannerReason: binding.plannerReason } : {}) }, pulled.history.length);
      // Both deferred events describe the committed handoff, including the callback payload.
      for (const change of this.pendingChanges ?? []) if (change.task.id === id) change.task = assigned;
      return assigned;
    });
  }

  /** No owner or execution evidence may be taken back by planning undo. */
  undoPlannedPull(id: number, by: PeerId, revision: number): Task {
    const task = this.get(id), pull = task ? planningUndoEntry(task)?.planning : undefined;
    if (!task || task.state !== "proposed" || task.owner || taskHasStarted(task) || (task.planningRevision ?? 0) !== revision || !pull?.pull || pull.revision !== revision) throw new Error("planner pull undo changed or already offered");
    const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "backlog returned", note: `undo planner pull revision ${revision}` };
    const result = this.taskWrite(() => this.db.query("UPDATE tasks SET state='backlog',owner=NULL,reviewer=NULL,reserved=?,planning_revision=planning_revision+1,history=?,updated=? WHERE id=? AND planning_revision=? AND state='proposed' AND owner IS NULL")
      .run(pull.previous.reserved ?? null, JSON.stringify([...task.history, entry]), now, id, revision));
    if (result.changes !== 1) throw new Error("planner pull undo changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  /** #334: set by `Tasks` for exactly the next `splitBacklog` and cleared by it, so the hub's own intake split requires its parent to still be a draft. */
  requireDraftForNextSplit = false;
  splitBacklog(id: number, by: PeerId, revision: number, parts: (Parameters<Board["propose"]>[1] & { fields?: PlanningFields; afterParts?: number[]; screeningNote?: string })[], note: string, withheld = false): { parent: Task; children: Task[] } {
    const requireDraft = this.requireDraftForNextSplit; this.requireDraftForNextSplit = false;
    return this.atomic(() => {
      const parent = this.get(id);
      if (!parent || parent.state !== "backlog" || parent.owner || taskHasStarted(parent) || (parent.planningRevision ?? 0) !== revision || parts.length < 2 || parts.length > 8) throw new Error("split changed or invalid");
      // #334: the hub's own intake split is only ever for a draft. An approval clears the mark without moving the planning revision, so the revision alone cannot tell the
      // person approved the card while the model answered; checked here, in the same transaction as the write, nothing can slip between this and the children.
      if (requireDraft && !parent.draft) throw new Error("split changed or invalid");
      const children: Task[] = [];
      for (const part of parts) {
        const inherited = part.afterParts?.length ? (part.deps ?? []).filter(dep => !parent.deps?.includes(dep)) : part.deps ?? [];
        const deps = [...new Set([...inherited, ...(part.afterParts ?? []).map(index => { const child = children[index]; if (!child) throw new Error("split dependencies must name an earlier part"); return child.id; })])];
        let child = this.propose(by, { ...part, deps, backlog: true, ...(parent.draft ? { draft: true } : {}) });
        if (part.screeningNote !== undefined) child = this.update(child.id, HUB, "screened", {}, part.screeningNote);
        if (part.fields && Object.keys(part.fields).length) child = this.plan(child.id, by, part.fields, 0, note, withheld);
        children.push(child);
      }
      const deps = children.map(child => child.id);
      const updated = this.plan(id, by, { deps }, revision, note, withheld);
      const entry = updated.history.at(-1)!;
      entry.planning!.split = { children: children.map(child => ({ id: child.id, revision: child.planningRevision ?? 0, history: child.history.length })) };
      this.taskWrite(() => this.db.query("UPDATE tasks SET history=? WHERE id=?").run(JSON.stringify(updated.history), id));
      const notification = this.pendingChanges?.findLast(change => change.task.id === id && change.entry.planning?.revision === revision + 1);
      if (notification) { notification.task = updated; notification.entry = entry; }
      return { parent: this.get(id)!, children };
    });
  }

  /**
   * #334: approve an intake draft and its children in one transaction. Only the person's approval reaches here (Tasks.approveIntake);
   * each card must still be an unstarted, ownerless backlog draft, or nothing changes.
   */
  approveDrafts(ids: readonly number[], by: PeerId, note: string): Task[] {
    return this.atomic(() => {
      const rows = ids.map(id => this.get(id));
      for (const row of rows) if (!row || row.state !== "backlog" || !row.draft || row.owner || taskHasStarted(row)) throw new Error("draft changed, approved or started");
      return rows.map(row => {
        const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "draft approved", note };
        const result = this.taskWrite(() => this.db.query("UPDATE tasks SET draft=0, history=?, updated=? WHERE id=? AND draft=1").run(JSON.stringify([...row!.history, entry]), now, row!.id));
        if (result.changes !== 1) throw new Error("draft changed, approved or started");
        const updated = this.get(row!.id)!; this.changed(updated, entry); return updated;
      });
    });
  }

  undoBacklogSplit(id: number, by: PeerId, revision: number): Task {
    return this.atomic(() => {
      const parent = this.get(id), entry = parent ? planningUndoEntry(parent) : undefined, split = entry?.planning?.split;
      if (!parent || parent.state !== "backlog" || parent.owner || taskHasStarted(parent) || (parent.planningRevision ?? 0) !== revision || !split || entry?.planning?.revision !== revision) throw new Error("split undo changed");
      const ids = new Set(split.children.map(child => child.id));
      for (const saved of split.children) {
        const child = this.get(saved.id);
        if (!child || child.state !== "backlog" || child.owner || taskHasStarted(child) || (child.planningRevision ?? 0) !== saved.revision || child.history.length !== saved.history) throw new Error("split child changed or started");
      }
      if (this.list().some(task => task.id !== id && !ids.has(task.id) && (task.deps?.some(dep => ids.has(dep)) || task.sdlc?.phase?.tasks.some(ref => ids.has(ref.id) || ref.after.some(dep => ids.has(dep)))))) throw new Error("split children are referenced by other work");
      const restored = this.plan(id, by, { deps: entry!.planning!.previous.deps ?? [] }, revision, `undo split revision ${revision}`);
      for (const child of ids) this.taskWrite(() => {
        this.db.query("DELETE FROM task_code_symbols WHERE task=?").run(child);
        return this.db.query("DELETE FROM tasks WHERE id=?").run(child);
      });
      return restored;
    });
  }

  newRelease(name: string, goal: string, order: number, planner?: PeerId | null): Release {
    const now = Date.now(), selected = plannerValue(planner);
    const result = this.db.query("INSERT INTO releases(name,goal,release_order,created,updated,planner) VALUES(?,?,?,?,?,?)").run(name, goal, order, now, now, selected);
    return this.release(Number(result.lastInsertRowid))!;
  }
  release(id: number): Release | undefined {
    const row = this.db.query("SELECT * FROM releases WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? parseRelease(row) : undefined;
  }
  releases(): Release[] {
    return (this.db.query("SELECT * FROM releases ORDER BY release_order,id").all() as Record<string, unknown>[]).map(parseRelease);
  }
  updateRelease(id: number, patch: Partial<Pick<Release, "state" | "planner" | "plannedStart" | "cut" | "ship" | "train">>, revision: number): Release {
    const release = this.release(id);
    if (!release || release.revision !== revision) throw new Error("release revision changed");
    const next = { ...release, ...patch, planner: Object.hasOwn(patch, "planner") ? plannerValue(patch.planner) : release.planner ?? null }, now = Date.now();
    const moves: Record<ReleaseState, ReleaseState[]> = { planning: ["active", "dropped"], active: ["frozen", "dropped"], frozen: ["shipped", "dropped"], shipped: [], dropped: [] };
    if (next.state !== release.state && !moves[release.state].includes(next.state)) throw new Error("invalid release transition");
    if (patch.train && next.state !== release.state && ["frozen", "shipped"].includes(next.state)) {
      const event = next.train?.history.at(-1);
      if (event?.event === (next.state === "frozen" ? "cut" : "shipped")) event.at = now;
    }
    const dates = [next.plannedStart, next.cut, next.ship].filter((date): date is number => date !== null);
    if (dates.some(date => !Number.isSafeInteger(date) || date <= 0 || date > 8_640_000_000_000_000) || dates.some((date, i) => i > 0 && dates[i-1]! > date)) throw new Error("invalid release planned dates");
    const result = this.db.query("UPDATE releases SET state=?,planned_start=?,cut=?,ship=?,activated_at=?,frozen_at=?,shipped_at=?,updated=?,train=?,planner=?,revision=revision+1 WHERE id=? AND revision=?")
      .run(next.state, next.plannedStart, next.cut, next.ship, release.activatedAt ?? (next.state === "active" ? now : null), release.frozenAt ?? (next.state === "frozen" ? now : null), release.shippedAt ?? (next.state === "shipped" ? now : null), now, next.train === undefined ? null : JSON.stringify(next.train), next.planner, id, revision);
    if (result.changes !== 1) throw new Error("release revision changed");
    return this.release(id)!;
  }

  /** Cross-connection scope changes cannot race the final freeze write. */
  freezeRelease(id: number, revision: number, scope: Task[], train: NonNullable<Release["train"]>): Release {
    return this.db.transaction(() => {
      const release = this.release(id);
      if (!release || release.revision !== revision || release.state !== "active" || this.releases().some(row => row.id !== id && ["active", "frozen"].includes(row.state)) || JSON.stringify(this.list().filter(task => task.release === id)) !== JSON.stringify(scope)) throw new Error("release scope changed before freeze");
      return this.updateRelease(id, { state: "frozen", train }, revision);
    })();
  }

  recordOutcome(peer: PeerId, cls: TaskClass, ok: boolean, at = Date.now()): void {
    this.db.query("INSERT INTO outcomes (peer, class, ok, at) VALUES (?, ?, ?, ?)").run(peer, cls, ok ? 1 : 0, at);
    this.db.query("DELETE FROM outcomes WHERE at < ?").run(at - OUTCOMES_KEPT_MS); // nothing older is read
  }

  outcomes(cls: TaskClass, since: number): { peer: PeerId; ok: number; at: number }[] {
    return this.db.query("SELECT peer, ok, at FROM outcomes WHERE class = ? AND at >= ?").all(cls, since) as { peer: PeerId; ok: number; at: number }[];
  }

  recordReview(r: Omit<ReviewOutcome, "at">, at = Date.now()): void {
    this.db.query("INSERT INTO reviews (implementer, reviewer, class, kind, task, at) VALUES (?, ?, ?, ?, ?, ?)").run(r.implementer, r.reviewer, r.class, r.kind, r.task, at);
  }

  /** One task's review outcomes, or a class's (for reviewer choice). */
  reviews(where: { task: number } | { class: TaskClass }): ReviewOutcome[] {
    return ("task" in where
      ? this.db.query("SELECT * FROM reviews WHERE task = ? ORDER BY at").all(where.task)
      : this.db.query("SELECT * FROM reviews WHERE class = ? ORDER BY at").all(where.class)) as ReviewOutcome[];
  }

  /** A short-circuit SQL presence read; no task, receipt or history body is hydrated into JS. */
  hasConductorManualState(): boolean {
    const row = this.db.query(`SELECT EXISTS(
      SELECT 1 FROM tasks, json_each(CASE WHEN json_valid(tasks.history) THEN tasks.history ELSE '[]' END) AS entry
      WHERE tasks.state NOT IN ('approved','cancelled') AND CASE WHEN json_valid(entry.value)
        THEN json_type(entry.value,'$.conductorManual') IS NOT NULL ELSE 0 END
    ) AS present`).get() as { present: number };
    return row.present === 1;
  }

  hasPlannerState(): boolean {
    const row = this.db.query(`SELECT
      EXISTS(SELECT 1 FROM tasks WHERE planner IS NOT NULL) OR
      EXISTS(SELECT 1 FROM releases WHERE planner IS NOT NULL) OR
      EXISTS(SELECT 1 FROM tasks WHERE CASE WHEN json_valid(sdlc) THEN
        json_type(sdlc,'$.planReview.planAuthor') IS NOT NULL OR json_type(sdlc,'$.planReview.selfReview') IS NOT NULL ELSE 0 END) OR
      EXISTS(SELECT 1 FROM tasks, json_each(CASE WHEN json_valid(tasks.history) THEN tasks.history ELSE '[]' END) AS entry
        WHERE CASE WHEN json_valid(entry.value) THEN json_type(entry.value,'$.planAuthor') IS NOT NULL OR json_type(entry.value,'$.selfReview') IS NOT NULL ELSE 0 END)
      AS present`).get() as { present: number };
    return row.present === 1;
  }

  close(): void {
    this.db.close();
  }
}

export interface ReviewOutcome {
  implementer: PeerId;
  reviewer: PeerId;
  class: TaskClass;
  /** approved; contradicted (a later check failure or changes requested on the same places); caught (changes requested, then the redo passed); escalated */
  kind: "approved" | "contradicted" | "caught" | "escalated";
  task: number;
  at: number;
}

function parse(row: Record<string, unknown>): Task {
  const out = { ...row } as Record<string, unknown>;
  for (const key of ["offer", "cancelled"]) if (row[key] == null) delete out[key]; else out[key] = JSON.parse(String(row[key]));
  for (const col of JSON_COLS) {
    if (col === "sdlc" && row[col] == null) delete out[col];
    else out[col] = JSON.parse(String(row[col]));
  }
  try {
    const rawSymbols = row.code_symbols == null ? undefined : String(row.code_symbols);
    const symbols = rawSymbols === undefined || Buffer.byteLength(rawSymbols) > 64 * 1024 ? undefined : parseTaskCodeSymbols(JSON.parse(rawSymbols));
    const head = (out.refs as TaskRefs).commit ?? (out.sdlc as SdlcReceipt | undefined)?.head ?? (out.sdlc as SdlcReceipt | undefined)?.localHead;
    const privateSymbols = (out.signals as string[]).some(signal => signal === "pii" || signal === "pii_path");
    if (symbols && symbols.head === head && !privateSymbols) out.codeSymbols = symbols;
  } catch { /* Malformed optional derived evidence stays unavailable. */ }
  delete out.code_symbols;
  if (out.project_profile != null) Object.assign(out, JSON.parse(String(out.project_profile)));
  delete out.project_profile;
  if (out.external_repo != null && out.external_issue != null) out.external = { provider: "github", repo: String(out.external_repo), issue: Number(out.external_issue), url: `https://github.com/${out.external_repo}/issues/${out.external_issue}` };
  delete out.external_repo; delete out.external_issue;
  if (out.task_role != null) out.role = out.task_role;
  delete out.task_role;
  if (out.planned_start != null) out.plannedStart = out.planned_start;
  delete out.planned_start;
  if (out.planning_revision) out.planningRevision = out.planning_revision;
  delete out.planning_revision;
  if (out.pinned) out.pinned = true; else delete out.pinned;
  if (out.draft) out.draft = true; else delete out.draft;
  for (const key of ["rank", "priority", "release", "due"]) if (out[key] == null) delete out[key];
  out.planner = row.planner ?? null;
  return out as unknown as Task;
}

function parseRelease(row: Record<string, unknown>): Release {
  return { ...(row.train == null ? {} : { train: JSON.parse(String(row.train)) }), planner: row.planner == null ? null : String(row.planner), id: Number(row.id), name: String(row.name), goal: String(row.goal), order: Number(row.release_order), state: row.state as ReleaseState,
    plannedStart: row.planned_start as number | null, cut: row.cut as number | null, ship: row.ship as number | null,
    activatedAt: row.activated_at as number | null, frozenAt: row.frozen_at as number | null, shippedAt: row.shipped_at as number | null,
    created: Number(row.created), updated: Number(row.updated), revision: Number(row.revision) };
}
