import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import plugin, { createProvider } from "../src/ui/plugin.ts";
import { guidancePanelAssets } from "../src/ui/guidance-panel.ts";
import { guidanceLines } from "../src/ui/guidance-view.ts";
import { personEvidence } from "../src/ui/plugin-questions.ts";
import { receiptEvidence } from "../src/ui/plugin-results.ts";
import { DASHBOARD_VIEWS } from "../src/hub/ui.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import type { GuidanceDiffResult, GuidancePageResult, GuidancePublicRecord } from "../src/hub/guidance-variants.ts";

// Only scripted loopback control and a fake console DOM: no model, native session, accounts or actual handoff.
const id = "a".repeat(64), secondId = "b".repeat(64);
const current = { taskId: 7, taskCreated: 100, flowRevision: 9 };
const record: GuidancePublicRecord = {
  ...current, id, experimentId: "withheld", flowRevision: 4, roleId: "implementer", layer: "shipped", author: "user",
  baselineSha256: "c".repeat(64), candidateSha256: "d".repeat(64), changedSections: ["Scope"],
  bytes: { baseline: 1000, candidate: 1100, record: 3000 }, status: "declared", applicable: false,
  rationale: { problemHypothesis: "withheld", expectedObservableDifference: "A smaller task scope may reduce retries." },
  evidence: [{ key: "e".repeat(64), status: "unavailable" }],
};
const page: GuidancePageResult = { state: "available", current, records: [record], truncated: false };
const diff: GuidanceDiffResult = { state: "available", current, record,
  sections: ["Scope", "Deliverables", "Evidence"].map(section => ({ section, before: "withheld", after: "A bounded public sentence." })) as Extract<GuidanceDiffResult, { state: "available" }>["sections"],
  protectedSections: ["Not in scope", "Hub use", "Review duties"] };
const query = { after: 0, panel: "guidance", op: "list", projectId: "p1", instanceId: "i1", taskId: 7, taskCreated: 100 };
const marker = "PRIVATE-GUIDANCE-CONSOLE-MARKER";
const dirs: string[] = [], servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function providerFixture(options: { features?: string[]; welcomeRoot?: string; welcomeInstance?: string; stall?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-guidance-console-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/guidance-fixture-project", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (value: string) => value === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const requests: Record<string, unknown>[] = [], hellos: Record<string, unknown>[] = [], effects: Record<string, unknown>[] = [];
  let features = options.features ?? ["guidance_views"];
  let reply: Record<string, unknown> = { ok: true, guidance: page };
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("no", { status: 400 }); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") {
        hellos.push(message);
        socket.send(JSON.stringify({ rid: message.rid, t: "welcome", cwd: options.welcomeRoot ?? project.root, projectId: project.id,
          instanceId: options.welcomeInstance ?? "i1", features }));
        return;
      }
      if (message.t === "guidance_list" || message.t === "guidance_show") {
        requests.push(message);
        if (!options.stall) socket.send(JSON.stringify({ rid: message.rid, ...reply }));
        return;
      }
      if (message.t === "ui_action" || message.t === "guidance_create" || message.t === "guidance_withdraw") effects.push(message);
      socket.send(JSON.stringify({ rid: message.rid, ok: false, error: "unexpected fixture operation" }));
    } },
  });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  const descriptor = { pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1", features };
  const writeStatus = (next: Record<string, unknown>) => writeFileSync(join(project.stateDir, "status.json"), JSON.stringify(next));
  writeStatus(descriptor); writeFileSync(join(project.stateDir, "control-token"), "guidance-scripted-token");
  return { provider: createProvider({ home, registry, lifecycle, forwardTimeoutMs: (_operation, nominal) => options.stall ? 40 : nominal }),
    requests, hellos, effects, setReply: (next: Record<string, unknown>) => { reply = next; },
    setFeatures: (next: string[]) => { features = next; writeStatus({ ...descriptor, features: next }); } };
}

describe("read-only Guidance console provider", () => {
  test("list and variant-id show return the same public projection and shared lines over a pinned console port", async () => {
    const f = providerFixture();
    const listing = await f.provider.snapshot(query);
    expect(listing.ok).toBe(true); expect(listing.guidance).toEqual(page); expect(listing.lines).toEqual(guidanceLines(page));
    expect(f.hellos[0]).toMatchObject({ role: "console", projectId: "p1", instanceId: "i1" });
    const { rid: listRid, ...sentList } = f.requests[0]!;
    expect(typeof listRid).toBe("number"); expect(sentList).toEqual({ t: "guidance_list", taskId: 7, taskCreated: 100 });
    f.setReply({ ok: true, guidance: diff });
    const shown = await f.provider.snapshot({ ...query, op: "show", id });
    expect(shown.ok).toBe(true); expect(shown.guidance).toEqual(diff); expect(shown.lines).toEqual(guidanceLines(diff));
    const { rid: showRid, ...sentShow } = f.requests[1]!;
    expect(typeof showRid).toBe("number"); expect(sentShow).toEqual({ t: "guidance_show", taskId: 7, taskCreated: 100, id });
    expect(JSON.stringify(sentShow)).not.toContain("withheld"); expect(sentShow).not.toHaveProperty("experimentId");
    expect(f.effects).toEqual([]);
  });

  test("finite pages preserve their opaque cursor, and unavailable is never an empty successful page", async () => {
    const f = providerFixture();
    const partial: GuidancePageResult = { state: "available", current, records: [record], truncated: true, cursor: "fixture_cursor" };
    f.setReply({ ok: true, guidance: partial });
    const result = await f.provider.snapshot({ ...query, cursor: "fixture_cursor" });
    expect(result.guidance).toEqual(partial); expect(result.lines).toEqual(guidanceLines(partial));
    expect(f.requests[0]).toMatchObject({ t: "guidance_list", cursor: "fixture_cursor" });
    f.setReply({ ok: true, guidance: { state: "unavailable" } });
    const hidden = await f.provider.snapshot(query);
    expect(hidden.guidance).toEqual({ state: "unavailable" }); expect(hidden.lines).toEqual(guidanceLines({ state: "unavailable" }));
    expect(JSON.stringify(hidden.lines)).not.toContain("Page complete"); expect(f.effects).toEqual([]);
  });

  test("the new panel preserves the dashboard panels and advertises no guidance mutation", () => {
    expect(plugin.manifest.panels.map(panel => panel.id)).toEqual([...DASHBOARD_VIEWS, "guidance"]);
    expect((plugin.manifest.capabilities?.actions ?? []).filter(action => action.startsWith("guidance"))).toEqual([]);
  });

  test("structurally valid replies for a different task, epoch or variant never satisfy this selection", async () => {
    const f = providerFixture();
    for (const wrong of [{ ...current, taskId: current.taskId + 1 }, { ...current, taskCreated: current.taskCreated + 1 }]) {
      const guidance: GuidancePageResult = { state: "available", current: wrong, records: [{ ...record, ...wrong }], truncated: false };
      f.setReply({ ok: true, guidance });
      const result = await f.provider.snapshot(query);
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty("guidance"); expect(result).not.toHaveProperty("lines");
    }
    const wrongVariant: GuidanceDiffResult = { ...(diff as Extract<GuidanceDiffResult, { state: "available" }>), record: { ...record, id: secondId } };
    f.setReply({ ok: true, guidance: wrongVariant });
    const result = await f.provider.snapshot({ ...query, op: "show", id });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty("guidance"); expect(result).not.toHaveProperty("lines");
    expect(f.requests).toHaveLength(3); expect(f.effects).toEqual([]);
  });

  test("read-only guidance grants no exception to the existing question and receipt identity guards", () => {
    const meta = { via: "console", identity: "fixture person", node: "fixture node" } as Parameters<typeof personEvidence>[1];
    const features = ["action.meta"];
    expect(personEvidence(features, meta, {}).ok).toBe(true); expect(receiptEvidence(features, meta, {}).ok).toBe(true);
    for (const key of ["author", "meta", "personMeta", "person", "identity", "surface"]) {
      expect(personEvidence(features, meta, { [key]: "forged" }).ok).toBe(false);
      expect(receiptEvidence(features, meta, { [key]: "forged" }).ok).toBe(false);
    }
    for (const key of ["questionSet", "projectId", "instanceId"]) expect(personEvidence(features, meta, { [key]: "forged" }).ok).toBe(false);
    for (const key of ["completion", "completionId", "seen"]) expect(receiptEvidence(features, meta, { [key]: "forged" }).ok).toBe(false);
    expect(personEvidence([], meta, {}).ok).toBe(false); expect(receiptEvidence([], meta, {}).ok).toBe(false);
  });

  test("forged write operations, page identities and unknown scope fields never reach a control operation", async () => {
    const f = providerFixture();
    for (const fields of [{ op: "create", variant: { author: "user" } }, { op: "withdraw", id, flowRevision: 9 },
      { actor: "user" }, { person: "user" }, { personMeta: { person: "user", authority: "terminal" } },
      { experimentId: "withheld" }, { flowRevision: 9 }, { snapshotToken: "forged" }, { privateBody: marker }]) {
      expect((await f.provider.snapshot({ ...query, ...fields })).ok).toBe(false);
    }
    for (const action of ["guidance_create", "guidance_withdraw"]) {
      expect((await f.provider.action({ action, projectId: "p1", instanceId: "i1", id, person: "user", confirmed: true, fingerprint: "forged" })).ok).toBe(false);
    }
    expect(f.requests).toEqual([]); expect(f.effects).toEqual([]);
  });

  test("unknown project, missing instance, changed descriptor feature and mismatching source identity refuse", async () => {
    const f = providerFixture();
    for (const target of [{ projectId: "missing" }, { instanceId: "" }, { instanceId: "replacement" }]) {
      expect((await f.provider.snapshot({ ...query, ...target })).ok).toBe(false);
    }
    expect(f.requests).toEqual([]);
    f.setFeatures([]);
    const unsupported = await f.provider.snapshot(query);
    expect(unsupported.ok).toBe(false); expect(String(unsupported.error)).toMatch(/upgrade|restart|guidance_views/i);
    expect(f.requests).toEqual([]);
    for (const options of [{ welcomeRoot: "/tmp/different-guidance-root" }, { welcomeInstance: "replacement" }]) {
      const wrong = providerFixture(options);
      expect((await wrong.provider.snapshot(query)).ok).toBe(false);
      expect(wrong.requests).toEqual([]); expect(wrong.effects).toEqual([]);
    }
  });

  test("a daemon with no advertised feature and a missed read deadline refuse without any generic action", async () => {
    const old = providerFixture({ features: [] });
    const unsupported = await old.provider.snapshot(query);
    expect(unsupported.ok).toBe(false); expect(String(unsupported.error)).toMatch(/upgrade|restart|guidance_views/i);
    expect(old.requests).toEqual([]); expect(old.effects).toEqual([]);
    const slow = providerFixture({ stall: true });
    const timeout = await slow.provider.snapshot(query);
    expect(timeout.ok).toBe(false); expect(typeof timeout.error).toBe("string"); expect(timeout).not.toHaveProperty("unconfirmed");
    expect(timeout).not.toHaveProperty("guidance"); expect(slow.effects).toEqual([]);
  });

  test("malformed and oversized source replies cannot leak private fields or source failure text", async () => {
    const f = providerFixture();
    const available = page as Extract<GuidancePageResult, { state: "available" }>;
    const malformed = [{ ...available, records: [{ ...record, baseline: { bytes: marker } }] },
      { ...available, records: Array.from({ length: 33 }, (_, index) => ({ ...record, id: index.toString(16).padStart(64, "0") })) },
      { ...available, records: [record, record] }, { ...available, cursor: "cursor_on_complete" },
      { ...available, truncated: true }, { ...available, current: { ...current, taskCreated: 101 } },
      { ...available, records: [{ ...record, rationale: { ...record.rationale, problemHypothesis: marker.repeat(300) } }] },
      { state: "unavailable", count: 1, privateBody: marker }];
    for (const guidance of malformed) {
      f.setReply({ ok: true, guidance });
      const result = await f.provider.snapshot(query);
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty("guidance"); expect(result).not.toHaveProperty("lines");
      expect(JSON.stringify(result)).not.toContain(marker);
    }
    f.setReply({ ok: false, error: marker });
    const result = await f.provider.snapshot(query);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(marker); expect(f.effects).toEqual([]);
  });
});

class Element {
  children: Element[] = []; parent?: Element;
  private ownText = "";
  className = ""; type = ""; value = ""; inputMode = ""; required = false; autocomplete = ""; pattern = "";
  disabled = false; hidden = false; tabIndex = -1;
  attributes = new Map<string, string>(); listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  constructor(readonly tag: string, readonly ownerDocument: { createElement(tag: string): Element }) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get options(): Element[] { return this.children.filter(child => child.tag === "option"); }
  append(...nodes: Element[]) { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes: Element[]) { for (const child of this.children) child.parent = undefined; this.ownText = ""; this.children = []; this.append(...nodes); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(name, listener); }
  dispatch(name: string) { this.listeners.get(name)?.({ preventDefault() {} }); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelectorAll(selector: string): Element[] { return this.all().slice(1).filter(child => child.tag === selector); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// One I/O turn drains the promises whose responses this fixture explicitly releases. No polling or timer assertions.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const projects = [{ id: "p1", state: "running", instanceId: "i1" }, { id: "p2", state: "running", instanceId: "i2" }];
function panelFixture() {
  const document = { createElement: (tag: string): Element => new Element(tag, document) };
  const mount = document.createElement("div");
  const requests: { input: Record<string, unknown>; reply: ReturnType<typeof deferred> }[] = [], effects: unknown[] = [];
  const forbidden = (kind: string) => (...args: unknown[]) => { effects.push({ kind, args }); throw new Error("forbidden fixture port"); };
  const host = { mount, snapshot(input: Record<string, unknown>) { const reply = deferred(); requests.push({ input, reply }); return reply.promise; }, action: forbidden("action") };
  const assets = guidancePanelAssets();
  const factory = runInNewContext(assets.js.replace("export default", "globalThis.factory =") + "\n;globalThis.factory;", {
    fetch: forbidden("network"), setTimeout: forbidden("timer"), setInterval: forbidden("timer"),
  });
  const panel = factory(host) as { show(panel: string, params?: Record<string, string>): void; hide(): void; destroy(): void };
  const root = mount.children[0]!;
  const form = root.all().find(node => node.tag === "form")!;
  const project = root.all().find(node => node.tag === "select")!;
  const [task, epoch] = root.all().filter(node => node.tag === "input") as [Element, Element];
  const output = root.all().find(node => node.tag === "pre")!;
  const notice = root.all().find(node => node.attributes.get("role") === "status")!;
  const button = (text: string) => root.all().find(node => node.tag === "button" && node.textContent === text)!;
  const select = (projectId = "p1", taskId = "7", created = "100") => {
    project.value = projectId; project.dispatch("input"); task.value = taskId; task.dispatch("input"); epoch.value = created; epoch.dispatch("input");
  };
  const initial = async () => {
    panel.show("guidance"); expect(requests[0]!.input).toEqual({ panel: "board", after: 0 });
    requests[0]!.reply.resolve({ ok: true, projects }); await turn(); select();
  };
  const answer = async (value: GuidancePageResult | GuidanceDiffResult, lines = guidanceLines(value)) => {
    requests.at(-1)!.reply.resolve({ ok: true, guidance: value, lines }); await turn();
  };
  return { assets, panel, mount, root, form, project, task, epoch, output, notice, button, requests, effects, select, initial, answer };
}

describe("actual generated Guidance panel", () => {
  test("reads only an explicit scope, pages only on a click, and selects a withheld-label declaration by variant id", async () => {
    const f = panelFixture(); expect(f.root.hidden).toBe(true); expect(f.requests).toEqual([]);
    await f.initial(); expect(f.requests).toHaveLength(1);
    f.form.dispatch("submit");
    expect(f.requests.at(-1)!.input).toEqual({ panel: "guidance", op: "list", projectId: "p1", instanceId: "i1", taskId: 7, taskCreated: 100 });
    const partial: GuidancePageResult = { state: "available", current, records: [record], truncated: true, cursor: "fixture_cursor" };
    await f.answer(partial);
    const before = f.requests.length; await turn(); expect(f.requests).toHaveLength(before);
    f.button("Next page").dispatch("click");
    expect(f.requests.at(-1)!.input.cursor).toBe("fixture_cursor");
    await f.answer(page);
    f.button("Show diff").dispatch("click");
    expect(f.requests.at(-1)!.input).toEqual({ panel: "guidance", op: "show", projectId: "p1", instanceId: "i1", taskId: 7, taskCreated: 100, id });
    await f.answer(diff); expect(f.output.textContent).toBe(guidanceLines(diff).join("\n"));
    expect(f.effects).toEqual([]); expect(JSON.stringify(f.requests.map(request => request.input))).not.toContain("withheld");
    expect(f.requests.every(request => !("experimentId" in request.input) && !("person" in request.input))).toBe(true);
    f.form.dispatch("submit"); expect(f.requests.at(-1)!.input).not.toHaveProperty("cursor"); await f.answer(page);
  });

  test("renders the admitted lines as literal text and has no browser/action/private-state fallback", async () => {
    const f = panelFixture(); await f.initial(); f.form.dispatch("submit");
    const text = "<img src=x onerror=bad()> <script>bad()</script>";
    await f.answer(page, [text]); expect(f.output.textContent).toBe(text);
    expect(f.root.all().some(node => ["img", "script"].includes(node.tag))).toBe(false);
    for (const forbidden of ["host.action", "fetch(", "innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "document.cookie", "localStorage", "setInterval", "setTimeout", "baseline.bytes", "candidate.bytes", "evidenceRefs", "personMeta", "snapshotToken"]) {
      expect(f.assets.js).not.toContain(forbidden);
    }
    expect(f.assets.css).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i); expect(f.effects).toEqual([]);
  });

  test("missing or malformed presentation lines refuse rather than rendering raw DTO fields or source error text", async () => {
    const f = panelFixture(); await f.initial();
    for (const lines of [undefined, null, marker, [marker, {}]]) {
      f.form.dispatch("submit"); f.requests.at(-1)!.reply.resolve({ ok: true, guidance: { ...page, privateBody: marker }, ...(lines === undefined ? {} : { lines }) });
      await turn(); expect(f.output.textContent).toBe(""); expect(f.notice.textContent).toContain("Guidance unavailable"); expect(f.root.textContent).not.toContain(marker);
    }
    f.form.dispatch("submit"); f.requests.at(-1)!.reply.resolve({ ok: false, error: marker }); await turn();
    expect(f.root.textContent).not.toContain(marker); expect(f.effects).toEqual([]);
  });

  for (const boundary of ["project", "task"] as const) for (const outcome of ["success", "refusal", "error"] as const) {
    test(`late ${outcome} cannot replace a new ${boundary} scope or enable controls while its read is pending`, async () => {
      const f = panelFixture(); await f.initial(); f.form.dispatch("submit"); const old = f.requests.at(-1)!;
      f.select(boundary === "project" ? "p2" : "p1", boundary === "task" ? "8" : "7", boundary === "task" ? "200" : "100");
      f.form.dispatch("submit"); const fresh = f.requests.at(-1)!;
      if (outcome === "error") old.reply.reject(new Error(marker));
      else old.reply.resolve(outcome === "refusal" ? { ok: false, error: marker } : { ok: true, guidance: page, lines: [marker] });
      await turn(); expect(f.output.textContent).toBe(""); expect(f.notice.textContent).toBe("Reading declarations...");
      expect(f.button("List declarations").disabled).toBe(true); expect(f.root.textContent).not.toContain(marker);
      const binding = boundary === "task" ? { ...current, taskId: 8, taskCreated: 200 } : current;
      const value: GuidancePageResult = { state: "available", current: binding, records: [{ ...record, ...binding, id: secondId }], truncated: false };
      fresh.reply.resolve({ ok: true, guidance: value, lines: ["CURRENT SCOPE"] }); await turn();
      expect(f.output.textContent).toBe("CURRENT SCOPE"); expect(f.button("List declarations").disabled).toBe(false); expect(f.effects).toEqual([]);
    });
  }

  test("late project listing success/error and hidden/destroyed reads cannot replace the current view", async () => {
    const f = panelFixture(); f.panel.show("guidance", { project: "p1" }); const old = f.requests.at(-1)!;
    f.panel.show("guidance", { project: "p2" }); const fresh = f.requests.at(-1)!;
    fresh.reply.resolve({ ok: true, projects }); await turn();
    old.reply.resolve({ ok: true, projects: [{ id: marker, state: "running", instanceId: "old" }] }); await turn();
    expect(f.project.value).toBe("p2"); expect(f.root.textContent).not.toContain(marker);
    f.select(); f.form.dispatch("submit"); const hidden = f.requests.at(-1)!; f.panel.hide();
    hidden.reply.resolve({ ok: true, guidance: page, lines: [marker] }); await turn();
    expect(f.root.hidden).toBe(true); expect(f.output.textContent).toBe(""); expect(f.root.textContent).not.toContain(marker);
    f.panel.show("guidance"); const listing = f.requests.at(-1)!; f.panel.destroy(); listing.reply.reject(new Error(marker)); await turn();
    expect(f.mount.children).toEqual([]); expect(f.effects).toEqual([]);
  });

  test("a completed newer scope keeps its text, controls and next-page cursor after an older success arrives", async () => {
    const f = panelFixture(); await f.initial(); f.form.dispatch("submit"); const old = f.requests.at(-1)!;
    f.select("p2"); f.form.dispatch("submit");
    const fresh: GuidancePageResult = { state: "available", current, records: [{ ...record, id: secondId }], truncated: true, cursor: "new_scope_cursor" };
    await f.answer(fresh, ["CURRENT SCOPE"]);
    old.reply.resolve({ ok: true, guidance: page, lines: [marker] }); await turn();
    expect(f.output.textContent).toBe("CURRENT SCOPE"); expect(f.button("List declarations").disabled).toBe(false);
    expect(f.button("Next page").hidden).toBe(false); expect(f.root.textContent).not.toContain(marker);
    f.button("Next page").dispatch("click");
    expect(f.requests.at(-1)!.input).toMatchObject({ projectId: "p2", instanceId: "i2", cursor: "new_scope_cursor" });
    await f.answer(page); expect(f.effects).toEqual([]);
  });
});
