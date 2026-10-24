import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// #317: the dashboard's Deliverables group in the task sheet and the card chip's label. The hub classifies (ids, hashes, sizes, a path only where the PII screen allows,
// a measurement only for records it measured); the page draws what it is given and never claims a change it was not told about.
class Node {
  children: Node[] = []; textContent = ""; className = ""; attrs: Record<string, string> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function page() {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function deliverableLabel("), end = html.indexOf("function taskDetail(");
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const api = runInNewContext(`${html.slice(start, end)};({ deliverableLabel, deliverablesSection })`, {
    el: (tag: string, text?: string, cls?: string) => { const n = new Node(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; },
  }) as { deliverableLabel(d: unknown): string; deliverablesSection(task: unknown): Node | null };
  return { api, html };
}
const sha = "a".repeat(64);
const file = (over: Record<string, unknown> = {}) => ({ id: "d-123456789abc", path: "out/report.md", format: "md", version: "v1", sha256: sha, bytes: 12, ...over });

test("a task with no deliverables has no group, and the label of nothing is empty", () => {
  const { api } = page();
  expect(api.deliverablesSection({ id: 1 })).toBeNull();
  expect(api.deliverablesSection({ id: 1, deliverables: { state: "delivered", files: [] } })).toBeNull();
  expect(api.deliverableLabel(undefined)).toBe("");
});

test("the group lists each file with its path, format, version, size and a hash prefix, and says it was not measured when the hub measured nothing", () => {
  const { api } = page();
  const section = api.deliverablesSection({ id: 1, deliverables: { state: "approved", files: [file(), file({ id: "d-bbbbbbbbbbbb", path: "out/b.md", version: undefined, bytes: 3 })] } })!;
  const text = section.text();
  expect(text).toContain("Deliverables"); expect(text).toContain("2 files approved");
  expect(text).toContain("out/report.md [md v1] 12 B, sha256 " + "a".repeat(12));
  expect(text).toContain("out/b.md [md] 3 B");
  expect(text).toContain("not measured now: run ahub deliverables --check");
  expect(text).not.toContain("changed since review");                    // no measurement was reported, so none is claimed
  expect(text).not.toContain("a".repeat(13));                             // only a prefix of the hash is drawn
});

test("a measurement the hub reported is shown, as changed (warn) or unchanged, and a private file is drawn without a path", () => {
  const { api } = page();
  const changed = api.deliverablesSection({ id: 1, deliverables: { state: "approved", files: [file({ path: undefined, private: true })], checked: { at: 1, result: "changed" } } })!;
  expect(changed.text()).toContain("1 file approved, changed since review");
  expect(changed.text()).toContain("private file [md v1]"); expect(changed.text()).not.toContain("out/report.md");
  expect(changed.text()).not.toContain("not measured now");
  expect(changed.children.find(node => node.textContent.includes("changed since review"))!.className).toContain("warn");
  const same = api.deliverablesSection({ id: 1, deliverables: { state: "delivered", files: [file()], checked: { at: 1, result: "unchanged" } } })!;
  expect(same.text()).toContain("1 file delivered, unchanged when last checked");
  expect(same.children.find(node => node.textContent.includes("unchanged when last checked"))!.className).not.toContain("warn");
});

test("the label says nothing about change without a measurement, and never says unchanged for an unmeasured record", () => {
  const { api } = page();
  const base = { state: "delivered", files: [file()] };
  expect(api.deliverableLabel(base)).toBe("1 file delivered");
  expect(api.deliverableLabel({ ...base, state: "approved", files: [file(), file()] })).toBe("2 files approved");
  expect(api.deliverableLabel({ ...base, checked: { at: 1, result: "unchanged" } })).toBe("1 file delivered, unchanged when last checked");
  expect(api.deliverableLabel({ ...base, checked: { at: 1, result: "changed" } })).toBe("1 file delivered, changed since review");
  for (const unmeasured of [base, { ...base, checked: undefined }, { ...base, checked: null }]) expect(api.deliverableLabel(unmeasured)).not.toMatch(/unchanged|changed since/);
});

test("a measurement with a missing or unreadable file is never labelled unchanged, and is drawn as a warning", () => {
  const { api } = page();
  const base = { state: "approved", files: [file()] };
  expect(api.deliverableLabel({ ...base, checked: { at: 1, result: "missing" } })).toBe("1 file approved, a file is missing");
  expect(api.deliverableLabel({ ...base, checked: { at: 1, result: "unknown" } })).toBe("1 file approved, could not be measured");
  expect(api.deliverableLabel({ ...base, checked: { at: 1, result: "something new" } })).toBe("1 file approved, could not be measured");   // an unrecognised reading is not read as unchanged
  expect(api.deliverableLabel({ ...base, checked: { at: 1 } })).toBe("1 file approved, could not be measured");
  for (const result of ["missing", "unknown"]) {
    const section = api.deliverablesSection({ id: 1, deliverables: { ...base, checked: { at: 1, result } } })!;
    expect(section.text()).not.toContain("unchanged"); expect(section.text()).not.toContain("not measured now");
    expect(section.children.find(node => /missing|measured/.test(node.textContent))!.className).toContain("warn");
  }
});

test("the card shows a Deliverables chip with the label as its title and in its aria-label, built from the snapshot field only", () => {
  const { html } = page();
  const card = html.slice(html.indexOf("function taskCard("), html.indexOf("function setColumnFocus("));
  expect(card).toContain("task.deliverables?.files?.length");
  expect(card).toContain("deliverable-chip");
  expect(card).toContain("chip.title = deliverableLabel(task.deliverables)");
  expect(card).toContain("deliverableLabel(task.deliverables))");
  expect(html).toContain("const delivered = deliverablesSection(task); if (delivered) row.append(delivered);");
  expect(card).not.toMatch(/fetch\(|post\(|innerHTML/);                   // the page invents nothing and opens nothing
});
