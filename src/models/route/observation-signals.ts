import { createHash } from "node:crypto";
import { types } from "node:util";
import { captureJudgeConversation, type JudgeMessage } from "./conversation-view.ts";
import { captureStageInput, estimateStageInputTokens } from "./stage-input.ts";
import { diagnoseStageResult, type StageDiagnostic } from "./stage-diagnostics.ts";

export interface ToolObservation {
  name: string;
  command?: string;
  resultText?: string;
  isError?: boolean;
  source?: string;
}
export interface ObservationOutcome {
  severity: 0 | 0.3 | 0.7 | 1;
  tests: "pass" | "fail" | "none";
  failureDigests: readonly string[];
}
type Severity = ObservationOutcome["severity"];
export interface RetainedObservationFailure { digest: string; operation?: string | null }
interface Failure { digest: string; test: boolean; severity: Severity; observation: number; operation: string | null }
interface ResultFacts {
  operation: string | null;
  explicitCommand: boolean;
  readOnly: boolean;
  nativeError: boolean;
  assertionDiagnostic: boolean;
  testInvocation: boolean;
  testMention: boolean;
  diagnostic: StageDiagnostic;
  text: string;
}
const WIRE_BYTES = 2_000_000;
const OPERATION_BYTES = 256;
const unavailable = Symbol("observation unavailable");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const testName = /\b(?:test|tests|spec|specs|pytest|vitest|jest|cargo test|go test)\b|^(?:run_tests|run_test|unittest)$/iu;
// Local lexical evidence only, never an executable/exit-status attestation.
const testCommand = /\b(?:bun test|pytest|vitest|jest|cargo test|go test|npm test|pnpm test|yarn test)\b|(?:^|[\s;&|])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test(?:$|[\s:])|python(?:3(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)\b|(?:make|just)\s+test\b)/iu;

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw unavailable;
  return descriptor?.value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function dataArray(value: unknown): value is unknown[] {
  return !!value && typeof value === "object" && !types.isProxy(value) && Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= WIRE_BYTES && Buffer.byteLength(value) <= WIRE_BYTES;
}
function command(argumentsText: string): { value?: string; explicit: boolean } {
  try {
    const args: unknown = JSON.parse(argumentsText);
    if (!plain(args)) return { explicit: true };
    const value = own(args, "command");
    return { explicit: Object.hasOwn(args, "command"), ...(typeof value === "string" ? { value } : {}) };
  } catch { return { explicit: true }; }
}
function facts(name: string, value: string, nativeError: boolean, invocation?: string, readFamily = false,
  explicitCommand = invocation !== undefined): ResultFacts {
  const readOnly = readFamily || /^(?:read|read_file|readfile|glob|grep|search|list|ls|lookup)(?:_|$)/i.test(name)
    || name.toLowerCase() === "text_editor" && invocation === "view";
  return {
    operation: name && Buffer.byteLength(name) <= OPERATION_BYTES ? name : null, explicitCommand,
    readOnly, nativeError, text: value,
    assertionDiagnostic: /\bassertion(?:error| failed)\b/i.test(value),
    testInvocation: testName.test(name) || invocation !== undefined && testCommand.test(invocation),
    testMention: /\btests?\b|\bassertion(?:error| failed)\b/i.test(value),
    diagnostic: diagnoseStageResult({ text: value, error: nativeError, family: readOnly ? "read" : "other", associated: true }),
  };
}

/** Inspect the entire validated batch; the recent R1 window supplies no completeness claim. */
function associatedResults(messages: readonly JudgeMessage[]): ResultFacts[] | undefined {
  let pending: { calls: Map<string, NonNullable<JudgeMessage["tool_calls"]>[number]>; seen: Set<string> } | undefined;
  const results: ResultFacts[] = [];
  const complete = (): boolean => !pending || pending.calls.size === pending.seen.size;
  for (const message of messages) {
    if (message.role === "assistant") {
      if (!complete()) return undefined;
      pending = { calls: new Map(), seen: new Set() };
      for (const call of message.tool_calls ?? []) {
        if (!call.id || pending.calls.has(call.id)) return undefined;
        pending.calls.set(call.id, call);
      }
    } else if (message.role === "tool") {
      const id = message.tool_call_id;
      if (!id || !pending || pending.seen.has(id) || typeof message.content !== "string") return undefined;
      const call = pending.calls.get(id);
      if (!call) return undefined;
      // Reuse the owned R1 identity/family oracle on one already-associated pair.
      // Use the FULL original result for diagnostics, not the oracle's bounded text projection.
      const pair = captureStageInput([{ role: "assistant", content: null, tool_calls: [call] }, message]);
      const result = pair?.results[0];
      if (!result?.associated) return undefined;
      pending.seen.add(id);
      const invocation = command(call.function.arguments);
      results.push(facts(call.function.name, message.content, message.is_error === true || message.isError === true,
        invocation.value, result.family === "read", invocation.explicit));
    } else if (message.role === "user") {
      if (!complete()) return undefined;
      pending = undefined;
    }
  }
  return complete() ? results : undefined;
}

/** Separate a reported operation failure from a test-count report in the same result. */
function otherReportedDiagnostic(value: string): StageDiagnostic {
  const remainder = value
    .replace(/\b\d+\s+(?:tests?\s+)?(?:fail(?:ed|ures)?|pass(?:ed)?)\b/gi, "")
    .replace(/\btests?\s+(?:failed|passed|pass|failures?)\b/gi, "");
  return diagnoseStageResult({ text: remainder, error: false, family: "other", associated: true });
}
function fold(results: readonly ResultFacts[], prior: readonly RetainedObservationFailure[] = []): {
  outcome: ObservationOutcome; failures: Failure[]; retained: RetainedObservationFailure[];
} {
  let failures: Failure[] = [], passed = false;
  let retained = [...prior];
  for (const [observation, result] of results.entries()) {
    if (result.readOnly && !result.nativeError) continue;
    const diagnostic = result.diagnostic, context = result.testInvocation || result.testMention;
    const inherited = !context && !result.explicitCommand && result.operation !== null
      && (retained.some(failure => failure.operation === result.operation)
        || failures.some(failure => failure.test && failure.operation === result.operation));
    const genuinePass = (context || inherited) && !result.nativeError && diagnostic.fault === "none" && diagnostic.test === "pass";
    if (genuinePass) {
      failures = failures.filter(failure => !failure.test || inherited && failure.operation !== result.operation);
      retained = retained.filter(failure => failure.operation === undefined || inherited && failure.operation !== result.operation);
      passed = true;
    }
    if (diagnostic.fault === "none" || diagnostic.fingerprint === undefined) continue;
    const qualifiedTest = context;
    const stronger = result.nativeError || result.assertionDiagnostic || diagnostic.fault === "exception";
    const independent = diagnostic.fault === "reported" && !stronger && diagnostic.test === "fail"
      ? otherReportedDiagnostic(result.text) : undefined;
    const testOnly = qualifiedTest && diagnostic.test === "fail" && independent?.fault === "none";
    const severity: Severity = diagnostic.fault === "critical" ? 1 : stronger ? 0.7 : testOnly ? 0 : 0.3;
    const fingerprint = digest(diagnostic.fingerprint);
    failures.push({ digest: fingerprint, test: qualifiedTest, severity, observation, operation: result.operation });
    if (qualifiedTest && independent && independent.fault !== "none") {
      failures.push({ digest: fingerprint, test: false, severity: 0.3, observation, operation: result.operation });
    }
  }
  const severity = failures.reduce<Severity>((prior, failure) => failure.severity > prior ? failure.severity : prior, 0);
  return { outcome: { severity, tests: failures.some(failure => failure.test) ? "fail" : passed ? "pass" : "none",
    failureDigests: [...new Set(failures.map(failure => failure.digest))] }, failures, retained };
}

export function projectOutcomeBatch(assistant: unknown, tools: readonly unknown[]): ObservationOutcome | undefined {
  return projectOutcomeWithContext(assistant, tools)?.outcome;
}

/** Private tracker metadata, never a message/event field or retained result body. */
export function projectOutcomeWithContext(assistant: unknown, tools: readonly unknown[], prior: readonly RetainedObservationFailure[] = []): {
  outcome: ObservationOutcome; retained: readonly RetainedObservationFailure[];
} | undefined {
  try {
    if (!dataArray(tools) || tools.length > WIRE_BYTES / 20 || !dataArray(prior) || prior.length > WIRE_BYTES / 20) return undefined;
    for (const entry of prior) {
      if (!plain(entry) || Object.keys(entry).some(key => key !== "digest" && key !== "operation")
        || typeof own(entry, "digest") !== "string" || !/^[a-f0-9]{64}$/.test(own(entry, "digest") as string)) return undefined;
      if (Object.hasOwn(entry, "operation")) {
        const name = own(entry, "operation");
        if (name !== null && (typeof name !== "string" || !name || Buffer.byteLength(name) > OPERATION_BYTES)) return undefined;
      }
    }
    const source: unknown[] = [assistant];
    for (let index = 0; index < tools.length; index++) source.push(own(tools, String(index)));
    const conversation = captureJudgeConversation(source);
    if (!conversation || conversation.messages.length !== source.length || conversation.messages[0]?.role !== "assistant"
      || conversation.messages.slice(1).some(message => message.role !== "tool")) return undefined;
    const results = associatedResults(conversation.messages);
    if (!results) return undefined;
    const projected = fold(results, prior);
    return { outcome: projected.outcome, retained: projected.retained };
  } catch { return undefined; }
}

export function priorFailureDigests(messages: readonly unknown[]): readonly string[] | undefined {
  const entries = priorFailureContext(messages);
  return entries && [...new Set(entries.map(entry => entry.digest))];
}

export function priorFailureContext(messages: readonly unknown[]): readonly RetainedObservationFailure[] | undefined {
  const conversation = captureJudgeConversation(messages);
  if (!conversation) return undefined;
  const results = associatedResults(conversation.messages);
  if (!results) return undefined;
  const retained = new Map<string, RetainedObservationFailure>();
  for (const failure of fold(results).failures) {
    const entry = { digest: failure.digest, ...(failure.test ? { operation: failure.operation } : {}) };
    retained.set(`${entry.digest}:${failure.test ? JSON.stringify(failure.operation) : "unqualified"}`, entry);
    if (retained.size > WIRE_BYTES / 20) return undefined;
  }
  return [...retained.values()];
}

/** Only the digest escapes; R1's diagnostic/fingerprint text remains transient. */
export function failureFingerprint(value: string, isError: boolean): string | undefined {
  if (!text(value) || typeof isError !== "boolean") return undefined;
  const diagnostic = diagnoseStageResult({ text: value, error: isError, family: "other", associated: true });
  return diagnostic.fingerprint === undefined ? undefined : digest(diagnostic.fingerprint);
}

export function repeatedObservationFailure(observations: readonly ToolObservation[]): boolean | undefined {
  try {
    if (!dataArray(observations) || observations.length > WIRE_BYTES / 20) return undefined;
    const copied: Record<string, unknown>[] = [];
    let remaining = WIRE_BYTES;
    const charge = (bytes: number): void => { remaining -= bytes; if (remaining < 0) throw unavailable; };
    const inspectedText = (value: unknown): value is string => {
      if (typeof value !== "string" || value.length > WIRE_BYTES) return false;
      charge(Buffer.byteLength(value)); return true;
    };
    // Lower-bound aggregate admission precedes every diagnostic/fingerprint operation.
    for (let index = 0; index < observations.length; index++) {
      charge(20);
      const item = own(observations, String(index));
      if (!plain(item)) return undefined;
      const name = own(item, "name"), resultText = own(item, "resultText"), invocation = own(item, "command"),
        isError = own(item, "isError"), source = own(item, "source");
      if (!inspectedText(name) || !name || resultText !== undefined && !inspectedText(resultText) || invocation !== undefined && !inspectedText(invocation)
        || source !== undefined && !inspectedText(source) || isError !== undefined && typeof isError !== "boolean") return undefined;
      if (["resultText", "command", "isError", "source"].some(key => Object.hasOwn(item, key) && own(item, key) === undefined)) return undefined;
      copied.push({ role: "tool", content: resultText ?? "", name, ...(invocation === undefined ? {} : { command: invocation }),
        ...(source === undefined ? {} : { source }), ...(isError === undefined ? {} : { isError }) });
    }
    if (estimateStageInputTokens(copied) === undefined) return undefined;
    const results = copied.map(item => facts(item.name as string, item.content as string,
      item.isError === true, item.command as string | undefined));
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const failure of fold(results).failures) {
      const occurrence = `${failure.observation}:${failure.digest}`;
      if (seen.has(occurrence)) continue;
      seen.add(occurrence);
      const count = (counts.get(failure.digest) ?? 0) + 1;
      if (count > 1) return true;
      counts.set(failure.digest, count);
    }
    return false;
  } catch { return undefined; }
}
