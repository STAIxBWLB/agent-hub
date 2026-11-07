/** Protocol fixture compiled to a private fake cli-entry.js, never a real agent. */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { connect } from "node:net";

const metadata = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")) as { version: string; fixtureFault?: string };
const fault = metadata.fixtureFault, home = process.env.HOME!;
try { connect(9, "127.0.0.1"); throw new Error("fixture network was not denied"); }
catch (error) { if ((error as Error).message !== "model-free receipt refuses network") throw error; }
appendFileSync(join(home, "fixture-environment.jsonl"), JSON.stringify({ home, runtime: process.env.QWEN_RUNTIME_DIR, config: process.env.XDG_CONFIG_HOME,
  fixtureKey: process.env.OPENAI_API_KEY === "fixture-not-a-real-key", parentCanary: Object.values(process.env).some(value => value?.includes("PARENT_QWEN_CANARY")) }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; method: string; params: { modeId?: string; sessionId?: string } };
  appendFileSync(join(home, "fixture-methods.jsonl"), JSON.stringify({ method: request.method, ...request.params }) + "\n");
  let result: unknown;
  if (request.method === "initialize") result = { protocolVersion: fault === "protocol" ? 2 : 1, agentInfo: { name: fault === "identity" ? "other-agent" : "qwen-code", title: "Qwen Code", version: fault === "version" ? "0.0.0" : metadata.version },
    authMethods: [{ id: fault === "auth" ? "oauth" : "openai", _meta: { type: "terminal" } }] };
  else if (request.method === "session/new") result = { sessionId: "fixture-session", modes: { currentModeId: fault === "default-mode" ? "yolo" : "default",
    availableModes: (fault === "missing-mode" ? ["default", "yolo"] : ["default", "auto-edit", "yolo", "plan", "auto", "future-unmapped"]).map(id => ({ id })) },
    models: { currentModelId: "fixture-model-id", availableModels: [{ modelId: "fixture-model-id", name: fault === "model" ? "ambient-model" : "fixture-model" }] } };
  else if (request.method === "session/set_mode") {
    if (request.params.sessionId !== "fixture-session") throw new Error("mode request lost its session binding");
    if (fault === "mode-ack") { console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "fixture mode refusal" } })); continue; }
    result = {};
  } else throw new Error("fixture refuses any prompt, account or other RPC method");
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
