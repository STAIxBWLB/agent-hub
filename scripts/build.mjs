// Bundles the Claude channel server into the plugin dir (the marketplace copies only that dir).
// `--check` fails when the committed bundle is stale.
import { readFileSync, writeFileSync } from "node:fs";

const out = "plugins/agent-hub/server.js";
const result = await Bun.build({ entrypoints: ["src/adapters/claude-channel.ts"], target: "bun", minify: false });
if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
const code = await result.outputs[0].text();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current !== code) {
    console.error(`${out} is stale: run "bun run build" and commit the result`);
    process.exit(1);
  }
} else {
  writeFileSync(out, code);
  console.log(`built ${out} (${(code.length / 1024).toFixed(0)} KB)`);
}
