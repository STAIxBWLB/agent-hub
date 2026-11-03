import { homedir } from "node:os";
import type { AutonomyPeerStatus } from "../hub/autonomy.ts";
import type { ClaudeHomeCheck } from "./claude-homes.ts";

export { autonomyEnvironment } from "../hub/autonomy.ts";
export const AUTONOMY_USAGE = "usage: ahub autonomy on [--all-projects] [--yes] | off [--all-projects] | status [--json]";
export interface AutonomyCliPorts {
  environment: string;
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  ask(prompt: string): Promise<string | null>;
  print(line: string): void;
  contextLines?: readonly string[];
  confirmPrompt?: string;
  beforeApply?(action: "on" | "off"): Promise<void> | void;
  decorateStatus?(reply: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** Authority is checked by the ordinary CLI identity gate and independently by the daemon. */
export async function runAutonomy(args: string[], ports: AutonomyCliPorts): Promise<string | undefined> {
  const [action, flag, ...extra] = args;
  if (!action || !["on", "off", "status"].includes(action) || extra.length || flag !== undefined && !(action === "on" && flag === "--yes" || action === "status" && flag === "--json")) return AUTONOMY_USAGE;
  if (action !== "status") for (const line of ports.contextLines ?? []) ports.print(line);
  let confirmation: string | undefined;
  const request = async (action: string) => {
    const reply = await ports.request({ t: "autonomy", action, environment: ports.environment, ...(action === "on" ? { confirmed: true, confirmation } : {}) });
    if (reply.ok !== true) throw new Error(`${typeof reply.error === "string" ? reply.error : "autonomy request refused"}${reply.saved === true ? "; project configuration was saved; inspect ahub autonomy status or ahub settings undo" : ""}`);
    return reply;
  };
  if (action === "on") {
    const preview = await request("preview");
    if (typeof preview.confirmation !== "string" || !preview.confirmation) throw new Error("autonomy confirmation preview is unavailable; upgrade the running hub");
    confirmation = preview.confirmation;
    for (const line of Array.isArray(preview.lines) ? preview.lines : []) if (typeof line === "string") ports.print(line);
    if (flag !== "--yes" && (await ports.ask(ports.confirmPrompt ?? "Apply project autonomy? Approval prompts change; sandboxes and trust stay in force. [y/N] "))?.trim().toLowerCase() !== "y") {
      ports.print("Project autonomy was not changed."); return;
    }
  }
  let machineApplied = false;
  if (action === "on" || action === "off") { await ports.beforeApply?.(action); machineApplied = ports.beforeApply !== undefined; }
  let reply: Record<string, unknown>;
  try { reply = await request(action); }
  catch (error) {
    if (machineApplied) throw new Error(`${error instanceof Error ? error.message : String(error)}; Machine autonomy default was set to ${action}; project apply failed. Inspect ahub autonomy status before retrying.`);
    throw error;
  }
  if (action === "status" && ports.decorateStatus) reply = await ports.decorateStatus(reply);
  if (action === "status" && args.includes("--json")) ports.print(JSON.stringify(reply.status));
  else {
    const lines = action === "status" && reply.status && typeof reply.status === "object"
      ? renderAutonomyStatus(reply.status as Record<string, unknown>) : null;
    for (const line of lines ?? (Array.isArray(reply.lines) ? reply.lines : typeof reply.text === "string" ? [reply.text] : [])) if (typeof line === "string") ports.print(line);
  }
}

/** Human presentation only; the daemon report and JSON wire output stay unchanged. */
export function renderAutonomyStatus(status: Record<string, unknown>, home = homedir()): string[] | null {
  if (!Array.isArray(status.peers)) return null;
  const peers = status.peers as AutonomyPeerStatus[];
  const machine = status.machineDefault as { enabled: boolean; notice?: string } | undefined;
  const lines = [`Project autonomy · environment ${status.environment}${machine ? ` · machine default ${machine.enabled ? "on" : "off"}` : ""}`, ""];
  const rows = [["PEER", "NOW", "NEXT START"], ...peers.map(peer => [peer.id, peer.effectiveMode, peer.nextMode ?? "unmanaged"])];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  for (const row of rows) lines.push(row.map((value, column) => column < row.length - 1 ? value.padEnd(widths[column]!) : value).join("  "));

  const floors = new Map<string, { row: AutonomyPeerStatus["floor"][number]; peers: Set<string> }>();
  const classes = new Set<string>(), enforced = new Set<string>();
  const unknowns = new Map<string, Set<string>>();
  for (const peer of peers) {
    for (const row of peer.floor ?? []) {
      classes.add(row.class);
      if (row.status === "hub-enforced" || row.status === "structural-guard") enforced.add(row.class);
      const key = JSON.stringify([row.class, row.status, row.reason]);
      let group = floors.get(key);
      if (!group) { group = { row, peers: new Set() }; floors.set(key, group); }
      group.peers.add(peer.id);
    }
    for (const text of peer.missing ?? []) {
      if ((peer.floor ?? []).some(row => text.startsWith(`${row.class}: `))) continue;
      let group = unknowns.get(text);
      if (!group) { group = new Set(); unknowns.set(text, group); }
      group.add(peer.id);
    }
  }
  lines.push("", `Guarded actions (${classes.size} classes; ${enforced.size} enforced for at least one peer)`);
  for (const { row, peers: members } of floors.values()) {
    lines.push(`  ${row.class} · ${row.status} · ${members.size === peers.length ? "all peers" : [...members].join(", ")}`, `    ${row.reason}`);
  }
  if (unknowns.size) {
    lines.push("", "Unknowns");
    for (const [text, members] of unknowns) lines.push(`  ${[...members].join(", ")}: ${text}`);
  }
  if (machine?.notice) lines.push("", machine.notice);
  const notices = status.claudeHomeNotices as string[] | undefined;
  if (Array.isArray(status.claudeHomes) || notices?.length) {
    lines.push("", "Claude homes");
    for (const notice of notices ?? []) lines.push(`  ${notice}`);
    for (const profile of (status.claudeHomes ?? []) as ClaudeHomeCheck[]) {
      const path = profile.home.path;
      const display = path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
      lines.push(`  ${display}: plugin ${profile.plugin.state}; hook ${profile.hook.state}. ${profile.hook.reason}`);
    }
  }
  return lines;
}
