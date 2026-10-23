import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { contrast } from "../src/ui/peer-palette.ts";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const script = html.slice(html.indexOf("const SETTING_GROUPS ="), html.indexOf("function syncStarts("));
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");

class Element {
  children: Element[] = []; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {}; textContent: string; value = ""; id = ""; type = ""; hidden = false; disabled = false; open = false; htmlFor = ""; placeholder = ""; rows = 0;
  constructor(public tag: string, text = "", public className = "") { this.textContent = text; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ""; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, listener: () => unknown) { this.listeners[key] = listener; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  text() { return this.all().map(node => node.textContent).join("\n"); }
}
const existing = { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" }, "jcode-two": { kind: "jcode", roles: ["implementer"] } };
const edit = { revisions: { "config.local.json": "a".repeat(64), "sdlc.toml": "absent" },
  instances: [{ id: "codex-review", fields: existing["codex-review"], tier3: [] }, { id: "jcode-two", fields: existing["jcode-two"], tier3: ["jcode_home", "model"] }],
  blocks: [{ path: "review.pool", value: ["claude", "codex"] }, { path: "context.gate", value: 0.8 }],
  sdlc: { mode: "advise", requiredChecks: ["gate"], pending: false },
  tier3: [{ key: "kimi_cmd", set: true, command: "ahub settings edit config.local.json set kimi_cmd <json>" }, { key: "instances.jcode-two.model", set: true, command: "ahub settings edit config.local.json set instances.jcode-two.model <json>" }],
  backups: [{ name: "config.local.json.1700000000000.abcdef12.bak", file: "config.local.json", at: 1_700_000_000_000, bytes: 321 }],
  fields: { instance: ["kind", "roles", "start_mode", "review_mode", "readOnly", "worktree", "permission_mode"], tier3Instance: ["jcode_home", "provider", "model", "provider_profile"] } };
function page(settings: Record<string, unknown>, session = true) {
  const nodes = new Map<string, Element>(), signatures = new Map<string, string>(), sent: Record<string, unknown>[] = [];
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element("div")); return nodes.get(id)!; };
  const replies: Record<string, unknown>[] = [];
  const context: Record<string, any> = { $: get, managerMode: false, snapshotValid: true, stopped: false, Date, JSON, settings,
    el: (tag: string, text?: string, cls?: string) => new Element(tag, text, cls), badge: (text: string, cls?: string) => new Element("span", text, cls),
    empty: (target: Element, text: string) => target.append(new Element("p", text)),
    update: (id: string, data: unknown, draw: (node: Element) => void) => { const next = JSON.stringify(data); if (signatures.get(id) === next) return; signatures.set(id, next); get(id).replaceChildren(); draw(get(id)); },
    button: (text: string, payload: Record<string, unknown>) => { const node = new Element("button", text); node.dataset.mutation = "project"; node.listeners.click = () => sent.push(payload); return node; },
    action: async (payload: Record<string, unknown>) => { sent.push(payload); return true; },
    post: async (_path: string, payload: Record<string, unknown>) => { sent.push(payload); return replies.shift() ?? { ok: true, lines: [] }; },
    canMutate: () => true, context: () => ({ projectId: "p", instanceId: "i", generation: 1 }), notice: () => {},
  };
  runInNewContext(`${script}; globalThis.redraw = next => renderSettings(next); renderSettings(settings);`, context);
  return { get, sent, replies, redraw: context.redraw as (next: unknown) => void, session };
}
const withEdit = (extra: Record<string, unknown> = {}) => ({ rows: [], pendingRestart: [], sessionUntil: Date.now() + 600_000, configEdit: { ...edit, ...extra } });

test("#689 the Structure group lists each instance with its tier 2 fields and the lifecycle, inside a settings session", () => {
  const root = page(withEdit()).get("settings"), text = root.text();
  for (const expected of ["Structure", "codex-review", "jcode-two", "review.pool", "context.gate", "advise", "required checks"]) expect(text, expected).toContain(expected);
  const group = root.all().find(node => node.className === "structure-group")!;
  const labels = group.all().filter(node => node.tag === "button").map(node => node.textContent);
  expect(labels).toEqual(["Preview change", "Preview change"]); // the lifecycle form and the instance form; no control that does not act, no write before a preview
});

test("#689 every tier 3 key is shown read-only with the console command, and has no input, no button and no value", () => {
  const root = page(withEdit()).get("settings");
  const group = root.all().find(node => node.className === "structure-tier3")!;
  expect(group).toBeDefined();
  const text = group.text();
  expect(text).toContain("kimi_cmd"); expect(text).toContain("instances.jcode-two.model");
  expect(text).toContain("ahub settings edit config.local.json set kimi_cmd <json>");
  expect(text).toContain("runs code with the daemon's rights or chooses where secrets are read from");
  expect(group.all().filter(node => ["input", "select", "textarea", "button"].includes(node.tag))).toEqual([]);
  // The tier 3 fields of an instance are not offered in its form either.
  const jcode = root.all().find(node => node.className === "structure-instance" && node.text().includes("jcode-two"))!;
  expect(jcode.text()).not.toContain("jcode_home:"); expect(jcode.text()).toContain("set in the console");
});

test("#689 outside a settings session the Structure group is read-only and says how to open a session", () => {
  const root = page({ rows: [], pendingRestart: [], configEdit: edit }).get("settings");
  const group = root.all().find(node => node.className === "structure-group")!;
  expect(group.text()).toContain("ahub ui --settings");
  expect(group.all().filter(node => ["input", "select", "textarea"].includes(node.tag))).toEqual([]);
  expect(group.all().filter(node => node.tag === "button" && node.textContent === "Preview change")).toEqual([]);
});

test("#689 an older hub without config edits shows no Structure group and nothing undefined", () => {
  const root = page({ rows: [], pendingRestart: [] }).get("settings");
  expect(root.text()).not.toContain("Structure"); expect(root.text()).not.toContain("undefined");
});

test("#689 previewing sends the revision the hub reported and shows the loader's reason at the field; confirm needs a reason and sends it", async () => {
  const view = page(withEdit());
  const root = view.get("settings");
  const form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  field("id").value = "codex-fresh"; field("kind").value = "codex"; field("roles").value = "reviewer"; field("review_mode").value = "fresh";
  view.replies.push({ ok: false, error: "instances.codex-review.review_mode: fresh requires reviewer-only roles, headless mode and a declared fresh-review capability", field: "instances.codex-review.review_mode" });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[0]).toEqual({ action: "config_edit_preview", edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["instances", "codex-fresh"], value: { kind: "codex", roles: ["reviewer"], review_mode: "fresh" } }] } });
  expect(root.text()).toContain("fresh requires reviewer-only roles, headless mode");
  expect(form.all().some(node => node.textContent === "Write change")).toBe(false);
  field("start_mode").value = "headless";
  view.replies.push({ ok: true, lines: ['instances.codex-review: (unset) -> {"kind":"codex"} (pending restart)'], tier: 2 });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(root.text()).toContain("instances.codex-review: (unset)");
  const write = form.all().find(node => node.textContent === "Write change")!;
  expect(write).toBeDefined();
  await write.listeners.click!();
  expect(view.sent.filter(payload => payload.action === "config_edit_apply")).toEqual([]); // no reason, no write
  form.all().find(node => node.id === "structure-reason")!.value = "add the reviewer";
  await write.listeners.click!();
  expect(view.sent.at(-1)).toMatchObject({ action: "config_edit_apply", reason: "add the reviewer", edit: { file: "config.local.json", revision: "a".repeat(64) } });
  expect(JSON.stringify(view.sent.at(-1))).not.toContain("confirm");
});

test("#689 the lifecycle form sends sdlc.toml with its own revision, and a restart-pending lifecycle is badged", async () => {
  const view = page(withEdit({ sdlc: { mode: "advise", requiredChecks: ["gate"], pending: true } }));
  const root = view.get("settings");
  expect(root.text()).toContain("restart pending");
  const mode = root.all().find(node => node.id === "structure-sdlc-mode")!;
  mode.value = "enforce";
  view.replies.push({ ok: true, lines: ['sdlc.mode: "advise" -> "enforce" (pending restart)'], tier: 2 });
  await root.all().find(node => node.className === "structure-sdlc")!.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[0]).toEqual({ action: "config_edit_preview", edit: { file: "sdlc.toml", revision: "absent", set: [{ path: ["mode"], value: "enforce" }] } });
});

test("#689 the page never offers a confirm field for a tier 3 key, even when the hub's preview names one", async () => {
  const view = page(withEdit());
  const root = view.get("settings"), form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  field("id").value = "jcode-two"; field("kind").value = "jcode";
  view.replies.push({ ok: true, lines: ["x"], tier: 3, confirm: "instances.jcode-two" });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(form.all().some(node => node.textContent === "Write change")).toBe(false);
  expect(root.text()).toContain("console");
  expect(root.all().filter(node => node.placeholder.includes("type "))).toEqual([]);
});

test("#689 the Structure styles are token pairs that pass contrast in both themes, keep 44px targets and reflow at phone width", () => {
  const light = /:root\{([^}]+)\}/.exec(css)![1]!, dark = /:root\[data-theme="dark"\]\{([^}]+)\}/.exec(css)![1]!;
  const tokens = (block: string) => new Map([...block.matchAll(/--([a-z0-9-]+):#([0-9a-f]{6})\b/g)].map(m => [m[1]!, "#" + m[2]!]));
  const rules = [...css.matchAll(/(\.structure-[^{]+|\.meta\.structure-[a-z-]+)\{([^}]*)\}/g)].map(m => ({ selector: m[1]!, body: m[2]! }));
  expect(rules.length).toBeGreaterThan(5);
  const used = (body: string, prop: string) => new RegExp("(?:^|;)" + prop + ":var\\(--([a-z0-9-]+)\\)").exec(body)?.[1];
  const pairs: [string, string, string][] = [];
  for (const { selector, body } of rules) { const fg = used(body, "color"), bg = used(body, "background") ?? used(body, "background-color"); if (fg && bg) pairs.push([selector, fg, bg]); }
  expect(pairs.map(pair => pair[0]).join(" ")).toContain("structure-tier3");
  for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
    const t = tokens(block);
    for (const [selector, fg, bg] of pairs) expect(contrast(t.get(fg)!, t.get(bg)!), `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(css).toMatch(/\.structure-[^{]*(button|input|select)[^{]*\{[^}]*min-height:44px/);
  const phone = css.match(/@media\(max-width:600px\)\{([\s\S]*?)\}\s*(?=@media|$)/)?.[1] ?? "";
  expect(phone).toContain(".structure-");
});

test("#689 an instance form with no id or no kind says so on the page instead of doing nothing, and sends no request", async () => {
  const view = page(withEdit());
  const root = view.get("settings"), form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent).toEqual([]);
  expect(form.text()).toContain("An instance needs an id and a kind.");
  field("id").value = "codex-new"; // a new instance with no kind
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent).toEqual([]); expect(form.text()).toContain("An instance needs an id and a kind.");
  field("id").value = "codex-review"; // an existing one with nothing to change
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent).toEqual([]); expect(form.text()).toContain("Type the field to change");
});

test("#689 the lifecycle form with nothing typed says so on the page and sends no request", async () => {
  const view = page(withEdit());
  const lifecycle = view.get("settings").all().find(node => node.className === "structure-sdlc")!;
  await lifecycle.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent).toEqual([]);
  expect(lifecycle.text()).toContain("Give a mode or the required checks.");
});

test("#689 changing one field of an existing instance sends only that field as a leaf, so omitted fields and tier 3 fields are never replaced", async () => {
  const view = page(withEdit());
  const root = view.get("settings"), form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  field("id").value = "jcode-two"; field("roles").value = "verifier";
  view.replies.push({ ok: true, lines: ["x"], tier: 2 });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[0]).toEqual({ action: "config_edit_preview", edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["instances", "jcode-two", "roles"], value: ["verifier"] }] } });
  // Another existing instance: a field left blank stays as it is (no kind is needed to change one field).
  field("roles").value = ""; field("id").value = "codex-review"; field("review_mode").value = "fresh"; field("worktree").value = "";
  view.replies.push({ ok: true, lines: ["x"], tier: 2 });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[1]).toMatchObject({ edit: { set: [{ path: ["instances", "codex-review", "review_mode"], value: "fresh" }] } });
});

test("#689 a new instance still goes as one object, and a bad readOnly is refused on the page, never turned into false", async () => {
  const view = page(withEdit());
  const root = view.get("settings"), form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  field("id").value = "codex-extra"; field("kind").value = "codex"; field("roles").value = "reviewer"; field("start_mode").value = "headless";
  field("readOnly").value = "TRUE";
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent).toEqual([]);
  expect(form.text()).toContain("readOnly is true or false");
  field("readOnly").value = "true";
  view.replies.push({ ok: true, lines: ["x"], tier: 2 });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[0]).toMatchObject({ edit: { set: [{ path: ["instances", "codex-extra"], value: { kind: "codex", roles: ["reviewer"], start_mode: "headless", readOnly: true } }] } });
});

test("#689 clearing a field of an existing instance is a removal of that leaf with the word clear, never an empty value", async () => {
  const view = page(withEdit());
  const root = view.get("settings"), form = root.all().find(node => node.className === "structure-add")!;
  const field = (name: string) => form.all().find(node => node.id === "structure-" + name)!;
  field("id").value = "codex-review"; field("start_mode").value = "clear";
  view.replies.push({ ok: true, lines: ["x"], tier: 2 });
  await form.all().find(node => node.textContent === "Preview change")!.listeners.click!();
  expect(view.sent[0]).toMatchObject({ edit: { set: [{ path: ["instances", "codex-review", "start_mode"], value: null }] } });
});
