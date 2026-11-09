# Orca companion: native receipt (person-run leg)

**Status: NOT RUN.** This is the native open and disable receipt that #1198 O1 asks for. It cannot be
produced by code or by an agent: it needs a person to install the plugin into an **isolated** Orca
profile and use it. Until the fields below are filled in by that person, nothing in this repository
claims a native result, and the action counts in [README.md](README.md) are procedure counts only.

Do not use your everyday Orca profile for this. Do not record workspace names, folder paths, terminal
contents, one-time links or task text in this file: ids and counts only.

## Before you start (isolation)

1. Confirm how your installed Orca isolates a profile (a separate user-data directory). A pinned upstream
   source recognizes an `ORCA_USER_DATA_PATH` environment variable, but that is **not verified on the installed
   app**. Check it first: launch with a throwaway directory, confirm Orca shows none of your plugins or
   workspaces, then continue. If you cannot confirm isolation, stop and record that here.
2. Record: Orca version (`orca --version`), macOS version, ahub version (`ahub --version`).
3. Have an initialized project whose hub is running (`ahub up`), registered as a workspace in that profile.
   The companion starts nothing and bootstraps nothing.

## Steps and what to record

| # | Step | Record |
| --- | --- | --- |
| 1 | `orca plugin validate integrations/orca` and `orca plugin inspect integrations/orca` | exit codes; the access shown matches README "Capabilities asked for" (yes / no) |
| 2 | `orca plugin dev load integrations/orca`, then `--approve <fingerprint>` | approval needed (yes / no); loaded (yes / no) |
| 3 | In Settings, list this Mac's host id(s) under "Host ids that mean this Mac" (or turn on the missing-host option) | the host id Orca reports for your workspace is shown or null (state which, not the value) |
| 4 | Open the agent-hub panel | the workspace is listed and selectable (yes / no); a refusal sentence if not |
| 5 | Select the workspace, click **Open dashboard** | actions counted after selection: ___; browser opened by ahub (yes / no); a one-time link button appeared (yes / no); Orca consent prompt appeared (yes / no) |
| 6 | Click **Open console** | actions counted after selection, including selecting the new terminal tab: ___; the existing console is visible (yes / no) |
| 7 | Click **Open family console** | actions counted: ___; visible (yes / no) |
| 8 | Select a workspace, then in Orca rename or remove it (or re-point its folder) and click an entry | refused with a visible sentence (yes / no); nothing ran (yes / no) |
| 8a | Click **Show status** for the selected workspace (hub running) | the panel shows the version, task counts and peer states for the same project you selected (yes / no); no title, path or task text appears (yes / no) |
| 8b | Stop the hub yourself (`ahub down` or equivalent) and click **Show status** again | the panel says offline and names `ahub up` (yes / no); nothing was started (yes / no) |
| 8c | Leave a reading on screen for over a minute without clicking | it is labelled stale and nothing re-read it (yes / no) |
| 9 | Before disabling: note running agents, worktrees and open terminals (counts only) | agents ___; worktrees ___; terminals ___ |
| 10 | `orca plugin disable local.agent-hub-companion` | disabled (yes / no) |
| 11 | After disabling: same counts as step 9 | agents ___; worktrees ___; terminals ___; unchanged (yes / no) |
| 12 | With the plugin disabled, run `ahub console` and `ahub ui` yourself in a terminal in that workspace, and use Orca normally | both worked (yes / no); Orca unaffected (yes / no) |
| 13 | `orca plugin dev unload integrations/orca` (or uninstall) | removed (yes / no); `orca plugin list` no longer shows it (yes / no) |
| 14 | `orca plugin logs local.agent-hub-companion` before removal | the log holds only lines like `entry.open: ok` and no path, name, link or output (yes / no) |

## Terminal focus recheck (O4, person-run leg)

**Status: NOT RUN.** The 2026-11-09 read-only evidence recheck on Orca 1.4.254
left focus unsupported; no focus action was added. No terminal was switched or
driven and no plugin was loaded for that recheck. This is separate from the
native open/disable procedure above and is not native UX acceptance.

| Leg | Record |
| --- | --- |
| Exact plugin id to current same-host CLI handle mapping, workspace identity and runtime/incarnation freshness | NOT RUN; mapping unproven in installed declarations and CLI inventory |
| Focus the verified existing console in an isolated profile, without creation/replacement; count actions separately | NOT RUN; blocked until a safe mapping and guarded focus implementation exist |
| Stale, ambiguous and cross-host bindings retain the manual command and never switch another project's terminal | NOT RUN; no native focus implementation to exercise |

Use only an isolated profile and throwaway project for any later person-run
proof. Do not treat CLI inventory success as focus or UI proof. Record counts and
closed verdicts only, never terminal contents, paths, tickets or live identifiers.

## Result

- Who ran it and when: ___
- Isolation confirmed how: ___
- Overall: PASS / FAIL / PARTIAL, with the failing step numbers: ___
- Anything that surprised you: ___

The remote, Windows and mobile combinations are separate legs (O3) and are not covered here.
