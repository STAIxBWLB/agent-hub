import { sanitize } from "./envelope.ts";
import { CorpusIndex, MAX_CORPUS_READS, MAX_FRONTMATTER_BYTES, MAX_NOTE_BYTES, parseNote, type NoteRecord } from "./corpus.ts";

export const MAX_CORPUS_EVIDENCE = 6;
export const MAX_CORPUS_EVIDENCE_ITEM_BYTES = 768;
export const MAX_CORPUS_EVIDENCE_BYTES = 4096;

export interface CorpusEvidencePolicy {
  allowed(): boolean;
  version(): string;
  /** Screen the complete, fresh note plus its raw metadata before any excerpt is produced. */
  safe(text: string, paths: readonly string[]): boolean;
}

export interface CorpusEvidence { id: string; kind: "note"; text: string }

const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();
const words = (text: string): string[] => [...new Set(normalize(text).match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
const score = (query: readonly string[], text: string): number => {
  const haystack = normalize(text);
  return query.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
};

/** Slugs retain Unicode letters and numbers, fold case, and use hyphens for punctuation or whitespace. */
export function headingSlug(heading: string): string {
  return normalize(heading).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

/** Escape only the delimiters in the citation grammar; Unicode and its spelling remain literal. */
function escapeCitationPart(value: string): string {
  return value.replace(/[\\,#\[\]]/g, char => `\\${char}`);
}

export function noteCitationId(baseId: string, slug: string): string {
  const id = `${escapeCitationPart(baseId)}#${escapeCitationPart(slug)}`;
  if (!isNoteCitation(id)) throw new Error("unsupported note citation id");
  return id;
}

/** A syntactic guard for note citations. Callers still need to match the full ID against evidence they actually supplied. */
export function isNoteCitation(id: string): boolean {
  if (!id.startsWith("note:") || Buffer.byteLength(id) > 1024 || Array.from(id).some(char => { const point = char.codePointAt(0)!; return point <= 0x1f || point === 0x7f; })) return false;
  let separator = -1, escaped = false;
  for (let i = 5; i < id.length; i++) {
    const char = id[i]!;
    if (escaped) { if (!["\\", ",", "[", "]", "#"].includes(char)) return false; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "#") { if (separator >= 0) return false; separator = i; continue; }
    if (char === "," || char === "[" || char === "]") return false;
  }
  return !escaped && separator > 5 && separator < id.length - 1 && id.slice(5, separator).includes("/");
}

interface Section { slug: string; heading?: string; body: string }

function contentStart(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  let bytes = 0;
  for (let i = 1; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i]!) + 1;
    if (bytes > MAX_FRONTMATTER_BYTES) return lines.length;
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) return i + 1;
  }
  return lines.length;
}

/** Split prose using the same Markdown heading expression and fenced-code rules as parseNote. */
function sections(text: string): Section[] {
  const lines = text.split(/\r?\n/), start = contentStart(lines), bodyLines = lines.slice(start);
  const parsedHeadings = parseNote(text).headings;
  const boundaries: { line: number; text: string }[] = [];
  let fence: string | undefined;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { const mark = marker[1]![0]!; if (!fence) fence = mark; else if (fence === mark) fence = undefined; continue; }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    const cleanHeading = heading?.[2]?.replace(/\s+/g, " ").trim().slice(0, 200);
    if (heading && parsedHeadings[boundaries.length]?.text === cleanHeading) boundaries.push({ line: i, text: parsedHeadings[boundaries.length]!.text });
  }

  const occupied = new Set<string>();
  const allocate = (raw: string): string => {
    const base = headingSlug(raw);
    let candidate = base, suffix = 2;
    while (occupied.has(candidate)) candidate = `${base}-${suffix++}`;
    occupied.add(candidate);
    return candidate;
  };
  const hasIntro = boundaries.length === 0 || bodyLines.slice(0, boundaries[0]!.line).some(line => line.trim());
  const result: Section[] = [];
  if (hasIntro) {
    occupied.add("top");
    const end = boundaries[0]?.line ?? bodyLines.length;
    result.push({ slug: "top", body: bodyLines.slice(0, end).join("\n").trim() });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const heading = boundaries[i]!;
    const end = boundaries[i + 1]?.line ?? bodyLines.length;
    result.push({ slug: allocate(heading.text), heading: heading.text, body: bodyLines.slice(heading.line + 1, end).join("\n").trim() });
  }
  if (!result.length) result.push({ slug: "top", body: bodyLines.join("\n").trim() });
  return result;
}

function metadata(record: NoteRecord): string {
  return JSON.stringify({ id: record.id, root: record.root, path: record.path, title: record.title, frontmatter: record.frontmatter, tags: record.tags, aliases: record.aliases, headings: record.headings });
}

function truncateUtf8(text: string, maxBytes: number): string {
  let out = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out;
}

function truncateExcerpt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = " [cut]", markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return "";
  return `${truncateUtf8(text, maxBytes - markerBytes)}${marker}`;
}

function permitted(policy: CorpusEvidencePolicy): boolean {
  try { return policy.allowed(); } catch { return false; }
}

/** Metadata-first retrieval with a fresh, whole-note privacy screen before any excerpt leaves this module. */
export function corpusEvidence(query: string, index: CorpusIndex, policy: CorpusEvidencePolicy): CorpusEvidence[] {
  if (!query.trim() || !permitted(policy)) return [];
  let version: string;
  try { version = policy.version(); } catch { return []; }
  index.refresh();
  if (!permitted(policy)) return [];
  const terms = words(query);
  if (!terms.length) return [];
  // ponytail: ceiling is 32 metadata-ranked candidates; upgrade by adding a query index over approved note text, never by opening every note body.
  const candidates = index.notes().map(record => ({ record, score: score(terms, [record.title, record.path, ...record.tags, ...record.aliases, ...record.headings.map(h => h.text)].filter(Boolean).join(" ")) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, MAX_CORPUS_READS);
  const reads = index.readMany(candidates.map(item => item.record.id));
  if (!permitted(policy)) return [];
  let currentVersion: string;
  try { currentVersion = policy.version(); } catch { return []; }
  if (currentVersion !== version) return [];

  const out: CorpusEvidence[] = [];
  let aggregate = 0;
  for (const read of reads) {
    const record = read.record;
    const currentMetadata = metadata(record);
    if (Buffer.byteLength(read.text) > MAX_NOTE_BYTES) continue;
    try { if (!policy.safe(`${read.text}\n${currentMetadata}`, [read.path, record.path, record.id])) continue; }
    catch { continue; }
    const currentScore = score(terms, [record.title, record.path, ...record.tags, ...record.aliases, ...record.headings.map(h => h.text)].filter(Boolean).join(" "));
    if (!currentScore) continue;
    const noteSections = sections(read.text);
    const candidatesForNote = noteSections.map(section => ({ section, score: score(terms, `${section.heading ?? ""} ${section.body}`) }))
      .sort((a, b) => b.score - a.score);
    const best = candidatesForNote[0]?.section;
    if (!best) continue;
    const rawExcerpt = [best.heading ? `# ${best.heading}` : "", best.body].filter(Boolean).join("\n");
    const safeText = sanitize(rawExcerpt);
    let id: string;
    try { id = noteCitationId(record.id, best.slug); } catch { continue; }
    const remainingText = MAX_CORPUS_EVIDENCE_BYTES - aggregate - Buffer.byteLength(id);
    if (!id || remainingText <= 0) continue;
    const text = truncateExcerpt(safeText, Math.min(MAX_CORPUS_EVIDENCE_ITEM_BYTES, remainingText));
    if (!text) continue;
    const cost = Buffer.byteLength(id) + Buffer.byteLength(text);
    out.push({ id, kind: "note", text });
    aggregate += cost;
    if (out.length >= MAX_CORPUS_EVIDENCE) break;
  }
  try { if (policy.version() !== version || !permitted(policy)) return []; } catch { return []; }
  return out;
}
