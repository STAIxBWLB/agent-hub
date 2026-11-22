#!/usr/bin/env bun
// Keep this entrypoint plain JavaScript: Node must fail before loading TypeScript or bun:sqlite.
const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.bun ?? "");
if (!version || !(Number(version[1]) > 1 || (Number(version[1]) === 1 && (Number(version[2]) > 4 || (Number(version[2]) === 4 && Number(version[3]) >= 4))))) {
  console.error("ahub: Bun >=1.4.4 is required. Install Bun: https://bun.sh");
  process.exit(1);
}

// An instructed child is confined to its inherited daemon IPC channel; a WebSocket cannot be substituted.
if (process.env.AGENTHUB_INSTRUCTED_IPC !== undefined) {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor() { throw new Error("WebSocket unavailable in an instructed child"); }
  };
}

// Shell completion asks on every Tab: answer from the help entries without loading the CLI (#603).
if (process.argv[2] === "__complete") {
  const { completeWords } = await import("./completion.ts");
  console.log(completeWords(process.argv.slice(process.argv[3] === "--" ? 4 : 3)).join("\n"));
} else await import("./main.ts");
