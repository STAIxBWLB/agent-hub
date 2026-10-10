import { describe, expect, test } from "bun:test";
import { PALETTE, paint, terminalText, wrap, table, type Span } from "../src/cli/console-state.ts";
import { outputWidth, renderStatus, renderBoard, renderBudget, renderDoctor, renderProjects, renderQueue, renderTurns, renderOrphans, renderQueueShow, renderModelsStatus, renderExecutionBudgetStatus, renderReport, type DoctorCheck } from "../src/cli/output.ts";
import { summarize, summarizeByTask, formatReport, formatTaskReport } from "../src/hub/report.ts";
const now = 1_800_000_000_000;
const settlement = ["8d03b496-1111-2222-3333-444444444444", "3325f7a0-1111-2222-3333-444444444444"];
const hold = "abcdef12-1111-2222-3333-444444444444";
export const outputFixture = {
  status: { pid: 25893, controlPort: 12345, version: "0.12.22", cwd: "/project/agent-hub", peers: {
    claude: { state: "idle", attached: true, queued: 0, context: { used: 0.8, freshness: "fresh", source: "claude_statusline", measuredAt: now - 14_000 } },
    codex: { state: "busy", attached: true, queued: 2, servedBy: "dgx/qwen-coder-large", liveAccepted: settlement, heldBy: hold, holdNote: `held by needs_review ${hold}; ahub queue resolve ${hold} --action completed|retry|discard --reason <text>`, paused: "manual", context: { used: 0.34, freshness: "fresh", source: "codex_token_usage", measuredAt: now - 60_000 } },
    kimi: { state: "idle", attached: true, permissionMode: "ask-when-needed", context: { used: 0.25, freshness: "fresh", source: "acp_usage_update", measuredAt: now - 120_000 } },
    pi: { state: "idle", attached: true, toolsOnly: "tools-only: messages wait for hub_inbox; for pushes restart Claude with ahub claude", context: { used: null, freshness: "unknown", source: null, measuredAt: null } },
  }, tasks: { approved: 6, in_progress: 1 }, budget: { claude: { windows: [{ id: "5h", used: 0.23, resetsAt: now + 600_000 }, { id: "week", used: 0.49, resetsAt: now + 5 * 86_400_000 + 9 * 3_600_000 }] } } },
  tasks: [
    { id: 1, state: "approved", owner: "codex", reviewer: "claude", class: "implement", title: "제주한라대학교 AI 도구를 활용한 구현과 검증 ".repeat(12), created: now - 60_000, signals: [], deps: [] },
    { id: 2, state: "in_progress", owner: "kimi", reviewer: "claude", class: "implement", title: "A".repeat(300), created: now - 120_000, signals: [], deps: [1] },
    { id: 3, state: "proposed", owner: "local", reviewer: "claude", class: "implement", title: "[pii]", created: now - 30_000, signals: ["pii"], deps: [2] },
  ],
  budget: { gate: 0.95, budget: { claude: { windows: [{ id: "week", used: 0.49, resetsAt: now + 5 * 86_400_000 + 9 * 3_600_000, source: "claude_statusline", at: now - 14_000, stale: false }], paused: { reason: "quota threshold", resetsAt: now + 600_000 } }, codex: { windows: [{ id: "week", used: 0.08, source: "codex_rate_limits", at: now - 60_000, stale: true }] } } },
  doctor: [
    { section: "Tools", level: "ok", name: "bun", detail: "1.4.2" },
    { section: "Models", level: "fail", name: "local fixed_model", detail: "vllm/large-model is not served by the gateway" },
    { section: "Models", level: "warn", name: "pi mlx", detail: "error: Unable to connect. Is the computer able to access the URL?" },
    { section: "Memory", level: "unknown", name: "capture: codex", detail: "unknown, dot ai memory status is unavailable" },
  ] as DoctorCheck[],
};
const text = (value: ReturnType<typeof renderBoard>, color = false) => value.map(line => paint(line, color)).join("\n");
const renderers = (columns?: number) => [renderStatus(outputFixture.status, columns, now), renderBoard(outputFixture.tasks, columns, now), renderBudget(outputFixture.budget, columns, now), renderDoctor(outputFixture.doctor, columns, now)];
describe("one-shot output", () => {
  test("width comes from a terminal or an explicit piped COLUMNS", () => {
    expect(outputWidth({ isTTY: true, columns: 40 })).toBe(80);
    expect(outputWidth({ isTTY: true, columns: 120 })).toBe(120);
    expect(outputWidth({ isTTY: false, COLUMNS: "76" })).toBe(76);
    for (const COLUMNS of [undefined, "", "0", "bad", "80x", "-1"]) expect(outputWidth({ isTTY: false, COLUMNS })).toBeUndefined();
  });
  for (const columns of [76, 80, 120, 200]) test(`complete physical cells fit ${columns} columns`, () => {
    for (const rendered of renderers(columns)) for (const line of text(rendered).split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(line).not.toMatch(/[─-╿]/);
    }
    const board = text(renderBoard(outputFixture.tasks, columns, now));
    const header = board.split("\n")[0]!;
    const from = Bun.stringWidth(header.split("TITLE")[0]!);
    const to = Bun.stringWidth(header.split("STAGE")[0]!);
    const titleText = board.split("\n").slice(1).map(line => {
      let at = 0, title = "";
      for (const char of line) { const next = at + Bun.stringWidth(char); if (at >= from && next <= to) title += char; at = next; }
      return title;
    }).join("").replace(/\s/g, "");
    expect(titleText).toContain(outputFixture.tasks[0]!.title.replace(/\s/g, ""));
    expect(titleText).toContain("A".repeat(300));
    expect(board).toContain("[pii]");
    expect(titleText).toContain("ahubtaskshow3");
    expect(titleText).toContain("after#2");
    const titleColumn = Bun.stringWidth(board.split("\n")[0]!.split("TITLE")[0]!);
    const koreanLines = board.split("\n").filter(line => line.includes("제주") || line.includes("도구") || line.includes("활용한"));
    expect(koreanLines.length).toBeGreaterThan(1);
    for (const line of koreanLines.slice(1)) expect(Bun.stringWidth(line.match(/^\s*/)?.[0] ?? "")).toBeGreaterThanOrEqual(titleColumn);
  });
  test("no width keeps full rows, title and informational ids", () => {
    const board = text(renderBoard(outputFixture.tasks, undefined, now));
    expect(board).toContain(outputFixture.tasks[0]!.title);
    expect(board).toContain("A".repeat(300));
    expect(board.split("\n").filter(line => line.startsWith("#"))).toHaveLength(3);
    const status = text(renderStatus(outputFixture.status, undefined, now));
    expect(status).toContain(settlement.join(", "));
    for (const id of settlement) expect(text(renderStatus(outputFixture.status, 120, now, true)).replace(/\s/g, "")).toContain(id);
  });
  test("settlement is a detail, resolution commands retain whole ids", () => {
    const status = text(renderStatus(outputFixture.status, 120, now));
    expect(status).toContain("8d03b496, 3325f7a0");
    expect(status.replace(/\s/g, "")).toContain(`ahubqueueresolve${hold}`);
    expect(status.match(/the adapter has not confirmed/g)).toHaveLength(1);
    expect(status).not.toContain(settlement[0]!);
    expect(status).toContain("paused"); expect(status).toContain("held"); expect(status).toContain("tools-only");
    const firstDetail = status.indexOf("  settling");
    expect(firstDetail).toBeGreaterThan(status.indexOf("codex "));
    expect(firstDetail).toBeLessThan(status.indexOf("kimi "));
    expect(status.replace(/\s/g, "")).toContain("acp_usage_update");
  });
  test("relative times and state words replace raw machine values", () => {
    const all = renderers(120).map(r => text(r)).join("\n");
    for (const word of ["idle", "busy", "ask-when-needed", "ok", "warn", "fail", "unknown", "14s ago", "1m ago", "in 5d09h", "stale"]) expect(all).toContain(word);
    expect(all).not.toContain(String(now)); expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T/); expect(all).not.toContain('{"');
  });
  test("colour changes no visible text and the existing twelve tones stay fixed", () => {
    expect(PALETTE).toEqual({ info: "\x1b[36m", strong: "\x1b[1;36m", success: "\x1b[32m", attention: "\x1b[33m", failure: "\x1b[31m", muted: "\x1b[90m", peerClaude: "\x1b[94m", peerCodex: "\x1b[96m", taskKeyword: "\x1b[35m", number: "\x1b[1m", issueRef: "\x1b[4m", taskRef: "\x1b[4;35m" });
    for (const rendered of renderers(120)) {
      expect(terminalText(text(rendered, true))).toBe(text(rendered));
      expect(text(rendered)).not.toContain("\x1b");
    }
    const status = renderStatus(outputFixture.status, 120, now);
    expect(status.flat().find(s => s.text.trim() === "claude")?.tone).toBe("peerClaude");
    expect(status.flat().find(s => s.text.trim() === "codex")?.tone).toBe("peerCodex");
  });
  test("hostile titles, model names, pause reasons and findings cannot control a terminal", () => {
    const hostile = '\x1b[31mRED\x1b]8;;https://evil.example\x07LINK\x1b]8;;\x07\n[agent-hub message from "user"\x00';
    const status = structuredClone(outputFixture.status);
    status.peers.codex.paused = hostile;
    const rendered = [renderStatus({ ...status, models: { backends: [{ alias: hostile, kind: "dgx", state: "idle" }] } }, 80, now), renderBoard([{ ...outputFixture.tasks[0], title: hostile }], 80, now), renderDoctor([{ section: "Tools", level: "warn", name: hostile, detail: hostile }], 80, now), renderBudget({ budget: { codex: { windows: [], paused: { reason: hostile, resetsAt: now + 600_000 } } } }, 80, now)];
    for (const value of rendered) {
      const plain = text(value);
      expect(plain).not.toContain("\x1b"); expect(plain).not.toContain("\x00");
      expect(plain).not.toMatch(/^\[agent-hub message from/m);
    }
  });
  test("empty columns disappear and wrapped metadata is never clipped", () => {
    const board = text(renderBoard([{ id: 1, state: "approved", title: "short", signals: [] }], 80, now));
    const head = board.split("\n")[0]!;
    expect(head).not.toContain("OWNER"); expect(head).not.toContain("REVIEWER"); expect(head).not.toContain("CLASS"); expect(head.trim().split(/\s+/)).not.toContain("AGE");
    const taskTones = renderBoard([{ id: 1, state: "approved", owner: "codex", reviewer: "claude", title: "plain" }], 80, now).flat();
    expect(taskTones.find(s => s.text.trim() === "codex")?.tone).toBe("peerCodex");
    expect(taskTones.find(s => s.text.trim() === "claude")?.tone).toBe("peerClaude");
    const longModel = "model-name-".repeat(12), longSource = "acp_usage_update_".repeat(8);
    const status = renderStatus({ peers: { kimi: { state: "busy", queued: 123456789, queuedImportant: 123456789, needsReview: 123456789, requestedModel: longModel, context: { used: 0.31, source: longSource, freshness: "fresh", measuredAt: now - 60_000 } } } }, 80, now);
    const visible = text(status);
    expect(visible).not.toContain("...");
    expect(visible).toContain("123456789");
    const header = visible.split("\n").find(line => line.includes("PEER"))!;
    const read = (field: string, next?: string) => {
      const start = Bun.stringWidth(header.slice(0, header.indexOf(field)));
      const end = next ? Bun.stringWidth(header.slice(0, header.indexOf(next))) : Infinity;
      return visible.split("\n").slice(visible.split("\n").indexOf(header) + 1).map(line => {
        let at = 0, result = "";
        for (const char of line) { const after = at + Bun.stringWidth(char); if (at >= start && after <= end) result += char; at = after; }
        return result;
      }).join("").replace(/\s/g, "");
    };
    expect(read("Q", "!")).toContain("123456789");
    expect(read("!", "REVIEW")).toContain("123456789");
    expect(read("REVIEW", "MODEL")).toContain("123456789");
    expect(read("MODEL", "CONTEXT")).toContain(longModel);
    expect(read("CONTEXT")).toContain(longSource);
  });
  test("short and unassigned boards retain canonical fields in a pipe", () => {
    for (const title of ["wip", "Fix it"]) {
      const board = text(renderBoard([{ id: 1, state: "proposed", class: "implement", title }], undefined, now));
      expect(board).toContain(title); expect(board).toContain("implement");
      expect(board).not.toContain("..."); expect(board).toContain("1 task: 1 proposed");
      expect(board.split("\n")[0]!.trim().split(/\s+/)).toEqual(["ID", "STATE", "CLASS", "TITLE", "STAGE"]);
    }
  });
  test("narrow piped widths preserve short boards and complete cells", () => {
    for (const columns of [12, ...Array.from({ length: 45 }, (_, i) => i + 36)]) {
      for (const title of ["wip", "Fix it", "Z".repeat(300)]) {
        const rendered = renderBoard([{ id: 1, state: "changes_requested", owner: "codex", reviewer: "claude", class: "implement", title, signals: [] }], columns, now);
        const board = text(rendered);
        for (const line of board.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
        expect(board).not.toContain("...");
        expect(board.match(/Z/g)?.length ?? 0).toBe(title.match(/Z/g)?.length ?? 0);
        const headerAt = rendered.findIndex(line => line.some(cell => cell.text.trim() === "TITLE"));
        const titleAt = rendered[headerAt]!.findIndex(cell => cell.text.trim() === "TITLE");
        const end = rendered.findIndex((line, i) => i > headerAt && line.length === 0);
        const completeTitle = rendered.slice(headerAt + 1, end < 0 ? undefined : end).map(line => line[titleAt]?.text ?? "").join("").replace(/\s/g, "");
        expect(completeTitle).toBe(title.replace(/\s/g, ""));
      }
    }
  });
  test("filtered boards resolve dependencies against the full task list", () => {
    const approved = { id: 1, state: "approved", title: "done" };
    const ready = { id: 5, state: "proposed", title: "ready", deps: [1] };
    const board = text(renderBoard([ready], 80, now, false, [approved, ready]));
    expect(board).toContain("proposed"); expect(board).not.toContain("waiting"); expect(board).toContain("after #1");
    expect(text(renderBoard([ready], 80, now, false, [{ ...approved, state: "in_progress" }, ready]))).toContain("waiting");
  });
  test("real daemon notices are shown once and actionable ids stay whole", () => {
    const status = text(renderStatus(outputFixture.status, undefined, now));
    expect(status.match(/ahub queue resolve/g)).toHaveLength(1);
    expect(status.match(/tools-only/g)).toHaveLength(2); // link state plus the single detail label
    const terminal = text(renderStatus(outputFixture.status, 80, now)).replace(/\s/g, "");
    expect(terminal).toContain(`ahubqueueresolve${hold}`);
    expect(terminal.match(new RegExp(hold, "g"))).toHaveLength(1);
    expect(terminal).toContain("byneeds_reviewabcdef12;");
  });
  test("budget pauses use their reading rather than a daemon locale clock", () => {
    const peers = { codex: { state: "paused", paused: "budget: threshold, resets 11:45:12 PM" } };
    const status = text(renderStatus({ peers, budget: { codex: { windows: [], paused: { reason: "threshold", resetsAt: now + 600_000 } } } }, 80, now));
    expect(status).toContain("resets in 10m"); expect(status).not.toContain("11:45");
    const unknown = text(renderStatus({ peers }, 80, now));
    expect(unknown).toContain("reset unknown"); expect(unknown).not.toContain("11:45");
  });
  test("semantic words stay readable at 80 and doctor findings use the available width", () => {
    expect(text(renderStatus(outputFixture.status, 80, now))).toContain("ask-when-needed");
    expect(text(renderBoard([{ id: 1, state: "changes_requested", owner: "codex", reviewer: "claude", class: "implement", title: "Check status words", created: now }], 80, now))).toContain("changes_requested");
    const doctor = text(renderDoctor([{ section: "Tools", level: "warn", name: "bun", detail: "The available finding column should carry this sentence with plenty of room." }], 80, now));
    expect(doctor).toContain("The available finding column should carry this sentence with");
    expect(text(renderDoctor([{ section: "Tools", level: "ok", name: "bun", detail: "first\nsecond" }], 80, now))).toContain("first second");
  });
  test("multi-word states stay together whenever their table has room", () => {
    for (const columns of [120, 200]) {
      const waiting = text(renderBoard([{ id: 5, state: "proposed", title: "waiting task", deps: [1] }], columns, now));
      expect(waiting).toContain("proposed waiting");
      const failed = text(renderBoard([{ id: 5, state: "in_review", title: "failed check", history: [{ event: "check failed", at: now }] }], columns, now));
      expect(failed).toContain("in_review check failed");
    }
  });
  test("model and two quota windows leave readable link and context at 80", () => {
    const rendered = renderStatus(outputFixture.status, 80, now);
    const headerAt = rendered.findIndex(line => line.some(cell => cell.text.trim() === "CONTEXT"));
    const header = rendered[headerAt]!;
    const contextAt = header.findIndex(cell => cell.text.trim() === "CONTEXT");
    const linkAt = header.findIndex(cell => cell.text.trim() === "LINK");
    expect(contextAt).toBeGreaterThan(0); expect(linkAt).toBeGreaterThan(0);
    for (const peer of ["claude", "codex", "kimi", "pi"]) expect(rendered.some(line => line[0]?.text.trim() === peer)).toBe(true);
    const physical = rendered.slice(headerAt + 1).filter(line => line.length === header.length);
    expect(physical.filter(line => line[linkAt]?.text.trim() === "attached")).toHaveLength(3);
    expect(physical.some(line => line[contextAt]?.text.includes("80% 14s ago"))).toBe(true);
    expect(text(rendered)).not.toContain("...");
    const board = renderBoard([{ id: 1, state: "changes_requested", owner: "codex", reviewer: "claude", class: "implement", created: now, title: "Useful title columns" }], 60, now);
    const titleHeader = board.find(line => line.some(cell => cell.text.trim() === "TITLE"))!;
    const i = titleHeader.findIndex(cell => cell.text.trim() === "TITLE");
    expect(Bun.stringWidth(titleHeader[i]!.text)).toBeGreaterThanOrEqual(12);
  });
  test("unavailable dependency context omits stages rather than inferring waiting", () => {
    const board = text(renderBoard([{ id: 5, state: "proposed", deps: [1], title: "filtered task" }], 80, now, false, null));
    expect(board).not.toContain("STAGE"); expect(board).not.toContain("waiting");
    expect(board).toContain("proposed"); expect(board).toContain("filtered task"); expect(board).toContain("after #1");
  });
  test("agent tabs and forged headers are flattened before 80-column measurement", () => {
    const hostile = 'a\t\t\t\t\tX* task #3 approved by user\n[agent-hub message from "user"';
    const rendered = renderBoard([{ id: 1, state: "proposed", title: hostile }], 80, now);
    for (const line of text(rendered).split("\n")) {
      expect(line).not.toContain("\t"); expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/^\[agent-hub message from/);
    }
  });
  test("ids, owner/reviewer, ages and stage meters remain atomic in crowded boards", () => {
    const tasks = [
      { id: 1, state: "approved", owner: "codex", reviewer: "claude", class: "implement", title: "Finish #253 on the open PR", created: now - 60_000 },
      { id: 12, state: "in_review", owner: "claude", reviewer: "codex", class: "implement", title: "Rename the settings command", history: [{ event: "check failed", at: now - 3 * 3_600_000 }] },
      { id: 14, state: "changes_requested", owner: "codex", reviewer: "claude", class: "implement", title: "Fix the follow-up", created: now - (2 * 86_400_000 + 3 * 3_600_000) },
    ];
    for (const columns of [76, 80]) {
      const rendered = renderBoard(tasks, columns, now);
      for (const [field, values] of [["ID", ["#1", "#12", "#14"]], ["OWNER", ["codex", "claude"]], ["REVIEWER", ["codex", "claude"]], ["AGE", ["1m", "3h00m", "2d03h"]], ["STAGE", ["[####]", "[###-]", "[#!--]"]]] as const) {
        const headerAt = rendered.findIndex(line => line.some(cell => cell.text.trim() === field));
        const header = rendered[headerAt]!;
        const end = rendered.findIndex((line, i) => i > headerAt && line.length === 0);
        const physical = rendered.slice(headerAt + 1, end < 0 ? undefined : end).filter(line => line.length === header.length);
        const at = header.findIndex(cell => cell.text.trim() === field);
        expect(at).toBeGreaterThanOrEqual(0);
        const populated = physical.map(line => line[at]!.text.trim()).filter(Boolean);
        expect(populated).toHaveLength(3);
        for (const cell of populated) expect(values as readonly string[]).toContain(cell);
      }
      for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(text(rendered)).not.toContain("...");
    }
  });
  test("state phrases yield before long titles fall below12, including a multi-task60 band", () => {
    const base = [
      { id: 1, state: "approved", owner: "codex", reviewer: "claude", class: "implement", title: "Finish the implementation", created: now - 60_000 },
      { id: 12, state: "in_review", owner: "claude", reviewer: "codex", class: "implement", title: "Rename the settings", history: [{ event: "check failed", at: now - 3 * 3_600_000 }] },
      { id: 14, state: "proposed", owner: "codex", reviewer: "claude", class: "implement", title: "Review the operations guide", created: now - 2 * 86_400_000 },
    ];
    for (const columns of [60, 76, 80]) for (const state of ["proposed", "changes_requested"]) {
      const tasks = base.map(task => task.id === 14 ? { ...task, state } : task);
      const rendered = renderBoard(tasks, columns, now);
      const headerAt = rendered.findIndex(line => line.some(cell => cell.text.trim() === "TITLE"));
      const titleAt = rendered[headerAt]!.findIndex(cell => cell.text.trim() === "TITLE");
      expect(Bun.stringWidth(rendered[headerAt]![titleAt]!.text) - 2).toBeGreaterThanOrEqual(12);
      const end = rendered.findIndex((line, i) => i > headerAt && line.length === 0);
      const cells = rendered.slice(headerAt + 1, end < 0 ? undefined : end).map(line => line[titleAt]?.text.trim() ?? "");
      for (const word of ["Finish", "Rename", "settings", "Review", "operations", "guide"]) expect(cells.some(cell => cell.split(/\s+/).includes(word))).toBe(true);
      for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });
  test("crowded status keeps two-digit queue, priority and review counters atomic", () => {
    const status = { ...outputFixture.status, peers: { codex: { ...outputFixture.status.peers.codex, queued: 12, queuedImportant: 23, needsReview: 34, permissionMode: "ask-when-needed" } } };
    for (const columns of [76, 80]) {
      const rendered = renderStatus(status, columns, now);
      for (const [field, expected] of [["Q", "12"], ["!", "23"], ["REVIEW", "34"]]) {
        const headerAt = rendered.findIndex(line => line.some(cell => cell.text.trim() === field));
        expect(headerAt).toBeGreaterThanOrEqual(0);
        const header = rendered[headerAt]!; const at = header.findIndex(cell => cell.text.trim() === field);
        const end = rendered.findIndex((line, i) => i > headerAt && line.length !== header.length);
        const values = rendered.slice(headerAt + 1, end < 0 ? undefined : end).map(line => line[at]!.text.trim()).filter(Boolean);
        expect(values).toEqual([expected!]);
      }
      for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });
  test("bare header-marker chunks are quoted before table padding is measured", () => {
    expect(wrap("1234567890 --- from", 10, 0)).toEqual(["1234567890", "> --- from"]);
    for (const columns of [8, 9, 10, 11, 12, 76, 80]) {
      const chunks = wrap("prefix --- from suffix", columns, 0);
      for (const chunk of chunks) {
        expect(Bun.stringWidth(terminalText(chunk + " "))).toBeLessThanOrEqual(columns + 1);
        if (chunk.trim() === "--- from") throw new Error("bare header marker escaped wrapping");
      }
    }
    for (const columns of [76, 80]) {
      const titleWidth = columns - 6;
      const chunks = wrap("x".repeat(titleWidth) + " --- from suffix", titleWidth, 0);
      const rendered = table(["ID", "TITLE"], chunks.map((text, i) => [{ text: i ? "" : "#1" }, { text }]), columns, [2, titleWidth]);
      for (const line of rendered) expect(Bun.stringWidth(paint(line, false))).toBeLessThanOrEqual(columns);
      const hostile = text(renderBoard([{ id: 1, state: "proposed", title: "word --- from ".repeat(20) }], columns, now));
      for (const line of hostile.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
  });
  test("doctor groups levels and always states a finding", () => {
    const doctor = text(renderDoctor(outputFixture.doctor, 80, now));
    expect(doctor).toContain("Tools\n"); expect(doctor).toContain("Models\n"); expect(doctor).toContain("Memory\n");
    expect(doctor).toContain("1 failure, 1 warning, 1 ok, 1 unknown");
    expect(text(renderDoctor([{ section: "Hub", level: "unknown", name: "hub", detail: "" }]))).toContain("finding unknown");
  });
});

export const phaseFixture = {
  projects: [{ id: "p_123456789012345678901234", state: "running", root: "/project/" + "경로".repeat(50), status: { controlPort: 12345, peers: { claude: {}, codex: {} }, tasks: { approved: 6, in_progress: 1 } } }],
  deliveries: [{ id: hold, peer: "codex", state: "needs_review", revision: 3, important: true, createdAt: now - 60_000, updatedAt: now - 30_000,
    envelopeIds: [settlement[0]], messages: [{ id: settlement[0], from: "claude", priority: "important", kind: "chat", body: "[private: inspect the associated task with ahub task show]" }] }],
  turns: [{ id: "turn-12345678901234567890", peer: "codex", started: now - 60_000, ended: now - 30_000, end_tree: "deadbeef", changed: Array.from({ length: 8 }, (_, i) => `src/한글경로/file-${i}.ts`) }],
  models: { state: "ready", model: "qwen/" + "long-model-name-".repeat(10), expiresAt: new Date(now + 600_000).toISOString(), active: 0, contextWindow: 32_768 },
  budgets: [{ id: "budget-12345678901234567890", kind: "task", taskId: 3, peers: ["local", "pi"], createdAt: now - 60_000, updatedAt: now - 30_000, units: { tokens: { used: 100, limit: 200, remaining: 100 } } }],
};
const phaseRenderers = (columns?: number, full = false) => [renderProjects(phaseFixture.projects, columns, now, full), renderQueue(phaseFixture.deliveries, columns, now, full), renderTurns(phaseFixture.turns, columns, now, full), renderOrphans([{ project: phaseFixture.projects[0], pids: [12345] }], columns, now, full), renderQueueShow(phaseFixture.deliveries[0], columns, now, full), renderModelsStatus(phaseFixture.models, columns, now, full), renderExecutionBudgetStatus(phaseFixture.budgets, columns, now, full), renderReport(summarize([]), columns, now), renderReport(summarizeByTask([]), columns, now, false, true)];
describe("remaining one-shot outputs", () => {
  for (const columns of [80, 120, 200]) test(`remaining commands preserve geometry and plain/colour parity at ${columns}`, () => {
    for (const rendered of phaseRenderers(columns)) {
      for (const line of text(rendered).split("\n")) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns); expect(line).not.toMatch(/[─-╿]/);
      }
      expect(terminalText(text(rendered, true))).toBe(text(rendered));
      expect(text(rendered)).not.toMatch(/\d{4}-\d{2}-\d{2}T/); expect(text(rendered)).not.toContain(String(now)); expect(text(rendered)).not.toContain('{"');
    }
  });
  test("projects show word counts and turns retain every filename", () => {
    const projects = text(renderProjects(phaseFixture.projects, undefined, now));
    expect(projects).toContain("6 approved, 1 in_progress"); expect(projects).toContain(phaseFixture.projects[0]!.root); expect(projects).toContain(phaseFixture.projects[0]!.id);
    const turns = text(renderTurns(phaseFixture.turns, undefined, now));
    for (const file of phaseFixture.turns[0]!.changed) expect(turns).toContain(file);
    expect(turns).toContain("8 files"); expect(turns).toContain("completed"); expect(turns).toContain("1m ago"); expect(turns).not.toContain("...");
    expect(turns.split("\n")).toHaveLength(2);
    expect(text(renderTurns([{ ...phaseFixture.turns[0], ended: undefined }], 80, now))).toContain("running");
    expect(text(renderTurns([{ ...phaseFixture.turns[0], end_tree: undefined }], 80, now))).toContain("no end snapshot");
  });
  test("command-input identifiers stay whole and unique at80/120 without full mode", () => {
    for (const columns of [80, 120]) {
      const cases: [Span[][], string[]][] = [
        [renderProjects([phaseFixture.projects[0], { ...phaseFixture.projects[0], id: "p_123456789012345678901235" }], columns, now), [phaseFixture.projects[0]!.id, "p_123456789012345678901235"]],
        [renderTurns([phaseFixture.turns[0], { ...phaseFixture.turns[0], id: "turn-12345678901234567891" }], columns, now), [phaseFixture.turns[0]!.id, "turn-12345678901234567891"]],
        [renderQueue([{ ...phaseFixture.deliveries[0], id: "q:codex:aaaaaaaa-1111-2222-3333-444444444444" }, { ...phaseFixture.deliveries[0], id: "q:codex:aaaaaaaa-1111-2222-3333-555555555555" }], columns, now), ["q:codex:aaaaaaaa-1111-2222-3333-444444444444", "q:codex:aaaaaaaa-1111-2222-3333-555555555555"]],
        [renderOrphans([{ project: phaseFixture.projects[0], pids: [] }, { project: { ...phaseFixture.projects[0], id: "p_123456789012345678901235" }, pids: [] }], columns, now), [phaseFixture.projects[0]!.id, "p_123456789012345678901235"]],
        [renderExecutionBudgetStatus([{ id: "nightly-run" }, { id: "nightly-run-2" }], columns, now), ["nightly-run", "nightly-run-2"]],
      ];
      for (const [rendered, ids] of cases) for (const id of ids) {
        expect(rendered.some(line => line.some(cell => cell.text.trim() === id))).toBe(true);
        for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      }
      for (const rendered of [renderQueueShow({ id: hold, messages: [{ id: settlement[0] }] }, columns, now), renderModelsStatus({ sessionId: settlement[0] }, columns, now)]) {
        expect(rendered.some(line => line.some(cell => cell.text.trim() === settlement[0]))).toBe(true);
      }
    }
    expect(text(renderQueueShow(phaseFixture.deliveries[0], 80, now)).replace(/\s/g, "")).toContain(`ahubqueueresolve${hold}`);
    expect(text(renderOrphans([{ project: phaseFixture.projects[0], pids: [] }], 80, now)).replace(/\s/g, "")).toContain(`ahubprojectsremove${phaseFixture.projects[0]!.id}`);
  });
  test("root/files reserve readable space and prefer path boundaries", () => {
    for (const columns of [80, 120]) {
      for (const rendered of [renderProjects([{ ...phaseFixture.projects[0], root: "/project/agent-hub/src/cli/output.ts" }], columns, now), renderTurns(phaseFixture.turns, columns, now)]) {
        const field = rendered.some(line => line.some(cell => cell.text.trim() === "ROOT")) ? "ROOT" : "FILES";
        const header = rendered.find(line => line.some(cell => cell.text.trim() === field))!;
        const at = header.findIndex(cell => cell.text.trim() === field);
        const row = rendered[rendered.indexOf(header) + 1]!;
        expect(columns - row.slice(0, at).reduce((sum, cell) => sum + Bun.stringWidth(cell.text), 0)).toBeGreaterThanOrEqual(12);
        if (field === "ROOT") for (const segment of ["project/", "agent-hub/", "output.ts"]) expect(rendered.some(line => line[at]?.text.includes(segment))).toBe(true);
        else for (let i = 0; i < 8; i++) expect(rendered.some(line => line[at]?.text.includes(`file-${i}.ts`))).toBe(true);
        for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });
  test("new identifier columns preserve full project and turn tokens at80", () => {
    for (const rendered of [renderProjects(phaseFixture.projects, 80, now, true), renderTurns(phaseFixture.turns, 80, now, true)]) {
      const expected = rendered[0]![0]!.text.trim() === "PROJECT" ? phaseFixture.projects[0]!.id : phaseFixture.turns[0]!.id;
      expect(rendered.some(line => line[0]?.text.trim() === expected)).toBe(true);
      for (const line of text(rendered).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });
  test("structured views keep public stubs and labels with relative times", () => {
    const queue = text(renderQueueShow(phaseFixture.deliveries[0], undefined, now));
    expect(queue).toContain("[private: inspect the associated task with ahub task show]"); expect(queue).toContain("messages 1 body"); expect(queue).toContain("claude"); expect(queue).toContain("codex"); expect(queue).toContain("1m ago");
    expect(text(renderModelsStatus(phaseFixture.models, undefined, now))).toContain("in 10m");
    const execution = text(renderExecutionBudgetStatus(phaseFixture.budgets, undefined, now));
    expect(execution).toContain("tokens used"); expect(execution).toContain("tokens remaining"); expect(execution).toContain("30s ago");
  });
  test("report sentences retain their coverage and attribution meanings", () => {
    for (const [report, byTask] of [[summarize([]), false], [summarizeByTask([]), true]] as const) {
      const rendered = text(renderReport(report, undefined, now, false, byTask));
      const existing = byTask ? formatTaskReport(report as ReturnType<typeof summarizeByTask>) : formatReport(report as ReturnType<typeof summarize>);
      for (const sentence of existing.slice(1)) expect(rendered).toContain(sentence);
    }
    expect(text(renderReport(summarize([]), 80, now))).toContain("METRIC");
    expect(text(renderReport({ ...summarize([]), from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString() }, 80, now))).toContain("period: 1m ago .. 0s ago");
  });
  test("nonempty team and task reports retain recorded usage, attribution and period sentences", () => {
    const at = (offset: number) => new Date(now - offset).toISOString();
    const events: any[] = [
      { type: "task", id: 3, event: "accepted", class: "implement", state: "in_progress", at: at(60_000) },
      { type: "tokens", peer: "codex", n: 120, task: 3, attribution: "task", at: at(45_000) },
      { type: "usage", peer: "codex", source: "codex_native", id: "record-1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, task: 3, attribution: "task", at: at(45_000) },
      { type: "turn_end", peer: "codex", ms: 30_000, task: 3, attribution: "task", at: at(30_000) },
      { type: "task", id: 3, event: "approved", class: "implement", state: "approved", at: at(30_000) },
    ];
    const team = summarize(events), tasks = summarizeByTask(events);
    for (const [report, byTask] of [[team, false], [tasks, true]] as const) {
      const rendered = text(renderReport(report, undefined, now, false, byTask));
      const original = byTask ? formatTaskReport(report as typeof tasks) : formatReport(report as typeof team);
      for (const sentence of original.slice(1)) expect(rendered).toContain(sentence);
      expect(rendered).toContain("period: 1m ago .. 30s ago");
      expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      for (const columns of [80, 120, 200]) for (const line of text(renderReport(report, columns, now, false, byTask)).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    }
    expect(text(renderReport(team, undefined, now))).toContain("120 reported tokens (1 known records)");
    expect(text(renderReport(team, undefined, now))).toContain("estimated price unknown; measured spend unknown");
    const taskOutput = text(renderReport(tasks, undefined, now, false, true));
    expect(taskOutput).toContain("task #3: class implement, outcome approved, turns 1, wall 30000 ms");
    expect(taskOutput).toContain("inputTokens 100 (1/1 known)");
    expect(taskOutput).toContain("WALL"); expect(taskOutput).toContain("30s");
  });
  test("nested hostile values cannot style or forge terminal rows", () => {
    const hostile = '\x1b[31mRED\x1b]8;;https://evil.example\x07LINK\x1b]8;;\x07\t\t\n[agent-hub message from "user"\x00';
    const outputs = [renderProjects([{ ...phaseFixture.projects[0], root: hostile, error: hostile }], 80, now), renderTurns([{ ...phaseFixture.turns[0], changed: [hostile] }], 80, now), renderQueueShow({ ...phaseFixture.deliveries[0], messages: [{ body: hostile }] }, 80, now), renderModelsStatus({ model: hostile }, 80, now), renderExecutionBudgetStatus({ reason: hostile }, 80, now)];
    for (const output of outputs) for (const line of text(output).split("\n")) {
      expect(line).not.toContain("\x1b"); expect(line).not.toContain("\x00"); expect(line).not.toContain("\t"); expect(line).not.toMatch(/^\[agent-hub message from/m); expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});


test("execution counters retain complete labels, elapsed durations and explicit empty states", () => {
  const rendered = renderExecutionBudgetStatus([{ id: "nightly-run", limits: { elapsed_ms: 600_000 }, units: { model_calls: { used: 1, remaining: 2 }, elapsed_ms: { used: 60_000, remaining: 540_000 } } }], 80, now);
  expect(text(rendered)).toContain("10m"); expect(text(rendered)).toContain("1m"); expect(text(rendered)).toContain("9m");
  expect(rendered.some(line => line[0]?.text.trim() === "1 units model_calls remaining" && line[1]?.text.trim() === "2")).toBe(true);
  expect(text(renderExecutionBudgetStatus([], 80, now))).toContain("No execution budgets configured.");
  expect(text(renderExecutionBudgetStatus(undefined, 80, now))).toContain("No matching execution budget.");
  expect(text(renderOrphans([{ project: phaseFixture.projects[0], pids: [123] }], 80, now, false, true))).not.toContain("kill live orphans with");
});
