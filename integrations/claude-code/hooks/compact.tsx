/** View metadata only. No host calls, raw-output parsing or logical outcome inference. */
export interface CompactToolProps {
  tool: string;
  tool_use_id: string;
  input: unknown;
  isRunning: boolean;
  isErrored: boolean;
  isInterrupted: boolean;
  isExpanded?: boolean;
}
export const MAX_COMPACT_IDS = 64;
export const compactId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const toolName = /^(?:mcp__agent-hub__|mcp__plugin_agent-hub_agent-hub__)(hub_review|hub_task_done|hub_send|hub_delivery_done)$/;
export function compactHubToolRow(props: CompactToolProps): string | undefined {
  const match = typeof props.tool === "string" ? toolName.exec(props.tool) : null;
  const name = match?.[0] === props.tool ? match?.[1] : undefined;
  if (!name || !compactId(props.tool_use_id) || ![props.isRunning, props.isErrored, props.isInterrupted].every(value => typeof value === "boolean")) return undefined;
  const input = object(props.input) ? props.input : {};
  const task = ["hub_review", "hub_task_done"].includes(name) && Number.isSafeInteger(input.id) && Number(input.id) > 0 ? ` #${input.id}` : "";
  const state = props.isInterrupted ? "interrupted" : props.isErrored ? "error" : props.isRunning ? "running" : "returned";
  const requested = name === "hub_review" && typeof input.verdict === "string" && ["approved", "changes_requested"].includes(input.verdict) ? ` (requested ${input.verdict})` : "";
  const recipients = name === "hub_send" && Array.isArray(input.to) && input.to.length > 0 && input.to.length <= 8 && input.to.every(compactId) ? ` (requested to ${input.to.join(", ")})` : "";
  return `${name}${task}: ${state}${requested}${recipients}`;
}
/** Bounded session-only UI metadata; never retain input, output or a rendered original tree. */
export function compactIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(compactId))].slice(-MAX_COMPACT_IDS) : [];
}
export function toggledCompactIds(value: unknown, id: string): string[] {
  const ids = compactIds(value);
  return !compactId(id) ? ids : ids.includes(id) ? ids.filter(candidate => candidate !== id) : [...ids, id].slice(-MAX_COMPACT_IDS);
}
