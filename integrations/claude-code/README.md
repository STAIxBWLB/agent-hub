# Optional Claude Code hub companion

C1 of [#1338](https://github.com/STAIxBWLB/agent-hub/issues/1338), amended 2026-11-09. Support: **fixture_only**. Terminal native receipt: **NOT RUN**. Declared API provenance is Claude Code 2.1.319, not a supported or minimum-version promise. The separate [C0 contract](host-contract-v1.md) keeps all seven capability questions unproven or unsupported.

# What it does

- `/hub` toggles a native host pane and requests a bounded read.
- `/hub refresh` requests a read. Events within 1000 ms coalesce or wait for the next eligible event; no timer retries them.
- `/hub console` prints one shell-quoted `ahub --project '<root>' console` command for a separate terminal. It opens nothing.
- Session start, main turn completion and completed agent-hub tools can refresh. No idle polling, clock timer or delivery hook.

Only the person's `origin.kind: composer` command can touch the pane or request a read. Other origins return the same text with no host calls. The mod observes tool and turn results without changing them. It has no channel, prompt, model, approval, task mutation or lifecycle command.

Each refresh makes one `status --json` read. The session's canonical real root is checked before and after it; returned `cwd` must match that root. The first valid daemon `projectId` is pinned, and later reads must match it, including after `/clear`. Root or daemon-id drift refuses visibly. Registry existence and uniqueness are **not verified**: status can still answer from a running daemon after its registration is removed. A bounded registration read would be a separate task. No project, node or cwd fallback is selected by this mod.

The pane shows only the hub version, peer ids/states/counts, optional attachment and needs-review counts, and task-state counts. It requests no board or global project inventory, and displays no task rows, titles or details, including PII rows. Task lists, role-specific task lists and registry-inventory verification are named unavailable; budget/permission/held-delivery details also remain unavailable. Current output is therefore **partial**, never assumed complete or zero-filled. Unknown status fields, including doing, paths and free text, are not copied.

The displayed states distinguish running, partial, stale (over 60 seconds at render time), offline, unavailable version, unknown and fixed transport failures. There is no timer to redraw an idle pane; age is checked when the host draws it.

# Isolated person-run installation

No Claude Code mod was installed or loaded, and no real Claude Code profile/settings were loaded or changed in C1. A separately authorized read of this project's hub status/registry is recorded only as source-CLI measurement. First use a scratch project and explicit isolated HOME and CLAUDE_CONFIG_DIR, with no credentials copied. In that isolated terminal, start a Claude session with `claude --plugin-dir <absolute path to this folder>`. This is a separate optional mod, not the agent-hub channel plugin or a marketplace entry.

The command-line declaration kit says that flag loads the mod for that session only. Removing that flag and exiting the scratch session removes it; for an installed copy, use the existing `claude plugin disable agent-hub-companion` / `claude plugin uninstall agent-hub-companion` commands in that same isolated profile. Do not change the real profile to qualify this fixture-only build. Record observed commands and outcomes in [terminal receipt](receipts/terminal.md) before claiming support.

# Checks and limits

The shipped host declaration SHA-256 is pinned in [host-contract-v1.json](host-contract-v1.json). It is supplied outside this repo and never copied into Bun's global types. The module uses its declared `Register`, `origin.kind`, `turn.complete`, `session.root`, `fs.stat`, `process.run`, `state` and pane APIs. No host API signatures are invented locally.

Read-set revision 2 supersedes the C0 fixture read candidates and the first C1 implementation. Reads use exactly `ahub --project <literal root> status --json`, once per refresh, with cwd the same root and 5000 ms timeout. `process.run` declares a 4 MiB cap **per stream**; it has no caller byte-limit option. This adapter rejects truncation and more than 262144 combined UTF-8 bytes before parsing. It does not claim that the host stops producing at 262144 bytes. Rows are bounded at 256 and public scalars at 240 characters. A host rejection after the timeout is classified by elapsed time; a structured ENOENT is missing CLI; an unclassified rejection stays unknown.

Only the last closed projection goes to per-session `$.state`. No raw CLI output, root, ticket, link or credential is persisted. No `$.store`, settings, logs or refresh timers are used. `/clear` retires pending reads while retaining the established project root and daemon projectId; it starts no read itself, and later permitted composer/turn/tool events can refresh without another session start. Other session ends disable the controller. Held responses cannot publish after clear or disable. Native unload/removal behavior remains person-run NOT RUN; this mod declares no unload hook. Channel plugin, peers and standalone hub have no import or runtime dependency on this folder.

`test/claude-code-companion-status.test.ts` runs a fake host and the C0 fake CLI, including literal shell-metacharacter roots, identity refusals, output bounds, closed fields, non-composer effects, coalescing and held-response races. Synthetic 850-row board and 300-row global-project payloads both exceed 256 KiB; fixtures prove neither command is requested. These checks and static validation are source evidence. Native painting, real command origins, process error encoding, action counts and disable independence remain person-run NOT RUN. See [support matrix](support-matrix.json).

Static installed-CLI validation (`claude plugin validate --json`) on an isolated copy passed with zero manifest or hooks errors. Author/icon warnings and marketplace-install advice remain; marketplace distribution is outside C1. This is static module validation, not an installed plugin, host test session or native receipt.

# Read-set measurements

The reviewer measured the former reads on this project at main `7a76dff0`: board JSON had 850 rows and 4,009,483 bytes; global project JSON had 223,424 bytes and was read three times per old refresh. These are reviewer measurements, not new reads by this implementation session. Revision 2 removes both commands. The approved one-refresh source-CLI measurement is recorded under `c1.readSet.measurement` in the JSON contract; it is not a native mod or UI receipt, and no raw packet is retained.

The one authorized source-CLI refresh at code head `97d9d67db6a0cd6cafe108472d36b4ae63cdf665` (source/hub 0.35.0, 2026-11-09T13:18:42.876Z) used **1 adapter CLI spawn**, returned **19,030 stdout bytes / 0 stderr bytes**, and took **744.856 ms** end to end; exit 0 and the canonical-root/first-projectId-pin checks passed, producing a partial projection. Spawn count excludes the wrapper and OS descendants. First-id pin matching is not independent registration or cross-refresh attestation. These numeric facts were recorded in a later documentation commit; this is one source-CLI observation, not native mod/UI acceptance.

# C2 attention and compact tool views

The declared AbovePrompt band is used only on terminal/desktop sites without an active survey. It appends one fixed line per positively proven need, with the exact shell-quoted separate-terminal command from `/hub console`; it runs nothing. A fresh, identity-bound partial reading may prove one kind independently of unrelated missing fields. Stale (over 60 seconds), missing-time, clock-inconsistent, unknown, unavailable-version, identity-refused or transport-error readings add no band.

- A positive peer `needsReview` count proves held deliveries needing person review.
- The producer's exact `paused` prefix `budget: ` proves a retained budget record. Only a boolean is copied; no reason or formatted reset time is kept. Manual or unknown pauses do not imply budget attention.
- A closed `needs.first` approval with `level: act` and a future deadline proves one pending permission request. Its deadline is checked again when drawn. This is not a full permission inventory; no permission body or ticket is copied.
- Offline with assigned `in_progress` work remains unavailable. Neither broader active WIP nor the existing offline-need summary proves that exact state. The pane names this gap; it creates no waiting line and performs no board/projects fallback.

ToolUse views compact only the four exact agent-hub MCP tools `hub_review`, `hub_task_done`, `hub_send` and `hub_delivery_done`. A bounded per-session list of at most 64 tool-use IDs controls Show/Hide original. It stores no input, output or rendered tree; clear/exit retire pending presses and clear the list. Native expanded/verbose views and other tools pass through to the original renderer. Labels distinguish running, error, interrupted and returned; input metadata is explicitly requested metadata and never presented as an approved/done outcome. The unchanged original row remains available behind the toggle.

The source model-input test dispatches actual registered hooks and builds model tool results, queued delivery text and system sections from the returned core-chain values. It exercises UI rendering/toggles on and off, checks equal model inputs, and proves the comparator detects test-only mutations of all three protected inputs. Per-session UI state is outside the model-input channel by the declared SDK contract. This synthetic proof is not a native channel-origin or paint receipt. A real needs_review band raised/cleared and native tool-row/disable UX remain person-run **NOT RUN**; support stays **fixture_only**. No status line or channel row is added, and refresh still uses the single status-only read set.
