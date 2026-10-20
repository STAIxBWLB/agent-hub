#!/usr/bin/env bun
// Keep this entrypoint plain JavaScript: Node must fail before loading TypeScript or bun:sqlite.
const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.bun ?? "");
if (!version || !(Number(version[1]) > 1 || (Number(version[1]) === 1 && (Number(version[2]) > 4 || (Number(version[2]) === 4 && Number(version[3]) >= 2))))) {
  console.error("ahub: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}

// Shell completion asks on every Tab: answer from the help entries without loading the CLI (#603).
if (process.argv[2] === "__complete") {
  const { completeWords } = await import("./completion.ts");
  console.log(completeWords(process.argv.slice(process.argv[3] === "--" ? 4 : 3)).join("\n"));
} else await import("./main.ts");
