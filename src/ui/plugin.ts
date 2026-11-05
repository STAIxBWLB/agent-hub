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
import type { ActionMeta } from "@staix/agent-console/contract";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Registry } from "../hub/registry.ts";
import { projectConsole, type Lifecycle, type ManagerOptions } from "../hub/manager.ts";
// lifecycle.ts reaches the whole daemon; it is imported only when a project is inspected, started or stopped.
import { DASHBOARD_VIEWS, renderDashboard } from "../hub/ui.ts";
import { officeModel, type OfficeScene } from "./office-model.ts";
import { personEvidence, questionItem, QUESTION_ITEM, type InboxAnswers, type QuestionRowView } from "./plugin-questions.ts";
import { canPublishResults, receiptEvidence, resultItem, RESULT_ACTIONS, RESULT_ITEM, type ResultAction, type ResultRowView } from "./plugin-results.ts";
import { mergeSpaces, officeSpace } from "./office-space.ts";
import { VERSION as version } from "../version.ts";

type Tone = "ok" | "warn" | "err" | "neutral";
interface InboxItem {
  id: string; group: "decision" | "review" | "result" | "candidate" | "alert"; kind: string; title: string; detail?: string; actor?: string; project?: string;
  at: string; chip?: { text: string; tone: Tone };
  verbs: { id: string; label: string; primary?: boolean; destructive?: boolean; reason?: "optional" | "required" }[];
  link: { panel: string; params?: Record<string, string> };
  /** #1054: a `result` item carries the action acon runs once the person has seen it. */
  seen?: { action: string };
}
type ActionResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; unconfirmed?: true }
  | { ok: false; needsConfirm: true; preview: string[]; fingerprint: string; verb?: string; warnings?: string[] };
export interface ConsoleProvider {
  assets: { js: string; css?: string };
  snapshot(input: { after: number; panel: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Record<string, unknown>, meta?: ActionMeta): Promise<ActionResult>;
  close?(): Promise<void>;
}
export interface ConsolePlugin {
  manifest: {
    api: 1; tool: string; version: string; title: string; icon?: string; pollMs?: number;
    panels: { id: string; title: string; order?: number }[];
    capabilities?: { actions?: string[]; confirm?: boolean; multiProject?: boolean; inbox?: boolean; space?: boolean };
  };
  open(ctx: { home: string; log(line: string): void; features?: readonly string[] }): Promise<ConsoleProvider>;
}

const TITLES: Record<(typeof DASHBOARD_VIEWS)[number], string> = { board: "Board", office: "Office", stream: "Stream", agents: "Agents", message: "Message", memory: "Memory", settings: "Settings" };
/** The dashboard's own actions plus the inbox verbs; the manager whitelist is still applied to each forwarded call. */
const FORWARDED = ["start", "stop", "send", "pause", "resume", "permit", "propose", "intake", "assign", "backlog_pull", "backlog_return", "planning", "planning_undo", "planner_pull", "backlog_split", "release_new", "release_change", "setting", "setting_undo", "setting_preview", "setting_reload", "config_edit_preview", "config_edit_apply", "start_peer", "sdlc_queue", "sdlc_release", "worktree_override_set", "worktree_override_clear", "worktrees_refresh_prs"] as const;
/** Advertised so acon lets the page send it, never forwarded: `action()` answers it through its own port (`answerVerb`), after the console's person meta is checked (#1053 T5). */
const QUESTION_ACTIONS = ["answer"] as const;
/** #1054 T6: the receipt actions, advertised so acon lets the inbox and the page send them, never forwarded: `action()` checks the console's person meta, then calls the dedicated `projectConsole(...).receipt` port (`receiptVerb`). */
const RESULT_ADVERTISED = RESULT_ACTIONS;
const REVIEW_ACTIONS = ["review_comment_put", "review_comment_delete", "review_comment_send"] as const;
const INBOX_VERBS = ["approve", "deny", "open"] as const;
/** Outward or destructive: answered needsConfirm first (agent-console AGENTS.md); previews are read-only and stay direct. */
const CONFIRMED = new Set(["review_comment_delete", "review_comment_send", "stop", "permit", "setting", "setting_undo", "setting_reload", "config_edit_apply", "start_peer", "backlog_split", "send", "approve", "deny", "worktree_override_set", "worktrees_refresh_prs"]);
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
  body = swap(body, "const reviewKit = null;", "const reviewKit = typeof host.ui.review === 'function' ? {render:host.ui.review.bind(host.ui),snapshot:input=>host.snapshot(input)} : null;");
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
/** #727: the inbox reply is bounded; `more` counts what was left out. Most urgent first: a decision waits on the person, then a review, a result, a candidate, an alert. */
const INBOX_MAX_ITEMS = 50;
const INBOX_GROUP_RANK: Record<InboxItem["group"], number> = { decision: 0, review: 1, result: 2, candidate: 3, alert: 4 };
interface InboxReply { items: InboxItem[]; more: number }

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
export function createProvider(options: { home: string; registry?: Registry; lifecycle?: Lifecycle; log?: (line: string) => void; spaceBudgetMs?: number; features?: readonly string[]; forwardTimeoutMs?: ManagerOptions["forwardTimeoutMs"]; inboxFreshMs?: number; inboxStaleMs?: number; inboxProjectBudgetMs?: number }): ConsoleProvider {
  const registry = options.registry ?? new Registry(join(options.home, "registry.db"));
  const owned = !options.registry;
  const lifecycle = options.lifecycle ?? lazyLifecycle();
  const { list, act, answer, receipt, consoleControl } = projectConsole({ registry, lifecycle, home: options.home, forwardTimeoutMs: options.forwardTimeoutMs });
  const assets = panelAssets();
  const seen = new Map<string, string>(); // inbox item id -> first-seen ISO time, so `at` stays stable

  async function running(): Promise<ProjectRow[]> {
    const listing = await list() as { projects: ProjectRow[] };
    return listing.projects.filter((p) => p.state === "running" && p.instanceId);
  }
  /**
   * #727: one project's items from its last answer, reused for a project that did not answer in time, so a slow daemon neither blanks its rows nor restarts their `at`.
   * Fenced by the action generation on both sides: an entry is written only by a computation that no action has overtaken, and read only in the generation it was written in, so an approval
   * or an answer that has been given never comes back from here (a late project is then simply left out of that poll, which is the safe side).
   */
  const lastProjectItems = new Map<string, { generation: number; items: InboxItem[] }>();
  /** The project's `agents` snapshot, or null when it did not answer within the budget or threw: the other projects' rows are never held back by it. */
  /**
   * #1196 follow-up: a project's `agents` snapshot still running past its budget is reused by the next poll instead of asking that daemon again, so a slow daemon gets one question at a time.
   * Reuse stays within one action generation: a question asked before an approval or an answer never answers a poll made after it.
   */
  const projectFlight = new Map<string, { generation: number; work: Promise<Record<string, unknown>> }>();
  const projectSnapshot = (project: ProjectRow) => {
    let flight = projectFlight.get(project.id);
    if (!flight || flight.generation !== inboxGeneration) {
      const work = act({ action: "snapshot", after: 0, projectId: project.id, instanceId: project.instanceId, view: "agents" }) as Promise<Record<string, unknown>>;
      const entry = { generation: inboxGeneration, work };
      flight = entry;
      projectFlight.set(project.id, entry);
      work.finally(() => { if (projectFlight.get(project.id) === entry) projectFlight.delete(project.id); }).catch(() => {});
    }
    return within(flight.work, INBOX_PROJECT_BUDGET_MS);
  };
  async function inbox(generation: number): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    // #1196 follow-up: the listing asks every daemon for its status, so it gets the project budget and falls back to the last listing, as space() does.
    const listing = running().then((rows) => { lastRunning = rows; return rows; }, () => lastRunning);
    const projects = await within(listing, INBOX_PROJECT_BUDGET_MS) ?? lastRunning;
    // The projects are asked at once: the answer takes as long as the slowest daemon, not the sum of them (#727).
    const snaps = await Promise.all(projects.map(projectSnapshot));
    for (const [index, project] of projects.entries()) {
      const snap = snaps[index];
      if (snap === null || snap === undefined) {
        const last = lastProjectItems.get(project.id);
        if (last && last.generation === inboxGeneration) items.push(...last.items);
        continue;
      }
      if (snap.ok === false) { lastProjectItems.delete(project.id); continue; }
      const firstItem = items.length;
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
      // #1053 T5: the open questions peers asked the person. A private question's title is a stub; the form (the person's own answer surface) carries the text.
      for (const q of (snap.questions as QuestionRowView[] | undefined) ?? []) {
        if (!q || typeof q.set !== "string" || !Array.isArray(q.questions) || !q.questions.length) continue;
        const item = questionItem(q, { id: project.id, name }, options.features);
        seen.set(item.id, item.at);
        items.push(item);
      }
      // #1054 T6: unread results, only to a console that renders the `result` group AND gives a receipt person evidence. Otherwise they stay in the ahub panel, `ahub console`, `ahub status`
      // and `ahub results`. A row that is not well formed is dropped, never rendered; the detail is what the hub built at display (a stub when private).
      if (canPublishResults(options.features)) {
        const results = (snap.results as { unread?: ResultRowView[] } | undefined)?.unread;
        for (const row of Array.isArray(results) ? results : []) {
          if (!row || typeof row.id !== "string" || !/^cmp-[a-f0-9]{12}$/.test(row.id) || typeof row.peer !== "string" || !Number.isSafeInteger(row.settledAt)) continue;
          const item = resultItem(row, { id: project.id, name });
          seen.set(item.id, item.at);
          items.push(item);
        }
      }
      // #1057 D4: one alert when the shelf holds more settled worktrees than `worktrees.alert_over` (0 = never). Counts only: no path, branch or title, and no action
      // beyond opening the panel, because removal is the person's `ahub worktrees tidy` and never a button.
      const shelf = snap.worktrees as { settled?: unknown[]; alertOver?: number } | undefined;
      const settledCount = Array.isArray(shelf?.settled) ? shelf!.settled.length : 0;
      if (typeof shelf?.alertOver === "number" && shelf.alertOver > 0 && settledCount > shelf.alertOver) {
        const id = `worktrees:${project.id}`;
        const at = seen.get(id) ?? new Date().toISOString();
        seen.set(id, at);
        items.push({ id, group: "alert", kind: "worktrees", title: `${settledCount} settled worktrees`, detail: `More than ${shelf.alertOver}. Review them in Agents, then run ahub worktrees tidy.`, project: name, at,
          chip: { text: "worktrees", tone: "warn" }, verbs: [{ id: "open", label: "Open Agents", primary: true }], link: { panel: "agents", params: { project: project.id } } });
      }
      for (const t of (snap.tasks as { id: number; title: string; state: string; reviewer: string | null; owner: string | null }[] | undefined) ?? []) {
        if (t.state !== "in_review" || t.reviewer !== "user") continue;
        const id = `review:${project.id}:${t.id}`;
        const at = seen.get(id) ?? new Date().toISOString();
        seen.set(id, at);
        items.push({ id, group: "review", kind: "review", title: `#${t.id} ${t.title}`.slice(0, 200), ...(t.owner ? { actor: t.owner } : {}), project: name, at,
          chip: { text: "review", tone: "neutral" }, verbs: [{ id: "open", label: "Open board", primary: true }], link: { panel: "board", params: { project: project.id } } });
      }
      if (generation === inboxGeneration) lastProjectItems.set(project.id, { generation, items: items.slice(firstItem) });
    }
    for (const id of lastProjectItems.keys()) if (!projects.some((project) => project.id === id)) lastProjectItems.delete(id);
    // Forget ids that left the inbox, so `seen` stays the size of what is waiting now. This runs on the whole list, before the cap, so a row below the cap keeps its `at`.
    const current = new Set(items.map((item) => item.id));
    for (const id of seen.keys()) if (!current.has(id)) seen.delete(id);
    return items;
  }

  /**
   * #727: what acon polls. The expensive part (every running project's `agents` snapshot) is shared and cached:
   *  - concurrent snapshots join one computation in flight;
   *  - a result younger than `inboxFreshMs` is served as it is;
   *  - a result younger than `inboxStaleMs` is served at once while one refresh runs in the background (nothing runs while nobody polls);
   *  - older, or after any action (an approval or an answer changes what is waiting), the caller waits for a fresh computation.
   * The reply is bounded: at most INBOX_MAX_ITEMS items, the most urgent first, and `more` says how many were left out.
   */
  const INBOX_FRESH_MS = options.inboxFreshMs ?? 1_000, INBOX_STALE_MS = options.inboxStaleMs ?? 10_000, INBOX_PROJECT_BUDGET_MS = options.inboxProjectBudgetMs ?? 2_000;
  let inboxGeneration = 0, inboxCache: { generation: number; at: number; value: InboxReply } | undefined, inboxFlight: { generation: number; promise: Promise<InboxReply> } | undefined;
  function inboxComputation(): Promise<InboxReply> {
    if (inboxFlight && inboxFlight.generation === inboxGeneration) return inboxFlight.promise;
    const generation = inboxGeneration;
    const promise: Promise<InboxReply> = inbox(generation).then((all) => {
      const ordered = [...all].sort((a, b) => INBOX_GROUP_RANK[a.group] - INBOX_GROUP_RANK[b.group] || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const value: InboxReply = { items: ordered.slice(0, INBOX_MAX_ITEMS), more: Math.max(0, ordered.length - INBOX_MAX_ITEMS) };
      if (!inboxCache || inboxCache.generation <= generation) inboxCache = { generation, at: Date.now(), value };
      return value;
    }).finally(() => { if (inboxFlight?.promise === promise) inboxFlight = undefined; });
    inboxFlight = { generation, promise };
    return promise;
  }
  async function inboxSnapshot(): Promise<InboxReply> {
    if (inboxCache && inboxCache.generation === inboxGeneration) {
      const age = Date.now() - inboxCache.at;
      if (age < INBOX_FRESH_MS) return inboxCache.value;
      if (age < INBOX_STALE_MS) { void inboxComputation().catch(() => {}); return inboxCache.value; }
    }
    return await inboxComputation();
  }

  /**
   * #1012 Part 2: every running project's office as one acon SpaceScene. The office model is kept per project as
   * `previous`, as the dashboard keeps it, so desk slots and message arcs persist across polls. A restarted daemon
   * (new instanceId) restarts its event sequence at zero, so its previous model is dropped.
   */
  const offices = new Map<string, { instanceId: string | null; model: OfficeScene }>();
  /**
   * acon wants a snapshot within 5 s. The project listing asks every daemon for its status, so it gets its own budget and
   * falls back to the last listing; projects are then read concurrently, and one that has not answered is left out of this poll.
   */
  const SPACE_BUDGET_MS = options.spaceBudgetMs ?? 3_000;
  const within = async <T,>(work: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    try { return await Promise.race([work, late]); } catch { return null; } finally { clearTimeout(timer); }
  };
  let lastRunning: ProjectRow[] = [];
  async function space() {
    // A listing that finishes after its budget still becomes the fallback for the next poll.
    const listing = running().then((rows) => { lastRunning = rows; return rows; }, () => lastRunning);
    const projects = await within(listing, Math.round(SPACE_BUDGET_MS / 2)) ?? lastRunning;
    for (const id of offices.keys()) if (!projects.some((p) => p.id === id)) offices.delete(id);
    const scenes = [];
    const snaps = await Promise.all(projects.map((project) =>
      within(act({ action: "snapshot", after: 0, projectId: project.id, instanceId: project.instanceId, view: "office" }) as Promise<Record<string, unknown>>, SPACE_BUDGET_MS)));
    for (const [i, project] of projects.entries()) {
      const snap = snaps[i];
      if (!snap || snap.ok === false) continue;
      const cached = offices.get(project.id);
      const model = officeModel(snap as never, cached?.instanceId === project.instanceId ? cached.model : null, { cols: 4, now: Date.now() });
      offices.set(project.id, { instanceId: project.instanceId, model });
      const label = projects.length > 1 ? (project.root.split("/").filter(Boolean).pop() ?? project.id) : undefined;
      scenes.push(officeSpace(model, { id: project.id, ...(label ? { label } : {}) }, Date.now()));
    }
    return mergeSpaces(scenes);
  }

  /**
   * #1053 T5: an answer to a question item. Only with the console's own person meta (checked by the caller); the project and set come from the item id, never from the
   * page. The hub re-validates every answer against the stored row and names a stale or superseded set's terminal state.
   */
  async function answerVerb(input: Record<string, unknown>, person: string): Promise<ActionResult> {
    const m = typeof input.id === "string" ? QUESTION_ITEM.exec(input.id) : null;
    if (!m) return { ok: false, error: "unknown inbox item" };
    const project = (await running()).find((p) => p.id === m[1]);
    if (!project) return { ok: false, error: "project is not running" };
    const result = await answer({ projectId: project.id, instanceId: project.instanceId }, { questionSet: m[2]!, answers: input.answers as InboxAnswers, person }) as Record<string, unknown>;
    return result.ok === true ? { ok: true, message: "Answered" } : { ok: false, error: String(result.error ?? "the answer was refused") };
  }

  /**
   * #1054 T6: a receipt for the person: one result read (the inbox's `result_seen`, whose item id names the project and the completion; the panel's carries the same ids), all read, or the
   * last read unread again. Only with the console's own person meta (checked by the caller). The project comes from the item id or, from the panel, from the project it is showing; the
   * hub re-checks that the result exists and is unread, and names a stale one. `seenAt` and `explicit` are acon's and are not forwarded: the hub stamps its own time.
   */
  async function receiptVerb(name: ResultAction, input: Record<string, unknown>): Promise<ActionResult> {
    let projectId: string | undefined, id: string | undefined;
    if (name === "result_seen") {
      const m = typeof input.id === "string" ? RESULT_ITEM.exec(input.id) : null;
      if (m) { projectId = m[1]; id = m[2]; }
      else if (typeof input.projectId === "string" && typeof input.id === "string" && /^cmp-[a-f0-9]{12}$/.test(input.id)) { projectId = input.projectId; id = input.id; }
      if (!projectId || !id) return { ok: false, error: "unknown result" };
    } else projectId = typeof input.projectId === "string" ? input.projectId : undefined;
    const project = (await running()).find((p) => p.id === projectId);
    if (!project) return { ok: false, error: "project is not running" };
    const target = { projectId: project.id, instanceId: project.instanceId };
    const result = (name === "result_seen" ? await receipt(target, { op: "result_seen", id: id! })
      : await receipt(target, { op: "results", action: name === "results_read_all" ? "read-all" : "unread-last" })) as Record<string, unknown>;
    if (result.ok !== true) return { ok: false, error: String(result.error ?? "the receipt was refused") };
    return { ok: true, message: name === "result_seen" ? "Marked read" : name === "results_read_all" ? `Marked ${Number(result.marked) || 0} read` : "Marked unread again" };
  }

  /** approve/deny resolve to the hub's own `permit` with the request's option; nothing else is reachable from an item. */
  async function inboxVerb(input: Record<string, unknown>): Promise<ActionResult> {
    const m = typeof input.id === "string" ? /^perm:([^:]+):(.+)$/.exec(input.id) : null;
    if (input.action === "open") return { ok: true, message: typeof input.id === "string" && (input.id.startsWith("worktrees:") || input.id.startsWith("question:") || input.id.startsWith("result:")) ? `Open the Agents panel to ${input.id.startsWith("question:") ? "answer" : input.id.startsWith("result:") ? "read the result" : "review the shelf"}.` : "Open the Board panel to review." };
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
      if (input.panel === "review_blob" || input.panel === "review_comments") {
        const { panel: _panel, projectId, instanceId, ...payload } = input;
        return await consoleControl({ projectId, instanceId }, input.panel, payload);
      }
      if (input.panel === "inbox") return { ...await inboxSnapshot() };
      if (input.panel === "space") return { scene: await space() };
      const view = (DASHBOARD_VIEWS as readonly string[]).includes(String(input.view)) ? input.view : (DASHBOARD_VIEWS as readonly string[]).includes(input.panel) ? input.panel : undefined;
      if (typeof input.projectId !== "string" || typeof input.instanceId !== "string") {
        // A bare panel poll (the shell's own, and conformance) gets the listing; the dashboard polls with a project.
        // With exactly one running project the board opens on it, as `ahub ui` does inside a project.
        const listing = await list() as { projects: ProjectRow[] } & Record<string, unknown>;
        const live = listing.projects.filter((p) => p.state === "running");
        return { ...listing, ...(live.length === 1 ? { selectedProjectId: live[0]!.id } : {}), panel: input.panel };
      }
      const { panel: _panel, ...rest } = input;
      return { ...await act({ ...rest, action: "snapshot", ...(view ? { view } : {}) }) as Record<string, unknown>, reviewWritable: options.features?.includes("action.meta") === true };
    },
    async action(input, meta) {
      // #727: an action changes what is waiting, so the cached inbox is dropped before it runs and again when it ends (a poll in between must not keep the old answer).
      inboxGeneration++;
      try { return await runAction(input, meta); } finally { inboxGeneration++; }
    },
    async close() { if (owned) registry.close(); },
  };

    async function runAction(input: Parameters<ConsoleProvider["action"]>[0], meta: ActionMeta | undefined): Promise<ActionResult> {
      const name = String(input.action);
      // #1053 T5: `answer` is accepted only with the console's own verified person meta, and never with page-supplied identity or target fields; anything else is refused before the hub.
      if (name === "answer") {
        const evidence = personEvidence(options.features, meta, input);
        if (!evidence.ok) return { ok: false, error: evidence.error };
        const { action: _a, confirmed: _c, fingerprint: _f, ...forward } = input;
        return await answerVerb(forward, evidence.identity);
      }
      // #1054 T6: a receipt is accepted only with the console's own verified person meta, and never with page-supplied identity or target fields; anything else is refused before the hub.
      if ((RESULT_ACTIONS as readonly string[]).includes(name)) {
        const evidence = receiptEvidence(options.features, meta, input);
        if (!evidence.ok) return { ok: false, error: evidence.error };
        const { action: _a, confirmed: _c, fingerprint: _f, seenAt: _s, explicit: _e, ...forward } = input;
        return await receiptVerb(name as ResultAction, forward);
      }
      const review = REVIEW_ACTIONS.includes(name as typeof REVIEW_ACTIONS[number]);
      if (review && (!options.features?.includes("action.meta") || !meta || meta.via !== "console" || typeof meta.identity !== "string" || !meta.identity.trim() || typeof meta.node !== "string" || !meta.node.trim())) {
        return { ok: false, error: "Review comments need a console with verified person identity; update acon and reopen this panel." };
      }
      if (review && ["author", "meta", "personMeta", "at", "state", "sentAt"].some(key => Object.hasOwn(input, key))) {
        return { ok: false, error: "Review identity and timestamps are supplied by the console; remove those fields and retry." };
      }
      if (![...FORWARDED, ...INBOX_VERBS, ...REVIEW_ACTIONS].includes(name as never)) return { ok: false, error: "unknown action" };
      const fingerprint = fingerprintOf(input);
      if (CONFIRMED.has(name) && !(input.confirmed === true && input.fingerprint === fingerprint)) {
        const target = typeof input.projectId === "string" ? registry.get(input.projectId)?.root.split("/").filter(Boolean).pop() : undefined;
        const preview = name === "review_comment_delete" ? [`Delete or dismiss this review comment on task #${String(input.task ?? "?")}.`]
          : name === "approve" || name === "deny" ? [`${name === "approve" ? "Allow" : "Deny"} this tool request once.`]
          : name === "send" ? [`Send a message as you${target ? ` in ${target}` : ""}.`]
          : [`Run ${name}${target ? ` in ${target}` : ""}.`];
        return { ok: false, needsConfirm: true, preview, fingerprint, verb: name === "approve" ? "Allow once" : name === "deny" ? "Deny" : name };
      }
      if (review) {
        const { action: _action, confirmed: _confirmed, fingerprint: _fingerprint, projectId, instanceId, ...payload } = input;
        return await consoleControl({ projectId, instanceId }, name as typeof REVIEW_ACTIONS[number], payload, meta) as ActionResult;
      }
      const { confirmed: _c, fingerprint: _f, ...forward } = input;
      if (name === "approve" || name === "deny" || name === "open") return await inboxVerb(forward);
      const result = await act(forward) as Record<string, unknown>;
      return (result.ok === false ? { ok: false, error: String(result.error ?? "action failed"), ...(result.unconfirmed === true ? { unconfirmed: true as const } : {}) } : { ...result, ok: true }) as ActionResult;
    }
}

const plugin: ConsolePlugin = {
  manifest: {
    api: 1, tool: "ahub", version, title: "agent-hub", icon: "agents", pollMs: 2000,
    panels: DASHBOARD_VIEWS.map((id, order) => ({ id, title: TITLES[id], order })),
    capabilities: { actions: [...FORWARDED, ...INBOX_VERBS, ...QUESTION_ACTIONS, ...RESULT_ADVERTISED, ...REVIEW_ACTIONS], confirm: true, multiProject: true, inbox: true, space: true },
  },
  async open(ctx) { return createProvider({ home: ctx.home, log: ctx.log, features: ctx.features }); },
};
export default plugin;
