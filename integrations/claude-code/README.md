# Optional Claude Code hub companion

C1 of [#1338](https://github.com/STAIxBWLB/agent-hub/issues/1338), amended 2026-11-09. Support: **fixture_only**. Terminal native receipt: **NOT RUN**. Declared API provenance is Claude Code 2.1.319, not a supported or minimum-version promise. The separate [C0 contract](host-contract-v1.md) keeps all seven capability questions unproven or unsupported.

# What it does

- `/hub` toggles a native host pane and requests a bounded read.
- `/hub refresh` requests a read. Events within 1000 ms coalesce or wait for the next eligible event; no timer retries them.
- `/hub console` prints one shell-quoted `ahub --project '<root>' console` command for a separate terminal. It opens nothing.
- Session start, main turn completion and completed agent-hub tools can refresh. No idle polling, clock timer or delivery hook.

Only the person's `origin.kind: composer` command can touch the pane or request a read. Other origins return the same text with no host calls. The mod observes tool and turn results without changing them. It has no channel, prompt, model, approval, task mutation or lifecycle command.

Each public read checks the session's canonical real root and its one owning `projects --json` registration. Status must report that exact root and project id. Changed, missing, duplicate or mismatched registrations refuse visibly. No project, node or cwd fallback is selected.

The pane shows only public peer ids/states/counts, optional attachment and needs-review counts, task-state counts and board ids/public titles/states. A `[pii]` row shows id only. It discards detail, notes, doing, paths, logs and review bodies. Budget/permission/held-delivery details and role assignment lack a proven public shape in C0 and are named unavailable; current CLI output can therefore be **partial**, never assumed complete or zero-filled. The board is a bounded public overview, not an assignment claim.

The displayed states distinguish running, partial, stale (over 60 seconds at render time), offline, unavailable version, unknown and fixed transport failures. There is no timer to redraw an idle pane; age is checked when the host draws it.

# Isolated person-run installation

No install or live profile was exercised in C1. First use a scratch project and explicit isolated HOME and CLAUDE_CONFIG_DIR, with no credentials copied. In that isolated terminal, start a Claude session with `claude --plugin-dir <absolute path to this folder>`. This is a separate optional mod, not the agent-hub channel plugin or a marketplace entry.

The command-line declaration kit says that flag loads the mod for that session only. Removing that flag and exiting the scratch session removes it; for an installed copy, use the existing `claude plugin disable agent-hub-companion` / `claude plugin uninstall agent-hub-companion` commands in that same isolated profile. Do not change the real profile to qualify this fixture-only build. Record observed commands and outcomes in [terminal receipt](receipts/terminal.md) before claiming support.

# Checks and limits

The shipped host declaration SHA-256 is pinned in [host-contract-v1.json](host-contract-v1.json). It is supplied outside this repo and never copied into Bun's global types. The module uses its declared `Register`, `origin.kind`, `turn.complete`, `session.root`, `fs.stat`, `process.run`, `state` and pane APIs. No host API signatures are invented locally.

Reads use exactly `ahub --project <literal root> projects|status|board --json`, with cwd the same root and 5000 ms timeout. `process.run` declares a 4 MiB cap **per stream**; it has no caller byte-limit option. This adapter rejects truncation and more than 262144 combined UTF-8 bytes before parsing. It does not claim that the host stops producing at 262144 bytes. Rows are bounded at 256 and public scalars at 240 characters. A host rejection after the timeout is classified by elapsed time; a structured ENOENT is missing CLI; an unclassified rejection stays unknown.

Only the last closed projection goes to per-session `$.state`. No raw CLI output, root, ticket, link or credential is persisted. No `$.store`, settings, logs or refresh timers are used. `/clear` retires pending reads while retaining the established project root and registration id; it starts no read itself, and later permitted composer/turn/tool events can refresh without another session start. Other session ends disable the controller. Held responses cannot publish after clear or disable. Native unload/removal behavior remains person-run NOT RUN; this mod declares no unload hook. Channel plugin, peers and standalone hub have no import or runtime dependency on this folder.

`test/claude-code-companion-status.test.ts` runs a fake host and the C0 fake CLI, including literal shell-metacharacter roots, registration refusals, output bounds, closed fields, non-composer effects, coalescing and held-response races. These checks and static validation are source evidence. Native painting, real command origins, process error encoding, action counts and disable independence remain person-run NOT RUN. See [support matrix](support-matrix.json).

Static installed-CLI validation (`claude plugin validate --json`) on an isolated copy passed with zero manifest or hooks errors. Author/icon warnings and marketplace-install advice remain; marketplace distribution is outside C1. This is static module validation, not an installed plugin, host test session or native receipt.
