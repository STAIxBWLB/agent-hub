import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./packs.ts";

export type ResearchCampaignStatus = "draft" | "approved" | "superseded" | "closed";
export interface ResearchUnit {
  id: string;
  round: number;
  question: string;
  perspective: string;
  requiredOutput: string;
  sourceIds: string[];
  dependsOn: string[];
  purpose: "discovery" | "independent_check" | "analysis" | "synthesis";
  adoptTaskId?: number;
}
export interface ResearchCampaignContract {
  question: string;
  scope: string;
  exclusions: string[];
  sourceIds: string[];
  units: ResearchUnit[];
  deliverableSections: { id: string; title: string; ownerUnitId: string }[];
  stopPolicy: { maxUnits: number; maxFollowUpRounds: number; deadline: string };
  budget?: { id: string; hardCap: ("model_calls" | "tool_calls" | "elapsed_ms" | "tokens")[] };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, SOURCE = /^src:[0-9a-f]{16}$/;
const SHORT = 512, LONG = 4096, BODY = 64 * 1024;
const PURPOSES = ["discovery", "independent_check", "analysis", "synthesis"] as const;
const RESOURCES = ["model_calls", "tool_calls", "elapsed_ms", "tokens"] as const;
function fail(field: string, reason: string): never { throw new Error(`${field}: ${reason}`); }

/** Only inert JSON-shaped data reaches validation or canonical hashing; never invoke a caller's accessor/toJSON. */
function record(input: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, "value"))) fail(field, "expected a plain data object");
  for (const key of Object.keys(input)) if (!keys.includes(key)) {
    const named = key === key.trim() && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ? `${field}.${key}` : field;
    fail(named, "unknown field");
  }
  return input as Record<string, unknown>;
}
function list(input: unknown, max: number, field: string, min = 0): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < min || input.length > max || Object.getOwnPropertySymbols(input).length) fail(field, `expected a list of ${min} to ${max} items`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
    Array.from({ length: input.length }, (_, index) => descriptors[String(index)]).some(descriptor => !descriptor || !Object.hasOwn(descriptor, "value"))) fail(field, "expected a dense data list");
  return Array.from({ length: input.length }, (_, index) => descriptors[String(index)]!.value);
}
const utf8 = (value: string) => Buffer.from(value, "utf8").toString("utf8") === value;
function text(input: unknown, max: number, field: string): string {
  if (typeof input !== "string" || input.length > max || Buffer.byteLength(input, "utf8") > max || !input.trim() || !utf8(input)) fail(field, `expected non-empty UTF-8 text of at most ${max} bytes`);
  return input;
}
function id(input: unknown, field: string, source = false): string {
  if (typeof input !== "string" || input !== input.trim() || !(source ? SOURCE : ID).test(input)) fail(field, source ? "expected a source id (src:<16 hex>)" : "expected a lowercase id of 1 to 64 characters");
  return input;
}
function integer(input: unknown, min: number, max: number, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) fail(field, `expected an integer from ${min} to ${max}`);
  return input;
}
function distinct(values: readonly (string | number)[], field: string): void {
  if (new Set(values).size !== values.length) fail(field, "duplicate values");
}
function ids(input: unknown, max: number, field: string, source = false): string[] {
  const values = list(input, max, field).map((item, index) => id(item, `${field}[${index}]`, source));
  distinct(values, field);
  return values;
}
function deadline(input: unknown, field: string): string {
  const value = text(input, SHORT, field);
  const match = /^(\d{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match || match[0] !== value) fail(field, "expected an ISO timestamp with an explicit time zone");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!days || day < 1 || day > days || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(Date.parse(value))) fail(field, "expected a valid ISO timestamp");
  return value;
}

/** Structural contract only. Source existence, adoption authority, approval time and handoff advancement belong to Tasks. */
export function parseResearchCampaign(input: unknown): ResearchCampaignContract {
  const raw = record(input, ["question", "scope", "exclusions", "sourceIds", "units", "deliverableSections", "stopPolicy", "budget"], "campaign");
  const stop = record(raw.stopPolicy, ["maxUnits", "maxFollowUpRounds", "deadline"], "campaign.stopPolicy");
  const stopPolicy = {
    maxUnits: integer(stop.maxUnits, 1, 32, "campaign.stopPolicy.maxUnits"),
    maxFollowUpRounds: integer(stop.maxFollowUpRounds, 0, 5, "campaign.stopPolicy.maxFollowUpRounds"),
    deadline: deadline(stop.deadline, "campaign.stopPolicy.deadline"),
  };
  const sourceIds = ids(raw.sourceIds, 64, "campaign.sourceIds", true), sourceSet = new Set(sourceIds);
  const units = list(raw.units, 32, "campaign.units", 1).map((value, index): ResearchUnit => {
    const field = `campaign.units[${index}]`, unit = record(value, ["id", "round", "question", "perspective", "requiredOutput", "sourceIds", "dependsOn", "purpose", "adoptTaskId"], field);
    if (typeof unit.purpose !== "string" || !(PURPOSES as readonly string[]).includes(unit.purpose)) fail(`${field}.purpose`, "expected discovery, independent_check, analysis or synthesis");
    const sources = ids(unit.sourceIds, 16, `${field}.sourceIds`, true);
    if (sources.some(source => !sourceSet.has(source))) fail(`${field}.sourceIds`, "must be a subset of campaign.sourceIds");
    return {
      id: id(unit.id, `${field}.id`), round: integer(unit.round, 0, stopPolicy.maxFollowUpRounds, `${field}.round`),
      question: text(unit.question, LONG, `${field}.question`), perspective: text(unit.perspective, SHORT, `${field}.perspective`), requiredOutput: text(unit.requiredOutput, SHORT, `${field}.requiredOutput`),
      sourceIds: sources, dependsOn: ids(unit.dependsOn, 16, `${field}.dependsOn`), purpose: unit.purpose as ResearchUnit["purpose"],
      ...(unit.adoptTaskId !== undefined ? { adoptTaskId: integer(unit.adoptTaskId, 1, Number.MAX_SAFE_INTEGER, `${field}.adoptTaskId`) } : {}),
    };
  });
  if (units.length > stopPolicy.maxUnits) fail("campaign.units", "exceeds stopPolicy.maxUnits");
  distinct(units.map(unit => unit.id), "campaign.units.id");
  distinct(units.flatMap(unit => unit.adoptTaskId === undefined ? [] : [unit.adoptTaskId]), "campaign.units.adoptTaskId");
  const byId = new Map(units.map(unit => [unit.id, unit]));
  for (const [index, unit] of units.entries()) for (const dependency of unit.dependsOn) {
    const previous = byId.get(dependency);
    if (!previous) fail(`campaign.units[${index}].dependsOn`, "names an unknown unit");
    if (previous.round > unit.round) fail(`campaign.units[${index}].dependsOn`, "cannot depend on a later round");
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (unit: ResearchUnit): void => {
    if (visiting.has(unit.id)) fail("campaign.units.dependsOn", "dependency cycle");
    if (visited.has(unit.id)) return;
    visiting.add(unit.id);
    for (const dependency of unit.dependsOn) visit(byId.get(dependency)!);
    visiting.delete(unit.id); visited.add(unit.id);
  };
  for (const unit of units) visit(unit);
  const sections = list(raw.deliverableSections, 32, "campaign.deliverableSections").map((value, index) => {
    const field = `campaign.deliverableSections[${index}]`, section = record(value, ["id", "title", "ownerUnitId"], field);
    const ownerUnitId = id(section.ownerUnitId, `${field}.ownerUnitId`), owner = byId.get(ownerUnitId);
    if (!owner || owner.purpose !== "synthesis") fail(`${field}.ownerUnitId`, "must name an existing synthesis unit");
    return { id: id(section.id, `${field}.id`), title: text(section.title, SHORT, `${field}.title`), ownerUnitId };
  });
  distinct(sections.map(section => section.id), "campaign.deliverableSections.id");
  let budget: ResearchCampaignContract["budget"];
  if (raw.budget !== undefined) {
    const value = record(raw.budget, ["id", "hardCap"], "campaign.budget");
    // Reference ids retain ExecutionBudget.configure's existing exact, non-empty <=200-character contract.
    if (typeof value.id !== "string" || !value.id || value.id.length > 200 || !utf8(value.id)) fail("campaign.budget.id", "expected an existing budget id of 1 to 200 characters");
    const hardCap = list(value.hardCap, RESOURCES.length, "campaign.budget.hardCap").map((resource, index) => {
      if (typeof resource !== "string" || !(RESOURCES as readonly string[]).includes(resource)) fail(`campaign.budget.hardCap[${index}]`, "unknown resource");
      return resource as NonNullable<ResearchCampaignContract["budget"]>["hardCap"][number];
    });
    distinct(hardCap, "campaign.budget.hardCap");
    budget = { id: value.id, hardCap };
  }
  const result: ResearchCampaignContract = {
    question: text(raw.question, LONG, "campaign.question"), scope: text(raw.scope, LONG, "campaign.scope"),
    exclusions: list(raw.exclusions, 32, "campaign.exclusions").map((value, index) => text(value, SHORT, `campaign.exclusions[${index}]`)),
    sourceIds, units, deliverableSections: sections, stopPolicy, ...(budget ? { budget } : {}),
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > BODY) fail("campaign", "stored body exceeds 64 KiB");
  return result;
}

/** Content identity only: ordering of lists and the person's literal text remains significant. */
export function campaignHash(contract: ResearchCampaignContract): string {
  return createHash("sha256").update(canonicalJson(parseResearchCampaign(contract))).digest("hex");
}

export interface ResearchHandoffV1 {
  campaignId: string;
  revision: number;
  unitId: string;
  taskId: number;
  evidence: { sourceId: string; locator: string }[];
  unresolved: string[];
  contradictions: { sourceIds: string[]; note: string }[];
  limitations: string[];
  insufficientEvidence?: string;
}
export interface ResearchHandoffRecord {
  handoff: ResearchHandoffV1;
  seq: number;
  by: string;
  at: number;
  private: boolean;
}

/** Required-field diagnostics are aggregate; no partially validated handoff is persisted. */
export function parseResearchHandoff(input: unknown): ResearchHandoffV1 {
  const required = ["campaignId", "revision", "unitId", "taskId", "evidence", "unresolved", "contradictions", "limitations"] as const;
  const raw = record(input, [...required, "insufficientEvidence"], "handoff");
  const missing = required.filter(key => raw[key] === undefined);
  if (missing.length) fail("handoff", `missing required fields: ${missing.join(", ")}`);
  if (typeof raw.campaignId !== "string" || !/^rc-[0-9a-f]{12}$/.test(raw.campaignId)) fail("handoff.campaignId", "expected a campaign id");
  const shortList = (value: unknown, field: string) => list(value, 16, field).map((item, index) => text(item, SHORT, `${field}[${index}]`));
  const value: ResearchHandoffV1 = {
    campaignId: raw.campaignId,
    revision: integer(raw.revision, 1, Number.MAX_SAFE_INTEGER, "handoff.revision"),
    unitId: id(raw.unitId, "handoff.unitId"), taskId: integer(raw.taskId, 1, Number.MAX_SAFE_INTEGER, "handoff.taskId"),
    evidence: list(raw.evidence, 64, "handoff.evidence").map((item, index) => {
      const field = `handoff.evidence[${index}]`, entry = record(item, ["sourceId", "locator"], field);
      return { sourceId: id(entry.sourceId, `${field}.sourceId`, true), locator: text(entry.locator, SHORT, `${field}.locator`) };
    }),
    unresolved: shortList(raw.unresolved, "handoff.unresolved"),
    contradictions: list(raw.contradictions, 16, "handoff.contradictions").map((item, index) => {
      const field = `handoff.contradictions[${index}]`, entry = record(item, ["sourceIds", "note"], field);
      return { sourceIds: ids(entry.sourceIds, 16, `${field}.sourceIds`, true), note: text(entry.note, SHORT, `${field}.note`) };
    }),
    limitations: shortList(raw.limitations, "handoff.limitations"),
    ...(raw.insufficientEvidence !== undefined ? { insufficientEvidence: text(raw.insufficientEvidence, SHORT, "handoff.insufficientEvidence") } : {}),
  };
  if (Buffer.byteLength(canonicalJson(value), "utf8") > BODY) fail("handoff", "stored body exceeds 64 KiB");
  return value;
}

export type ResearchResource = NonNullable<ResearchCampaignContract["budget"]>["hardCap"][number];
export type ResearchBudgetSupport = "enforceable" | "unknown" | "advisory" | "unavailable";
export interface ResearchProjectionInput {
  campaign: { id: string; revision: number; status: ResearchCampaignStatus; contract: ResearchCampaignContract };
  bindings: readonly { unitId: string; taskId: number; round: number }[];
  tasks: readonly { id: number; state: string; owner: string | null }[];
  handoffs: readonly ResearchHandoffRecord[];
  now: number;
  budget?: { id: string; kind: "task" | "run"; taskId?: number; peers: readonly string[]; limits: Partial<Record<ResearchResource, number>>;
    used?: Partial<Record<ResearchResource, number>>; coveredTaskIds: readonly number[] };
  instrumentedPeers?: readonly string[];
}
export interface ResearchProjection {
  id: string;
  revision: number;
  held: boolean;
  reasons: string[];
  sharedPeerLedger: boolean;
  /** Whether the contract names a budget at all. A named budget that cannot be read still has its rows (`unknown`, `unavailable`); with none named the resource labels carry no information. */
  budgetNamed: boolean;
  units: { unitId: string; round: number; taskId: number | null; state: string; purpose: ResearchUnit["purpose"];
    intentionalIndependentCheck: boolean; sourceIds: string[]; duplicateSourceIds: string[];
    handoff: { present: boolean; complete: boolean; insufficientEvidence: boolean; coveredSourceIds: string[] };
    budget: Record<ResearchResource, { support: ResearchBudgetSupport; used: number | null; limit: number | null }> }[];
  discoveryRounds: { round: number; complete: boolean }[];
}

/** Facts supplied by the host only; task completion never substitutes for source coverage. */
export function studyProjection(input: ResearchProjectionInput): ResearchProjection {
  const { campaign, now } = input, contract = campaign.contract;
  const reasons: string[] = [];
  if (campaign.status !== "approved") reasons.push("campaign approval is not current");
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(contract.stopPolicy.deadline)) || now >= Date.parse(contract.stopPolicy.deadline)) reasons.push("campaign deadline has passed or is unknown");
  if (contract.units.length > contract.stopPolicy.maxUnits || input.bindings.length > contract.stopPolicy.maxUnits) reasons.push("campaign unit limit exceeded");
  if (input.bindings.some(binding => binding.round > contract.stopPolicy.maxFollowUpRounds)) reasons.push("campaign follow-up limit exceeded");
  const assignments = new Map<string, number>();
  for (const unit of contract.units) if (unit.purpose === "discovery") for (const source of unit.sourceIds) assignments.set(source, (assignments.get(source) ?? 0) + 1);
  const units: ResearchProjection["units"] = contract.units.map(unit => {
    const binding = input.bindings.find(value => value.unitId === unit.id), task = binding && input.tasks.find(value => value.id === binding.taskId);
    const latest = binding && input.handoffs.filter(value => value.handoff.campaignId === campaign.id && value.handoff.unitId === unit.id && value.handoff.taskId === binding.taskId && value.handoff.revision <= campaign.revision).sort((a, b) => b.seq - a.seq)[0];
    const covered = new Set(latest?.handoff.evidence.map(value => value.sourceId) ?? []), insufficientEvidence = !!latest?.handoff.insufficientEvidence;
    const budget = Object.fromEntries(RESOURCES.map(resource => {
      const ledger = input.budget, configured = contract.budget;
      let support: ResearchBudgetSupport;
      if (resource === "tokens" || resource === "model_calls" && contract.budget && input.budget?.id === contract.budget.id && input.budget.limits.tokens !== undefined) support = "unavailable";
      else if (!configured || !task?.owner || !ledger || ledger.id !== configured.id) support = "unknown";
      else if (!input.instrumentedPeers?.includes(task.owner)) support = "unavailable";
      else if (!ledger.peers.includes(task.owner) || !ledger.coveredTaskIds.includes(task.id) || ledger.kind === "task" && ledger.taskId !== task.id || ledger.limits[resource] === undefined) support = "advisory";
      else support = "enforceable";
      const matching = configured && ledger?.id === configured.id;
      return [resource, { support, used: matching ? ledger.used?.[resource] ?? null : null, limit: matching ? ledger.limits[resource] ?? null : null }];
    })) as ResearchProjection["units"][number]["budget"];
    return { unitId: unit.id, round: binding?.round ?? unit.round, taskId: binding?.taskId ?? null, state: task?.state ?? "unknown", purpose: unit.purpose,
      intentionalIndependentCheck: unit.purpose === "independent_check", sourceIds: [...unit.sourceIds],
      duplicateSourceIds: unit.purpose === "discovery" ? unit.sourceIds.filter(source => (assignments.get(source) ?? 0) > 1) : [],
      handoff: { present: !!latest, complete: !!latest && unit.sourceIds.every(source => covered.has(source)), insufficientEvidence, coveredSourceIds: unit.sourceIds.filter(source => covered.has(source)) }, budget };
  });
  const discoveryRounds = [...new Set(units.filter(unit => unit.purpose === "discovery").map(unit => unit.round))].sort((a, b) => a - b)
    .map(round => ({ round, complete: units.filter(unit => unit.round === round && unit.purpose === "discovery").every(unit => unit.handoff.complete || unit.handoff.insufficientEvidence) }));
  return { id: campaign.id, revision: campaign.revision, held: reasons.length > 0, reasons,
    sharedPeerLedger: !!contract.budget && input.budget?.id === contract.budget.id && input.budget.kind === "run", budgetNamed: !!contract.budget, units, discoveryRounds };
}
