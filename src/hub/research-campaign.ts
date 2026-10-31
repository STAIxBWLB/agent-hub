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
