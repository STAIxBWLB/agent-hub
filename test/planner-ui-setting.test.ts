import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { checkSettingValue, settingDef } from "../src/hub/settings.ts";

class Node {
  children: Node[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {};
  dataset: Record<string, string> = {};
  value = ""; id = ""; htmlFor = "";
  constructor(public tag: string, public textContent = "") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, run: () => unknown) { this.listeners[key] = run; }
  all(): Node[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
function page(fileValue: string | string[] | null) {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function settingRow("), end = html.indexOf("/* Structure (#689)", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const sent: { action: string; key: string; value: unknown }[] = [];
  const row = { key: "planner", group: "Roles", label: "Planners", type: "peers", value: ["codex"], fileValue,
    file: "config.local.json", source: "config.local.json", applies: "live", risk: "raises" };
  // Exercise the actual dashboard editor and read() closure, with only its DOM/control ports supplied.
  const node = runInNewContext(`${html.slice(start, end)};settingRow(row,true)`, { row, managerMode: false, snapshotValid: true,
    settingText: String, el: (tag: string, text?: string) => new Node(tag, text), badge: (text: string) => new Node("span", text),
    action: async (payload: { action: string; key: string; value: unknown }) => { sent.push(payload); return true; },
  }) as Node;
  const input = node.all().find(child => child.tag === "input")!;
  const save = node.all().find(child => child.attrs["aria-label"] === "Save Planners")!;
  expect(input).toBeDefined(); expect(save).toBeDefined();
  return { input, sent, save: () => save.listeners.click!() };
}

for (const [fileValue, shown, submitted, normalized] of [
  ["claude", "claude", ["claude"], "claude"],
  [["claude", "codex"], "claude, codex", ["claude", "codex"], ["claude", "codex"]],
  [null, "", null, null],
] as const) test(`#525 planner editor preserves ${JSON.stringify(fileValue)} through an unchanged save and server normalization`, async () => {
  const f = page(fileValue === null || typeof fileValue === "string" ? fileValue : [...fileValue]);
  // Removing the scalar-string branch empties this input and silently submits inheritance.
  expect(f.input.value).toBe(shown);
  await f.save();
  expect(f.sent).toEqual([{ action: "setting", key: "planner", value: submitted }]);
  const definition = settingDef("planner"); if (typeof definition === "string") throw new Error(definition);
  expect(checkSettingValue(definition, f.sent[0]!.value)).toEqual(normalized);
});
