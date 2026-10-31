export { autonomyEnvironment } from "../hub/autonomy.ts";
export const AUTONOMY_USAGE = "usage: ahub autonomy on [--all-projects] [--yes] | off [--all-projects] | status [--json]";
export interface AutonomyCliPorts {
  environment: string;
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  ask(prompt: string): Promise<string | null>;
  print(line: string): void;
  contextLines?: readonly string[];
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
    if (flag !== "--yes" && (await ports.ask("Apply project autonomy? Approval prompts change; sandboxes and trust stay in force. [y/N] "))?.trim().toLowerCase() !== "y") {
      ports.print("Project autonomy was not changed."); return;
    }
  }
  if (action === "on" || action === "off") await ports.beforeApply?.(action);
  let reply = await request(action);
  if (action === "status" && ports.decorateStatus) reply = await ports.decorateStatus(reply);
  if (action === "status" && args.includes("--json")) ports.print(JSON.stringify(reply.status));
  else for (const line of Array.isArray(reply.lines) ? reply.lines : typeof reply.text === "string" ? [reply.text] : []) if (typeof line === "string") ports.print(line);
}
