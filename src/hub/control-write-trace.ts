import { AsyncLocalStorage } from "node:async_hooks";

export const CONTROL_WRITE_KINDS = [
  "hub_task_propose", "hub_review", "hub_task_accept", "hub_task_done", "hub_task_decline", "hub_task_cancel",
  "hub_task_assign", "task_assign", "task_assign_checked", "task_unassign", "hub_delivery_done", "background",
] as const;
export type ControlWriteKind = typeof CONTROL_WRITE_KINDS[number];

export const CONTROL_WRITE_PHASES = [
  "client-send", "client-wait", "client-receive", "daemon-receive", "daemon-dispatch", "daemon-reply",
  "board-write", "queue-hook", "status-hook", "memory", "external", "snapshot",
] as const;
export type ControlWritePhase = typeof CONTROL_WRITE_PHASES[number];

export const CONTROL_WRITE_SLOW_MS = 1_000;
export const CONTROL_WRITE_LOOP_DELAY_MS = 250;
export const CONTROL_WRITE_SAMPLE_MS = 100;
export const CONTROL_WRITE_MAX_LINE_BYTES = 2_048;
export const CONTROL_WRITE_MAX_DURATION_MS = 86_400_000;

const MAX_ACTIVE_REQUESTS = 128;
const MAX_ACTIVE_SPANS = 256;
const MAX_RECENT_SPANS = 512;
const MAX_REQUEST_SPANS = 32;
const MAX_LOOP_SPANS = 8;
const MIN_SYNC_PREFIX_MS = 10;
const MAX_EMITS_PER_MINUTE = 60;
const RATE_LIMIT_MS = 1_000;
const RATE_KEYS = ["slow", "loop"] as const;

export interface ControlWriteMetadata { kind: ControlWriteKind; task?: number }
export type ControlWritePrivacy = () => boolean;
export type ControlWriteSink = (line: string) => void;
export interface ControlWriteTelemetryOptions {
  emit: ControlWriteSink;
  now?: () => number;
  maxActiveRequests?: number;
  maxActiveSpans?: number;
  maxRecentSpans?: number;
  maxRequestSpans?: number;
  rateLimitMs?: number;
}

interface PhaseTotal { phase: ControlWritePhase; durationMs: number }
interface RequestTrace {
  telemetry: ControlWriteTelemetry;
  metadata: ControlWriteMetadata;
  privacyCurrent: ControlWritePrivacy;
  logPrivacy: ControlWritePrivacy;
  startedAt: number;
  phases: Map<ControlWritePhase, number>;
  phaseOrder: ControlWritePhase[];
  spanCount: number;
  settled: boolean;
  privacySuppressed: boolean;
}
interface SpanTrace {
  id?: number;
  request: RequestTrace;
  phase: ControlWritePhase;
  startedAt: number;
  async: boolean;
}
interface SpanInterval {
  kind: ControlWriteKind;
  task?: number;
  phase: ControlWritePhase;
  startedAt: number;
  endedAt?: number;
  async: boolean;
  privacyCurrent: ControlWritePrivacy;
}

const currentTrace = new AsyncLocalStorage<RequestTrace>();

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validTaskId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function numericTaskId(value: unknown): number | undefined {
  return validTaskId(value) ? value : undefined;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

const OPERATIONS: Readonly<Record<string, ControlWriteKind>> = {
  hub_task_propose: "hub_task_propose", hub_review: "hub_review", hub_task_accept: "hub_task_accept",
  hub_task_done: "hub_task_done", hub_task_decline: "hub_task_decline", hub_task_cancel: "hub_task_cancel",
  hub_task_assign: "hub_task_assign", task_assign: "task_assign", task_assign_checked: "task_assign_checked", task_unassign: "task_unassign",
};

/** The control protocol contributes only a closed operation name and, when present, a positive task id. */
export function controlWriteMetadata(message: unknown): ControlWriteMetadata | undefined {
  if (!isObject(message)) return undefined;
  try {
    let kind: ControlWriteKind | undefined;
    let args: Record<string, unknown> | undefined;
    const type = ownValue(message, "t"), operation = ownValue(message, "op");
    if (type === "delivery_complete") kind = "hub_delivery_done";
    else if (type === "task" && typeof operation === "string") {
      kind = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : undefined;
      const rawArgs = ownValue(message, "args");
      args = isObject(rawArgs) ? rawArgs : undefined;
    }
    if (!kind) return undefined;
    const task = numericTaskId(args ? ownValue(args, "id") : undefined);
    return task === undefined ? { kind } : { kind, task };
  } catch { return undefined; }
}

function isPhase(value: string): value is ControlWritePhase {
  return (CONTROL_WRITE_PHASES as readonly string[]).includes(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  try { return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function"; }
  catch { return false; }
}

/** Add a bounded phase to the current request. With no request context, this is a no-op. */
export function controlWriteSpan<T>(phase: ControlWritePhase, fn: () => T): T {
  const request = currentTrace.getStore();
  if (!request || request.settled || request.privacySuppressed || !isPhase(phase)) return fn();
  const span = request.telemetry.beginSpan(request, phase);
  let result: T;
  try { result = fn(); }
  catch (error) { request.telemetry.finishSpan(span); throw error; }
  if (!isThenable(result)) { request.telemetry.finishSpan(span); return result; }
  span.async = true;
  request.telemetry.recordSyncPrefix(span);
  return Promise.resolve(result).then(
    value => { request.telemetry.finishSpan(span); return value; },
    error => { request.telemetry.finishSpan(span); throw error; },
  ) as T;
}

/** Bounded per-daemon control write and event-loop timing. Logs contain metadata, never request payloads. */
export class ControlWriteTelemetry {
  private readonly nowFn: () => number;
  private readonly maxActiveRequests: number;
  private readonly maxActiveSpans: number;
  private readonly maxRecentSpans: number;
  private readonly maxRequestSpans: number;
  private readonly rateLimitMs: number;
  private readonly requests = new Map<number, RequestTrace>();
  private readonly spans = new Map<number, SpanTrace>();
  private readonly recent: SpanInterval[] = [];
  private readonly emitted: number[] = [];
  private readonly lastEmit = new Map<typeof RATE_KEYS[number], number>();
  private nextRequestId = 1;
  private nextSpanId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextSampleAt: number | undefined;
  private lastNow = 0;
  private stopped = false;
  private completedRequests = 0;
  private slowRequests = 0;
  private blockedLoopSamples = 0;
  private droppedActive = 0;
  private droppedSpans = 0;
  private droppedRecent = 0;
  private droppedLogs = 0;
  private droppedMetadata = 0;
  private clockFailures = 0;

  constructor(private readonly options: ControlWriteTelemetryOptions) {
    this.nowFn = options.now ?? (() => performance.now());
    this.maxActiveRequests = options.maxActiveRequests ?? MAX_ACTIVE_REQUESTS;
    this.maxActiveSpans = options.maxActiveSpans ?? MAX_ACTIVE_SPANS;
    this.maxRecentSpans = options.maxRecentSpans ?? MAX_RECENT_SPANS;
    this.maxRequestSpans = options.maxRequestSpans ?? MAX_REQUEST_SPANS;
    this.rateLimitMs = options.rateLimitMs ?? RATE_LIMIT_MS;
    if (![this.maxActiveRequests, this.maxActiveSpans, this.maxRecentSpans].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(this.maxRequestSpans) || this.maxRequestSpans < 1 || this.maxRequestSpans > MAX_REQUEST_SPANS
      || !Number.isSafeInteger(this.rateLimitMs) || this.rateLimitMs < 0 || this.rateLimitMs > RATE_LIMIT_MS
      || this.maxActiveRequests > MAX_ACTIVE_REQUESTS || this.maxActiveSpans > MAX_ACTIVE_SPANS || this.maxRecentSpans > MAX_RECENT_SPANS) throw new Error("invalid control write trace bounds");
  }

  /** Wrap a synchronous or asynchronous operation without changing its result or exception. */
  run<T>(metadata: ControlWriteMetadata, privacyCurrent: ControlWritePrivacy, fn: () => T): T {
    if (this.stopped) return fn();
    const safeMetadata = this.safeMetadata(metadata);
    if (!safeMetadata || typeof privacyCurrent !== "function") {
      this.droppedMetadata++;
      return fn();
    }
    if (!this.privateNow(privacyCurrent)) return fn();
    if (this.requests.size >= this.maxActiveRequests) { this.droppedActive++; return fn(); }
    const now = this.readNow();
    const request: RequestTrace = {
      telemetry: this, metadata: safeMetadata, privacyCurrent,
      startedAt: now, phases: new Map(), phaseOrder: [], spanCount: 0, settled: false, privacySuppressed: false,
      logPrivacy: () => false,
    };
    request.logPrivacy = () => !request.privacySuppressed && this.privateNow(request.privacyCurrent);
    const id = this.nextRequestId++;
    this.requests.set(id, request);
    let result: T;
    try { result = currentTrace.run(request, fn); }
    catch (error) { this.finishRequest(id, request, "threw"); throw error; }
    if (!isThenable(result)) { this.finishRequest(id, request, "returned"); return result; }
    return Promise.resolve(result).then(
      value => { this.finishRequest(id, request, "returned"); return value; },
      error => { this.finishRequest(id, request, "threw"); throw error; },
    ) as T;
  }

  /** Observe a daemon boundary; work outside a control request is labelled as background. */
  observe<T>(phase: ControlWritePhase, privacyCurrent: ControlWritePrivacy, fn: () => T): T {
    const current = currentTrace.getStore();
    if (current?.telemetry === this && !current.settled) {
      if (!this.privateNow(privacyCurrent)) current.privacySuppressed = true;
      return controlWriteSpan(phase, fn);
    }
    return this.run({ kind: "background" }, privacyCurrent, () => controlWriteSpan(phase, fn));
  }

  /** Start one unref'd event-loop delay probe for the daemon. */
  start(): void {
    if (this.stopped) this.stopped = false;
    if (this.timer) return;
    this.nextSampleAt = this.readNow() + CONTROL_WRITE_SAMPLE_MS;
    this.timer = setInterval(() => this.sample(), CONTROL_WRITE_SAMPLE_MS);
    this.timer.unref?.();
  }

  /** Stop the probe and suppress later diagnostics from this daemon instance. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.nextSampleAt = undefined;
  }

  /** Deterministic probe seam used by tests; a missing cause remains explicitly unknown. */
  sample(): void {
    if (this.stopped) return;
    const now = this.readNow(), expected = this.nextSampleAt ?? now;
    this.nextSampleAt = now + CONTROL_WRITE_SAMPLE_MS;
    const delayMs = Math.max(0, now - expected);
    if (delayMs < CONTROL_WRITE_LOOP_DELAY_MS) return;
    this.blockedLoopSamples++;
    const from = expected;
    const observed: { kind: ControlWriteKind; task?: number; phase: ControlWritePhase; durationMs: number; open?: true; privacyCurrent: ControlWritePrivacy }[] = [];
    for (const interval of this.recent) {
      if (interval.async || interval.endedAt === undefined || interval.startedAt >= now || interval.endedAt < from) continue;
      observed.push({ kind: interval.kind, ...(interval.task === undefined ? {} : { task: interval.task }), phase: interval.phase, durationMs: this.roundMs(interval.endedAt - interval.startedAt), privacyCurrent: interval.privacyCurrent });
    }
    for (const span of this.spans.values()) {
      if (!span.async || span.startedAt >= now) continue;
      observed.push({ kind: span.request.metadata.kind, ...(span.request.metadata.task === undefined ? {} : { task: span.request.metadata.task }), phase: span.phase, durationMs: this.roundMs(now - span.startedAt), open: true,
        privacyCurrent: span.request.logPrivacy });
    }
    const unique = new Map<string, (typeof observed)[number]>();
    for (const row of observed.sort((a, b) => b.durationMs - a.durationMs)) {
      const key = `${row.kind}:${row.task ?? ""}:${row.phase}:${row.open === true}`;
      if (!unique.has(key)) unique.set(key, row);
    }
    const selected = [...unique.values()].slice(0, MAX_LOOP_SPANS);
    const spans = selected.map(({ kind, task, phase, durationMs, open }) => ({ kind, ...(task === undefined ? {} : { task }), phase, durationMs, ...(open ? { open: true as const } : {}) }));
    const guards = [...new Set(selected.map(row => row.privacyCurrent))];
    const attribution = selected.some(row => row.open !== true) ? "sync_overlap_observed" : selected.length ? "open_async_wait" : "unknown";
    this.emit("loop", {
      type: "control_write_loop_delay", delayMs: this.roundMs(delayMs), attribution, spans,
    }, () => guards.every(guard => this.privateNow(guard)));
  }

  /** Flat numeric counters for the authenticated full-status projection. */
  status(): Record<string, number> {
    return {
      active: this.requests.size,
      activeSpans: this.spans.size,
      completedRequests: this.completedRequests,
      slowRequests: this.slowRequests,
      blockedLoopSamples: this.blockedLoopSamples,
      recentSpans: this.recent.length,
      droppedActive: this.droppedActive,
      droppedSpans: this.droppedSpans,
      droppedRecent: this.droppedRecent,
      droppedLogs: this.droppedLogs,
      droppedMetadata: this.droppedMetadata,
      clockFailures: this.clockFailures,
    };
  }

  beginSpan(request: RequestTrace, phase: ControlWritePhase): SpanTrace {
    const span: SpanTrace = { request, phase, startedAt: this.readNow(), async: false };
    if (this.spans.size >= this.maxActiveSpans || request.spanCount >= this.maxRequestSpans) { this.droppedSpans++; return span; }
    request.spanCount++;
    span.id = this.nextSpanId++;
    this.spans.set(span.id, span);
    return span;
  }

  finishSpan(span: SpanTrace): void {
    if (span.id === undefined || this.spans.get(span.id) !== span || span.request.settled) return;
    const endedAt = this.readNow();
    this.spans.delete(span.id);
    const durationMs = Math.max(0, endedAt - span.startedAt);
    const request = span.request;
    const prior = request.phases.get(span.phase) ?? 0;
    if (!request.phaseOrder.includes(span.phase)) request.phaseOrder.push(span.phase);
    request.phases.set(span.phase, prior + durationMs);
    if (!span.async) {
      this.recent.push({ kind: request.metadata.kind, ...(request.metadata.task === undefined ? {} : { task: request.metadata.task }), phase: span.phase, startedAt: span.startedAt, endedAt, async: false, privacyCurrent: request.logPrivacy });
      while (this.recent.length > this.maxRecentSpans) { this.recent.shift(); this.droppedRecent++; }
    }
  }

  /** Preserve a long synchronous prelude inside an async function for the delayed loop probe. */
  recordSyncPrefix(span: SpanTrace): void {
    if (span.id === undefined) return;
    const endedAt = this.readNow();
    if (endedAt - span.startedAt < MIN_SYNC_PREFIX_MS) return;
    const request = span.request;
    this.recent.push({ kind: request.metadata.kind, ...(request.metadata.task === undefined ? {} : { task: request.metadata.task }), phase: span.phase, startedAt: span.startedAt, endedAt, async: false, privacyCurrent: request.logPrivacy });
    while (this.recent.length > this.maxRecentSpans) { this.recent.shift(); this.droppedRecent++; }
  }

  private finishRequest(id: number, request: RequestTrace, outcome: "returned" | "threw"): void {
    if (!this.requests.delete(id)) return;
    request.settled = true;
    for (const [spanId, span] of this.spans) if (span.request === request) { this.spans.delete(spanId); this.droppedSpans++; }
    this.completedRequests++;
    const durationMs = this.roundMs(this.readNow() - request.startedAt);
    if (durationMs < CONTROL_WRITE_SLOW_MS) return;
    this.slowRequests++;
    const phases: PhaseTotal[] = request.phaseOrder.map(phase => ({ phase, durationMs: this.roundMs(request.phases.get(phase) ?? 0) }));
    this.emit("slow", {
      type: "control_write_slow", kind: request.metadata.kind, ...(request.metadata.task === undefined ? {} : { task: request.metadata.task }),
      durationMs, outcome, phases: phases.slice(0, MAX_LOOP_SPANS), ...(phases.length > MAX_LOOP_SPANS ? { truncated: true } : {}),
    }, request.logPrivacy);
  }

  private emit(key: typeof RATE_KEYS[number], value: Record<string, unknown>, privacyCurrent: ControlWritePrivacy): void {
    if (this.stopped || !this.privateNow(privacyCurrent)) return;
    const now = this.readNow(), last = this.lastEmit.get(key);
    if (last !== undefined && now - last < this.rateLimitMs) { this.droppedLogs++; return; }
    while (this.emitted.length && now - this.emitted[0]! >= 60_000) this.emitted.shift();
    if (this.emitted.length >= MAX_EMITS_PER_MINUTE) { this.droppedLogs++; return; }
    let line: string;
    try { line = JSON.stringify(value); } catch { this.droppedLogs++; return; }
    if (Buffer.byteLength(line) > CONTROL_WRITE_MAX_LINE_BYTES) {
      const minimal = value.type === "control_write_loop_delay"
        ? { type: "control_write_loop_delay", delayMs: typeof value.delayMs === "number" ? value.delayMs : 0, attribution: "unknown", spans: [], truncated: true }
        : { type: "control_write_slow", kind: value.kind, ...(value.task === undefined ? {} : { task: value.task }), durationMs: value.durationMs, outcome: value.outcome, phases: [], truncated: true };
      line = JSON.stringify(minimal);
      if (Buffer.byteLength(line) > CONTROL_WRITE_MAX_LINE_BYTES) { this.droppedLogs++; return; }
    }
    this.lastEmit.set(key, now);
    this.emitted.push(now);
    try { this.options.emit(line); } catch { this.droppedLogs++; }
  }

  private privateNow(guard: ControlWritePrivacy): boolean {
    try { return guard() === true; } catch { return false; }
  }

  private safeMetadata(metadata: unknown): ControlWriteMetadata | undefined {
    if (!isObject(metadata)) return undefined;
    try {
      const kind = ownValue(metadata, "kind"), task = ownValue(metadata, "task");
      if (typeof kind !== "string" || !(CONTROL_WRITE_KINDS as readonly string[]).includes(kind) || task !== undefined && !validTaskId(task)) return undefined;
      return { kind: kind as ControlWriteKind, ...(task === undefined ? {} : { task }) };
    } catch { return undefined; }
  }

  private readNow(): number {
    let value: number;
    try { value = this.nowFn(); } catch { this.clockFailures++; return this.lastNow; }
    if (!Number.isFinite(value) || value < this.lastNow) { this.clockFailures++; return this.lastNow; }
    this.lastNow = value;
    return value;
  }

  private roundMs(value: number): number {
    const bounded = Number.isFinite(value) ? Math.min(CONTROL_WRITE_MAX_DURATION_MS, Math.max(0, value)) : CONTROL_WRITE_MAX_DURATION_MS;
    return Math.round(bounded * 10) / 10;
  }
}
