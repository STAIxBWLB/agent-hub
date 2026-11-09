import type { EngineInterface, Register, RenderElement } from "claude-code";
import { attentionLines } from "./attention.ts";
import { compactHubToolRow, compactIds, toggledCompactIds } from "./compact.tsx";
import { CompanionController, commandText } from "./controller.ts";
import { CompanionError, LIMITS, lines, type Reading } from "./status.ts";

const PANE = "agent-hub";
const READING = { plugin: "agent-hub-companion", key: "reading" } as const;
const COMPACT = { plugin: "agent-hub-companion", key: "compactRows" } as const;

async function realRoot($: EngineInterface) {
  const spelling = await $.session.root();
  const stat = await $.fs.stat(spelling, { resolve: true });
  if (stat.kind !== "dir" || !stat.realPath?.startsWith("/")) throw new CompanionError("binding");
  return stat.realPath;
}
function createController($: EngineInterface, selected: { root: string }): CompanionController {
  return new CompanionController({
    realRoot: async () => {
      const current = await realRoot($);
      // Bind to the session's root, never a cwd or node fallback.
      if (selected.root && selected.root !== current) throw new CompanionError("binding");
      selected.root = current;
      return current;
    },
    now: () => Date.now(),
    run: async call => {
      const started = Date.now();
      const result = await $.process.run([call.executable, ...call.argv], { cwd: call.cwd, timeoutMs: LIMITS.timeoutMs }).catch((error: unknown) => {
        if (Date.now() - started >= LIMITS.timeoutMs) throw new CompanionError("timeout");
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new CompanionError("missing_cli");
        throw new CompanionError("unknown");
      });
      if (result.isStdoutTruncated || result.isStderrTruncated) throw new CompanionError("oversized");
      if (new TextEncoder().encode(result.stdout + result.stderr).length > LIMITS.maxOutputBytes) throw new CompanionError("oversized");
      return result;
    },
    publish: async (reading: Reading) => { await $.state.set(READING, reading); },
    toggle: async () => {
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE });
      else await $.ui.open({ id: PANE, title: "agent-hub (fixture only)" });
    },
  });
}

/** Uses declared 2.1.319 host APIs only. Loading is optional and not native-qualified. */
export const register: Register = on => {
  let controller: CompanionController | undefined;
  const selected = { root: "" };
  let uiEpoch = 0, uiActive = true;
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "hub", description: "Read-only hub pane: /hub, /hub refresh, /hub console" });
    await (controller ??= createController($, selected)).event("session.start");
    return next(e);
  });
  on("command.run", { command: "hub" }, async ($, e) => {
    // A non-person origin cannot instantiate a controller or read even the root.
    const answer = e.origin.kind === "composer" ? await (controller ??= createController($, selected)).command(e.args, e.origin.kind, selected.root) : commandText(e.args, selected.root);
    return { text: selected.root || e.args !== "console" ? answer : "Hub project is unavailable. Run /hub refresh." };
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      try { await (controller ??= createController($, selected)).event("turn.end"); } catch { /* Display failures cannot replace the completed turn. */ }
    }
    return result;
  });
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      try { await (controller ??= createController($, selected)).event("tool.done", e.tool); } catch { /* Display failures cannot replace a tool result. */ }
    }
    return result;
  });
  on("session.end", async ($, e, next) => {
    uiEpoch++;
    if (e.reason === "clear") controller?.clearSession();
    else { controller?.disable(); uiActive = false; }
    try {
      const held = await $.state.get(COMPACT);
      if (compactIds(held.value?.expandedIds).length) await $.state.set(COMPACT, { expandedIds: [] });
    } catch { /* UI cleanup cannot replace the session end. */ }
    return next(e);
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (!uiActive || !["terminal", "desktop"].includes(e.surface) || e.props.hasSurvey !== false) return next(e);
    const epoch = uiEpoch;
    const { value } = await $.state.get(READING);
    if (!uiActive || epoch !== uiEpoch) return next(e);
    const rows = attentionLines(value ?? { state: "unknown" }, selected.root, Date.now());
    if (!rows.length) return next(e);
    const original = await next(e);
    if (!uiActive || epoch !== uiEpoch) return original;
    const { Box, Text } = $.ui.resolve(e);
    return h(Box, { flexDirection: "column" }, original, ...rows.map((line, i) => h(Text, { key: `attention-${i}` }, line))) as RenderElement;
  });
  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    if (!uiActive || !["terminal", "desktop", "vscode", "mobile"].includes(e.surface) || e.props.isExpanded === true || e.requestId !== e.props.tool_use_id) return next(e);
    const summary = compactHubToolRow(e.props);
    const toolUseId = e.props.tool_use_id;
    if (summary === undefined) return next(e);
    const epoch = uiEpoch;
    const { value } = await $.state.get(COMPACT);
    if (!uiActive || epoch !== uiEpoch) return next(e);
    const expanded = compactIds(value?.expandedIds).includes(toolUseId);
    const original = expanded ? await next(e) : undefined;
    if (!uiActive || epoch !== uiEpoch) return expanded ? original as RenderElement : next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    return h(Box, { flexDirection: "column" },
      h(Box, {}, h(Text, {}, summary), h(Button, {
        key: "toggle-original", label: expanded ? "Hide original" : "Show original",
        onPress: async () => {
          if (!uiActive || epoch !== uiEpoch) return;
          const held = await $.state.get(COMPACT);
          if (!uiActive || epoch !== uiEpoch) return;
          await $.state.set(COMPACT, { expandedIds: toggledCompactIds(held.value?.expandedIds, toolUseId) }, { ifVersion: held.version });
        },
      })), ...(original === undefined ? [] : [original])) as RenderElement;
  });
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const { value } = await $.state.get(READING);
    return h(Box, { flexDirection: "column" }, ...lines(value ?? { state: "unknown" }, Date.now()).map((line, i) => h(Text, { key: String(i) }, line))) as RenderElement;
  });
};
