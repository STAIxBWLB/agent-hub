/**
 * acon console plugin for agent-hub (#935, plan entelecheia/ai-workspace#60 §2.5).
 *
 * D1: the provider lifts the manager's project listing and forwarding (`projectConsole` in src/hub/manager.ts):
 * Registry + ControlClient.connect(stateDir, {role: "console"}) -> ui_snapshot / ui_action. It adds no protocol and
 * no action: every action is checked against the manager's own whitelist, and every view against DASHBOARD_VIEWS.
 * D2: the panel is the `ahub ui` dashboard itself, built from renderDashboard(), with post() routed to the host.
 *
 * Contract: @staix/agent-console api 1, declared structurally below so agent-hub keeps zero runtime dependencies.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Registry } from "../hub/registry.ts";
import { projectConsole, type Lifecycle } from "../hub/manager.ts";
// lifecycle.ts reaches the whole daemon; it is imported only when a project is inspected, started or stopped.
import { DASHBOARD_VIEWS, renderDashboard } from "../hub/ui.ts";
import { VERSION as version } from "../version.ts";

type Tone = "ok" | "warn" | "err" | "neutral";
interface InboxItem {
  id: string; group: "decision" | "review" | "candidate" | "alert"; kind: string; title: string; detail?: string; actor?: string; project?: string;
  at: string; chip?: { text: string; tone: Tone };
  verbs: { id: string; label: string; primary?: boolean; destructive?: boolean; reason?: "optional" | "required" }[];
  link: { panel: string; params?: Record<string, string> };
}
type ActionResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; unconfirmed?: true }
  | { ok: false; needsConfirm: true; preview: string[]; fingerprint: string; verb?: string; warnings?: string[] };
export interface ConsoleProvider {
  assets: { js: string; css?: string };
  snapshot(input: { after: number; panel: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Record<string, unknown>): Promise<ActionResult>;
  close?(): Promise<void>;
}
export interface ConsolePlugin {
  manifest: {
    api: 1; tool: string; version: string; title: string; icon?: string; pollMs?: number;
    panels: { id: string; title: string; order?: number }[];
    capabilities?: { actions?: string[]; confirm?: boolean; multiProject?: boolean; inbox?: boolean };
  };
  open(ctx: { home: string; log(line: string): void }): Promise<ConsoleProvider>;
}

const TITLES: Record<(typeof DASHBOARD_VIEWS)[number], string> = { board: "Board", office: "Office", stream: "Stream", agents: "Agents", message: "Message", memory: "Memory", settings: "Settings" };
/** The dashboard's own actions plus the inbox verbs; the manager whitelist is still applied to each forwarded call. */
const FORWARDED = ["start", "stop", "send", "pause", "resume", "permit", "propose", "assign", "backlog_pull", "backlog_return", "planning", "planning_undo", "planner_pull", "backlog_split", "release_new", "release_change", "setting", "setting_undo", "setting_preview", "setting_reload", "config_edit_preview", "config_edit_apply", "start_peer", "sdlc_queue", "sdlc_release"] as const;
const INBOX_VERBS = ["approve", "deny", "open"] as const;
/** Outward or destructive: answered needsConfirm first (agent-console AGENTS.md); previews are read-only and stay direct. */
const CONFIRMED = new Set(["stop", "permit", "setting", "setting_undo", "setting_reload", "config_edit_apply", "start_peer", "backlog_split", "send", "approve", "deny"]);
const fingerprintOf = (input: Record<string, unknown>) => {
  const { confirmed: _c, fingerprint: _f, reason: _r, ...rest } = input;
  return createHash("sha256").update(JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]))).digest("hex");
};

/** The `ahub ui` dashboard as an acon panel module. Each rewrite must match exactly once, so drift fails loudly. */
export function panelAssets(): { js: string; css: string } {
  const { styles, markup, script } = renderDashboard();
  const swap = (source: string, from: string, to: string) => {
    const at = source.indexOf(from);
    if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`acon panel: expected exactly one ${JSON.stringify(from.slice(0, 60))}`);
    return source.slice(0, at) + to + source.slice(at + from.length);
  };
  let body = script;
  // Preferences stay in the panel's memory: the shell's origin has its own cookies and storage.
  body = swap(body, "  get: (name, fallback = '') => { try { return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? fallback; } catch { return fallback; } },\n  set: (name, value) => { try { document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch {} }",
    "  get: (name, fallback = '') => prefs.has(name) ? prefs.get(name) : fallback,\n  set: (name, value) => { prefs.set(name, value); }");
  body = body.replaceAll("document.getElementById(", () => "$$(");
  // The shell owns the URL, cookies-free state and its own theme; the panel never touches history or the page theme.
  body = swap(body, "let ticket = location.hash.slice(1);\nhistory.replaceState(null, '', location.pathname);", "let ticket = '';");
  body = swap(body, "const apply = () => { document.documentElement.dataset.theme = choice; };", "const apply = () => {};");
  body = swap(body, "const $ = (id) => $$(id);", "const $ = $$;");
  // post() goes to the host: /projects is the manager listing, /snapshot and /action are the plugin's panel calls.
  body = swap(body, "async function post(path, body) {\n  const response = await fetch(path, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});\n  if (response.status === 401) { expire(); throw new Error('Run ahub ui to start a new session.'); }\n  const result = await response.json();",
    "async function post(path, body) {\n  const result = path === '/projects' ? await host.snapshot({ panel: 'board' }) : path === '/snapshot' ? await host.snapshot({ ...body, panel: 'board' }) : await host.action(body);\n  if (!result) { expire(); throw new Error('The console session ended.'); }\n  const response = { ok: result.ok !== false, status: 200 };");
  // Polling stops with the panel; the shell keeps its own clock.
  body = swap(body, "function expire() { stopped = true;", "function expire() { stopped = true; host.toast?.('The agent-hub panel stopped. Reload the console to reconnect.');");
  body = body.replaceAll("document.querySelectorAll(", "root.querySelectorAll(");
  // The view keys listen inside the panel only (the shell owns global keys), and the page title belongs to the shell.
  body = swap(body, "document.addEventListener('keydown', dashboardKey);", "root.addEventListener('keydown', dashboardKey);");
  body = swap(body, "if(document.title!==title)document.title=title;", "");
  // An inbox link names the project that owns the item; the next project refresh selects it.
  body = swap(body, "if (!selectedProjectId && typeof result.selectedProjectId === 'string') selectedProjectId = result.selectedProjectId;",
    "if (wantProject && projectList.some((p) => p && p.id === wantProject)) selectedProjectId = wantProject;\n    else if (!selectedProjectId && typeof result.selectedProjectId === 'string') selectedProjectId = result.selectedProjectId;\n    wantProject = '';");
  // The shell owns the page's landmarks and the view tabs (its panel tabs are DASHBOARD_VIEWS): the panel's <main>,
  // <header> and <footer> become plain blocks marked by class, and its own view nav is hidden.
  body = body.replaceAll("'main section[data-view]'", () => "'.ahub-main section[data-view]'").replaceAll("'main > .stack'", () => "'.ahub-main > .stack'");
  // The skip link targets the shell's page; inside a panel it would jump nowhere.
  const panelMarkup = markup.replace('<a class="skip-link" href="#main-content">Skip to content</a>', "")
    .replace('<main id="main-content" tabindex="-1">', '<div id="main-content" class="ahub-main">').replace("</main>", "</div>")
    .replace('<header class="topbar">', '<div class="topbar">').replace(/<\/header>/, "</div>")
    .replace("<footer>", '<div class="ahub-footer">').replace("</footer>", "</div>");
  if (/<(main|header|footer)\b/.test(panelMarkup)) throw new Error("acon panel: a landmark element remained in the dashboard markup");
  // Scope every rule to the panel root so the dashboard's base styles never reach the shell around it.
  const css = [...styles.map((style) => `.ahub-panel{\n${style.replaceAll(":root", "&").replace(/(^|})\s*\*\{/g, "$1 *{").replace(/(^|[}\s])body\{/g, "$1&{")
    .replace(/(^|[\s{};,>])main(?=[\s{:>[])/g, "$1.ahub-main").replace(/(^|[\s{};,>])footer(?=[\s{:>[])/g, "$1.ahub-footer")}\n}`),
  // Last, so they win over the scoped dashboard rules: acon's panel tabs replace the view nav, and the shell owns the theme.
  `.ahub-panel #dashboard-nav.view-nav,.ahub-panel .topbar .theme-field,.ahub-panel .topbar .brand{display:none}
.ahub-panel .shell.shell{min-height:0;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
.ahub-panel .shell .shell-body{grid-column:1}
.ahub-panel .shell .ahub-main{grid-row:2}`].join("\n");
  const js = `// agent-hub dashboard as an acon panel (#935). Generated from src/ui/index.html; do not edit.
export default (host) => {
  const root = host.ui.h("div", { class: "ahub-panel" });
  // The panel follows the console's theme; the dashboard's own theme control is hidden (see panel.css).
  const followTheme = (theme) => { root.dataset.theme = theme?.mode === "dark" ? "dark" : "light"; };
  followTheme(host.theme); host.onTheme?.(followTheme);
  const prefs = new Map();
  const $$ = (id) => root.querySelector('#' + CSS.escape(id));
  host.mount.append(root);
  const template = new DOMParser().parseFromString(${JSON.stringify(`<body>${panelMarkup}</body>`)}, "text/html");
  root.append(...template.body.childNodes);
  let started = false, stop = () => {}, wantProject = '', pickProject = () => {};
  const start = () => {
    if (started) return; started = true;
    stop = (() => {
${body}
      pickProject = () => { clearTimeout(projectsTimer); void refreshProjects(); };
      return () => { stopped = true; clearTimeout(timer); clearTimeout(projectsTimer); };
    })();
  };
  return {
    show(panel, params) {
      if (typeof params?.project === "string" && params.project) { wantProject = params.project; if (started) pickProject(); }
      start(); if (${JSON.stringify(DASHBOARD_VIEWS)}.includes(panel)) switchViewFromHost(panel); },
    hide() {},
    destroy() { stop(); root.remove(); },
  };
  function switchViewFromHost(panel) { root.querySelector('button[data-view-target="' + panel + '"]')?.click(); }
};
`;
  return { js, css };
}

interface ProjectRow { id: string; root: string; state: string; instanceId: string | null }

/** lifecycle.ts reaches the whole daemon (and files acon's import scan cannot parse); load it on first use only. */
function lazyLifecycle(): Lifecycle {
  const load = () => import("../hub/lifecycle.ts");
  return {
    inspectProject: async (project) => (await load()).inspectProject(project),
    startProject: async (project, options) => (await load()).startProject(project, options),
    stopProject: async (project, expected) => (await load()).stopProject(project, expected),
  };
}

/** Build the provider over an injectable registry and lifecycle (tests use a temp home and fakes). */
export function createProvider(options: { home: string; registry?: Registry; lifecycle?: Lifecycle; log?: (line: string) => void }): ConsoleProvider {
  const registry = options.registry ?? new Registry(join(options.home, "registry.db"));
  const owned = !options.registry;
  const lifecycle = options.lifecycle ?? lazyLifecycle();
  const { list, act } = projectConsole({ registry, lifecycle, home: options.home });
  const assets = panelAssets();
  const seen = new Map<string, string>(); // inbox item id -> first-seen ISO time, so `at` stays stable

  async function running(): Promise<ProjectRow[]> {
    const listing = await list() as { projects: ProjectRow[] };
    return listing.projects.filter((p) => p.state === "running" && p.instanceId);
  }
  async function inbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const project of await running()) {
      const snap = await act({ action: "snapshot", after: 0, projectId: project.id, instanceId: project.instanceId, view: "agents" }) as Record<string, unknown>;
      if (snap.ok === false) continue;
      const name = project.root.split("/").filter(Boolean).pop() ?? project.id;
      for (const p of (snap.permissions as { id: string; peer: string; title: string; createdAt?: number; terminalOnly?: boolean; options: { optionId: string; kind: string; name: string }[] }[] | undefined) ?? []) {
        const id = `perm:${project.id}:${p.id}`;
        const at = typeof p.createdAt === "number" ? new Date(p.createdAt).toISOString() : (seen.get(id) ?? new Date().toISOString());
        seen.set(id, at);
        const allow = !p.terminalOnly && p.options.some((o) => o.kind === "allow_once");
        const deny = p.options.some((o) => o.kind === "reject_once");
        items.push({ id, group: "decision", kind: "approval", title: `${p.peer}: ${p.title}`.slice(0, 200), actor: p.peer, project: name, at,
          chip: { text: "approval", tone: "warn" },
          verbs: [...(allow ? [{ id: "approve", label: "Allow once", primary: true }] : []), ...(deny ? [{ id: "deny", label: "Deny", destructive: true }] : [])],
          link: { panel: "agents", params: { project: project.id } } });
      }
      for (const t of (snap.tasks as { id: number; title: string; state: string; reviewer: string | null; owner: string | null }[] | undefined) ?? []) {
        if (t.state !== "in_review" || t.reviewer !== "user") continue;
        const id = `review:${project.id}:${t.id}`;
        const at = seen.get(id) ?? new Date().toISOString();
        seen.set(id, at);
        items.push({ id, group: "review", kind: "review", title: `#${t.id} ${t.title}`.slice(0, 200), ...(t.owner ? { actor: t.owner } : {}), project: name, at,
          chip: { text: "review", tone: "neutral" }, verbs: [{ id: "open", label: "Open board", primary: true }], link: { panel: "board", params: { project: project.id } } });
      }
    }
    // Forget ids that left the inbox, so `seen` stays the size of what is waiting now.
    const current = new Set(items.map((item) => item.id));
    for (const id of seen.keys()) if (!current.has(id)) seen.delete(id);
    return items;
  }

  /** approve/deny resolve to the hub's own `permit` with the request's option; nothing else is reachable from an item. */
  async function inboxVerb(input: Record<string, unknown>): Promise<ActionResult> {
    const m = typeof input.id === "string" ? /^perm:([^:]+):(.+)$/.exec(input.id) : null;
    if (input.action === "open") return { ok: true, message: "Open the Board panel to review." };
    if (!m) return { ok: false, error: "unknown inbox item" };
    const project = (await running()).find((p) => p.id === m[1]);
    if (!project) return { ok: false, error: "project is not running" };
    const snap = await act({ action: "snapshot", after: 0, projectId: project.id, instanceId: project.instanceId, view: "agents" }) as Record<string, unknown>;
    const request = ((snap.permissions as { id: string; terminalOnly?: boolean; options: { optionId: string; kind: string }[] }[] | undefined) ?? []).find((p) => p.id === m[2]);
    if (!request) return { ok: false, error: "permission expired or already answered" };
    const kind = input.action === "approve" ? "allow_once" : "reject_once";
    if (kind === "allow_once" && request.terminalOnly) return { ok: false, error: "answer this approval with ahub permit" };
    const option = request.options.find((o) => o.kind === kind);
    if (!option) return { ok: false, error: "that answer is not offered for this approval" };
    const result = await act({ action: "permit", projectId: project.id, instanceId: project.instanceId, id: request.id, option: option.optionId }) as Record<string, unknown>;
    return result.ok === true ? { ok: true, message: input.action === "approve" ? "Allowed once" : "Denied" } : { ok: false, error: String(result.error ?? "permit failed") };
  }

  return {
    assets,
    async snapshot(input) {
      if (input.panel === "inbox") return { items: await inbox() };
      const view = (DASHBOARD_VIEWS as readonly string[]).includes(String(input.view)) ? input.view : (DASHBOARD_VIEWS as readonly string[]).includes(input.panel) ? input.panel : undefined;
      if (typeof input.projectId !== "string" || typeof input.instanceId !== "string") {
        // A bare panel poll (the shell's own, and conformance) gets the listing; the dashboard polls with a project.
        // With exactly one running project the board opens on it, as `ahub ui` does inside a project.
        const listing = await list() as { projects: ProjectRow[] } & Record<string, unknown>;
        const live = listing.projects.filter((p) => p.state === "running");
        return { ...listing, ...(live.length === 1 ? { selectedProjectId: live[0]!.id } : {}), panel: input.panel };
      }
      const { panel: _panel, ...rest } = input;
      return await act({ ...rest, action: "snapshot", ...(view ? { view } : {}) }) as Record<string, unknown>;
    },
    async action(input) {
      const name = String(input.action);
      if (![...FORWARDED, ...INBOX_VERBS].includes(name as never)) return { ok: false, error: "unknown action" };
      const fingerprint = fingerprintOf(input);
      if (CONFIRMED.has(name) && !(input.confirmed === true && input.fingerprint === fingerprint)) {
        const target = typeof input.projectId === "string" ? registry.get(input.projectId)?.root.split("/").filter(Boolean).pop() : undefined;
        const preview = name === "approve" || name === "deny" ? [`${name === "approve" ? "Allow" : "Deny"} this tool request once.`]
          : name === "send" ? [`Send a message as you${target ? ` in ${target}` : ""}.`]
          : [`Run ${name}${target ? ` in ${target}` : ""}.`];
        return { ok: false, needsConfirm: true, preview, fingerprint, verb: name === "approve" ? "Allow once" : name === "deny" ? "Deny" : name };
      }
      const { confirmed: _c, fingerprint: _f, ...forward } = input;
      if (name === "approve" || name === "deny" || name === "open") return await inboxVerb(forward);
      const result = await act(forward) as Record<string, unknown>;
      return (result.ok === false ? { ok: false, error: String(result.error ?? "action failed"), ...(result.unconfirmed === true ? { unconfirmed: true as const } : {}) } : { ...result, ok: true }) as ActionResult;
    },
    async close() { if (owned) registry.close(); },
  };
}

const plugin: ConsolePlugin = {
  manifest: {
    api: 1, tool: "ahub", version, title: "agent-hub", icon: "agents", pollMs: 3000,
    panels: DASHBOARD_VIEWS.map((id, order) => ({ id, title: TITLES[id], order })),
    capabilities: { actions: [...FORWARDED, ...INBOX_VERBS], confirm: true, multiProject: true, inbox: true },
  },
  async open(ctx) { return createProvider({ home: ctx.home, log: ctx.log }); },
};
export default plugin;
