import { join } from "node:path";

export const SYNTHETIC_CLAUDE_PARENT_COMMAND = "claude --dangerously-load-development-channels plugin:agent-hub@agent-hub";

/** Source snippet for fixtures: inject only the flattened parent row; production marker and classifier still run. */
export function syntheticClaudeParentEvidenceSetup(): string {
  const port = join(import.meta.dir, "../../src/adapters/claude-channel-evidence.ts");
  return `import { claudeParentCommandPort } from ${JSON.stringify(port)}; claudeParentCommandPort.read = () => ${JSON.stringify(SYNTHETIC_CLAUDE_PARENT_COMMAND)};`;
}
