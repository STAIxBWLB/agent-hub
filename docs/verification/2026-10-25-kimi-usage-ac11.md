# Kimi usage counting live receipt (#285 AC11)

## Scope and isolation

Measured on 2026-10-25 with agent-hub source `38cde512ca489cc7cbdd032fc16fe213758b41dd` and Kimi Code CLI 2.3.1. ACP initialization served protocol version 1 and agent version 2.3.1. Every wire file declared wire protocol 1.5; all four usage rows had `usageScope: "turn"`.

The measured process had a new disposable cwd, `HOME`, `KIMI_CODE_HOME`, `TMPDIR` and `XDG_CONFIG_HOME`. Its generated native config retained only the installed managed provider and model settings, with hooks and telemetry disabled. The installed account's credential/oauth directories and device identity were symlinked into the disposable native home without printing their contents. No personal project or prior session was read. No `/usages` credential or plan-quota probe was made; #285 AC9 remains outside this receipt.

The ACP sequence was one ordinary no-tool prompt, `/usage`, one prompt requiring a subagent, and `/usage` again. Raw prompts, answers, session identifiers and transcript paths are not reproduced here. The measurements below contain field names, counts and timings only.

## Wire rows and native `/usage`

`counted` means `inputOther + inputCacheCreation + output`, the hub ceiling rule. `total` also includes `inputCacheRead`. Native `Session total` is its displayed input plus output.

| Point after turn | Main rows | Subagent rows | Main `total` | All-agent `counted` | All-agent cache reads | All-agent `total` | Native `Session total` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary prompt | 1 | 0 | 23,847 | 4,647 | 19,200 | 23,847 | 23,847 |
| Subagent prompt | 3 | 1 | 72,058 | 10,326 | 73,984 | 84,310 | 72,058 |

After the ordinary prompt, native input was 23,769 and output 78. After the subagent prompt, native input was 71,811 and output 247. Both native totals exactly equal the main-agent four-counter wire total. The second native total excludes the subagent's 12,252 tokens: 84,310 all-agent tokens minus 12,252 equals 72,058.

Therefore `/usage` reconciles with the main-agent wire sum, not the all-agent sum once a subagent runs. The hub intentionally counts subagents, so its all-agent total can be higher than Kimi's native session total without a counting error. Cache reads are part of the native session total but remain excluded from the hub ceiling count.

The production `KimiWireReader` independently read this captured session as `status: "ok"`: four rows, `counted` 10,326, cache reads 73,984 and `total` 84,310, exactly matching the direct field-only scan.

## Turn-end timing

- After the ordinary prompt's `session/prompt` result, the synchronous disk read still had zero rows. The main row was present by the read 1,000 ms later. This run does not prove that an ordinary main row is already durable at the prompt-result instant.
- After the subagent prompt's result, all three main rows and the subagent row were already present synchronously and remained unchanged at 1,000 ms.
- The ordinary prompt emitted `usage_update { used: 23847, size: 1048576 }` at the prompt-result boundary (0 ms observed delay). The subagent prompt emitted `{ used: 24175, size: 1048576 }` 5 ms after its result. These are context occupancy readings, not cumulative session consumption.
- Neither `/usage` turn emitted a `usage_update`.

## Does ACP `/usage` cost a model call?

No model request was recorded for either `/usage` turn in this run.

| `/usage` turn | Rows before | Rows at prompt result | Rows 1,000 ms later | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| After ordinary prompt | 1 | 1 | 1 | 3 ms |
| After subagent prompt | 4 | 4 | 4 | 2 ms |

Both turns returned `stopReason: "end_turn"`. Their answers contained context occupancy and main-session totals, not plan-quota fields. With no new `usage.record` at either the response or the settled read, these ACP `/usage` calls did not consume a model request.

## Evidence retention and verdict

The external evidence is under the workspace scratchpad's `temp/agent-hub-429/run2/` directory, with raw ACP and answer files mode 0600. The producer is `temp/agent-hub-429/probe.ts`; its SHA-256 is `c9105d46a4aa3627b4ec5a907e62e2795aba057fb6d02666215f02566c4e50cf`. The sanitized result JSON SHA-256 is `727f22fb1412be3f4bd90db44626f90acce65e2badb4c5548db89fbacdeafc47`.

AC11's Kimi legs are **VERIFIED** for the installed 2.3.1 session described here: native occupancy timing, main and subagent wire rows, native-total reconciliation, and the model-call cost of ACP `/usage`. The ordinary main-row result also records a timing limitation rather than claiming synchronous durability. This receipt does not verify another Kimi version, plan quotas, or #199 AC5.
