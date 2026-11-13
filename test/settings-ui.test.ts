import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { checkSettingValue, parseSettingText, settingDef, settingRefusal, type SettingDef } from "../src/hub/settings.ts";
import { validateRawConfig } from "../src/hub/config-apply.ts";

const def = (key: string): SettingDef => { const row = settingDef(key); if (typeof row === "string") throw new Error(row); return row; };
test("reviewer quota opt-outs use existing guarded settings and preserve finite numeric/off/inherit values", () => {
  const gate = def("review.gate"), unknown = def("review.unknown_quota");
  expect(gate.risk).toBe("raises"); expect(unknown.risk).toBe(gate.risk); expect(unknown.applies).toBe(gate.applies);
  for (const [raw, expected] of [["off", "off"], ["0.75", 0.75], ["0", 0], ["1", 1], ["inherit", null]] as const)
    expect(checkSettingValue(gate, parseSettingText(gate, raw))).toBe(expected);
  for (const value of ["on", "false", false, NaN, Infinity, -0.1, 1.1]) expect(() => checkSettingValue(gate, value)).toThrow(/off.*number/);
  for (const value of ["skip", "pass"]) expect(checkSettingValue(unknown, parseSettingText(unknown, value))).toBe(value);
  expect(() => checkSettingValue(unknown, "allow")).toThrow(/skip.*pass/);
  for (const [row, value] of [[gate, "off"], [unknown, "pass"]] as const) {
    expect(settingRefusal(row, value, "ordinary")).toContain("settings session"); expect(settingRefusal(row, value, "conductor")).toContain("not an operational");
    expect(settingRefusal(row, value, "settings")).toBeUndefined(); expect(settingRefusal(row, value, "terminal")).toBeUndefined();
  }
  expect(() => validateRawConfig({ review: { gate: "off", unknown_quota: "pass" } })).not.toThrow();
  for (const review of [{ gate: "on" }, { unknown_quota: "allow" }, { gate: false }, { unknown_quota: true }])
    expect(() => validateRawConfig({ review })).toThrow(/review\.(gate|unknown_quota)/);
});

class Node {
  children: Node[] = []; attrs: Record<string, string> = {}; listeners: Record<string, () => unknown> = {}; dataset: Record<string, string> = {};
  value = ""; id = ""; type = ""; name = ""; disabled = false; htmlFor = "";
  constructor(public tag: string, public textContent = "", public className = "") {}
  append(...items: Node[]) { this.children.push(...items); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, fn: () => unknown) { this.listeners[key] = fn; }
  all(): Node[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
test("actual dashboard control preserves off/numbers/inherit and sends invalid text to validation instead of NaN/null", async () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8"), script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!).find(s => s.includes("function settingRow(row, raise)"))!;
  const parsed = ts.createSourceFile("settings.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "settingRow")!;
  const row = { ...def("review.gate"), value: "off", fileValue: "off", file: "config.local.json", source: "config.local.json" }, sent: Record<string, unknown>[] = [];
  const node = runInNewContext(fn.getText(parsed) + "; settingRow(row,true)", { row, managerMode:false, snapshotValid:true, settingText:String,
    el:(tag:string,text?:string,cls?:string)=>new Node(tag,text,cls), badge:(text:string)=>new Node("span",text),
    action:async (payload:Record<string,unknown>)=>{sent.push(payload);return true;} }) as Node;
  const input = node.all().find(n => n.tag === "input")!, save = node.all().find(n => n.tag === "button" && n.textContent === "Save")!;
  expect(input.type).toBe("text"); expect(input.value).toBe("off"); expect(input.name).toBe("review.gate");
  expect(node.all().find(n => n.tag === "label")!.htmlFor).toBe(input.id); expect(row.label).toContain("0..1 or off");
  for (const [text, expected] of [["off","off"],["0.35",0.35],["",null],["bad-value","bad-value"]] as const) {
    input.value = text; await save.listeners.click!(); expect(sent.at(-1)!.value).toBe(expected);
    expect(JSON.parse(JSON.stringify(sent.at(-1))).value).toBe(expected);
  }
  expect(() => checkSettingValue(def("review.gate"), sent.at(-1)!.value)).toThrow(/off.*number/);
});
