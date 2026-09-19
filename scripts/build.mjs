// Bundles the Claude channel server into the plugin dir (the marketplace copies only that dir) and stamps the
// package version into the plugin manifest. `--check` fails when the committed bundle or manifest is stale.
import { readFileSync, writeFileSync } from "node:fs";

const out = "plugins/agent-hub/server.js";
const manifest = "plugins/agent-hub/.claude-plugin/plugin.json";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const result = await Bun.build({ entrypoints: ["src/adapters/claude-channel.ts"], target: "bun", minify: false });
if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
const code = await result.outputs[0].text();
const stamped = `${JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }, null, 2)}\n`;

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

if (process.argv.includes("--check")) {
  const stale = [[out, code], [manifest, stamped]].filter(([file, want]) => read(file) !== want).map(([file]) => file);
  if (stale.length) {
    console.error(`${stale.join(", ")} stale against package.json ${version}: run "bun run build" and commit the result`);
    process.exit(1);
  }
} else {
  writeFileSync(out, code);
  writeFileSync(manifest, stamped);
  console.log(`built ${out} (${(code.length / 1024).toFixed(0)} KB), plugin ${version}`);
}
