import type { EngineInterface, Register, RenderElement } from "claude-code";
import { CompanionController, commandText } from "./controller.ts";
import { CompanionError, LIMITS, lines, type Reading } from "./status.ts";

const PANE = "agent-hub";
const READING = { plugin: "agent-hub-companion", key: "reading" } as const;

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
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") controller?.clearSession();
    else controller?.disable();
    return next(e);
  });
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const { value } = await $.state.get(READING);
    return h(Box, { flexDirection: "column" }, ...lines(value ?? { state: "unknown" }, Date.now()).map((line, i) => h(Text, { key: String(i) }, line))) as RenderElement;
  });
};
