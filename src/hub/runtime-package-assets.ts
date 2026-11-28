/** Reviewed agent-mem dependency assets. Directory order followed by file order is the recovery digest order. */
export const MEMORY_RUNTIME_LAYOUTS = {
  "@staix/cli-output": { directories: ["src"], files: ["package.json", "README.md", "LICENSE"] },
  "@staix/mcp-stdio": { directories: ["src", "fixtures"], files: ["package.json", "README.md", "LICENSE"] },
  "@staix/agent-hosts": { directories: ["src", "fixtures"], files: ["package.json", "README.md", "LICENSE"] },
} as const;
