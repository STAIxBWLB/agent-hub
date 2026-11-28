export const isClaudeSessionUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Stable leaf import for released statusline/CLI callers. Native policy belongs to the adapter.
export { claudePeer, claudeStateFile, ownTerminalRow, transcriptPersisted, pathEvidence } from "../adapters/definitions/native-channel-state.ts";
