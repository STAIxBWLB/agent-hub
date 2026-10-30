// A fake ACP agent for the #445 C1 capability listing. Flags: --qwen (Qwen identity), --version <v>, --early (send the list before answering session/new, as a fast agent may),
// --foreign (also send a list for another session), --session <id>. A `session/prompt` is answered at once. Control line `{"relist":...}` is not used: the list is sent once per session.
import { createInterface } from "node:readline";
const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
const reply = (id: number, result: unknown) => send({ jsonrpc: "2.0", id, result });
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const qwen = process.argv.includes("--qwen"), version = arg("--version") ?? (qwen ? "0.26.1" : "2.3.2"), session = arg("--session") ?? "cmd-session";
const list = (id: string, commands: unknown[]) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "available_commands_update", availableCommands: commands } } });
const commands = qwen
  ? [{ name: "clear", description: "builtin", _meta: { source: "builtin-command" } }, { name: "review", description: "Review the diff.", _meta: { source: "bundled-skill" } }]
  : [{ name: "compact", description: "builtin" }, { name: "skill:review", description: "Review the diff." }];
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: 1, agentInfo: qwen ? { name: "qwen-code", version } : { name: "Kimi Code CLI", version } });
  else if (m.method === "session/new") {
    if (process.argv.includes("--foreign") || process.argv.includes("--only-foreign")) list("some-other-session", [{ name: "skill:intruder", description: "not ours" }]);
    const once = arg("--once"); // send our own list only the first time this file is absent: a restarted process sends none
    const silent = process.argv.includes("--only-foreign") || (once !== undefined && (await Bun.file(once).exists()));
    if (once !== undefined) await Bun.write(once, "1");
    if (process.argv.includes("--early") && !silent) list(session, commands);
    reply(m.id, { sessionId: session, modes: { currentModeId: "default", availableModes: ["default", "yolo", "auto", "auto-edit"].map(id => ({ id, name: id })) } });
    if (!process.argv.includes("--early") && !silent) list(session, commands);
    if (process.argv.includes("--foreign-after")) list("some-other-session", [{ name: "skill:intruder", description: "not ours, and late" }]);
  }
  else if (m.method === "session/set_mode") reply(m.id, {});
  else if (m.method === "session/prompt") reply(m.id, { stopReason: "end_turn" });
}
