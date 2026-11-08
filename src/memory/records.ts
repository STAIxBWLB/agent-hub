import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CaptureStore, CAPTURE_MAX_EXCERPT, CAPTURE_MAX_PATHS, RECORD_INSTRUCTION, isDenied, looksSecret, parseRecordLines, type ParsedRecord } from "@staix/agent-mem";

export interface RecordCaptureCounts { accepted: number; dropped: number; bytes: number }
export interface RecordCaptureResult extends RecordCaptureCounts { text: string }
export interface RecordCapturePolicy {
  /** Required effective machine/repository opt-in. Missing or unknown is disabled. */
  records: boolean;
  /** Captured owner/turn/session/policy fence; false or a throw refuses all effects. */
  current(): boolean;
  project: string; cwd: string; peer: string; turn: string; session: string;
  /** Stable host turn timestamp, also used by the library's idempotent receipt. */
  at: string;
  home?: string; memoryDir?: string;
  publicText(text: string): boolean;
  /** Receives a lexical repository-relative path without a symbol suffix. Unknown must refuse. */
  denyPath(path: string): boolean;
}
export interface RecordCapturePorts {
  /** Whole-turn privacy, remote/review exclusion and adapter eligibility, before policy/config access. */
  eligible(): boolean;
  policy(): RecordCapturePolicy | undefined;
  /** Counts of processed records/canonical UTF-8 bytes only; never text, paths or identity. */
  observe?(counts: RecordCaptureCounts): void;
}
const marker = /^[\t ]*(?:>[\t ]*)*amem:[^\r\n]*(?:\r\n|[\r\n]|$)/gm;
/** Transport stripping only. Record grammar, private-span handling and validation belong to agent-mem. */
export function stripRecordLines(text: string): string { return text.replace(marker, ""); }
function stripped(text: string): { text: string; count: number } {
  let count = 0;
  return { text: text.replace(marker, () => { count++; return ""; }), count };
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && Buffer.byteLength(value) <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);

/** Host-only local capture; no worker, observer model, MemoryClient or curated-memory writes. */
export class RecordCapture {
  constructor(private readonly ports: RecordCapturePorts) {}
  private current(policy: RecordCapturePolicy): boolean {
    try { return this.ports.eligible() === true && policy.records === true && policy.current() === true; }
    catch { return false; }
  }
  private policy(): RecordCapturePolicy | undefined {
    try {
      if (this.ports.eligible() !== true) return;
      const policy = this.ports.policy();
      return policy && policy.records === true && this.current(policy) ? policy : undefined;
    } catch { return; }
  }
  instruction(): string | undefined { return this.policy() ? RECORD_INSTRUCTION : undefined; }
  private valid(policy: RecordCapturePolicy): boolean {
    if (!identity(policy.project, 400) || !identity(policy.peer, 64) || !/^[a-z][a-z0-9-]*$/.test(policy.peer)
      || !identity(policy.turn, 256) || !identity(policy.session, 4096) || !identity(policy.at, 32)
      || !isAbsolute(policy.cwd) || (policy.home === undefined) === (policy.memoryDir === undefined)
      || policy.home !== undefined && !isAbsolute(policy.home) || policy.memoryDir !== undefined && !isAbsolute(policy.memoryDir)) return false;
    try { return new Date(policy.at).toISOString() === policy.at; } catch { return false; }
  }
  private clear(record: ParsedRecord, policy: RecordCapturePolicy): boolean {
    try {
      if (!this.current(policy) || record.line.length > CAPTURE_MAX_EXCERPT || record.anchors.length > CAPTURE_MAX_PATHS
        || looksSecret(record.line) || policy.publicText(record.line) !== true) return false;
      for (const anchor of record.anchors) {
        const path = anchor.split("#")[0]!;
        if (isDenied(path) || policy.denyPath(path) !== false) return false;
      }
      return this.current(policy);
    } catch { return false; }
  }
  finish(answer: string): RecordCaptureResult {
    const shared = stripped(answer), empty = { text: shared.text, accepted: 0, dropped: 0, bytes: 0 };
    // Stripping is independent of capture eligibility and even policy/configuration failures.
    const policy = this.policy();
    if (!policy || shared.count === 0) return empty;
    let store: CaptureStore | undefined;
    const counts: RecordCaptureCounts = { accepted: 0, dropped: shared.count, bytes: 0 };
    try {
      if (!this.valid(policy)) return this.result(shared.text, counts, policy);
      const parsed = parseRecordLines(answer, () => !this.current(policy));
      if (parsed.incomplete || !this.current(policy)) return empty;
      // Preflight the entire batch before any store/config access. No partial records or silent cuts.
      const records = parsed.records.filter(record => this.clear(record, policy));
      if (!this.current(policy)) return empty;
      if (records.length) {
        const project = policy.project, peer = policy.peer, session = policy.session, turn = policy.turn, at = policy.at;
        store = new CaptureStore({ project, cwd: policy.cwd, ...(policy.home === undefined ? { memoryDir: policy.memoryDir } : { home: policy.home }),
          screen: text => {
            try { return !this.current(policy) || looksSecret(text) || policy.publicText(text) !== true || !this.current(policy); }
            catch { return true; }
          } });
        for (const record of records) {
          const index = parsed.records.indexOf(record);
          if (!this.current(policy)) break;
          try {
            store.append({ project, agent: peer, event: "Record", paths: record.anchors, excerpt: record.line, at,
              session: digest(["ahub-record-session-v1", project, peer, session]).slice(0, 16),
              status: `turn:${digest(["ahub-record-turn-v1", turn]).slice(0, 16)}` },
            { receipt: digest(["ahub-record-v1", project, peer, session, turn, at, index, record.line]) });
            // Includes an already-present idempotent library receipt; not a claim of newly inserted disk bytes.
            counts.accepted++; counts.dropped--; counts.bytes += Buffer.byteLength(record.line);
          } catch { /* Current package caps/policy or unavailable storage decline the whole row; never share its text. */ }
        }
      }
    } catch { /* Final-answer publication must survive capture/config/store failures. */ }
    finally { try { store?.close(); } catch { /* No answer text or native error escapes. */ } }
    return this.result(shared.text, counts, policy);
  }
  private result(text: string, counts: RecordCaptureCounts, policy: RecordCapturePolicy): RecordCaptureResult {
    if (!this.current(policy)) return { text, accepted: 0, dropped: 0, bytes: 0 };
    try { this.ports.observe?.({ ...counts }); } catch { /* An observation never costs an answer. */ }
    return { text, ...counts };
  }
  /** Stores are scoped to finish(), including every error path. */
  close(): void {}
}
