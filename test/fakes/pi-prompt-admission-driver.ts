// Drives the real extension while the test independently delays its snapshot ACK and lifecycle POST.
export {};
const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
const { default: extension } = await import(String(process.argv[2]));
let idle = true, sent = 0;
let nativeEvents: Promise<unknown> = Promise.resolve();
let finish!: () => void;
const stopped = new Promise<void>(resolve => { finish = resolve; });
const ctx = {
  isIdle: () => idle,
  sessionManager: { getHeader: () => ({ id: "prompt-session" }), getSessionFile: () => "/tmp/prompt-session.jsonl", getEntries: () => [] },
  shutdown: finish,
};
extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerProvider: () => {}, registerTool: () => {},
  sendMessage: () => {
    sent++; if (process.argv[3] !== "deferred") idle = false;
    if (process.argv[3] === "sequential") nativeEvents = nativeEvents.then(() => handlers.get("agent_start")!({})).then(() => { idle = true; return handlers.get("agent_settled")!({}, ctx); });
  } });
const { createInterface } = await import("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  if (line === "start") { idle = false; void handlers.get("agent_start")!({}); }
});
await handlers.get("session_start")!({}, ctx);
await stopped;
await nativeEvents;
console.log(JSON.stringify({ sent }));
process.exit(0);
