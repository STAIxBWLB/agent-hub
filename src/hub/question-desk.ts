import { HUB, newEnvelope, USER, type Envelope, type PeerId } from "./envelope.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { QuestionWaitDetached } from "./question-detach.ts";
import { parseAsk, QUESTION_SET, type AnswerResult, type QuestionAnswer, type QuestionReason, type QuestionRow, type QuestionStore, type QuestionSurface } from "./questions.ts";

/**
 * #1053 T3: what `hub_ask` does with the store. The store owns the row and its one terminal transition; this desk owns the waiting call (in memory, never
 * persisted), the person's supersede, the cancel on stop or abort, the expiry sweep and the hub-built envelope a late answer needs. It reaches the rest of the
 * daemon only through `DeskPorts`, so a fake peer and a fake bus exercise every path. Nothing here logs: question and answer text stay in the store and in the
 * envelope addressed to the asking peer.
 */

export type AskResult =
  | { status: "answered"; questionSet: string; answers: QuestionAnswer[]; answeredBy: "person"; surface: QuestionSurface }
  | { status: "pending"; questionSet: string }
  | { status: "superseded"; questionSet: string }
  | { status: "cancelled"; questionSet: string; reason: QuestionReason }
  | { status: "unavailable"; reason: QuestionReason };

/** The events the desk reports: ids, peers, counts and a closed reason, never a prompt, an option or an answer. */
export interface QuestionEvent {
  type: "question";
  set: string;
  peer: string;
  event: "asked" | "answered" | "pending" | "superseded" | "cancelled" | "expired" | "unavailable";
  latencyMs?: number;
  surface?: QuestionSurface;
  reason?: QuestionReason;
  questions?: number;
  private?: boolean;
}

export interface DeskPorts {
  store: QuestionStore;
  now(): number;
  /** How long a `hub_ask` call of this peer waits before it answers `pending`. */
  waitMs(peer: PeerId): number;
  ttlMs(): number;
  /** The peer's native session id; "" when the adapter reports none or the peer is offline: unknown never cancels. */
  session(peer: PeerId): string;
  unattended(peer: PeerId): boolean;
  /** The peer's current turn is a PII turn (`piiTurn`, from the tool call), or it holds an open PII task, or `task` is one. */
  isPrivate(peer: PeerId, task: number | undefined, piiTurn?: boolean): boolean;
  /** The hub is stopping or in recovery: a new question is refused before any row exists. */
  held(): boolean;
  /** Publish a hub-built envelope; throws when the bus refuses it (the row keeps its owed flag and the sweep retries). */
  publish(env: Envelope): void;
  event(e: QuestionEvent): void;
  /** Peers whose queue can still take an envelope; an unknown peer id never gets a row. */
  peerKnown(peer: PeerId): boolean;
}

interface Waiter { resolve(result: AskResult): void; timer: ReturnType<typeof setTimeout>; detach(): void }
/** Settled rows are kept this long for `ahub` readbacks, then pruned; an open row or an owed envelope is never pruned. */
const KEEP_SETTLED_MS = 7 * 86_400_000;

/** The late-answer envelope. `from` is the person, `kind` is `answer`, and the set rides in `refs.question` and as the body's first line `reply_to: <set>` (an envelope has no reply field of its own: `reply_to` is the `hub_send` argument that resolves an envelope id). The id is derived from the set so a republish after a crash is dropped by the bus's own dedupe. */
export function answerEnvelope(row: QuestionRow): Envelope {
  const result: AskResult = { status: "answered", questionSet: row.set, answers: row.answers ?? [], answeredBy: "person", surface: row.surface ?? "console" };
  const body = `reply_to: ${row.set}\nYour question ${row.set} was answered by the person${row.surface ? ` (${row.surface})` : ""}. Use this answer; do not ask it again.\n${JSON.stringify(result)}`;
  return { ...newEnvelope(USER, body, { to: [row.peer], kind: "answer", priority: "important", refs: { question: row.set }, ...(row.private ? { private: true } : {}) }), id: `answer-${row.set}` };
}
/** The expiry notice. A hub notice of kind `status`, never an answer: the agent decides for itself. */
export function expiryEnvelope(row: QuestionRow, ttlMs: number): Envelope {
  const hours = Math.max(1, Math.round(ttlMs / 3_600_000));
  const body = `Your question ${row.set} expired unanswered after about ${hours} hour${hours === 1 ? "" : "s"}. This is not an answer: decide yourself and say so.`;
  return { ...newEnvelope(HUB, body, { to: [row.peer], kind: "status", priority: "status", refs: { question: row.set }, ...(row.private ? { private: true } : {}) }), id: `question-expired-${row.set}` };
}

export class QuestionDesk {
  private readonly waiters = new Map<string, Waiter>();
  private closed = false;
  constructor(private readonly p: DeskPorts) {}

  /** The waiting calls right now (a row without one is orphaned: its answer takes the late path). */
  waiting(): number { return this.waiters.size; }

  async ask(peer: PeerId, raw: unknown, ctx: { signal?: AbortSignal; piiTurn?: boolean } = {}): Promise<AskResult> {
    if (this.closed || this.p.held()) throw new PreEffectToolRefusal("the hub is stopping or recovering; ask again once it is back");
    if (peer === USER || peer === HUB || !this.p.peerKnown(peer)) throw new PreEffectToolRefusal("hub_ask is for the agents of this project; the person answers with the console");
    const parsed = parseAsk(raw);
    if (!parsed.ok) throw new PreEffectToolRefusal(parsed.error);
    // `--unattended` means nobody is watching: no row, no wait. The agent decides and says so.
    if (this.p.unattended(peer)) {
      this.p.event({ type: "question", set: "-", peer, event: "unavailable", reason: "unattended", questions: parsed.value.questions.length });
      return { status: "unavailable", reason: "unattended" };
    }
    if (ctx.signal?.aborted) throw new PreEffectToolRefusal("the turn was aborted before the question was asked");
    const created = this.p.store.ask({ peer, session: this.p.session(peer), ...(parsed.value.task !== undefined ? { task: parsed.value.task } : {}), private: this.p.isPrivate(peer, parsed.value.task, ctx.piiTurn === true), questions: parsed.value.questions }, this.p.now());
    if ("error" in created) throw new PreEffectToolRefusal(created.error);
    const row = created;
    this.p.event({ type: "question", set: row.set, peer, event: "asked", questions: row.questions.length, private: row.private });
    return new Promise<AskResult>(resolve => {
      const waitMs = Math.max(1000, this.p.waitMs(peer));
      const onAbort = () => {
        if (!this.waiters.has(row.set)) return;
        if (ctx.signal?.reason instanceof QuestionWaitDetached) { this.p.event({ type: "question", set: row.set, peer, event: "pending", latencyMs: this.p.now() - row.created, private: row.private }); this.settleWait(row.set, { status: "pending", questionSet: row.set }); }
        else this.cancelRow(row.set, "turn_aborted");
      };
      const timer = setTimeout(() => {
        // The window ended: the row stays open and its answer arrives as an envelope.
        if (!this.waiters.has(row.set)) return;
        this.p.event({ type: "question", set: row.set, peer, event: "pending", latencyMs: this.p.now() - row.created, private: row.private });
        this.settleWait(row.set, { status: "pending", questionSet: row.set });
      }, waitMs);
      timer.unref?.();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(row.set, { resolve, timer, detach: () => ctx.signal?.removeEventListener("abort", onAbort) });
    });
  }

  /**
   * The person's answer, from the console role only (the daemon checks the role before it calls this). Of any number of concurrent answers, stops and expiries,
   * the store's compare-and-set lets exactly one win; a loser is told the row's real terminal state. An answer to a row with no waiting call is the late path.
   */
  answer(set: unknown, raw: unknown, surface: QuestionSurface): AnswerResult {
    if (typeof set !== "string" || !QUESTION_SET.test(set)) return { ok: false, error: "no such question" };
    const current = this.p.store.get(set);
    if (current?.state === "open" && this.sessionChanged(current)) {
      this.cancelRow(set, "session_changed");
      return { ok: false, error: "question is already cancelled", state: "cancelled" };
    }
    const late = !this.waiters.has(set);
    const result = this.p.store.answer(set, raw, surface, this.p.now(), late);
    if (!result.ok) return result;
    this.p.event({ type: "question", set, peer: result.row.peer, event: "answered", latencyMs: this.p.now() - result.row.created, surface, private: result.row.private });
    if (late) this.publishOwed(result.row);
    else this.settleWait(set, { status: "answered", questionSet: set, answers: result.row.answers ?? [], answeredBy: "person", surface });
    return result;
  }

  /** The person sent these peers a normal message: every open question of each is superseded and its waiting call told. That message is delivered as usual. */
  supersede(peers: readonly PeerId[]): void {
    for (const peer of new Set(peers)) for (const row of this.p.store.settleFor(peer, "superseded", "superseded", this.p.now())) {
      this.p.event({ type: "question", set: row.set, peer, event: "superseded", latencyMs: this.p.now() - row.created, private: row.private });
      this.settleWait(row.set, { status: "superseded", questionSet: row.set });
    }
  }
  /** A stop of the peer: its open questions are cancelled and its waiting calls told. */
  cancelPeer(peer: PeerId, reason: QuestionReason): void {
    for (const row of this.p.store.settleFor(peer, "cancelled", reason, this.p.now())) this.announceCancel(row, reason);
  }
  /** Peers with at least one open row, for a broadcast from the person. */
  openPeers(): PeerId[] { return [...new Set(this.p.store.list({ state: "open" }, 200).map(row => row.peer))]; }

  /** Expiry, session changes, envelopes still owed and old settled rows. Run on a timer and once at start. */
  sweep(): void {
    if (this.closed) return;
    const now = this.p.now();
    for (const row of this.p.store.expireDue(now, this.p.ttlMs())) {
      this.p.event({ type: "question", set: row.set, peer: row.peer, event: "expired", latencyMs: now - row.created, reason: "expired", private: row.private });
      // A waiting call carries the result itself, so no envelope is owed; an orphaned row gets the hub notice.
      if (this.waiters.has(row.set)) { this.p.store.published(row.set); this.settleWait(row.set, { status: "cancelled", questionSet: row.set, reason: "expired" }); }
      else this.publishOwed(row);
    }
    for (const row of this.p.store.list({ state: "open" }, 200)) if (this.sessionChanged(row)) this.cancelRow(row.set, "session_changed");
    for (const row of this.p.store.owed()) this.publishOwed(row);
    this.p.store.prune(now, KEEP_SETTLED_MS);
  }
  /** Start repair: a row whose session changed is cancelled, every other open row stays open for the late path, and an owed envelope goes out. */
  repair(): void { this.sweep(); }

  /** Shutdown: waiting calls end `pending` (their rows stay open and survive the restart); nothing new is admitted. */
  close(): void {
    this.closed = true;
    this.endWaits();
  }
  /** Recovery `prepare`: waiting calls end `pending` now, so a restart never waits out a person's window; every row stays open for the late path. */
  endWaits(): void {
    for (const [set, waiter] of [...this.waiters]) { if (this.waiters.get(set) === waiter) this.settleWait(set, { status: "pending", questionSet: set }); }
  }

  private sessionChanged(row: QuestionRow): boolean {
    if (!row.session) return false;
    const now = this.p.session(row.peer);
    return now !== "" && now !== row.session;
  }
  private cancelRow(set: string, reason: QuestionReason): void {
    const row = this.p.store.settle(set, "cancelled", reason, this.p.now());
    if (row) this.announceCancel(row, reason);
  }
  private announceCancel(row: QuestionRow, reason: QuestionReason): void {
    this.p.event({ type: "question", set: row.set, peer: row.peer, event: "cancelled", latencyMs: this.p.now() - row.created, reason, private: row.private });
    this.settleWait(row.set, { status: "cancelled", questionSet: row.set, reason });
  }
  private settleWait(set: string, result: AskResult): void {
    const waiter = this.waiters.get(set);
    if (!waiter) return;
    this.waiters.delete(set);
    clearTimeout(waiter.timer);
    waiter.detach();
    waiter.resolve(result);
  }
  /** Publish the envelope a row owes its peer, then mark it published. A refusal leaves the flag, and the sweep tries again. */
  private publishOwed(row: QuestionRow): void {
    try {
      this.p.publish(row.state === "answered" ? answerEnvelope(row) : expiryEnvelope(row, this.p.ttlMs()));
      this.p.store.published(row.set);
    } catch { /* the bus refused it (recovery hold, storage error): the row still owes it */ }
  }
}
