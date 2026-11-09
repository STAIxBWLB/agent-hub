# Claude Code companion host contract v1

C0 of [#1338](https://github.com/STAIxBWLB/agent-hub/issues/1338), task #830. Recorded 2026-11-09.
This freezes a data and fixture baseline. No companion is installed, no channel plugin changes, no native UI support is claimed.
The [JSON contract](host-contract-v1.json) is checked by `test/claude-code-companion-contract.test.ts`.

# Evidence and capability decisions

Installed Claude Code **2.1.319** ran only with isolated HOME and CLAUDE_CONFIG_DIR. A registered scratch hub outside Git used agent-hub **0.35.0**. [Direct evidence](receipts/c0-cli.md) separates successful command reads from unobserved mod APIs. No credentials were copied, no model turn was used. The unchanged real settings hashes are recorded there and in JSON.

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
