import { autonomyPreset, validateAutonomyPreset, type AutonomyPreset } from "../hub/autonomy.ts";
export const AUTONOMY_USAGE = "usage: ahub autonomy on [--yes] | off | status [--json]";
export interface AutonomyCliPorts {
  environment: string;
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  ask(prompt: string): Promise<string | null>;
  print(line: string): void;
}
export function autonomyEnvironment(env: NodeJS.ProcessEnv, terminal: boolean, preset: AutonomyPreset = autonomyPreset()): string {
  if (validateAutonomyPreset(preset).length) throw new Error("autonomy preset is invalid");
  const matching = Object.entries(preset.environments).filter(([, row]) => (!row.detect.variable || !!env[row.detect.variable]) && (row.detect.terminal === undefined || row.detect.terminal === terminal))
    .sort((a, b) => a[1].detect.priority - b[1].detect.priority);
  if (!matching[0] || matching[1]?.[1].detect.priority === matching[0][1].detect.priority) throw new Error("autonomy environment is missing or ambiguous");
  return matching[0][0];
}
/** Authority is checked by the ordinary CLI identity gate and independently by the daemon. */
export async function runAutonomy(args: string[], ports: AutonomyCliPorts): Promise<string | undefined> {
  const [action, flag, ...extra] = args;
  if (!action || !["on", "off", "status"].includes(action) || extra.length || flag !== undefined && !(action === "on" && flag === "--yes" || action === "status" && flag === "--json")) return AUTONOMY_USAGE;
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
    if (flag !== "--yes" && (await ports.ask("Apply project autonomy? Approval prompts change; sandboxes and trust stay in force. [y/N] "))?.trim().toLowerCase() !== "y") {
      ports.print("Project autonomy was not changed."); return;
    }
  }
  const reply = await request(action);
  if (action === "status" && args.includes("--json")) ports.print(JSON.stringify(reply.status));
  else for (const line of Array.isArray(reply.lines) ? reply.lines : typeof reply.text === "string" ? [reply.text] : []) if (typeof line === "string") ports.print(line);
}
