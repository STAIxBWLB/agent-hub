import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { taskProgress } from "../src/ui/task-progress.ts";
import { initialConsoleState, renderConsole } from "../src/cli/console-state.ts";
import { startDashboard } from "../src/hub/ui.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function setup() {
  let time = 1_000;
  const snapshots: number[] = [];
  const actions: Record<string, unknown>[] = [];
  const ui = startDashboard({
    now: () => time,
    snapshot: (after) => { snapshots.push(after); return { events: [{ text: "private-test-event" }], cursor: 42 }; },
    action: async (input) => {
      actions.push(input);
      if (input.type === "throw") throw new Error("private-backend-error");
      return { ok: true };
    },
  });
  cleanup.push(ui.stop);
  function post(path: string, body: unknown = {}, overrides: Record<string, string | null> = {}) {
    const headers = new Headers({ origin: ui.origin, "content-type": "application/json" });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    return fetch(`${ui.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function session() {
    const ticket = new URL(ui.issue()).hash.slice(1);
    const response = await post("/session", { ticket });
    expect(response.status).toBe(200);
    return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, response, ticket };
  }
  return { ui, post, session, snapshots, actions, advance: (ms: number) => { time += ms; } };
}

test("dashboard shell is static, data-free and protected by browser response headers", async () => {
  const { ui, snapshots, actions } = setup();
  const url = new URL(ui.issue());
  expect(url.origin).toBe(ui.origin);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.search).toBe("");
  expect(url.hash.slice(1)).toMatch(/^[a-f0-9]{64}$/);
  const response = await fetch(ui.origin);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain(url.hash.slice(1));
  expect(html).not.toContain("private-test-event");
  expect(html).not.toContain("control-token");
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  const csp = response.headers.get("content-security-policy")!;
  for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "sha256-"]) expect(csp).toContain(directive);
  expect(csp).not.toContain("unsafe-inline");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("ticket exchange creates a distinct HttpOnly Strict session and permits snapshot/action requests", async () => {
  const { post, session, snapshots, actions } = setup();
  const { cookie, response, ticket } = await session();
  const setCookie = response.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=3600"]) expect(setCookie).toContain(flag);
  expect(cookie).not.toContain(ticket);
  expect(await response.json()).toEqual({ ok: true });
  const snapshot = await post("/snapshot", { after: 7 }, { cookie });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toEqual({ events: [{ text: "private-test-event" }], cursor: 42 });
  expect(snapshots).toEqual([7]);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(200);
  expect(snapshots).toEqual([7, 0]);
  expect((await post("/action", { type: "pause", peer: "kimi" }, { cookie })).status).toBe(200);
  expect(actions).toEqual([{ type: "pause", peer: "kimi" }]);
  expect((await post("/session", { ticket })).status).toBe(401);
});

test("tickets expire at sixty seconds and sessions at one hour without sliding renewal", async () => {
  const { ui, post, session, advance } = setup();
  const old = new URL(ui.issue()).hash.slice(1);
  advance(60_000);
  expect((await post("/session", { ticket: old })).status).toBe(401);
  const { cookie } = await session();
  advance(3_599_999);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(200);
  advance(1);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(401);
  expect((await post("/action", {}, { cookie })).status).toBe(401);
  expect((await post("/snapshot")).status).toBe(401);
  expect((await post("/snapshot", {}, { cookie: "ahub_ui_fake=forged" })).status).toBe(401);
});

test("every endpoint enforces exact Host and every API enforces exact Origin before invoking callbacks", async () => {
  const { ui, post, session, snapshots, actions } = setup();
  const { cookie } = await session();
  const ticket = new URL(ui.issue()).hash.slice(1);
  for (const path of ["/session", "/snapshot", "/action"]) {
    for (const origin of [null, "null", "https://attacker.example", `${ui.origin}.attacker.example`, ui.origin.replace("127.0.0.1", "localhost")]) {
      const response = await post(path, { ticket }, { origin, cookie });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const host of ["attacker.example", new URL(ui.origin).host.replace("127.0.0.1", "localhost"), "127.0.0.1"]) {
      expect((await post(path, { ticket }, { host, cookie })).status).toBe(403);
    }
  }
  expect((await fetch(ui.origin, { headers: { host: "attacker.example" } })).status).toBe(403);
  expect((await fetch(ui.origin, { headers: { origin: "null" } })).status).toBe(403);
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
  // Rejected cross-origin requests must not consume a valid bootstrap ticket.
  expect((await post("/session", { ticket })).status).toBe(200);
});

test("API rejects wrong methods, types, malformed objects, invalid cursors and unknown paths", async () => {
  const { ui, post, session, snapshots, actions } = setup();
  const { cookie } = await session();
  for (const path of ["/session", "/snapshot", "/action"]) {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const response = await fetch(`${ui.origin}${path}`, { method, headers: { origin: ui.origin, cookie } });
      expect(response.status).toBe(405);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded"]) expect((await post(path, {}, { cookie, "content-type": type })).status).toBe(415);
    for (const body of [null, [], "hello", 5, true]) expect((await post(path, body, { cookie })).status).toBe(400);
    expect((await fetch(`${ui.origin}${path}`, { method: "POST", headers: { origin: ui.origin, cookie, "content-type": "application/json" }, body: "{" })).status).toBe(400);
  }
  for (const after of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect((await post("/snapshot", { after }, { cookie })).status).toBe(400);
  expect((await post("/unknown", {}, { cookie })).status).toBe(404);
  for (const path of ["/src/cli/main.ts", "/.agenthub/state/control-token", "/index.html"]) expect((await fetch(`${ui.origin}${path}`)).ok).toBe(false);
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
});

test("requests without Host are rejected even when Origin and session are valid", async () => {
  const { ui, session, snapshots, actions } = setup();
  const { cookie } = await session();
  for (const path of ["/session", "/snapshot", "/action"]) {
    const response = await new Promise<string>((resolve, reject) => {
      let raw = "";
      const socket = connect(Number(new URL(ui.origin).port), "127.0.0.1", () => {
        socket.write(`POST ${path} HTTP/1.1\r\nOrigin: ${ui.origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP response timed out")));
      socket.on("data", (chunk) => { raw += chunk.toString(); });
      socket.on("end", () => resolve(raw));
      socket.on("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 (400|403) /);
    expect(response).not.toContain("Set-Cookie:");
  }
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
});

test("action errors never disclose backend text and stopped listeners lose their credentials", async () => {
  const { ui, post, session } = setup();
  const { cookie } = await session();
  const response = await post("/action", { type: "throw" }, { cookie });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("private-backend-error");
  ui.stop();
  await expect(fetch(ui.origin)).rejects.toThrow();
});

test("oversized API bodies are rejected before the action callback", async () => {
  const { post, session, actions } = setup();
  const { cookie } = await session();
  const response = await post("/action", { type: "message", body: "x".repeat(40 * 1024) }, { cookie });
  expect(response.ok).toBe(false);
  expect(actions).toEqual([]);
});

test("manager project route and async scoped snapshots preserve project context", async () => {
  const calls: { after: number; input?: Record<string, unknown> }[] = [];
  const ui = startDashboard({
    projects: async () => ({ ok: true, mode: "all", projects: [{ id: "p1", root: "/tmp/one", state: "running", instanceId: "i1" }] }),
    snapshot: async (after, input) => { calls.push({ after, input }); await Promise.resolve(); return { events: [], cursor: after + 1, projectId: "p1", instanceId: "i1" }; },
    action: async () => ({ ok: true }),
  });
  cleanup.push(ui.stop);
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${ui.origin}${path}`, { method: "POST", headers: { origin: ui.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const ticket = new URL(ui.issue()).hash.slice(1);
  const session = await post("/session", { ticket });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  expect(await (await post("/projects", {}, cookie)).json()).toMatchObject({ mode: "all", projects: [{ id: "p1" }] });
  const response = await post("/snapshot", { after: 4, projectId: "p1", instanceId: "i1" }, cookie);
  expect(await response.json()).toMatchObject({ cursor: 5, projectId: "p1", instanceId: "i1" });
  expect(calls).toEqual([{ after: 4, input: { after: 4, projectId: "p1", instanceId: "i1" } }]);
});

test("local project route remains available without a manager callback", async () => {
  const { post, session } = setup();
  const { cookie } = await session();
  expect(await (await post("/projects", {}, { cookie })).json()).toEqual({ ok: true, mode: "project" });
});

test("snapshot rejects a backend identity that disagrees with the requested project", async () => {
  const ui = startDashboard({ snapshot: async () => ({ status: {}, events: [], cursor: 0, projectId: "authoritative", instanceId: "i1" }), action: async () => ({ ok: true }) });
  cleanup.push(ui.stop);
  const post = (body: unknown, cookie: string) => fetch(`${ui.origin}/snapshot`, { method: "POST", headers: { origin: ui.origin, "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const ticket = new URL(ui.issue()).hash.slice(1);
  const session = await fetch(`${ui.origin}/session`, { method: "POST", headers: { origin: ui.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  expect((await post({ after: 0, projectId: "requested", instanceId: "i1" }, cookie)).status).toBe(409);
});


test("shared public progress executes in the hashed dashboard and matches console counts/stages", async () => {
  const { ui } = setup(); const response = await fetch(ui.origin); const html = await response.text();
  const model = html.match(/const taskProgress = ([\s\S]*?);\nconst themeControl/)?.[1];
  expect(model).toBeDefined();
  const browserModel = runInNewContext("(" + model + ")");
  const board = [{ id: 1, state: "approved" as const, title: "[pii]" }, { id: 2, state: "proposed" as const, deps: [1], title: "ready" }, { id: 3, state: "proposed" as const, deps: [4], title: "waiting" }, { id: 4, state: "in_progress" as const, title: "working" }, { id: 5, state: "in_review" as const, title: "review" }, { id: 6, state: "changes_requested" as const, title: "changes" }, { id: 7, state: "approved" as const, title: "done" }];
  const progress = JSON.parse(JSON.stringify(browserModel(board)));
  expect(progress).toEqual(taskProgress(board));
  const s = initialConsoleState(true); s.panel = 3; s.tasks = board;
  const summary = renderConsole(s, 200, 60)[2]!;
  expect(summary).toContain("2/7 approved");
  for (const [state, count] of Object.entries(progress.counts)) if (state !== "approved") expect(summary).toContain(`${state.replaceAll("_", " ").replace("in review", "review").replace("changes requested", "changes")} ${count}`);
  class Node {
    children: Node[] = []; textContent = ""; className = ""; attrs: Record<string, string> = {};
    append(...nodes: Node[]) { this.children.push(...nodes); }
    mutations = 0;
    replaceChildren() { this.children = []; this.mutations++; }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
  }
  const target = new Node();
  const document = { createElement: () => new Node(), createElementNS: () => new Node() };
  const consumers = html.slice(html.indexOf("function renderTaskProgress("), html.indexOf("function render(snapshot)"));
  const updateStart = html.indexOf("function update("); const updateSource = html.slice(updateStart, html.indexOf("\n", updateStart));
  const renderers = runInNewContext(`const $ = () => target; const el = (tag,text,cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); node.className = cls || ''; return node; }; const signatures=new Map(); ${updateSource} ${consumers}; ({renderTaskProgress,renderTaskStage})`, { document, target });
  renderers.renderTaskProgress(progress);
  expect(target.children[0]?.textContent).toBe("2/7 approved (28%)");
  expect(target.children[2]?.textContent).toContain("waiting 1");
  expect(renderers.renderTaskStage(progress.stages[5]).attrs["aria-label"]).toBeUndefined();
  expect(renderers.renderTaskStage(progress.stages[5]).children.at(-1).textContent).toContain("Stage 2/4: changes requested (back in progress)");
  expect(target.children[1]?.attrs.preserveAspectRatio).toBe("none"); expect(target.children[1]?.attrs["aria-hidden"]).toBe("true");
  const rectangles = target.children[1]!.children;
  expect(rectangles).toHaveLength(6);
  let expectedX = 0;
  for (const [index, count] of Object.values(progress.counts).entries()) {
    const width = Number(count) / progress.total * 100;
    expect(Number(rectangles[index]?.attrs.x)).toBeCloseTo(expectedX); expect(Number(rectangles[index]?.attrs.width)).toBeCloseTo(width); expectedX += width;
  }
  expect(expectedX).toBeCloseTo(100);
  const mutations = target.mutations; renderers.renderTaskProgress(JSON.parse(JSON.stringify(progress))); expect(target.mutations).toBe(mutations);
  const nodes = new Map<string, Node>(); const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  get('task-progress').append(new Node());
  const reset = html.slice(html.indexOf('function resetView('), html.indexOf('function projectName('));
  runInNewContext(`let selectedProjectId='',selectedInstanceId='',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false; const managerMode=true; const signatures=new Map(); const $=get; const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{}; const empty=(node,text)=>{node.textContent=text}; ${reset}; resetView('next','instance');`, { get });
  expect(get('task-progress').children).toHaveLength(0); expect(get('task-progress').textContent).toBe('No project selected.');
  renderers.renderTaskProgress(browserModel([]));
  expect(target.children[0]?.textContent).toBe("0/0 approved (0%)");
  renderers.renderTaskProgress(browserModel(Array.from({ length: 100 }, (_, id) => ({ id, state: id < 29 ? 'approved' : 'proposed' }))));
  expect(target.children[0]?.textContent).toBe('29/100 approved (29%)');
  expect(Math.floor((29 / 100) * 100)).toBe(28); // confirms why rounded binary ratios must not drive the percentage
  expect(html).toContain("renderTaskProgress(progress)");
  const blocks = [...html.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)]; expect(blocks).toHaveLength(3);
  for (const match of blocks) expect(response.headers.get("content-security-policy")).toContain(createHash("sha256").update(match[2]!).digest("base64"));
  expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
});
test("theme preference initializes before style/paint, persists choices and tolerates blocked cookie access", async () => {
  const { ui } = setup(); const html = await (await fetch(ui.origin)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  expect(html.indexOf(script!)).toBeLessThan(html.indexOf("<style>"));
  for (const saved of ["system", "light", "dark", "invalid"]) {
    let cookie = 'other=1; agent-hub-theme=' + saved; const values: string[] = []; const root = { dataset: {} as Record<string, string> };
    const document = { documentElement: root, get cookie() { return cookie; }, set cookie(value: string) { values.push(value); cookie = value; } };
    const theme = runInNewContext(script + ";dashboardTheme", { document });
    expect(root.dataset.theme).toBe(saved === "invalid" ? "system" : saved);
    theme.set("dark"); expect(root.dataset.theme).toBe("dark"); expect(values[0]).toBe("agent-hub-theme=dark; Path=/; Max-Age=31536000; SameSite=Strict");
    const otherPort = { dataset: {} as Record<string, string> };
    runInNewContext(script + ";dashboardTheme", { document: { documentElement: otherPort, cookie } }); expect(otherPort.dataset.theme).toBe("dark");
  }
  const root = { dataset: {} as Record<string, string> };
  const theme = runInNewContext(script + ";dashboardTheme", { document: { documentElement: root, get cookie() { throw new Error("blocked"); }, set cookie(_value: string) { throw new Error("blocked"); } } });
  expect(root.dataset.theme).toBe("system"); expect(() => theme.set("light")).not.toThrow();
  expect(html).not.toContain("localStorage");
  expect(html).toContain('.progress-waiting{fill:var(--waiting)}');
  expect(html).toContain(':root[data-theme="dark"]');
  expect(html).toContain(':root:not([data-theme="light"]):not([data-theme="dark"])');
  expect(html).toContain('@media(prefers-color-scheme:dark)');
});

test("shared model injection treats dollar replacement patterns as literal source text", async () => {
  const original = taskProgress.toString;
  taskProgress.toString = () => original.call(taskProgress) + '\n/* $& */';
  try {
    const { ui } = setup(); const html = await (await fetch(ui.origin)).text();
    expect(html).toContain('/* $& */');
  } finally { taskProgress.toString = original; }
});
