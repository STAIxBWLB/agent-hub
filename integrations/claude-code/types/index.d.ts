/** Public session-state contract. No host globals or persistence API declarations. */
export type AgentHubCompanionReading = {
  state: "running" | "stale" | "partial" | "offline" | "unavailable_version" | "unknown" | "binding" | "missing_cli" | "timeout" | "nonzero" | "oversized" | "unrecognized";
  fetchedAt?: number;
  version?: string;
  peers?: { id: string; state: string; queued?: number; attached?: boolean; needsReview?: number }[];
  tasks?: { state: string; count: number }[];
  board?: { id: number; publicTitle?: string; state?: string }[];
  missing?: string[];
};
declare module "claude-code" {
  interface PluginState { "agent-hub-companion": { reading: AgentHubCompanionReading } }
}
