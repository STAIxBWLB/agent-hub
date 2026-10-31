import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import plugin, { createProvider, panelAssets } from "../src/ui/plugin.ts";
import { DASHBOARD_VIEWS, renderDashboard, startDashboard } from "../src/hub/ui.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { aconManifestPath, registerAconPlugin } from "../src/cli/acon-register.ts";
import { officeModel, type OfficeSnapshotInput } from "../src/ui/office-model.ts";
import { mergeSpaces, officeSpace, SPACE_CAPS } from "../src/ui/office-space.ts";

// #935: the acon console plugin over the manager's own listing and forwarding, against a scripted project hub.
const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PERMISSION = { t: "permission", id: "perm-1", peer: "kimi", title: "execute: fixture command", createdAt: 1_790_000_000_000, expiresAt: Date.now() + 60_000,
  options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Deny" }] };

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-acon-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/acon-project", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const actions: Record<string, unknown>[] = [], snapshots: Record<string, unknown>[] = [];
  let permissions = [PERMISSION];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" }));
      if (m.t === "ui_snapshot") { snapshots.push(m); return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions,
        status: { peers: { kimi: { state: "busy", queued: 2, permissionMode: "default" }, codex: { state: "idle" } } },
        events: [{ seq: 1, event: { t: "envelope", env: { from: "codex", to: ["kimi"], kind: "chat", priority: "status", ts: Date.now(), body: "MARKER-1012 body", refs: { task: "7" } } } }],
        tasks: [{ id: 7, title: "Review the parser", detail: "MARKER-1012 detail", class: "implement", state: "in_review", owner: "codex", reviewer: "user" }, { id: 8, title: "Other", state: "in_review", owner: "codex", reviewer: "claude" }, { id: 9, title: "Wire the space", class: "implement", state: "in_progress", owner: "kimi" }] })); }
      if (m.t === "ui_action") { actions.push(m.action); if (m.action.action === "permit") permissions = []; return void ws.send(JSON.stringify({ rid: m.rid, ok: true })); }
    },
  } });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  const provider = createProvider({ home, registry, lifecycle });
  return { home, provider, actions, snapshots };
}

describe("acon plugin manifest", () => {
  test("panels are exactly DASHBOARD_VIEWS, with inbox and confirm", () => {
    expect(plugin.manifest.panels.map((p) => p.id)).toEqual([...DASHBOARD_VIEWS]);
    expect(plugin.manifest).toMatchObject({ api: 1, tool: "ahub", capabilities: { inbox: true, confirm: true } });
    expect(() => JSON.stringify(plugin.manifest)).not.toThrow();
  });
});

describe("acon plugin provider (D1)", () => {
  test("a bare panel poll lists the registered projects; a project poll forwards ui_snapshot with the view", async () => {
    const { provider, snapshots } = fixture();
    const listing = await provider.snapshot({ after: 0, panel: "board" });
    expect(listing).toMatchObject({ ok: true, mode: "all", projects: [{ id: "p1", state: "running", instanceId: "i1" }] });
    const snap = await provider.snapshot({ after: 0, panel: "board", projectId: "p1", instanceId: "i1", view: "office" });
    expect(snap.ok).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ t: "ui_snapshot", view: "office" });
    await provider.snapshot({ after: 0, panel: "board", projectId: "p1", instanceId: "i1", view: "not-a-view" });
    expect(snapshots.at(-1)?.view).toBe("board"); // an unknown view never reaches the hub
  });

  test("the inbox lists approvals and the person's reviews, with a stable at", async () => {
    const { provider } = fixture();
    const first = (await provider.snapshot({ after: 0, panel: "inbox" })).items as any[];
    expect(first.map((i) => [i.group, i.kind, i.id])).toEqual([["decision", "approval", "perm:p1:perm-1"], ["review", "review", "review:p1:7"]]);
    expect(first[0].at).toBe(new Date(PERMISSION.createdAt).toISOString());
    expect(first[0].verbs.map((v: any) => v.id)).toEqual(["approve", "deny"]);
    expect(first.map((i) => i.link)).toEqual([{ panel: "agents", params: { project: "p1" } }, { panel: "board", params: { project: "p1" } }]);
    await Bun.sleep(20);
    const second = (await provider.snapshot({ after: 0, panel: "inbox" })).items as any[];
    expect(second.map((i) => i.at)).toEqual(first.map((i) => i.at));
  });

  test("approve answers needsConfirm, then forwards the hub's own permit with the allow option", async () => {
    const { provider, actions } = fixture();
    const preview = await provider.action({ action: "approve", id: "perm:p1:perm-1" });
    expect(preview).toMatchObject({ ok: false, needsConfirm: true });
    expect(actions).toEqual([]);
    if (!("needsConfirm" in preview)) throw new Error("expected a preview");
    const wrong = await provider.action({ action: "approve", id: "perm:p1:perm-1", confirmed: true, fingerprint: "0".repeat(64) });
    expect("needsConfirm" in wrong).toBe(true);
    const done = await provider.action({ action: "approve", id: "perm:p1:perm-1", confirmed: true, fingerprint: String(preview.fingerprint) });
    expect(done.ok).toBe(true);
    expect(actions).toEqual([{ action: "permit", projectId: "p1", instanceId: "i1", id: "perm-1", option: "yes" }]);
    expect((await provider.snapshot({ after: 0, panel: "inbox" })).items).toHaveLength(1); // the approval is gone
  });

  test("outward dashboard actions confirm first; reads and unknown actions do not reach the hub", async () => {
    const { provider, actions } = fixture();
    for (const action of ["send", "stop", "permit", "setting", "config_edit_apply", "start_peer"]) {
      const result = await provider.action({ action, projectId: "p1", instanceId: "i1", body: "hello" });
      expect("needsConfirm" in result && result.needsConfirm).toBe(true);
    }
    expect((await provider.action({ action: "shell_exec", projectId: "p1", instanceId: "i1" })).ok).toBe(false);
    expect((await provider.action({ action: "pause", projectId: "p1", instanceId: "i1", peer: "kimi" })).ok).toBe(true);
    expect(actions).toEqual([{ action: "pause", projectId: "p1", instanceId: "i1", peer: "kimi" }]);
  });
});

describe("dashboard assets (D2)", () => {
  test("ahub ui still serves the same page and CSP from renderDashboard", async () => {
    const { html } = renderDashboard();
    const dashboard = startDashboard({ snapshot: () => ({}), action: () => ({}) });
    try {
      const response = await fetch(`${dashboard.origin}/`, { headers: { host: new URL(dashboard.origin).host } });
      expect(await response.text()).toBe(html);
      const hash = (body: string) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
      for (const script of renderDashboard().script.length ? [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!) : []) {
        expect(response.headers.get("content-security-policy")).toContain(hash(script));
      }
    } finally { dashboard.stop(); }
  });

  test("the panel module is an ES module that routes post() to the host and never reaches the page's URL, cookies or fetch", () => {
    const { js, css } = panelAssets();
    expect(new Bun.Transpiler({ loader: "js" }).scan(js).exports).toEqual(["default"]);
    for (const bad of ["fetch(", "document.cookie", "history.replaceState", "location.hash", "document.getElementById", "innerHTML", "document.addEventListener"]) expect(js).not.toContain(bad);
    expect(js).toContain("host.snapshot(");
    expect(js).toContain("host.action(body)");
    expect(js).toContain("if (wantProject && projectList.some("); // an inbox link's project is selected on show
    expect(css.startsWith(".ahub-panel{")).toBe(true);
    expect(js).not.toMatch(/<(main|header|footer)\b/); // the shell owns the landmarks
    expect(/@import|url\(\s*["']?(https?:)?\/\//i.test(css)).toBe(false);
  });
});

describe("acon Space from the office model (#1012 Part 2)", () => {
  const MARKER = "XYZZY-MARKER-1012";
  const dirty = {
    status: { peers: { codex: { state: "busy", queued: 1, needsReview: 1, permissionMode: "acceptEdits" }, pi: { state: "idle" }, kimi: { state: "busy", paused: "budget" } } },
    tasks: [
      { id: 1, title: "[pii]", detail: `${MARKER} private detail`, class: "implement", state: "in_progress", owner: "codex", deps: [] },
      { id: 2, title: "public title", detail: `${MARKER} other detail`, class: "test", state: "proposed", deps: [] },
      { id: 3, title: "in review", class: "review", state: "in_review", owner: "pi", reviewer: "codex", deps: [] },
      { id: 4, title: "shipped", class: "implement", state: "approved", owner: "pi", deps: [] },
    ],
    permissions: [{ id: "p1", peer: "codex", title: `${MARKER} approval title`, options: [] }],
    links: [{ kind: "overlap", tasks: [1, 3], peers: ["codex", "pi"], reason: `${MARKER} overlap reason` }],
    events: [{ seq: 9, event: { t: "envelope", env: { from: "codex", to: ["pi"], kind: "chat", priority: "status", ts: 1500, body: `${MARKER} body`, refs: { task: "1" } } } }],
    budget: { codex: { windows: [], paused: null } },
  } as unknown as OfficeSnapshotInput;

  test("peers, zones, cards and links map onto the SpaceScene contract with project-prefixed ids", () => {
    const scene = officeSpace(officeModel(dirty, null, { cols: 4, now: 3000 }), { id: "p1" });
    const actor = (id: string) => scene.actors.find((a) => a.id === `p1:${id}`)!;
    expect(actor("codex")).toMatchObject({ name: "codex", state: "waiting", card: "p1:1", link: { panel: "agents" } });
    expect(actor("codex").marks?.map((m) => m.kind)).toEqual(["approval", "inbox", "mode"]);
    expect(actor("pi").state).toBe("idle");
    expect(actor("kimi").marks?.map((m) => m.kind)).toContain("paused");
    expect(scene.actors.every((a) => a.pet === undefined)).toBe(true); // the shell assigns installed pets
    expect(scene.zones.map((z) => [z.id, z.kind, z.count])).toEqual([["p1:todo", "queue", 1], ["p1:work", "work", 1], ["p1:review", "review", 1], ["p1:done", "done", 1]]);
    expect(scene.cards.find((c) => c.id === "p1:1")).toMatchObject({ title: "#1 [pii]", zone: "p1:work", owner: "p1:codex" });
    expect(scene.cards.find((c) => c.id === "p1:2")?.zone).toBe("p1:todo");
    expect(scene.links).toEqual([expect.objectContaining({ kind: "overlap", from: "p1:codex", to: "p1:pi", label: "#1 #3" })]);
    // Message links come from envelope rows that arrive after the first snapshot (the office model's arcs), as on the dashboard.
    const first = officeModel(dirty, null, { cols: 4, now: 3000 });
    const flowing = officeSpace(officeModel({ ...dirty, events: [{ seq: 10, event: { t: "envelope", env: { from: "codex", to: ["pi"], kind: "chat", priority: "status", ts: 3500, body: `${MARKER} new`, refs: { task: "1" } } } }] } as OfficeSnapshotInput, first, { cols: 4, now: 4000 }), { id: "p1" });
    expect(flowing.links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "message", from: "p1:codex", to: "p1:pi", label: "#1" })]));
    expect(JSON.stringify(flowing)).not.toContain(MARKER);
  });

  test("MARKER: no body, detail, approval title, reason or PII text reaches the mapped scene", () => {
    expect(JSON.stringify(dirty)).toContain(MARKER);
    const scene = officeSpace(officeModel(dirty, null, { cols: 4, now: 3000 }), { id: "p1", label: "proj" });
    expect(JSON.stringify(scene)).not.toContain(MARKER);
    expect(scene.actors[0]!.name.startsWith("proj / ")).toBe(true);
  });

  test("merged scenes stay within acon's caps", () => {
    const one = officeSpace(officeModel(dirty, null, { cols: 4, now: 3000 }), { id: "p" });
    const many = mergeSpaces(Array.from({ length: 40 }, (_, i) => ({ ...one, actors: one.actors.map((a) => ({ ...a, id: `${i}:${a.id}` })), links: Array.from({ length: 5 }, () => one.links![0]!) })));
    expect(many.actors.length).toBe(SPACE_CAPS.actors);
    expect(many.links!.length).toBe(SPACE_CAPS.links);
  });

  test("the provider's space panel aggregates running projects through ui_snapshot and leaks no marker", async () => {
    const { provider, snapshots } = fixture();
    const { scene } = await provider.snapshot({ after: 0, panel: "space" }) as { scene: any };
    expect(snapshots.at(-1)).toMatchObject({ t: "ui_snapshot", view: "office" });
    expect(scene.actors.map((a: any) => a.id).sort()).toEqual(["p1:codex", "p1:kimi"]);
    expect(scene.actors.find((a: any) => a.id === "p1:kimi")).toMatchObject({ state: "waiting", card: "p1:9", marks: expect.arrayContaining([{ kind: "approval", text: "1 approval" }]) });
    expect(scene.cards.map((c: any) => c.id)).toEqual(expect.arrayContaining(["p1:7", "p1:9"]));
    expect(JSON.stringify(scene)).not.toContain("MARKER-1012");
    expect(plugin.manifest.capabilities?.space).toBe(true);
  });
});

describe("ahub setup registration", () => {
  test("writes ahub.json with the module sha256 in a 0700 directory, idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "ahub-acon-reg-")); dirs.push(home);
    const module = join(import.meta.dir, "..", "src", "ui", "plugin.ts");
    const first = registerAconPlugin(home, module);
    expect(first).toEqual({ path: aconManifestPath(home), changed: true });
    const written = JSON.parse(readFileSync(aconManifestPath(home), "utf8"));
    expect(written).toEqual({ api: 1, tool: "ahub", module, sha256: createHash("sha256").update(readFileSync(module)).digest("hex") });
    expect(statSync(join(home, "console", "plugins")).mode & 0o777).toBe(0o700);
    expect(registerAconPlugin(home, module)).toEqual({ path: aconManifestPath(home), changed: false });
    expect(registerAconPlugin(home, join(home, "missing.ts"))).toHaveProperty("error");
    expect(existsSync(`${aconManifestPath(home)}.${process.pid}.tmp`)).toBe(false);
  });
});
