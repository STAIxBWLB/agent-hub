import { AsyncLocalStorage } from "node:async_hooks";
import { parseModelCommand } from "../cli/model.ts";

/** Parse only the explicit skill's `run` form; no shell syntax or implicit quoting is accepted. */
export function parseExactInstruction(args: string): string[] | undefined {
  if (!args.isWellFormed() || /[\p{Cc}\p{Cf}'"\\$`<>&]/u.test(args)) return;
  const words = args.trim().split(/ +/u);
  if (words[0] !== "run" || !words[1] || words[1]!.startsWith("-")) return;
  return words.slice(1);
}

/** A missing machine-local setting uses exact mode; malformed values never enable it. */
export function instructedMode(value: unknown): "off" | "exact" {
  if (value === undefined) return "exact";
  if (value === "off" || value === "exact") return value;
  throw new Error("instructed.mode must be off or exact");
}

export interface ExactForm { argv: string[]; taskId?: number; targetPeer?: string }

/** Closed, syntax-checked forms only. New and unclassified forms never inherit authority. */
export function exactForm(argv: readonly string[]): ExactForm | undefined {
  if (argv.some(word => word === "--as-user" || word.startsWith("--as-user=") || word === "--project" || word.startsWith("--project=") || word === "--live-test")) return;
  const [command, sub, ...tail] = argv;
  if (command === "task" && (sub === "assign" || sub === "unassign")) {
    const positional: string[] = [], flags = new Map<string, string>();
    for (let i = 0; i < tail.length; i++) {
      const word = tail[i]!;
      if (word.startsWith("--")) {
        if (!["--role", "--revision"].includes(word) || flags.has(word) || !tail[i + 1]) return;
        flags.set(word, tail[++i]!);
      } else positional.push(word);
    }
    if (positional.length !== (sub === "assign" ? 2 : 1) || !/^[1-9]\d*$/.test(positional[0]!) || !Number.isSafeInteger(Number(positional[0]))) return;
    if (sub === "assign" && !/^[a-z][a-z0-9-]*$/.test(positional[1]!)) return;
    const role = flags.get("--role");
    if (role && !(sub === "assign" ? ["owner", "reviewer", "planner"] : ["owner", "reviewer"]).includes(role)) return;
    const revision = flags.get("--revision");
    if (revision !== undefined && (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)))) return;
    return { argv: [...argv], taskId: Number(positional[0]) };
  }
  if (command === "backlog" && (sub === "pull" || sub === "return") && tail.length === 1 && /^[1-9]\d*$/.test(tail[0]!) && Number.isSafeInteger(Number(tail[0]))) return { argv: [...argv], taskId: Number(tail[0]) };
  if (command === "model") {
    try { const model = parseModelCommand(argv.slice(1)); if ((model.op === "set" || model.op === "clear") && model.peer) return { argv: [...argv], targetPeer: model.peer }; } catch { return; }
  }
  if (["stop", "pause", "resume"].includes(command ?? "") && argv.length === 2 && sub && /^[a-z][a-z0-9-]*$/.test(sub)) return { argv: [...argv], targetPeer: sub };
  if (command === "settings" && sub === "set" && tail.length >= 2 && tail.length <= 3) {
    const [key, value, flag] = tail;
    if (key && value && (key === "tasks.auto_pull" || /^tasks\.wip_limits\.[a-z][a-z0-9-]*$/.test(key) || key === "tasks.queue_backpressure.max_queued" || key === "tasks.queue_backpressure.max_oldest_s" || key === "budget.gate" || key === "review.gate" || key === "review.unknown_quota" || key === "review.max_minutes") && (flag === undefined || flag === "--yes")) return { argv: [...argv] };
  }
  return;
}

export interface InstructedExecution { peer: string; receipt: string; taskId?: number; active: boolean; current(): void }
/** Host-only provenance follows the actual control request into board writes. */
export const instructedExecution = new AsyncLocalStorage<InstructedExecution>();
export function instructedHistory(by: string): { instructed: true; instructedPeer: string; instructionReceipt: string } | Record<string, never> {
  const context = instructedExecution.getStore();
  return by === "user" && context?.active ? { instructed: true, instructedPeer: context.peer, instructionReceipt: context.receipt } : {};
}
