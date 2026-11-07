// Bundles the Claude channel server into the plugin dir (the marketplace copies only that dir) and stamps the
// package version into the plugin manifest. `--check` fails when the committed bundle or manifest is stale.
import { readFileSync, writeFileSync } from "node:fs";

// Bun.build output differs between Bun versions, and CI builds with .bun-version: re-run once under that Bun (#591).
const pinned = readFileSync(".bun-version", "utf8").trim();
if (Bun.version !== pinned) {
  if (process.env.AHUB_BUILD_PINNED_BUN) {
    console.error(`build: bun x bun@${pinned} ran Bun ${Bun.version}; the bundle must be built with Bun ${pinned} (.bun-version)`);
    process.exit(1);
  }
  const run = Bun.spawnSync([process.execPath, "x", `bun@${pinned}`, "scripts/build.mjs", ...process.argv.slice(2)],
    { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, AHUB_BUILD_PINNED_BUN: "1" } });
  process.exit(run.exitCode ?? 1);
}

const out = "plugins/agent-hub/server.js";
const kimiHookOut = "plugins/agent-hub/kimi-hook.js";
const policyWorkerOut = "plugins/agent-hub/kimi-review-policy-worker.js";
const manifest = "plugins/agent-hub/.claude-plugin/plugin.json";
const roleNotice = readFileSync("templates/roles/NOTICE.md", "utf8");
const roleNoticeOut = "plugins/agent-hub/ROLE-NOTICE.md";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const result = await Bun.build({ entrypoints: ["src/adapters/claude-channel.ts", "src/cli/kimi-facts-hook.ts"], target: "bun", minify: false });
if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
const output = async (name) => {
  const found = result.outputs.find(candidate => candidate.path.endsWith(`/${name}`));
  if (!found) throw new Error(`build output missing: ${name}`);
  return found.text();
};
const code = await output("claude-channel.js");
const kimiHook = await output("kimi-facts-hook.js");
const policyWorker = await Bun.build({ entrypoints: ["src/adapters/kimi-review-policy-worker.ts"], target: "bun", minify: false });
if (!policyWorker.success) {
  console.error(policyWorker.logs.join("\n"));
  process.exit(1);
}
const policyWorkerCode = await policyWorker.outputs[0].text();
const stamped = `${JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }, null, 2)}\n`;

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

if (process.argv.includes("--check")) {
  const stale = [[out, code], [kimiHookOut, kimiHook], [policyWorkerOut, policyWorkerCode], [manifest, stamped], [roleNoticeOut, roleNotice]].filter(([file, want]) => read(file) !== want).map(([file]) => file);
  if (stale.length) {
    console.error(`${stale.join(", ")} stale against package.json ${version}: run "bun run build" and commit the result`);
    process.exit(1);
  }
} else {
  writeFileSync(roleNoticeOut, roleNotice);
  writeFileSync(out, code);
  writeFileSync(kimiHookOut, kimiHook);
  writeFileSync(policyWorkerOut, policyWorkerCode);
  writeFileSync(manifest, stamped);
  console.log(`built ${out} (${(code.length / 1024).toFixed(0)} KB), ${kimiHookOut} (${(kimiHook.length / 1024).toFixed(0)} KB), ${policyWorkerOut} (${(policyWorkerCode.length / 1024).toFixed(0)} KB), plugin ${version}`);
}
