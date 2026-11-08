import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  children: Node[] = []; private content = "";
  get textContent() { return this.content; }
  set textContent(value: string) { this.content = value; this.children = []; }
  value = ""; disabled = false; hidden = false; isConnected = true; type = ""; maxLength = 0; autocomplete = ""; spellcheck = false;
  listeners: Record<string, (() => unknown)[]> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(_key: string, _value: string) {}
  addEventListener(key: string, callback: () => unknown) { (this.listeners[key] ??= []).push(callback); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  async emit(event: string) { for (const callback of this.listeners[event] ?? []) await callback(); }
  async click() { await this.emit("click"); }
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
    post: async (_url: string, payload: any) => { requests.push(payload); return options.post ? options.post(payload) : { ok: true, confirmation: { token: "fixture-token", expiresAt: Date.now() + 60_000, peer: "codex", action: payload.modelAction, previousModel: "old", nextModel: payload.modelAction === "clear" ? null : payload.model, appliesFrom: "next_turn" }, appliesFrom: "next_turn" }; },
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
  expect(clear.box.text()).toContain("old -> native default"); expect(clear.button("Confirm next-turn model")).toBeDefined();
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
    expect(f.banner.hidden).toBe(false); expect(f.banner.text()).toContain("could not read a bounded model catalog");
    expect(f.banner.text()).toContain("run ahub model list for the cause");
    expect(f.banner.text()).toContain("ahub model set <peer> <model>"); expect(f.banner.text()).toContain("ahub model clear <peer>");
    expect(f.box.text()).toContain("Runtime models unavailable"); expect(f.box.all().some(node => node.tag === "button" || node.tag === "input")).toBe(false);
    expect(f.requests).toHaveLength(0);
  }
  const healthy = page(); expect(healthy.banner.hidden).toBe(true); expect(healthy.banner.text()).toBe("");
});

test("editing a previewed draft fences even a detached old confirmation token", async () => {
  for (const emitInput of [false, true]) {
    const f = page(); f.input().value = "first"; await f.button("Preview model").click();
    const old = f.button("Confirm next-turn model"); f.input().value = "second";
    if (emitInput) await f.input().emit("input");
    await old.click(); expect(f.requests).toHaveLength(1);
    await f.button("Preview model").click(); expect(f.requests[1]).toEqual({ action: "model_preview", modelAction: "set", peer: "codex", model: "second" });
    await old.click(); expect(f.requests).toHaveLength(2);
  }
});

test("late confirmation success or error cannot overwrite a newer draft preview", async () => {
  for (const failed of [false, true]) {
    let release!: () => void;
    const f = page({ post: async payload => {
      if (payload.action === "model_preview") return { ok: true, confirmation: { token: "token-" + payload.model, expiresAt: Date.now() + 60_000, peer: "codex", action: "set", previousModel: "old", nextModel: payload.model, appliesFrom: "next_turn" } };
      if (payload.token === "token-first") return new Promise((resolve, reject) => { release = () => failed ? reject(new Error("late first failure")) : resolve({ ok: true, appliesFrom: "next_turn" }); });
      return { ok: true, appliesFrom: "next_turn" };
    } });
    f.input().value = "first"; await f.button("Preview model").click();
    const oldConfirm = f.button("Confirm next-turn model"), pending = oldConfirm.click();
    f.input().value = "second"; await f.input().emit("input"); await f.button("Preview model").click();
    const secondConfirm = f.button("Confirm next-turn model"), before = f.box.text();
    release(); await pending;
    expect(f.box.text()).toBe(before); expect(f.box.text()).toContain("old -> second");
    expect(f.box.text()).not.toContain("Selection saved"); expect(f.box.text()).not.toContain("late first failure");
    expect(f.button("Confirm next-turn model")).toBe(secondConfirm);
    await oldConfirm.click(); expect(f.requests.filter(item => item.action === "model_confirm")).toHaveLength(1);
    await secondConfirm.click(); expect(f.requests.at(-1)).toEqual({ action: "model_confirm", token: "token-second" });
    expect(f.box.text()).toContain("saved for the next turn");
  }
});

test("stale preview finally cannot unlock a newer pending preview", async () => {
  const releases = new Map<string, (value: unknown) => void>();
  const f = page({ post: payload => new Promise(resolve => { releases.set(payload.model, resolve); }) });
  f.input().value = "first"; const first = f.button("Preview model").click();
  f.input().value = "second"; await f.input().emit("input"); const second = f.button("Preview model").click();
  releases.get("first")!({ ok: true, confirmation: {} }); await first;
  expect(f.button("Preview model").disabled).toBe(true); expect(f.button("Preview clear").disabled).toBe(true);
  releases.get("second")!({ ok: true, confirmation: { token: "second", expiresAt: Date.now() + 60_000, peer: "codex", action: "set", previousModel: "old", nextModel: "second", appliesFrom: "next_turn" } }); await second;
  expect(f.button("Preview model").disabled).toBe(false); expect(f.box.text()).toContain("old -> second");
});

test("preview must acknowledge success and exactly bind the requested bounded model or clear", async () => {
  for (const change of [{ ok: false }, { nextModel: "different" }, { previousModel: "bad model" }, { nextModel: { token: "unsafe" } }, { nextModel: "a".repeat(129) }]) {
    const f = page({ post: async () => ({ ok: "ok" in change ? change.ok : true, confirmation: { token: "token", expiresAt: Date.now() + 60_000, peer: "codex", action: "set", previousModel: "old", nextModel: "new", appliesFrom: "next_turn", ...change } }) });
    f.input().value = "new"; await f.button("Preview model").click();
    expect(f.box.text()).toContain("Model preview unavailable"); expect(f.box.all().some(node => node.textContent === "Confirm next-turn model")).toBe(false);
  }
  const clear = page({ post: async () => ({ ok: true, confirmation: { token: "token", expiresAt: Date.now() + 60_000, peer: "codex", action: "clear", previousModel: "old", nextModel: "new", appliesFrom: "next_turn" } }) });
  await clear.button("Preview clear").click(); expect(clear.box.text()).toContain("Model preview unavailable");
  expect(clear.box.all().some(node => node.textContent === "Confirm next-turn model")).toBe(false);
});

test("preview server refusals preserve their specific cause and repair as error text", async () => {
  for (const error of [
    "unsupported live: qwen (version unverified) has no verified model setter; restart this peer with ahub restart qwen",
    "model changes are person-only and this authority expired; run ahub model in a person's terminal or reopen ahub ui --settings",
  ]) {
    const f = page({ post: async () => ({ ok: false, error }) }); f.input().value = "new"; await f.button("Preview model").click();
    expect(f.box.text()).toContain("Error: " + error); expect(f.box.text()).not.toContain("Model preview unavailable");
    expect(f.box.all().some(node => node.textContent === "Confirm next-turn model")).toBe(false); expect(f.requests).toHaveLength(1);
  }
  const expired = "model authority expired before the write; reopen the person settings session and preview again";
  const rejected = page({ post: async () => { throw new Error(expired); } }); rejected.input().value = "new"; await rejected.button("Preview model").click();
  expect(rejected.box.text()).toContain("Error: " + expired);
});

test("saved audit failure is reported without claiming successful application or offering the old token again", async () => {
  const error = "model override was saved but its model_change audit could not be appended; run ahub model list before retrying and repair events.jsonl";
  const f = page({ post: async payload => payload.action === "model_preview" ? { ok: true, confirmation: { token: "token", expiresAt: Date.now() + 60_000, peer: "codex", action: "set", previousModel: "old", nextModel: "new", appliesFrom: "next_turn" } } : { ok: false, saved: true, error } });
  f.input().value = "new"; await f.button("Preview model").click(); const old = f.button("Confirm next-turn model"); await old.click();
  expect(f.box.text()).toContain("Error: " + error); expect(f.box.text()).not.toContain("Selection saved for the next turn");
  expect(f.box.all().some(node => node.textContent === "Confirm next-turn model")).toBe(false);
  await old.click(); expect(f.requests.filter(item => item.action === "model_confirm")).toHaveLength(1);
});

test("unknown or unsafe error replies keep fixed fallbacks and plain text cannot create markup", async () => {
  for (const result of [null, [], { ok: false, error: "a".repeat(2049) }, { ok: false, error: "bad\ncontrol" }, { ok: false, error: { message: "arbitrary" } }]) {
    const f = page({ post: async () => result }); f.input().value = "new"; await f.button("Preview model").click();
    expect(f.box.text()).toContain("Error: Model preview unavailable; reopen ahub ui --settings and retry."); expect(f.box.text()).not.toContain("arbitrary");
  }
  const text = "unsupported <script>fixture</script>; reopen ahub ui --settings";
  const f = page({ post: async () => ({ ok: false, error: text }) }); f.input().value = "new"; await f.button("Preview model").click();
  expect(f.box.text()).toContain("Error: " + text); expect(f.box.all().some(node => node.tag === "script")).toBe(false);
});
