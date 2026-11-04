import { join } from "node:path";

/** Source snippet for fixtures: inject only the flattened parent row; production marker and classifier still run. */
export function syntheticClaudeParentEvidenceSetup(): string {
  const port = join(import.meta.dir, "../../src/adapters/claude-channel-evidence.ts");
  return `import { claudeParentCommandPort } from ${JSON.stringify(port)}; claudeParentCommandPort.read = () => "claude --dangerously-load-development-channels plugin:agent-hub@agent-hub";`;
}
