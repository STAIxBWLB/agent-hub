import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage } from "../../omniroute/client.ts";
import { extractToolSignals, fingerprint } from "./signals.ts";
import { normalizeConversation } from "./normalize.ts";

export type RouteTurnOutcome = "completed" | "failed";
export type RouteTestOutcome = "pass" | "fail" | "none";
export type RouteAdvisorOutcome = "approve" | "redo" | "failed";
export interface RouteDimensions { severity: number; spinning: number; exploring: number; production: number }
export interface RouteTurnContext { turn: string; task?: number; pii: boolean }
export interface RouteLabelEvent {
  decision: string;
  turnId: string;
  turn: RouteTurnOutcome;
  pii: boolean;
  task?: number;
  latched: boolean;
  next?: { severity: 0 | 0.3 | 0.7 | 1; tests: RouteTestOutcome; repeat: boolean };
  advisor?: RouteAdvisorOutcome;
}

interface DecisionLabel {
  id: string;
  dimensions: RouteDimensions;
  baselineFingerprints: Set<string>;
  next?: RouteLabelEvent["next"];
  advisor?: RouteAdvisorOutcome;
}
interface OpenTurn {
  context: RouteTurnContext;
  decisions: Map<string, DecisionLabel>;
  latched: boolean;
  closed: boolean;
}

const discreteSeverity = (value: number): 0 | 0.3 | 0.7 | 1 => value >= 1 ? 1 : value >= 0.7 ? 0.7 : value >= 0.3 ? 0.3 : 0;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Holds only identifiers, numeric dimensions, enums, and hashed diagnostic fingerprints. */
export class RouteLabelTracker {
  private active: OpenTurn | undefined;
  private readonly turns = new Map<string, OpenTurn>();
  private readonly decisionOwners = new Map<string, OpenTurn>();

  constructor(private readonly sink?: (event: RouteLabelEvent) => void) {}

  beginTurn(context: RouteTurnContext): void {
    const prior = this.active;
    if (prior && !prior.closed) this.endTurn(prior.context.turn, "failed");
    const turn: OpenTurn = { context: { ...context }, decisions: new Map(), latched: false, closed: false };
    this.turns.set(context.turn, turn);
    this.active = turn;
  }

  captureTurn(): OpenTurn | undefined { return this.active && !this.active.closed ? this.active : undefined; }

  addDecision(turn: OpenTurn | undefined, dimensions: RouteDimensions, priorMessages: ChatMessage[] = []): string | undefined {
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn) return undefined;
    const id = randomUUID();
    turn.decisions.set(id, { id, dimensions: { ...dimensions }, baselineFingerprints: batchFingerprints(priorMessages) });
    this.decisionOwners.set(id, turn);
    return id;
  }

  setLatched(turn: OpenTurn | undefined, latched: boolean): void {
    if (turn && !turn.closed && this.turns.get(turn.context.turn) === turn) turn.latched ||= latched;
  }

  observeResults(decisionId: string | undefined, assistant: ChatMessage, tools: ChatMessage[]): void {
    const turn = decisionId ? this.decisionOwners.get(decisionId) : undefined;
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn || !decisionId) return;
    const decision = turn.decisions.get(decisionId);
    if (!decision) return;

    const batch = normalizeConversation([assistant, ...tools]);
    const signals = extractToolSignals(batch, Math.max(3, tools.length));
    const severity = discreteSeverity(signals.severity);
    const tests = signals.testsPassed ? "pass" : testFailure(assistant, tools) ? "fail" : "none";
    const fingerprints = batchFingerprints([assistant, ...tools]);
    const repeat = [...fingerprints].some((fingerprint) => decision.baselineFingerprints.has(fingerprint));
    decision.next = { severity, tests, repeat };
  }

  observeAdvisor(decisionId: string | undefined, verdict: RouteAdvisorOutcome): void {
    const turn = decisionId ? this.decisionOwners.get(decisionId) : undefined;
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn || !decisionId) return;
    const decision = turn.decisions.get(decisionId);
    if (decision) decision.advisor = verdict;
  }

  endTurn(turnId: string, outcome: RouteTurnOutcome, sink?: (event: RouteLabelEvent) => void): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.closed) return;
    turn.closed = true;
    this.turns.delete(turnId);
    if (this.active === turn) this.active = undefined;
    for (const decision of turn.decisions.values()) {
      const event: RouteLabelEvent = {
        decision: decision.id,
        turnId,
        turn: outcome,
        pii: turn.context.pii,
        latched: turn.latched,
        ...(turn.context.task === undefined ? {} : { task: turn.context.task }),
        ...(decision.next === undefined ? {} : { next: decision.next }),
        ...(decision.advisor === undefined ? {} : { advisor: decision.advisor }),
      };
      try { (sink ?? this.sink)?.(event); } catch { /* optional labels cannot affect the turn */ }
      this.decisionOwners.delete(decision.id);
    }
    turn.decisions.clear();
  }
}

function batchFingerprints(messages: ChatMessage[]): Set<string> {
  const conversation = normalizeConversation(messages);
  const result = new Set<string>();
  for (const message of conversation.messages) {
    for (const tool of message.toolResults) {
      if (!tool.content) continue;
      const call = conversation.messages.flatMap(item => item.toolCalls).find(item => item.id === tool.toolCallId);
      const matchedAssistant: ChatMessage = {
        role: "assistant", content: null,
        tool_calls: call ? [{ id: call.id, type: "function", function: { name: call.name, arguments: safeJson(call.arguments) } }] : [],
      };
      const signals = extractToolSignals(normalizeConversation([matchedAssistant, {
        role: "tool", tool_call_id: tool.toolCallId, content: tool.content, ...(tool.isError ? { is_error: true } : {}),
      }]), 3);
      if (signals.severity === 0) continue;
      const value = fingerprint(tool.content, tool.isError === true);
      if (value !== undefined) result.add(sha256(value));
    }
  }
  return result;
}

function testFailure(assistant: ChatMessage, tools: ChatMessage[]): boolean {
  const conversation = normalizeConversation([assistant, ...tools]);
  const calls = conversation.messages.flatMap(message => message.toolCalls);
  const results = conversation.messages.flatMap(message => message.toolResults);
  for (const result of results) {
    const call = calls.find(item => item.id === result.toolCallId);
    if (!call) continue;
    const args = safeJson(call.arguments);
    const isTestCall = /\b(test|tests|spec|specs|pytest|vitest|jest|cargo test|go test)\b/iu.test(call.name)
      || /\b(bun test|pytest|vitest|jest|cargo test|go test|npm test|pnpm test|yarn test)\b/iu.test(args);
    if (!isTestCall && !/\btests?\b/iu.test(result.content)) continue;
    const matchedAssistant: ChatMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: args } }],
    };
    const outcomeSignals = extractToolSignals(normalizeConversation([matchedAssistant, {
      role: "tool", tool_call_id: result.toolCallId, content: result.content, ...(result.isError ? { is_error: true } : {}),
    }]), 3);
    if (!result.isError && outcomeSignals.readCount > 0) continue;
    const severity = outcomeSignals.severity;
    const numericFailures = /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failures|errors?)\b/iu.test(result.content)
      || /\b(?:failed|failures|errors?)\b[^\n\d]{0,20}[1-9]\d*/iu.test(result.content);
    if (numericFailures || severity > 0) return true;
  }
  return false;
}

function safeJson(value: unknown): string {
  try { return typeof value === "string" ? value : JSON.stringify(value) ?? ""; }
  catch { return ""; }
}
