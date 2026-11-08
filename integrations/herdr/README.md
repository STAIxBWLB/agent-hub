# agent-hub entry for Herdr (optional)

Tasks H1, H2 and H3 of [#1199](https://github.com/STAIxBWLB/agent-hub/issues/1199), on the frozen
[H0 contract](host-contract-v1.md). **Optional and removable.** Herdr and ahub keep working exactly as they do
today with this folder absent. It is not an ahub dependency and ahub is not its dependency: nothing in `src/`,
`scripts/` or `package.json` mentions it.

## What it does

A dialog you open on purpose. It shows the **machine and folder** of the focused space, lists that machine's
registered ahub projects (`ahub projects --json`, read on that machine), marks the ones that contain the folder, and
waits. Nothing runs on open except that one bounded read, and nothing opens until you **select a row**. A single
matching project is only a default you still select.

For the selected project:

- **Open console** opens one new tab in that space running `ahub --project <id> console` with the project root as the tab's
  folder, so Herdr starts it on that space's machine. The hub must already be running.
- **Open dashboard** (this computer only) runs the existing `ahub ui` from the project folder. Its output is dropped:
  a printed link or one-time ticket is never kept, shown or rewritten. If ahub printed one, the entry says so.
- **Copy command** puts `ahub --project '<root>' console` on the clipboard, quoted as one shell word, for you to run
  on the machine named in the dialog. It runs nothing. This is the route for a remote project's dashboard too.
- **Status** (H2) reads `ahub --project <id> status --json` from the project folder on that machine, on your click only,
  and shows a small card of text: the hub version, task counts per state, and for each peer its state and queue length
  (`queue 0` when the hub reported none waiting, `queue ?` when it gave no usable count, so the two are never confused). Nothing
  else from ahub's output is read, so no task title, note or private-task text can reach it, and the hub's reported
  folder must equal the selected root, as for the open actions. Missing CLI, timeout, exit error, no hub running,
  too-large output, unrecognized output, an old hub, a partial reading and a stale one (older than 60 s, judged on the
  entry's own clock) are each a different state with a fixed sentence. Nothing refreshes it for you.
- **Focus console** and **Peek console** (H2, this computer only) look through Herdr's live terminals with
  `hc get <address> --json` and accept a terminal only when its foreground process is `ahub [--project <root|id>]
  console` for the selected project, exactly one matches, and it still matches on a second read. The space and its
  machine are then read once more with nothing awaited before the one `pane.focus` or `terminal.peek`, so a space that
  moved in the meantime refuses. A focus is believed only after Herdr's `focused()` shows it. If no console is found
  you are told so and **nothing is started, replaced or closed**: use Open console. Herdr's working, blocked, done and
  idle word for that terminal is shown to you as Herdr's observation and is never sent to ahub.

Every command that acts on the project names it by registration id (`--project <id>`, before the command), so a project
with a custom state directory is read from the state directory it registered, not assumed to use the default. Before
every effect it re-reads the space, the machine, the registrations, and runs `ahub --project <id> status --json` from the
project folder to prove the registration still owns that folder (the hub's reported folder must equal the selected root)
with a running hub. The space and its machine are read once more immediately before the tab or `ahub ui` is requested,
because the reads before it are awaited: a space that moved to another machine in the meantime refuses, and nothing opens. A changed,
replaced, moved, duplicate or unknown project, an unready machine or a hub that is not running each refuse with a
fixed sentence and open nothing. It never starts, stops, restarts or upgrades anything, and never touches tasks,
reviews, approvals, roles, budget or memory. There is no polling and it keeps no state.

## What it will not do

Run anything on this Mac for a remote space. Put a project path in a command line. Resolve a remote path locally.
Open or convert a remote loopback link. Focus, replace, restart or close an existing terminal (existing-terminal
focus is unbuilt until a Herdr terminal can be mapped to an ahub console, see the contract). Raise the `exec`
limits (30 s, 8 MiB). Edit your layout, settings, keys or other mods.

Native focus rests on one observed fact: real herdr-core 0.1.18 reports a console typed into a Herdr shell with the
foreground argv `bun <path>/ahub [--project X] console`. A console started another way (a wrapper script, a different
runtime, an alias that renames the program) is not recognized and falls back to Open console. That is a safe miss, not a
claim that no console exists.

## Install (additive, by you)

Herdr has no install command: a mod is a folder. Use a scratch home first.

1. `HERDR_APP_HOME=/some/scratch/dir` with `mods/` inside it, copy this `mod/` folder to `mods/ahub`, and run
   `herdr-app check <scratch>/mods/ahub`. It must print `check passed`.
2. For your real profile: copy `mod/` to `~/.config/herdr-app/mods/ahub`. Never overwrite a folder that already has
   that name, and read the three files first, because the mod runs programs (`ahub`) with your environment.
3. It declares `"place": "none"`, so Herdr docks it nowhere and your layout is unchanged. To open it, add a key to
   your own `keys.json` (merge, do not replace the file), for example `"global": { "alt-a": "mod.open:ahub" }`, or
   run `mod.open` with name `ahub` from the command palette. Pick a key you do not already use.

## Disable and remove

Delete `mods/ahub` (five files: `main.js`, `core.js`, `card.js`, `focus.js`, `mod.json`). Nothing else was written: no layout, settings, program or other-mod file was changed, and
`installed.json`, `seen.json` and `shared.json` are Herdr's own bookkeeping. If you added a key, remove that line
from `keys.json`. Terminals, tabs opened earlier, ahub agents and hub state are not affected, because the mod owns
none of them. What removal does to a copy that is already shown was **not observed** and is part of the
person-run [native receipt](native-receipt.md).

## Platforms and support matrix (H3)

[`support-matrix.json`](support-matrix.json) gives each combination its own verdict. A combination is `supported` only
when its receipt file exists and no longer says NOT RUN, and a test enforces that. **None is supported today**: each leg
needs a person's machines, so each is a **person-run** receipt that has not been run. No identity check is loosened for
any combination.

| Combination | Verdict | What happens | Receipt (person-run, NOT RUN) |
| --- | --- | --- | --- |
| `macos-local` | fixture only | everything above, checked against fixtures and the real `hc` and `herdr-app check` in scratch homes | [native-receipt.md](native-receipt.md) |
| `remote-space` | unsupported | designed to open the console in that machine's space and read on that machine; the dashboard and focus refuse. No remote machine is configured here, so nothing remote was ever run | [receipts/remote.md](receipts/remote.md) |
| `windows` | unsupported | every action refuses with `unsupported_platform` and nothing runs | [receipts/windows.md](receipts/windows.md) |
| `linux` | unsupported | never exercised and not claimed | none |
| `browser-or-mobile` | unsupported | Herdr names no such client for mods. Mobile is **not** inferred from SSH reachability or a machine being ready | [receipts/browser-mobile.md](receipts/browser-mobile.md) |

How the journeys compare with the H0 baseline is in [baseline-comparison.md](baseline-comparison.md): procedure counts only,
none observed, and no action-count gain is claimed.

## Platforms (summary)

macOS and Linux paths only. On a Windows window every action refuses (`unsupported_platform`) and nothing runs,
because the folder and quoting rules here are POSIX and no Windows leg exists. A remote space needs a machine that
Herdr lists as ready and a native receipt (H3). Mobile is not claimed and is never inferred from SSH reachability.

## What is and is not proven

Proven by tests against the H0 fake host (`test/herdr-companion-entry.test.ts`): the selection and refusal rules,
fixed argv only, the special-character and remote cases, output handling, rapid switches, no retry, no link kept, no
runtime mention. Proven with the real host: `herdr-app check` accepts the files in a scratch home (it caught a
`structuredClone` the host runtime lacks). **Not proven:** that the dialog opens and looks right in a window, that the card renders legibly, that Focus really moves keyboard focus to the console's pane in a window (the fixture proves the decision and the re-read, not Herdr's behaviour), that
`mod.open` opens it, that `tab.new` with `argv` starts `ahub console` as intended, any remote machine, and what
disabling does to a shown copy. Those are the person-run receipt, and the action count below is a procedure count.

| | Baseline (no mod) | With the entry | Observed |
| --- | --- | --- | --- |
| Local console, after the project is chosen | 2: new tab, submit `ahub console` | 1 click on Open console (plus 1 to open the dialog and 1 to select, counted separately) | not run |
| Local dashboard | 2: new tab, submit `ahub ui` | 1 click on Open dashboard (same separate steps) | not run |
| Remote console | 2 on that machine's space | 1 click, or Copy command and paste | not run, no machine configured |
| Go to an existing local console | find it among tabs, then click: not countable, depends on how many tabs | 1 click on Focus console (plus the separate open and select steps) | not run |
