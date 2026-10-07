// Runs the real Pi extension (path in argv[2]) against the bridge in AGENTHUB_PI_BRIDGE_URL, fires
// session_start and agent_start through the registered handlers, then executes the managed read tool
// argv[3] times, printing each result as one JSON line — so test/pi-ceiling.test.ts can assert the
// tool-step ceiling boundary (#179): which calls reached the bridge, the structured ceiling events,
// and the isError flags Pi 1.0.1 reads. AGENTHUB_PI_MAX_STEPS sets the ceiling. Same hermetic-process
// pattern as pi-extension-driver.ts (#181). Not imported by the hub.
export {};
const handlers = new Map<string, (...args: any[]) => unknown>();
const tools = new Map<string, { execute: (toolCallId: string, params: unknown) => Promise<unknown> }>();
const { default: extension } = await import(String(process.argv[2]));
extension({
  on: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn),
  registerProvider: () => {},
  registerTool: (def: any) => tools.set(def.name, def),
});
const ctx = {
  sessionManager: { getHeader: () => ({ id: "sess-ceiling" }), getSessionFile: () => "/tmp/sess-ceiling.jsonl", getEntries: () => [] },
  modelRegistry: undefined,
  shutdown: () => {},
  abort: () => {},
  isIdle: () => true,
};
await handlers.get("session_start")?.({}, ctx);
await handlers.get("agent_start")?.();
const read = tools.get("read");
if (!read) throw new Error("the read tool was not registered");
const execute = async (id: string) => {
  try { console.log(JSON.stringify(await read.execute(id, { path: id }))); }
  catch (error) { console.log(JSON.stringify({ thrown: (error as Error).message })); }
};
if (process.argv[4] === "reset-budget") {
  // At the legacy limit, shared-budget refusal must precede the step counter. The next admitted
  // invocation still rejects at count 3; a budget refusal must neither reset nor increment it.
  for (const id of ["t1-c1", "t1-c2", "t1-budget", "t1-cap"]) await execute(id);
  // The real producer handler opens generation 2 and resets both the counter and forced failure.
  await handlers.get("agent_start")?.();
  for (const id of ["t2-c1", "t2-c2"]) await execute(id);
  await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "new turn succeeded" }] }] });
  await execute("t2-cap");
} else {
  const n = Number(process.argv[3] ?? 0);
  for (let i = 1; i <= n; i++) await execute(`c${i}`);
}
await handlers.get("session_shutdown")?.();
process.exit(0);
