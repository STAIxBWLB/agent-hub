import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import plugin, { createProvider } from "../src/ui/plugin.ts";
import { DASHBOARD_VIEWS, renderDashboard } from "../src/hub/ui.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { renderExecutionLineage, validateLineageReply } from "../src/cli/lineage.ts";

// #1220 T3: the acon console reads the same admitted lineage page the CLI prints, over the console role's own
// control message, and nothing here links, probes or executes.
const task = { v: 1 as const, tool: "ahub" as const, projectKey: "fixture-project", kind: "task", id: "7" };
const attempt = { ...task, kind: "attempt", id: "ra-0123456789ab" };
const page = { state: "available" as const, nodes: [{ ref: task, state: "in_progress", strength: "host-observed" as const }, { ref: attempt, state: "failed", strength: "runner-attested" as const }],
  edges: [{ from: task, to: attempt, relation: "attempted" as const, strength: "host-observed" as const }], truncated: false };

const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-lineage-console-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/lineage-project", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const hellos: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [], actions: Record<string, unknown>[] = [];
  let reply: Record<string, unknown> = { ok: true, lineage: page };
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.t === "hello") { hellos.push(m); return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" })); }
      if (m.t === "lineage_show") { requests.push(m); return void ws.send(JSON.stringify({ rid: m.rid, ...reply })); }
      if (m.t === "ui_action") { actions.push(m.action); return void ws.send(JSON.stringify({ rid: m.rid, ok: true })); }
      return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions: [], tasks: [], events: [] }));
    },
  } });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  return { provider: createProvider({ home, registry, lifecycle }), hellos, requests, actions, setReply: (value: Record<string, unknown>) => { reply = value; } };
}

describe("acon lineage provider port (#1220 T3)", () => {
  test("atex build appears as metadata without a navigation action", async () => {
    const { provider, setReply, actions } = fixture();
    const build = { v: 1 as const, tool: "atex" as const, projectKey: "writing-project", kind: "build", id: "receipt-1", sha256: "a".repeat(64) };
    setReply({ ok: true, lineage: { ...page, nodes: [...page.nodes, { ref: build, state: "declared", strength: "declared" }] } });
    const reply = await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 });
    expect(reply.ok).toBe(true);
    const lines = (reply.lines as string[]).join("\n");
    expect(lines).toContain("atex"); expect(lines).toContain("build"); expect(lines).toContain("a".repeat(64));
    expect(actions).toEqual([]);
  });
  test("the console answers with the page the CLI prints, over the console role's own control message", async () => {
    const { provider, hellos, requests, actions } = fixture();
    const reply = await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 });
    // AC5's equivalence: the console's lines are the CLI's lines for the same admitted page.
    expect(reply).toEqual({ ok: true, panel: "lineage", lineage: page, lines: renderExecutionLineage(validateLineageReply(page)) });
    expect(hellos[0]).toMatchObject({ role: "console", projectId: "p1", instanceId: "i1" });
    // The closed selector list, and nothing this plugin or the page added: no project, instance, panel or injection.
    const { rid, ...sent } = requests[0] as Record<string, unknown>;
    expect(typeof rid).toBe("number");
    expect(sent).toEqual({ t: "lineage_show", taskId: 7 });
    expect(actions).toEqual([]);
  });

  test("lineage reading executes nothing and adds no dashboard panel or action", async () => {
    const { provider, actions } = fixture();
    expect(plugin.manifest.panels.map((panel) => panel.id)).toEqual([...DASHBOARD_VIEWS, "guidance"]);
    expect(plugin.manifest.capabilities).toMatchObject({ reads: ["lineage"] });
    const tabs = [...renderDashboard().markup.matchAll(/data-view-target="([^"]+)"/g)].map((match) => match[1]);
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs).not.toContain("lineage");
    expect((plugin.manifest.capabilities?.actions ?? []).some((name) => name.startsWith("lineage"))).toBe(false);
    for (const query of [{ taskId: 7 }, { attemptId: attempt.id }, { root: task, task: { id: 7, created: 100 }, nodes: 5, edges: 2, bytes: 4096, cursor: "opaque_cursor" }]) {
      expect((await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", ...query })).ok).toBe(true);
    }
    expect(actions).toEqual([]);
  });

  test("an unavailable source stays a refusal and a truncated page keeps its cursor", async () => {
    const { provider, setReply } = fixture();
    for (const value of [{ state: "unavailable" }, { state: "unavailable", reason: "withheld" }, { state: "unavailable", reason: "cursor_invalid" }]) {
      setReply({ ok: true, lineage: value });
      const reply = await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 });
      expect(reply).toMatchObject({ ok: true, panel: "lineage", lineage: value });
      const lines = (reply.lines as string[]).join("\n");
      expect(lines).not.toContain("Page complete.");
      expect(lines).not.toContain("Execution lineage (metadata only)");
      expect(reply.lines).toEqual(renderExecutionLineage(validateLineageReply(value)));
    }
    setReply({ ok: true, lineage: { ...page, truncated: true, cursor: "opaque_cursor" } });
    const truncated = await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7, cursor: "opaque_cursor" });
    expect(truncated.lineage).toMatchObject({ truncated: true, cursor: "opaque_cursor" });
    expect((truncated.lines as string[]).join("\n")).toContain("same root and bounds with --cursor opaque_cursor");
  });

  test("a selector the query does not name is dropped, never forwarded or read as authority", async () => {
    const { provider, requests } = fixture();
    expect((await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7, taskTitle: "private title", root: undefined })).ok).toBe(true);
    const { rid: _rid, ...sent } = requests[0] as Record<string, unknown>;
    expect(sent).toEqual({ t: "lineage_show", taskId: 7 });
    expect(sent).not.toHaveProperty("taskTitle");
    expect(sent).not.toHaveProperty("root");
    expect(sent).not.toHaveProperty("instanceId");
    expect(sent).not.toHaveProperty("panel");
  });

  test("an unknown project, a missing instance and a malformed reply are refused, never rendered", async () => {
    const { provider, requests, setReply } = fixture();
    expect(await provider.snapshot({ after: 0, panel: "lineage", projectId: "p9", instanceId: "i1", taskId: 7 })).toEqual({ ok: false, panel: "lineage", error: "unknown project" });
    expect(await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "", taskId: 7 })).toEqual({ ok: false, panel: "lineage", error: "expected daemon instance is required" });
    expect(requests).toEqual([]);
    setReply({ ok: false, error: "lineage read failed" });
    expect(await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 })).toEqual({ ok: false, panel: "lineage", error: "lineage read failed" });
    for (const value of [{ ...page, cursor: "cursor_on_complete" }, { ...page, truncated: true }, { state: "unavailable", hiddenCount: 1 },
      { state: "available", nodes: [], edges: [] }, { ...page, nodes: [{ ...page.nodes[0], body: "private payload" }] },
      { ...page, edges: [{ from: task, to: { ...task, tool: "ares", projectKey: "outside-project", kind: "output", id: "opaque-output" }, relation: "produced", strength: "host-observed" }] }]) {
      setReply({ ok: true, lineage: value });
      const refused = await provider.snapshot({ after: 0, panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 });
      expect(refused.ok).toBe(false);
      expect(String(refused.error)).toContain("unsupported shape");
      expect(refused).not.toHaveProperty("lineage");
      expect(refused).not.toHaveProperty("lines");
    }
  });
});

test("acon 0.2.0 loads the lineage read declaration and renders its route refusal (#1632)", async () => {
  const contract = import.meta.resolve("@staix/agent-console/contract");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", contract), "utf8"));
  expect(version).toBe("0.2.0");
  const { loadPlugins } = await import(new URL("./plugins.ts", contract).href);
  const { startServer } = await import(new URL("./server.ts", contract).href);
  const home = mkdtempSync(join(tmpdir(), "ahub-lineage-acon-"));
  dirs.push(home);
  const module = fileURLToPath(new URL("../src/ui/plugin.ts", import.meta.url));
  const sha256 = createHash("sha256").update(readFileSync(module)).digest("hex");
  const plugins = await loadPlugins({ dir: home, entries: [{ tool: "ahub", file: module, module, sha256, status: "verified" }] }, { home, log: () => {} });
  expect(plugins[0]?.status).toBe("ready");
  expect(plugins[0]?.manifest.capabilities).toMatchObject({ reads: ["lineage"] });
  const acon = startServer({ home, plugins, pluginsDir: home, version, log: () => {} });
  try {
    const headers = { "Content-Type": "application/json", Origin: acon.origin };
    const login = await fetch(acon.origin + "/session", { method: "POST", headers,
      body: JSON.stringify({ ticket: new URL(acon.issue()).hash.slice(1) }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")?.split(";")[0];
    expect(cookie).toBeDefined();
    await login.json();
    const refusal = await fetch(acon.origin + "/p/ahub/snapshot", { method: "POST",
      headers: { ...headers, Cookie: cookie! }, body: JSON.stringify({ panel: "lineage", projectId: "p1", instanceId: "i1", taskId: 7 }) });
    const data = await refusal.json();
    expect(refusal.status).toBe(400);
    expect(data).toEqual({ ok: false, error: "unknown panel" });

    // Exercise the pinned shell's actual failure renderer with the route response.
    const shell = await (await fetch(acon.origin + "/shell.js")).text();
    const from = shell.indexOf("async function pollPanel()");
    const end = shell.indexOf("// ---------- actions and confirm", from);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(from);
    const parts: string[] = [];
    const banner = { hidden: true, replaceChildren: (...nodes: string[]) => parts.push(...nodes) };
    const panel = { instance: {}, banner, gen: 0, cursor: 0, next: 0 };
    await runInNewContext(shell.slice(from, end) + "\npollPanel()", {
      state: { route: { area: "tool", tool: "ahub", panel: "lineage" }, panels: new Map([["ahub", panel]]) },
      document: { visibilityState: "visible" }, toolById: () => ({ title: "agent-hub" }),
      adaptivePollMs: () => 1000, post: async () => ({ status: refusal.status, data }),
      icon: () => "", h: (_tag: string, node: { text: string }) => node.text, hashFor: () => "#system",
    });
    expect(banner.hidden).toBe(false);
    expect(parts.join("")).toBe("agent-hub could not refresh. Details in System");
  } finally { await acon.stop(); }
});
