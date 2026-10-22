// #685: records what an owned Jcode process was started with (argv, peer id, launch id, native home), then
// becomes the shared fake Jcode unchanged. The shared fake is a packaged conformance file; this wrapper adds no behavior to it.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const record = args.includes("--record") ? args[args.indexOf("--record") + 1] : undefined;
if (record) {
  const role = args.includes("serve") ? "serve" : args.includes("acp") ? "acp" : args.includes("version") ? "version" : "other";
  appendFileSync(record, JSON.stringify({ kind: "launch", role, argv: args, peer: process.env.AGENTHUB_PEER_ID, launch: process.env.AGENTHUB_LAUNCH_ID, home: process.env.JCODE_HOME, socket: process.env.JCODE_SOCKET,
    compatBase: process.env.JCODE_OPENAI_COMPAT_API_BASE, compatKey: process.env.OPENAI_COMPAT_API_KEY, gatewayKey: process.env.OMNIROUTE_API_KEY }) + "\n");
}
await import("./jcode-agent.ts");
