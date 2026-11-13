import { guidancePanelAssets } from "./guidance-panel.ts";
import { guidanceLines, guidanceProbeStatusLines } from "./guidance-view.ts";
/**
 * acon console plugin for agent-hub (#935, plan entelecheia/ai-workspace#60 §2.5).
 *
 * D1: the provider lifts the manager's project listing and forwarding (`projectConsole` in src/hub/manager.ts):
 * Registry + ControlClient.connect(stateDir, {role: "console"}) -> ui_snapshot / ui_action. It adds no protocol and
 * no action: every action is checked against the manager's own whitelist, and every view against DASHBOARD_VIEWS.
 * D2: the panel is the `ahub ui` dashboard itself, built from renderDashboard(), with post() routed to the host.
 *
 * Contract: @staix/agent-console api 1. The manifest type is acon's own, imported type-only (#1375); the provider and item
 * shapes below stay structural so agent-hub keeps zero runtime dependencies.
 */
import type { VisualPayload, VisualSide, ActionMeta, ConsolePanelManifest } from "@staix/agent-console/contract";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Registry } from "../hub/registry.ts";
import { projectConsole, type Lifecycle, type ManagerOptions } from "../hub/manager.ts";
// lifecycle.ts reaches the whole daemon; it is imported only when a project is inspected, started or stopped.
import { DASHBOARD_VIEWS, renderDashboard } from "../hub/ui.ts";
import { parseLineageResult } from "../hub/execution-lineage.ts";
import { executionLineageLines } from "./lineage-view.ts";
import { officeModel, type OfficeScene } from "./office-model.ts";
import { personEvidence, questionItem, QUESTION_ITEM, type InboxAnswers, type QuestionRowView } from "./plugin-questions.ts";
import { canPublishResults, receiptEvidence, resultItem, RESULT_ACTIONS, RESULT_ITEM, type ResultAction, type ResultRowView } from "./plugin-results.ts";
import { mergeSpaces, officeSpace } from "./office-space.ts";
import type { DeliverablePorts } from "../hub/deliverable-files.ts";
import type { VisualFile } from "../hub/visual.ts";
import { matchesPolicy } from "../hub/path-policy.ts";
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
  asset?(input: { id: string }): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  close?(): Promise<void>;
}
export interface ConsolePlugin {
  /** acon's own manifest type, imported type-only: a field or bound the console does not know fails typecheck here (#1375). */
  manifest: ConsolePanelManifest;
  open(ctx: { home: string; log(line: string): void; features?: readonly string[] }): Promise<ConsoleProvider>;
}

const TITLES: Record<(typeof DASHBOARD_VIEWS)[number], string> = { board: "Board", office: "Office", stream: "Stream", agents: "Agents", message: "Message", memory: "Memory", settings: "Settings" };
/** The dashboard's own actions plus the inbox verbs; the manager whitelist is still applied to each forwarded call. */
const FORWARDED = ["start", "stop", "send", "pause", "resume", "permit", "propose", "intake", "assign", "backlog_pull", "backlog_return", "planning", "planning_undo", "planner_pull", "backlog_split", "release_new", "release_change", "setting", "setting_undo", "setting_preview", "model_preview", "model_confirm", "setting_reload", "config_edit_preview", "config_edit_apply", "start_peer", "sdlc_queue", "sdlc_release", "worktree_override_set", "worktree_override_clear", "worktrees_refresh_prs"] as const;
/** Advertised so acon lets the page send it, never forwarded: `action()` answers it through its own port (`answerVerb`), after the console's person meta is checked (#1053 T5). */
const QUESTION_ACTIONS = ["answer"] as const;
/** #1054 T6: the receipt actions, advertised so acon lets the inbox and the page send them, never forwarded: `action()` checks the console's person meta, then calls the dedicated `projectConsole(...).receipt` port (`receiptVerb`). */
const RESULT_ADVERTISED = RESULT_ACTIONS;
const REVIEW_ACTIONS = ["review_comment_put", "review_comment_delete", "review_comment_send"] as const;
/** #1221 T2 AC5: the two verbs an advisory supervision row offers; both reach the hub's own `decide`, as the person. */
const SUPERVISION_VERBS = ["supervision_accept", "supervision_dismiss"] as const;
const SUPERVISION_ITEM = /^supervision:([^:]+):(sup-[0-9a-f]{12})$/;
const INBOX_VERBS = ["approve", "deny", "open", ...SUPERVISION_VERBS] as const;
/** Outward or destructive: answered needsConfirm first (agent-console AGENTS.md); previews are read-only and stay direct. */
// A supervision acceptance runs the proposal's existing action, so it is confirmed like an approval; a dismissal runs nothing and is not.
const CONFIRMED = new Set(["review_comment_delete", "review_comment_send", "stop", "permit", "setting", "setting_undo", "setting_reload", "config_edit_apply", "start_peer", "backlog_split", "send", "approve", "deny", "worktree_override_set", "worktrees_refresh_prs", "supervision_accept"]);
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
  body = swap(body, "const visualKit = null;", "const visualKit = typeof host.ui.visual === 'function' ? host.ui.visual.bind(host.ui) : null;");
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
/** #1220 T3: the closed lineage selectors a page may send; the manager refuses anything else, and `after` is the shell's own field. */
const LINEAGE_QUERY = ["taskId", "attemptId", "root", "task", "cursor", "nodes", "edges", "bytes"] as const;
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
export function createProvider(options: { visualPolicy?: (cwd: string) => Promise<DeliverablePorts>; visualRead?: typeof import("../hub/visual-assets.ts").readVisualAsset; home: string; registry?: Registry; lifecycle?: Lifecycle; log?: (line: string) => void; spaceBudgetMs?: number; runningFreshMs?: number; features?: readonly string[]; forwardTimeoutMs?: ManagerOptions["forwardTimeoutMs"]; inboxFreshMs?: number; inboxStaleMs?: number; inboxProjectBudgetMs?: number }): ConsoleProvider {
  const registry = options.registry ?? new Registry(join(options.home, "registry.db"));
  const owned = !options.registry;
  const lifecycle = options.lifecycle ?? lazyLifecycle();
  const { list, act, answer, receipt, consoleControl, lineage, guidance, guidanceProbe } = projectConsole({ registry, lifecycle, home: options.home, forwardTimeoutMs: options.forwardTimeoutMs });
  const dashboard = panelAssets(), guide = guidancePanelAssets();
  const assets = { css: `${dashboard.css}\n${guide.css}`, js: `${dashboard.js.replace("export default (host) => {", "const createDashboard = (host) => {")}\n${guide.js.replace("export default (host) => {", "const createGuidance = (host) => {")}\nexport default (host) => {
    const dashboardMount = host.mount.ownerDocument.createElement('div'), guidanceMount = host.mount.ownerDocument.createElement('div');
    dashboardMount.hidden = true; guidanceMount.hidden = true; host.mount.append(dashboardMount, guidanceMount);
    const dashboard = createDashboard({...host,mount:dashboardMount}), guidance = createGuidance({...host,mount:guidanceMount});
    return { show(panel,params) { const guide = panel === 'guidance'; dashboardMount.hidden = guide; guidanceMount.hidden = !guide;
      if (guide) { dashboard.hide(); guidance.show(panel,params); } else { guidance.hide(); dashboard.show(panel,params); } },
      hide() { dashboard.hide(); guidance.hide(); dashboardMount.hidden = true; guidanceMount.hidden = true; },
      destroy() { dashboard.destroy(); guidance.destroy(); dashboardMount.remove(); guidanceMount.remove(); } };
  };` };
  const seen = new Map<string, string>(); // inbox item id -> first-seen ISO time, so `at` stays stable

  async function running(): Promise<ProjectRow[]> {
    const listing = await list() as { projects: ProjectRow[] };
    return listing.projects.filter((p) => p.state === "running" && p.instanceId);
  }
  /**
   * #730 r1200-m1: the project listing asks every daemon for its status, so a slow one holds it. `space()` and `inbox()` both bound it to `ms` and fall back to the last listing.
   * One listing is in flight at a time and both callers join it, so a listing that hangs is asked once, not once per poll. A listing that finishes after its budget still becomes the fallback.
   */
  let lastRunning: ProjectRow[] = [];
  const RUNNING_FRESH_MS = options.runningFreshMs ?? 10_000;
  let runningCache: { generation: number; at: number } | undefined;
  let listingFlight: { generation: number; promise: Promise<ProjectRow[]> } | undefined;
  function runningWithin(ms: number, cached = false): Promise<ProjectRow[]> {
    const generation = inboxGeneration;
    const reusable = runningCache?.generation === generation;
    if (cached && reusable && Date.now() - runningCache!.at < RUNNING_FRESH_MS) return Promise.resolve(lastRunning);
    if (!listingFlight || listingFlight.generation !== generation) {
      const promise: Promise<ProjectRow[]> = running().then((rows) => {
        if (generation === inboxGeneration) { lastRunning = rows; runningCache = { generation, at: Date.now() }; }
        return rows;
      }, () => lastRunning).finally(() => { if (listingFlight?.promise === promise) listingFlight = undefined; });
      listingFlight = { generation, promise };
    }
    // Space reuses an expired listing while its one refresh runs; the inbox keeps its existing bounded refresh path.
    if (cached && reusable) return Promise.resolve(lastRunning);
    return within(listingFlight.promise, ms).then((rows) => rows ?? lastRunning);
  }
  /**
   * #727: one project's items from its last answer, reused for a project that did not answer in time, so a slow daemon neither blanks its rows nor restarts their `at`.
   * Fenced by the action generation on both sides: an entry is written only by a computation that no action has overtaken, and read only in the generation it was written in, so an approval
   * or an answer that has been given never comes back from here (a late project is then simply left out of that poll, which is the safe side).
   */
  const lastProjectItems = new Map<string, { generation: number; items: InboxItem[] }>();
  /**
   * #730 r1200-m2: a project's `agents` snapshot in flight. `within()` stops waiting at the budget but the snapshot keeps running, so the next refresh joins it while it is pending instead of asking the
   * same slow project again (one question per slow project, not one per poll). Joined only in the generation it started in, so an answer that began before an action never serves a poll after it.
   */
  const projectFlights = new Map<string, { generation: number; instanceId: string | null; promise: Promise<Record<string, unknown> | null> }>();
  /** The project's `agents` snapshot, or null when it did not answer within the budget or threw: the other projects' rows are never held back by it. */
  const projectSnapshot = (project: ProjectRow) => {
    let flight = projectFlights.get(project.id);
    if (!flight || flight.generation !== inboxGeneration || flight.instanceId !== project.instanceId) {
      const promise: Promise<Record<string, unknown> | null> = Promise.resolve(act({ action: "snapshot", after: 0, projectId: project.id, instanceId: project.instanceId, view: "agents" }) as Promise<Record<string, unknown>>)
        .then((snap) => snap, () => null)
        .finally(() => { if (projectFlights.get(project.id)?.promise === promise) projectFlights.delete(project.id); });
      flight = { generation: inboxGeneration, instanceId: project.instanceId, promise };
      projectFlights.set(project.id, flight);
    }
    return within(flight.promise, INBOX_PROJECT_BUDGET_MS);
  };
  async function inbox(generation: number): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    const projects = await runningWithin(Math.round(INBOX_PROJECT_BUDGET_MS / 2));
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
      // #1221 T2 AC5: an advisory supervision proposal. The hub sends this field only in advisory mode, and it never
      // carries a private task or task text; the row offers the hub's own two verbs and nothing else.
      const advisory = snap.supervision as { mode?: string; proposals?: { id: string; task: number; rule: string; action: string; reason: string; created?: number }[] } | undefined;
      for (const p of advisory?.mode === "advisory" && Array.isArray(advisory.proposals) ? advisory.proposals : []) {
        if (!p || typeof p.id !== "string" || !/^sup-[0-9a-f]{12}$/.test(p.id) || !Number.isSafeInteger(p.task)) continue;
        const id = `supervision:${project.id}:${p.id}`;
        const at = typeof p.created === "number" ? new Date(p.created).toISOString() : (seen.get(id) ?? new Date().toISOString());
        seen.set(id, at);
        items.push({ id, group: "candidate", kind: "supervision", title: `#${p.task}: ${String(p.action).slice(0, 32)}`.slice(0, 200),
          detail: `${String(p.rule).slice(0, 64)} (${String(p.reason).slice(0, 64)})`, project: name, at,
          chip: { text: "supervision", tone: "neutral" },
          verbs: [{ id: "supervision_accept", label: "Accept", primary: true }, { id: "supervision_dismiss", label: "Dismiss" }],
          link: { panel: "board", params: { project: project.id } } });
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
  const offices = new Map<string, { instanceId: string | null; cursor: number; model: OfficeScene }>();
  const officeFlights = new Map<string, { instanceId: string | null; generation: number; promise: Promise<Record<string, unknown> | null> }>();
  let spaceFlight: { generation: number; promise: Promise<{ scene: ReturnType<typeof mergeSpaces>; cursor: number }> } | undefined;
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
  function officeSnapshot(project: ProjectRow, after: number, generation: number) {
    let flight = officeFlights.get(project.id);
    if (!flight || flight.instanceId !== project.instanceId || flight.generation !== generation) {
      const promise: Promise<Record<string, unknown> | null> = Promise.resolve(act({ action: "snapshot", after, projectId: project.id, instanceId: project.instanceId, view: "office" }) as Promise<Record<string, unknown>>)
        .then(value => value, () => null)
        .finally(() => { if (officeFlights.get(project.id)?.promise === promise) officeFlights.delete(project.id); });
      flight = { instanceId: project.instanceId, generation, promise };
      officeFlights.set(project.id, flight);
    }
    return within(flight.promise, SPACE_BUDGET_MS);
  }
  async function spaceComputation(generation: number) {
    const projects = await runningWithin(Math.round(SPACE_BUDGET_MS / 2), true);
    const previous = new Map(offices);
    const scenes = [];
    const cursors: (string | number | null)[][] = [];
    const next = new Map<string, { instanceId: string | null; cursor: number; model: OfficeScene }>();
    const snaps = await Promise.all(projects.map(project => officeSnapshot(project,
      previous.get(project.id)?.instanceId === project.instanceId ? previous.get(project.id)!.cursor : 0, generation)));
    for (const [i, project] of projects.entries()) {
      const snap = snaps[i];
      const cached = previous.get(project.id);
      const sameInstance = cached?.instanceId === project.instanceId;
      // A timeout omits this project's outward scene, but retains its baseline for the next valid reply.
      // A known refusal or a restarted instance gets no such fallback.
      if (!snap) { if (sameInstance) next.set(project.id, cached!); continue; }
      if (snap.ok === false) continue;
      // Event cursors do not cover every public status/privacy field on older daemons. Only an explicit
      // unchanged reply permits model reuse; a full reply is always screened by the unchanged #264 mapper.
      if (snap.changed === false && !sameInstance) continue;
      const model = snap.changed === false ? cached!.model
        : officeModel(snap as never, sameInstance ? cached!.model : null, { cols: 4, now: Date.now() });
      const cursor = Number.isSafeInteger(snap.cursor) && Number(snap.cursor) >= 0 ? Number(snap.cursor) : 0;
      next.set(project.id, { instanceId: project.instanceId, cursor, model });
      cursors.push([project.id, project.instanceId, cursor]);
      // #1375: the project is the scene's group, always named by its directory, so the console shows the group instead of a
      // name prefix on every actor (a lone project's id is not a human name).
      const label = project.root.split("/").filter(Boolean).pop() ?? project.id;
      // Keep the wall clock here even when the model is reused: message arcs expire without a daemon event.
      scenes.push(officeSpace(model, { id: project.id, label }, Date.now()));
    }
    const scene = mergeSpaces(scenes);
    if (generation !== inboxGeneration) return { scene, cursor: 0 };
    const fingerprint = createHash("sha256").update(JSON.stringify([projects.map(p => [p.id, p.instanceId, p.root]), cursors, scene])).digest("hex");
    // Thirteen hex digits fit exactly in a safe integer; provider reopen cannot alias a local counter's first value.
    const cursor = Number.parseInt(fingerprint.slice(0, 13), 16) || 1;
    offices.clear(); for (const [id, entry] of next) offices.set(id, entry);
    return { scene, cursor };
  }
  async function space(after: number) {
    if (!spaceFlight || spaceFlight.generation !== inboxGeneration) {
      const generation = inboxGeneration;
      const promise = spaceComputation(generation).finally(() => { if (spaceFlight?.promise === promise) spaceFlight = undefined; });
      spaceFlight = { generation, promise };
    }
    const value = await spaceFlight.promise;
    return after > 0 && after === value.cursor ? { changed: false, cursor: value.cursor } : value;
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

  /**
   * approve/deny resolve to the hub's own `permit` with the request's option, and a supervision verb to the hub's own
   * `supervision` action as the person; nothing else is reachable from an item, and the page never names the task, the
   * actor or the action.
   */
  async function inboxVerb(input: Record<string, unknown>): Promise<ActionResult> {
    const supervision = typeof input.id === "string" ? SUPERVISION_ITEM.exec(input.id) : null;
    if (supervision && (input.action === "supervision_accept" || input.action === "supervision_dismiss")) {
      const project = (await running()).find((p) => p.id === supervision[1]);
      if (!project) return { ok: false, error: "project is not running" };
      const result = await act({ action: "supervision", projectId: project.id, instanceId: project.instanceId, id: supervision[2], verb: input.action === "supervision_accept" ? "accept" : "dismiss" }) as Record<string, unknown>;
      if (result.ok !== true) return { ok: false, error: String(result.error ?? "the supervision decision was refused") };
      const receipt = result.receipt as { outcome?: string; detail?: string } | undefined;
      return { ok: true, message: input.action === "supervision_dismiss" ? "Dismissed" : receipt?.outcome === "ran" ? "Accepted and run" : receipt?.outcome === "unknown" ? "Accepted; the outcome is unconfirmed, check the task" : "Accepted" };
    }
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
      if (input.panel === "space") return await space(input.after);
      // #1220 T3: the execution-lineage read (AC5). A provider port, not a panel id: the shell's own panels are
      // DASHBOARD_VIEWS and neither that list nor the dashboard's action list grows. Reading executes nothing, and
      // an unavailable or unsupported source stays a refusal here rather than an empty successful graph.
      if (input.panel === "guidance") {
        const { panel: _panel, after: _after, projectId, instanceId, op, ...query } = input;
        // T4 (#1226): one probe experiment's status and sealed receipts. Same panel, same read-only port family: it forwards only the exact probe id, and a reply
        // that does not parse, fails a receipt digest or names another probe is a refusal, never partial text.
        if (op === "probe") {
          const reply = await guidanceProbe({ projectId, instanceId }, query);
          if (!reply.ok || !("receipts" in reply) || !reply.receipts) return { ok: false, panel: "guidance", error: "error" in reply ? reply.error : "guidance probe status unavailable" };
          return { ok: true, panel: "guidance", probe: reply.receipts, lines: guidanceProbeStatusLines(reply.receipts) };
        }
        if (op !== "list" && op !== "show") return { ok: false, panel: "guidance", error: "guidance console is read-only; select list/show/probe and a current task scope" };
        const result = await guidance({ projectId, instanceId }, op, query);
        if (!result.ok || !("guidance" in result) || !result.guidance) return { ok: false, panel: "guidance", error: "error" in result ? result.error : "guidance read unavailable" };
        return { ok: true, panel: "guidance", guidance: result.guidance, lines: guidanceLines(result.guidance) };
      }
      if (input.panel === "lineage") {
        const query = Object.fromEntries(LINEAGE_QUERY.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
        const reply = await lineage({ projectId: input.projectId, instanceId: input.instanceId }, query);
        if (reply.ok === false) return { ok: false, panel: "lineage", error: String(reply.error ?? "lineage read failed") };
        try { const page = parseLineageResult(reply.lineage); return { ok: true, panel: "lineage", lineage: page, lines: executionLineageLines(page) }; }
        catch (error) { return { ok: false, panel: "lineage", error: (error as Error).message }; }
      }
      const view = (DASHBOARD_VIEWS as readonly string[]).includes(String(input.view)) ? input.view : (DASHBOARD_VIEWS as readonly string[]).includes(input.panel) ? input.panel : undefined;
      if (typeof input.projectId !== "string" || typeof input.instanceId !== "string") {
        // A bare panel poll (the shell's own, and conformance) gets the listing; the dashboard polls with a project.
        // With exactly one running project the board opens on it, as `ahub ui` does inside a project.
        const listing = await list() as { projects: ProjectRow[] } & Record<string, unknown>;
        const live = listing.projects.filter((p) => p.state === "running");
        return { ...listing, ...(live.length === 1 ? { selectedProjectId: live[0]!.id } : {}), panel: input.panel };
      }
      const { panel: _panel, ...rest } = input;
      const result = await act({ ...rest, action: "snapshot", ...(view ? { view } : {}) }) as Record<string, unknown>;
      if (result.visual && typeof result.visual === "object") {
        const row = result.visual as { payload?: VisualPayload };
        if (row.payload?.kind === "beforeAfter") {
          const side = (value: VisualSide) => "asset" in value
            ? { ...value, asset: visualAssetId(input.projectId as string, input.instanceId as string, value.asset) } : value;
          result.visual = { ...row, payload: { ...row.payload, before: side(row.payload.before), after: side(row.payload.after) } };
        }
      }
      return { ...result, reviewWritable: options.features?.includes("action.meta") === true };
    },
    async action(input, meta) {
      // #727: an action changes what is waiting, so the cached inbox is dropped before it runs and again when it ends (a poll in between must not keep the old answer).
      inboxGeneration++;
      try { return await runAction(input, meta); } finally { inboxGeneration++; }
    },
    async asset(input) {
      let readingAsset = false;
      try {
        const identity = parseVisualAssetId(input.id); if (!identity) return null;
        const { projectId, instanceId, asset } = identity;
        const registered = registry.get(projectId);
        if (!registered || registered.instanceId !== instanceId) return null;
        const project = { ...registered };
        const sameProject = () => { const now = registry.get(projectId); return !!now && now.root === project.root && now.stateDir === project.stateDir && now.instanceId === instanceId; };
        const metadata = async () => {
          if (!sameProject()) return null;
          const reply = await act({ action: "snapshot", after: 0, projectId, instanceId, visualAsset: asset }) as Record<string, unknown>;
          return reply.ok === false || !sameProject() ? null : reply.visualAsset;
        };
        const before = await metadata() as { id: string; task?: number; from: string; created: number; file: VisualFile } | null;
        if (!before || before.file?.asset !== asset || before.id !== asset.split(":")[0]) return null;
        const policy = options.visualPolicy ?? (async (cwd: string): Promise<DeliverablePorts> => {
          const { loadConfig } = await import("../hub/daemon.ts");
          const config = loadConfig(cwd); return { cwd, deny: config.local.deny, private: file => matchesPolicy(cwd, file, config.pii?.paths ?? [], true) };
        });
        const initialPolicy = await policy(project.root);
        if (!sameProject()) return null;
        const read = options.visualRead ?? (await import("../hub/visual-assets.ts")).readVisualAsset;
        if (!sameProject()) return null;
        readingAsset = true;
        const bytes = await read(before.file, initialPolicy);
        readingAsset = false;
        const after = await metadata(), currentPolicy = await policy(project.root);
        if (!after || !sameProject() || currentPolicy.private(before.file.path) || JSON.stringify(currentPolicy.deny) !== JSON.stringify(initialPolicy.deny) || JSON.stringify(after) !== JSON.stringify(before)) return null;
        return bytes;
      } catch {
        if (readingAsset) throw new Error("visual asset changed since posted or no longer allowed; post the visual again using a current public file");
        return null;
      }
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
          : name === "supervision_accept" ? [`Accept a supervision proposal${target ? ` in ${target}` : ""} and run the action it names once.`]
          : [`Run ${name}${target ? ` in ${target}` : ""}.`];
        return { ok: false, needsConfirm: true, preview, fingerprint, verb: name === "approve" ? "Allow once" : name === "deny" ? "Deny" : name };
      }
      if (review) {
        const { action: _action, confirmed: _confirmed, fingerprint: _fingerprint, projectId, instanceId, ...payload } = input;
        return await consoleControl({ projectId, instanceId }, name as typeof REVIEW_ACTIONS[number], payload, meta) as ActionResult;
      }
      const { confirmed: _c, fingerprint: _f, ...forward } = input;
      if (name === "approve" || name === "deny" || name === "open" || (SUPERVISION_VERBS as readonly string[]).includes(name)) return await inboxVerb(forward);
      const result = await act(forward) as Record<string, unknown>;
      return (result.ok === false ? { ok: false, error: String(result.error ?? "action failed"), ...(result.unconfirmed === true ? { unconfirmed: true as const } : {}) } : { ...result, ok: true }) as ActionResult;
    }
}

/**
 * #1375 (acon#105): how long acon may reuse a snapshot instead of asking again, 0-60000 ms. The inbox provider serves a
 * result under its own `inboxFreshMs` as it is and recomputes past it, so declaring more than that would hand the console a
 * value the provider would already have refreshed, and a person acts on an approval it missed. A Space scene's only
 * time-dependent content is its message arcs, which expire on a 10 s window, so one poll interval of reuse cannot show the
 * page anything older than the poll it would have drawn anyway.
 */
const POLL_MS = 2_000, INBOX_MAX_AGE_MS = 1_000, SPACE_MAX_AGE_MS = POLL_MS;

const plugin: ConsolePlugin = {
  manifest: {
    api: 1, tool: "ahub", version, title: "agent-hub", icon: "agents", pollMs: POLL_MS,
    panels: [...DASHBOARD_VIEWS.map((id, order) => ({ id, title: TITLES[id], order })), { id: "guidance", title: "Guidance", order: DASHBOARD_VIEWS.length }],
    capabilities: { actions: [...FORWARDED, ...INBOX_VERBS, ...QUESTION_ACTIONS, ...RESULT_ADVERTISED, ...REVIEW_ACTIONS], confirm: true, multiProject: true,
      inbox: true, inboxMaxAgeMs: INBOX_MAX_AGE_MS, space: true, spaceMaxAgeMs: SPACE_MAX_AGE_MS },
  },
  async open(ctx) { return createProvider({ home: ctx.home, log: ctx.log, features: ctx.features }); },
};
export default plugin;

/** Project and instance are part of the outward id; a copied DB's UUID never selects another project. */
export function visualAssetId(projectId: string, instanceId: string, asset: string): string {
  const value = `ahub-visual:${projectId}:${instanceId}:${asset}`;
  if (!parseVisualAssetId(value)) throw new Error("visual asset identity unavailable; reopen its current project");
  return value;
}
export function parseVisualAssetId(value: unknown): { projectId: string; instanceId: string; asset: string } | undefined {
  if (typeof value !== "string") return;
  const match = /^ahub-visual:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(?:before|after))$/.exec(value);
  return match ? { projectId: match[1]!, instanceId: match[2]!, asset: match[3]! } : undefined;
}
