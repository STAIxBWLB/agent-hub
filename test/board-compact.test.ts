import { expect, test } from "bun:test";
import { renderBoard, stageCode } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

// #724: `ahub board` at a terminal width is one line per task; --full keeps the wrapped layout.
const now = Date.parse("2026-10-23T00:00:00Z");
const text = (lines: ReturnType<typeof renderBoard>) => lines.map(line => paint(line, false)).join("\n");
const next = "issue identity missing: name one issue (title #N, refs or hub_sdlc_record)";
const tasks = Array.from({ length: 15 }, (_, i) => ({
  id: 100 + i, state: i % 3 === 0 ? "changes_requested" : i % 3 === 1 ? "in_progress" : "proposed", owner: ["codex", "jcode", "claude"][i % 3], reviewer: "claude", class: "implement", created: now - i * 3_600_000,
  title: i === 4 ? "제주한라대학교 AI 도구를 활용한 구현과 검증 ".repeat(6) : `Task ${i}: ${"a long descriptive title that keeps going ".repeat(4)}`,
  deps: i === 2 ? [113, 114, 115] : i === 3 ? [113] : [], signals: i === 5 ? ["pii"] : [], lifecycle: { stage: "intent", next, actor: "owner/planner" },
}));

for (const columns of [80, 120, 200]) test(`every task is one line at ${columns} columns, then the summary and the legend (#724)`, () => {
  const lines = text(renderBoard(tasks, columns, now)).split("\n");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  expect(lines.filter(line => line.startsWith("#"))).toHaveLength(15);
  expect(lines[0]).toMatch(/^ID +STATE/);
  expect(lines[0]).toContain("TITLE");
  expect(lines[16]).toBe("");
  expect(lines[17]).toStartWith("15 tasks:");
  expect(lines.slice(18).join(" ")).toContain("STAGE: [#---] SDLC progress");
  const board = lines.join("\n");
  expect(board).toContain(columns > 80 ? "intent: issue?" : "] issue?");
  expect(board).not.toContain("name one issue");
  expect(board).toContain("#113,+2");
  expect(board).toContain("...");
  if (columns > 80) expect(board).toContain("(ahub task show 105)");
});

test("--full and piped output keep the wrapped layout with the whole advice (#724)", () => {
  const full = text(renderBoard(tasks, 80, now, true));
  expect(full.replace(/\s/g, "")).toContain("after#113,#114,#115");
  expect(text(renderBoard(tasks, 400, now, true))).toContain(next);
  expect(full.split("\n").length).toBeGreaterThan(40);
  const piped = text(renderBoard(tasks, undefined, now));
  expect(piped).toContain(tasks[0]!.title);
  expect(piped).toContain(next);
});

test("stage codes are short and an unknown blocker is cut (#724)", () => {
  expect(stageCode(next)).toBe("issue?");
  expect(stageCode("required check ci: not successful on current head")).toBe("CI?");
  expect(stageCode("person may inspect merge readiness; no automatic merge")).toBe("ready");
  expect(stageCode("lifecycle stage definition unknown")).toBe("lifecycle...");
});
