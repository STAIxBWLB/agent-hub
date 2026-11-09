# agent-hub companion for Orca (optional)

Task O1 of [#1198](https://github.com/STAIxBWLB/agent-hub/issues/1198), on the frozen
[O0 host contract](host-contract-v1.md). **Optional and removable.** ahub and Orca each keep all
of their own functionality without it, and nothing in the ahub package depends on it: this folder is not in
the npm `files` list, and no file under `src/` refers to it.

## What it does

A panel in Orca's right sidebar lists Orca's workspaces. You select one, and it opens an
**existing** agent-hub screen for it:

| Button | What happens | Where it runs |
| --- | --- | --- |
| Open dashboard | the worker runs `ahub ui` (no other argument) with the selected folder as its working directory. ahub opens its own browser. If ahub only prints a one-time link, the panel shows an "Open the link" button; clicking it is the gesture Orca requires to open it | a short-lived child of the plugin worker |
| Open console | Orca creates a terminal in that workspace running `'ahub' 'console'` | a terminal you can see and close |
| Open family console | the same, running `'acon' 'ui'` | a terminal you can see and close |

It never approves, assigns, completes, retries, stops or upgrades anything, starts a hub, or
writes configuration. Those decisions stay in the screens it opens.

## Read-only status (O2)

"Show status" reads the selected project's public status and shows it as counts and closed words: the
agent-hub version, tasks by state, and each peer's state with its queue length and whether it is attached.
It is built by copying a closed list of fields out of `ahub status --json` (run with the folder as its working
directory and nothing else). Every free-text field in that output is never read: no task title, no peer
`doing` line, no notice, no path. The states stay distinct:

| State | Meaning |
| --- | --- |
| running | read within the last minute, every field present |
| stale | read more than a minute ago. Re-labelled from the panel's own clock when you return to it; nothing refreshes it |
| partial | the hub answered but did not report some fields; the missing ones are named and never shown as 0 |
| unavailable version | the hub answered without any field this view needs (an older agent-hub); it names the upgrade you can run, and does not run it |
| offline | no hub is running for this project; it names `ahub up`, and does not start anything |
| unknown | the reading carries no time |

**Refresh is only your click** (and re-drawing the panel when you return to it, which makes no request).
There is no poller, no timer that reads status, and no transcript or terminal output is read. The status
call re-verifies the exact workspace binding first, so a changed, missing, remote or re-pointed workspace is
refused before `ahub` runs.

**There is no terminal focus.** The [O4 recheck](host-contract-v1.md#terminal-focus-recheck-o4-2026-11-09)
on installed Orca 1.4.254 still found no documented mapping from a plugin terminal id to an
`orca terminal switch` handle, so this companion never calls `orca terminal switch`, never reads a terminal
and never replaces one. The console buttons always create a new terminal; to reach an existing one, select its
tab in Orca or run `ahub console` yourself. Verified focus stays unsupported until a mapping is proven.

## Selection is exact

A row is chosen by Orca's **workspace id**. A name or a branch only labels a row and never
selects one (two workspaces can share both). A selection binds four values: id, host id, kind and
the folder's real path on this Mac. Before every effect the worker re-reads a complete inventory and
requires all four to be unchanged. Each of these refuses visibly, with a fixed sentence, and runs
nothing: a duplicate id, a missing workspace, a truncated list, a malformed row, a changed id, host,
kind or folder (including a symlink that was re-pointed), a host that is not declared to be this Mac,
and a folder that is not a real absolute folder here.

Orca leaves a workspace's host id empty for some workspaces, and the API does not say what a given id
means. The plugin therefore runs nothing locally for a host it was not told is this Mac. In the
plugin's settings, list the host ids that are this Mac (`localHostIds`), or turn on "Treat a missing
host id as this Mac" if all your workspaces are local. Remote workspaces are never run here: the
panel shows the command to run on that host.

## Nothing is kept

No CLI output, one-time link, task text or credential is written to plugin storage, a setting, a
secret or the log. The worker's log lines are a handler name and a closed code (for example
`entry.open: missing`). The selection lives in the panel's memory only. A one-time link is held in
memory until it is used or 55 seconds pass (ahub's own expires after 60), then dropped. The worker
requests no storage or secrets capability.

## Capabilities asked for

`workspace:read` (the inventory), `workspace:write` (show the workspace), `terminal:send` (create the
console terminal; Orca requires this capability for `terminal.create`), `settings:own` (the three
settings). Nothing else: no `agent:*`, no `terminal:read`, no hooks, events or commands. A trusted
worker is full-access code that Orca runs only after you approve it, and Orca does not confine its
filesystem or child processes; the fixtures model the companion's contract, not a sandbox.

## Action counts

Counted after the workspace is selected; waiting is not an action; one click or one submitted command
is one action. These are **procedure** counts, not measured UI results (see "What is not proven").

| Journey | Baseline without the companion | With the companion (procedure) | Against the "at most two" target |
| --- | --- | --- | --- |
| Local console | 2: open a terminal in the workspace, submit `ahub console` | 2: click Open console, then select the new terminal's tab (Orca creates it in the background) | within the target, **no fewer actions** than the baseline |
| Local dashboard | 2: open a terminal, submit `ahub ui` | 1: click Open dashboard. 2 when ahub only prints a one-time link and the panel's "Open the link" click opens it; Orca's own consent prompt for an unknown web host is a further step | within the target; fewer by 1 only when ahub opens its own browser |
| Family console | 2: open a terminal, submit `acon ui` | 2: click Open family console, then select the tab | within the target, **no fewer actions** than the baseline |

Selecting the workspace is 1 action in every case, counted separately. Remote workspaces have no
companion path: the baseline applies on the remote host.

## Install and remove (explicit, in an isolated profile first)

Nothing installs or enables itself, and `ahub setup` and Orca's settings never turn it on. Check it
offline, which does not contact the app:

```sh
orca plugin validate integrations/orca
orca plugin inspect integrations/orca      # shows the access it asks for and its content hash
```

Load it as a development plugin into **an isolated Orca profile** (never your everyday one for a
first run). The isolation mechanism of your Orca build must be confirmed before launching; see
[native-receipt.md](native-receipt.md). Loading returns the authority review for code, and you approve it
with the fingerprint Orca just printed:

```sh
orca plugin dev load integrations/orca                     # prints the fingerprint and exits 3 until approved
orca plugin dev load integrations/orca --approve <fingerprint>
orca plugin list
orca plugin logs local.agent-hub-companion
```

Disable or remove it, in this order of reach:

```sh
orca plugin disable local.agent-hub-companion              # keep it installed, turn it off
orca plugin dev unload integrations/orca                   # remove the development folder
orca plugin uninstall <publisher>.agent-hub-companion      # if it was installed from a source instead
```

Disabling or removing it stops no agent, removes no worktree, edits no hub state and restores no
setting, because it never changed any. Remove its plugin folder state with the commands above only.

## Platforms and support matrix (O3)

[`support-matrix.json`](support-matrix.json) gives each combination its own verdict. A combination is
`supported` only when its receipt file exists and no longer says NOT RUN, and a test enforces that. **None is
supported today**: each leg needs a person's machines or accounts, so each is a **person-run** receipt that has
not been run. No identity check is loosened for any combination.

| Combination | Verdict | What happens | Receipt (person-run, NOT RUN) |
| --- | --- | --- | --- |
| `macos-local-desktop` | fixture only | everything above, checked against fixtures and real scripts | [native-receipt.md](native-receipt.md) |
| `remote-workspace` | unsupported | a workspace whose host id is not declared to be this Mac is refused before anything runs; you are shown `'ahub' 'console'` to run on that host; a remote loopback link is never opened locally | [receipts/remote.md](receipts/remote.md) |
| `windows-desktop` | unsupported | every workspace is refused with `unsupported_platform` and nothing runs: the entries build a POSIX-quoted command line and expect an `ahub` executable | [receipts/windows.md](receipts/windows.md) |
| `browser-or-mobile-client` | unsupported | where the client has no external navigation, no link is held or shown; it says to run `ahub ui` on the machine that runs the project. Mobile is **not** inferred from SSH reachability or from Orca offering mobile pairing | [receipts/browser-mobile.md](receipts/browser-mobile.md) |
| `linux-desktop` | unsupported | never exercised and not claimed | none |

## What is not proven

- **Native behaviour.** Everything above is checked against the O0 fake host and CLI fixtures and against
  Orca's own offline `orca plugin validate`. No call has run against a real Orca plugin host from this
  code. [native-receipt.md](native-receipt.md) is the person-run leg that records the observed actions,
  the outcome and the disable and standalone checks; until it is filled in, the action counts above are
  the procedure counts and the native result is unknown.
- **Terminal focus.** There is no focus-existing-console action. O0 found no documented mapping from a
  plugin terminal id to a `orca terminal switch` handle; O4 rechecked 1.4.254 with the same verdict.
  "Open console" always creates a terminal.
- **Remote, Windows, browser and mobile** are unqualified (O3). A browser client has no desktop external
  navigation, so there the dashboard button reports `ahub ui` to run instead of a link.
- **Security.** Approved capabilities do not confine a trusted worker. Treat the plugin as code you run.
