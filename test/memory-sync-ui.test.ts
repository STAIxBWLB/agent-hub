import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const start = html.indexOf("function memorySyncLine(sync) {"), end = html.indexOf("function renderMemory(", start);
const time = html.split("\n").find(line => line.startsWith("const time ="));
if (start < 0 || end <= start || !time) throw new Error("memory sync UI closure moved; bind its actual production dependencies");
const render = runInNewContext(`${time}\n${html.slice(start, end)}\nmemorySyncLine`) as (sync: unknown) => string;

test("Memory row keeps profile readiness separate from automatic sync failure and exposes a safe action", () => {
  const canary = "PRIVATE-ROW-AND-ERROR-CANARY";
  const text = render({ state: "failed", cause: "declined", declinedCount: 3, at: Date.parse("2026-11-05T01:00:00Z"),
    error: canary, ids: [canary], nextStep: canary });
  expect(text).toContain("failed (declined / 3 declined)");
  expect(text).toContain("ahub memory declined");
  expect(text).not.toContain(canary);
  expect(text).not.toContain("Invalid Date");
  expect(html).toContain('id="memory-sync-status"');
});

test("Memory sync UI does not turn unavailable states or invalid timestamps into healthy/NaN status", () => {
  for (const state of ["disabled", "unavailable", "notrun", "unknown"]) {
    expect(render({ state })).toContain(state);
    expect(render({ state })).not.toContain("ok");
  }
  const invalid = render({ state: "failed", cause: "transport", at: Number.MAX_SAFE_INTEGER });
  expect(invalid).toContain("last unknown");
  expect(invalid).toContain("run ahub memory sync as a person");
  expect(invalid).not.toMatch(/Invalid Date|NaN/);
});
