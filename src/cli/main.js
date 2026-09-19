#!/usr/bin/env bun
// Keep this entrypoint plain JavaScript: Node must fail before loading TypeScript or bun:sqlite.
const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.bun ?? "");
if (!version || !(Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 3))) {
  console.error("ahub: Bun >=1.3.0 is required. Install Bun: https://bun.sh");
  process.exit(1);
}

await import("./main.ts");
