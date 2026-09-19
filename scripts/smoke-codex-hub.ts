// Live Codex legs through a running hub (`ahub up` first, in a scratch git repo): the hub task tools over MCP, then
// turn/steer into a running turn. This script stands in for the Codex TUI. Usage: bun scripts/smoke-codex-hub.ts
import { ControlClient, stateDirFor } from "../src/hub/control-client.ts";
const cwd = process.cwd();
const hub = await ControlClient.connect(stateDirFor(cwd), { role: "console" });
const events: any[] = [];
hub.onPush = (m) => { if (m.t === "event") events.push(m.e); if (m.t === "notice") console.log("  *", m.line.slice(0, 160)); };
hub.send({ t: "tail" });
const started = await hub.request({ t: "start", peer: "codex" });
if (!started.ok) throw new Error(started.error);
const tui = new WebSocket(started.proxyUrl);
const seen: any[] = [];
tui.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  seen.push(m);
  if (m.id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd } })); }
  else if (m.id !== undefined && m.method) { console.log("  approval asked:", m.method, JSON.stringify(m.params).slice(0, 140)); tui.send(JSON.stringify({ id: m.id, result: { decision: "accept" } })); }
  else if (m.method === "mcpServer/startupStatus/updated" && m.params.name === "agent-hub") console.log("  mcp agent-hub:", m.params.status);
};
await new Promise((r) => (tui.onopen = r));
tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-hub-live", title: "agent-hub live", version: "0" } } }));
const until = async (cond: () => boolean, what: string, ms = 180_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout: " + what); await Bun.sleep(250); } };
const peerState = async () => (await hub.request({ t: "status" })).status.peers.codex?.state;
await until(() => seen.some((m) => m.id === 2 && m.result?.thread?.id), "thread");
const threadId = seen.find((m) => m.id === 2).result.thread.id;
await Bun.sleep(6000); // MCP servers finish starting

console.log("== leg A: a task for codex, to be handled with the hub's MCP tools");
const proposed = await hub.request({ t: "task", op: "hub_task_propose", args: { class: "test", owner: "codex", title: "Read words.ts (read only) and report how many exported constants it has. Use the agent-hub MCP tools hub_task_accept and hub_task_done for this task." } });
console.log("  ", proposed.text);
const id = Number(/#(\d+)/.exec(proposed.text)![1]);
await until(() => events.some((e) => e.t === "envelope" && e.env.from === "codex"), "codex answer");
const show = JSON.parse((await hub.request({ t: "task", op: "task_show", args: { id } })).text);
console.log("   history:", show.history.map((h: any) => `${h.by}:${h.event}`).join(", "), "| state:", show.state);
console.log("   codex said:", events.find((e) => e.t === "envelope" && e.env.from === "codex").env.body.slice(0, 160).replace(/\n/g, " "));

console.log("== leg B: steer a running turn");
while ((await peerState()) !== "idle") await Bun.sleep(300);
const before = events.length;
tui.send(JSON.stringify({ id: 50, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Without using any tools, write the numbers 1 to 25, one per line, each followed by a seven-word sentence about that number. Take your time." }] } }));
while ((await peerState()) !== "busy") await Bun.sleep(100);
await Bun.sleep(2500);
const sent = await hub.request({ t: "send", body: "[IMPORTANT] Stop the list now. End your answer with the exact line: STEERED-BY-HUB", to: ["codex"] });
const queuedRightAfter = (await hub.request({ t: "status" })).status.peers.codex.queued;
console.log("   sent:", JSON.stringify(sent.targets), "| queued right after:", queuedRightAfter, "(0 means it went in as turn/steer)");
await until(() => events.slice(before).some((e) => e.t === "envelope" && e.env.from === "codex"), "steered answer");
const answer = events.slice(before).find((e) => e.t === "envelope" && e.env.from === "codex").env;
console.log("   final answer ends with:", JSON.stringify(answer.body.trim().split("\n").slice(-2).join(" | ").slice(-120)), "| lines:", answer.body.trim().split("\n").length, "| hop", answer.hop);
console.log("   leaked hub ids to the TUI side:", seen.some((m) => typeof m.id === "number" && m.id < 0));
tui.close(); hub.close(); process.exit(0);
