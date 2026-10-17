import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderStatus } from "../src/cli/output.ts";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const settingsCode = html.slice(html.indexOf("const SETTING_GROUPS ="), html.indexOf("function syncStarts("));
class Element {
  children: Element[] = []; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {}; textContent: string; value = ""; id = ""; type = ""; step = ""; min = ""; max = ""; hidden = false; disabled = false; open = false; htmlFor = "";
  constructor(public tag: string, text = "", public className = "") { this.textContent = text; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ""; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, listener: () => unknown) { this.listeners[key] = listener; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  text() { return this.all().map(node => node.textContent).join("\n"); }
}
const row = (overrides: Record<string, unknown> = {}) => ({ key: "research.enabled", group: "Switches", label: "Research records", type: "boolean", file: "config.local.json", applies: "restart", restartReason: "research observer is constructed at startup", risk: "safe", value: true, fileValue: false, pending: false, source: "config.local.json", ...overrides });
function page(settings: unknown, managerMode = false, snapshotValid = true) {
  const nodes = new Map<string, Element>(), signatures = new Map<string, string>(), sent: Record<string, unknown>[] = [];
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element("div")); return nodes.get(id)!; };
  const context: Record<string, any> = { $: get, managerMode, snapshotValid, stopped: false, Date, settings,
    el: (tag: string, text?: string, cls?: string) => new Element(tag, text, cls), badge: (text: string, cls?: string) => new Element("span", text, cls),
    empty: (target: Element, text: string) => target.append(new Element("p", text)),
    update: (id: string, data: unknown, draw: (node: Element) => void) => { const next = JSON.stringify(data); if (signatures.get(id) === next) return; signatures.set(id, next); get(id).replaceChildren(); draw(get(id)); },
    button: (text: string, payload: Record<string, unknown>) => { const node = new Element("button", text); node.dataset.mutation = "project"; node.disabled = managerMode && !snapshotValid; node.listeners.click = () => { sent.push(payload); }; return node; },
    action: async (payload: Record<string, unknown>) => { sent.push(payload); return true; },
    canMutate: () => !managerMode || snapshotValid, context: () => ({ projectId: "project-a", instanceId: "instance-a", generation: 1 }), notice: () => {},
  };
  runInNewContext(`${settingsCode}; globalThis.redraw = next => renderSettings(next); renderSettings(settings);`, context);
  return { get, sent, redraw: context.redraw as (settings: unknown) => void };
}

test("#439 dashboard reload uses its existing project action and respects stale snapshots", async () => {
  const view = page({ rows: [row()], pendingRestart: [] });
  const reload = view.get("settings").all().find(node => node.textContent === "Reload configuration");
  expect(reload).toBeDefined(); expect(reload?.dataset.mutation).toBe("project");
  await reload!.listeners.click!(); expect(view.sent).toEqual([{ action: "setting_reload" }]);
  const stale = page({ rows: [row()], pendingRestart: [] }, true, false);
  expect(stale.get("settings").all().find(node => node.textContent === "Reload configuration")?.disabled).toBe(true);
});

test("#439 dashboard shows canonical apply classes, running/file values and pending reasons without losing drafts", () => {
  const rows = [row(), row({ key: "pi.auto_start", group: "Start", applies: "next use", restartReason: undefined, value: false, fileValue: null, pending: null })];
  const settings = { rows, pendingRestart: [{ key: "research.enabled", reason: "research observer is constructed at startup" }, { key: "models", reason: "model inventory is built at startup" }] };
  const view = page(settings), root = view.get("settings");
  expect(root.text()).toContain("Running: true"); expect(root.text()).toContain("File: false");
  expect(root.text()).toContain("restart"); expect(root.text()).toContain("next use"); expect(root.text()).toContain("File: (not set)");
  expect(root.text()).toContain("models: model inventory is built at startup");
  const control = root.all().find(node => node.id === "setting-research-enabled")!;
  expect(control.value).toBe("false"); control.value = "true";
  view.redraw({ ...settings, pendingRestart: [{ key: "models", reason: "updated restart reason" }] });
  expect(root.all().find(node => node.id === "setting-research-enabled")).toBe(control); expect(control.value).toBe("true");
  expect(root.text()).toContain("models: updated restart reason");
});

test("#439 dashboard stays readable against an older snapshot without reload metadata", () => {
  const view = page({ rows: [row({ applies: "hub start", fileValue: undefined, restartReason: undefined })] });
  expect(view.get("settings").text()).toContain("Research records");
  expect(view.get("settings").text()).not.toContain("undefined");
  view.redraw(undefined); expect(view.get("settings").text()).toContain("This hub does not report settings.");
});

test("#439 human status lists pending restart keys and reasons safely at narrow widths", () => {
  const data = { peers: {}, pendingRestart: [{ key: "models", reason: "inventory requires restart\nfor a new backend\u001b[31m" }] };
  for (const columns of [undefined, 40, 80]) {
    const rendered = renderStatus(data, columns), output = rendered.map(line => line.map(span => span.text).join("")).join("\n");
    expect(output).toContain("models"); expect(output.replace(/\s+/g, " ")).toContain("inventory requires restart");
    expect(output).not.toContain(String.fromCharCode(27));
    if (columns) for (const line of rendered) expect(Bun.stringWidth(line.map(span => span.text).join(""))).toBeLessThanOrEqual(columns);
  }
  expect(renderStatus({ peers: {} }).flat().map(span => span.text).join(" ")).not.toContain("pending restart");
});

test("#439 reload action keeps the selected manager project and instance server-bound", async () => {
  const source = html.slice(html.indexOf("async function action(payload"), html.indexOf("function button(text"));
  const sent: unknown[] = [], control = new Element("button");
  const context: Record<string, any> = { stopped: false, managerMode: true, snapshotValid: true, viewGeneration: 4,
    selectedProjectId: "project-a", selectedInstanceId: "instance-a", pendingButtons: new WeakSet(), pendingStarts: new Map(),
    canMutate: () => true, context: () => ({ projectId: "project-a", instanceId: "instance-a", generation: 4 }),
    notice: () => {}, post: async (_path: string, payload: unknown) => { sent.push(payload); return { ok: true }; },
    control,
  };
  await runInNewContext(`${source}; action({action:'setting_reload'}, control);`, context);
  expect(sent).toEqual([{ action: "setting_reload", projectId: "project-a", instanceId: "instance-a" }]);
  expect(control.disabled).toBe(false);
});


test("#439 dashboard duration editor accepts and submits fractional numbers", async () => {
  const duration = row({ key: "task_sweep.interval_s", type: "number", applies: "live", restartReason: undefined, value: 300, fileValue: 1.5, pending: 1.5, min: 1, max: 2147483.647 });
  const view = page({ rows: [duration], pendingRestart: [] });
  const control = view.get("settings").all().find(node => node.id === "setting-" + String(duration.key).replaceAll(".", "-"))!;
  expect(control.tag).toBe("input"); expect(control.type).toBe("number"); expect(control.step).toBe("any"); expect(control.value).toBe("1.5");
  control.value = "2.5";
  await view.get("settings").all().find(node => node.textContent === "Save")!.listeners.click!();
  expect(view.sent).toEqual([{ action: "setting", key: duration.key, value: 2.5 }]);
});
