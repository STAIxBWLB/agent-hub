import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { INTAKE_MAX_SOURCES, INTAKE_MAX_TEXT } from "../src/hub/intake.ts";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const start = html.indexOf("function renderSources("), end = html.indexOf("const attentionBaseTitle =", start);
const code = html.slice(start, end);
const updateCode = html.slice(html.indexOf("function update("), html.indexOf("function empty("));
class Node {
  value = ""; textContent = ""; focused = false; children: Node[] = []; attrs: Record<string, string> = {};
  classList = { toggle: (_key: string, _value: boolean) => {} };
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  focus() { this.focused = true; }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
}
function rig() {
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const calls: unknown[] = [], pendingButtons = new WeakSet<Node>();
  let current = { projectId: "one", instanceId: "instance", generation: 1 }, reply: (payload: unknown) => Promise<boolean> = async () => true;
  const api = runInNewContext(`${updateCode} ${code}; ({renderSources, submitIntake});`, {
    $: get, el: (tag: string, text?: string) => { const node = new Node(tag); node.textContent = text === undefined ? "" : String(text); return node; },
    signatures: new Map(), document: { activeElement: null },
    empty: (target: Node, text: string) => { const node = new Node("p"); node.textContent = text; target.append(node); },
    context: () => ({ ...current }), stopped: false, pendingButtons,
    action: async (payload: unknown, button: Node) => { calls.push(payload); pendingButtons.add(button); try { return await reply(payload); } finally { pendingButtons.delete(button); } },
  });
  return { get, calls, api, submit: () => api.submitIntake({ preventDefault() {}, submitter: get("intake-submit") }),
    reply: (next: typeof reply) => { reply = next; }, switchProject: () => { current = { ...current, projectId: "two", generation: 2 }; } };
}
const source = "src:0123456789abcdef", other = "src:fedcba9876543210";

test("source list renders metadata as text and distinguishes unavailable from empty (#1144)", () => {
  const f = rig();
  f.api.renderSources(undefined); expect(f.get("sources").text()).toContain("unavailable");
  f.api.renderSources([]); expect(f.get("sources").text()).toContain("No registered sources");
  f.api.renderSources([{ id: source, kind: '<img src=x onerror="throw 1">', bytes: 17, hashPrefix: "0123456789ab", added_at: 123,
    origin: "/private/path", content: "secret content", sha256: "full hash must not be rendered" }]);
  const text = f.get("sources").text();
  for (const value of [source, "17 bytes", "0123456789ab", "registered", "<img"]) expect(text).toContain(value);
  for (const value of ["/private/path", "secret content", "full hash"]) expect(text).not.toContain(value);
  const visit = (node: Node): Node[] => [node, ...node.children.flatMap(visit)];
  expect(visit(f.get("sources")).some(node => node.tag === "img")).toBe(false);
});

test("intake creates a held draft with selected source ids and clears only confirmed input (#1144)", async () => {
  const f = rig(); f.get("intake-text").value = "  Prepare a report  "; f.get("intake-sources").value = `${source}, ${other}`;
  let done!: (value: boolean) => void; f.reply(() => new Promise(resolve => { done = resolve; }));
  const pending = f.submit();
  expect(f.calls).toEqual([{ action: "intake", text: "Prepare a report", sources: [source, other] }]);
  expect(f.get("intake-result").textContent).toContain("Waiting");
  expect(f.get("intake-text").value).toContain("Prepare a report");
  await f.submit(); expect(f.calls).toHaveLength(1);
  done(true); await pending;
  expect(f.get("intake-text").value).toBe(""); expect(f.get("intake-sources").value).toBe("");
  expect(f.get("intake-result").textContent).toContain("Draft saved to Backlog");
});

test("intake invalid input is explained at the field and causes no action (#1144)", async () => {
  for (const [text, sources, invalid] of [[" ", "", "intake-text"], ["x".repeat(INTAKE_MAX_TEXT + 1), "", "intake-text"],
    ["valid", "doi:example", "intake-sources"], ["valid", `${source} ${source}`, "intake-sources"],
    ["valid", Array.from({ length: INTAKE_MAX_SOURCES + 1 }, (_, n) => `src:${n.toString(16).padStart(16, "0")}`).join(" "), "intake-sources"]]) {
    const f = rig(); f.get("intake-text").value = text!; f.get("intake-sources").value = sources!; await f.submit();
    expect(f.calls).toEqual([]); expect(f.get(invalid!).focused).toBe(true); expect(f.get(invalid!).attrs["aria-invalid"]).toBe("true");
    expect(f.get("intake-result").textContent.length).toBeGreaterThan(0);
  }
  expect(html).toContain(`id="intake-text" required maxlength="${INTAKE_MAX_TEXT}"`);
  expect(html).toContain('for="intake-sources"'); expect(html).toContain('id="intake-result" class="meta" role="status" aria-live="polite"');
});

test("refusal, uncertain completion, edits and project switches preserve unsaved intake text (#1144)", async () => {
  const refused = rig(); refused.get("intake-text").value = "Keep me"; refused.reply(async () => false); await refused.submit();
  expect(refused.get("intake-text").value).toBe("Keep me"); expect(refused.get("intake-result").textContent).toContain("check Backlog");
  for (const changeProject of [false, true]) {
    const f = rig(); f.get("intake-text").value = "First project";
    let done!: (value: boolean) => void; f.reply(() => new Promise(resolve => { done = resolve; })); const pending = f.submit();
    if (changeProject) f.switchProject();
    f.get("intake-text").value = "New unsaved request"; f.get("intake-result").textContent = "New context";
    done(true); await pending; expect(f.get("intake-text").value).toBe("New unsaved request");
    if (changeProject) expect(f.get("intake-result").textContent).toBe("New context");
  }
});
