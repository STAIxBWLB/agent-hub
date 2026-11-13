import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// #1054 T6: the dashboard's Results section, executed against a fake DOM (the page's own `renderResults`, cut by its text like the rooms and worktree panel tests).
const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
class Node {
  children: Node[] = []; textContent = ""; className = ""; dataset: Record<string, string> = {}; title = ""; type = ""; disabled = false; onclick: (() => void) | undefined;
  clicks: (() => void)[] = [];
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; this.textContent = ""; }
  addEventListener(_type: string, listener: () => void) { this.clicks.push(listener); }
  set innerHTML(_value: string) { throw new Error("result text must use text nodes"); }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function page() {
  const start = html.indexOf("function renderResults("), end = html.indexOf("/* #1057: the worktree shelf.", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const nodes = new Map<string, Node>(), get = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const posted: Record<string, unknown>[] = [];
  const line = (prefix: string) => html.split("\n").find(row => row.startsWith(prefix))!;
  const context = {
    $: get, document: { createElement: (tag: string) => new Node(tag) },
    empty: (target: Node, text: string) => { const node = new Node("p"); node.textContent = text; target.append(node); },
    // the page's `button` builds a <button> whose click posts the payload; here a recorded stand-in with the same shape, so the section's own payloads are what is checked
    button: (text: string, payload: Record<string, unknown>) => { const node = new Node("button"); node.textContent = text; node.dataset.action = String(payload.action); node.addEventListener("click", () => posted.push(payload)); return node; },
    update: (id: string, _data: unknown, render: (target: Node) => void) => { const target = get(id); target.replaceChildren(); render(target); },
    time: (value: number) => `t${value}`, rel: (value: number) => `r${value}`,
  };
  const api = runInNewContext(`${line("const el = ")}\n${line("const badge = ")}\n${html.slice(start, end)};({renderResults})`, context) as { renderResults(results: unknown): void };
  return { api, get, posted, source: html.slice(start, end) };
}
const row = (extra: Record<string, unknown> = {}) => ({ id: "cmp-0123456789ab", peer: "codex", outcome: "done", settledAt: 1000, startedAt: 0, ms: 4200, private: false, title: "codex: finished", read: false, detail: { kind: "head", text: "summarise the notes" }, ...extra });
const buttons = (f: ReturnType<typeof page>) => f.get("results").all().filter(node => node.tag === "button");

test("an unread result shows its title, outcome, settle time and request head with Mark read, and the section's tools", () => {
  const f = page(); f.api.renderResults({ unread: [row()], moreUnread: 0, canUnread: false });
  const text = f.get("results").text();
  for (const shown of ["codex: finished", "done", "settled r1000", "4s", "summarise the notes", "Mark read", "Mark all read"]) expect(text).toContain(shown);
  expect(f.get("results-count").textContent).toBe("1 unread");
  expect(text).not.toContain("Mark last unread again");                                   // nothing has been read, so there is nothing to relight
  expect(buttons(f).map(node => node.dataset.action)).toEqual(["result_seen", "results_read_all"]);
});

test("the buttons post exactly the person's three receipt actions, naming the one result by its id", () => {
  const f = page(); f.api.renderResults({ unread: [row(), row({ id: "cmp-ffffffffffff" })], moreUnread: 0, canUnread: true });
  for (const node of buttons(f)) for (const click of node.clicks) click();
  expect(f.posted).toEqual([{ action: "result_seen", id: "cmp-0123456789ab" }, { action: "result_seen", id: "cmp-ffffffffffff" }, { action: "results_read_all" }, { action: "results_unread_last" }]);
  expect(f.get("results").text()).toContain("Mark last unread again");
});

test("a private result shows its stub, a result with no detail shows none, and a number past the bound says where the rest is", () => {
  const f = page();
  f.api.renderResults({ unread: [row({ private: true, title: "codex: a private result", detail: { kind: "stub", text: "a private request" } }), row({ id: "cmp-aaaaaaaaaaaa", detail: { kind: "none" } })], moreUnread: 7, canUnread: false });
  const text = f.get("results").text();
  expect(text).toContain("a private request"); expect(text).toContain("codex: a private result");
  expect(text).toContain("7 older unread; run ahub results --unread to list them all.");
  expect(f.get("results-count").textContent).toBe("9 unread");
  expect(f.get("results").all().filter(node => node.tag === "p" && node.className === "meta").map(node => node.textContent)).toEqual(["a private request", "7 older unread; run ahub results --unread to list them all."]);
});

test("nothing unread, and an older hub or a live-test session that sends no results, are said plainly and carry no button that writes", () => {
  const f = page();
  f.api.renderResults({ unread: [], moreUnread: 0, canUnread: true });
  expect(f.get("results").text()).toContain("Nothing unread.");
  expect(buttons(f).map(node => node.dataset.action)).toEqual(["results_unread_last"]);   // only the relight, since there is nothing to mark
  f.api.renderResults(undefined);
  expect(f.get("results").text()).toContain("Results are shown to the person on a current snapshot.");
  expect(buttons(f)).toEqual([]); expect(f.get("results-count").textContent).toBe("");
});

test("result text is set as text only: a markup-looking request is shown as characters and never parsed", () => {
  const f = page();
  f.api.renderResults({ unread: [row({ detail: { kind: "head", text: "<img src=x onerror=alert(1)> <script>bad()</script>" }, title: "codex: <b>finished</b>" })], moreUnread: 0, canUnread: false });
  expect(f.get("results").text()).toContain("<img src=x onerror=alert(1)>");
  expect(f.source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  expect(f.get("results").all().every(node => node.tag !== "img" && node.tag !== "script")).toBe(true);
});

test("the page wires the section: it is in the Agents view, rendered from the snapshot, and the worktree and rooms panel slices still cut cleanly", () => {
  expect(html).toContain('id="results-section" aria-labelledby="results-title" data-view="agents"');
  expect(html).toContain("renderResults(snapshot.results);");
  // `renderResults` sits BEFORE the worktree shelf's comment, so the slice the worktree panel test cuts (renderWorktrees .. renderBench) is exactly what it was
  const worktrees = html.slice(html.indexOf("function renderWorktrees(shelf)"), html.indexOf("function renderBench(bench)"));
  expect(worktrees).not.toContain("renderResults"); expect(worktrees).not.toContain("results_read_all");
  expect(html.indexOf("function renderResults(")).toBeLessThan(html.indexOf("function renderWorktrees(shelf)"));
  // the mutation buttons are the page's own `button(...)` (project-scoped, disabled without a current snapshot in manager mode), never a raw fetch
  expect(html.slice(html.indexOf("function renderResults("), html.indexOf("/* #1057: the worktree shelf."))).not.toMatch(/fetch\(|post\(/);
});
