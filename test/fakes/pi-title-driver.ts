// Executes the real extension against synchronous native title ports. No Pi CLI or model is started.
export {};
const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
let title: string | undefined;
const writes: string[] = [];
let finish!: () => void;
const stopped = new Promise<void>(resolve => { finish = resolve; });
const { default: extension } = await import(String(process.argv[2]));
extension({ on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => handlers.set(name, handler), registerProvider() {}, registerTool() {},
  getSessionName: () => title, setSessionName: (value: string) => { if (value === "THROW_NATIVE_TITLE_CANARY") throw new Error(value); title = value; writes.push(value); void handlers.get("session_info_changed")?.({}); } });
const { createInterface } = await import("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  if (line === "manual") { title = "person native name"; void (async () => { await handlers.get("session_info_changed")?.({}); await fetch(`${process.env.AGENTHUB_PI_BRIDGE_URL}/driver`, { method: "POST", body: "manual" }); })(); }
});
await handlers.get("session_start")!({}, { isIdle: () => true, shutdown: finish,
  sessionManager: { getHeader: () => ({ id: "title-session" }), getSessionFile: () => "/tmp/title-session.jsonl", getEntries: () => [] } });
await stopped;
console.log(JSON.stringify({ title, writes }));
process.exit(0);
