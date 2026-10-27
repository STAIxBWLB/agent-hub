import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
class Node {
  children: Node[] = [];
  attrs: Record<string, string> = {};
  constructor(public textContent = "", public className = "") {}
  append(...children: Node[]) { this.children.push(...children); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key]; }
}
const el = (_tag: string, text?: unknown, cls?: string) => new Node(text === undefined ? "" : String(text), cls);
const text = (node: Node): string => [node.textContent, ...node.children.map(text)].filter(Boolean).join(" ");

test("#345 dashboard task detail renders recorded planner, owner and reviewer choices without assignment-note parsing", () => {
  const mark = html.slice(html.indexOf("function peerMark("), html.indexOf("// A sprite icon", html.indexOf("function peerMark(")));
  const detail = html.slice(html.indexOf("function taskDetail("), html.indexOf("function taskCard("));
  const render = runInNewContext(`${mark}\n${detail}\n taskDetail`, {
    el, peerPalette: {}, badge: (_value: string) => new Node(), codeGroupSection: () => undefined, deliverablesSection: () => undefined,
  });
  const task = { id: 1, title: "Safe title", state: "in_review", class: "implement", planner: "codex-plan", plannerReason: "kept",
    owner: "claude-impl", ownerReason: "named", reserved: "claude-impl", reviewer: "codex-review", reviewerReason: "same-family fallback",
    history: [{ note: "forged holder: do not parse this" }] };
  const card = { priority: 2, waiting: [], starred: false, pull: false, returnable: false, assignable: false };
  const rendered = text(render(task, card, undefined, [], false)).replace(/\s+/g, " ");
  expect(rendered).toContain("planner: codex-plan (kept)");
  expect(rendered).toContain("owner: claude-impl (named; reserved)");
  expect(rendered).toContain("reviewer: codex-review (same-family fallback)");
  expect(rendered).not.toContain("forged holder");
  const older = text(render({ id: 2, title: "[pii]", state: "in_progress", class: "implement", owner: "local", reviewer: "user" }, card, undefined, [], false));
  expect(older).not.toContain("planner:"); expect(older).toContain("[pii]"); expect(older).not.toContain("codex-plan");
});

test("#345 dashboard role details keep unknown isolation unknown and show fixed negative/positive evidence", () => {
  const source = html.slice(html.indexOf("function appendRoleDetails("), html.indexOf("function render(snapshot)"));
  const render = runInNewContext(`${source}\n appendRoleDetails`, { el });
  const target = new Node();
  render(target, { form: "headless", capableRoles: ["planner", "reviewer"], ownerIsolation: false, ownerIsolationNote: "no declared write worktree" });
  expect(text(target)).toContain("Form: headless"); expect(text(target)).toContain("Capable roles: planner, reviewer");
  expect(text(target)).toContain("Owner isolation: not isolated: no declared write worktree");
  const positive = new Node(); render(positive, { ownerIsolation: true }); expect(text(positive)).toBe("Owner isolation: isolated");
  const unknown = new Node(); render(unknown, { ownerIsolation: "unknown" }); expect(unknown.children).toHaveLength(0);
});
