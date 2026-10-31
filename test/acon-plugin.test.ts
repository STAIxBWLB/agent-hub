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
        tasks: [{ id: 7, title: "Review the parser", state: "in_review", owner: "codex", reviewer: "user" }, { id: 8, title: "Other", state: "in_review", owner: "codex", reviewer: "claude" }] })); }
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
