import { createInterface } from "node:readline";

await import("./acp-server.ts");

// Install after the native fake so the extra observer cannot consume an early initialize before its handler exists.
// Qwen first acknowledges its startup mode. Only the subsequent prompt enables the fake's
// late-result-before-mode-ack barrier, so the test never deadlocks startup on its own future cancel.
createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).method === "session/prompt" && !process.argv.includes("--mode-after-cancel")) process.argv.push("--mode-after-cancel");
});
