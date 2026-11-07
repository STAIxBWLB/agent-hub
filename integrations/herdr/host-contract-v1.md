# Herdr companion host contract v1

H0 of [#1199](https://github.com/STAIxBWLB/agent-hub/issues/1199), task #793. Recorded 2026-11-07. This is a
contract and fixture baseline, not an installed mod and not a native usability qualification. H1 builds the
entry point, H2 the read-only card and terminal navigation, H3 qualifies remote and mobile. No ahub runtime change,
no mod installed, and nothing written into the person's Herdr profile. The machine-readable form is
[host-contract-v1.json](host-contract-v1.json); a test checks it against the fixtures.

## Evidence and version boundary

Installed: Herdr app **0.1.13**, herdr-core `hc` **0.1.18**, gpui-shell 0.7.1. The app writes its own type
declarations and guide into its home on every start, so those files are the truth for that version. They were read,
not edited. SHA-256 of what was read:

- `herdr.d.ts`: `5dd5388abe811467d94edf9e3427730614d581348087758f28afc26565affbe3`
- `AGENTS.md`: `429d3c9d5bfe4670ac3c7ec3b1fb8a2dd4b26b82666709ce164a17733fdd66d4`
- `gpui-kit.d.ts`: `240970545ddc115e88ed1e5ae853461371e29e8dd7f7410979334a6d71acfb7a`

A different hash means this contract has to be re-read. Primary references named by the issue:
[herdr-app AGENTS.md](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md),
[herdr.d.ts](https://github.com/herdrdev/herdr-app/blob/master/defaults/herdr.d.ts),
[herdr-core schema](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md).

What was **observed on this Mac** (all local, none through a mod):

- `herdr-app check` on a throwaway mod in a scratch `HERDR_APP_HOME` passed, and rejected an import the host does not
  export, so the check really loads a mod.
- `hc exec --json` runs argv with no shell: a literal `$HOME;x y` came back unchanged. stdout and stderr are base64.
- `hc exec` failures differ: a missing program or folder is `spawn_failed`, an unknown machine is `machine_unknown`,
  a timeout is `{code: null, timed_out: true}`, a nonzero exit is `{code: N}`. 9 MB of output returned
  `truncated: true`: for `hc` the cap is a flag the caller must read.
- `ahub status --json` run through `hc exec` in a worktree with no hub exits 1 with the plain text
  `no hub running for <root>/.agenthub/state`. From a subdirectory of a running project it reports the project root.

What was **not observed**, and so is not claimed:

- any call from a mod running inside the app (no mod was loaded into the person's profile, the window was not driven),
- `exec` through a remote machine (`hc machine ls` is empty here),
- how a timeout or an oversized output reaches a mod's `exec` promise, and what `on: ""` means for `exec`,
- a mod-visible mapping from a Herdr terminal to an ahub console or peer.

## Supported mod API surface

All from `herdr.d.ts` and `AGENTS.md`. Mods are trusted code: commands and network are unrestricted, so the
companion's limits are its own contract, not a sandbox.

| Call | Contract | Companion use |
| --- | --- | --- |
| `exec(command, args?, {cwd?, on?})` | resolves `{code, stdout, stderr}`; **30 s limit, 8 MiB output**; real user environment; `on` is a space's `machine`; rejects when it cannot start, the folder is missing or the machine is unreachable | bounded reads only: `ahub projects --json`, `ahub --project <root> status --json`. Never an interactive console, and the caps are never raised |
| `run(command, args?)` | returns `null`; most commands apply as the call returns | the only way to navigate or open a terminal. Success is learned only by re-reading `focused()`, `spaces()` or `terminals()` |
| `spaces()`, `machines()`, `panes()`, `focused()`, `terminals()` | live data. `spaces()[i].machine` is `null` for this computer. `machines()[].layout` is `loading`, `ready` or `unavailable`; structural commands fail while a machine's layout is unavailable. `focused().pane` is `null` while a layout terminal block holds focus | the selector's inputs |
| `commands()` | every app command with argument names and required flags | capability probe before use |

Commands the companion may run through `run` (argument names from `herdr-app commands`, `*` required):
`space.select {index, id}`, `tab.new {name, space, folder, argv, task, mod, props}`, `tab.select {index, id}`,
`terminal.open {argv, folder, place, name}`, `terminal.peek {terminal*}`, `pane.focus {pane, terminal}`,
`pane.split {direction*, pane, argv, mod, props}`, `agent.focus {terminal*}`, `mod.open {name*}`, `overlay.close {id}`.
Never used: `terminal.kill`, `terminal.park`, `terminal.keep`, `tab.close`, `space.close`, `pane.close`, `app.*`,
`layout.*`, `mod.clone`, `window.*`.

Rules the host states and the fixtures enforce: an unknown argument name is an error and never falls back to the
current target; target ids must be strings; implicit pane actions and `place: right|down` fail while a layout terminal
block is focused. `tab.new` and `terminal.open` take **no machine**: a tab starts on the focused or selected space's
machine, so opening a console on a machine means that machine's space is the target. `herdr-app` also has a CLI
(`do`, `ls`, `status`, `check`), but a mod uses `run`, not a subprocess of it.

## How the current pane's machine and cwd resolve to a candidate root

The pane's machine and cwd are a **navigation hint, never authority**. The authority is an ahub registration read on
the same machine. `test/helpers/herdr-root-candidates.ts` is a specification by example for H1, not shipped code.

1. No focused context, or a focused space that no longer exists: no candidate.
2. The space's machine is not in `machines()`: refused (`unknown_machine`). Listed but `loading` or `unavailable`:
   refused (`machine_unavailable`). Nothing runs and no name is mapped to this Mac.
3. Read `ahub projects --json` on that machine with `exec(..., {on: machine})`. A remote cwd is never resolved or
   tested on this Mac. Output that is not JSON, not a list, has a non-absolute root, or a nonzero exit is a distinct failure.
4. Candidates are registered roots that equal the cwd or contain it **at a path-segment boundary** (`/work/a` does not
   contain `/work/ab`).
5. One candidate is the default and still needs the person's confirmation. Several is `ambiguous`: the deepest is
   highlighted, never chosen. None: the person picks from the list, or sees the existing setup instruction. A mod pane
   has no cwd, so it has no candidate. Two registrations with the same root are `duplicate` and refused.
6. Before every effect the focus is re-read and machine and root compared again; a change refuses with a refresh
   instruction.

Ambiguities this leaves for the person, on purpose: a **git worktree** is its own project root (ahub stops at the
nearest working-tree boundary), so a pane in a worktree resolves to a root that may have no hub even if the main
checkout does; a cwd under **two registered roots**; a pane cwd through a **symlink** (`/tmp` versus `/private/tmp`)
that does not match a canonical registered root; and a cwd inside **no registration**, where ahub's own rule would use
the git root but the companion registers and initializes nothing.

## Install, disable and ownership

A mod is a folder `mods/<name>/` with `main.js` and `mod.json` under the app home (`~/.config/herdr-app`, or
`$HERDR_APP_HOME`), read live. **No install, disable or uninstall command exists** in `herdr-app --help`,
`herdr-app commands` or `AGENTS.md`. The documented path is manual and additive: copy the folder, never overwrite a
name that is taken, merge `keys.json` rather than replace it, run `herdr-app check <folder>`, and tell the person
before adding a mod that runs programs.

- The first time Herdr sees a folder it docks one copy per `mod.json` into the shown layout. `"place": "none"` docks
  nothing, so H1 ships with `none`.
- Owned: `mods/<name>/` only. Never touched: `layouts/`, `settings.json`, `programs.json`, other mods, and
  `installed.json`, `seen.json` and `shared.json`, which Herdr writes. A `keys.json` change is an additive merge the
  person approves.
- Disable is the person removing the folder. What that does to a copy already shown, or to a layout file that names
  the mod, **was not observed**; H1's native receipt must record it. A fake's immutable state is not that proof.
- Native tests use a scratch `HERDR_APP_HOME`.

## Three baseline journeys

**Procedure counts, not measurements**: the person's window was not driven, so nothing below was observed in a native
Herdr window. One chord or one submitted command is one action, and waiting is not an action. Selection is counted
separately. Start: the exact space is selected. End: the existing screen is visibly open.

| Journey | Selection (separate) | After selection | Count | Observed |
| --- | --- | --- | ---: | --- |
| Local console | 1, explicit, after machine and root inspection | new tab in the space; submit `ahub console` (with `--project <root>` when the folder is not the root) | 2 | not run |
| Local dashboard | 1, explicit local space | new tab in the space; submit `ahub ui`; any browser consent counted separately | 2 | not run |
| Remote console | 1, explicit remote space | new tab in that machine's space; submit `ahub console` there | 2 | not run, no remote machine is configured here |

H1's target is at most two explicit actions after selection (AC2), recorded in a native receipt, not inferred from
these counts.

## Unsupported or unproven

- **Existing-terminal focus** (AC5): no ahub record names a Herdr terminal address, and no mod-visible mapping from a
  Herdr terminal to an ahub console or peer was found. `run` returns `null` whatever happens and the host does not document what an unknown address does, so the fixture takes the worst case (a silent no-op) and a
  focus is believed only after `focused()` is re-read. Focus stays unbuilt until a mapping is proven. An
  explicit **Open console** (new tab) is the supported way.
- Remote console from a mod needs a configured machine and a native receipt. Remote or mobile browser dashboards have
  no proven existing route and are never a converted loopback URL. Mobile is never inferred from SSH reachability.
- Windows hosts were not exercised.

## Fixture contract and acceptance ceiling

`test/helpers/herdr-mod-host.ts` offers only the functions and commands a test lists, rejects what the host rejects,
and is **stricter than the host** in the places the host is silent (a timeout or oversized output rejects, an empty
`on` is refused, a stale `pane.focus` is a silent no-op). Those are listed under `fixtureStrictness` in the JSON, so a
green test is never read as a host fact. `test/fakes/herdr-companion-cli.ts` is a separate scripted CLI port.
`test/herdr-companion-contract.test.ts` checks special-character paths, machine loss, invalid, truncated and oversized
output, stale terminal addresses, rapid project switches, disable independence and that no ahub runtime file mentions
Herdr. A fake cannot establish installed host capabilities, terminal address equivalence, native UI improvement,
remote reachability or security confinement; those are the person-run receipts of H1 to H3.
