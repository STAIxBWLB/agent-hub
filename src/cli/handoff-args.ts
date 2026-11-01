// Argument parsing for `ahub task handoff` (#604, agent-hub#1030). Pure: argv in, one request or a usage line out, so main.ts stays a thin dispatcher and every form is testable without a daemon.
import { CLASSES } from "../hub/board.ts";

export const HANDOFF_USAGE = "usage: ahub task handoff --project <root|id> [<class>] <title...> [--path <p>]... [--issue <n>] [--task <n>] [--detail <text>] [--json] [--color=auto|always|never]";

export interface HandoffCliRequest { project: string; title: string; class?: string; detail?: string; paths?: string[]; issue?: number; task?: number }

/** `operands` is argv after `task handoff`, presentation flags already removed. A first word that is a class name is the class, said out loud by the caller (the documented short form). */
export function parseHandoffArgs(operands: readonly string[]): HandoffCliRequest | { usage: string } {
  const one: Record<string, string> = {}, paths: string[] = [], rest: string[] = [];
  for (let i = 0; i < operands.length; i++) {
    const arg = operands[i]!;
    if (arg === "--project" || arg === "--detail" || arg === "--issue" || arg === "--task" || arg === "--path") {
      const value = operands[++i];
      if (value === undefined || value.startsWith("--")) return { usage: HANDOFF_USAGE };
      if (arg === "--path") paths.push(value); else { if (Object.hasOwn(one, arg)) return { usage: HANDOFF_USAGE }; one[arg] = value; }
    } else if (arg.startsWith("--")) return { usage: HANDOFF_USAGE };
    else rest.push(arg);
  }
  const project = one["--project"];
  const classed = rest[0] !== undefined && (CLASSES as readonly string[]).includes(rest[0]) && rest.length > 1;
  const title = (classed ? rest.slice(1) : rest).join(" ").trim();
  if (!project || !title) return { usage: HANDOFF_USAGE };
  if (one["--issue"] !== undefined && !/^[1-9]\d{0,9}$/.test(one["--issue"])) return { usage: `${HANDOFF_USAGE}\n--issue is the target repository's issue number` };
  if (one["--task"] !== undefined && !/^[1-9]\d{0,9}$/.test(one["--task"])) return { usage: `${HANDOFF_USAGE}\n--task is this project's own task id` };
  return { project, title, ...(classed ? { class: rest[0]! } : {}), ...(one["--detail"] !== undefined ? { detail: one["--detail"] } : {}), ...(paths.length ? { paths } : {}), ...(one["--issue"] !== undefined ? { issue: Number(one["--issue"]) } : {}), ...(one["--task"] !== undefined ? { task: Number(one["--task"]) } : {}) };
}
