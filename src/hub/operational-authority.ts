import type { SettingDef } from "./settings.ts";

/**
 * Existing live registry rows only. A new registry key never inherits conductor authority from a prefix.
 * #933: every live config key outside the person's group. The registry's groups cannot tell spending from operations
 * (`tasks.wip_limits.*`, `tasks.auto_pull` and `tasks.queue_backpressure.*` decide how much work the hub hands out unattended,
 * and an agent never turns auto pull on), and Permissions, Roles and Start are trust or not live, so the list stays explicit.
 */
export const CONDUCTOR_SETTING_KEYS = [
  "task_sweep.enabled", "task_sweep.auto_reassign", "task_sweep.no_writes_turns", "task_sweep.interval_s",
  "task_sweep.unaccepted_min", "task_sweep.idle_min", "task_sweep.review_min", "task_sweep.ready_min", "task_sweep.ladder_min",
  "snapshots.enabled", "research.enabled", "approvals.notify",
  "tasks.escalate_after",
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
/** Daemon-authorized labels. Recovery labels pass the initial role check, then require their separate per-operation proof. */
export const CONDUCTOR_DAEMON_OPERATIONS = ["roster add","roster remove","stop","queue show","queue resolve","queue discard","settings set","doctor orphans kill","logs","export",
  "board import","intake approve","schedule run","schedule pause","schedule resume","goal link","task unassign","restart","upgrade","recovery resume","recovery abort"] as const;
/**
 * #933: forms whose effect runs in the CLI process itself (local files). The daemon admits and audits them once at the handshake (`admit`),
 * after the CLI has validated their arguments. Recovery-bearing restart/upgrade forms use the separate source-issued continuation proof.
 * ponytail: `memory promote|demote|forget|supersede|rebuild|machine --label` and the local `goal` changes stay the person's because the pinned
 * amem (0.12.0) records their actor as "user"; once the hub passes an agent actor through agent-mem 0.13.0 attribution (agent-mem#143, after
 * the pin bump in #958) they can join this list. `goal link` is a daemon form: the hub records the peer as its actor.
 */
export const CONDUCTOR_LOCAL_OPERATIONS = ["research backfill","bench run","source add"] as const;
export type ConductorOperation = typeof CONDUCTOR_DAEMON_OPERATIONS[number] | typeof CONDUCTOR_LOCAL_OPERATIONS[number];
export const conductorLocalOperation = (value:unknown): boolean => typeof value==="string" && (CONDUCTOR_LOCAL_OPERATIONS as readonly string[]).includes(value);

function operationalDisplayArgument(arg: string): boolean {
  return arg === "--json" || arg === "--verbose" || arg.startsWith("--color=");
}

function recoveryConductorAction(args: readonly string[]): "resume" | "abort" | undefined {
  const words = args.filter(arg => !operationalDisplayArgument(arg));
  const action = words[0];
  if (action !== "resume" && action !== "abort") return undefined;
  const tail = words.slice(1);
  if (tail.length > 1 || tail.some(arg => arg.startsWith("-"))) return undefined;
  return action;
}

function restartOrUpgrade(command: string, args: readonly string[]): "restart" | "upgrade" | undefined {
  const words = args.filter(arg => !operationalDisplayArgument(arg));
  if (words.includes("--dry-run")) return undefined;
  if (command === "restart") return words.length === 1 && words[0] === "--yes" ? "restart" : undefined;
  if (command !== "upgrade" || words.length !== 3) return undefined;
  if (words[0] === "--yes" && words[1] === "--to" && !words[2]!.startsWith("-")) return "upgrade";
  if (words[0] === "--to" && !words[1]!.startsWith("-") && words[2] === "--yes") return "upgrade";
  return undefined;
}

/** Select the closed command family; the existing command parser still validates all arguments before effects. */
export function conductorOperation(command:string,args:readonly string[]): ConductorOperation | undefined {
  const words=args.filter(arg=>!arg.startsWith("--"));
  const sub=words[0];
  if (command === "restart" || command === "upgrade") return restartOrUpgrade(command, args);
  if (command === "recovery") {
    const action = recoveryConductorAction(args);
    return action ? `recovery ${action}` : undefined;
  }
  if (command==="roster" && (sub==="add" || sub==="remove")) return `roster ${sub}`;
  if (command==="stop" && args.length===1 && /^[a-z][a-z0-9-]{0,31}$/.test(args[0]!)) return "stop";
  if (command==="queue" && (sub==="show" || sub==="resolve" || sub==="discard")) return `queue ${sub}`;
  if (command==="task" && sub==="unassign") return "task unassign";
  if (command==="doctor" && args.includes("--orphans") && args.includes("--kill")) return "doctor orphans kill";
  if (command==="logs" || command==="export") return command;
  if (command==="settings" && sub==="set" && operationalSettingKey(words[1])) return "settings set";
  // #933: operational forms the person no longer has to run; recovery-bearing forms above use their own proof.
  if (command==="board" && args[0]==="import") return "board import";
  if (command==="research" && args[0]==="backfill") return "research backfill";
  if (command==="bench" && args.find(arg=>arg!=="--json")==="run") return "bench run";
  if (command==="source" && sub==="add") return "source add";
  if (command==="intake" && sub==="approve" && words.length===2) return "intake approve";
  if (command==="schedule" && (sub==="run" || sub==="pause" || sub==="resume")) return `schedule ${sub}`;
  if (command==="goal" && args.find(arg=>arg!=="--json")==="link") return "goal link";
  return undefined;
}


/** Only a failed conductor/operational authority fence carries this marker, never an ordinary operation error. */
export class OperationalAuthorityError extends Error {
  readonly code = "AHUB_OPERATIONAL_AUTHORITY";
  constructor(message:string,readonly scope:"conductor"|"person"|"operational"="operational") { super(message); }
}

export const OPERATIONAL_PERSON_GUIDANCE="the person runs it in ahub console or a terminal";
export function operationalRefusal(peer:string,command:string):string {
  return `${peer} cannot run ahub ${command}; ${OPERATIONAL_PERSON_GUIDANCE}; this operation requires the explicit conductor role`;
}
/** #933: the console task ops the conductor may now run, by audit label. The daemon admits each through `admitOperational` before Tasks sees it. */
export const CONDUCTOR_TASK_OPS: Readonly<Record<string,ConductorOperation>> = {github_import:"board import",intake_approve:"intake approve",schedule_run:"schedule run",schedule_pause:"schedule pause",schedule_resume:"schedule resume",task_unassign:"task unassign"};
/** Fixed labels only; refused requests never put argument text in the audit. */
export function operationalRequestLabel(value:unknown):string|undefined {
  if(!value || typeof value!=="object" || Array.isArray(value))return undefined;
  const message=value as Record<string,unknown>;
  if(message.t==="conductor_operational") {
    if(message.op==="authorize")return typeof message.command==="string" && (CONDUCTOR_DAEMON_OPERATIONS as readonly string[]).includes(message.command)?message.command:"unknown";
    if(message.op==="admit")return conductorLocalOperation(message.command)?message.command as string:"unknown";
    return message.op==="orphans"?"doctor orphans kill":message.op==="logs"||message.op==="export"?message.op:"unknown";
  }
  if(message.t==="peer_stop")return "stop";
  if(message.t==="goal_link")return "goal link";
  if(message.t==="task" && typeof message.op==="string" && Object.hasOwn(CONDUCTOR_TASK_OPS,message.op))return CONDUCTOR_TASK_OPS[message.op];
  if(message.t==="queue" && typeof message.op==="string" && ["show","resolve","discard"].includes(message.op))return `queue ${message.op}`;
  if(message.t==="settings_set"||message.t==="settings_preview")return "settings set";
  return undefined;
}
