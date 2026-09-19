// Fake ACP agent over stdio. Echoes prompts in two chunks, rejects overlapping prompts with
// turn.agent_busy, asks permission when the prompt contains "PERMISSION", goes silent for 10 s on
// "SLOW" (until session/cancel), and fails the prompt on "BROKEN".
import { createInterface } from "node:readline";

const delay = Number(process.env.FAKE_ACP_DELAY_MS ?? 20);
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let cancel: (() => void) | undefined;
let nextId = 1000;
const waiting = new Map<number, (result: any) => void>();

async function prompt(id: number, text: string) {
  if (busy) return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "turn.agent_busy" } });
  busy = true;
  let verdict = "";
  if (text.includes("PERMISSION")) {
    const reqId = nextId++;
    const result = await new Promise<any>((resolve) => {
      waiting.set(reqId, resolve);
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { title: "write file" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    });
    verdict = ` permission=${result.outcome.optionId ?? result.outcome.outcome}`;
  }
  if (text.includes("BROKEN")) {
    busy = false;
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "session error" } });
  }
  if (text.includes("SLOW")) {
    const cancelled = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      cancel = () => (clearTimeout(timer), resolve(true));
    });
    busy = false;
    if (cancelled) {
      await sleep(delay); // the cancelled prompt reports late, after the next one may have started
      return send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  }
  await sleep(delay);
  const items = text.split('[agent-hub message from "').length - 1;
  const memo = text.includes("Shared project memory") ? " +memory" : "";
  for (const part of ["echo: ", text.split("\n").at(-1)! + verdict + (items > 1 ? ` (${items} items)` : "") + memo]) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } },
    });
  }
  busy = false;
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
  else if (msg.method === "session/cancel") cancel?.();
  else if (msg.method === "session/prompt") void prompt(msg.id, msg.params.prompt[0].text);
  else if (msg.id !== undefined && !msg.method) waiting.get(msg.id)?.(msg.result);
});
