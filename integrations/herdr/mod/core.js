// The Herdr entry point's logic (#1199 H1). Pure and host-injected: no `herdr` or `gpui-kit` import, no filesystem, no network, no timers. `main.js` is the thin native glue.
//
// What it does: show the machine and folder of the focused space, list that machine's registered ahub projects, bind ONE explicit selection (space, machine, id, real root),
// then open the existing `ahub console` in a new Herdr tab on that machine, or the existing local dashboard, or hand back a command to copy.
//
// What it never does: run anything on this Mac for a remote space, put a project path in a command line, resolve a remote path locally, open or rewrite a loopback link, keep a dashboard
// ticket (the output of `ahub ui` is dropped), start/stop/restart/upgrade anything, touch a task, review, approval, role, budget or memory, kill/park/close a terminal, retry,
// poll, or persist anything. The pane's folder is a hint: authority is a registration read on the same machine.

import { CARD_SENTENCES, classifyRun, projectStatus, ageCard, formatCard } from "./card.js";
import { MAX_TERMINALS, matchConsole, terminalRow } from "./focus.js";

export const EXEC = Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 });
export const MAX_PROJECTS = 500;
/** The only programs and arguments this entry ever passes to exec or run. Anything else is a bug. */
export const FIXED = Object.freeze({
  projects: Object.freeze(["projects", "--json"]),
  status: Object.freeze(["status", "--json"]),
  console: Object.freeze(["console"]),
  ui: Object.freeze(["ui"]),
});
export const PROGRAM = "ahub";
/**
 * Every command that acts on ONE project names it with `--project <id>` before the command. A command run with only a folder resolves its project from that folder and assumes the default
 * state directory, so a registered project with a custom one would read as offline; the id selects the registration, with the state directory it recorded.
 */
export const projectArgs = (id, fixed) => ["--project", id, ...fixed];
/** A registration id is passed as one argument, never through a shell. Only these characters, and never a leading dash (a selector must not look like a flag). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Closed vocabulary. Fixed sentences: a refusal never carries raw CLI output, stderr or a link. */
export const REFUSALS = Object.freeze({
  host_unavailable: "Herdr did not answer for this window's spaces. Nothing was run.",
  no_context: "No space is focused. Focus a terminal in the space you want, then refresh.",
  unknown_machine: "This space's machine is not one Herdr lists, so nothing was run for it.",
  machine_unavailable: "That machine is not ready (still loading or offline). Nothing was run. Try again when Herdr shows it connected.",
  read_failed: "Could not run ahub there (it may not be installed on that machine, the folder may have moved, or the machine did not answer). Nothing was changed.",
  cli_failed: "ahub exited with an error. Nothing was changed. Run `ahub status` in a terminal in the project to see why.",
  bad_output: "ahub answered in a shape this entry does not recognize, so it did nothing. Update ahub or this entry.",
  too_many: "That machine has more registered projects than this entry reads. Nothing was run.",
  duplicate: "Two registrations claim the same folder, or the same id appears twice. Resolve it with `ahub projects`, then refresh.",
  no_selection: "Select a project first.",
  changed: "That project or space is not what was selected (it moved, was replaced or is gone). Refresh and select again.",
  offline: "That project's hub is not running. Start it yourself with `ahub up` in the project, then try again. This entry never starts it.",
  remote: "The dashboard only opens on this computer. For a project on another machine, use Open console in its space, or copy the command and run it there.",
  unsupported_platform: "This entry does not run on Windows. Copy-free fallback: open a terminal in the project yourself and run `ahub console`.",
  busy: "An action is already running. Wait for it to finish.",
  stale: "The selection changed while this was running, so it stopped before changing anything.",
  host_refused: "Herdr refused the request. Nothing was opened.",
  unconfirmed: "Herdr did not show a new tab after the request. It was not retried, so check the space before trying again.",
  link_printed: "ahub printed a link instead of opening one. It was not kept or shown. Run `ahub ui` in a terminal on this computer.",
  bad_root: "That folder name has a character that cannot be copied safely into a shell. Open a terminal there yourself.",
  no_console: "No running console for this project was found in Herdr. Use Open console to start one; nothing was replaced or created.",
  ambiguous_console: "More than one running console matches this project, so none was chosen. Focus the one you want yourself.",
  remote_focus: "Focusing an existing terminal on another machine is not supported here. Use Open console in that machine's space.",
  unconfirmed_focus: "Herdr did not show that terminal as focused after the request. It was not retried, and nothing was started or closed.",
  too_many_terminals: "Herdr lists more terminals than this entry looks through, so none was chosen. Focus the console yourself.",
  hc_unavailable: "Herdr did not let this entry read a terminal, so none was chosen. Focus the console yourself.",
});

// The mod runtime has no structuredClone (herdr-app check rejected it). Everything copied here is plain JSON data.
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (refusal, extra = {}) => ({ ok: false, refusal, message: REFUSALS[refusal], ...extra });
const text = (v, max = 4096) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Equal, or an ancestor at a path-segment boundary: `/work/a` does not contain `/work/ab`. POSIX absolute paths only. */
export function containsAtBoundary(root, cwd) {
  if (typeof root !== "string" || typeof cwd !== "string" || !root.startsWith("/") || !cwd.startsWith("/")) return false;
  const r = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === r || r === "/" || cwd.startsWith(`${r}/`);
}

/** One POSIX single-quoted word for a person to paste. Refuses anything with a control character, because a pasted newline runs. */
export function posixQuote(value) {
  if (!text(value)) return null;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseRows(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return { refusal: "bad_output" }; }
  if (!Array.isArray(value)) return { refusal: "bad_output" };
  if (value.length > MAX_PROJECTS) return { refusal: "too_many" };
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !SAFE_ID.test(row.id) || !text(row.root) || !row.root.startsWith("/")) return { refusal: "bad_output" };
    // Only these fields are kept. The rest of a row (it embeds a whole status) is dropped here and never stored or shown.
    rows.push({ id: row.id, root: row.root, state: row.state === "running" ? "running" : row.state === "stopped" ? "stopped" : "unknown" });
  }
  const roots = new Set(), ids = new Set();
  for (const row of rows) { if (roots.has(row.root) || ids.has(row.id)) return { refusal: "duplicate" }; roots.add(row.root); ids.add(row.id); }
  return { rows };
}

function candidateKind(cwd, rows) {
  if (!cwd) return { kind: "no_cwd", hits: [] };
  const hits = rows.filter(r => containsAtBoundary(r.root, cwd)).sort((a, b) => b.root.length - a.root.length);
  return { kind: hits.length === 0 ? "none" : hits.length === 1 ? "single" : "ambiguous", hits };
}

export function createHerdrEntry({ host }) {
  let generation = 0, busy = false, cardBusy = false;
  let view = { status: "idle", machine: null, machineLabel: "this computer", cwd: null, rows: [], candidate: "none", highlighted: null, selection: null, refusal: null, message: "", card: null };

  const label = machine => (machine === null ? "this computer" : machine);
  const platform = () => { try { return host.platform ? host.platform() : null; } catch { return null; } };

  function context() {
    let focus, spaces, machines;
    try { focus = host.focused(); spaces = host.spaces(); machines = host.machines(); } catch { return fail("host_unavailable"); }
    if (!focus || typeof focus !== "object" || !Array.isArray(spaces) || !Array.isArray(machines)) return fail("no_context");
    const space = spaces.find(s => s && s.id === focus.space);
    if (!space) return fail("no_context");
    return { ok: true, focus, space, spaces, machines };
  }
  function ready(machines, machine) {
    const found = machines.find(m => m && m.name === machine);
    if (!found) return machine === null ? "machine_unavailable" : "unknown_machine";
    return found.layout === "ready" ? null : "machine_unavailable";
  }
  /** One bounded, fixed-argv exec. A rejection is `read_failed`; the host's own behavior on timeout or oversize is undocumented, so any rejection is treated alike. */
  async function run(args, options) {
    try { return { ok: true, result: await host.exec(PROGRAM, [...args], options) }; } catch { return { ok: false }; }
  }
  async function readProjects(machine) {
    const got = await run(FIXED.projects, machine === null ? {} : { on: machine });
    if (!got.ok) return { refusal: "read_failed" };
    if (got.result.code !== 0) return { refusal: "cli_failed" };
    return parseRows(got.result.stdout);
  }
  /** Run `ahub --project <id> status --json` from the project folder (the folder must still exist) and require it to name the selected id, using the registration's own state directory. */
  async function checkProject(binding) {
    const options = binding.machine === null ? { cwd: binding.root } : { cwd: binding.root, on: binding.machine };
    const got = await run(projectArgs(binding.id, FIXED.status), options);
    if (!got.ok) return { refusal: "read_failed" };
    if (got.result.code !== 0) return { refusal: typeof got.result.stderr === "string" && got.result.stderr.includes("no hub running") ? "offline" : "cli_failed" };
    let status;
    try { status = JSON.parse(got.result.stdout); } catch { return { refusal: "bad_output" }; }
    if (!status || typeof status !== "object" || typeof status.projectId !== "string") return { refusal: "bad_output" };
    // Selected by id, `projectId` equals the id by construction, so it proves little. What proves the registration still owns this folder is the root the hub reports for itself.
    if (status.projectId !== binding.id) return { refusal: "changed" };
    return typeof status.cwd === "string" && status.cwd === binding.root ? { ok: true } : { refusal: status.cwd === undefined ? "bad_output" : "changed" };
  }

  /** Read `ahub --project <root> status --json` ON the selected machine, from the project folder, within the host's own caps. Returns a card whose state is always one of the closed ones. */
  async function readCard(sel) {
    const options = sel.machine === null ? { cwd: sel.root } : { cwd: sel.root, on: sel.machine };
    const started = typeof host.now === "function" ? host.now() : Date.now();
    let result = null, rejected = false;
    try { result = await host.exec(PROGRAM, projectArgs(sel.id, FIXED.status), options); } catch { rejected = true; }
    const done = typeof host.now === "function" ? host.now() : Date.now();
    const kind = classifyRun({ rejected, elapsedMs: done - started, timeoutMs: EXEC.timeoutMs, result,
      stderrSaysNoHub: !rejected && result && typeof result.stderr === "string" && result.stderr.startsWith("ahub: no hub running for ") });
    if (kind.kind !== "ok") return { ok: false, state: kind.kind, fetchedAt: done };
    let raw;
    try { raw = JSON.parse(result.stdout); } catch { return { ok: false, state: "bad_output", fetchedAt: done }; }
    const card = projectStatus(raw, done, done);
    if (!card.ok) return { ok: false, state: card.state, fetchedAt: done };
    if (card.projectId !== sel.id) return { ok: false, state: "changed", fetchedAt: done };
    // Selected by id, `projectId` equals the id by construction, so the proof is the folder the hub reports for itself: the same rule as the open actions (checkProject).
    if (typeof raw.cwd !== "string" || raw.cwd !== sel.root) return { ok: false, state: raw.cwd === undefined ? "bad_output" : "changed", fetchedAt: done };
    return card;
  }

  function setView(patch) { view = { ...view, ...patch }; return view; }

  return {
    view: () => copy(view),

    /** Re-read the focus, the machine and its registered projects. Never selects. Bumps the generation, so anything still running for an older view stops. */
    async refresh() {
      const gen = ++generation;
      setView({ status: "loading", refusal: null, message: "", selection: null, card: null });
      if (platform() === "windows") return setView({ status: "refused", refusal: "unsupported_platform", message: REFUSALS.unsupported_platform, rows: [], candidate: "none", highlighted: null });
      const ctx = context();
      if (!ctx.ok) return setView({ status: "refused", refusal: ctx.refusal, message: ctx.message, rows: [], candidate: "none", highlighted: null });
      const machine = ctx.space.machine ?? null;
      const state = ready(ctx.machines, machine);
      const base = { machine, machineLabel: label(machine), cwd: typeof ctx.focus.cwd === "string" && ctx.focus.cwd ? ctx.focus.cwd : null };
      if (state) return setView({ ...base, status: "refused", refusal: state, message: REFUSALS[state], rows: [], candidate: "none", highlighted: null });
      const read = await readProjects(machine);
      if (gen !== generation) return view;
      if (read.refusal) return setView({ ...base, status: "refused", refusal: read.refusal, message: REFUSALS[read.refusal], rows: [], candidate: "none", highlighted: null });
      const found = candidateKind(base.cwd, read.rows);
      const rows = read.rows.map(r => ({ ...r, candidate: found.hits.some(h => h.id === r.id) }));
      rows.sort((a, b) => Number(b.candidate) - Number(a.candidate) || a.root.localeCompare(b.root));
      return setView({ ...base, status: "ready", refusal: null, message: "", rows, candidate: found.kind, highlighted: found.kind === "ambiguous" ? found.hits[0].id : found.kind === "single" ? found.hits[0].id : null,
        spaceId: ctx.space.id });
    },

    /** Bind one explicit row to this space and machine. A single candidate is a default the person still confirms by selecting it. */
    select(id) {
      if (view.status !== "ready") return fail("changed");
      const row = view.rows.find(r => r.id === id);
      if (!row) return fail("changed");
      generation++;
      const selection = { id: row.id, root: row.root, machine: view.machine, machineLabel: view.machineLabel, spaceId: view.spaceId, state: row.state };
      setView({ selection, refusal: null, message: "", card: null });
      return { ok: true, selection: copy(selection) };
    },

    /**
     * Explicit refresh of the card for the selected project. Never started by a timer: the caller is a click, or a project-context change (select). A second call while one is reading is refused, and a
     * reading that finishes after the selection changed is dropped, so a card is never shown under another project's name.
     */
    async refreshCard() {
      const sel = view.selection;
      if (!sel) return fail("no_selection");
      if (platform() === "windows") return fail("unsupported_platform");
      if (cardBusy) return fail("busy");
      let spaces, machines;
      try { spaces = host.spaces(); machines = host.machines(); } catch { return fail("host_unavailable"); }
      const space = Array.isArray(spaces) ? spaces.find(s => s && s.id === sel.spaceId) : null;
      if (!space || (space.machine ?? null) !== sel.machine) return fail("changed");
      const state = Array.isArray(machines) ? ready(machines, sel.machine) : "machine_unavailable";
      if (state) { setView({ card: { ok: false, state: "machine_unavailable", fetchedAt: null } }); return { ok: false, state: "machine_unavailable" }; }
      cardBusy = true;
      const gen = generation, id = sel.id;
      try {
        const card = await readCard(sel);
        if (gen !== generation || view.selection?.id !== id) return fail("stale");
        setView({ card });
        return { ok: card.ok === true, state: card.state };
      } finally { cardBusy = false; }
    },

    /** The fixed sentence for a card state that is not a reading. */
    cardSentence(state) { return CARD_SENTENCES[state] ?? ""; },

    /** The card's visible lines for a person, from the current reading (see formatCard). */
    cardLines(now) { return formatCard(this.card(now), s => CARD_SENTENCES[s] ?? ""); },

    /** The card as of `now`: a running reading older than the stale bound is reported as stale, without asking the hub again. */
    card(now) { return view.card ? copy(ageCard(view.card, typeof now === "number" ? now : (typeof host.now === "function" ? host.now() : Date.now()))) : null; },

    /** Focus an existing console for the selected project, or refuse. Never starts, replaces, closes or types into a terminal. */
    async focusConsole() { return focusEffect("focus"); },
    /** The same verification, then `terminal.peek`, which Herdr opens over the tab with its own keep and close controls. */
    async peekConsole() { return focusEffect("peek"); },

    /** Open the existing `ahub console` in a new tab of the selected space, so Herdr puts it on that space's machine. The folder is the project root; no path is in a command line. */
    async openConsole() { return effect("console"); },
    /** This computer only. `ahub ui` opens the existing local dashboard; its output is dropped. */
    async openDashboard() { return effect("dashboard"); },

    /** The one command to paste into a shell on the selected machine. Runs nothing. */
    copyCommand() {
      const sel = view.selection;
      if (!sel) return fail("no_selection");
      if (platform() === "windows") return fail("unsupported_platform");
      const quoted = posixQuote(sel.root);
      if (!quoted) return fail("bad_root");
      return { ok: true, command: `${PROGRAM} --project ${quoted} console`, machine: sel.machine, machineLabel: sel.machineLabel };
    },
  };

  /** Re-read the selected space and its machine's readiness, with no await in between and the effect right after. A mismatch is a refusal, never a retry. */
  function recheckSpace(sel) {
    let spaces, machines;
    try { spaces = host.spaces(); machines = host.machines(); } catch { return { refusal: "host_unavailable" }; }
    if (!Array.isArray(spaces) || !Array.isArray(machines)) return { refusal: "host_unavailable" };
    const space = spaces.find(s => s && s.id === sel.spaceId);
    if (!space || (space.machine ?? null) !== sel.machine) return { refusal: "changed" };
    const state = ready(machines, sel.machine);
    return state ? { refusal: state } : { space };
  }

  async function focusEffect(kind) {
    const sel = view.selection;
    if (!sel) return fail("no_selection");
    if (busy) return fail("busy");
    if (sel.machine !== null) return fail("remote_focus");
    if (platform() === "windows") return fail("unsupported_platform");
    if (typeof host.hc !== "function") return fail("hc_unavailable");
    busy = true;
    const gen = generation;
    try {
      const early = recheckSpace(sel); // a precondition only: refused before any read; it is read again right before the effect
      if (early.refusal) return fail(early.refusal);
      // The binding: the selected id must still own the selected root, here, before any terminal is looked at.
      const read = await readProjects(sel.machine);
      if (gen !== generation) return fail("stale");
      if (read.refusal) return fail(read.refusal);
      const row = read.rows.find(r => r.root === sel.root);
      if (!row || row.id !== sel.id) return fail("changed");
      const found = await findConsole(host, sel);
      if (gen !== generation) return fail("stale");
      if (found.refusal) return fail(found.refusal);
      // Recheck immediately before the one effect: the same terminal must still be the single related console.
      const again = await findConsole(host, sel);
      if (gen !== generation) return fail("stale");
      if (again.refusal || again.address !== found.address) return fail(again.refusal ?? "changed");
      // The reads above were awaited, and only refresh and select move the generation, so the space and its machine are read again here with nothing awaited before the effect (the same rule as
      // the open actions). A space that moved, or a machine that went away, while ahub and Herdr were answering refuses and nothing is focused.
      const live = recheckSpace(sel);
      if (live.refusal) return fail(live.refusal);
      try { host.run(kind === "peek" ? "terminal.peek" : "pane.focus", { terminal: found.address }); }
      catch { return fail("host_refused"); }
      // `run` returns null whatever happened, so a focus is believed only when `focused()` shows it. A peek has no such read: it is reported as requested, never as confirmed.
      // `observed` is Herdr's own working/blocked/done/idle word for that terminal. It is shown to the person and nothing else: it is never sent to ahub.
      if (kind === "peek") return { ok: true, requested: "peek", terminal: found.address, confirmed: false, observed: found.herdr };
      let now;
      try { now = host.focused(); } catch { return fail("unconfirmed_focus"); }
      return now && now.terminal === found.address ? { ok: true, focused: found.address, confirmed: true, observed: found.herdr } : fail("unconfirmed_focus");
    } finally { busy = false; }
  }

  async function effect(kind) {
    const sel = view.selection;
    if (!sel) return fail("no_selection");
    if (busy) return fail("busy");
    if (kind === "dashboard" && sel.machine !== null) return fail("remote");
    // A Windows window is refused whatever machine the space is on: no combination with a Windows window has a receipt, so none is attempted.
    if (platform() === "windows") return fail("unsupported_platform");
    busy = true;
    const gen = generation;
    try {
      // 1. Re-read everything the selection was bound to. The focus is NOT part of it: the person chose a row, and focus is only a hint.
      let spaces, machines;
      try { spaces = host.spaces(); machines = host.machines(); } catch { return fail("host_unavailable"); }
      if (!Array.isArray(spaces) || !Array.isArray(machines)) return fail("host_unavailable");
      const early = spaces.find(s => s && s.id === sel.spaceId);
      if (!early || (early.machine ?? null) !== sel.machine) return fail("changed");
      const state = ready(machines, sel.machine);
      if (state) return fail(state);
      const read = await readProjects(sel.machine);
      if (gen !== generation) return fail("stale");
      if (read.refusal) return fail(read.refusal);
      const row = read.rows.find(r => r.root === sel.root);
      if (!row || row.id !== sel.id) return fail("changed");
      // 2. Prove the project resolves, from that folder, to the selected id, and that its hub is running. This never starts it.
      const checked = await checkProject(sel);
      if (gen !== generation) return fail("stale");
      if (!checked.ok) return fail(checked.refusal);
      // 3. The effect. The reads above were awaited, and only refresh and select move the generation, so the space and its machine are read again here, synchronously with the effect: a space that moved
      // to another machine, or a machine that went away, while ahub was answering must not receive the tab.
      const live = recheckSpace(sel);
      if (live.refusal) return fail(live.refusal);
      if (kind === "dashboard") {
        const got = await run(projectArgs(sel.id, FIXED.ui), { cwd: sel.root });
        // No stale check here: the dashboard was already requested, so reporting "stale" would misstate what happened.
        if (!got.ok) return fail("read_failed");
        if (got.result.code !== 0) return fail("cli_failed");
        // The output is never returned, logged or stored. If it holds a link, ahub could not open one.
        return /https?:\/\//i.test(String(got.result.stdout)) ? fail("link_printed") : { ok: true, opened: "dashboard", machineLabel: sel.machineLabel };
      }
      const before = new Set((live.space.tabs ?? []).map(t => t.id));
      try { host.run("tab.new", { space: live.space.id, folder: sel.root, argv: [PROGRAM, ...projectArgs(sel.id, FIXED.console)], name: tabName(sel.root) }); }
      catch { return fail("host_refused"); }
      // `run` returns null whatever happened, so the result is learned only by re-reading. There is no retry: a second request could open a second console.
      let after;
      try { after = host.spaces().find(s => s && s.id === live.space.id); } catch { return fail("unconfirmed"); }
      const added = (after?.tabs ?? []).find(t => !before.has(t.id));
      return added ? { ok: true, opened: "console", tab: added.id, machineLabel: sel.machineLabel } : fail("unconfirmed");
    } finally { busy = false; }
  }
}

/** Find the one running `ahub console` for the selection among Herdr's terminals, from facts `hc get` reports. Returns the address, or a refusal. */
async function findConsole(host, sel) {
  let rows;
  try { rows = host.terminals(); } catch { return { refusal: "host_unavailable" }; }
  if (!Array.isArray(rows)) return { refusal: "host_unavailable" };
  if (rows.length > MAX_TERMINALS) return { refusal: "too_many_terminals" };
  const live = rows.map(terminalRow).filter(r => r && r.live);
  // A remote terminal's address has a machine prefix. Remote `hc get` was not observed, so none is examined and none can match.
  const local = live.filter(r => !r.address.includes("/"));
  const hits = [];
  for (const row of local) {
    let got;
    try { got = await host.hc(["get", row.address, "--json"]); } catch { return { refusal: "hc_unavailable" }; }
    if (!got || got.code !== 0) continue; // finished, gone or unreadable: not a related console
    let info;
    try { info = JSON.parse(got.stdout); } catch { continue; }
    if (info && info.state === "live" && matchConsole(info.foreground, sel)) hits.push(row.address);
  }
  if (hits.length === 0) return { refusal: "no_console" };
  if (hits.length > 1) return { refusal: "ambiguous_console" };
  return { address: hits[0], herdr: local.find(r => r.address === hits[0]).herdr };
}

/** A tab's name is display text, never code, but keep it short and free of control characters. */
export function tabName(root) {
  const base = String(root).split("/").filter(Boolean).pop() ?? "project";
  return `ahub: ${base.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40)}`;
}
