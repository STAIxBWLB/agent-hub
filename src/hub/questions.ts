import { randomUUID } from "node:crypto";
import { openHubDatabase, type Database } from "./db-schema.ts";

/**
 * #1053 T2: structured questions a peer asks the person. A row is the one record that the waiting tool call, the late-answer envelope and the inbox all read.
 * This module knows the row shape and its state machine only: it never learns what `hub_ask` is, never touches a bus, a socket or a timer, and never logs.
 * Question and answer text are stored here and nowhere else (hub.db, like a task title): the daemon keeps them out of logs, events and memory capture.
 */

export const QUESTION_STATES = ["open", "answered", "superseded", "cancelled", "expired"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];
/** Why a row left `open` without an answer; a closed list, so a reason can be shown and counted without any text. */
export const QUESTION_REASONS = ["superseded", "stopped", "turn_aborted", "session_changed", "expired", "unattended"] as const;
export type QuestionReason = (typeof QUESTION_REASONS)[number];
/** Where an answer came from. `acon` is the plugin action of T5; the others are the console's own surfaces. */
export const QUESTION_SURFACES = ["terminal", "console", "dashboard", "acon"] as const;
export type QuestionSurface = (typeof QUESTION_SURFACES)[number];

export const MAX_QUESTIONS = 4, MAX_OPTIONS = 8, MIN_OPTIONS = 2;
export const MAX_PROMPT = 500, MAX_LABEL = 80, MAX_DESCRIPTION = 240, MAX_OTHER = 500;
/** Bounds on rows that can wait at once: one peer cannot fill the inbox, and the whole table stays small. */
export const MAX_OPEN_PER_PEER = 8, MAX_OPEN_TOTAL = 64;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const QUESTION_SET = /^qs-[a-f0-9]{12}$/;
/** Controls other than tab and newline: they never reach a person's screen or another agent's prompt. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

export interface AskOption { id: string; label: string; description?: string }
export interface AskQuestion { id: string; prompt: string; options: AskOption[]; multi?: boolean; allowOther?: boolean }
export interface QuestionAnswer { questionId: string; optionIds: string[]; other?: string }
export interface AskInput { questions: AskQuestion[]; task?: number }

export interface QuestionRow {
  set: string;
  peer: string;
  /** The peer's native session when it asked; "" when the adapter reports none (unknown never cancels). */
  session: string;
  task?: number;
  /** Asked in a PII turn or about a PII task: surfaces show a stub title and the late envelope is private. */
  private: boolean;
  state: QuestionState;
  created: number;
  settled?: number;
  reason?: QuestionReason;
  surface?: QuestionSurface;
  questions: AskQuestion[];
  answers?: QuestionAnswer[];
  /** 0 nothing to publish, 1 a hub envelope (late answer or expiry notice) is owed to the peer, 2 it was published. */
  envelope: 0 | 1 | 2;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const length = (text: string): number => Array.from(text).length;
const closed = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
/** Text a person reads: no controls, trimmed, bounded by code points. Messages name the field, never the value. */
function text(value: unknown, field: string, max: number, optional = false): Parsed<string | undefined> {
  if (value === undefined && optional) return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return fail(`${field} must not be empty`);
  if (length(trimmed) > max) return fail(`${field} is longer than ${max} characters`);
  if (CONTROL.test(trimmed)) return fail(`${field} holds a control character`);
  return { ok: true, value: trimmed };
}

/** The `hub_ask` input, closed and bounded exactly as the spec's Design section. Never echoes a value. */
export function parseAsk(input: unknown): Parsed<AskInput> {
  if (!plain(input) || !closed(input, ["questions", "task"])) return fail("hub_ask takes questions and an optional task");
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) return fail(`questions must hold 1 to ${MAX_QUESTIONS} questions`);
  let task: number | undefined;
  if (input.task !== undefined) {
    if (typeof input.task !== "number" || !Number.isSafeInteger(input.task) || input.task < 1) return fail("task must be a positive task number");
    task = input.task;
  }
  const questions: AskQuestion[] = [], seen = new Set<string>();
  for (const [index, raw] of input.questions.entries()) {
    const at = `questions[${index}]`;
    if (!plain(raw) || !closed(raw, ["id", "prompt", "options", "multi", "allowOther"])) return fail(`${at} takes id, prompt, options, multi and allowOther`);
    if (typeof raw.id !== "string" || !ID.test(raw.id)) return fail(`${at}.id must be 1 to 64 characters of letters, digits, dot, dash or underscore`);
    if (seen.has(raw.id)) return fail(`${at}.id repeats an earlier question id`);
    seen.add(raw.id);
    const prompt = text(raw.prompt, `${at}.prompt`, MAX_PROMPT);
    if (!prompt.ok) return prompt;
    if (!Array.isArray(raw.options) || raw.options.length < MIN_OPTIONS || raw.options.length > MAX_OPTIONS) return fail(`${at}.options must hold ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
    if (raw.multi !== undefined && typeof raw.multi !== "boolean") return fail(`${at}.multi must be a boolean`);
    if (raw.allowOther !== undefined && typeof raw.allowOther !== "boolean") return fail(`${at}.allowOther must be a boolean`);
    const options: AskOption[] = [], ids = new Set<string>();
    for (const [position, option] of raw.options.entries()) {
      const where = `${at}.options[${position}]`;
      if (!plain(option) || !closed(option, ["id", "label", "description"])) return fail(`${where} takes id, label and description`);
      if (typeof option.id !== "string" || !ID.test(option.id)) return fail(`${where}.id must be 1 to 64 characters of letters, digits, dot, dash or underscore`);
      if (ids.has(option.id)) return fail(`${where}.id repeats an earlier option id`);
      ids.add(option.id);
      const label = text(option.label, `${where}.label`, MAX_LABEL);
      if (!label.ok) return label;
      const description = text(option.description, `${where}.description`, MAX_DESCRIPTION, true);
      if (!description.ok) return description;
      options.push({ id: option.id, label: label.value!, ...(description.value !== undefined ? { description: description.value } : {}) });
    }
    questions.push({ id: raw.id, prompt: prompt.value!, options, ...(raw.multi === true ? { multi: true } : {}), ...(raw.allowOther === true ? { allowOther: true } : {}) });
  }
  return { ok: true, value: { questions, ...(task !== undefined ? { task } : {}) } };
}

/**
 * A person's answers against the stored row: every question answered once, only known option ids, one option unless `multi`, free text only where
 * `allowOther` and at most 500 characters. Accepts the array form (`[{ questionId, optionIds, other? }]`, the tool result's) and the record form acon
 * submits (`{ [questionId]: { selected, other? } }`). A reason names a question by position, never its text or the offered value.
 */
export function validateAnswers(questions: readonly AskQuestion[], input: unknown): Parsed<QuestionAnswer[]> {
  let rows: unknown[];
  // The record form is rewritten into the array form; a malformed record entry is remembered by position, never by a marker key a caller could also send.
  const malformed = new Set<number>();
  if (Array.isArray(input)) rows = input;
  else if (plain(input)) rows = Object.entries(input).map(([questionId, value], position) => {
    if (!plain(value) || !closed(value, ["selected", "other"])) { malformed.add(position); return { questionId }; }
    return { questionId, optionIds: value.selected, ...(value.other !== undefined ? { other: value.other } : {}) };
  });
  else return fail("answers must be a list or a map of question ids");
  if (rows.length > MAX_QUESTIONS) return fail("answers name more questions than were asked");
  const byId = new Map(questions.map((question, index) => [question.id, { question, index }])), answers = new Map<string, QuestionAnswer>();
  for (const [position, raw] of rows.entries()) {
    if (malformed.has(position) || !plain(raw) || !closed(raw, ["questionId", "optionIds", "other"]) || typeof raw.questionId !== "string") return fail(`answers[${position}] takes questionId, optionIds and other`);
    const known = byId.get(raw.questionId);
    if (!known) return fail(`answers[${position}] names a question that was not asked`);
    if (answers.has(raw.questionId)) return fail(`answers[${position}] answers question ${known.index + 1} twice`);
    const { question, index } = known, label = `question ${index + 1}`;
    const chosen = raw.optionIds === undefined ? [] : raw.optionIds;
    if (!Array.isArray(chosen) || chosen.some(id => typeof id !== "string")) return fail(`${label}: options must be a list of option ids`);
    if (new Set(chosen).size !== chosen.length) return fail(`${label}: an option is chosen twice`);
    const offered = new Set(question.options.map(option => option.id));
    if (chosen.some(id => !offered.has(id as string))) return fail(`${label}: an option id was not offered`);
    if (chosen.length > 1 && question.multi !== true) return fail(`${label}: takes one option`);
    let other: string | undefined;
    if (raw.other !== undefined) {
      if (question.allowOther !== true) return fail(`${label}: does not take other text`);
      const parsed = text(raw.other, `${label}: other text`, MAX_OTHER);
      if (!parsed.ok) return parsed;
      other = parsed.value;
    }
    if (!chosen.length && other === undefined) return fail(`${label}: choose an option${question.allowOther === true ? " or give other text" : ""}`);
    answers.set(raw.questionId, { questionId: raw.questionId, optionIds: chosen as string[], ...(other !== undefined ? { other } : {}) });
  }
  const missing = questions.findIndex(question => !answers.has(question.id));
  if (missing >= 0) return fail(`question ${missing + 1} has no answer`);
  return { ok: true, value: questions.map(question => answers.get(question.id)!) };
}

interface RawRow {
  set_id: string; peer: string; session: string; task: number | null; private: number; state: string; created: number; settled: number | null; reason: string | null;
  surface: string | null; questions: string; answers: string | null; envelope: number;
}
function rowOf(raw: RawRow): QuestionRow {
  return {
    set: raw.set_id, peer: raw.peer, session: raw.session, ...(raw.task !== null ? { task: raw.task } : {}), private: raw.private === 1, state: raw.state as QuestionState,
    created: raw.created, ...(raw.settled !== null ? { settled: raw.settled } : {}), ...(raw.reason !== null ? { reason: raw.reason as QuestionReason } : {}),
    ...(raw.surface !== null ? { surface: raw.surface as QuestionSurface } : {}), questions: JSON.parse(raw.questions) as AskQuestion[],
    ...(raw.answers !== null ? { answers: JSON.parse(raw.answers) as QuestionAnswer[] } : {}), envelope: raw.envelope as 0 | 1 | 2,
  };
}

export type AnswerResult = { ok: true; row: QuestionRow } | { ok: false; error: string; state?: QuestionState };

/** `questions` in hub.db. Additive table (no format bump): an older hub ignores it, which `Daemon` guards for recovery with the `questions` feature. */
export class QuestionStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = openHubDatabase(dbPath, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS questions (
      set_id TEXT PRIMARY KEY, peer TEXT NOT NULL, session TEXT NOT NULL DEFAULT '', task INTEGER, private INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('open','answered','superseded','cancelled','expired')), created INTEGER NOT NULL, settled INTEGER, reason TEXT, surface TEXT,
      questions TEXT NOT NULL, answers TEXT, envelope INTEGER NOT NULL DEFAULT 0)`);
    this.db.run("CREATE INDEX IF NOT EXISTS questions_by_state ON questions(state, peer)");
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  get(set: string): QuestionRow | undefined {
    if (typeof set !== "string" || !QUESTION_SET.test(set)) return undefined;
    const raw = this.db.query("SELECT * FROM questions WHERE set_id = ?").get(set) as RawRow | null;
    return raw ? rowOf(raw) : undefined;
  }
  /** Oldest first, bounded. */
  list(filter: { state?: QuestionState; peer?: string } = {}, limit = 200): QuestionRow[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (filter.state) { where.push("state = ?"); args.push(filter.state); }
    if (filter.peer) { where.push("peer = ?"); args.push(filter.peer); }
    return (this.db.query(`SELECT * FROM questions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created, set_id LIMIT ?`).all(...args, limit) as RawRow[]).map(rowOf);
  }
  openCount(peer?: string): number {
    const row = (peer === undefined ? this.db.query("SELECT COUNT(*) AS n FROM questions WHERE state = 'open'").get() : this.db.query("SELECT COUNT(*) AS n FROM questions WHERE state = 'open' AND peer = ?").get(peer)) as { n: number };
    return row.n;
  }
  /** Any row an older daemon would silently orphan: an open question, or an envelope still owed. */
  hasPending(): boolean {
    return (this.db.query("SELECT EXISTS(SELECT 1 FROM questions WHERE state = 'open' OR envelope = 1) AS present").get() as { present: number }).present === 1;
  }

  /** A new open row. Refuses past the per-peer and total bounds, so a loop cannot flood the inbox. */
  ask(input: { peer: string; session: string; task?: number; private: boolean; questions: AskQuestion[] }, now: number): QuestionRow | { error: string } {
    if (this.openCount(input.peer) >= MAX_OPEN_PER_PEER) return { error: `${MAX_OPEN_PER_PEER} questions from this peer are already waiting for the person; wait for an answer before asking more` };
    if (this.openCount() >= MAX_OPEN_TOTAL) return { error: "too many questions are waiting for the person; try again later" };
    const set = `qs-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.query("INSERT INTO questions(set_id, peer, session, task, private, state, created, questions) VALUES(?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(set, input.peer, input.session, input.task ?? null, input.private ? 1 : 0, now, JSON.stringify(input.questions));
    return this.get(set)!;
  }

  /**
   * The one terminal transition: a compare-and-set on `state = 'open'`. Of any number of concurrent callers (a person's answer, a stop, an expiry) exactly one
   * sees `changes === 1`; every other gets the row's real terminal state back. `late` says no waiting call will carry the result, so an envelope is owed.
   */
  answer(set: string, raw: unknown, surface: QuestionSurface, now: number, late: boolean): AnswerResult {
    const row = this.get(set);
    if (!row) return { ok: false, error: "no such question" };
    if (row.state !== "open") return { ok: false, error: `question is already ${row.state}`, state: row.state };
    const parsed = validateAnswers(row.questions, raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const result = this.db.query("UPDATE questions SET state = 'answered', settled = ?, surface = ?, answers = ?, envelope = ? WHERE set_id = ? AND state = 'open'")
      .run(now, surface, JSON.stringify(parsed.value), late ? 1 : 0, set);
    if (result.changes !== 1) { const now_ = this.get(set); return { ok: false, error: `question is already ${now_?.state ?? "settled"}`, ...(now_ ? { state: now_.state } : {}) }; }
    return { ok: true, row: this.get(set)! };
  }
  /** Leave `open` for `superseded`, `cancelled` or `expired`. Returns the row only when this call made the transition. */
  settle(set: string, state: "superseded" | "cancelled" | "expired", reason: QuestionReason, now: number, notify = false): QuestionRow | undefined {
    if (typeof set !== "string" || !QUESTION_SET.test(set)) return undefined;
    const result = this.db.query("UPDATE questions SET state = ?, settled = ?, reason = ?, envelope = ? WHERE set_id = ? AND state = 'open'").run(state, now, reason, notify ? 1 : 0, set);
    return result.changes === 1 ? this.get(set) : undefined;
  }
  /** Every open row of one peer, each through `settle`; the rows this call settled. */
  settleFor(peer: string, state: "superseded" | "cancelled", reason: QuestionReason, now: number, only?: (row: QuestionRow) => boolean): QuestionRow[] {
    const settled: QuestionRow[] = [];
    for (const row of this.list({ state: "open", peer }, MAX_OPEN_PER_PEER * 4)) {
      if (only && !only(row)) continue;
      const done = this.settle(row.set, state, reason, now);
      if (done) settled.push(done);
    }
    return settled;
  }
  /** Open rows older than the ttl become `expired` with a notice owed; the caller marks it published when a waiting call carried the result instead. */
  expireDue(now: number, ttlMs: number): QuestionRow[] {
    const expired: QuestionRow[] = [];
    for (const row of this.list({ state: "open" }, MAX_OPEN_TOTAL * 2)) if (now - row.created >= ttlMs) { const done = this.settle(row.set, "expired", "expired", now, true); if (done) expired.push(done); }
    return expired;
  }
  /** Rows whose envelope is owed (a late answer or an expiry notice that a crash or an offline peer kept from going out). */
  owed(): QuestionRow[] {
    return (this.db.query("SELECT * FROM questions WHERE envelope = 1 ORDER BY settled, set_id LIMIT 200").all() as RawRow[]).map(rowOf);
  }
  published(set: string): void { this.db.query("UPDATE questions SET envelope = 2 WHERE set_id = ? AND envelope = 1").run(set); }
  /** Settled rows older than `keepMs` go; open and owed rows never do. */
  prune(now: number, keepMs: number): number {
    return this.db.query("DELETE FROM questions WHERE state != 'open' AND envelope != 1 AND settled IS NOT NULL AND settled < ?").run(now - keepMs).changes;
  }
}
