import { types } from "node:util";
import type { ReviewAnchor, ReviewSelector } from "./acon-review-contract.d.ts";
import { sanitize } from "./envelope.ts";
import { projectionPath } from "./projected-diff.ts";
import type { ReviewMaterial } from "./review-material.ts";
export type { ReviewAnchor, ReviewSelector, ReviewThread } from "./acon-review-contract.d.ts";

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

const fail = (field: string): never => { throw new Error(`review anchor ${field} is invalid or over its hub bound; select a contained public path and bounded selectors, then retry`); };
function writeText(value: string, maxBytes: number, field: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) return fail(field);
  const safe = sanitize(value);
  if (Buffer.byteLength(safe, "utf8") > maxBytes) return fail(field);
  return safe;
}
/** The hub write boundary. It returns an owned copy and sanitizes only here, never while placing stored anchors. */
export function parseReviewAnchor(value: unknown): ReviewAnchor {
  if (reviewAnchorContractProblems(value).length) return fail("shape");
  const row = value as ReviewAnchor, path = writeText(row.path, 4096, "path");
  if (/[\p{Cc}\p{Cf}\\]/u.test(path) || /^[a-z]:/i.test(path) || !projectionPath({ top: "", dir: "", prefix: "" }, path)) return fail("path");
  const selectors = row.selectors.map((selector): ReviewSelector => {
    switch (selector.kind) {
      case "lineRange":
        if (!Number.isSafeInteger(selector.startLine) || !Number.isSafeInteger(selector.endLine)) return fail("lineRange");
        return { ...selector };
      case "textQuote": return { kind: "textQuote", exact: writeText(selector.exact, 512, "exact"), prefix: writeText(selector.prefix, 64, "prefix"), suffix: writeText(selector.suffix, 64, "suffix") };
      case "diffHunk": return { kind: "diffHunk", hunkHeader: writeText(selector.hunkHeader, 256, "hunkHeader") };
      case "structural": return { kind: "structural", scheme: writeText(selector.scheme, 128, "scheme"), ref: writeText(selector.ref, 512, "ref") };
      case "region":
        if (selector.page !== undefined && !Number.isSafeInteger(selector.page)) return fail("page");
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
