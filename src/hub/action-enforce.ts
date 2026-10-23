import { ACTION_CLASSES, classifyAction, type ActionClass } from "./action-class.ts";
import { actionApprovalText, actionPolicyConfig, type ActionBudgets, type ActionPolicyConfig } from "./action-policy.ts";
import type { ActionGateVerdict } from "../adapters/acp.ts";

/**
 * Where the always-ask policy (#636) meets the two surfaces that see a tool call before it runs: the Claude PreToolUse hook and ACP
 * `session/request_permission`. The classifier (`action-class.ts`) and the budget ledger (`action-policy.ts`) decide; this file only
 * connects them, and only ever adds an approval: an empty result keeps the native permission policy.
 */

/** One native tool call as an adapter saw it: every name it is known by, the ACP tool kind when reported, and its arguments. */
export interface ActionCall { names: readonly string[]; kind?: string; input: unknown }

/** The classes of one call. ACP names a shell call `execute` by kind whatever its tool is called, so that kind is also read as a shell. */
export function classifyCall(call: ActionCall, root: string): ActionClass[] {
  const names = new Set(call.names.filter(name => typeof name === "string" && name.length > 0));
  if (call.kind === "execute") names.add("bash");
  const found = new Set<ActionClass>();
  for (const name of names) for (const key of classifyAction(name, call.input, root)) found.add(key);
  return ACTION_CLASSES.filter(key => found.has(key));
}

/**
 * The classes the Claude PreToolUse hook must `ask` about, in every permission mode. The budget never relaxes it: Claude's own dialog
 * cannot carry a class-budget choice, so every classed Claude call asks (a count of zero approved calls, always). A handle-less request
 * selects the classes without touching any session ledger.
 */
export function claudeActionClasses(budgets: ActionBudgets, tool: string, input: unknown, root: string): ActionClass[] {
  const classes = classifyAction(tool, input, root);
  if (!classes.length) return [];
  const decision = budgets.request(undefined, classes);
  return decision.kind === "ask" ? decision.classes : [];
}

/** The command line an approval shows: the shell command when there is one, else the arguments. Bounded by the caller's screen. */
export function commandText(input: unknown): string {
  let value: unknown = input;
  if (typeof input === "string") { try { value = JSON.parse(input) as unknown; } catch { return input; } }
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>, command = record.command ?? record.cmd;
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every(word => typeof word === "string")) return (command as string[]).join(" ");
    if (Array.isArray(record.args) && record.args.every(word => typeof word === "string")) return ["git", ...(record.args as string[])].join(" ");
  }
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

export interface ActionGatePorts<T> {
  budgets: ActionBudgets;
  policy(): ActionPolicyConfig | undefined;
  /** The peer's execution root: a delete outside it is classed. */
  root(peer: string): string;
  /** The task the peer is working on, for the approval line. */
  task(peer: string): T | undefined;
  /** The task's public view (`Tasks.publicView`): the only way a task title reaches an approval. */
  publicView(task: T): Record<string, unknown>;
  /** A private turn or an open PII task: the command is withheld. */
  isPrivate(peer: string): boolean;
  /** The PII screen for text (`Tasks.nameable`). */
  nameable(text: string): boolean;
}

/**
 * The ACP gate of one peer. It returns a verdict only when a person must be asked: a classed call with no session budget left. A call
 * within an approved class budget, and every unclassed call, return undefined and follow the permission mode as before (the budget
 * spends here, once per request).
 */
export function actionGate<T>(ports: ActionGatePorts<T>, peer: string): (call: ActionCall, session: string) => ActionGateVerdict | undefined {
  return (call, session) => {
    const classes = classifyCall(call, ports.root(peer));
    if (!classes.length) return undefined;
    const decision = ports.budgets.request(ports.budgets.bindSession(peer, session), classes);
    if (decision.kind !== "ask") return undefined; // native, or within an approved class budget
    const title = actionApprovalText(decision.classes, commandText(call.input), ports.task(peer), {
      publicView: task => ports.publicView(task), private: ports.isPrivate(peer), commandView: command => ports.nameable(command) ? command : undefined });
    const challenge = decision.challenge, limits = actionPolicyConfig(ports.policy()).budgets;
    // A budget of one is this call alone: the ordinary allow already says that, so no second choice is offered for it.
    if (/ \[cut, \d+ chars\]$/.test(title) || !challenge || !decision.classes.some(key => limits[key] > 1)) return { title };
    return { title, budget: { label: decision.classes.map(key => `${key} x${limits[key]}`).join(", "), approve: () => ports.budgets.approve(challenge) } };
  };
}
