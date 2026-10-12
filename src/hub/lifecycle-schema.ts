import { ControlClient } from "./control-client.ts";
import { SDLC_STAGES } from "./sdlc.ts";
/** The daemon owns the active definition. Unavailable reads never invent a project-file stage set. */
export async function activeLifecycleStages(stateDir: string, peer: string, projectRoot: string, active?: ControlClient): Promise<string[] | undefined> {
  let client: ControlClient | undefined;
  try {
    client = active ?? await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot }, 1000);
    const reply = await client.request({ t: "status" }, 1000);
    if (reply.t !== "status" || !reply.status || typeof reply.status !== "object" || Array.isArray(reply.status)) return undefined;
    // A live older daemon has the fixed seven-stage contract and no optional metadata field.
    if (!Object.hasOwn(reply.status, "lifecycleStages")) return [...SDLC_STAGES];
    const stages: unknown = reply.status.lifecycleStages;
    if (!Array.isArray(stages) || !stages.length || stages.length > 32 || stages.some(s => typeof s !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(s)) || new Set(stages).size !== stages.length) return undefined;
    return [...stages] as string[];
  } catch { return undefined; }
  finally { if (client !== active) client?.close(); }
}
