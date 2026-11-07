# Kimi delayed usage and attribution receipt (#1281)

## Scope and isolation

Measured on 2026-11-07 with agent-hub source `a3de35e41ca26614108593b61de5674a960b2b95` plus the #1281 working change, and Kimi Code CLI 2.5.2. ACP initialization served protocol version 1 and agent version 2.5.2. The wire log declared protocol version 1.5.

The measured process had a new disposable cwd, `HOME`, `KIMI_CODE_HOME`, `TMPDIR` and `XDG_CONFIG_HOME`. Its generated native config retained only the installed managed provider and model settings, with hooks and telemetry disabled. The installed account's credential/oauth directories and device identity were symlinked into the disposable native home without printing their contents. No personal project or prior session was read. No credential or plan-quota probe was made.

Each turn was one ordinary no-tool prompt. Raw prompts, answers, session identifiers and transcript paths are not reproduced here and the disposable directories were removed. The measurements below contain field names, counts, timing relationships and attribution only.

## Native row timing and attribution

`counted` means `inputOther + inputCacheCreation + output`, the hub ceiling rule. `row within turn` compares the native row time with the captured hub turn interval. `usage after turn_end` compares the hub's `usage` event time with its immutable `turn_end` event.

| Attempt | Counted | Cache reads | Row within turn | Usage after turn_end | Attribution |
| --- | ---: | ---: | --- | --- | --- |
| 1 | 5,518 | 23,552 | yes | no | `delivery`, task 1281 |
| 2 | 237 | 28,928 | yes | no | `delivery`, task 1281 |
| 3 | 322 | 28,928 | yes | no | `delivery`, task 1281 |
| 4 | 153 | 28,928 | yes | no | `delivery`, task 1281 |
| 5 | 240 | 28,928 | yes | no | `delivery`, task 1281 |
| 6 | 325 | 28,928 | yes | no | `delivery`, task 1281 |
| 7 | 152 | 28,928 | yes | no | `delivery`, task 1281 |
| 8 | 240 | 28,928 | yes | no | `delivery`, task 1281 |

Every native row time fell inside its captured turn interval. Every row was collected before `turn_end`, and the `tokens` event carried the same `delivery`, task 1281 attribution and counted value as the `usage` event. This verifies current native row-time semantics and immediate attribution on Kimi 2.5.2.

## AC8 verdict

**The delayed native leg is UNVERIFIED.** Zero of the eight ordinary turns produced a row after `turn_end`, so this version did not provide the delayed native evidence AC8 asks for. The immediate rows above must not be presented as delayed evidence.

The production delayed path is covered separately by `test/daemon-kimi-delayed-usage.test.ts`: its real unreferenced 250 ms timer collects a post-result row without another turn, updates `usage`, `tokens`, the budget and roll-up, and leaves `turn_end` unchanged. The A/B test fires the injected scheduler while task B is open and proves that A's delayed row keeps A's attribution, increments no turn total, and that an ambiguous timestamp is `unattributed`. These fixtures establish the #1281 behavior, not a current native delay.

The earlier native delay observed on Kimi 2.3.1 remains recorded in [2026-10-25-kimi-usage-ac11.md](2026-10-25-kimi-usage-ac11.md). A future version that again produces a post-result row should repeat this receipt's ordinary-turn leg.
