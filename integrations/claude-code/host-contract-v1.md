# Claude Code companion host contract v1

C0 of [#1338](https://github.com/STAIxBWLB/agent-hub/issues/1338), task 830. Recorded 2026-11-09.
This freezes a data and fixture baseline. No companion is installed, no channel plugin changes, no native UI support is claimed.
The [JSON contract](host-contract-v1.json) is checked by `test/claude-code-companion-contract.test.ts`.

# Evidence and capability decisions

Installed Claude Code **2.1.319** ran only with isolated HOME and CLAUDE_CONFIG_DIR. A registered scratch hub outside Git used agent-hub **0.35.0**. [Direct evidence](receipts/c0-cli.md) separates successful command reads from unobserved mod APIs. No Claude credentials were copied and no model turn was used. An initial unrelated inherited credential environment was removed, then all retained probe outcomes were reproduced with an explicit noncredential environment allowlist; the receipt records the correction. The matching real settings hashes at the native-probe boundary are recorded there and in JSON. A later read-only pre-push audit differed (confirmed 2026-11-09T08:12:37Z); cause UNKNOWN. This is time-separated evidence, not an unchanged-through-task claim.

| C0 question | Verdict | Consequence |
| --- | --- | --- |
| Reads from `$.process` under agent markers | unproven at the host API; direct CLI `status --json`, `board --json`, `projects --json` succeeded with Claude markers | Fixed read vectors are candidates; C1 still needs the native `$.process` receipt |
| `session.receive` channel deliveries and origin | unproven | Drop channel-row rendering and delivery-trigger refresh |
| `$.ui.status` with user statusLine and quota tee | unproven | Drop the status-line entry; do not touch user statusLine or tee |
| `command.run` composer, model and plugin origins | unproven | Admit no effectful slash command until native origin proof; non-composer gets text only |
| Terminal, desktop, VS Code and mobile drawing | unproven | Each surface stays unqualified with its own NOT RUN receipt |
| Minimum Claude Code version | unproven | 2.1.319 is an observed CLI version, not a minimum or supported-mod promise |
| `ahub tail` as safe event source | unsupported | Agent-marked CLI refuses it; its free text stream is excluded; no polling replacement |

Each row's command, observed result and narrower claim are in JSON and the CLI receipt. Typings, a synthetic test context and the issue's API inventory do not establish runtime behavior. C1/C2 must fill the native gaps; a missing capability removes only that surface, never expands authority. Desktop, VS Code and mobile remain person-run legs. [Terminal](receipts/terminal.md), [desktop](receipts/desktop.md), [VS Code](receipts/vscode.md), [mobile](receipts/mobile.md) receipts are all **NOT RUN**.

# Fixture boundary

The independent fake CLI never spawns or imports another companion. Fixed executable `ahub`, argv `['--project', boundRoot, 'status'|'board'|'projects', '--json']`, cwd `boundRoot`; no shell. Proposed companion ceilings: **5000 ms**, **262144 combined UTF-8 stdout/stderr bytes**, **256 rows**, **240 characters per public scalar**. These are caller-enforced C0 choices, not measured host limits. Overflow rejects the entire result, including UTF-8 overflow; timeout, nonzero, malformed JSON and wrong binding remain distinct.

The fixture copies only the closed fields listed in JSON: status `cwd`, `projectId`, version, peer id/state/queued/optional attached/optional needsReview and task state/count; board id/public title/state. The board's `title` is already the existing `publicTitle` view. `[pii]` rows yield only id. Unknown source fields are dropped, not copied. No detail, review body, note, path, doing or log line is exposed. Root is an opaque exact binding value, including spaces and shell metacharacters. Missing optional fields stay absent; missing required fields refuse, never zero-fill. Permission, budget and held detail are unavailable until a public shape is proved.

Before C1 reads, exactly one registration must match the bound real root and id, on every refresh; missing, changed, duplicate or mismatched bindings refuse before further reads. C0 tests only status binding and pure closed projection; C1 owns registration orchestration and display states. Running, offline, unknown, partial, stale (>60 s), unavailable version and each transport failure are separate. Only last projection goes in per-session `$.state`; no output, credential or task text goes in store, settings or logs.

Refresh candidates are session start, turn end, completed hub-tool call and person refresh, at most one read in flight, coalesced, minimum interval 1000 ms. Delivery-trigger refresh is dropped until observed. No periodic timer, no `tail`. All mutations and lifecycle actions remain outside this companion. `/hub console` prints one shell-quoted command for a separate terminal and opens nothing. `/hub ui` is excluded until host origin and safe navigation are qualified.

# Baseline journeys

Counting rule: one explicit focus/open chord or click, or one submitted command, is one action. Typing the command and waiting add none. Start: Claude session focused, exact root known, no separate terminal open. End: the existing screen visibly answers the question. Any project selection or consent adds one action, counted separately.

| Journey | Existing procedure | Procedure actions | Observed native actions |
| --- | --- | --- | --- |
| What needs me | Open a separate terminal; submit `ahub --project <quoted root> console`, inspect attention and existing person-only commands | 2 | NOT RUN |
| Is peer X alive | Open a separate terminal; submit `ahub --project <quoted root> status`, inspect peer state/attachment/queue | 2 | NOT RUN |

These are procedure counts, as distinct from measurement. The empty scratch hub CLI read did not contain a live peer or a real hold. C2 must show what-needs-me in at most one action without leaving Claude Code, including an actual hold raised and cleared. C0 establishes no improvement.

# Installation and removal

No installable companion exists in C0; no marketplace entry or channel plugin dependency was added. Existing `ahub status`, `ahub console`, `ahub board` and `ahub ui` workflows remain standalone. C1/C3 must document isolated install, enable, disable and remove with their own receipt; removing the optional mod must leave peers, channel and hub unchanged. No `src/`, `plugins/agent-hub`, quota or approval policy changed here.

# C1 amended implementation

The owner amendment of 2026-11-09 permits a separate read-only mod against declared types and a fake host, with native terminal proof as a person-run NOT RUN leg. The [companion README](README.md) and [support matrix](support-matrix.json) describe that fixture_only implementation. This supersedes the C0 statement that no companion exists and its requirement for native proof before building C1; it does not change any of the seven C0 capability verdicts or grant native support. Declared 2.1.319 types are pinned by SHA-256 in JSON and checked outside the Bun type universe, not committed. The actual process.run API accepts timeoutMs but no custom byte cap; the adapter rejects truncated or oversized responses before parsing, with the host buffering bound reported separately.

# C1 read-set revision 2

The AC1 amendment of 2026-11-09T12:57:02Z supersedes the C0 candidate read set and initial C1 orchestration. C1 now makes exactly one project-scoped `status --json` read per refresh and copies version, peers and task-state counts only. `board` and `projects` are forbidden; task/role lists are unavailable. The canonical session root and stable daemon projectId bind every response, with root checks around the read and projectId pinned across `/clear`. Registry existence/uniqueness is NOT VERIFIED; a bounded registration read requires a separate task.

At main `7a76dff0`, the reviewer measured board JSON at 850 rows / 4,009,483 bytes and project JSON at 223,424 bytes, previously read three times per refresh. Those reviewer observations are not new implementation-session probes. The JSON contract records their provenance and the separate approved one-refresh source-CLI numeric measurement. No raw packet is retained, and no source-CLI measurement qualifies a native host API or UI surface.

# C2 declared UI contract

C2 uses the same declared SDK hash and C1 status-only identity-bound read set. AbovePrompt is declared on terminal/desktop; survey/no-attention/unknown sites pass through. Fresh partial readings may independently prove held-count, budget-record-prefix or first active-approval facts. Other states, stale readings and expired approvals create no waiting band. Budget reason/reset text and permission tickets/bodies are never retained. Exact offline-owned-in_progress proof and the full permission inventory are unavailable and named outside the band.

ToolUse renders only four exact native agent-hub tools, preserves the original via `next(e)` behind a bounded per-session toggle, and yields original for expanded/verbose or unrecognized rows. Native transport status is not a logical approval/completion claim. Source model-input proof uses actual registered chains with on/off UI exercise and counterfactual mutations of result, channel and system inputs. It does not install production receive/prompt hooks. The JSON C2 section records producer-source and SDK evidence; every native paint/origin/raised-cleared-hold receipt remains NOT RUN.
