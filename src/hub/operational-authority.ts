import type { SettingDef } from "./settings.ts";

/** Existing live registry rows only. A new registry key never inherits conductor authority from a prefix. */
export const CONDUCTOR_SETTING_KEYS = [
  "task_sweep.enabled", "task_sweep.auto_reassign", "task_sweep.no_writes_turns", "task_sweep.interval_s",
  "task_sweep.unaccepted_min", "task_sweep.idle_min", "task_sweep.review_min", "task_sweep.ready_min", "task_sweep.ladder_min",
  "snapshots.enabled", "research.enabled", "approvals.notify",
] as const;
const settingKeys: ReadonlySet<string> = new Set(CONDUCTOR_SETTING_KEYS);
export const operationalSettingKey = (value: unknown): value is string => typeof value === "string" && settingKeys.has(value);

/** Host registry identity must still match the exact live data leaf. This is policy, never proof of the caller's role. */
export function operationalSetting(def: Pick<SettingDef,"key"|"path"|"applies"|"store"|"locked">): boolean {
  return !def.locked && def.applies==="live" && def.store==="config" && def.path.join(".")===def.key && operationalSettingKey(def.key);
}

/** Roster participation uses its existing lifecycle-aware write, independently of generic settings set. */
export function operationalRosterSetting(def: Pick<SettingDef,"key"|"path"|"applies"|"store"|"locked"|"group">): boolean {
  return !def.locked && def.group==="Roster" && def.applies==="live" && def.store==="config"
    && def.path.length===2 && def.path[0]==="roster" && typeof def.path[1]==="string"
    && /^[a-z][a-z0-9-]{0,31}$/.test(def.path[1]) && def.key===`roster.${def.path[1]}`;
}

export const CONDUCTOR_LOCAL_ACTIONS = ["doctor orphans kill","logs","export"] as const;
export type ConductorLocalAction = typeof CONDUCTOR_LOCAL_ACTIONS[number];
export const conductorLocalAction = (value:unknown): value is ConductorLocalAction => typeof value==="string" && (CONDUCTOR_LOCAL_ACTIONS as readonly string[]).includes(value);
export type ConductorOperation = ConductorLocalAction | "roster add" | "roster remove" | "stop" | "queue show" | "queue resolve" | "queue discard" | "task cancel" | "settings set";

/** Select the closed command family; the existing command parser still validates all arguments before effects. */
export function conductorOperation(command:string,args:readonly string[]): ConductorOperation | undefined {
  const words=args.filter(arg=>!arg.startsWith("--"));
  const sub=words[0];
  if (command==="roster" && (sub==="add" || sub==="remove")) return `roster ${sub}`;
  if (command==="stop" && args.length===1 && /^[a-z][a-z0-9-]{0,31}$/.test(args[0]!)) return "stop";
  if (command==="queue" && (sub==="show" || sub==="resolve" || sub==="discard")) return `queue ${sub}`;
  if (command==="task" && sub==="cancel") return "task cancel";
  if (command==="doctor" && args.includes("--orphans") && args.includes("--kill")) return "doctor orphans kill";
  if (command==="logs" || command==="export") return command;
  if (command==="settings" && sub==="set" && operationalSettingKey(words[1])) return "settings set";
  return undefined;
}
