// The Herdr entry point's logic (#1199 H1). Pure and host-injected: no `herdr` or `gpui-kit` import, no filesystem, no network, no timers. `main.js` is the thin native glue.
//
// What it does: show the machine and folder of the focused space, list that machine's registered ahub projects, bind ONE explicit selection (space, machine, id, real root),
// then open the existing `ahub console` in a new Herdr tab on that machine, or the existing local dashboard, or hand back a command to copy.
//
// What it never does: run anything on this Mac for a remote space, put a project path in a command line, resolve a remote path locally, open or rewrite a loopback link, keep a dashboard
// ticket (the output of `ahub ui` is dropped), start/stop/restart/upgrade anything, touch a task, review, approval, role, budget or memory, kill/park/close a terminal, retry,
// poll, or persist anything. The pane's folder is a hint: authority is a registration read on the same machine.

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
    if (!row || typeof row !== "object" || !text(row.id, 128) || !text(row.root) || !row.root.startsWith("/")) return { refusal: "bad_output" };
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
  let generation = 0, busy = false;
  let view = { status: "idle", machine: null, machineLabel: "this computer", cwd: null, rows: [], candidate: "none", highlighted: null, selection: null, refusal: null, message: "" };

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
  /** Run `ahub status --json` with the project folder as cwd, exactly where `ahub console` will resolve the project, and require it to name the selected id. */
  async function checkProject(binding) {
    const options = binding.machine === null ? { cwd: binding.root } : { cwd: binding.root, on: binding.machine };
    const got = await run(FIXED.status, options);
    if (!got.ok) return { refusal: "read_failed" };
    if (got.result.code !== 0) return { refusal: typeof got.result.stderr === "string" && got.result.stderr.includes("no hub running") ? "offline" : "cli_failed" };
    let status;
    try { status = JSON.parse(got.result.stdout); } catch { return { refusal: "bad_output" }; }
    if (!status || typeof status !== "object" || typeof status.projectId !== "string") return { refusal: "bad_output" };
    return status.projectId === binding.id ? { ok: true } : { refusal: "changed" };
  }

  function setView(patch) { view = { ...view, ...patch }; return view; }

  return {
    view: () => copy(view),

    /** Re-read the focus, the machine and its registered projects. Never selects. Bumps the generation, so anything still running for an older view stops. */
    async refresh() {
      const gen = ++generation;
      setView({ status: "loading", refusal: null, message: "", selection: null });
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
      setView({ selection, refusal: null, message: "" });
      return { ok: true, selection: copy(selection) };
    },

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

  async function effect(kind) {
    const sel = view.selection;
    if (!sel) return fail("no_selection");
    if (busy) return fail("busy");
    if (kind === "dashboard" && sel.machine !== null) return fail("remote");
    if (platform() === "windows" && sel.machine === null) return fail("unsupported_platform");
    busy = true;
    const gen = generation;
    try {
      // 1. Re-read everything the selection was bound to. The focus is NOT part of it: the person chose a row, and focus is only a hint.
      let spaces, machines;
      try { spaces = host.spaces(); machines = host.machines(); } catch { return fail("host_unavailable"); }
      if (!Array.isArray(spaces) || !Array.isArray(machines)) return fail("host_unavailable");
      const space = spaces.find(s => s && s.id === sel.spaceId);
      if (!space || (space.machine ?? null) !== sel.machine) return fail("changed");
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
      // 3. The effect.
      if (kind === "dashboard") {
        const got = await run(FIXED.ui, { cwd: sel.root });
        // No stale check here: the dashboard was already requested, so reporting "stale" would misstate what happened.
        if (!got.ok) return fail("read_failed");
        if (got.result.code !== 0) return fail("cli_failed");
        // The output is never returned, logged or stored. If it holds a link, ahub could not open one.
        return /https?:\/\//i.test(String(got.result.stdout)) ? fail("link_printed") : { ok: true, opened: "dashboard", machineLabel: sel.machineLabel };
      }
      const before = new Set((space.tabs ?? []).map(t => t.id));
      try { host.run("tab.new", { space: space.id, folder: sel.root, argv: [PROGRAM, ...FIXED.console], name: tabName(sel.root) }); }
      catch { return fail("host_refused"); }
      // `run` returns null whatever happened, so the result is learned only by re-reading. There is no retry: a second request could open a second console.
      let after;
      try { after = host.spaces().find(s => s && s.id === space.id); } catch { return fail("unconfirmed"); }
      const added = (after?.tabs ?? []).find(t => !before.has(t.id));
      return added ? { ok: true, opened: "console", tab: added.id, machineLabel: sel.machineLabel } : fail("unconfirmed");
    } finally { busy = false; }
  }
}

/** A tab's name is display text, never code, but keep it short and free of control characters. */
export function tabName(root) {
  const base = String(root).split("/").filter(Boolean).pop() ?? "project";
  return `ahub: ${base.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40)}`;
}
