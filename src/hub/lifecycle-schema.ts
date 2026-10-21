import { ControlClient } from "./control-client.ts";
import { configuredToolContext, type ProjectToolContext } from "./hub-tools.ts";
import { SDLC_STAGES } from "./sdlc.ts";
/** The daemon owns the active definition. Unavailable reads never invent a project-file stage set. */
/** The active stage ids and whether the lifecycle is enabled (`criteria`, #481 S8); an older daemon never says so. */
export async function activeLifecycle(stateDir: string, peer: string, projectRoot: string, active?: ControlClient): Promise<({ stages: string[]; criteria: boolean } & ProjectToolContext) | undefined> {
  let client: ControlClient | undefined;
  try {
    client = active ?? await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot }, 1000);
    const reply = await client.request({ t: "status" }, 1000);
    if (reply.t !== "status" || !reply.status || typeof reply.status !== "object" || Array.isArray(reply.status)) return undefined;
    const projectTools = configuredToolContext(reply.status, peer);
    // A live older daemon has the fixed seven-stage contract and no optional metadata field.
    if (!Object.hasOwn(reply.status, "lifecycleStages")) return { stages: [...SDLC_STAGES], criteria: false, ...projectTools };
    const stages: unknown = reply.status.lifecycleStages;
    if (!Array.isArray(stages) || !stages.length || stages.length > 32 || stages.some(s => typeof s !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(s)) || new Set(stages).size !== stages.length) return undefined;
    return { stages: [...stages] as string[], criteria: reply.status.lifecycleCriteria === true, ...projectTools };
  } catch { return undefined; }
  finally { if (client !== active) client?.close(); }
}
export async function activeLifecycleStages(stateDir: string, peer: string, projectRoot: string, active?: ControlClient): Promise<string[] | undefined> {
  return (await activeLifecycle(stateDir, peer, projectRoot, active))?.stages;
}
