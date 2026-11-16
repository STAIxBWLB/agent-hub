import { HUB, USER, type Envelope } from "./envelope.ts";

export type TurnTrigger = "assign" | "review" | "message" | "manual" | "schedule";
export interface TurnAttribution { task?: number; attempt?: string; trigger?: TurnTrigger; private?: boolean; cloud?: boolean }

/** Hints are not authority: only emit a task when the host's turn context is unambiguous. */
export function turnAttribution(envs: readonly Envelope[], options: { task?: number; cloud?: boolean; scheduled?: (task: number) => boolean | undefined } = {}): TurnAttribution {
  let invalidTask = false;
  const refs = new Set(envs.flatMap(env => {
    const value = env.refs?.task;
    if (value === undefined) return [];
    if (!/^[1-9][0-9]*$/.test(value)) { invalidTask = true; return []; }
    const id = Number(value);
    if (!Number.isSafeInteger(id)) { invalidTask = true; return []; }
    return [id];
  }));
  const task = options.task === undefined || invalidTask ? undefined : refs.size === 1 ? [...refs][0] : refs.size === 0 ? options.task : undefined;
  const validTask = task !== undefined && Number.isSafeInteger(task) && task > 0 && (options.task === undefined || task === options.task);
  let scheduled: boolean | undefined;
  if (validTask && options.scheduled) try { scheduled = options.scheduled(task); } catch { /* Unknown provenance yields no assignment trigger. */ }
  let uncertainTrigger = false;
  const triggers = new Set(envs.flatMap(env => {
    if (env.from === HUB && env.kind === "review") return ["review" as const];
    if (env.from === HUB && env.kind === "task" && env.refs?.taskOffer !== undefined) {
      if (scheduled === undefined) { uncertainTrigger = true; return []; }
      return [scheduled ? "schedule" as const : "assign" as const];
    }
    if (env.from === USER) return ["manual" as const];
    if (env.kind === "chat" && env.from !== HUB) return ["message" as const];
    return [];
  }));
  return { ...(validTask ? { task } : {}), ...(!uncertainTrigger && triggers.size === 1 ? { trigger: [...triggers][0]! } : {}),
    ...(envs.some(env => env.private) ? { private: true } : {}), ...(options.cloud ? { cloud: true } : {}) };
}

/** Strip inherited/configured hints and add only validated host-provided values. */
export function applyTurnAttribution(source: NodeJS.ProcessEnv, context?: TurnAttribution): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.AGENTHUB_TASK_ID; delete env.AGENTHUB_ATTEMPT_ID; delete env.AGENTHUB_TRIGGER;
  const hidden = context?.private === true && context.cloud === true;
  if (!hidden && context?.task !== undefined && Number.isSafeInteger(context.task) && context.task > 0) env.AGENTHUB_TASK_ID = String(context.task);
  if (!hidden && typeof context?.attempt === "string" && /^ra-[0-9a-f]{12}$/.test(context.attempt)) env.AGENTHUB_ATTEMPT_ID = context.attempt;
  if (context?.trigger && ["assign", "review", "message", "manual", "schedule"].includes(context.trigger)) env.AGENTHUB_TRIGGER = context.trigger;
  return env;
}
