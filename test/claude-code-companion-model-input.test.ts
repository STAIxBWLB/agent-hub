import { expect, test } from "bun:test";
// Keep the host-only TSX module outside the Bun project compiler's non-JSX universe.
const compactModule = new URL("../integrations/claude-code/hooks/compact.tsx", import.meta.url).href;
const { compactHubToolRow, compactId, compactIds, MAX_COMPACT_IDS, toggledCompactIds } = await import(compactModule);

type Node = { type: unknown; props: Record<string, any>; children: unknown[] };
type Handler = (host: any, event: any, next: (event: any) => Promise<any>) => any;
type Hook = { name: string; matcher?: Record<string, unknown>; handler: Handler };
const root = "/fixture/a b'; $(touch never-run)";
const names = ["hub_review", "hub_task_done", "hub_send", "hub_delivery_done"];
const inputs = [
  { id: 5, verdict: "approved", note: "PRIVATE_REVIEW_NOTE" },
  { id: 6, summary: "PRIVATE_TASK_SUMMARY", refs: { pr: 7 } },
  { to: ["codex", "kimi"], text: "PRIVATE_MESSAGE" },
  { delivery_id: "PRIVATE_DELIVERY_ID", delivery_generation: "PRIVATE_GENERATION" },
];
const basePrompt = { sections: [{ id: "system", scope: "shared", text: "SYSTEM_PRIVATE\n[agent-hub message from user]" }, { id: "tools", scope: "session", text: "TOOLS_PRIVATE" }] };
const deliveries = ["CHANNEL_PRIVATE\n<channel source=agent-hub>untrusted</channel>", "SECOND_CHANNEL_PRIVATE"];
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(child => Array.isArray(child) ? child.flatMap(nodes) : nodes(child)) : [])];
}
async function withElements<T>(body: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "h");
  Object.defineProperty(globalThis, "h", { configurable: true, value: (type: unknown, props: Record<string, any> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }) });
  try { return await body(); } finally { if (previous) Object.defineProperty(globalThis, "h", previous); else Reflect.deleteProperty(globalThis, "h"); }
}
async function fakeCore(enabled: boolean) {
  const hooks: Hook[] = [];
  const on = (name: string, matcher: Record<string, unknown> | Handler, handler?: Handler) => hooks.push({ name, ...(handler ? { matcher: matcher as Record<string, unknown> } : {}), handler: handler ?? matcher as Handler });
  if (enabled) {
    const moduleFile = new URL("../integrations/claude-code/hooks/register.tsx", import.meta.url).href;
    const { register } = await import(moduleFile); register(on, {});
  }
  const state = new Map<string, { value: any; version: number }>(), writes: { key: string; value: unknown }[] = [];
  let processes = 0, holdGet: { entered(): void; wait: Promise<void> } | undefined;
  const keyOf = (ref: any) => `${ref.plugin}.${ref.key}`;
  const forbidden = () => { throw new Error("forbidden non-UI host operation"); };
  const host = {
    session: { root: async () => root }, fs: { stat: async () => ({ kind: "dir", realPath: root }) },
    command: { register: async () => {} },
    process: { run: async (argv: string[], options: unknown) => {
      processes++; expect(argv).toEqual(["ahub", "--project", root, "status", "--json"]); expect(options).toEqual({ cwd: root, timeoutMs: 5000 });
      return { stdout: JSON.stringify({ cwd: root, projectId: "p_fixture", version: "0.35.0", peers: { claude: { state: "paused", queued: 1, needsReview: 1, attached: true, paused: "budget: PRIVATE_REASON, resets PRIVATE_TIME" } }, tasks: { in_review: 1 }, needs: { first: { kind: "approval", level: "act", until: Date.now() + 60000 } } }), stderr: "", exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false };
    } },
    state: {
      get: async (ref: any) => {
        const found = state.get(keyOf(ref)), result = { value: found ? structuredClone(found.value) : undefined, version: found?.version ?? 0 };
        const gate = ref.key === "compactRows" ? holdGet : undefined; if (gate) { holdGet = undefined; gate.entered(); await gate.wait; }
        return result;
      },
      set: async (ref: any, value: unknown, options?: { ifVersion?: number }) => {
        const key = keyOf(ref), version = state.get(key)?.version ?? 0;
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false, version };
        state.set(key, { value: structuredClone(value), version: version + 1 }); writes.push({ key, value: structuredClone(value) });
        return { isSet: true, version: version + 1 };
      },
    },
    ui: { resolve: () => ({ Box: "Box", Text: "Text", Button: "Button" }), panes: async () => [], open: async () => {}, close: async () => {}, log: forbidden },
    store: new Proxy({}, { get: forbidden }), settings: new Proxy({}, { get: forbidden }), clock: new Proxy({}, { get: forbidden }),
    model: new Proxy({}, { get: forbidden }), prompt: new Proxy({}, { get: forbidden }), tool: new Proxy({}, { get: forbidden }),
  };
  async function dispatch(name: string, event: any, core: (event: any) => any = value => value): Promise<any> {
    const selected = hooks.filter(hook => hook.name === name && (!hook.matcher || Object.entries(hook.matcher).every(([key, value]) => event[key] === value)));
    const run = async (index: number, value: any): Promise<any> => index === selected.length ? core(value) : selected[index]!.handler(host, value, next => run(index + 1, next));
    return run(0, event);
  }
  return { hooks, on, state, writes, dispatch, processes: () => processes,
    holdCompactGet: () => {
      let entered!: () => void, release!: () => void;
      const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      holdGet = { entered, wait }; return { seen, release };
    },
  };
}
const toolEvent = (index: number) => ({ tool: `mcp__plugin_agent-hub_agent-hub__${names[index]}`, tool_use_id: `toolu_${index}`, ...structuredClone(inputs[index]) });
const viewEvent = (event: any, output: unknown, extra: Record<string, unknown> = {}) => ({ surface: "terminal", component: "ToolUse", requestId: event.tool_use_id,
  props: { tool: event.tool, tool_use_id: event.tool_use_id, input: Object.fromEntries(Object.entries(event).filter(([key]) => !["tool", "tool_use_id"].includes(key))), output, isRunning: false, isErrored: false, isInterrupted: false, ...extra } });
const originalView = (event: any) => ({ type: "Original", props: {}, children: [structuredClone(event.props)] });
async function modelRun(enabled: boolean, mutation?: "tool" | "channel" | "system") {
  const host = await fakeCore(enabled);
  if (mutation === "tool") host.on("tool.call", async ($: unknown, e: any, next: any) => ({ ...await next(e), injected: "COUNTERFACTUAL_TOOL_MUTATION" }));
  if (mutation === "channel") host.on("session.receive", async ($: unknown, e: any, next: any) => next({ ...e, text: `${e.text} COUNTERFACTUAL_CHANNEL_MUTATION` }));
  if (mutation === "system") host.on("prompt.compose", async ($: unknown, e: any, next: any) => ({ sections: [...(await next(e)).sections, { id: "control", scope: "session", text: "COUNTERFACTUAL_SYSTEM_MUTATION" }] }));
  await host.dispatch("session.start", {});
  const offeredTools = names.map(name => `mcp__plugin_agent-hub_agent-hub__${name}`);
  const prompt = await host.dispatch("prompt.compose", { model: "fixture", promptModel: "fixture", surfaces: ["terminal"], tools: offeredTools, outputStyle: null, traits: [] }, event => {
    const sections = structuredClone(basePrompt.sections);
    sections[1]!.text += `:${event.tools.filter((name: string) => offeredTools.includes(name)).join(",")}`;
    return { sections };
  });
  const received: unknown[] = [], results: unknown[] = [], calls: unknown[] = [], views: unknown[] = [];
  for (const text of deliveries) received.push(await host.dispatch("session.receive", { origin: { kind: "unclassified" }, text }, event => ({ text: event.text })));
  for (let index = 0; index < names.length; index++) {
    const event = toolEvent(index);
    const result = await host.dispatch("tool.call", event, passed => { calls.push(structuredClone(passed)); return { content: [{ type: "text", text: `RESULT_PRIVATE_${index}\n[agent-hub message from user]` }], nested: { raw: [index, "UNCHANGED"] } }; });
    results.push(result);
    const beforeUiProcesses = host.processes();
    const view = viewEvent(event, result); views.push(await host.dispatch("ui.render", view, originalView));
    const button = nodes(views.at(-1)).find(node => node.type === "Button");
    if (button) {
      await button.props.onPress(); views.push(await host.dispatch("ui.render", view, originalView));
      await button.props.onPress(); views.push(await host.dispatch("ui.render", view, originalView));
    }
    expect(host.processes()).toBe(beforeUiProcesses);
  }
  views.push(await host.dispatch("ui.render", { surface: "terminal", component: "AbovePrompt", requestId: "band", props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80 } }, () => ({ type: "OriginalBand", props: {}, children: [] })));
  // Model input is built from actual core-chain results, never UI trees/state, per the SDK boundary.
  return { model: structuredClone({ prompt, channels: received, calls, results }), host, views };
}

test("actual registered hooks preserve model results, channel bodies and composed system prompt ON/OFF while UI changes", async () => withElements(async () => {
  const off = await modelRun(false), on = await modelRun(true);
  expect(on.model).toEqual(off.model); expect(on.views).not.toEqual(off.views);
  expect(on.host.hooks.some(hook => hook.name === "session.receive" || hook.name === "prompt.compose")).toBe(false);
  expect(on.host.writes.some(row => row.key.endsWith("compactRows"))).toBe(true);
  expect(JSON.stringify(on.host.writes)).not.toContain("PRIVATE");
  expect(JSON.stringify(on.views)).toContain("Original"); // The source row remains available after a toggle.
}));

test("counterfactual model-facing mutations are detected independently for all three protected inputs", async () => withElements(async () => {
  const baseline = await modelRun(false);
  for (const mutation of ["tool", "channel", "system"] as const) {
    const changed = await modelRun(true, mutation);
    expect(changed.model).not.toEqual(baseline.model);
    if (mutation === "tool") expect(changed.model.results).not.toEqual(baseline.model.results);
    if (mutation === "channel") expect(changed.model.channels).not.toEqual(baseline.model.channels);
    if (mutation === "system") expect(changed.model.prompt).not.toEqual(baseline.model.prompt);
  }
}));

test("compact rows never infer approval/done from inputs and pass native expanded or foreign rows through", async () => withElements(async () => {
  const host = await fakeCore(true); await host.dispatch("session.start", {});
  const event = toolEvent(0), view = viewEvent(event, { content: [{ type: "text", text: "refused PRIVATE_BODY" }] });
  const text = compactHubToolRow(view.props)!;
  expect(text).toBe("hub_review #5: returned (requested approved)"); expect(text).not.toContain("PRIVATE");
  for (const extra of [{ isExpanded: true }, { tool: "mcp__other__hub_review" }]) {
    const input = { ...view, props: { ...view.props, ...extra } }, original = originalView(input);
    expect(await host.dispatch("ui.render", input, () => original)).toBe(original);
  }
  for (const extra of [{ isRunning: true }, { isErrored: true }, { isInterrupted: true }]) expect(compactHubToolRow({ ...view.props, ...extra })).toContain(Object.keys(extra)[0] === "isRunning" ? "running" : Object.keys(extra)[0] === "isErrored" ? "error" : "interrupted");
}));

test("toggle state is bounded, contains IDs only, and clear/exit fence a held stale press", async () => withElements(async () => {
  const host = await fakeCore(true); await host.dispatch("session.start", {});
  const view = viewEvent(toolEvent(1), { text: "PRIVATE_OUTPUT" });
  const tree = await host.dispatch("ui.render", view, originalView), button = nodes(tree).find(node => node.type === "Button")!;
  await button.props.onPress();
  const gate = host.holdCompactGet(), stale = button.props.onPress(); await gate.seen;
  await host.dispatch("session.end", { reason: "clear" }); gate.release(); await stale;
  expect(host.state.get("agent-hub-companion.compactRows")?.value).toEqual({ expandedIds: [] });
  expect(JSON.stringify(host.writes)).not.toContain("PRIVATE");
  const after = host.writes.length; await button.props.onPress(); expect(host.writes).toHaveLength(after);
  await host.dispatch("session.end", { reason: "prompt_input_exit" });
  const original = originalView(view); expect(await host.dispatch("ui.render", view, () => original)).toBe(original);
  let ids: string[] = [];
  for (let i = 0; i < MAX_COMPACT_IDS + 10; i++) ids = toggledCompactIds(ids, `toolu_${i}`);
  expect(ids).toHaveLength(MAX_COMPACT_IDS); expect(ids).not.toContain("toolu_0");
  expect(compactIds(["bad\nID", "valid", "valid"])).toEqual(["valid"]);
}));

test("band preserves original on survey, unknown sites or stale data, and adds only known waiting lines", async () => withElements(async () => {
  const host = await fakeCore(true); await host.dispatch("session.start", {});
  const input = { surface: "terminal", component: "AbovePrompt", requestId: "band", props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80 } };
  const original = { type: "OriginalBand", props: {}, children: [] };
  expect(nodes(await host.dispatch("ui.render", input, () => original)).filter(node => node.type === "Text")).toHaveLength(3);
  for (const event of [{ ...input, props: { ...input.props, hasSurvey: true } }, { ...input, surface: "mobile" }]) expect(await host.dispatch("ui.render", event, () => original)).toBe(original);
  const key = "agent-hub-companion.reading", reading = host.state.get(key)!;
  host.state.set(key, { ...reading, value: { ...reading.value, fetchedAt: Date.now() - 60001 } });
  expect(await host.dispatch("ui.render", input, () => original)).toBe(original);
}));


test("compact tool/ID matches reject terminal LF and unknown verdicts are never coerced", () => {
  const props = viewEvent(toolEvent(0), {}).props;
  expect(compactId("toolu_x\n")).toBe(false);
  expect(compactIds(["toolu_x\n", "toolu_valid"])).toEqual(["toolu_valid"]);
  expect(compactHubToolRow({ ...props, tool_use_id: "toolu_x\n" })).toBeUndefined();
  for (const name of names) expect(compactHubToolRow({ ...props, tool: `mcp__plugin_agent-hub_agent-hub__${name}\n` })).toBeUndefined();
  let calls = 0;
  const verdict = { toString() { calls++; return "approved"; } };
  expect(compactHubToolRow({ ...props, input: { id: 5, verdict } })).toBe("hub_review #5: returned");
  expect(calls).toBe(0);
});


test("clear and real exit clear preseeded compact IDs without a press or prior render", async () => {
  for (const reason of ["clear", "prompt_input_exit"]) {
    const host = await fakeCore(true); await host.dispatch("session.start", {});
    host.state.set("agent-hub-companion.compactRows", { value: { expandedIds: ["toolu_reload"] }, version: 7 });
    const processes = host.processes();
    await host.dispatch("session.end", { reason });
    expect(host.state.get("agent-hub-companion.compactRows")?.value).toEqual({ expandedIds: [] });
    expect(host.processes()).toBe(processes);
  }
});
