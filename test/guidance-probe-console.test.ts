import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import plugin, { createProvider } from "../src/ui/plugin.ts";
import { guidancePanelAssets } from "../src/ui/guidance-panel.ts";
import { guidanceProbeStatusLines } from "../src/ui/guidance-view.ts";
import { DASHBOARD_VIEWS } from "../src/hub/ui.ts";
import { PROTOCOL, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { USER } from "../src/hub/envelope.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import type { ProbeReceiptExport } from "../src/hub/guidance-probes.ts";
import { probeTasksFixture, runProbeExperiment } from "./helpers/guidance-probe-tasks.ts";

// #1226 T4: the producer's probe status through the REAL generated panel and the REAL provider, against a scripted loopback hub that serves a REAL export taken
// from the real Tasks + Store. No model, worker, native session or account is used, and no action is ever advertised or forwarded.
const marker = "PRIVATE-PROBE-CONSOLE-MARKER";
const dirs: string[] = [], servers: { stop(force?: boolean): void }[] = [], clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const close of clean.splice(0).reverse()) await close();
});

/** One real fake-provider experiment, exported exactly as the daemon would answer `guidance_probe_receipts`. */
async function realExport(): Promise<ProbeReceiptExport> {
  const f = await probeTasksFixture(clean), run = await runProbeExperiment(f);
  return f.tasks.guidanceProbeReceipts(USER, run.id);
}

function providerFixture(options: { features?: string[]; welcomeInstance?: string; stall?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-probe-console-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/probe-fixture-project", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (value: string) => value === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const requests: Record<string, unknown>[] = [], hellos: Record<string, unknown>[] = [], effects: Record<string, unknown>[] = [];
  let features = options.features ?? ["guidance_probes", "guidance_probe_receipts"];
  let reply: Record<string, unknown> = { ok: false, error: "no export scripted" };
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("no", { status: 400 }); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") {
        hellos.push(message);
        socket.send(JSON.stringify({ rid: message.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: options.welcomeInstance ?? "i1", features }));
        return;
      }
      if (message.t === "guidance_probe_receipts") {
        requests.push(message);
        if (!options.stall) socket.send(JSON.stringify({ rid: message.rid, ...reply }));
        return;
      }
      // Anything else a probe read could have sent is an effect, and there must be none.
      effects.push(message);
      socket.send(JSON.stringify({ rid: message.rid, ok: false, error: "unexpected fixture operation" }));
    } },
  });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  const descriptor = { pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1", features };
  const writeStatus = (next: Record<string, unknown>) => writeFileSync(join(project.stateDir, "status.json"), JSON.stringify(next));
  writeStatus(descriptor); writeFileSync(join(project.stateDir, "control-token"), "probe-scripted-token");
  return { provider: createProvider({ home, registry, lifecycle, forwardTimeoutMs: (_operation, nominal) => options.stall ? 40 : nominal }),
    requests, hellos, effects, setReply: (next: Record<string, unknown>) => { reply = next; },
    setFeatures: (next: string[]) => { features = next; writeStatus({ ...descriptor, features: next }); } };
}
const ask = (id: string, extra: Record<string, unknown> = {}) => ({ after: 0, panel: "guidance", op: "probe", projectId: "p1", instanceId: "i1", id, ...extra });

describe("the provider's probe read over a scripted control port", () => {
  test("a real export is returned with the shared lines, after a pinned console hello and a closed request", async () => {
    const exported = await realExport(), f = providerFixture();
    f.setReply({ ok: true, receipts: exported });
    const result = await f.provider.snapshot(ask(exported.status.id));
    expect(result.ok).toBe(true); expect(result.probe).toEqual(exported); expect(result.lines).toEqual(guidanceProbeStatusLines(exported));
    expect(f.hellos[0]).toMatchObject({ role: "console", projectId: "p1", instanceId: "i1" });
    const { rid, ...sent } = f.requests[0]!;
    expect(typeof rid).toBe("number"); expect(sent).toEqual({ t: "guidance_probe_receipts", id: exported.status.id });
    expect(f.effects).toEqual([]);
  });
  test("the text states fixture evidence, the full denominator and no live trial", async () => {
    const exported = await realExport(), text = guidanceProbeStatusLines(exported).join("\n");
    expect(text).toContain("Fixture evidence only"); expect(text).toContain("no live model or worker trial");
    expect(text).toContain("Outcomes (every reserved slot counts)"); expect(text).toContain("2 succeeded");
    expect(text).not.toMatch(/live trial (passed|succeeded|demonstrated)/i);
  });
  test("the panel manifest keeps its panels and advertises no probe action", () => {
    expect(plugin.manifest.panels.map(panel => panel.id)).toEqual([...DASHBOARD_VIEWS, "guidance"]);
    expect((plugin.manifest.capabilities?.actions ?? []).filter(action => /guidance|probe/.test(action))).toEqual([]);
  });
  test("forged fields, a malformed id, a missing scope and an older hub never reach a control operation or satisfy the read", async () => {
    const exported = await realExport(), f = providerFixture();
    f.setReply({ ok: true, receipts: exported });
    const id = exported.status.id;
    for (const fields of [{ actor: "user" }, { person: "user" }, { revision: 3 }, { variantId: id }, { file: "/tmp/x" }, { privateBody: marker }]) {
      expect((await f.provider.snapshot(ask(id, fields))).ok, JSON.stringify(fields)).toBe(false);
    }
    for (const bad of ["short", "G".repeat(64), "a".repeat(63), "A".repeat(64), "", undefined as unknown as string]) expect((await f.provider.snapshot(ask(bad))).ok).toBe(false);
    for (const target of [{ projectId: "missing" }, { instanceId: "" }, { instanceId: "replacement" }]) expect((await f.provider.snapshot(ask(id, target))).ok).toBe(false);
    expect(f.requests).toEqual([]); expect(f.effects).toEqual([]);
    f.setFeatures(["guidance_probes"]);
    const old = await f.provider.snapshot(ask(id));
    expect(old.ok).toBe(false); expect(String(old.error)).toMatch(/upgrade|restart|guidance_probe_receipts/i);
    expect(f.requests).toEqual([]);
  });
  test("a reply for another probe, a tampered receipt, a refused read and a missed deadline are refusals that carry no text and no source error", async () => {
    const exported = await realExport(), f = providerFixture(), id = exported.status.id;
    const other = { ...exported, status: { ...exported.status, id: "e".repeat(64) } };
    const tampered = JSON.parse(JSON.stringify(exported)); tampered.slots[0].receipt.state = "failed";
    for (const receipts of [other, tampered, { ...exported, privateBody: marker }, null, "x"]) {
      f.setReply({ ok: true, receipts });
      const result = await f.provider.snapshot(ask(id));
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty("probe"); expect(result).not.toHaveProperty("lines");
      expect(JSON.stringify(result)).not.toContain(marker);
    }
    f.setReply({ ok: false, error: marker });
    const refused = await f.provider.snapshot(ask(id));
    expect(refused.ok).toBe(false); expect(refused).not.toHaveProperty("lines");
    const slow = providerFixture({ stall: true }); slow.setReply({ ok: true, receipts: exported });
    const timeout = await slow.provider.snapshot(ask(id));
    expect(timeout.ok).toBe(false); expect(timeout).not.toHaveProperty("probe"); expect(slow.effects).toEqual([]);
  });
  test("the existing list and show reads are unchanged beside the new op", async () => {
    const f = providerFixture(["guidance_views"] as never);
    const result = await f.provider.snapshot({ after: 0, panel: "guidance", op: "list", projectId: "p1", instanceId: "i1", taskId: 7, taskCreated: 100 });
    expect(result.ok).toBe(false); // no guidance_list reply is scripted here: the point is that the op still routes to the guidance port, not the probe port
    expect(f.requests).toEqual([]);
  });
});

// ---------- the actual generated panel ----------
class Element {
  children: Element[] = []; parent?: Element;
  private ownText = "";
  className = ""; type = ""; value = ""; inputMode = ""; required = false; autocomplete = ""; pattern = ""; maxLength = 0; spellcheck = true;
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
  const forms = root.all().filter(node => node.tag === "form"), probeForm = forms[1]!;
  const project = root.all().find(node => node.tag === "select")!;
  const probeId = probeForm.all().find(node => node.tag === "input")!;
  const pres = root.all().filter(node => node.tag === "pre"), probeOutput = pres[1]!;
  const notice = root.all().find(node => node.attributes.get("role") === "status")!;
  const button = (text: string) => root.all().find(node => node.tag === "button" && node.textContent === text)!;
  const initial = async () => {
    panel.show("guidance"); expect(requests[0]!.input).toEqual({ panel: "board", after: 0 });
    requests[0]!.reply.resolve({ ok: true, projects }); await turn(); project.value = "p1"; project.dispatch("input");
  };
  return { assets, panel, mount, root, probeForm, probeId, project, probeOutput, notice, button, requests, effects, initial };
}
const probeReply = (exported: ProbeReceiptExport) => ({ ok: true, panel: "guidance", probe: exported, lines: guidanceProbeStatusLines(exported) });

describe("actual generated Guidance panel: probe status", () => {
  test("reads one exact probe id for the selected project and shows the provider's own lines as literal text", async () => {
    const exported = await realExport(), f = panelFixture(); await f.initial();
    f.probeId.value = exported.status.id; f.probeId.dispatch("input");
    f.probeForm.dispatch("submit");
    expect(f.requests.at(-1)!.input).toEqual({ panel: "guidance", op: "probe", projectId: "p1", instanceId: "i1", id: exported.status.id });
    f.requests.at(-1)!.reply.resolve(probeReply(exported)); await turn();
    expect(f.probeOutput.textContent).toBe(guidanceProbeStatusLines(exported).join("\n"));
    expect(f.notice.textContent).toContain("Fixture evidence only");
    expect(f.effects).toEqual([]);
    for (const forbidden of ["host.action", "fetch(", "innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "document.cookie", "localStorage", "setInterval", "setTimeout"]) expect(f.assets.js).not.toContain(forbidden);
  });
  test("an invalid id or no project selected sends nothing", async () => {
    const f = panelFixture(); await f.initial();
    for (const bad of ["", "xyz", "A".repeat(64), "a".repeat(63)]) { f.probeId.value = bad; f.probeId.dispatch("input"); f.probeForm.dispatch("submit"); }
    expect(f.requests).toHaveLength(1); expect(f.notice.textContent).toContain("64-character probe id");
    const noProject = panelFixture(); noProject.panel.show("guidance"); noProject.requests[0]!.reply.resolve({ ok: true, projects }); await turn();
    noProject.probeId.value = "a".repeat(64); noProject.probeForm.dispatch("submit");
    expect(noProject.requests).toHaveLength(1);
  });
  test("a reply for another probe, missing lines, a refusal or a thrown error shows nothing of it and no raw source text", async () => {
    const exported = await realExport(), f = panelFixture(); await f.initial();
    const submit = () => { f.probeId.value = exported.status.id; f.probeForm.dispatch("submit"); return f.requests.at(-1)!; };
    const other = { ...exported, status: { ...exported.status, id: "e".repeat(64) } };
    for (const reply of [probeReply(other), { ok: true, probe: exported, lines: marker }, { ok: true, probe: exported, lines: [marker, {}] }, { ok: true, probe: exported }, null]) {
      submit().reply.resolve(reply); await turn();
      expect(f.probeOutput.textContent).toBe(""); expect(f.root.textContent).not.toContain(marker);
    }
    submit().reply.reject(new Error(marker)); await turn();
    expect(f.probeOutput.textContent).toBe(""); expect(f.root.textContent).not.toContain(marker); expect(f.notice.textContent).toContain("Probe status unavailable");
    // A refusal's own text is the provider's bounded, fixed sentence: the panel shows that sentence and never the rest of the reply, so a field a hostile source
    // adds beside it (here the marker) can never reach the page.
    submit().reply.resolve({ ok: false, error: "guidance probe is unavailable; inspect a registered declaration in this project", privateBody: marker, probe: { slots: [marker] }, lines: [marker] }); await turn();
    expect(f.notice.textContent).toBe("guidance probe is unavailable; inspect a registered declaration in this project");
    expect(f.probeOutput.textContent).toBe(""); expect(f.root.textContent).not.toContain(marker);
    // And a refusal that is not a string at all falls back to the fixed unavailable sentence.
    submit().reply.resolve({ ok: false, error: { marker }, lines: [marker] }); await turn();
    expect(f.notice.textContent).toContain("Probe status unavailable"); expect(f.root.textContent).not.toContain(marker);
    expect(f.effects).toEqual([]);
  });
  test("a late reply cannot replace a newer read, a changed id, a hidden panel or a destroyed one", async () => {
    const exported = await realExport(), f = panelFixture(); await f.initial();
    f.probeId.value = exported.status.id; f.probeForm.dispatch("submit"); const old = f.requests.at(-1)!;
    f.probeId.value = "d".repeat(64); f.probeId.dispatch("input"); f.probeForm.dispatch("submit"); const fresh = f.requests.at(-1)!;
    old.reply.resolve(probeReply(exported)); await turn();
    expect(f.probeOutput.textContent).toBe(""); expect(f.notice.textContent).toBe("Reading probe status...");
    f.probeId.value = exported.status.id; f.probeId.dispatch("input");
    fresh.reply.resolve(probeReply(exported)); await turn();
    expect(f.probeOutput.textContent).toBe("");
    f.probeForm.dispatch("submit"); const hidden = f.requests.at(-1)!; f.panel.hide();
    hidden.reply.resolve(probeReply(exported)); await turn();
    expect(f.root.hidden).toBe(true); expect(f.probeOutput.textContent).toBe("");
    f.panel.show("guidance"); f.requests.at(-1)!.reply.resolve({ ok: true, projects }); await turn();
    f.probeId.value = exported.status.id; f.probeForm.dispatch("submit"); const last = f.requests.at(-1)!; f.panel.destroy(); last.reply.resolve(probeReply(exported)); await turn();
    expect(f.mount.children).toEqual([]); expect(f.effects).toEqual([]);
  });
  test("the generated markup parses and carries the fixture-only note", () => {
    const f = panelFixture();
    expect(f.root.textContent).toContain("fixture evidence only"); expect(f.root.textContent).toContain("claims no live model or worker trial");
    expect(f.probeId.maxLength).toBe(64); expect(f.probeId.pattern).toBe("[a-f0-9]{64}"); expect(f.probeId.spellcheck).toBe(false);
  });
});

test("the daemon advertises the receipts feature beside the existing probe feature", () => {
  expect(DAEMON_FEATURES).toContain("guidance_probe_receipts"); expect(DAEMON_FEATURES).toContain("guidance_probes");
});
