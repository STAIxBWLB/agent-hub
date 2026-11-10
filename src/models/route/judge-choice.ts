import { types } from "node:util";
import type { StageEvidence } from "./stage-evidence.ts";

export type HostChoicePurpose = "plan_execute_model" | "advisor_judge_model" | "escalation_judge_model";
export type HostPhase = "planning" | "executing";
const PACKET_BYTES = 1024;

function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Compose only checked R1 scalars; no unknown property or serialization hook is copied. */
export function hostChoicePacket(evidence: StageEvidence, purpose: HostChoicePurpose, phase: HostPhase | undefined, sensitive: boolean): string | undefined {
  try {
    if (purpose !== "plan_execute_model" && purpose !== "advisor_judge_model" && purpose !== "escalation_judge_model") return undefined;
    if (purpose === "plan_execute_model" ? phase !== "planning" && phase !== "executing" : phase !== undefined) return undefined;
    if (data(evidence, "schemaVersion") !== 1 || data(evidence, "kind") !== "stage-route-evidence") return undefined;
    const source = data(evidence, "dimensions");
    const severity = data(source, "severity"), spinning = data(source, "spinning"), exploring = data(source, "exploring"), productionIntensity = data(source, "productionIntensity");
    if (![severity, spinning, exploring, productionIntensity].every(unit)) return undefined;
    const dimensions = { severity, spinning, exploring, productionIntensity };
    let packet: string;
    if (sensitive) packet = JSON.stringify({ schemaVersion: 1, kind: "stage-route-evidence", dimensions });
    else {
      const turn = data(evidence, "turn"), incomplete = data(evidence, "incomplete"), signals = data(evidence, "signals"), scores = data(evidence, "scores");
      if (turn !== "user" && turn !== "tool_result" && turn !== "compaction" && turn !== "other" || typeof incomplete !== "boolean") return undefined;
      const results = data(signals, "results"), failures = data(signals, "failures"), repeatedFailures = data(signals, "repeatedFailures"), reads = data(signals, "reads"), mutations = data(signals, "mutations"), assistantTurns = data(signals, "assistantTurns");
      const tests = data(signals, "tests"), fault = data(signals, "fault"), efficient = data(scores, "efficient"), capable = data(scores, "capable");
      if (![results, failures, repeatedFailures, reads, mutations, assistantTurns].every(count) || !unit(efficient) || !unit(capable)
        || tests !== "none" && tests !== "pass" && tests !== "fail" && tests !== "unknown"
        || fault !== "none" && fault !== "reported" && fault !== "exception" && fault !== "critical") return undefined;
      const stage = { schemaVersion: 1, kind: "stage-route-evidence", turn, incomplete,
        signals: { results, failures, repeatedFailures, reads, mutations, assistantTurns, tests, fault }, dimensions, scores: { efficient, capable } };
      packet = JSON.stringify({ schemaVersion: 1, kind: "host-route-choice-evidence", purpose, ...(phase ? { phase } : {}), stage });
    }
    return Buffer.byteLength(packet, "utf8") <= PACKET_BYTES ? packet : undefined;
  } catch { return undefined; }
}

export interface ChoiceWindow<T> {
  result: Promise<T | undefined>;
  readonly commonSettled: Promise<void>;
  close(): Promise<T | undefined>;
}

/**
 * ponytail: common host preparation has no cancellation API. Closing races it, not joins it.
 * Only the separately started request is abortable/joined. Upgrade common ports to optional
 * abort/currentness support if an actual hang is observed; do not infer physical cancellation.
 */
export function startChoiceWindow<P, T>(ports: {
  signal: AbortSignal;
  prepare(closed: () => boolean): Promise<P | undefined>;
  request(prepared: P, signal: AbortSignal, closed: () => boolean): Promise<T | undefined>;
}): ChoiceWindow<T> {
  const controller = new AbortController();
  let closed = false, settled = false, value: T | undefined, failed = false, failure: unknown;
  let request: Promise<T | undefined> | undefined, closing: Promise<T | undefined> | undefined;
  let resolve!: (value: T | undefined) => void, reject!: (error: unknown) => void;
  const result = new Promise<T | undefined>((yes, no) => { resolve = yes; reject = no; });
  // A later await still observes rejection; this consumer prevents an unhandled gap during fallback.
  void result.catch(() => {});
  const done = (answer: T | undefined) => { if (!closed) { settled = true; value = answer; resolve(answer); } };
  const refuse = (error: unknown) => { if (!closed) { settled = true; failed = true; failure = error; reject(error); } };
  const close = (): Promise<T | undefined> => {
    if (closing) return closing;
    let complete!: (value: T | undefined) => void, fail!: (error: unknown) => void;
    closing = new Promise<T | undefined>((yes, no) => { complete = yes; fail = no; });
    void closing.catch(() => {});
    closed = true; controller.abort();
    ports.signal.removeEventListener("abort", abort);
    if (!settled) resolve(undefined);
    void (async () => {
      if (request) await request.catch(() => undefined);
      if (failed) throw failure;
      return value;
    })().then(complete, fail);
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  ports.signal.addEventListener("abort", abort, { once: true });
  let commonSettled: Promise<void>;
  if (ports.signal.aborted) { abort(); commonSettled = Promise.resolve(); }
  else {
    // Both late fulfillment and late rejection are consumed; neither can start HTTP after close.
    commonSettled = Promise.resolve().then(() => ports.prepare(() => closed)).then(prepared => {
      if (closed) return;
      if (prepared === undefined) { done(undefined); return; }
      let finish!: (value: T | undefined) => void, fail!: (error: unknown) => void;
      request = new Promise<T | undefined>((yes, no) => { finish = yes; fail = no; });
      void request.catch(() => {});
      // Publish the owned-task slot before invoking its port, including reentrant close/abort.
      try {
        void ports.request(prepared, controller.signal, () => closed).then(answer => {
          done(answer);
          finish(answer);
        }, error => {
          refuse(error);
          fail(error);
        });
      } catch (error) { refuse(error); fail(error); }
    }, refuse).catch(refuse);
  }
  return { result, close, commonSettled };
}

export async function runHostJudge<T, O>(ports: {
  parent: AbortSignal;
  timeoutMs: number;
  current(): void;
  common(signal: AbortSignal): Promise<boolean>;
  fallback(signal: AbortSignal): Promise<T | undefined>;
  observe(signal: AbortSignal): ChoiceWindow<O> | undefined;
}): Promise<{ value: T | undefined; observation: O | undefined }> {
  if (!Number.isSafeInteger(ports.timeoutMs) || ports.timeoutMs <= 0) throw new RangeError("invalid host judge deadline");
  const controller = new AbortController();
  let stop!: () => void;
  const stopped = new Promise<{ kind: "stop" }>(resolve => { stop = () => { controller.abort(); resolve({ kind: "stop" }); }; });
  const abort = () => stop();
  ports.parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(stop, ports.timeoutMs);
  let window: ChoiceWindow<O> | undefined;
  try {
    if (ports.parent.aborted) { stop(); return { value: undefined, observation: undefined }; }
    ports.current();
    const preparation = Promise.resolve().then(() => ports.common(controller.signal));
    void preparation.catch(() => {});
    const ready = await Promise.race([preparation.then(allowed => ({ kind: "ready" as const, allowed })), stopped]);
    if (ready.kind === "stop" || !ready.allowed) return { value: undefined, observation: undefined };
    ports.current();
    // Invoke the fallback port first. House quota admission runs before its first await;
    // this does not attest downstream provider/GPU generation order or a custom host's admission.
    const fallback = ports.fallback(controller.signal).then(value => ({ kind: "fallback" as const, value }));
    void fallback.catch(() => {});
    window = ports.observe(controller.signal);
    let observed = false;
    for (;;) {
      const event = await Promise.race([fallback, stopped, ...(!observed && window ? [window.result.then(value => ({ kind: "observation" as const, value }))] : [])]);
      if (event.kind === "observation") { observed = true; continue; }
      const observation = await window?.close();
      if (event.kind === "stop") return { value: undefined, observation: undefined };
      ports.current();
      return { value: event.value, observation };
    }
  } finally {
    clearTimeout(timer); ports.parent.removeEventListener("abort", abort);
    try { await window?.close(); }
    finally { controller.abort(); }
  }
}
