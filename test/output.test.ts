import { describe, expect, test } from "bun:test";
import { PALETTE, paint, terminalText } from "../src/cli/console-state.ts";
import { outputWidth, renderStatus, renderBoard, renderBudget, renderDoctor, type DoctorCheck } from "../src/cli/output.ts";
const now = 1_800_000_000_000;
const settlement = ["8d03b496-1111-2222-3333-444444444444", "3325f7a0-1111-2222-3333-444444444444"];
const hold = "abcdef12-1111-2222-3333-444444444444";
export const outputFixture = {
  status: { pid: 25893, controlPort: 12345, version: "0.12.22", cwd: "/project/agent-hub", peers: {
    claude: { state: "idle", attached: true, queued: 0, context: { used: 0.8, freshness: "fresh", source: "claude_statusline", measuredAt: now - 14_000 } },
    codex: { state: "busy", attached: true, queued: 2, liveAccepted: settlement, heldBy: hold, holdNote: "waiting for owner review", paused: "manual", context: { used: 0.34, freshness: "fresh", source: "codex_token_usage", measuredAt: now - 60_000 } },
    kimi: { state: "idle", attached: true, permissionMode: "ask-when-needed", context: { used: 0.25, freshness: "fresh", source: "acp_usage_update", measuredAt: now - 120_000 } },
    pi: { state: "idle", attached: true, toolsOnly: "tools-only: ahub pi", context: { used: null, freshness: "unknown", source: null, measuredAt: null } },
  }, tasks: { approved: 6, in_progress: 1 }, budget: { claude: { windows: [{ id: "5h", used: 0.23, resetsAt: now + 600_000 }] } } },
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
    expect(board.replace(/\s/g, "")).toContain("ahubtaskshow3");
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
  test("doctor groups levels and always states a finding", () => {
    const doctor = text(renderDoctor(outputFixture.doctor, 80, now));
    expect(doctor).toContain("Tools\n"); expect(doctor).toContain("Models\n"); expect(doctor).toContain("Memory\n");
    expect(doctor).toContain("1 failure, 1 warning, 1 ok, 1 unknown");
    expect(text(renderDoctor([{ section: "Hub", level: "unknown", name: "hub", detail: "" }]))).toContain("finding unknown");
  });
});
