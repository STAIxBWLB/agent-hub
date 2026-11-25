---
id: cli-output
type: module
title: CLI Output Standard v1
status: draft
parent: agent-hub-architecture
references: [agent-hub-architecture]
covers: [cli-output]
tags: [agent-hub, cli, contract]
paths:
  - src/cli/output-standard.ts
  - src/cli/console-state.ts
  - src/cli/output.ts
  - test/cli-output-conformance.test.ts
---

# CLI output standard v1

The canonical standard is the first-party package's [standard-v1.md](https://github.com/STAIxBWLB/cli-output/blob/v0.1.3/docs/standard-v1.md). The notes below describe the hub's implementation and compatibility boundaries. The hub uses shared Report primitives, paint and wrapping. A fallback preserves legacy code-point splitting and non-positive widths pending [cli-output issue 36](https://github.com/STAIxBWLB/cli-output/issues/36); the existing table stays local pending [issue 37](https://github.com/STAIxBWLB/cli-output/issues/37).

Version 1. This is a contract for the `ahub` family and every CLI under development; a change to it bumps the version. It is committed under the design-spec vocabulary as `type: module` because `ahub specs check` accepts only goal, architecture, module and submodule (issue #1484 asked for `type: contract`; the validator's fixed vocabulary wins, and the `contract` tag marks the intent).

## Why

`dot` already has an output contract: a `Printer` with a fixed blank-line, indent and stream policy (`internal/cli/printer.go`), a semantic marker alphabet (`internal/ui/markers.go`) and one set of style roles (`internal/ui/prompt.go`). Most other CLIs format output ad hoc. Reading `ahub` 0.39.0 on 2026-11-14:

- `ahub status` prints about 85 lines with no section titles. Problems (refused agent versions, failed deliveries, unbound memory) sit between plain facts with the same weight and no marker. Peer detail rows repeat the peer name as a key (`  claude form  tui`, `  claude flow roles  ...`).
- `ahub doctor` prints `ok` / `fail` / `unknown` as words in a LEVEL column, interleaves fails with oks, and on a piped run one long CHECK cell (a profile path) pushes the FINDING column about 130 characters right. There is no summary line, and it exits `0` with four `fail` rows.
- `ahub help` fits 80 columns but is one long wall: each command form carries a multi-line description at a 34-column indent.
- Headings, ids and table headings all share one cyan.
- `ahub task show <missing id>` prints `No task #N` to stdout and exits `0`.

What `ahub` already does right and keeps: `--color=auto|always|never`, `NO_COLOR` and `TERM=dumb` (`resolveColor`), terminal-text sanitizing, width-aware wrapping, `--json` on most read commands.

Normative parts of this standard: streams and exit codes, color policy, roles, markers, layout grammar, messages and help. Progress and the per-language notes are guidance.

## Principles

1. Meaning never rides on color alone. Every state has a glyph and a word; color only reinforces them. Output reads correctly with `NO_COLOR=1`, in grayscale and to a screen reader.
2. Problems first. Anything that needs action is shown before facts, marked, counted, and paired with the exact next command.
3. One grammar. Header, section, key/value row, bullet row and table look the same in every command and every CLI.
4. Calm by default. The default view answers "is it OK, and what do I do next". Detail moves behind `--verbose` or a subcommand.
5. Humans on the terminal, machines on `--json`. Human output may change between versions; `--json` is the stable interface.

## Streams and exit codes

- stdout: the result the person asked for, including a report's findings, its Attention section and its summary line, and `--json`.
- stderr: diagnostics about this invocation (errors, warnings about how the command ran, progress). Library or debug logs (for example Go `slog` INFO lines) never reach the terminal by default; they need `--verbose` or a log-level setting.
- Exit codes: `0` success; `1` the operation failed, a lookup found nothing, or a check found a failure; `2` usage error (unknown command or flag, bad argument); `75` is reserved for "temporary refusal, retry later" (EX_TEMPFAIL, as `dot remote` uses) and used only where a CLI already has that case.
- A view command (`status`, `list`, `show`) exits `0` when it could produce its view, even if the view lists problems. A check command (`doctor`, `check`, `lint`) exits `1` when any row is a failure; warnings and unknowns do not change the exit code.
- `--json` on a report command writes one JSON document to stdout and never contains an ANSI escape. Streaming commands may write JSON lines when documented. Documented bounds (for example "the last 1000 events") are allowed; human-output truncation never applies to `--json`. New timestamp fields use ISO 8601 UTC strings; existing fields keep their format.

## Color policy

Color is decided per stream (stdout and stderr separately), in this order; the first rule that applies wins:

| # | Condition | Color |
| --- | --- | --- |
| 1 | `--color=never` / `--color=always` | off / on |
| 2 | `NO_COLOR` is set and non-empty | off |
| 3 | `FORCE_COLOR` is set, non-empty and not `0`; or `CLICOLOR_FORCE` is set, non-empty and not `0` | on |
| 4 | `FORCE_COLOR=0` or `CLICOLOR=0` | off |
| 5 | the stream is a TTY and `TERM` is not `dumb` | on |
| 6 | otherwise | off |

- Every command that prints accepts `--color=auto|always|never` (`auto` = rules 2 to 6).
- `--json` output is never colored, whatever the rules say.
- Normative colors are the 16 ANSI colors in the role table. They follow the terminal's own theme, so they stay readable on light and dark backgrounds. A CLI may ship an optional truecolor theme (dot's Tokyo Night hex values, below) only behind an explicit setting, and only with a light and a dark variant per role that reaches 4.5:1 contrast on its background (3:1 for `hint`), checked by a test.
- Bold is reserved for the header, section titles and the status roles (`success`, `warning`, `error`). No background colors.

## Semantic roles

The roles are the API. Code names a role, never a raw color or SGR code.

| Role | Use | ANSI (normative) | Bold | dot hex (optional dark theme) |
| --- | --- | --- | --- | --- |
| `header` | report title | blue (34) | yes | `#7AA2F7` |
| `section` | section titles | magenta (35) | yes | `#BB9AF7` |
| `key` | key/value labels, table headings | blue (34) | no | `#7AA2F7` |
| `value` | values, emphasized list items | default foreground | no | default foreground |
| `success` | done, healthy, enabled | green (32) | yes | `#9ECE6A` |
| `warning` | attention needed, non-fatal | yellow (33) | yes | `#E0AF68` |
| `error` | failure, refusal, non-zero exit | red (31) | yes | `#F7768E` |
| `hint` | secondary text, unset, unknown, timestamps | bright black (90) | no | `#565F89` fails 3:1 on dark backgrounds; a theme must lighten it |
| `accent` | ids, refs, commands to copy | cyan (36) | no | `#7DCFFF` |

- `hint` text is never the only place a fact appears that the person needs; bright black is faint on some themes.
- A CLI may add identity colors for its own entities (ahub's per-peer palette) and underline for links, as long as they never reuse a status role's meaning.

## Marker alphabet

Glyphs are semantic; each pairs with one role. Code uses named constants, never inline glyph literals. A bullet row always carries the state word or the finding text beside the marker, so meaning survives without color.

| Marker | Glyph | ASCII | Role | Meaning |
| --- | --- | --- | --- | --- |
| `ok` | `✓` | `ok` | `success` | exists, succeeded, enabled, healthy |
| `fail` | `✗` | `x` | `error` | hard failure, refused |
| `warn` | `⚠` | `!` | `warning` | attention needed, non-fatal |
| `absent` | `-` | `-` | `hint` | missing or disabled, not a failure |
| `unknown` | `?` | `?` | `hint` | not measured, not reported |
| `pending` | `~` | `~` | `hint` | queued, not yet applied, diff |
| `active` | `*` | `*` | `success` | active or default choice |
| `next` | `→` | `->` | `accent` | the next step to run |

- A CLI may add markers for states of its own, each with a role from the table, a glyph not used above and an ASCII form, listed in its own marker constants.
- ASCII forms are used when the locale is not UTF-8 (`LC_ALL`, then `LC_CTYPE`, then `LANG`) or with `--ascii`.
- Width: the marker column is always 2 cells wide, padded with spaces (ASCII `ok` and `->` fill it). East Asian Ambiguous characters are measured as 1 cell (`Bun.stringWidth(s, { ambiguousIsNarrow: true })`, `unicode-width` non-CJK), so Korean and CJK terminals keep the same alignment.

## Layout grammar

- **List views** (#1654 T3): `projects`, `queue`, `turns` and the orphan views build a `LayoutReport` with `listReport`: header, one counted section holding the table, a bare one-line empty state (no header or section, as `ahub board`) and `next` steps. `--json` is unchanged.
- **SDLC reports** (#1654 T3): `sdlc authorize-release`, `sdlc merge`, `sdlc status`, `sdlc explain`, `sdlc queue`, `sdlc audit show`, `sdlc release`, `sdlc metrics` and `sdlc costs` build a `LayoutReport` (header, one section per topic, `kv` rows, a marker bullet per refused gate, blocker or unit, and tables placed with `append`). `--ascii` reaches them through the same `asciiMarkers` call as `status` and `doctor`. A long repository name that does not fit the header moves to a wrapped line under it, and `kv` stacks a value under its key when fewer than 10 cells would remain beside the label. `sdlc status` and `explain` (`lifecycleView`, `taskBlock`) are on it too, with one section per task.
- **Status and report** (#1654 T3): `status --verbose`, `status --full` and `report` use the shared header and section marks (`Hub`, `Peers`, `Models`, `Tasks`; the report's own sections), and every detail line keeps its text. A header whose context does not fit the terminal moves the context to a wrapped line under it. #1654 T4 runs the layout grammar (header first, one blank line before each section, no trailing blank, no line wider than the terminal at 24, 40 and 80 cells, and `--ascii` swaps every glyph) over the real output of each converted view in `test/cli-output-conformance.test.ts`.
- **Header**: one line, ` <tool> <Report>` in `header`, followed on the same line or the next by one line of context in `hint` (version, pid, endpoint, project path). One per report. Never in `--json`.
- **Header fit** (#1654 AC3): the header line does not wrap, and one `Report.titled(tool, name, context?, inline?)` decides where the context goes. A context that fits stays on the header line (two spaces after the name, or one space with `inline`, as in `ahub Merge queue owner/repo`). One that does not moves to a wrapped note under a short header, and a name too wide for any header keeps its first word there and repeats in full on the wrapped line. Without a wrap width nothing moves. `fitHeader`, `titled` and the lifecycle header no longer exist as copies.
- **Task, backlog, release, configuration and survey views** (#1654 AC3): `task show`, `task cancel`, the backlog results, `backlog groom`, `release list|show|new|plan|...`, `sdlc configure` and `sdlc survey show` build a `Report` (header, one `▸` section per group, `kv` rows, `warn` bullets, tables from the one `grid`). `sdlc-output.ts` and `task-output.ts` no longer define their own wrap, pair, bullet or heading helpers; `grid` in `sdlc-output.ts` is the one table helper every Report-based view calls.
- **The last eight output files** (#1654 AC3 close-out): `source add|list`, `schedule list|run|pause|resume`, the `study` views (list, show, receipts, experiments, evidence, readiness), `task handoff` and `board --handoffs`, `learn`, `intake`, `capabilities` and `worktrees` (list, tidy, tidy --confirm) build a `Report` with a header (`titled`), one `▸` section per group, `kv` rows, `warn` bullets and `grid` tables, and take a trailing `ascii`. An empty list stays one bare line, as `ahub board` prints it. `sdlc-output.ts` no longer exports `heading`, `pair` or `blank`; `pair` and `blank` survive only as the private narrow-table block layout of `grid`. A long command to copy is a wrapped note, not a `next` line, so no view passes the width at 24 cells.
- **Section**: one blank line, then `▸ <Name>` (ASCII `> <Name>`) in `section`, optionally followed by a count in `hint`: `▸ Peers (4 of 10 online)`. No blank line after it.
- **Key/value row**: two-space indent, `Key:` padded to the widest key in that section, two spaces, value. A key wider than 28 cells wraps its value to the next line at a four-space indent. An empty value is `(unset)` in `hint`. Keys are words, never repeated entity names: under a peer heading write `form`, not `claude form`.
- **Bullet row**: two-space indent, the 2-cell marker, one space, text: `  ⚠  codex-review 0.169.0 refused`. Nested detail uses four spaces; a next step is `    →  ahub agents trust codex-review 0.169.0`.
- **Table**: headings uppercase in `key`, two-space gutter, no borders. One flexible column (the free text) wraps; id, state, count and time columns never wrap. Every non-flexible text column is capped at 32 cells whether or not the output wraps, so one long cell cannot push the others off; a path longer than its cap shortens in the middle (`~/Library/.../home`), other text wraps inside its column. Empty cells are `-` in `hint`; a column that is `-` on every row is dropped.
- **Summary line** (check commands): the last line of stdout, `✗ 2 failed  ⚠ 3 warnings  ✓ 18 ok`, zero counts omitted, unknowns counted as `? 2 unknown`.
- **Blank lines**: exactly one before each section, none after; never two in a row; no trailing blank line.
- **Width**: on a TTY, wrap to the real terminal width. On a pipe, wrap only when `COLUMNS` is set; column caps still apply. Human output never truncates without `...` and a way to see the full value (`--json`, `--verbose` or a `show` subcommand).

## Messages

- Error line (stderr): `<tool>: <what failed>: <why>`. When stderr is a TTY it is prefixed with the `fail` marker (`✗ ahub: ...`); piped stderr keeps the plain form, so scripts and agents that match `<tool>: ` keep working.
- Next step: when the CLI knows the fix, a second line `  → <command or setting>` (ASCII `  -> `), complete and copyable (`cd` prefix and every value filled in), in `accent`. An error raised by a server or daemon that carries no fix prints no `→` line; the CLI never invents one.
- Warning (stderr): `<tool>: warning: <what>: <why>`, `warn` marker on a TTY, optional `→` line.
  In ahub, `warn()` in `main.ts` and `warnLine()` in `src/cli/warn-line.ts` print it through `warningLines` (`src/cli/error-format.ts`). A raw `console.log` or `console.error` in `src/cli` that bypasses Report, `printOutput`, `errorLines` or the warning printers is allowed only while `scripts/cli-raw-output.baseline.json` lists it with its reason; that list can only shrink, and `test/cli-output-conformance.test.ts` fails on a new call and on a stale entry.
- Success confirmation (stdout): `✓ <what was done>`; omit it when the output already shows the result.
- Usage error: the message, then `Usage: <tool> <command> <args>` and `Run '<tool> help <command>' for details.`, exit `2`.
- Plain English sentences, no emoji, no exclamation marks. Relative times in human output (`47d ago`, `in 5d15h`).

## Help

- `<tool> help`, `-h` and `--help` print to stdout and exit `0`: command groups, each command as `  <name>  <one-line summary>` in two aligned columns, within 80 columns.
- `<tool> help <command>` shows usage, a short description, each flag with one line, and one or two examples. Long explanations live here, not in the overview.
  - `ahub` lays it out as `▸ Usage` (every form), `▸ Description` (the overview summary), `▸ Flags (N)` (one line per flag: the flag with its value shape as the usage writes it, then what it is for), `▸ Examples` (one or two complete commands, only for a command that takes arguments) and `▸ Details`, which is the long text, every form with its whole description, unchanged, so nothing a form or flag says is lost. A section with nothing to show is omitted.
  - A flag's line says what the flag is for, in one short line (at most 46 cells beside its label, so it fits 80 columns; `--json` and `--color` keep the longer text this standard defines). The words sit in `FLAG_DESCRIPTIONS` in `src/cli/help.ts`, next to the usage text, keyed by the flag or by `<command> <flag>` where one command uses a flag for something else (`--all`); a flag a definition outside that file adds falls back to the forms that take it. `test/help.test.ts` fails a flag of any command with no description, a line over the width, or a table entry that names no flag. A flag's meaning that only the long text states stays in `Details`. Every example is checked against the dispatch table and the command's own usage by `test/help.test.ts`, so it cannot name a command, subcommand or flag that does not exist.
  - A native agent's overview summary is the third element of its `cli.usage` entry in its adapter definition, never a table in the help module.
- Usage lines use `<required>`, `[optional]`, `a|b` and `...`. A placeholder is `<lowercase>`, never a bare uppercase word (`<n>`, `<hash>`, `<ms>`, `<json>`, `<token>`). A line breaks only between bracket groups, and a group that fits on a line stays whole; a group wider than the line is the one case broken inside it. Details names each form by its leading words and says what it does; it does not repeat the usage that the Usage section already prints whole.

## Progress (guidance)

- Spinners or progress bars only when stderr is a TTY and color is on; never on a pipe, in CI or with `--json`. Without a TTY, print one line when a long step starts and one when it ends, with its duration. No carriage-return redraws in output that may be logged.

## Conformance checks (every CLI)

1. A golden test of the main report with color off, and one with `--color=always` asserting the roles map to the ANSI codes above.
2. `NO_COLOR=1` with `--color=auto` emits no ESC byte; `--json` never contains ESC; `FORCE_COLOR=1` on a pipe emits color.
3. At 80 columns no line exceeds 80 cells and no id or state column wraps.
4. A failing command exits non-zero with `<tool>: ` on stderr, and a usage error exits `2`.
5. `LANG=C` prints the ASCII markers.

## Per-language notes (guidance)

- Go: lipgloss v2 as dot uses it; lipgloss downsamples colors itself, so define roles with ANSI colors and add a theme only per the color policy. Disable its CLICOLOR handling only if it disagrees with the table above.
- TypeScript / Bun: a small zero-dependency module (role to SGR map, marker table, color resolution, `paint`). `ahub` grows its existing `Tone` / `PALETTE` / `paint` in `src/cli/console-state.ts` instead of adding a dependency.
- Rust: `anstyle` + `anstream`, and clap's `styles()` set to the same roles for help.
- Python: `rich` or `click.style`, gated by the same policy.

## Implementation in ahub

`src/cli/output-standard.ts` is the one module that holds the standard's portable executable form. It imports nothing, so a CLI outside the hub (or a shared package for the Bun family) can reuse it as a file move: `Role` and `ROLE_SGR` (the nine roles), `TONE_SGR` (the console tones that are not an identity palette entry), `MARKERS`, `markerCell`, `SECTION_MARKER`, `cellWidth`, `resolveColor` with `streamEnv` (the precedence table, per stream) and `asciiMarkers` (`--ascii` and the non-UTF-8 locale fallback). `src/cli/console-state.ts` keeps `Tone` and `PALETTE` (mapped onto the roles through `TONE_ROLE`; a tone with no entry names an identity color, never a status), re-exports the style names, lets a `Span` carry a `role` (it wins over its `tone`) and holds the `Report` builder for the layout grammar. `test/cli-output-conformance.test.ts` runs the five conformance checks and fails on a raw SGR literal in `src/cli/` and `src/hub/` outside `src/cli/output-standard.ts`, `src/cli/console.ts` (the full-screen console) and the identity palettes (`src/ui/peer-palette.ts`, `src/adapters/definitions/native-display.ts`).

## Adoption

This issue holds the canonical v1 text. The first `ahub` PR commits it as `docs/design/cli-output.md` (design spec frontmatter, `type: contract`); later changes amend that file with a version bump. Each other repository gets its own issue that links here and lists its gaps; it is done when the five conformance checks pass. dot's style is the reference for the look, and dot gets its own conformance issue like every other CLI.

## Command and renderer inventory

The [2026-11-25 inventory snapshot](cli-output-inventory.md) joins the built-in
dispatch keys, native adapter commands and rendered help. Refresh the snapshot with
`bun scripts/cli-output-inventory.ts --write` and compare it with the current checkout using
`bun scripts/cli-output-inventory.ts --check`. The comparison runs once per gate as
`scripts/check.sh`'s `cli output inventory` step, so a help or renderer change that ages the
snapshot fails the gate instead of waiting for review. A newer checkout may differ from
the dated snapshot as help and renderers change.

- Help at 80 columns spans 90 dispatch entries and 92 documented command words.
  The overview lists `backlog` and `check-path` once each. The global
  `--project` and `--live-test` forms account for the two help-only words.
  Detailed help includes examples for `version`, `kill`, `down` and `tail`.
  Details no longer repeats the usage, operands are lowercase `<placeholders>`
  and a usage line breaks only between bracket groups (hub task 1114).
- The roadmap usage error for `ahub roadmap new ... --json` names all four
  read operations that accept JSON (`list`, `show`, `check` and `export`).
  JSON support and exit status are unchanged.
- Human report layout is mixed. Doctor uses the shared report primitives but
  starts at its first section. Detailed status and project-list output still
  use their earlier layout. The CLI renders structured task tool results,
  while a non-JSON reply falls through as daemon text via `showToolText`.
  T3 should keep raw export, stream events, and completion payloads separate
  from human report formatting. Inspect daemon text case by case before
  changing any transport response.
- The direct-call table includes JSON and stderr sites. The renderer source
  scan records whether the CLI or hub authors each named renderer and
  measures representative host-free output. It labels helper-only, console
  and dashboard rows separately. The inline table measures direct literal
  output by source location and stream. Interpolated output and daemon
  pass-through branches still need end-to-end fixtures before T4 can claim
  conformance.

## Acceptance criteria (this repository)

- AC1: `docs/design/cli-output.md` holds this standard. `src/cli/console-state.ts` exposes the nine roles and the marker table; `Tone` stays as the TUI's vocabulary through a mapping onto roles. A test fails on raw SGR literals in `src/cli/` and `src/hub/` human-output code outside `console-state.ts`, with an allowlist for the identity palettes (`src/ui/peer-palette.ts`, `src/adapters/definitions/native-display.ts`) and the full-screen console (`src/cli/console.ts`).
- AC2: `ahub status` default view: header, then an `Attention` section listing every item that needs action as marker + text + `→` next step, then sections for the hub, peers and tasks, with plain keys in peer detail. The current full detail stays available behind `--verbose`. `--json` unchanged; exit code unchanged (`0`).
- AC3: `ahub doctor`: marker + check + finding rows, failures then warnings then unknowns then oks within each section, capped CHECK width, a summary line. Behavior change, named in the CHANGELOG: `doctor` exits `1` when any row is `fail` (it exits `0` today). `ahub setup` keeps its own exit behavior (it calls the doctor function, not the process exit). `--json` unchanged.
- AC4: `ahub help` overview uses one-line summaries; the long text moves to `ahub help <command>`. Every command, subcommand and flag still appears, and the help-vs-`main.ts` check keeps passing.
- AC5: the shared `fail()` helper in `src/cli/main.ts` prints the error line format (marker only on a TTY, plain `ahub: ` on a pipe) and accepts an optional next step. Behavior changes, named in the CHANGELOG and with their tests updated in the same PR: usage errors exit `2` (they exit `1` today, for example `test/identity-cli.test.ts` and `test/structural-config-cli-process.test.ts`), and `ahub task show <missing id>` prints to stderr and exits `1`. Call sites gain a next step only where the fix is known; daemon refusal text is passed through unchanged.
- AC6: the five conformance checks run in `bun test`.

## Tasks

- T1: spec doc, roles, markers, color resolution (the precedence table, per stream, `--ascii`), conformance tests (AC1, AC6). Before moving any line in `src/cli/console-state.ts` or `src/cli/output.ts`, search `scripts/seeds.json`: 13 seeds anchor in `console-state.ts` and 5 in `output.ts`.
- T2: `ahub doctor` (AC3) and the `fail()` format and exit codes (AC5).
- T3: `ahub status` (AC2); the `planner-normal-status-wip` seed anchors in the status code this rewrites.
- T4: `ahub help` (AC4).

## Out of scope

- The full-screen `ahub console` TUI and the web dashboard (they adopt the roles when touched).
- Any `--json` schema change.

