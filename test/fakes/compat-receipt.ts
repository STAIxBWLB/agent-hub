/** Fixture executable only: no native CLI, package installer, network or model. */
import { appendFileSync, writeFileSync } from "node:fs";

const [mode, observed, leg] = process.argv.slice(2);
if (!mode || !observed || !leg) throw new Error("compat receipt fake requires mode, observation file and leg");
const homeKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "QWEN_HOME", "KIMI_CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
const sensitiveKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "PI_MODEL"];
appendFileSync(observed, JSON.stringify({ role: mode === "descendant" ? "descendant" : "proof", mode, leg, pid: process.pid, cwd: process.cwd(),
  homes: Object.fromEntries(homeKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  sensitiveKeys: sensitiveKeys.filter(key => process.env[key] !== undefined),
  parentCanarySeen: [...homeKeys, ...sensitiveKeys].some(key => process.env[key]?.includes("PARENT_RECEIPT_CANARY")),
}) + "\n");
if (mode === "hang" || mode === "descendant") {
  if (mode === "hang") {
    const child = Bun.spawn([process.execPath, import.meta.path, "descendant", observed, leg], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    writeFileSync(`${observed}.children.json`, JSON.stringify({ leader: process.pid, descendant: child.pid }));
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  if (mode === "model") writeFileSync(`${observed}.model-executed`, "a forbidden model leg was dispatched");
  const failed = mode === "fail";
  if (failed) process.stderr.write("UNTRUSTED_NATIVE_FAILURE_CANARY");
  console.log(JSON.stringify({ schemaVersion: 1, legs: { [leg]: { status: failed ? "fail" : "pass", cause: failed ? "proof-failed" : "ok" } } }));
  process.exitCode = failed ? 1 : 0;
}
