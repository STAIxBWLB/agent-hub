import type { CompatId } from "../compat.ts";
import type { DoctorCheck } from "../../cli/output.ts";

// Fixed builtin doctor policy only. These projections neither execute probes nor extend AdapterDefinition.
const nativeTools = [
  { id: "claude", initial: true }, { id: "codex", initial: true }, { id: "kimi", initial: true },
  { id: "qwen", initial: false }, { id: "jcode", initial: false },
] as const;
export const DOCTOR_TOOL_PROBES: readonly string[] = Object.freeze(["bun", ...nativeTools.filter(tool => tool.initial).map(tool => tool.id)]);
export const DOCTOR_MEMORY_CAPTURE_PEERS = Object.freeze(["codex", "kimi"] as const);
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
