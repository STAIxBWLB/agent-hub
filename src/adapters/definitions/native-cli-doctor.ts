import type { CompatId } from "../compat.ts";
import type { DoctorCheck } from "../../cli/output.ts";

// Fixed builtin doctor policy only. These projections neither execute probes nor extend AdapterDefinition.
const nativeTools = [
  { id: "claude", initial: true }, { id: "codex", initial: true }, { id: "kimi", initial: true },
  { id: "qwen", initial: false }, { id: "jcode", initial: false },
] as const;
export const DOCTOR_TOOL_PROBES: readonly string[] = Object.freeze(["bun", ...nativeTools.filter(tool => tool.initial).map(tool => tool.id)]);
export const DOCTOR_MEMORY_CAPTURE_PEERS = Object.freeze(["codex", "kimi"] as const);
/**
 * What one read of agent-mem's own setup state gave (`amem setup <tool> --json`, a preview that writes nothing): the parsed plan, or why there is none. Agent-mem owns the state;
 * doctor never reads dotfiles text or a client's config itself (#1008).
 */
export type MemorySetupReading = { kind: "read"; plan: unknown } | { kind: "unavailable"; reason: string };

/**
 * One memory-capture doctor row from agent-mem's structured setup plan: `applied` (the hub's receipt matches and the MCP entry and hooks are as setup would write them), `pending`
 * (setup would add or replace something, so `amem setup <tool> --apply` is the fix), or `client missing` (the native CLI is not installed). A reading that cannot be trusted as the shape
 * agent-mem documents is unknown, never ready: the row says it could not be read instead of guessing. Pure: the plan is data, never text, and nothing here runs a process.
 * Codex also needs the person's native `/hooks` review before a newly registered hook runs, which agent-mem's setup does not grant, so an applied Codex row says so.
 */
export function nativeMemoryCaptureRow(tool: string, reading: MemorySetupReading): { ok: boolean | undefined; detail: string } {
  const unknown = (why: string) => ({ ok: undefined, detail: `unknown (${why})` });
  if (reading.kind !== "read") return unknown(reading.reason);
  const plan = reading.plan as { mode?: unknown; actions?: unknown } | null;
  const actions = plan && typeof plan === "object" && plan.mode === "preview" && Array.isArray(plan.actions) ? plan.actions : undefined;
  const action = actions?.length === 1 ? actions[0] as Record<string, unknown> | null : undefined;
  if (!action || typeof action !== "object" || action.target !== tool || typeof action.available !== "boolean" || !["add", "replace", "restore", "unchanged"].includes(String(action.mcpChange)))
    return unknown("`amem setup " + tool + " --json` did not return the setup plan it documents");
  if (action.available === false) return { ok: false, detail: `client missing: the ${tool} CLI is not installed, so there is nothing to set up` };
  const setup = `amem setup ${tool} --apply`;
  if (action.mcpChange !== "unchanged") {
    const state = typeof action.state === "string" ? action.state.slice(0, 60).replace(/[^\x20-\x7e]/g, "?") : "unknown";
    return { ok: false, detail: `not set up (${state}); run \`${setup}\`` };
  }
  const hooks = tool === "codex" ? "; newly registered hooks need the native /hooks review in Codex before they run (amem setup does not grant hook trust)" : "";
  return { ok: true, detail: `set up, per \`amem setup ${tool}\`${hooks}` };
}

export const DOCTOR_PLUGIN_PROBE = Object.freeze({ command: "claude", argv: Object.freeze(["plugin", "list", "--json"] as const), name: "claude plugin" });

/** Exact legacy section and severity classification, including non-native and unknown diagnostic names. */
export function nativeDoctorCheck(ok: boolean | undefined, name: string, detail: string): DoctorCheck {
  const nativeTool = nativeTools.some(tool => tool.id === name);
  const section: DoctorCheck["section"] = name === "bun" || nativeTool ? "Tools"
    : name === "config" || name === "retired setting" || name === "routing" ? "Config"
    : name.startsWith("memory") ? "Memory"
    : ["omniroute", "omniroute key", "routing model", "routing models", "pi mlx"].includes(name) ? "Models" : "Hub";
  const optional = nativeTool || ["ahub daemon", "pi mlx"].includes(name) || section === "Memory";
  const level: DoctorCheck["level"] = ok === undefined ? (name === "omniroute" ? "warn" : "unknown") : ok ? "ok" : optional ? "warn" : "fail";
  return { section, level, name, detail };
}

/** Recovery IDs are checked only for the two legacy native conversation surfaces. */
export function nativeDoctorRecoveryIdentity(peer: { id: string; state: string; sessionId?: string; threadId?: string }): { ok: boolean; name: string; detail: string } | undefined {
  const fields = { claude: "sessionId", codex: "threadId" } as const;
  const field = Object.hasOwn(fields, peer.id) ? fields[peer.id as keyof typeof fields] : undefined;
  if (!field || peer.state === "offline") return undefined;
  const identity = peer[field];
  return { ok: !!identity, name: `${peer.id} recovery ID`, detail: identity ? "recorded" : `missing; verify the current conversation and reconnect with ahub ${peer.id} before upgrading` };
}

export type NativeDoctorOptionalProbe =
  | { kind: "source-identity"; name: string; command: string[]; detail: string }
  | { kind: "jcode-mcp"; name: string; home: string }
  | { kind: "pinned-version"; name: string; command: string[]; compat: CompatId; confirmed: string; unconfirmed: string };

/** The host runs these existing checks in order; no process, filesystem or caller callback enters this planner. */
export function nativeDoctorOptionalProbes(config: { roster: Readonly<Record<string, boolean | undefined>>; jcode_cmd: string[]; qwen_cmd: string[]; jcode_home?: string;
  /** Declared extra instances (#685): a rostered Jcode instance's own home is inventoried like the base home. */
  instances?: Readonly<Record<string, { kind: string; jcode_home?: string }>> }): NativeDoctorOptionalProbe[] {
  const probes: NativeDoctorOptionalProbe[] = [];
  if (config.roster.jcode === true) probes.push({ kind: "source-identity", name: "jcode", command: config.jcode_cmd,
    detail: "CLI/source identity only; provider, project MCP and native teardown require separate receipts; native policy unmanaged" });
  // #572 AC4: jcode cannot be told which MCP servers to load, so the host lists the ones its config files name.
  if (config.roster.jcode === true && config.jcode_home) probes.push({ kind: "jcode-mcp", name: "jcode MCP servers", home: config.jcode_home });
  // #685: each extra instance has its own home, hence its own inventory. Names and homes only: no model source, URL or token.
  for (const [id, declaration] of Object.entries(config.instances ?? {})) {
    if (declaration.kind === "jcode" && declaration.jcode_home && config.roster[id] === true) probes.push({ kind: "jcode-mcp", name: `${id} MCP servers`, home: declaration.jcode_home });
  }
  if (config.roster.qwen === true) probes.push({ kind: "pinned-version", name: "qwen", command: config.qwen_cmd, compat: "qwen",
    confirmed: "CLI version verified; native ACP identity/modes and provider access require a separate live check",
    unconfirmed: "Qwen Code executable not confirmed; provider and ACP readiness unknown" });
  return probes;
}
