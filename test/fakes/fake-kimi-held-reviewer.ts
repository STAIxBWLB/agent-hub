import { appendFileSync, readFileSync } from "node:fs";

const [log, ...argv] = process.argv.slice(2);
if (!log) throw new Error("fixture log required");
if (argv.includes("--version")) { console.log("2.2.0"); process.exit(0); }
const home = process.env.KIMI_CODE_HOME;
if (!home) throw new Error("fixture private home required");
const agentFile = argv[argv.indexOf("--agent-file") + 1];
if (!agentFile) throw new Error("fixture agent file required");
const agent = readFileSync(agentFile, "utf8");
const task = Number(agent.match(/(?:Task|task) #(\d+)/)?.[1]);
if (!Number.isSafeInteger(task) || task < 1) throw new Error("fixture task framing unavailable");
await new Response(Bun.stdin.stream()).text();
appendFileSync(log, JSON.stringify({ home, task, pid: process.pid, peer: process.env.AGENTHUB_PEER_ID }) + "\n");
// The test holds this exact child/capability while real Tasks changes its review binding.
setInterval(() => {}, 1000);
