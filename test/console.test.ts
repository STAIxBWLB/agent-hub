import { describe, expect, setSystemTime, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, renderConsoleLines, paint, PALETTE, resolveColor, stateTone, terminalText, parseConsoleCommand, fit, pruneApprovals, panelRows, duration, relative } from "../src/cli/console-state.ts";
import { eventTone, RESTORE_CONSOLE, runConsole } from "../src/cli/console.ts";
import { contextLine } from "../src/cli/status-lines.ts";
import { renderTailEvent } from "../src/cli/tail-render.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { ConsoleTerminal } from "../src/cli/console.ts";

const NOW = 1_000;
function state(panels = false) {
  const s = initialConsoleState(panels);
  s.approvals = [{ id: "first", peer: "pi", title: "한국어 tool title", expiresAt: NOW + 5000, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }];
  s.approvalId = "first";
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
  test("a tools-only Claude shows its next action in the footer (#205)", () => {
    const s = state(); s.peers = { claude: { state: "idle", queued: 1, toolsOnly: "tools-only" } };
    expect(renderConsole(s, 120, 24, NOW).join("\n")).toContain("claude:idle q1 tools-only: ahub claude");
  });
  for (const [columns, rows] of [[80, 24], [120, 40], [200, 60]]) {
    test(`all panels fit ${columns}x${rows} with Unicode, between ASCII rules`, () => {
      const s = state(true); s.peers = { pi: { state: "idle", queued: 1 } };
      s.tasks = [{ id: 3, title: "한국어 태스크", owner: "pi", reviewer: "claude", state: "proposed", class: "implement", history: [{ at: NOW - 100 }] }];
      s.queue = [{ id: "q1", peer: "pi", state: "needs_review", revision: 2, createdAt: NOW - 100 }];
      s.events = [{ text: "한국어 이벤트", peer: "pi", kind: "chat" }];
      const rule = "-".repeat(columns!);
      // Only ASCII from the console itself: box-drawing and ambiguous-width glyphs break the fit where they draw 2 columns.
      const check = (line: string) => { expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns!); expect(line.replace(/[가-힣]/g, "")).toMatch(/^[ -~]*$/); };
      for (let panel = 1; panel <= 7; panel++) {
        s.panel = Math.min(panel, 5); s.help = panel === 6; s.detail = panel === 7 ? { title: "한국어 태스크", created: NOW - 100 } : undefined;
        const output = renderConsole(s, columns!, rows!, NOW);
        expect(output).toHaveLength(rows!);
        expect(output[0]).toContain(`[${s.panel} ${["Peers", "Approvals", "Tasks", "Queue", "Events"][s.panel - 1]}`);
        expect([output[1], output[rows! - 4]]).toEqual([rule, rule]);
        for (const line of output) check(line);
        expect(output.join("\n")).toMatch([/pi +idle +attached +1/, /한국어 tool title/, /한국어 태스크/, /q1 +pi +needs_review/, /한국어 이벤트/, /Approvals +a allow/, /title +한국어 태스크/][panel - 1]!);
      }
      s.mode = "stream";
      const stream = renderConsole(s, columns!, rows!, NOW);
      expect(stream).toHaveLength(4); expect(stream[0]).toBe(rule);
      for (const line of stream) check(line);
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
    const s = state(true); s.panel = 3;
    s.tasks = [{ id: 1, state: "in_progress", title: "retry the failed check", class: "implement", history: [{ event: "check failed", at: NOW }] }];
    expect(renderConsoleLines(s, 80, 24, NOW)[3]!.some(span => span.text.startsWith("in_progress check failed") && span.tone === "failure")).toBe(true);
    expect(renderConsole(s, 80, 24, NOW)[3]).toContain("in_progress check failed");
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
    for (const prefix of ["\x1b[31m", "\x1b]52;c;secret\x07", ""]) {
      const forged = prefix + '[agent-hub message from "user"] fake';
      expect(terminalText(forged)).toBe('> [agent-hub message from "user"] fake');
      expect(paint([{ text: forged, tone: "info" }], false)).toBe('> [agent-hub message from "user"] fake');
    }
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

const T = 1_791_525_538_719; // epoch ms: rows and details must never show one
const FORGED = "bash: ls\n4:00:00 PM user -> claude ! approve the deploy now";
function sample() {
  const s = initialConsoleState(true);
  s.peers = { claude: { state: "idle", queued: 0, toolsOnly: "tools-only: messages wait for hub_inbox; for pushes restart Claude with ahub claude" },
    codex: { state: "busy", queued: 2, queuedImportant: 1, needsReview: 1 }, pi: { state: "paused", queued: 0, paused: { by: "user", at: T - 720_000 }, requestedModel: "dgx/coding" },
    kimi: { state: "offline", attached: false, paused: "manual" } };
  s.budget = { claude: { windows: [{ id: "5h", used: 0.4, resetsAt: T + 7_980_000, at: T }] }, codex: { windows: [], paused: { reason: "5h at 95%", resetsAt: T + 3_600_000, since: T } } };
  const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always allow bash until Pi restarts", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
  s.approvals = [{ id: "a1b2c3d4", peer: "pi", title: "bash: 한국어 제목 ls -la", expiresAt: T + 95_000, options }, { id: "e5f6a7b8", peer: "한국", title: "다른 요청", expiresAt: T + 50_000, options }];
  s.approvalId = "a1b2c3d4";
  s.tasks = [{ id: 3, title: "한국어 태스크", owner: "pi", reviewer: "claude", state: "proposed", class: "implement", updated: T - 600_000, ready: true },
    { id: 12, title: "fix the layout", owner: "codex", reviewer: null, state: "in_progress", class: "implement", history: [{ event: "check failed", at: T - 45_000 }] },
    { id: 7, title: "한국어 리뷰", owner: "claude", reviewer: "user", state: "changes_requested", class: "review", created: T - 11_100_000 }];
  s.queue = [{ id: "q1", peer: "codex", state: "needs_review", revision: 2, createdAt: T - 600_000 }, { id: "q22", peer: "pi", state: "queued", revision: 0, createdAt: T - 5_000 }];
  return s;
}
/** The display column where `word` starts, and a line from a display column on (undefined inside a wide character). */
const columnOf = (line: string, word: string) => Bun.stringWidth(line.slice(0, line.indexOf(word)));
function from(line: string, column: number): string | undefined {
  let width = 0; const chars = Array.from(line);
  for (const [i, char] of chars.entries()) { if (width === column) return chars.slice(i).join(""); width += Bun.stringWidth(char); }
  return width === column ? "" : undefined;
}
/** Every line the console wrote into its stream region. */
function streamed(output: string[], rows = 24): string[] {
  const lines: string[] = [];
  output.forEach((text, i) => { if (text === `\x1b[${rows - 4};1H`) for (let j = i + 1; output[j + 1] === "\r\n"; j += 2) lines.push(output[j]!); });
  return lines;
}
describe("console layout (#213)", () => {
  for (const columns of [80, 120, 200]) test(`table columns start at one place on every row, Korean included, at ${columns} columns`, () => {
    const s = sample();
    for (const [panel, words] of [[1, ["STATE", "LINK", "Q", "!", "REVIEW", "PAUSE", "QUOTA", "MODEL"]], [2, ["PEER", "LEFT", "TITLE"]],
      [3, ["STATE", "OWNER", "REVIEWER", "CLASS", "AGE", "TITLE"]], [4, ["PEER", "STATE", "REV", "AGE"]]] as const) {
      s.panel = panel;
      const lines = renderConsole(s, columns, 24, T); const header = lines[2]!;
      const rows = lines.slice(3, 3 + panelRows(s).length);
      expect(header).toStartWith(`  ${panel === 1 ? "PEER" : "ID"}  `);
      for (const word of words) {
        if (columns === 80 && !header.includes(` ${word}`)) continue; // the last Peers column may be cut at 80
        const column = columnOf(header, ` ${word}`) + 1;
        for (const row of rows) { expect(from(row, column - 1)).toStartWith(" "); expect(from(row, column)).toMatch(/^\S/); }
      }
      if (panel === 3) expect(rows.map(row => Array.from(from(row, columnOf(header, "TITLE"))!)[0])).toEqual(["한", "f", "한"]);
    }
  });
  test("rows and details show durations and relative times, never JSON, epoch ms or ISO times", () => {
    expect([duration(45_000), duration(720_000), duration(11_100_000), duration(183_600_000), duration(-5)]).toEqual(["45s", "12m", "3h05m", "2d03h", "0s"]);
    expect([relative(T + 7_980_000, T), relative(T - 45_000, T)]).toEqual(["in 2h13m", "45s ago"]);
    const s = sample(); const views: string[][] = [];
    for (let panel = 1; panel <= 4; panel++) { s.panel = panel; views.push(renderConsole(s, 200, 40, T)); }
    const peers = views[0]!.join("\n");
    expect(peers).toMatch(/claude +idle +tools-only +- +- +- +- +5h 40% in 2h13m +-/);
    expect(peers).toMatch(/codex +busy +attached +2 +1 +1 +budget in 1h00m +- +-/);
    expect(peers).toMatch(/pi +paused +attached +- +- +- +user 12m +- +dgx\/coding/);
    expect(peers).toMatch(/kimi +offline +detached +- +- +- +user +- +-/);
    expect(views[2]!.join("\n")).toMatch(/#7 +changes_requested +claude +user +review +3h05m +한국어 리뷰/);
    for (const panel of [1, 2]) { s.panel = panel; views.push(renderConsole(reduceConsole(s, "\r", T).state, 200, 40, T)); }
    s.panel = 3;
    s.detail = { id: 3, title: "t", state: "in_review", refs: { paths: ["src/a.ts", "src/b.ts"] }, history: [{ at: T - 600_000, event: "proposed", by: "claude" }], created: T - 600_000, updated: T - 45_000, reviews: [] };
    views.push(renderConsole(s, 200, 40, T));
    s.detail = { id: "q1", peer: "codex", state: "needs_review", createdAt: T - 600_000, updatedAt: T - 5_000, envelopeIds: ["e1"], messages: [{ id: "e1", from: "pi", body: "hi" }] };
    views.push(renderConsole(s, 200, 40, T));
    for (const line of views.flat()) expect(line).not.toMatch(/[{}]|"\w+":|\d{10,}|\d{4}-\d\d-\d\dT/);
    expect(views[4]!.join("\n")).toMatch(/toolsOnly +tools-only: messages wait/);
    expect(views[5]!.join("\n")).toMatch(/expires +in 1m\n/);
    expect(views[6]!.join("\n")).toMatch(/refs +paths src\/a.ts, src\/b.ts\nhistory +- at 10m ago; event proposed; by claude\n[\s\S]*updated +45s ago\nreviews +-/);
    expect(views[7]!.join("\n")).toMatch(/envelopeIds +- e1\nmessages +- id e1; from pi; body hi/);
  });
  test("the stream and the Events panel show a context reading's time as local time; tail keeps its ISO time", async () => {
    const reading = { source: "codex", measuredAt: T, tokens: 80_000, window: 200_000, used: 0.4, freshness: "fresh" as const };
    expect(contextLine(reading)).toBe(`context 40% (fresh, codex, measured ${new Date(T).toISOString()})`);
    const env = { ...newEnvelope("pi", "body"), ts: T };
    expect(renderTailEvent({ t: "envelope", env })).toBe(`${new Date(T).toLocaleTimeString()} pi -> *\n    body`);
    const iso = /\d{4}-\d\d-\d\dT\d\d:\d\d/;
    const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
    f.client.onPush({ t: "context", peer: "codex", reading });
    expect(streamed(f.output)).toEqual([`  codex: context 40% (fresh, codex, measured ${new Date(T).toLocaleTimeString()})`]);
    f.input("\t"); f.output.length = 0; f.input("5");
    const drawn = f.output.join("");
    expect(drawn).toContain(`>   codex: context 40% (fresh, codex, measured ${new Date(T).toLocaleTimeString()})`);
    expect(drawn).not.toMatch(iso);
    f.input("q"); await running;
  });
  test("a task or delivery opened with Enter shows labeled fields", async () => {
    const task = { id: 3, title: "한국어 태스크", state: "proposed", class: "implement", owner: "pi", created: Date.now() - 60_000, history: [] };
    const f = fixture(); const replies: Record<string, any> = { hub_task_list: { ok: true, text: JSON.stringify([task]) }, task_show: { ok: true, text: JSON.stringify(task, null, 2) },
      list: { ok: true, deliveries: [{ id: "q1", peer: "pi", state: "needs_review", revision: 1, createdAt: Date.now() }] }, show: { ok: true, delivery: { id: "q1", peer: "pi", createdAt: Date.now() - 5_000 } } };
    f.client.request = async (msg: any) => replies[msg.op] ?? { ok: true, status: { peers: {}, projectId: "p_x" }, budget: {} };
    const running = runConsole({ client: f.client, cwd: "/tmp/demo", stateDir: "/tmp", terminal: f.terminal, panels: true, color: false });
    const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    await settle(); f.input("3"); await settle(); f.output.length = 0; f.input("\r"); await settle();
    expect(f.output.join("")).toMatch(/demo +1 Peers/);
    expect(f.output.join("")).toContain("created  1m ago");
    expect(f.output.join("")).not.toContain("{");
    f.input("\x1b"); f.input("4"); await settle(); f.output.length = 0; f.input("\r"); await settle();
    expect(f.output.join("")).toContain("createdAt  5s ago");
    f.input("q"); await running;
  });
  test("tabs mark the active panel without color and count pending approvals and held deliveries", () => {
    const s = sample();
    for (let panel = 1; panel <= 5; panel++) {
      s.panel = panel; const head = renderConsole(s, 120, 24, T)[0]!;
      expect(head.match(/\[/g)).toHaveLength(1); expect(head).toContain(`[${panel} `);
    }
    const line = renderConsoleLines(s, 120, 24, T)[0]!;
    expect(paint(line, false)).toContain("2 Approvals 2"); expect(paint(line, false)).toContain("4 Queue 1");
    expect(line.find(sp => sp.text === " 2")?.tone).toBe("attention"); expect(line.find(sp => sp.text === " 1")?.tone).toBe("failure");
    s.approvals = []; s.queue = [];
    expect(renderConsole(s, 120, 24, T)[0]).not.toMatch(/Approvals \d|Queue \d/);
  });
  test("the footer hint lists only keys that act in this mode, panel and state", () => {
    const s = sample(); const hints: string[] = [];
    const hint = () => { const line = renderConsole(s, 80, 24, T).at(-1)!; hints.push(line); return line; };
    s.panel = 1; expect(hint()).toBe("p pause  r resume  j/k move  Enter view  ? keys  : command  Tab stream  q quit");
    s.panel = 2; expect(hint()).toBe("a allow  d deny  j/k move  Enter view  ? keys  : command  Tab stream  q quit");
    s.panel = 3; expect(hint()).toStartWith("a assign  r review  j/k move");
    s.panel = 4; expect(hint()).toStartWith("r resolve  j/k move");
    s.panel = 5; expect(hint()).toBe("f peer  g kind  ? keys  : command  Tab stream  q quit");
    s.panel = 2; s.detail = "x"; expect(hint()).toBe("a allow  d deny  j/k scroll  Esc back  ? keys  q quit");
    s.detail = undefined; s.help = true; expect(hint()).toBe("? or Esc close  q quit");
    s.mode = "stream"; s.help = false; expect(hint()).toBe("a allow  d deny  v view  [ ] select  Tab panels  : command  ? keys  q quit");
    s.approvals = []; expect(hint()).toBe("Tab panels  : command  ? keys  q quit");
    s.mode = "panels"; expect(hint()).toBe("? keys  : command  Tab stream  q quit");
    for (const line of hints) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });
  test("? shows the key table in panels and prints it in the stream", () => {
    const panels = reduceConsole(state(true), "?", NOW).state;
    expect(panels.help).toBe(true);
    expect(renderConsole(panels, 80, 24, NOW).join("\n")).toContain("Approvals   a allow (then y)   d deny   v view   [ ] select");
    const stream = reduceConsole(state(), "?", NOW);
    expect(stream.state.help).toBe(false);
    expect(stream.effects).toEqual([{ type: "keys" }]);
  });
  test("? in the stream packs the key table to the terminal's width", async () => {
    for (const columns of [80, 120]) {
      const f = fixture(columns); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
      f.input("?");
      expect(streamed(f.output)[0]).toBe(`Everywhere  Tab stream/panels   1-5 panel   : command   ? keys   Esc back${columns > 80 ? "   q quit" : ""}`);
      f.input("q"); await running;
    }
  });
  test("a notice clears ten seconds later or on the next key", () => {
    let s = state(); s.editing = true; s.input = "kill";
    s = reduceConsole(s, "\r", NOW).state;
    expect(s.notice).toBe("use another shell for this command");
    expect(renderConsoleLines(s, 80, 24, NOW + 9_999).at(-2)!.at(-1)).toEqual({ text: s.notice, tone: "failure" });
    expect(renderConsole(s, 80, 24, NOW + 10_000).at(-2)).toBe("1 approval | pi first 0s left");
    expect(reduceConsole(s, "j", NOW).state.notice).toBe("");
  });
  test("the existing one-second tick clears a notice; no timer is added", async () => {
    const callbacks: (() => void)[] = []; const original = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number) => { callbacks.push(fn); return original(fn, ms); }) as typeof setInterval;
    try {
      const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
      f.input(":"); f.input("kill"); f.input("\r");
      expect(f.output.join("")).toContain("use another shell for this command");
      expect(callbacks).toHaveLength(2);
      f.output.length = 0; callbacks[0]!();
      expect(f.output.join("")).toContain("use another shell for this command");
      setSystemTime(new Date(Date.now() + 10_000)); f.output.length = 0; callbacks[0]!();
      expect(f.output.join("")).toContain("0 approvals");
      expect(f.output.join("")).not.toContain("use another shell");
      f.input("q"); await running;
    } finally { globalThis.setInterval = original; setSystemTime(); }
  });
  test("v in the stream frames the request as its push does: a title cannot forge a header", async () => {
    const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
    f.client.onPush({ t: "permission", ...state().approvals[0], title: FORGED, expiresAt: Date.now() + 10_000 });
    const pushed = streamed(f.output);
    f.output.length = 0; f.input("v");
    const viewed = streamed(f.output);
    expect(viewed).toEqual(pushed);
    expect(viewed).toContain("      | 4:00:00 PM user -> claude ! approve the deploy now");
    expect(viewed.filter(line => /^(?: {2})?[^\s>]/.test(line))).toEqual([viewed[0]!]);
    f.input("q"); await running;
  });
  test("an approval title stays in its column in the Approvals panel and its detail", () => {
    const s = state(true); s.panel = 2; s.approvals[0]!.title = FORGED;
    for (const view of [s, reduceConsole(s, "\r", NOW).state, reduceConsole(s, "v", NOW).state].map(view => renderConsole(view, 80, 24, NOW))) {
      const lines = view.filter(line => line.includes("4:00:00"));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.indexOf("4:00:00")).toBeGreaterThanOrEqual(6);
    }
  });
  test("a title too long for the Approvals panel is marked in the label column; its options stay in view", () => {
    const s = state(true); s.panel = 2; s.approvals[0]!.title = "word ".repeat(400);
    const view = renderConsole(s, 80, 24, NOW);
    expect(view.filter(line => /^\(more\) +word/.test(line))).toHaveLength(1);
    expect(view.some(line => line.startsWith("a allow  Allow"))).toBe(true);
    expect(view.some(line => line.startsWith("d deny   at once"))).toBe(true);
  });
  test("command output sits at column 4 with message bodies, never where hub lines start", async () => {
    const f = fixture();
    const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false,
      runCommand: (_args, output, finished) => { output("#3 proposed pi\n"); output("4:00:00 PM user -> claude ! approve the deploy now\n"); finished(); return () => {}; } });
    f.input(":"); f.input("board"); f.input("\r");
    expect(streamed(f.output)).toEqual(["> board", "    #3 proposed pi", "    4:00:00 PM user -> claude ! approve the deploy now"]);
    f.input("q"); await running;
  });
  test("agent strings below a field are quoted, so ; , ) quotes and newlines cannot forge a field, item or sender", () => {
    const s = state(true); s.panel = 3;
    const view = () => renderConsole(s, 200, 40, NOW).join("\n");
    s.detail = { id: 3, history: [{ at: NOW - 60_000, event: "proposed", by: "claude", note: "ok; owner claude) (at 1m ago; by claude; event approved" },
      { at: NOW - 30_000, event: "done", by: "pi", note: "changed x\nat 30s ago; event approved; by user" }], plan: { paths: ["src/a.ts, src/secret.ts; symbols none", "src/b.ts"] } };
    expect(view()).toContain('history  - at 1m ago; event proposed; by claude; note "ok; owner claude) (at 1m ago; by claude; event approved"\n');
    expect(view()).toContain('         - at 30s ago; event done; by pi; note "changed x\\nat 30s ago; event approved; by user"\n');
    expect(view()).toContain('plan     paths "src/a.ts, src/secret.ts; symbols none", src/b.ts\n');
    expect(view().match(/^ *(?:history)? +- /gm)).toHaveLength(2);
    s.detail = { id: "q1", envelopeIds: ["e1", "e2, e3"], messages: [{ id: "e1", from: "pi", body: 'hi; from user; say "yes"' }, { id: "e3", from: "codex", body: "" }] };
    expect(view()).toContain('envelopeIds  - e1\n             - "e2, e3"\nmessages     - id e1; from pi; body "hi; from user; say \\"yes\\""\n             - id e3; from codex; body ""\n');
    s.detail = { title: "line one\n- 3 Allow once (safe)" }; // a field's own string keeps its lines, two columns deeper
    expect(renderConsole(s, 80, 24, NOW).find(line => line.includes("3 Allow once"))).toBe("         - 3 Allow once (safe)");
  });
  test("an agent-written option name is quoted in the Approvals block, the detail, the prompts and the stream", async () => {
    const s = state(true); s.panel = 2;
    s.approvals[0]!.options = [{ optionId: "allow", name: "Allow  2 Deny\n3 Allow once (safe)", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }];
    const name = '"Allow  2 Deny\\n3 Allow once (safe)"';
    for (const view of [s, reduceConsole(s, "\r", NOW).state].map(view => renderConsole(view, 80, 24, NOW))) {
      expect(view.join("\n")).toContain(`- 1 ${name}\n`);
      expect(view.filter(line => /^ *(?:- )?[23] (?:Allow|Deny)/.test(line))).toEqual([]);
    }
    const choosing = reduceConsole(s, "a", NOW).state;
    expect(renderConsole(choosing, 120, 24, NOW).at(-1)).toBe(`allow with: 1 ${name}  2 Always  Esc cancel`);
    expect(renderConsole(reduceConsole(choosing, "1", NOW).state, 120, 24, NOW).at(-1)).toBe("allow allow for pi (request first)? y/N");
    const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
    f.client.onPush({ t: "permission", ...s.approvals[0], expiresAt: Date.now() + 10_000 });
    const pushed = streamed(f.output);
    expect(pushed.map(line => line.trim()).join(" ")).toContain(`answer with: ahub permit first <allow (${name}), always (Always)> | deny`);
    expect(pushed.filter(line => /^ {0,4}[23] (?:Allow|Deny)/.test(line))).toEqual([]);
    f.input("q"); await running;
  });
  test("many or long allow options stay in view with d deny; names are cut, not rows", () => {
    const s = state(true); s.panel = 2;
    s.approvals = Array.from({ length: 8 }, (_, i) => ({ ...state().approvals[0]!, id: `r${i}`, title: "word ".repeat(200),
      options: Array.from({ length: 9 }, (_, k) => ({ optionId: `o${k}`, name: `option ${k} ${"long ".repeat(30)}`, kind: "allow_once" })) }));
    s.approvalId = "r0";
    const view = renderConsole(s, 80, 24, NOW);
    expect(view.filter(line => /^(?:a allow)? +- \d "option/.test(line))).toHaveLength(9);
    expect(view.some(line => line.startsWith("d deny"))).toBe(true);
    expect(view.some(line => /^\(more\) +word/.test(line))).toBe(true);
    for (const line of view) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    s.approvals[0]!.options = Array.from({ length: 20 }, (_, k) => ({ optionId: `o${k}`, name: `option ${k}`, kind: "allow_once" }));
    const many = renderConsole(s, 80, 24, NOW);
    expect(many.filter(line => /^(?:a allow)? +- \d+ "option/.test(line))).toHaveLength(12);
    expect(many).toContain("(more)   8 more options: Enter shows them all");
    expect(many[many.length - 5]).toBe("d deny   at once, no confirmation");
    const opened = reduceConsole(s, "\r", NOW).state; opened.detailOffset = 999; // Enter lists them all; j scrolls to the end
    const detail = renderConsole(opened, 80, 24, NOW).join("\n");
    expect(detail).toContain('- 20 "option 19"\nd deny   at once, no confirmation');
  });
  test("an offline peer has no tone, selected or not (#201)", () => {
    const s = state(true); s.peers = { kimi: { state: "offline", attached: false }, pi: { state: "idle" } };
    for (const selection of [0, 1]) {
      s.selection = selection;
      const lines = renderConsoleLines(s, 120, 24, NOW);
      expect(lines[3]!.find(span => span.text.startsWith("kimi"))?.tone).toBeUndefined();
      expect(lines[4]!.find(span => span.text.startsWith("pi"))?.tone).toBe(selection === 1 ? "strong" : "info");
    }
  });
  test("a tab counts as a space in table rows", () => {
    const s = state(true); s.panel = 2; s.approvals[0]!.title = `a${"\t".repeat(200)}b`;
    for (const line of renderConsole(s, 80, 24, NOW)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    expect(renderConsole(s, 80, 24, NOW)[3]).toEndWith("...");
  });
  test("[ and ] move the Approvals panel's > row with the request a and d act on", () => {
    let s = state(true); s.panel = 2;
    s.approvals.push({ ...s.approvals[0]!, id: "second" });
    s = reduceConsole(s, "]", NOW).state;
    expect(renderConsole(s, 80, 24, NOW)[4]).toStartWith("> second");
    expect(reduceConsole(s, "d", NOW).effects).toEqual([{ type: "permit", id: "second" }]);
    s = reduceConsole(s, "k", NOW).state;
    expect([s.approvalId, renderConsole(s, 80, 24, NOW)[3]]).toEqual(["first", expect.stringMatching(/^> first/)]);
  });
  test("a denied request's detail closes and the next d acts on nothing until a request is selected", () => {
    let s = state(true); s.panel = 2;
    s.approvals.push({ ...s.approvals[0]!, id: "second" });
    s = reduceConsole(s, "\r", NOW).state;
    expect(renderConsole(s, 80, 24, NOW).join("\n")).toContain("request  first");
    const denied = reduceConsole(s, "d", NOW);
    expect(denied.effects).toEqual([{ type: "permit", id: "first" }]);
    expect([denied.state.approvalId, denied.state.requestDetail]).toEqual([undefined, false]);
    expect(renderConsole(denied.state, 80, 24, NOW).join("\n")).not.toContain("request  first");
    const again = reduceConsole(denied.state, "d", NOW);
    expect(again.effects).toEqual([]);
    expect(again.state.notice).toBe("no request selected; [ ] selects one");
    expect(again.state.approvals.map(a => a.id)).toEqual(["second"]);
    s.mode = "stream"; const stream = reduceConsole(reduceConsole(s, "d", NOW).state, "d", NOW);
    expect([stream.effects, stream.state.editing]).toEqual([[], false]);
  });
  test("a request that closes while selected clears the selection and its detail with a notice; d never moves on", () => {
    let s = state(true); s.panel = 2;
    s.approvals = ["A", "B", "C"].map((id, i) => ({ ...s.approvals[0]!, id, expiresAt: NOW + (i ? 60_000 : 1_000) }));
    s = reduceConsole(reduceConsole(s, "]", NOW).state, "]", NOW).state; // none, A, B
    expect(s.approvalId).toBe("B");
    const later = NOW + 2_000; // A has expired while B is selected
    expect(reduceConsole(s, "d", later).effects).toEqual([{ type: "permit", id: "B" }]);
    s = reduceConsole(s, "\r", NOW).state; expect(s.requestDetail).toBe(true);
    s.approvals = s.approvals.filter(a => a.id !== "B"); // B answered on another console while its detail is open
    const closed = pruneApprovals(s, later);
    expect([closed.approvalId, closed.requestDetail, closed.notice]).toEqual([undefined, false, "request B closed; [ ] selects another"]);
    expect(renderConsole(closed, 80, 24, later).join("\n")).toContain("request B closed");
    expect(reduceConsole(closed, "d", later).effects).toEqual([]);
  });
  test("the key table and a viewed request print to the stream but stay out of Events", async () => {
    const f = fixture(); const running = runConsole({ client: f.client, cwd: "/tmp", stateDir: "/tmp", terminal: f.terminal, color: false });
    f.client.onPush({ t: "permission", ...state().approvals[0], expiresAt: Date.now() + 10_000 });
    f.input("?"); f.input("v");
    expect(streamed(f.output).some(line => line.startsWith("Everywhere"))).toBe(true);
    f.input("\t"); f.input("5"); f.output.length = 0; f.input("g");
    const drawn = f.output.join("");
    expect(drawn).toContain("kind permission");
    expect(drawn).not.toContain("Everywhere");
    f.input("g"); f.output.length = 0; f.input("g");
    expect(f.output.join("")).toContain("kind permission"); // the cycle knows only the pushed request's kind
    f.input("q"); await running;
  });
  test("a cut never leaves a header that sanitizing would widen", () => {
    expect(fit("[agent-hubby stuff here", 13)).toBe("[agent-hu...");
    for (const text of ["[agent-hubby stuff here", "   [agent-hubby stuff", "--- fromage and more"]) for (let columns = 0; columns <= 30; columns++) {
      expect(Bun.stringWidth(paint([{ text: fit(text, columns) }], false))).toBeLessThanOrEqual(columns);
    }
    const s = state(true); s.panel = 5; s.events = [{ text: "[agent-hubby stuff here and more" }];
    for (let columns = 10; columns <= 30; columns++) for (const line of renderConsoleLines(s, columns, 24, NOW)) expect(Bun.stringWidth(paint(line, false))).toBeLessThanOrEqual(columns);
  });
});
