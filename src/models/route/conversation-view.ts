import { types } from "node:util";
import { captureStageInput, estimateStageInputTokens, type StageInput, type StageResultInput } from "./stage-input.ts";

const MESSAGES = 64, RESULTS = 16, CALLS = 32, PARTS = 32;
const RESULT_TEXT_BYTES = 64 * 1024;
const unavailable = Object.freeze({ unavailable: true });

export interface RouteResultObservation {
  input: StageResultInput;
  /** Local positive proof of an entire native string result, never a wire field. */
  sourceTextComplete: boolean;
}
export interface RouteConversationView {
  stageInput: StageInput;
  results: readonly RouteResultObservation[];
}

export interface JudgeMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type?: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  is_error?: boolean;
  isError?: boolean;
}
export interface JudgeConversation {
  instructions: readonly JudgeMessage[];
  messages: readonly JudgeMessage[];
  transcript: string;
  assistantTurns: number;
  resultCount: number;
  terminal?: { hasToolUse: boolean; visibleText: string };
}
const JUDGE_WIRE_BYTES = 2_000_000;

/** Full local-only native projection, separate from the stage window and adec packet. */
export function captureJudgeConversation(source: unknown): JudgeConversation | undefined {
  try {
    if (!array(source)) return undefined;
    let remaining = JUDGE_WIRE_BYTES;
    const charge = (bytes: number): void => { remaining -= bytes; if (remaining < 0) throw unavailable; };
    const string = (value: unknown): string => {
      if (typeof value !== "string" || value.length > JUDGE_WIRE_BYTES) throw unavailable;
      charge(Buffer.byteLength(value, "utf8")); return value;
    };
    const instructions: JudgeMessage[] = [], messages: JudgeMessage[] = [];
    let assistantTurns = 0, resultCount = 0;
    for (let index = 0; index < source.length; index++) {
      const raw = own(source, String(index));
      if (!record(raw)) throw unavailable;
      const role = own(raw, "role"), content = own(raw, "content");
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") throw unavailable;
      // A lower bound only: exact JSON-wire admission follows after inert copying.
      charge(20 + Buffer.byteLength(role));
      const message: JudgeMessage = { role, content: content === null ? null : string(content) };
      for (const flag of ["is_error", "isError"] as const) if (Object.hasOwn(raw, flag)) {
        const value = own(raw, flag);
        if (typeof value !== "boolean") throw unavailable;
        message[flag] = value;
      }
      if (Object.hasOwn(raw, "tool_call_id")) message.tool_call_id = string(own(raw, "tool_call_id"));
      if (role === "tool" && message.tool_call_id === undefined) throw unavailable;
      if (Object.hasOwn(raw, "tool_calls")) {
        const calls = own(raw, "tool_calls");
        if (!array(calls)) throw unavailable;
        message.tool_calls = [];
        for (let at = 0; at < calls.length; at++) {
          const call = own(calls, String(at));
          if (!record(call)) throw unavailable;
          const fn = own(call, "function");
          if (!record(fn)) throw unavailable;
          charge(32);
          const copied: NonNullable<JudgeMessage["tool_calls"]>[number] = {
            id: string(own(call, "id")),
            function: { name: string(own(fn, "name")), arguments: string(own(fn, "arguments")) },
          };
          if (Object.hasOwn(call, "type")) {
            if (own(call, "type") !== "function") throw unavailable;
            copied.type = "function";
          }
          message.tool_calls.push(copied);
        }
      }
      if (role === "assistant") assistantTurns++;
      if (role === "tool") resultCount++;
      if (role === "system" || role === "developer") instructions.push(message);
      else messages.push(message);
    }
    const ordered = [...instructions, ...messages];
    if (estimateStageInputTokens(ordered) === undefined) return undefined;
    const last = messages.at(-1);
    return { instructions, messages, transcript: JSON.stringify(ordered), assistantTurns, resultCount,
      ...(last?.role === "assistant" ? { terminal: { hasToolUse: !!last.tool_calls?.length, visibleText: last.content ?? "" } } : {}) };
  } catch { return undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function array(value: unknown): value is unknown[] {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw unavailable;
  const result: unknown = descriptor.value;
  if (result && typeof result === "object" && types.isProxy(result)) throw unavailable;
  return result;
}

/**
 * Local completion projection. Association and diagnostics remain R1's policies.
 * Preflight follows only the paths/caps R1 will inspect, without running getters.
 */
export function captureRouteView(source: unknown): RouteConversationView | undefined {
  try {
    const messages = array(source) ? source : record(source) ? own(source, "messages") : undefined;
    if (!array(messages)) return undefined;
    let calls = 0, parts = 0, turnSeen = false;
    const origins: { content: unknown; flagsKnown: boolean }[] = [];
    const inspectText = (value: unknown): void => {
      if (value === undefined || value === null || typeof value === "string") return;
      if (!array(value)) throw unavailable;
      for (let index = 0; index < value.length && parts < PARTS; index++, parts++) {
        const part = own(value, String(index));
        if (!record(part)) throw unavailable;
        own(part, "type"); own(part, "text");
      }
    };
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - MESSAGES); index--) {
      const message = own(messages, String(index));
      if (!record(message)) throw unavailable;
      const role = own(message, "role");
      if (role === "system" || role === "developer") continue;
      if (role !== "user" && role !== "assistant" && role !== "tool") throw unavailable;
      if (!turnSeen) {
        turnSeen = true;
        if (role === "user") inspectText(own(message, "content"));
      }
      if (role === "assistant") {
        const entries = own(message, "tool_calls");
        if (entries !== undefined && entries !== null && !array(entries)) throw unavailable;
        if (array(entries)) for (let at = entries.length - 1; at >= 0 && calls < CALLS; at--, calls++) {
          const call = own(entries, String(at));
          if (!record(call)) throw unavailable;
          own(call, "id");
          const fn = own(call, "function");
          if (fn !== undefined && fn !== null) {
            if (!record(fn)) throw unavailable;
            own(fn, "name");
          }
        }
      }
      if (role === "tool" && origins.length < RESULTS) {
        const content = own(message, "content");
        own(message, "tool_call_id");
        const snake = own(message, "is_error"), camel = own(message, "isError");
        const flagsKnown = (snake === undefined || typeof snake === "boolean") && (camel === undefined || typeof camel === "boolean");
        inspectText(content);
        origins.push({ content, flagsKnown });
      }
    }
    const stageInput = captureStageInput(source);
    if (!stageInput || stageInput.results.length !== origins.length) return undefined;
    origins.reverse();
    const results = stageInput.results.map((input, index) => {
      const original = origins[index]!;
      const text = original.content;
      return { input, sourceTextComplete: original.flagsKnown && typeof text === "string"
        && text.length <= RESULT_TEXT_BYTES && Buffer.byteLength(text, "utf8") <= RESULT_TEXT_BYTES
        && input.text === text };
    });
    return { stageInput, results };
  } catch { return undefined; }
}
