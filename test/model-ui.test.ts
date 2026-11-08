import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  children: Node[] = []; textContent = ""; value = ""; disabled = false; hidden = false; isConnected = true; type = ""; maxLength = 0; autocomplete = ""; spellcheck = false;
  listeners: Record<string, (() => unknown)[]> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(_key: string, _value: string) {}
  addEventListener(key: string, callback: () => unknown) { (this.listeners[key] ??= []).push(callback); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  async click() { for (const callback of this.listeners.click ?? []) await callback(); }
}
function page(options: { manager?: boolean; session?: boolean; unavailable?: boolean; statusUnavailable?: boolean; post?: (payload: any) => Promise<any> } = {}) {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function modelUnavailableText("), end = html.indexOf("function render(snapshot)", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const banner = new Node("p");
  const requests: any[] = [], state = { stopped: false, managerMode: options.manager ?? false, selectedProjectId: "project", selectedInstanceId: "instance", viewGeneration: 1,
    $: () => banner, snapshot: { runtimeModels: [], runtimeModelsUnavailable: options.unavailable === true, status: { runtimeModelsUnavailable: options.statusUnavailable === true } },
    context: () => ({ projectId: "project", instanceId: "instance", generation: 1 }), canMutate: () => true,
    el: (tag: string, text = "") => { const node = new Node(tag); node.textContent = text; return node; },
    post: async (_url: string, payload: any) => { requests.push(payload); return options.post ? options.post(payload) : { ok: true, confirmation: { token: "fixture-token", expiresAt: Date.now() + 60_000, peer: "codex", action: payload.modelAction, previousModel: "old", nextModel: "new", appliesFrom: "next_turn" }, appliesFrom: "next_turn" }; },
    model: { peer: "codex", effectiveModel: "old", source: "override", desiredModel: "new", pendingNextTurn: true }, until: options.session === false ? 0 : Date.now() + 60_000,
  };
  const box = runInNewContext(`${html.slice(start, end)}; modelControls(model,until,renderModelAvailability(snapshot))`, state) as Node;
  return { box, banner, state, requests, button: (label: string) => { const found = box.all().find(node => node.tag === "button" && node.textContent === label); if (!found) throw new Error("fixture button missing"); return found; }, input: () => box.all().find(node => node.tag === "input")! };
}
test("ordinary and manager dashboards show model state but acquire no settings authority", () => {
  for (const options of [{ session: false }, { manager: true }]) { const f = page(options); expect(f.box.text()).toContain("pending next turn"); expect(f.box.text()).toContain("ahub ui --settings"); expect(f.box.all().filter(node => node.tag === "button")).toHaveLength(0); expect(f.requests).toHaveLength(0); }
});
test("settings model action previews then sends only the server token; clear has no model operand", async () => {
  const f = page(); f.input().value = "new";
  await f.button("Preview model").click();
  expect(f.requests).toEqual([{ action: "model_preview", modelAction: "set", peer: "codex", model: "new" }]);
  expect(f.box.text()).toContain("The active turn is unchanged");
  await f.button("Confirm next-turn model").click();
  expect(f.requests[1]).toEqual({ action: "model_confirm", token: "fixture-token" });
  expect(f.box.text()).toContain("saved for the next turn");
  const clear = page(); await clear.button("Preview clear").click(); expect(clear.requests[0]).toEqual({ action: "model_preview", modelAction: "clear", peer: "codex" });
});
test("invalid tokens and stale preview callbacks create no confirmation or mutation", async () => {
  const invalid = page(); invalid.input().value = "--model bad"; await invalid.button("Preview model").click(); expect(invalid.requests).toHaveLength(0);
  let release!: (value: unknown) => void;
  const f = page({ post: () => new Promise(resolve => { release = resolve; }) }); f.input().value = "new";
  const pending = f.button("Preview model").click(); f.state.viewGeneration++;
  release({ ok: true, confirmation: { token: "fixture-token", expiresAt: Date.now() + 60_000, peer: "codex", action: "set", appliesFrom: "next_turn" } }); await pending;
  expect(f.box.all().some(node => node.textContent === "Confirm next-turn model")).toBe(false); expect(f.requests).toHaveLength(1);
});
test("stale confirmation and unconfirmed replies never claim an applied model", async () => {
  const stale = page(); stale.input().value = "new"; await stale.button("Preview model").click(); stale.state.stopped = true;
  await stale.button("Confirm next-turn model").click(); expect(stale.requests).toHaveLength(1);
  const f = page({ post: async payload => payload.action === "model_preview" ? { ok: true, confirmation: { token: "token", expiresAt: Date.now() + 60_000, peer: "codex", action: "set", previousModel: "old", nextModel: "new", appliesFrom: "next_turn" } } : { ok: true, unconfirmed: true } });
  f.input().value = "new"; await f.button("Preview model").click(); await f.button("Confirm next-turn model").click();
  expect(f.box.text()).toContain("unconfirmed"); expect(f.box.text()).not.toContain("Selection saved");
});

test("model catalog overflow shows a fixed banner and no model controls even in a settings session", () => {
  for (const options of [{ unavailable: true }, { statusUnavailable: true }]) {
    const f = page(options);
    expect(f.banner.hidden).toBe(false); expect(f.banner.text()).toContain("peer catalog exceeds the bounded display limit");
    expect(f.banner.text()).toContain("ahub model set <peer> <model>"); expect(f.banner.text()).toContain("ahub model clear <peer>");
    expect(f.box.text()).toContain("Runtime models unavailable"); expect(f.box.all().some(node => node.tag === "button" || node.tag === "input")).toBe(false);
    expect(f.requests).toHaveLength(0);
  }
  const healthy = page(); expect(healthy.banner.hidden).toBe(true); expect(healthy.banner.text()).toBe("");
});
