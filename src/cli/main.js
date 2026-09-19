#!/usr/bin/env bun
// Keep this entrypoint plain JavaScript: Node must fail before loading TypeScript or bun:sqlite.
if (!process.versions.bun) {
  console.error("ahub: Bun >=1.3.0 is required. Install Bun: https://bun.sh");
  process.exit(1);
}

await import("./main.ts");
