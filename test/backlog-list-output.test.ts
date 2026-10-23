import { expect, test } from "bun:test";
import { renderBacklog } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

// #399: `ahub backlog list` is a table, not raw JSON.
const now = Date.parse("2026-10-23T00:00:00Z");
const text = (lines: ReturnType<typeof renderBacklog>) => lines.map(line => paint(line, false)).join("\n");
const cards = Array.from({ length: 12 }, (_, i) => ({
  id: 300 + i, class: "implement", state: "backlog", priority: i % 3, rank: i === 0 ? undefined : 12 - i, reserved: ["codex", "jcode", "claude"][i % 3],
  deps: i === 1 ? [342, 343, 344] : i === 2 ? [339] : [], created: now - i * 3_600_000,
  title: `Card ${i}: ${"a long descriptive backlog title that keeps going ".repeat(3)}`,
}));

for (const columns of [80, 120, 200]) test(`one line per card at ${columns} columns, ranked first, then a summary (#399)`, () => {
  const lines = text(renderBacklog(cards, columns, now)).split("\n");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  const rows = lines.filter(line => /^\S+\s+#3\d\d\b/.test(line));
  expect(rows).toHaveLength(12);
  expect(rows[0]).toMatch(/^1\s+#311\b/);
  expect(rows[11]).toMatch(/^-\s+#300\b/);
  expect(lines.join("\n")).toContain("#342,+2");
  expect(lines.at(-1)).toBe("12 backlog cards; reserved: claude 4, codex 4, jcode 4");
});

test("piped and --full output keep whole titles and every dependency (#399)", () => {
  for (const out of [text(renderBacklog(cards, undefined, now)), text(renderBacklog(cards, 80, now, true))]) {
    expect(out.replace(/\s/g, "")).toContain(cards[1]!.title.replace(/\s/g, ""));
    expect(out).toContain("#342,#343,#344");
  }
});

test("an empty backlog says so (#399)", () => {
  expect(text(renderBacklog([], 80, now))).toBe("no backlog cards");
});
