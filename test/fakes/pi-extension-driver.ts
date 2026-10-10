// Runs the real Pi extension (path in argv[2]) against the bridge in AGENTHUB_PI_BRIDGE_URL and
// prints each managed-tool result as one JSON line, so test/pi-tool-result.test.ts can assert the
// isError flags Pi 1.0.1 reads (#181). A separate process keeps the extension's module-level env
// hermetic from other test files that import it. Not imported by the hub.
export {};
const tools = new Map<string, { execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>();
const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
const { default: extension } = await import(String(process.argv[2]));
extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerProvider: () => {}, registerTool: (def: any) => tools.set(def.name, def) });
const read = tools.get("read");
if (!read) throw new Error("the read tool was not registered");
if (process.argv[3] === "lineage") {
  const ctx = { abort: () => console.log("UNEXPECTED_NATIVE_ABORT"), sessionManager: { getHeader: () => ({ id: "producer-session" }), getSessionFile: () => "/tmp/producer-session.jsonl" } };
  await handlers.get("session_start")!({}, ctx);
  await handlers.get("agent_start")!({});
  console.log(JSON.stringify(await read.execute("initial-lineage", { path: "read" })));
  const pending = read.execute("delayed-lineage", { path: "read" });
  await Bun.sleep(20);
  await handlers.get("agent_start")!({});
  console.log(JSON.stringify(await pending));
  process.exit(0);
}
if (process.argv[3] === "approvals") {
  const signal = new AbortController();
  const pending = read.execute("native-cancelled", { path: "cancelled" }, signal.signal);
  setTimeout(() => signal.abort(), 50);
  console.log(JSON.stringify(await pending));
  console.log(JSON.stringify(await handlers.get("user_bash")!({ command: "exit 7", cwd: process.cwd() })));
  process.exit(0);
}
for (const [toolCallId, path] of [["c1", "ok"], ["c2", "secret"], ["c3", "legacy"], ["c4", "refused"], ["c5", "stopped"]] as const) {
  try {
    console.log(JSON.stringify(await read.execute(toolCallId, { path })));
  } catch (error) {
    console.log(JSON.stringify({ thrown: (error as Error).message }));
  }
}

for (const [toolCallId, name] of [["c6", "write"], ["c7", "edit"], ["c8", "read"]] as const) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`the ${name} tool was not registered`);
  const params = name === "write" ? { path: "denied", content: "replacement" }
    : name === "edit" ? { path: "denied", old: "before", new: "after" } : { path: "cancelled" };
  try { console.log(JSON.stringify(await tool.execute(toolCallId, params))); }
  catch (error) { console.log(JSON.stringify({ thrown: (error as Error).message })); }
}
