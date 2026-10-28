import { lstatSync } from "node:fs";
import { extname } from "node:path";
import { sanitize } from "../hub/envelope.ts";
import { matchesPolicy } from "../hub/path-policy.ts";
import { MAX_PROJECTION_INPUT, type ProjectedText } from "../hub/text-projection.ts";
import { OUTPUT_CAP } from "./sandbox.ts";

// agent-hub #515 (hub task #320): the local worker's `doc_read`. Spec: "On-prem web reading (#515)", AC2 and AC3 for doc_read.
// The model names a path and nothing else: the converter, its arguments and its sandbox are the person's `text_projection` config, run by `TextProjections`.

/** What the daemon hands the worker when a project opts in (`local.doc_read: true`). Getters, so a policy reload applies to the next call. */
export interface DocReadPort {
  /** The projections of this worker's execution root: the same instance the hub's own facts and review projections use. */
  projections: () => { handles(file: string): boolean; project(file: string): ProjectedText | undefined };
  /** `pii.paths`: a document under it is PII. */
  piiPaths: () => readonly string[];
  /** `signals.pii_patterns`: a document whose text matches is PII. */
  piiPatterns: () => readonly string[];
}
/** The port as a tool call sees it: with whether this turn is a PII task turn. */
export interface DocReadContext extends DocReadPort { pii: boolean }

export const DEFAULT_DOC_LINES = 2000;

/** The refusal text for a document the turn may not read, so the model is told why instead of retrying. */
const PII_PATH = "is under pii.paths: only a PII task turn on the on-prem worker may read it; ask for it in a PII task";
const PII_TEXT = "has text that matches signals.pii_patterns, so it is PII: only a PII task turn on the on-prem worker may read it; ask for it in a PII task";

/**
 * Text of one document. `file` is already the real path `guardPath` returned (inside the project, not on the denylist, no link escapes). Never throws: every refusal
 * is text for the model. Read-only: the converter runs in the projection sandbox on a private copy of the bytes and its cache lives in the hub state directory,
 * so nothing is written beside the document, whatever `data.readonly` says.
 * ponytail: the conversion is synchronous in the daemon process (bounded by the converter's 8 s timeout, then cached by content); upgrade path is an async spawn if long
 * documents ever stall the hub.
 */
export function docRead(file: string, shown: string, args: Record<string, unknown>, port: DocReadContext, cwd: string): string {
  const projections = port.projections();
  if (!projections.handles(file)) {
    const ext = extname(file).toLowerCase() || "(no extension)";
    return `error: no converter is configured for ${ext} files (text_projection in .agenthub/config.local.json names one per extension); use read for plain text`;
  }
  let st;
  try { st = lstatSync(file); } catch { return `error: ${shown} cannot be read`; }
  if (!st.isFile()) return `error: ${shown} is not a regular file`;
  if (st.nlink !== 1) return `error: ${shown} has several names (a hard link), so its path policy cannot be checked; copy it first`;
  if (st.size > MAX_PROJECTION_INPUT) return `error: ${shown} is larger than ${MAX_PROJECTION_INPUT / 1024 / 1024} MiB`;
  // pii.paths decides by the document's own path first: a non-PII turn never even converts it.
  if (!port.pii && matchesPolicy(cwd, file, [...port.piiPaths()])) return `error: ${shown} ${PII_PATH}`;
  const projected = projections.project(file);
  if (!projected) return `error: ${shown} could not be converted (the converter failed or timed out, it is not available here, or the sandbox is unavailable)`;
  const text = projected.text.replace(/\0/g, "");
  if (!port.pii) {
    // A pattern that cannot be evaluated is not a clear verdict.
    try { if (port.piiPatterns().some(pattern => new RegExp(pattern).test(text))) return `error: ${shown} ${PII_TEXT}`; }
    catch { return `error: ${shown} could not be screened against signals.pii_patterns, so it is not shown`; }
  }
  const lines = sanitize(text).split(/\r?\n/);
  const from = Math.max(1, Math.floor(Number(args.offset)) || 1), limit = Math.max(1, Math.floor(Number(args.limit)) || DEFAULT_DOC_LINES);
  if (from > lines.length) return `error: offset ${from} is past the end (${lines.length} lines)`;
  let out = "", shownTo = from - 1;
  for (let i = from - 1; i < Math.min(lines.length, from - 1 + limit); i++) {
    const row = `${i + 1}\t${lines[i]}\n`;
    if (out.length + row.length > OUTPUT_CAP) { if (!out) out = row.slice(0, OUTPUT_CAP); break; }
    out += row; shownTo = i + 1;
  }
  if (!shownTo || shownTo < from) shownTo = from;
  out = out.replace(/\n$/, "");
  return shownTo < lines.length ? `${out}\n(lines ${from}-${shownTo} of ${lines.length}; read again with offset=${shownTo + 1})` : out;
}
