// A fake Qwen Code TUI that speaks dual output (#286 Part 3): no model, no network, no real home. It reads the input file the way Qwen's RemoteInput does (from the file's size at
// start, complete lines only) and appends JSONL events to the event file, with the same event shapes Qwen 0.26.1 wrote in the T0 receipt (docs/verification/2026-10-25-qwen-dual-output-t0.md).
//
// Behaviour is scripted by the text of each submit:
//   TOOL:<name>:<json>   asks for approval (control_request can_use_tool); on allow runs the tool and answers; on deny emits NOTHING (the receipt's gap) and goes idle
//   STALL                emits the user event and then goes silent (a running turn that never settles); an `ESC` file next to the input ends it silently, as Esc does
//   ESCAPED              emits the user event and ends the turn with no assistant and no message_stop
//   NOTIFY               a background shell finished mid-turn: a tool_use message, then Qwen's own `<task-notification>` user event (the shape Qwen 0.26.1 wrote 48 times in the live
//                        event files, #517), then the answer. NOTIFYAFTER answers first and emits the notice after the turn has ended, with nothing following it.
//   anything else        answers "echo: <text>"
// A `confirmation_response` for an id that was already answered gets control_response error, as the receipt shows. `--tui-answer <ms>` answers the first approval itself after that delay
// (the person pressing Enter in the TUI): control_response success for that request_id.
import { appendFileSync, existsSync, openSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const input = flag("--input-file")!, events = flag("--json-file")!, version = flag("--fake-version") ?? process.env.FAKE_QWEN_VERSION ?? "0.26.1";
const resume = flag("-r") ?? flag("--resume");
const sessionId = resume ?? process.env.FAKE_QWEN_SESSION ?? randomUUID();
const tuiAnswerMs = flag("--tui-answer") === undefined ? undefined : Number(flag("--tui-answer"));
if (args.includes("--version")) { console.log(version); process.exit(0); }
const out = (event: Record<string, unknown>) => appendFileSync(events, `${JSON.stringify({ uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, ...event })}\n`);
const system = { type: "system", subtype: "session_start", data: { session_id: sessionId, cwd: process.cwd(), protocol_version: 2, version, supported_events: ["system", "user", "assistant", "stream_event", "result", "control_request", "control_response"] } };
if (!args.includes("--no-events")) { if (!existsSync(events)) writeFileSync(events, ""); out(system); }
writeFileSync(`${input}.pid`, String(process.pid));

let offset = existsSync(input) ? statSync(input).size : 0;   // RemoteInput starts at the current end: earlier submits are never replayed
const queue: string[] = [];
const waiting = new Map<string, (allowed: boolean) => void>();
const settled = new Set<string>();
let busy = false;

const assistant = (text: string, stop: "end_turn" | "tool_use") => {
  out({ type: "assistant", message: { id: randomUUID(), type: "message", role: "assistant", model: "fake", content: text ? [{ type: "text", text }] : [], stop_reason: stop, usage: {} } });
  out({ type: "stream_event", event: { type: "message_stop" } });
};
const userEvent = (text: string) => out({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
// One text block, task id, kind and status, then the detail lines: the shape of the real one.
const notification = () => userEvent(`<task-notification>\n<task-id>bg_${randomUUID().slice(0, 8)}</task-id>\n<kind>shell</kind>\n<status>completed</status>\n<summary>Shell command "sleep 1" completed.</summary>\n<command>sleep 1</command>\n<cwd>/tmp</cwd>\n<pid>1</pid>\n<exit-code>0</exit-code>\n<output-file>/tmp/out</output-file>\n</task-notification>`);

async function runTurn(text: string): Promise<void> {
  busy = true;
  userEvent(text);
  const body = text.split("\n").filter(line => !line.startsWith("[agent-hub")).join("\n");
  const tool = /TOOL:([^:\s]+):(\{.*\})/.exec(body);
  if (tool) {
    const requestId = randomUUID(), name = tool[1]!, toolInput = JSON.parse(tool[2]!);
    out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: name, tool_use_id: `toolu_${requestId.slice(0, 8)}`, input: toolInput, permission_suggestions: null, blocked_path: null } });
    const allowed = await new Promise<boolean>(resolve => {
      waiting.set(requestId, resolve);
      if (tuiAnswerMs !== undefined) setTimeout(() => { if (waiting.delete(requestId)) { settled.add(requestId); out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { allowed: true } } }); resolve(true); } }, tuiAnswerMs);
    });
    if (!allowed) { busy = false; return; }   // a deny cancels the whole turn and emits nothing at all
    assistant("", "tool_use");
    assistant(`ran ${name}`, "end_turn");
  } else if (body.includes("NOTIFYAFTER")) {
    assistant(`echo: ${body.slice(0, 200)}`, "end_turn");
    notification();            // after the turn ended, and nothing follows it
  } else if (body.includes("NOTIFY")) {
    assistant("", "tool_use");   // the model asked for a tool and Qwen runs it
    notification();            // the background shell ends meanwhile: Qwen tells the model, inside the same turn
    assistant(`echo: ${body.slice(0, 200)}`, "end_turn");
  } else if (body.includes("STALL")) {
    while (!existsSync(`${input}.esc`)) await Bun.sleep(25);
  } else if (body.includes("ESCAPED")) {
    // the person pressed Esc: the turn simply ends
  } else assistant(`echo: ${body.slice(0, 200)}`, "end_turn");
  busy = false;
}

function readInput(): void {
  const size = statSync(input).size;
  if (size < offset) offset = 0;
  if (size <= offset) return;
  const fd = openSync(input, "r"); const buffer = Buffer.alloc(size - offset);
  try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
  const end = buffer.lastIndexOf(10) + 1;
  if (end === 0) return;
  offset += end;
  for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let cmd: any; try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd?.type === "submit" && typeof cmd.text === "string") queue.push(cmd.text);
    else if (cmd?.type === "confirmation_response" && typeof cmd.request_id === "string" && typeof cmd.allowed === "boolean") {
      const resolve = waiting.get(cmd.request_id);
      // The receipt: allowed:true answers control_response success; allowed:false cancels the whole turn and writes NOTHING.
      if (resolve) { waiting.delete(cmd.request_id); settled.add(cmd.request_id); if (cmd.allowed) out({ type: "control_response", response: { subtype: "success", request_id: cmd.request_id, response: { allowed: true } } }); resolve(cmd.allowed); }
      else out({ type: "control_response", response: { subtype: "error", request_id: cmd.request_id, error: "unknown request_id (already resolved, cancelled, or never issued)" } });
    }
  }
}

setInterval(() => { try { readInput(); } catch { /* the file is being replaced */ } if (!busy && queue.length) void runTurn(queue.shift()!); }, 25);
process.on("SIGTERM", () => process.exit(0));
