import { types } from "node:util";
import type { ReviewAnchor, ReviewSelector } from "@staix/agent-console/contract";
import { sanitize } from "./envelope.ts";
import { projectionPath } from "./projected-diff.ts";
import type { ReviewMaterial } from "./review-material.ts";
export type { ReviewAnchor, ReviewSelector, ReviewThread } from "@staix/agent-console/contract";

/** Conformance bounds belong to the published acon contract; hub write byte bounds are a separate layer below. */
const CONTRACT = { exact: 2000, context: 64, body: 4000, threads: 200, selectors: 4 };
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !keys.includes(key)) || Object.values(descriptors).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return undefined;
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Object.getOwnPropertySymbols(value).length) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Object.keys(fields).length === value.length + 1 && Object.entries(fields).every(([key, field]) => key === "length"
    || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length && Object.hasOwn(field, "value") && field.enumerable);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function selectorProblems(value: unknown, at: string): string[] {
  const row = data(value, ["kind", "startLine", "endLine", "exact", "prefix", "suffix", "hunkHeader", "scheme", "ref", "x", "y", "width", "height", "page"]);
  if (!row) return [`${at}: inert closed selector required`];
  const allowed: Record<string, string[]> = {
    lineRange: ["kind", "startLine", "endLine"], textQuote: ["kind", "exact", "prefix", "suffix"],
    diffHunk: ["kind", "hunkHeader"], structural: ["kind", "scheme", "ref"], region: ["kind", "x", "y", "width", "height", "page"],
  };
  if (typeof row.kind !== "string" || !Object.hasOwn(allowed, row.kind)) return [`${at}.kind is unsupported`];
  if (Object.keys(row).some(key => !allowed[row.kind as string]!.includes(key))) return [`${at}: unknown selector fields`];
  switch (row.kind) {
    case "lineRange": return positive(row.startLine) && positive(row.endLine) && row.startLine <= row.endLine ? [] : [`${at}: invalid startLine/endLine`];
    case "textQuote": return text(row.exact) && row.exact.length <= CONTRACT.exact && typeof row.prefix === "string" && row.prefix.length <= CONTRACT.context
      && typeof row.suffix === "string" && row.suffix.length <= CONTRACT.context ? [] : [`${at}: invalid exact/prefix/suffix bounds`];
    case "diffHunk": return typeof row.hunkHeader === "string" && row.hunkHeader.startsWith("@@") ? [] : [`${at}.hunkHeader must start with @@`];
    case "structural": return text(row.scheme) && text(row.ref) ? [] : [`${at}: scheme and ref are required`];
    case "region": return [row.x, row.y, row.width, row.height].every(finite) && (row.page === undefined || positive(row.page)) ? [] : [`${at}: invalid region coordinates or page`];
    default: return [`${at}.kind is unsupported`];
  }
}

export function reviewAnchorContractProblems(value: unknown): string[] {
  const row = data(value, ["path", "side", "contentHash", "projection", "selectors"]);
  if (!row) return ["anchor: inert closed object required"];
  const problems: string[] = [];
  if (!text(row.path)) problems.push("anchor.path must be nonempty");
  if (row.side !== undefined && row.side !== "base" && row.side !== "head") problems.push("anchor.side must be base or head");
  if (row.contentHash !== undefined && (typeof row.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(row.contentHash))) problems.push("anchor.contentHash must be lowercase sha256");
  if (row.projection !== undefined) {
    const projection = data(row.projection, ["name", "version"]);
    if (!projection || !text(projection.name) || !text(projection.version)) problems.push("anchor.projection needs name and version");
  }
  if (!list(row.selectors, CONTRACT.selectors) || !row.selectors.length) problems.push("anchor.selectors needs 1-4 inert selectors");
  else row.selectors.forEach((selector, index) => problems.push(...selectorProblems(selector, `anchor.selectors[${index}]`)));
  return problems;
}
export function reviewThreadContractProblems(value: unknown): string[] {
  const row = data(value, ["id", "anchor", "body", "author", "at", "state"]);
  if (!row) return ["thread: inert closed object required"];
  const problems: string[] = [];
  for (const field of ["id", "author"]) if (!text(row[field])) problems.push(`thread.${field} must be nonempty`);
  if (!text(row.body) || row.body.length > CONTRACT.body) problems.push("thread.body must contain 1-4000 characters");
  if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) problems.push("thread.at must be a valid timestamp");
  if (row.state !== undefined && row.state !== "open" && row.state !== "resolved") problems.push("thread.state must be open or resolved");
  problems.push(...reviewAnchorContractProblems(row.anchor).map(problem => `thread.${problem}`));
  return problems;
}
export function reviewThreadsContractProblems(value: unknown): string[] {
  if (!list(value, CONTRACT.threads)) return ["threads must be an inert array of at most 200 entries"];
  const problems: string[] = [], ids = new Set<string>();
  value.forEach((thread, index) => {
    problems.push(...reviewThreadContractProblems(thread).map(problem => `threads[${index}]: ${problem}`));
    const row = data(thread, ["id", "anchor", "body", "author", "at", "state"]);
    if (row && typeof row.id === "string") { if (ids.has(row.id)) problems.push(`threads[${index}].id repeats`); ids.add(row.id); }
  });
  return problems;
}

export class ReviewAnchorError extends Error {
  constructor(readonly field: string, readonly maxBytes?: number, readonly shapeFields?: readonly string[]) {
    super("review anchor validation failed");
    this.name = "ReviewAnchorError";
    Object.freeze(this);
  }
  get safeMessage(): string {
    if (this.shapeFields) return `review anchor fields ${this.shapeFields.join(", ")} do not match the acon contract; correct those fields and retry`;
    if (this.maxBytes !== undefined) return `review anchor ${this.field} exceeds ${this.maxBytes} UTF-8 bytes; shorten that field and retry`;
    return `review anchor ${this.field} is invalid; correct that field and retry`;
  }
}
/** Returns only messages assembled by the anchor validator; arbitrary caught errors are never reflected. */
export function reviewAnchorErrorMessage(error: unknown): string {
  return error instanceof ReviewAnchorError ? error.safeMessage : "review anchor is invalid; correct its fields and retry";
}
function fail(field: string, maxBytes?: number): never { throw new ReviewAnchorError(field, maxBytes); }
function contractField(problem: string): string {
  const selector = /^anchor\.selectors\[(\d+)\]/.exec(problem);
  if (selector) {
    const prefix = `anchor.selectors[${selector[1]}]`;
    const member = /^\.([A-Za-z]+)/.exec(problem.slice(prefix.length))?.[1];
    if (member) return `selectors[${selector[1]}].${member}`;
    if (problem.includes("startLine/endLine")) return `selectors[${selector[1]}].startLine/endLine`;
    if (problem.includes("exact/prefix/suffix")) return `selectors[${selector[1]}].exact/prefix/suffix`;
    if (problem.includes("region coordinates or page")) return `selectors[${selector[1]}].x/y/width/height/page`;
    if (problem.includes("scheme and ref")) return `selectors[${selector[1]}].scheme/ref`;
    return `selectors[${selector[1]}]`;
  }
  const field = /^anchor\.(path|side|contentHash|projection|selectors)\b/.exec(problem)?.[1];
  return field ?? "anchor";
}
function failShape(problems: readonly string[]): never {
  const fields = [...new Set(problems.map(contractField))];
  throw new ReviewAnchorError("anchor", undefined, fields.length ? fields : ["anchor"]);
}
function writeQuoteText(value: string, maxBytes: number, field: string): string {
  if (value.includes("\0")) return fail(field);
  if (Buffer.byteLength(value, "utf8") > maxBytes) return fail(field, maxBytes);
  return value;
}
function writeText(value: string, maxBytes: number, field: string): string {
  if (value.includes("\0")) return fail(field);
  if (Buffer.byteLength(value, "utf8") > maxBytes) return fail(field, maxBytes);
  const safe = sanitize(value);
  if (Buffer.byteLength(safe, "utf8") > maxBytes) return fail(field, maxBytes);
  return safe;
}
/** The hub write boundary. Quote selector text stays byte-bounded and exact; other stored text is sanitized here. */
export function parseReviewAnchor(value: unknown): ReviewAnchor {
  const problems = reviewAnchorContractProblems(value);
  if (problems.length) return failShape(problems);
  const row = value as ReviewAnchor, path = writeText(row.path, 4096, "path");
  if (/[\p{Cc}\p{Cf}\\]/u.test(path) || /^[a-z]:/i.test(path) || !projectionPath({ top: "", dir: "", prefix: "" }, path)) return fail("path");
  const selectors = row.selectors.map((selector, index): ReviewSelector => {
    switch (selector.kind) {
      case "lineRange":
        if (!Number.isSafeInteger(selector.startLine) || !Number.isSafeInteger(selector.endLine)) return fail(`selectors[${index}].startLine/endLine`);
        return { ...selector };
      case "textQuote": return { kind: "textQuote", exact: writeQuoteText(selector.exact, 512, `selectors[${index}].exact`), prefix: writeQuoteText(selector.prefix, 64, `selectors[${index}].prefix`), suffix: writeQuoteText(selector.suffix, 64, `selectors[${index}].suffix`) };
      case "diffHunk": return { kind: "diffHunk", hunkHeader: writeText(selector.hunkHeader, 256, `selectors[${index}].hunkHeader`) };
      case "structural": return { kind: "structural", scheme: writeText(selector.scheme, 128, `selectors[${index}].scheme`), ref: writeText(selector.ref, 512, `selectors[${index}].ref`) };
      case "region":
        if (selector.page !== undefined && !Number.isSafeInteger(selector.page)) return fail(`selectors[${index}].page`);
        return { ...selector };
    }
  });
  return { path, ...(row.side === undefined ? {} : { side: row.side }), ...(row.contentHash === undefined ? {} : { contentHash: row.contentHash }),
    ...(row.projection ? { projection: { name: writeText(row.projection.name, 128, "projection.name"), version: writeText(row.projection.version, 128, "projection.version") } } : {}), selectors };
}

export interface ReviewAnchorStatus { status: "anchored" | "moved" | "outdated" | "unavailable"; range?: { startLine: number; endLine: number } }
function quotePosition(text: string, quote: Extract<ReviewSelector, { kind: "textQuote" }>): number | undefined {
  let count = 0, contextual = 0, first = -1, contextualAt = -1;
  if (!quote.exact) return undefined;
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    count++; first = at;
    const end = at + quote.exact.length;
    if (at >= quote.prefix.length && text.slice(at - quote.prefix.length, at) === quote.prefix
      && text.slice(end, end + quote.suffix.length) === quote.suffix) { contextual++; contextualAt = at; }
  }
  return count === 1 ? first : contextual === 1 ? contextualAt : undefined;
}
/** Placement only. Projection identity precedes byte equality; no stored selector or hash is rewritten. */
export function anchorStatus(anchor: ReviewAnchor, material: ReviewMaterial): ReviewAnchorStatus {
  if (material.state !== "available" || material.path !== anchor.path || material.side !== (anchor.side ?? "head")) return { status: "unavailable" };
  if (anchor.projection?.name !== material.projection?.name || anchor.projection?.version !== material.projection?.version) return { status: "outdated" };
  if (anchor.contentHash !== undefined && anchor.contentHash === material.contentHash) return { status: "anchored" };
  for (const selector of anchor.selectors) if (selector.kind === "textQuote") {
    const at = quotePosition(material.text, selector);
    if (at === undefined) continue;
    const startLine = material.text.slice(0, at).split("\n").length;
    const endLine = material.text.slice(0, at + selector.exact.length - 1).split("\n").length;
    return { status: "moved", range: { startLine, endLine } };
  }
  return { status: "outdated" };
}
