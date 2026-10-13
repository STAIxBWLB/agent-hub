// Exercise native retries inside one logical run, followed by an unrelated personal run.
export {};
const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
const { default: extension } = await import(String(process.argv[2]));
let idle = true;
let nativeEvents: Promise<unknown> = Promise.resolve();
let finish!: () => void;
const stopped = new Promise<void>(resolve => { finish = resolve; });
const ctx = {
  isIdle: () => idle,
  sessionManager: { getHeader: () => ({ id: "continuation-session" }), getSessionFile: () => "/tmp/continuation-session.jsonl", getEntries: () => [] },
  shutdown: finish,
};
const end = (text: string, stopReason = "stop") => handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason, content: [{ type: "text", text }] }] });
extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerProvider: () => {}, registerTool: () => {},
  sendMessage: () => {
    idle = false;
    nativeEvents = Promise.resolve().then(async () => {
      await handlers.get("agent_start")!({});
      await end("retryable failure", "error");
      await handlers.get("agent_start")!({});
      await end("recovered answer");
      idle = true; await handlers.get("agent_settled")!({}, ctx);
      idle = false; await handlers.get("agent_start")!({});
      await end("personal answer");
      idle = true; await handlers.get("agent_settled")!({}, ctx);
    });
  } });
await handlers.get("session_start")!({}, ctx);
await stopped;
await nativeEvents;
console.log(JSON.stringify({ completed: true }));
process.exit(0);
