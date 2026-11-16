import { configuredPolicy, memoryHome, withCliAttribution } from "@staix/agent-mem";

/** Run an agent's memory commands in the public amem attribution and visibility scope. */
export async function withAgentAttribution<T>(peer: string, cwd: string, work: () => Promise<T>): Promise<T> {
  return withCliAttribution({ actor: "agent", peer, policy: () => configuredPolicy(memoryHome(), cwd) }, work);
}
