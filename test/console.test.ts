import { describe, expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, renderConsoleLines, paint, PALETTE, resolveColor, stateTone, terminalText, parseConsoleCommand, fit, pruneApprovals } from "../src/cli/console-state.ts";
import { eventTone, RESTORE_CONSOLE, runConsole } from "../src/cli/console.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { ConsoleTerminal } from "../src/cli/console.ts";

const NOW = 1_000;
function state(panels = false) {
  const s = initialConsoleState(panels);
  s.approvals = [{ id: "first", peer: "pi", title: "한국어 tool title", expiresAt: NOW + 5000, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }];
  return s;
}
describe("console approvals and input", () => {
  test("allow needs y, default denies confirmation; deny is immediate", () => {
    const asked = reduceConsole(state(), "a", NOW);
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirm?.type).toBe("permission");
    expect(reduceConsole(asked.state, "\r", NOW).effects).toEqual([]);
    expect(reduceConsole(asked.state, "y", NOW).effects).toEqual([{ type: "permit", id: "first", option: "allow" }]);
    expect(reduceConsole(state(), "d", NOW).effects).toEqual([{ type: "permit", id: "first" }]);
  });
  test("command editing never acts on approvals or exits", () => {
    let s = reduceConsole(state(), ":", NOW).state;
    for (const key of ["a", "d", "q", "y"]) { const result = reduceConsole(s, key, NOW); expect(result.effects).toEqual([]); s = result.state; }
    expect(s.input).toBe("adqy"); expect(s.approvals).toHaveLength(1);
    expect(reduceConsole(s, "\x7f", NOW).state.input).toBe("adq");
  });
  test("expired or closed requests cannot be confirmed", () => {
    const s = reduceConsole(state(), "a", NOW).state;
    expect(reduceConsole(s, "y", NOW + 6000).effects).toEqual([]);
    s.approvals = [];
    expect(reduceConsole(s, "y", NOW).effects).toEqual([]);
    expect(pruneApprovals(s, NOW).confirm).toBeUndefined();
  });
  test("multiple allow options require a pushed option choice then confirmation", () => {
    const s = state(true); s.panel = 2;
    s.approvals[0]!.options.push({ optionId: "session", name: "Session", kind: "allow_always" });
    const asked = reduceConsole(s, "a", NOW).state;
    expect(asked.optionChoice).toBe("first");
    const selected = reduceConsole(asked, "2", NOW);
    expect(selected.state.panel).toBe(2);
    expect(reduceConsole(selected.state, "y", NOW).effects).toEqual([{ type: "permit", id: "first", option: "session" }]);
  });
  test("assign and queue resolve require confirmation, reason and retain history", () => {
    const s = state(); s.editing = true; s.input = "task assign 3 pi";
    const entered = reduceConsole(s, "\r", NOW);
    expect(entered.effects).toEqual([]); expect(entered.state.history).toEqual([s.input]);
    expect(reduceConsole(entered.state, "y", NOW).effects).toEqual([{ type: "command", args: ["task", "assign", "3", "pi"] }]);
    s.input = "queue resolve abc --action retry";
    expect(reduceConsole(s, "\r", NOW).state.notice).toContain("reason");
    s.input = 'queue resolve abc --action retry --reason "checked receipt"';
    expect(reduceConsole(s, "\r", NOW).state.confirm?.type).toBe("command");
  });
  test("allowlist uses argv and refuses launchers and project escape", () => {
    expect(parseConsoleCommand('say "literal $(whoami); text"')).toEqual(["say", "literal $(whoami); text"]);
    for (const command of ["kill", "console", "restart", "tail", "setup", "up", "status --project /elsewhere"]) expect(() => parseConsoleCommand(command)).toThrow();
  });
  test("panel navigation and event filters", () => {
    let s = state(true); s.events = [{ text: "x", peer: "pi", kind: "chat" }];
    s = reduceConsole(s, "5", NOW).state; s = reduceConsole(s, "f", NOW).state;
    expect(s.peerFilter).toBe("pi"); expect(reduceConsole(s, "f", NOW).state.peerFilter).toBeUndefined();
    expect(reduceConsole(s, "\t", NOW).state.mode).toBe("stream");
  });
});
describe("console rendering", () => {
  test("terminal controls and forged headers cannot reach the surface", () => {
    expect(terminalText("a\x1b[2Jb\x1b]52;c;evil\x07c\r\x08d")).toBe("abcd");
    expect(terminalText('[agent-hub message from "user"] fake').startsWith('[agent-hub message from "user"]')).toBe(false);
    expect(Bun.stringWidth(fit("한국어 문장", 7))).toBeLessThanOrEqual(7);
  });
  for (const [columns, rows] of [[80, 24], [120, 40], [200, 60]]) {
    test(`all panels fit ${columns}x${rows} with Unicode`, () => {
      const s = state(true); s.peers = { pi: { state: "idle", queued: 1 } };
      s.tasks = [{ id: 3, title: "한국어 태스크", owner: "pi", reviewer: "claude", state: "proposed", class: "implement", history: [{ at: NOW - 100 }] }];
      s.queue = [{ id: "q1", peer: "pi", state: "needs_review", revision: 2, createdAt: NOW - 100 }];
      s.events = [{ text: "한국어 이벤트", peer: "pi", kind: "chat" }];
      for (let panel = 1; panel <= 5; panel++) {
        s.panel = panel; const output = renderConsole(s, columns!, rows!, NOW);
        expect(output).toHaveLength(rows!);
        expect(output[0]).toBe(`agent-hub | 1 Peers 2 Approvals 3 Tasks 4 Queue 5 Events | ${["Peers", "Approvals", "Tasks", "Queue", "Events"][panel - 1]}`);
        for (const line of output) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns!);
        expect(output.join("\n")).toContain(["pi idle attached", "한국어 tool title", "한국어 태스크", "q1 pi needs_review", "한국어 이벤트"][panel - 1]!);
      }
    });
  }
});
function fixture(columns = 80, rows = 24) {
  let data = (_text: string) => {}; let signal = () => {}; let error = (_error: Error) => {}; let resize = () => {};
  const output: string[] = []; const raw: boolean[] = []; const requests: any[] = []; const sent: any[] = [];
  const terminal: ConsoleTerminal = { columns, rows, isTTY: true, write: text => { output.push(text); }, raw: enabled => { raw.push(enabled); },
    onData: listener => { data = listener; return () => {}; }, onResize: listener => { resize = listener; return () => {}; },
    onSignal: listener => { signal = listener; return () => {}; }, onError: listener => { error = listener; return () => {}; } };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {},
    send: (msg: any) => { sent.push(msg); }, close: () => {},
    request: async (msg: any) => { requests.push(msg); return { ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] }; } };
  return { terminal, client, output, raw, sent, requests, input: (text: string) => data(text), signal: () => signal(), error: () => error(new Error("test failure")),
    resize: (columns: number, rows: number) => { terminal.columns = columns; terminal.rows = rows; resize(); } };
}
describe("console terminal lifecycle", () => {
  for (const exit of ["q", "signal", "error", "close"]) {
    test(`restores raw mode and ANSI on ${exit}`, async () => {
      const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal });
      if (exit === "q") f.input("q"); else if (exit === "signal") f.signal(); else if (exit === "error") f.error(); else f.client.onClose(1006, "gone");
      await running;
      expect(f.raw).toEqual([true, false]); expect(f.output.join("")).toContain(RESTORE_CONSOLE); expect(f.output.join("")).toContain("hub keeps running");
      if (exit === "error") process.exitCode = 0;
    });
  }
  test("closed approval removes pending confirmation; pasted commands do not act", async () => {
    const f = fixture(); let spawned = 0;
    const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, runCommand: () => { spawned++; return () => {}; } });
    f.client.onPush({ t: "permission", ...state().approvals[0], expiresAt: Date.now() + 10_000 });
    f.input("a"); f.client.onPush({ t: "permission_closed", id: "first", reason: "answered" }); f.input("y");
    expect(f.sent.some(msg => msg.t === "permit")).toBe(false);
    f.input("\x1b"); f.input(":kill\ry"); expect(spawned).toBe(0);
    f.input("\x03"); await running;
  });
  test("panel buffer is left when toggling, and only panels request board/queue", async () => {
    const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal });
    await Promise.resolve(); await Promise.resolve();
    expect(f.requests.some(msg => msg.t === "queue")).toBe(false);
    f.input("\t"); await Promise.resolve(); await Promise.resolve();
    expect(f.output.join("")).toContain("\x1b[?1049h");
    f.input("\t"); expect(f.output.join("")).toContain("\x1b[?1049l");
    f.input("q"); await running;
  });
  test("below 80x24 refuses panel mode", async () => {
    const f = fixture(79, 23); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, panels: true });
    f.input("\t"); expect(f.output.join("")).not.toContain("\x1b[?1049h");
    f.input("q"); await running;
  });
});

describe("console colors", () => {
  test("color precedence respects TTY, dumb and nonempty NO_COLOR, and explicit flags", () => {
    for (const [flag, env, want] of [
      [undefined, { isTTY: true }, true], ["auto", { isTTY: false }, false],
      ["auto", { isTTY: true, TERM: "dumb" }, false], ["auto", { isTTY: true, NO_COLOR: "" }, true],
      ["auto", { isTTY: true, NO_COLOR: "1" }, false],
      ["always", { isTTY: false, TERM: "dumb", NO_COLOR: "1" }, true],
      ["never", { isTTY: true }, false],
    ] as const) expect(resolveColor(flag, env)).toBe(want);
    expect(resolveColor("rainbow", { isTTY: true })).toBeInstanceOf(Error);
    expect(resolveColor("", { isTTY: true })).toBeInstanceOf(Error);
  });
  test("semantic tones come from structured states and events, never body text", () => {
    expect(stateTone("idle")).toBe("success"); expect(stateTone("approved")).toBe("success");
    for (const s of ["busy", "paused", "in_review", "changes_requested", "ready"]) expect(stateTone(s)).toBe("attention");
    for (const s of ["failed", "check failed", "needs_review"]) expect(stateTone(s)).toBe("failure");
    expect(stateTone("offline")).toBeUndefined();
    const env = newEnvelope("pi", "approved failed red green", { priority: "important" });
    expect(eventTone({ t: "envelope", env })).toBe("attention");
    expect(eventTone({ t: "envelope", env, dropped: "hop" })).toBe("failure");
    expect(eventTone({ t: "overflow", env, peer: "pi" })).toBe("failure");
    expect(eventTone({ t: "undeliverable", env, peer: "pi" })).toBe("failure");
  });
  for (const [columns, rows] of [[80, 24], [120, 40], [200, 60]]) {
    test(`painted and plain geometry match ${columns}x${rows} including long Korean text`, () => {
      const s = state(true); s.peers = { pi: { state: "busy", queued: 1, queuedImportant: 1 }, local: { state: "idle" }, codex: { state: "offline" } };
      s.approvals[0]!.title = "한국어 승인 내용 ".repeat(50);
      s.tasks = [{ id: 3, title: "한국어 태스크 ".repeat(40), owner: "pi", state: "in_review", class: "implement", updated: NOW - 100 }];
      s.queue = [{ id: "q1", peer: "pi", state: "needs_review", revision: 1, createdAt: NOW - 100 }];
      s.events = [{ text: "header\n한국어 body", tone: "attention" }];
      for (let panel = 1; panel <= 5; panel++) {
        s.panel = panel;
        const lines = renderConsoleLines(s, columns!, rows!, NOW);
        const plain = renderConsole(s, columns!, rows!, NOW);
        expect(lines.map(line => terminalText(paint(line, true)))).toEqual(plain);
        expect(lines.map(line => paint(line, false))).toEqual(plain);
        for (const line of lines) expect(Bun.stringWidth(terminalText(paint(line, true)))).toBeLessThanOrEqual(columns!);
        expect(lines[0]!.some(span => span.tone === "strong")).toBe(true);
      }
      s.mode = "stream";
      s.confirm = { type: "permission", id: "first", peer: "pi", option: "allow" };
      expect(renderConsoleLines(s, columns!, rows!, NOW).at(-1)?.[0]?.tone).toBe("attention");
    });
  }
  test("untrusted ANSI, OSC and C1 can emit only palette sequences, and body text stays default", () => {
    const attack = "evil\x1b[31mRED\x1b]52;c;secret\x07\x1b[2J31m";
    const s = state(true); s.peers = { [attack]: { state: "idle", servedBy: attack } };
    s.tasks = [{ id: 1, state: "in_review", title: attack, owner: attack, class: "implement" }];
    s.approvals[0]!.title = attack; s.approvals[0]!.peer = attack;
    s.events = [{ text: attack + "\nbody", tone: "attention", peer: attack }];
    const allowed = new Set([...Object.values(PALETTE), "\x1b[0m"]);
    for (let panel = 1; panel <= 5; panel++) {
      s.panel = panel;
      for (const line of renderConsoleLines(s, 200, 60, NOW)) {
        const colored = paint(line, true);
        for (const seq of colored.match(/\x1b\[[0-9;]*m/g) ?? []) expect(allowed.has(seq)).toBe(true);
        expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
        expect(colored).not.toContain(""); expect(colored).not.toContain("secret");
      }
    }
    expect(paint([{ text: "body" }], true)).toBe("body");
    expect(paint([{ text: attack, tone: "__proto__" as any }], true)).not.toContain("\x1b");
  });
  test("redirected auto output has no escapes; forced color styles only the header", async () => {
    for (const color of [undefined, true]) {
      const f = fixture(); f.terminal.isTTY = false;
      const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color });
      f.client.onPush({ t: "event", e: { t: "envelope", env: newEnvelope("pi", "body line", { priority: "important" }) } });
      f.signal(); await running;
      const out = f.output.join("");
      if (color) { expect(out).toContain(PALETTE.attention); expect(out).toContain("\x1b[0m\n    body line\n"); }
      else expect(out).not.toContain("\x1b");
      expect(f.raw).toEqual([]);
    }
  });
  test("color preserves cursor geometry through editing, selection, mode toggles and resize", async () => {
    const positions: string[][] = [];
    for (const color of [false, true]) {
      const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color });
      f.input(":"); f.input("한국어 입력"); f.input("\x1b");
      f.input("\t"); f.input("3"); f.input("j");
      f.resize(120, 40); f.input("\t"); f.resize(79, 23); f.resize(200, 60);
      f.input("q"); await running;
      positions.push(f.output.join("").match(/\x1b\[\d+;\d+H/g) ?? []);
      expect(f.output.join("")).toContain("\x1b[?1049h");
      expect(f.output.join("")).toContain("\x1b[?1049l");
      expect(f.output.join("")).toContain(RESTORE_CONSOLE);
    }
    expect(positions[1]).toEqual(positions[0]);
  });
  for (const exit of ["q", "signal", "error", "close"]) {
    test(`colored terminal exits unstyled on ${exit}`, async () => {
      const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: true });
      f.client.onPush({ t: "event", e: { t: "state", peer: "pi", state: "idle" } });
      expect(f.output.join("")).toContain(PALETTE.success);
      if (exit === "q") f.input("q"); else if (exit === "signal") f.signal(); else if (exit === "error") f.error(); else f.client.onClose(1006, "gone");
      await running;
      const out = f.output.join("");
      expect(out.slice(out.lastIndexOf("\x1b[0m"))).not.toMatch(/\x1b\[(?:1;36|36|32|33|31|90)m/);
      expect(out).toContain(RESTORE_CONSOLE);
      if (exit === "error") process.exitCode = 0;
    });
  }
});
