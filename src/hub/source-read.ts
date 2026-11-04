import { sanitize } from "./envelope.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { validSourceId } from "./sources.ts";
import type { SourceMeta } from "./sources.ts";
import { createHash } from "node:crypto";
import { MAX_ORIGINS, MAX_ORIGIN_CHARS, parseSourceProjectionReceipt, sha256Of, type SourceProjectionReceiptV1 } from "./sources.ts";
import { resolveEvidenceLocator, type EvidenceLinkV1, type EvidenceResolution } from "./research-evidence.ts";

export const MAX_SOURCE_READ_BYTES = 32 * 1024;
export const SOURCE_READ_OFFSET_UNIT = "unicode-code-point";
const CUT_MARKER = " [cut]";
const REFUSAL = "source read unavailable";

export interface SourceReadRegistry {
  get(id: string): SourceMeta | undefined;
  readText(id: string): string | undefined;
  markPrivate(id: string): SourceMeta | undefined;
}

export interface SourceReadPolicy {
  /** Screen the complete stored text. True means clear; false means private or unknown. */
  screen(text: string, meta: SourceMeta): Promise<boolean>;
  /** A synchronous, fresh authorization check. */
  valid(): boolean;
  /** True only for an authorized on-prem worker inside a PII task. */
  canReadPrivate(): Promise<boolean>;
}

export interface SourceReadArgs { id: string; range?: { offset: number; length: number } }
export type SourceReadResult =
  | { id: string; kind: SourceMeta["kind"]; private: true }
  | { id: string; kind: SourceMeta["kind"]; private: true; text: string; next: number }
  | { id: string; kind: SourceMeta["kind"]; private: false; text: string; next: number };

function refuse(): never { throw new PreEffectToolRefusal(REFUSAL); }

/** Validate the exact tool shape before touching the registry or privacy policy. */
export function validateSourceRead(value: unknown): SourceReadArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "id" && key !== "range") || !validSourceId(input.id)) refuse();
  if (input.range === undefined) return { id: input.id };
  if (!input.range || typeof input.range !== "object" || Array.isArray(input.range)) refuse();
  const range = input.range as Record<string, unknown>;
  if (Object.keys(range).length !== 2 || Object.keys(range).some(key => key !== "offset" && key !== "length")
    || !Number.isSafeInteger(range.offset) || (range.offset as number) < 0
    || !Number.isSafeInteger(range.length) || (range.length as number) < 1
    || !Number.isSafeInteger((range.offset as number) + (range.length as number))) refuse();
  return { id: input.id, range: { offset: range.offset as number, length: range.length as number } };
}

function sameRecord(a: SourceMeta, b: SourceMeta): boolean {
  return a.id === b.id && a.kind === b.kind && a.origin === b.origin && a.sha256 === b.sha256 && a.bytes === b.bytes
    && a.added_at === b.added_at && a.private === b.private && JSON.stringify(a.origins) === JSON.stringify(b.origins) && JSON.stringify(a.projection) === JSON.stringify(b.projection);
}
function sameContent(a: SourceMeta, b: SourceMeta): boolean {
  return a.id === b.id && a.kind === b.kind && a.sha256 === b.sha256 && a.bytes === b.bytes;
}

async function privateResult(registry: SourceReadRegistry, id: string, meta: SourceMeta, range: SourceReadArgs["range"], policy: SourceReadPolicy): Promise<SourceReadResult> {
  const authorized = await policy.canReadPrivate();
  if (!policy.valid()) refuse();
  const afterAuth = registry.get(id);
  if (!afterAuth || !afterAuth.private || !sameRecord(meta, afterAuth)) refuse();
  if (!authorized) {
    if (!policy.valid()) refuse();
    return { id, kind: afterAuth.kind, private: true };
  }
  const text = registry.readText(id), finalMeta = registry.get(id);
  if (text === undefined || !finalMeta?.private || !sameRecord(afterAuth, finalMeta)) refuse();
  if (!policy.valid()) refuse();
  return render(id, finalMeta.kind, text, range, true);
}

/** Screen the whole source before selecting a bounded excerpt; re-read identity and privacy after async policy boundaries. */
export async function sourceRead(registry: SourceReadRegistry, value: unknown, policy: SourceReadPolicy): Promise<SourceReadResult> {
  const args = validateSourceRead(value);
  try {
    if (!policy.valid()) refuse();
    let meta = registry.get(args.id);
    if (!meta) refuse();
    if (meta.private) {
      const result = await privateResult(registry, args.id, meta, args.range, policy);
      if (!policy.valid()) refuse();
      return result;
    }

    let fullText = registry.readText(args.id);
    if (fullText === undefined) refuse();
    let clear = false;
    try { clear = await policy.screen(fullText, meta); }
    catch { clear = false; }
    if (!policy.valid()) refuse();
    const afterScreen = registry.get(args.id), afterScreenText = registry.readText(args.id);
    if (!afterScreen || afterScreenText === undefined || !sameContent(meta, afterScreen) || afterScreenText !== fullText) refuse();
    if (afterScreen.private) {
      const result = await privateResult(registry, args.id, afterScreen, args.range, policy);
      if (!policy.valid()) refuse();
      return result;
    }
    if (!sameRecord(meta, afterScreen)) refuse();
    meta = afterScreen;
    if (!clear) {
      if (!policy.valid()) refuse();
      meta = registry.markPrivate(args.id) ?? registry.get(args.id);
      if (!meta?.private) refuse();
      const result = await privateResult(registry, args.id, meta, args.range, policy);
      if (!policy.valid()) refuse();
      return result;
    }

    if (!policy.valid()) refuse();
    const current = registry.get(args.id);
    if (!current || !sameRecord(meta, current) || current.private) refuse();
    fullText = registry.readText(args.id);
    if (fullText === undefined || fullText !== afterScreenText) refuse();
    if (!policy.valid()) refuse();
    return render(args.id, current.kind, fullText, args.range, false);
  } catch {
    refuse();
  }
}

/** Walk only the requested, byte-bounded prefix. Sanitizer growth is measured by a bounded binary search over that prefix. */
function render(id: string, kind: SourceMeta["kind"], fullText: string, range: SourceReadArgs["range"], isPrivate: boolean): SourceReadResult {
  const offset = range?.offset ?? 0, limit = range?.length ?? Number.MAX_SAFE_INTEGER;
  const iterator = fullText[Symbol.iterator]();
  let skipped = 0;
  while (skipped < offset) {
    if (iterator.next().done) return isPrivate
      ? { id, kind, private: true, text: "", next: offset }
      : { id, kind, private: false, text: "", next: offset };
    skipped++;
  }

  const chars: string[] = [];
  let rawBytes = 0, exhausted = false, stoppedAtByteLimit = false;
  while (chars.length < limit) {
    const next = iterator.next();
    if (next.done) { exhausted = true; break; }
    const point = next.value;
    const size = Buffer.byteLength(point, "utf8");
    if (rawBytes + size > MAX_SOURCE_READ_BYTES) { stoppedAtByteLimit = true; break; }
    chars.push(point);
    rawBytes += size;
  }
  const hasMoreAfterSelection = stoppedAtByteLimit || (!exhausted && chars.length >= limit && !iterator.next().done);
  const fits = (count: number): boolean => {
    const candidate = sanitize(chars.slice(0, count).join(""));
    const needsMarker = hasMoreAfterSelection || count < chars.length;
    return Buffer.byteLength(candidate, "utf8") + (needsMarker ? Buffer.byteLength(CUT_MARKER, "utf8") : 0) <= MAX_SOURCE_READ_BYTES;
  };
  let low = 0, high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  const consumed = low;
  let text = sanitize(chars.slice(0, consumed).join(""));
  const hasMore = hasMoreAfterSelection || consumed < chars.length;
  if (hasMore) text += CUT_MARKER;
  const next = offset + consumed;
  return isPrivate ? { id, kind, private: true, text, next } : { id, kind, private: false, text, next };
}

export interface SourceEvidenceRegistry extends SourceReadRegistry { readRaw(id: string): Buffer | undefined }
export interface EvidenceSourcePolicy extends SourceReadPolicy {
  /** Current host decoder/converter fingerprint; never read from an evidence caller. No conversion is started here. */
  projectionVersion(receipt: SourceProjectionReceiptV1): string | undefined;
}
export interface EvidenceSourceRead { resolution: EvidenceResolution }

/** Selected-link read through the existing whole-source privacy boundary; full text never leaves this host closure. */
export async function readEvidenceSource(registry: SourceEvidenceRegistry, link: EvidenceLinkV1, policy: EvidenceSourcePolicy): Promise<EvidenceSourceRead> {
  const unavailable = (cause: Extract<EvidenceResolution, { status: "unavailable" }>["cause"]): EvidenceSourceRead => ({ resolution: { status: "unavailable", cause } });
  try {
    if (!policy.valid()) return unavailable("source_unavailable");
    const before = registry.get(link.sourceId);
    if (!before) return unavailable("source_unavailable");
    if (before.private) return unavailable("private");
    const receipt = parseSourceProjectionReceipt(before.projection);
    if (!receipt) return unavailable("projection_missing");
    const fullText = registry.readText(link.sourceId), raw = registry.readRaw(link.sourceId);
    if (fullText === undefined || !raw || receipt.rawSha256 !== before.sha256 || sha256Of(raw) !== before.sha256) return unavailable("source_unavailable");
    const selected = await sourceRead(registry, { id: link.sourceId, range: { offset: link.locator.start, length: link.locator.end - link.locator.start } }, { valid: () => policy.valid(), screen: (text, meta) => policy.screen(text, meta), canReadPrivate: async () => false });
    if (!policy.valid()) return unavailable("source_unavailable");
    const current = registry.get(link.sourceId);
    if (selected.private || current?.private) return unavailable("private");
    if (!current || !sameRecord(before, current) || registry.readText(link.sourceId) !== fullText) return unavailable("source_unavailable");
    const currentRaw = registry.readRaw(link.sourceId);
    if (!currentRaw || sha256Of(currentRaw) !== before.sha256) return unavailable("source_unavailable");
    const currentVersion = policy.projectionVersion(receipt);
    if (!currentVersion) return unavailable("projection_missing");
    if (currentVersion !== receipt.projectionVersion) return { resolution: { status: "stale", cause: "projection_changed" } };
    const resolution = resolveEvidenceLocator(link, { sourceId: current.id, rawSha256: current.sha256, projectionSha256: receipt.projectionSha256, projectionVersion: receipt.projectionVersion, text: fullText, complete: receipt.complete });
    if (!policy.valid()) return unavailable("source_unavailable");
    return { resolution };
  } catch { return unavailable("source_unavailable"); }
}

/** Ephemeral duplicate-origin keys, never an assertion of independent corroboration or a public origin projection. */
export function evidenceOriginKeys(meta: SourceMeta): readonly string[] | undefined {
  if (meta.private || !Array.isArray(meta.origins) || !meta.origins.length || meta.origins.length > MAX_ORIGINS) return undefined;
  const keys = new Set<string>();
  try {
    for (const origin of meta.origins) {
      if (origin.private || typeof origin.origin !== "string" || !origin.origin || origin.origin.length > MAX_ORIGIN_CHARS || /[\p{Cc}\p{Cf}]/u.test(origin.origin)) return undefined;
      let normalized = origin.origin;
      if (origin.kind === "url") {
        const url = new URL(normalized); if (url.protocol !== "https:" || url.username || url.password) return undefined;
        url.hash = ""; normalized = url.toString();
      } else if (origin.kind !== "file") return undefined;
      keys.add(createHash("sha256").update(JSON.stringify([origin.kind, normalized])).digest("hex"));
    }
    return [...keys].sort();
  } catch { return undefined; }
}
