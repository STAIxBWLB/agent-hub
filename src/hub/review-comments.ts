import type { ActionMeta, ReviewAnchor, ReviewThread } from "@staix/agent-console/contract";
import { types } from "node:util";
import { sanitize } from "./envelope.ts";
import { parseReviewAnchor, type ReviewAnchorStatus as AnchorPlacement } from "./review-anchor.ts";

export const REVIEW_COMMENT_LIMIT = 64;
export const REVIEW_COMMENT_BODY_BYTES = 2048;
export const REVIEW_PACKAGE_BYTES = 12000;
export type ReviewCommentLifecycle = "draft" | "sent" | "resolved" | "dismissed";
export interface ReviewCommentCounts { draft: number; sent: number; resolved: number; dismissed: number }
export interface ReviewCommentRecord {
  thread: ReviewThread; task: number; taskCreated: number; commit: string;
  lifecycle: ReviewCommentLifecycle; revision: number; sentAt?: string; private: boolean;
}
export type ReviewCommentView = {
  thread: ReviewThread; id?: never; task: number; commit: string; lifecycle: ReviewCommentLifecycle;
  revision: number; sentAt?: string; placement: AnchorPlacement;
} | { id: string; thread?: never; task: number; commit: string; lifecycle: ReviewCommentLifecycle;
  revision: number; sentAt?: string; placement: { status: "unavailable" } };
export interface ReviewCommentFence { task: number; taskCreated: number; flow: number; head?: string; owner: string | null }
export interface ReviewCommentMutation { task: number; id: string; revision: number; lifecycle?: ReviewCommentLifecycle; deleted?: true }
export interface ReviewCommentPackage {
  task: number; taskCreated: number; id: string; ids: string[]; owner: string; head: string; at: string;
  /** Immutable delivery payload. Missing on pre-recovery packages; those require explicit manual inspection. */
  body?: string; envelopeId?: string; trace?: string; ts?: number; delivery?: "unconfirmed" | "queued"; publicationEvidenceVersion?: 1;
  /** Ids whose quote/body were included in the immutable public envelope; absent on legacy packets. */
  visibleIds?: string[];
}
export interface ReviewCommentPackageView { id: string; count: number; delivery: "queued" | "unconfirmed" | "unavailable" }
export const emptyReviewCommentCounts = (): ReviewCommentCounts => ({ draft: 0, sent: 0, resolved: 0, dismissed: 0 });

function fail(cause: string): never { throw new Error(`review comments ${cause}; refresh the task review and retry with a current bounded comment`); }
export function reviewCommentFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length) fail("request must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.entries(descriptors).some(([key, value]) => !allowed.includes(key) || !value.enumerable || !Object.hasOwn(value, "value"))) fail("request has unknown, hidden fields or accessors");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function reviewCommentNumber(value: unknown, name: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${name} is invalid`);
  return value;
}
export function reviewCommentId(value: unknown): string {
  if (typeof value !== "string" || !/^comment-[a-f0-9-]{36}$/.test(value)) fail("id is invalid");
  return value;
}
export function reviewCommentIds(value: unknown): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail("ids must be an inert array");
  const descriptors = Object.getOwnPropertyDescriptors(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > REVIEW_COMMENT_LIMIT || Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail("ids must be a bounded distinct list");
  const ids: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("ids cannot contain holes, hidden fields or accessors");
    ids.push(reviewCommentId(descriptor.value));
  }
  if (new Set(ids).size !== ids.length) fail("ids must be distinct");
  return ids;
}
export function reviewCommentHead(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail("commit is not a full lowercase SHA");
  return value;
}
export function reviewCommentBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("body is empty or invalid");
  const body = sanitize(value);
  if (Buffer.byteLength(body, "utf8") > REVIEW_COMMENT_BODY_BYTES) fail("body exceeds 2048 UTF-8 bytes");
  return body;
}
function authorText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("verified person identity is invalid");
  const identity = sanitize(value);
  if (Buffer.byteLength(identity, "utf8") > 512 || /[\p{Cc}\p{Cf}]/u.test(identity) || Buffer.from(identity).toString("utf8") !== identity) fail("verified person identity is invalid");
  return identity;
}
export function reviewCommentAuthor(meta?: ActionMeta): string {
  if (meta === undefined) return "local";
  if (meta.via !== "console" || typeof meta.node !== "string" || !meta.node.trim()) fail("verified person identity is unavailable");
  return authorText(meta.identity);
}
/** Private-path quotes are discarded, never converted into invented line/page coordinates. */
export function privateReviewAnchor(anchor: ReviewAnchor): ReviewAnchor {
  const selectors = anchor.selectors.filter(selector => selector.kind === "lineRange" || selector.kind === "structural");
  if (!selectors.length) fail("private path needs an existing lineRange or structural selector");
  return parseReviewAnchor({ ...anchor, selectors });
}
export function reviewThreadProjection(record: ReviewCommentRecord): ReviewThread {
  return { ...record.thread, state: record.lifecycle === "resolved" || record.lifecycle === "dismissed" ? "resolved" : "open" };
}
/** Fixed storage validation; no stored body or parser cause is echoed on failure. */
export function parseStoredReviewComment(input: unknown): ReviewCommentRecord {
  try {
    const row = reviewCommentFields(input, ["thread", "task", "taskCreated", "commit", "lifecycle", "revision", "sentAt", "private"]);
    const thread = reviewCommentFields(row.thread, ["id", "anchor", "body", "author", "at"]);
    const author = authorText(thread.author);
    if (author !== thread.author) fail("stored author is not sanitized");
    if (!["draft", "sent", "resolved", "dismissed"].includes(String(row.lifecycle)) || typeof row.private !== "boolean"
      || typeof thread.author !== "string" || !thread.author || typeof thread.at !== "string" || !Number.isFinite(Date.parse(thread.at))
      || row.sentAt !== undefined && (typeof row.sentAt !== "string" || !Number.isFinite(Date.parse(row.sentAt)))) fail("stored metadata is invalid");
    if ((row.lifecycle === "sent" || row.lifecycle === "resolved") && row.sentAt === undefined) fail("stored sent time is missing");
    return { task: reviewCommentNumber(row.task, "task"), taskCreated: reviewCommentNumber(row.taskCreated, "taskCreated", 0), commit: reviewCommentHead(row.commit),
      lifecycle: row.lifecycle as ReviewCommentLifecycle, revision: reviewCommentNumber(row.revision, "revision"), private: row.private,
      ...(row.sentAt === undefined ? {} : { sentAt: row.sentAt as string }), thread: { id: reviewCommentId(thread.id), anchor: parseReviewAnchor(thread.anchor), body: reviewCommentBody(thread.body), author, at: thread.at } };
  } catch { throw new Error("review comment storage invalid; stop the hub and restore a trusted hub.db backup, then restart and retry"); }
}
export function renderReviewComment(record: ReviewCommentRecord, placement: AnchorPlacement, visible: boolean): string {
  if (!visible) return `[${record.thread.id}] unavailable: this comment is kept on the board.`;
  if (placement.status === "unavailable") return `[${record.thread.id}] unavailable: refresh the task review before using its text.`;
  const { anchor } = record.thread;
  const range = placement.status === "outdated" ? undefined : placement.range ?? anchor.selectors.find(selector => selector.kind === "lineRange");
  const location = sanitize(anchor.path) + (range ? `:${range.startLine}-${range.endLine}` : "");
  const quotes = anchor.selectors.filter(selector => selector.kind === "textQuote").map(selector => sanitize(selector.exact));
  return [`[${record.thread.id}] ${location} (${placement.status}) at ${record.commit}`, ...quotes.map(quote => `> ${quote.replace(/\n/g, "\n> ")}`), sanitize(record.thread.body)].join("\n");
}
