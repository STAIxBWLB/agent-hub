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
interface Failure { digest: string; test: boolean; severity: Severity; observation: number }
interface ResultFacts {
  readOnly: boolean;
  nativeError: boolean;
  assertionDiagnostic: boolean;
  testInvocation: boolean;
  testMention: boolean;
  diagnostic: StageDiagnostic;
  text: string;
}
const WIRE_BYTES = 2_000_000;
const unavailable = Symbol("observation unavailable");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const testName = /^(?:test|run_tests|run_test|pytest|unittest)$/i;
// Local lexical evidence only, never an executable/exit-status attestation.
const testCommand = /(?:^|[\s;&|])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test(?:$|[\s:])|(?:pytest|vitest|jest)(?:$|\s)|python(?:3(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)\b|(?:cargo|go|make|just)\s+test\b)/i;

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
function command(argumentsText: string): string | undefined {
  try {
    const args: unknown = JSON.parse(argumentsText);
    const value = plain(args) ? own(args, "command") : undefined;
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}
function facts(name: string, value: string, nativeError: boolean, invocation?: string, readFamily = false): ResultFacts {
  const readOnly = readFamily || /^(?:read|read_file|readfile|glob|grep|search|list|ls|lookup)(?:_|$)/i.test(name)
    || name.toLowerCase() === "text_editor" && invocation === "view";
  return {
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
      results.push(facts(call.function.name, message.content, message.is_error === true || message.isError === true,
        command(call.function.arguments), result.family === "read"));
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
function fold(results: readonly ResultFacts[]): { outcome: ObservationOutcome; failures: Failure[] } {
  let failures: Failure[] = [], passed = false;
  for (const [observation, result] of results.entries()) {
    if (result.readOnly && !result.nativeError) continue;
    const diagnostic = result.diagnostic, context = result.testInvocation || result.testMention;
    const genuinePass = context && !result.nativeError && diagnostic.fault === "none" && diagnostic.test === "pass";
    if (genuinePass) { failures = failures.filter(failure => !failure.test); passed = true; }
    if (diagnostic.fault === "none" || diagnostic.fingerprint === undefined) continue;
    const qualifiedTest = context;
    const stronger = result.nativeError || result.assertionDiagnostic || diagnostic.fault === "exception";
    const independent = diagnostic.fault === "reported" && !stronger && diagnostic.test === "fail"
      ? otherReportedDiagnostic(result.text) : undefined;
    const testOnly = qualifiedTest && diagnostic.test === "fail" && independent?.fault === "none";
    const severity: Severity = diagnostic.fault === "critical" ? 1 : stronger ? 0.7 : testOnly ? 0 : 0.3;
    const fingerprint = digest(diagnostic.fingerprint);
    failures.push({ digest: fingerprint, test: qualifiedTest, severity, observation });
    if (qualifiedTest && independent && independent.fault !== "none") {
      failures.push({ digest: fingerprint, test: false, severity: 0.3, observation });
    }
  }
  const severity = failures.reduce<Severity>((prior, failure) => failure.severity > prior ? failure.severity : prior, 0);
  return { outcome: { severity, tests: failures.some(failure => failure.test) ? "fail" : passed ? "pass" : "none",
    failureDigests: [...new Set(failures.map(failure => failure.digest))] }, failures };
}

export function projectOutcomeBatch(assistant: unknown, tools: readonly unknown[]): ObservationOutcome | undefined {
  try {
    if (!dataArray(tools) || tools.length > WIRE_BYTES / 20) return undefined;
    const source: unknown[] = [assistant];
    for (let index = 0; index < tools.length; index++) source.push(own(tools, String(index)));
    const conversation = captureJudgeConversation(source);
    if (!conversation || conversation.messages.length !== source.length || conversation.messages[0]?.role !== "assistant"
      || conversation.messages.slice(1).some(message => message.role !== "tool")) return undefined;
    const results = associatedResults(conversation.messages);
    return results && fold(results).outcome;
  } catch { return undefined; }
}

export function priorFailureDigests(messages: readonly unknown[]): readonly string[] | undefined {
  const conversation = captureJudgeConversation(messages);
  if (!conversation) return undefined;
  const results = associatedResults(conversation.messages);
  return results && fold(results).outcome.failureDigests;
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
    const results: ResultFacts[] = [], copied: Record<string, unknown>[] = [];
    for (let index = 0; index < observations.length; index++) {
      const item = own(observations, String(index));
      if (!plain(item)) return undefined;
      const name = own(item, "name"), resultText = own(item, "resultText"), invocation = own(item, "command"),
        isError = own(item, "isError"), source = own(item, "source");
      if (!text(name) || !name || resultText !== undefined && !text(resultText) || invocation !== undefined && !text(invocation)
        || source !== undefined && !text(source) || isError !== undefined && typeof isError !== "boolean") return undefined;
      if (["resultText", "command", "isError", "source"].some(key => Object.hasOwn(item, key) && own(item, key) === undefined)) return undefined;
      copied.push({ role: "tool", content: resultText ?? "", name, ...(invocation === undefined ? {} : { command: invocation }),
        ...(source === undefined ? {} : { source }), ...(isError === undefined ? {} : { isError }) });
      results.push(facts(name, resultText ?? "", isError === true, invocation));
    }
    if (estimateStageInputTokens(copied) === undefined) return undefined;
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
