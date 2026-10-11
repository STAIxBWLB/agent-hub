import { createInterface } from "node:readline";
const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
const reply = (id: number, result: unknown) => send({ jsonrpc: "2.0", id, result });
const update = (u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "watch-session", update: u } });
let promptId = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: 1, agentInfo: process.argv.includes("--qwen") ? { name: "qwen-code", version: "0.25.0" } : { name: "Kimi Code CLI", version: "2.1.1" } });
  else if (m.method === "session/new") reply(m.id, { sessionId: "watch-session", modes: { currentModeId: "default", availableModes: ["default", "yolo", "auto", "auto-edit"].map(id => ({ id, name: id })) } });
  else if (m.method === "session/set_mode") reply(m.id, {});
  else if (m.method === "session/prompt") {
    promptId = m.id;
    if (process.argv.includes("--pending-cancel")) {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PENDING_CANCEL_MARKER" } });
      update({ sessionUpdate: "usage_update", totalTokens: 1 });
      continue; // onTokens is the consuming-client barrier, no guessed timing sleep
    }
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "WATCH_ONLY_MARKER " } });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    for (const [id, kind] of [["read-1", "read"], ["edit-1", "edit"], ["run-1", "execute"]]) {
      update({ sessionUpdate: "tool_call", toolCallId: id, title: kind, kind, status: "in_progress", rawInput: kind === "execute" ? { command: "fixture command" } : { private: "WATCH_ONLY_MARKER" }, locations: [{ path: "source.ts" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: kind === "edit" ? [{ type: "diff", path: "source.ts", oldText: "old", newText: "new\nline" }] : [{ type: "content", content: { type: "text", text: "WATCH_ONLY_MARKER terminal output" } }] });
    }
    update({ sessionUpdate: "plan", entries: [{ content: "Plan complete", priority: "high", status: "completed" }] });
    send({ jsonrpc: "2.0", id: 901, method: "session/request_permission", params: { sessionId: "watch-session", toolCall: { toolCallId: "run-1", title: "execute", rawInput: { command: "fixture command" } }, options: [{ optionId: "no", kind: "reject_once", name: "Deny" }] } });
  } else if (m.id === 901 && m.result) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    reply(promptId, { stopReason: "end_turn" });
  }
}
