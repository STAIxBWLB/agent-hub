import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
// Every caller launches a fresh hub-owned profile. Model only native 1.5 usage, never a quota/error frame.
const sessionId = `session_${randomUUID()}`, sessionDir = join(home, "sessions", "wd_fixture", sessionId), agentDir = join(sessionDir, "agents", "main");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ sessionId, sessionDir }) + "\n");
writeFileSync(join(agentDir, "wire.jsonl"), JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 }) + "\n"
  + JSON.stringify({ type: "usage.record", agentId: "main", model: "fixture", usage: { inputOther: 3, output: 2, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: "turn", time: Date.now() }) + "\n");
appendFileSync(log, JSON.stringify({ home, task, pid: process.pid, peer: process.env.AGENTHUB_PEER_ID }) + "\n");
// The test holds this exact child/capability while real Tasks changes its review binding.
setInterval(() => {}, 1000);
