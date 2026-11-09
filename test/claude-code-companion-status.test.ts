import { describe, expect, test } from "bun:test";
import { CompanionController, type Ports, type Response } from "../integrations/claude-code/hooks/controller.ts";
import { CompanionError, LIMITS, aged, consoleCommand, lines, parse, bindStatus, projectReading, type Reading } from "../integrations/claude-code/hooks/status.ts";
import { FakeClaudeCompanionCli } from "./fakes/claude-code-companion-cli.ts";
const root = "/fixture/a b'; $(touch should-not-run)";
const binding = { root, projectId: "p_fixture" };
const registration = [{ root, id: binding.projectId }];
const status = { cwd: root, projectId: binding.projectId, version: "0.35.0", peers: { claude: { state: "idle", queued: 2, attached: true, needsReview: 1, doing: "PRIVATE" } }, tasks: { in_review: 1 }, detail: "PRIVATE" };
const response = (value: unknown) => ({ stdout: JSON.stringify(value), exitCode: 0 });
const completeRead = (): Response[] => [response(status)];
function harness(script: Response[] = completeRead()) {
  const cli = new FakeClaudeCompanionCli(script);
  let clock = 10000, selected = root, toggles = 0;
  const published: Reading[] = [];
  const ports: Ports = { realRoot: async () => selected, run: call => cli.run(call), now: () => clock, publish: value => { published.push(value); }, toggle: () => { toggles++; } };
  return { cli, ports, published, controller: new CompanionController(ports), tick: (value: number) => { clock += value; }, select: (value: string) => { selected = value; }, toggles: () => toggles };
}
describe("Claude companion closed projections", () => {
  test("status root stays literal; only counts and peers are copied", async () => {
    const h = harness(); await h.controller.refresh();
    expect(h.cli.calls.map(c => c.argv)).toEqual(["status"].map(kind => ["--project", root, kind, "--json"]));
    expect(h.cli.calls.every(c => c.cwd === root)).toBe(true);
    const projected = h.published[0]!;
    expect(Object.hasOwn(projected, "board")).toBe(false);
    expect(projected.tasks).toEqual([{ state: "in_review", count: 1 }]);
    expect(projected.missing).toContain("task list");
    expect(projected.missing).toContain("role-specific task list");
    expect(projected.missing).toContain("registration inventory");
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(JSON.stringify(projected)).not.toContain(root);
    expect(projected.missing).toContain("budget reason/reset time");
    expect(consoleCommand(root)).toBe("ahub --project '/fixture/a b'\\''; $(touch should-not-run)' console");
  });
  test("missing or mismatched daemon identity refuses and a pinned id cannot silently change", async () => {
    for (const value of [[], { ...status, projectId: undefined }, { ...status, cwd: "/foreign" }, { ...status, projectId: "" }]) {
      const h = harness([response(value)]); await h.controller.refresh();
      expect(h.cli.calls).toHaveLength(1); expect(h.published).toEqual([{ state: "binding" }]);
    }
    expect(() => bindStatus(status, root, "changed")).toThrow(CompanionError);
    const h = harness([response(status), response({ ...status, projectId: "p_replacement" })]);
    await h.controller.refresh(); h.tick(1001); await h.controller.refresh();
    expect(h.cli.calls).toHaveLength(2); expect(h.published.at(-1)).toEqual({ state: "binding" });
  });
  test("partial, unknown, stale and old version are distinct; absent is never zero", async () => {
    const partial = projectReading({ ...status, peers: { claude: { state: "new" } } }, binding, 100);
    expect(partial.state).toBe("partial"); expect(partial.peers).toEqual([{ id: "claude", state: "unknown" }]);
    expect(lines(partial, 101).join("\n")).toContain("queue unknown");
    expect(aged(partial, 60101).state).toBe("stale"); expect(aged(partial, 99).state).toBe("unknown");
    expect(aged({ state: "running", fetchedAt: 100 }, 101).state).toBe("running");
    expect(projectReading({ cwd: root, projectId: binding.projectId }, binding, 100).state).toBe("unavailable_version");
  });
  test("offline uses the exact real CLI stderr prefix, never a substring", async () => {
    for (const [stderr, exitCode, state] of [
      ["ahub: no hub running for /fixture/state (run: ahub up)\n", 1, "offline"],
      ["ahub: request failed: no hub running for /fixture/state\n", 1, "nonzero"],
      ["no hub running for /fixture/state\n", 1, "nonzero"],
      ["ahub: no hub running for /fixture/state\n", 2, "nonzero"],
    ] as const) {
      const h = harness(); const calls: string[] = [];
      h.ports.run = async call => { calls.push(call.argv[2]); return { stdout: "", stderr, exitCode }; };
      await h.controller.refresh(); expect(h.published).toEqual([{ state }]);
      expect(calls).toEqual(["status"]);
    }
  });
  test("malformed/schema/bytes/timeout/nonzero failures have fixed projection only", async () => {
    expect(() => parse("{" )).toThrow(CompanionError);
    expect(() => parse("한".repeat(LIMITS.maxOutputBytes))).toThrow(CompanionError);
    expect(() => projectReading({ ...status, cwd: "/foreign" }, binding, 1)).toThrow(CompanionError);
    for (const [reply, state] of [[{ stdout: "{", exitCode: 0 }, "unrecognized"], [{ stdout: "한".repeat(LIMITS.maxOutputBytes), exitCode: 0 }, "oversized"], [{ stdout: "", exitCode: 0, durationMs: 5001 }, "timeout"], [{ stdout: "PRIVATE", exitCode: 2 }, "nonzero"]] as const) {
      const h = harness(); h.ports.run = async () => reply; await h.controller.refresh(); expect(h.published).toEqual([{ state }]);
    }
  });
});
describe("event and gesture boundaries", () => {
  test("non-composer answers match composer without any process, state or UI effect", async () => {
    for (const argument of ["", "refresh", "console", "ui"]) {
      const h = harness();
      const answer = await h.controller.command(argument, "plugin", root);
      expect(h.cli.calls).toHaveLength(0); expect(h.published).toHaveLength(0); expect(h.toggles()).toBe(0);
      expect(await h.controller.command(argument, "composer", root)).toBe(answer);
      expect(h.toggles()).toBe(argument === "" ? 1 : 0);
      if (["console", "ui"].includes(argument)) expect(h.cli.calls).toHaveLength(0);
    }
  });
  test("only bounded event reads, interval and one inflight coalescing; no unsolicited loop", async () => {
    const h = harness(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); const run = h.ports.run;
    let entered!: () => void; const atRun = new Promise<void>(resolve => { entered = resolve; });
    h.ports.run = async call => { entered(); await wait; return run(call); };
    const first = h.controller.event("session.start"); await atRun;
    expect(h.controller.event("turn.end")).toBe(first);
    release(); await first; expect(h.cli.calls).toHaveLength(1);
    await h.controller.event("turn.end"); expect(h.cli.calls).toHaveLength(1);
    h.tick(1001); await h.controller.event("tool.done", "unrelated"); expect(h.cli.calls).toHaveLength(1);
  });

  test("long inflight events coalesce once, and a new selection survives the old finally", async () => {
    const h = harness([...completeRead(), ...completeRead()]);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); const run = h.ports.run;
    let firstCall = true; let entered!: () => void; const atRun = new Promise<void>(resolve => { entered = resolve; });
    h.ports.run = async call => { if (firstCall) { firstCall = false; entered(); await wait; } return run(call); };
    const first = h.controller.refresh(); await atRun;
    h.controller.refresh(); h.controller.refresh(); h.tick(2000); release(); await first;
    expect(h.cli.calls).toHaveLength(2); expect(h.published).toHaveLength(2);
    // A reset while an old result waits cannot overwrite the new selection.
    const race = harness(); let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; }); let old = true;
    let enteredOld!: () => void; const oldAtRun = new Promise<void>(resolve => { enteredOld = resolve; });
    race.ports.run = async call => { if (old) { old = false; enteredOld(); await held; return response(status); }
      return response({ ...status, cwd: "/new", projectId: "p_new" });
    };
    const previous = race.controller.refresh(); await oldAtRun;
    race.select("/new"); race.controller.reset(); const selectedRead = race.controller.refresh(); finish(); await Promise.all([previous, selectedRead]);
    expect(race.published).toHaveLength(1); expect(race.published[0]?.state).toBe("partial");
  });
  test("completed hub tool prefixes refresh, unrelated tool names do not", async () => {
    const h = harness([...completeRead(), ...completeRead()]);
    await h.controller.event("tool.done", "mcp__plugin_agent-hub_agent-hub__hub_status"); expect(h.cli.calls).toHaveLength(1);
    h.tick(1001); await h.controller.event("tool.done", "mcp__other__hub_status"); expect(h.cli.calls).toHaveLength(1);
    await h.controller.event("tool.done", "mcp__agent-hub__hub_task_done"); expect(h.cli.calls).toHaveLength(2);
  });
  test("held success/error and disable never republish an old binding", async () => {
    for (const failure of [false, true]) {
      const h = harness(); let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void; const atRun = new Promise<void>(resolve => { entered = resolve; });
      h.ports.run = async () => { entered(); await wait; if (failure) throw new Error("PRIVATE"); return response(status); };
      const first = h.controller.refresh(); await atRun;
      h.controller.disable(); release(); await first;
      expect(h.published).toHaveLength(0);
      await h.controller.refresh(); expect(h.published).toHaveLength(0);
    }
  });
  test("selection changes during a held read refuse; reset invalidates stale finally", async () => {
    const h = harness(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const atRun = new Promise<void>(resolve => { entered = resolve; });
    h.ports.run = async () => { entered(); await wait; return response(status); };
    const first = h.controller.refresh(); await atRun;
    h.select("/new"); release(); await first; expect(h.published).toEqual([{ state: "binding" }]);
    h.controller.reset(); h.controller.disable(); expect(h.published).toHaveLength(1);
  });
});

test("declared registration on a fake host: pane, pass-through events, no hidden persistence or non-composer effects", async () => {
  // Computed import keeps the separate host declaration universe out of Bun's globals.
  const moduleFile = new URL("../integrations/claude-code/hooks/register.tsx", import.meta.url).href;
  const { register } = await import(moduleFile);
  type Handler = (host: unknown, event: any, next: (event: any) => Promise<any>) => Promise<any>;
  const hooks = new Map<string, Handler>();
  register((name: string, matcher: unknown, handler?: Handler) => { hooks.set(name, (handler ?? matcher) as Handler); }, {});
  let effects = 0, open = false;
  let reading: Reading | undefined;
  const cli = new FakeClaudeCompanionCli(completeRead());
  const forbidden = () => { throw new Error("forbidden persistent or unrelated host access"); };
  const host = {
    session: { root: async () => { effects++; return root; } },
    fs: { stat: async (name: string, options: unknown) => { effects++; expect(name).toBe(root); expect(options).toEqual({ resolve: true }); return { kind: "dir", realPath: root }; } },
    process: { run: async (argv: string[], options: { cwd: string; timeoutMs: number }) => {
      effects++; expect(Object.keys(options).sort()).toEqual(["cwd", "timeoutMs"]);
      const result = await cli.run({ executable: argv[0]!, argv: argv.slice(1), cwd: options.cwd, timeoutMs: options.timeoutMs, maxOutputBytes: LIMITS.maxOutputBytes });
      return { ...result, stderr: result.stderr ?? "", isStdoutTruncated: false, isStderrTruncated: false };
    } },
    command: { register: async () => { effects++; } },
    state: { set: async (_ref: unknown, value: Reading) => { effects++; reading = value; }, get: async (ref: { key: string }) => ({ value: ref.key === "reading" ? reading : undefined, version: 0 }) },
    ui: { panes: async () => { effects++; return open ? [{ id: "agent-hub" }] : []; }, open: async () => { effects++; open = true; }, close: async () => { effects++; open = false; }, resolve: () => ({ Box: "Box", Text: "Text" }), log: forbidden },
    store: new Proxy({}, { get: forbidden }), settings: new Proxy({}, { get: forbidden }), clock: new Proxy({}, { get: forbidden }),
  };
  const invoke = (name: string, event: any, result: any = event) => hooks.get(name)!(host, event, async passed => { expect(passed).toBe(event); return result; });
  await invoke("command.run", { args: "refresh", origin: { kind: "plugin", name: "fixture" } }); expect(effects).toBe(0);
  const start = { cwd: root }; expect(await invoke("session.start", start)).toBe(start);
  expect(cli.calls).toHaveLength(1); expect(open).toBe(false); expect(reading?.state).toBe("partial");
  const before = effects;
  const expected = await invoke("command.run", { args: "console", origin: { kind: "composer" } });
  for (const kind of ["plugin", "sdk", "bridge", "unclassified"]) {
    expect(await invoke("command.run", { args: "console", origin: { kind } })).toEqual(expected);
  }
  expect(effects).toBe(before);
  const toolResult = { text: "UNCHANGED MODEL TOOL RESULT" };
  expect(await invoke("tool.call", { tool: "Read", agentId: undefined }, toolResult)).toBe(toolResult);
  expect(await invoke("turn.complete", { text: "UNCHANGED FINAL ANSWER", agentId: "subagent" }, toolResult)).toBe(toolResult);
  expect(hooks.has("session.receive")).toBe(false); expect(hooks.has("prompt.compose")).toBe(false);
  const previousH = Object.getOwnPropertyDescriptor(globalThis, "h");
  Object.defineProperty(globalThis, "h", { configurable: true, value: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) });
  try {
    const tree = await invoke("ui.render", { surface: "terminal", component: "Pane", requestId: "agent-hub" });
    expect(JSON.stringify(tree)).toContain("agent-hub: partial"); expect(JSON.stringify(tree)).not.toContain("PRIVATE");
  } finally { if (previousH) Object.defineProperty(globalThis, "h", previousH); else Reflect.deleteProperty(globalThis, "h"); }
  await invoke("command.run", { args: "", origin: { kind: "composer" } }); expect(open).toBe(true);
  await invoke("session.end", { reason: "exit" });
  const disabledEffects = effects; await invoke("command.run", { args: "refresh", origin: { kind: "composer" } }); expect(effects).toBe(disabledEffects);
  const freshHooks = new Map<string, Handler>();
  register((name: string, matcher: unknown, handler?: Handler) => { freshHooks.set(name, (handler ?? matcher) as Handler); }, {});
  host.process.run = async () => { throw Object.assign(new Error("PRIVATE"), { code: "ENOENT" }); };
  await freshHooks.get("session.start")!(host, start, async event => event);
  expect(reading).toEqual({ state: "missing_cli" });
});

async function lifecycleHost() {
  const moduleFile = new URL("../integrations/claude-code/hooks/register.tsx", import.meta.url).href;
  const { register } = await import(moduleFile);
  type Handler = (host: unknown, event: any, next: (event: any) => Promise<any>) => Promise<any>;
  const hooks = new Map<string, Handler>();
  register((name: string, matcher: unknown, handler?: Handler) => { hooks.set(name, (handler ?? matcher) as Handler); }, {});
  const calls: string[][] = [], readings: Reading[] = [];
  let currentRoot = root, currentProjectId = binding.projectId, effects = 0;
  let held: { enter(): void; wait: Promise<void>; failure: boolean } | undefined;
  const forbidden = () => { throw new Error("forbidden persistence or timer"); };
  const host = {
    session: { root: async () => { effects++; return currentRoot; } },
    fs: { stat: async () => { effects++; return { kind: "dir", realPath: currentRoot }; } },
    process: { run: async (argv: string[]) => {
      effects++; calls.push([...argv]);
      const gate = held; held = undefined;
      if (gate) { gate.enter(); await gate.wait; if (gate.failure) throw new Error("PRIVATE"); }
      if (argv[3] !== "status") throw new Error("forbidden command");
      const value = { ...status, projectId: currentProjectId };
      return { stdout: JSON.stringify(value), stderr: "", exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false };
    } },
    command: { register: async () => { effects++; } },
    state: { set: async (_ref: unknown, value: Reading) => { effects++; readings.push(value); }, get: async (ref: { key: string }) => ({ value: ref.key === "reading" ? readings.at(-1) : undefined, version: 0 }) },
    ui: { panes: async () => { effects++; return []; }, open: async () => { effects++; }, close: async () => { effects++; }, log: forbidden },
    store: new Proxy({}, { get: forbidden }), settings: new Proxy({}, { get: forbidden }), clock: new Proxy({}, { get: forbidden }),
  };
  const invoke = (name: string, event: any) => hooks.get(name)!(host, event, async passed => { expect(passed).toBe(event); return passed; });
  return { calls, readings, invoke, effects: () => effects,
    root: (value: string) => { currentRoot = value; }, projectId: (value: string) => { currentProjectId = value; },
    hold: (failure: boolean) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      held = { enter, wait, failure }; return { entered, release };
    },
    refresh: (mode: string) => mode === "composer" ? invoke("command.run", { args: "refresh", origin: { kind: "composer" } })
      : mode === "turn" ? invoke("turn.complete", { reason: "answer", agentId: undefined, text: "unchanged" })
      : invoke("tool.call", { tool: "mcp__plugin_agent-hub_agent-hub__hub_status", agentId: undefined }),
  };
}

test("clear resumes composer and event refresh without another session start, while real exit stays disabled", async () => {
  for (const mode of ["composer", "turn", "hub"]) {
    const h = await lifecycleHost(); await h.invoke("session.start", {});
    const before = h.effects(); await h.invoke("session.end", { reason: "clear" });
    expect(h.effects()).toBe(before); // Clear itself starts no read or UI/state effect.
    const calls = h.calls.length;
    await h.invoke("command.run", { args: "refresh", origin: { kind: "plugin" } }); expect(h.effects()).toBe(before);
    await h.refresh(mode); expect(h.calls.length - calls).toBe(1); expect(h.readings.at(-1)?.state).toBe("partial");
    await h.invoke("session.end", { reason: "prompt_input_exit" }); const stopped = h.effects();
    await h.invoke("command.run", { args: "", origin: { kind: "composer" } });
    await h.invoke("session.end", { reason: "clear" }); await h.refresh(mode);
    expect(h.effects()).toBe(stopped); // Clear cannot revive a real exit.
  }
});

test("clear retires held success and error before a subsequent conversation refresh", async () => {
  for (const failure of [false, true]) {
    const h = await lifecycleHost(); await h.invoke("session.start", {});
    await h.invoke("session.end", { reason: "clear" });
    const gate = h.hold(failure), oldRead = h.refresh("composer"); await gate.entered;
    await h.invoke("session.end", { reason: "clear" });
    const before = h.effects(); await h.invoke("command.run", { args: "refresh", origin: { kind: "sdk" } }); expect(h.effects()).toBe(before);
    const nextRead = h.refresh("turn"); gate.release(); await Promise.all([oldRead, nextRead]);
    expect(h.readings).toHaveLength(2); expect(h.readings.every(reading => reading.state === "partial")).toBe(true);
    expect(JSON.stringify(h.readings)).not.toContain("PRIVATE");
  }
});

test("clear preserves the established root and daemon projectId rather than rebinding foreign data", async () => {
  for (const drift of ["root", "projectId"]) {
    const h = await lifecycleHost(); await h.invoke("session.start", {});
    await h.invoke("session.end", { reason: "clear" });
    if (drift === "root") h.root("/foreign"); else h.projectId("p_foreign");
    const before = h.calls.length; await h.refresh("composer");
    expect(h.readings.at(-1)).toEqual({ state: "binding" });
    expect(h.calls.length - before).toBe(drift === "root" ? 0 : 1);
  }
});

test("status-only read set never requests realistic oversized board or global project inventories", async () => {
  const unwantedBoard = Array.from({ length: 850 }, (_, id) => ({ id: id + 1, title: `Task ${id}`, state: "in_progress", detail: "PRIVATE_DETAIL".repeat(350), plan: { files: ["PRIVATE_PATH"], steps: ["PRIVATE_PLAN"] }, refs: ["PRIVATE_REF"], history: [{ note: "PRIVATE_NOTE".repeat(20) }] }));
  const unwantedProjects = Array.from({ length: 300 }, (_, id) => ({ root: `/fixture/project-${id}`, id: `p_${id}`, peers: { claude: { state: "idle", doing: "PRIVATE_DOING".repeat(100) } } }));
  const boardRaw = JSON.stringify(unwantedBoard), projectsRaw = JSON.stringify(unwantedProjects);
  expect(unwantedBoard.length).toBeGreaterThan(LIMITS.maxRows); expect(unwantedProjects.length).toBeGreaterThan(LIMITS.maxRows);
  expect(new TextEncoder().encode(boardRaw).length).toBeGreaterThan(LIMITS.maxOutputBytes);
  expect(new TextEncoder().encode(projectsRaw).length).toBeGreaterThan(LIMITS.maxOutputBytes);
  for (const oversized of ["board", "projects"]) {
    const h = harness(); const commands: string[] = [];
    h.ports.run = async call => {
      const command = String(call.argv[2]); commands.push(command);
      if (command === "status") return response(status);
      if (command === "projects") return oversized === "projects" ? { stdout: projectsRaw, exitCode: 0 } : response(registration);
      if (command === "board") return { stdout: boardRaw, exitCode: 0 };
      throw new Error("unexpected command");
    };
    await h.controller.refresh();
    expect(commands).toEqual(["status"]);
    expect(h.published[0]?.state).toBe("partial");
    expect(JSON.stringify(h.published)).not.toContain("PRIVATE");
    expect(Object.hasOwn(h.published[0]!, "board")).toBe(false);
  }
});
