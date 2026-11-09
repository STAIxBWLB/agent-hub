# Qwen 0.27.0 dual-output qualification, matched Q2

Date: 2026-11-10 (KST). Task #850, Refs #888. **Normal-path Q2 PASS on
matched 0.26.1 and candidate 0.27.0; Q3-Q7 NOT RUN.** No new qwen-dual version
is admitted. Basic ACP and the live-setter contract are independent. These
macOS arm64 PTY observations use a local fixture provider, isolated homes and
private package candidates, without an account or real model inference.

## Required Q2 and separate characterization

Ruling fa75c5f2-fc78-42a1-85dc-cf206e6a7825 defines required Q2 using the actual
Bus and QwenDualPeer normal delivery path. A second envelope is published while
the first provider response is held. Input must contain one submit until the
first response is released. The first non-tool-use assistant and message_stop
must precede the second distinct user/provider/final-assistant/message_stop.
There must be exactly two user events and distinct completion indices; one
assistant containing both markers does not pass.

The public manual producer is
`scripts/compat-receipts/proofs/qwen-dual-bus-q2.ts`; it starts nothing on import
and relies on owned native/controller ports. Deterministic source controls in
`test/compat-receipt-qwen-dual-q2.test.ts` use synthetic event files, no native
process/account/model: normal held queue, tool-use stop remaining busy, and the
old merged-assistant false-positive shape, ordinary provider user-count mismatch,
and native-reader override refusal. Causal barriers and the exact second Bus
envelope id are checked. They do not certify native Q2.
Final input/events/provider evidence is frozen after owned stop and checked again;
late POST and USER/final-stop controls preserve the first failure checkpoint.
Tool-use and orphan Stops cannot be reused as new final assistants. No automation
manifest or autoAdmit eligibility is changed.

The [original 0.26.1 receipt](2026-10-25-qwen-dual-output-t0.md) used a real
model/gateway and a changing global install. Its direct-busy-submit queued-turn
claim was not reproduced by v2's private matched 0.26.1 control. The
[0.26.8 attempt](2026-11-06-qwen-0268-dual-output.md) records one user/final-stop
and both markers in one assistant. Extra provider POSTs have no recorded
format/title-schema/role classification, so their underlying cause remains
unknown. That direct-busy experiment is characterization, not a required-Q2
pass/fail and not an assertion about unmeasured 0.27.0 behavior.

## Initial 0.26.1 normal-path control, not qualified

One approved macOS arm64 PTY control ran at source HEAD
`345e1af9ab7403745bc38849e5b7f1252412714d`, with repository-pinned Bun 1.4.2,
Node 24.18.1 and an isolated private 0.26.1 package. Official npm integrity is
`sha512-4kpIzrlrgmawivim0yCZjr1AP5cfHTanyL7eL1g2R8WYU6QDBq7j9fiAye7REXL4EEXkRIq45D7+ngTw5n3GqQ==`;
its metadata derives bin `cli-entry.js`, SHA-256
`113efe4104a9fc66f507d34bfd6abbd896ceb77de47f4b468a0825a327fdc6a5`.
Normal private installation (scripts enabled and audio installer source reviewed),
kernel controls and protected before/after fences passed before Qwen execution. CLI flag and
no-title support were read from shipped source and the earlier matched-control
recipe; those source facts are separate from this new native observation.

- Actual input has two submits. Native event evidence has two user events and
  two ordered final assistant/message_stop pairs; the final session_end remains
  in the file. Held input stayed at one submit and the second exact envelope
  was queued then recorded as delivered by the actual Bus.
- The strict ordinary-provider check failed: requests had message counts 2/4/6,
  user counts 1/2/3 and markers first/second/second. All reported absent response
  format and no title schema. The first classifier could scan older user entries
  when the latest lacked a marker. The latest third user text was not retained,
  so its exact purpose is unknown; no third request is silently accepted.
- At that failure the producer had not yet copied successful chronology into
  its final summary, leaving default userCount 0/indices -1. Those defaults are
  not evidence of zero user events. The event file and causal barriers preserve
  the two real turns; source controls now require those observations to survive
  provider-check failure.
- Initial cleanup reported groupGone/ownedStopConfirmed false, leader exit -15,
  bridge exit 0, PTY bound passed and providerFault false. A later read-only
  inspection found the original group gone, both recorded Node PIDs absent and
  no provider listener; no extra signal was sent. This later absence is not
  retroactively substituted for the original cleanup observation.
- Protected, full private artifact and producer fences were unchanged; all
  after-fence attempts succeeded. This attempt did not qualify Q2; the separately
  approved later runs are recorded below.

Shipped 0.26.1 source declares `ui.enableFollowupSuggestions` default true
(`chunk-BRRTFGQN.js:3`); both TUI implementations gate automatic follow-ups on it
(`startInteractiveUI-QDXQDPQR.js:50`, `start-opentui-ui-COUX4CX5.js:315`). The
suggestion generator waits for two model entries and can append a new generated
user prompt (`chunk-6K54QXHZ.js:137-173`). The private setting was absent in this
first run. Equivalent settings/gates are present in 0.27.0. This is a source-based
confound, not confirmation of the first third POST's purpose.

The approved workload correction sets only private
`ui.enableFollowupSuggestions:false` and inspects only the latest user's marker,
leaving absent-marker requests unknown. Strict two ordinary requests, role counts
and turn-order assertions remain unchanged. The second attempt below showed that private setting was bypassed by `--bare`.
The final corrected workload uses full private settings without `--bare`.
Cleanup now records the original leader/group identity, waits for observed group
absence within its bound and memoizes its first result; it does not use a fixed
delay to manufacture success or replace an earlier false result.

Private evidence is located through `scratchpad/temp/task850/native-control-root.json`:
`q2-result.json`, `state/qwen-dual/input.jsonl`, `state/qwen-dual/events.jsonl`,
`cleanup-readonly-inspection.json` and source/causal records. No real account,
gateway, live user terminal or model inference was used.

## Second 0.26.1 attempt and settings correction

The second control at public HEAD
`b20080aaaad3cd81ba55ceb2329d35437a39d72e` also failed its strict provider check.
It retained the actual two user/final-stop turns: first Stop index 9, second user
10, second Stop 17. Provider requests had 2/4/6 messages and 1/2/3 users; the
latest-user-only classifier labelled the third request unknown. Its text was not
retained, so its purpose remains unknown. Cleanup and protected/artifact/producer
fences passed; that does not turn the provider failure into a pass.

Shipped 0.26.1 `llm-HWSJZ5AX.js:16` selects `createMinimalSettings()` under
`--bare`; `chunk-XXTP76KR.js:39` omits UI settings from that minimal object.
`QWEN_HOME` was the correct settings root (`chunk-EPODBRBP.js:3`), so a settings
path mismatch is not the observed source explanation. The correction removes
`--bare` only from this fixture and supplies owned empty system/default settings
using the shipped `QWEN_CODE_SYSTEM_SETTINGS_PATH` and
`QWEN_CODE_SYSTEM_DEFAULTS_PATH` overrides. The private UI follow-up setting,
no-title environment, fake auth/model, empty hooks/MCP and kernel protection remain.
The five private memory booleans are declared by the shipped memory schema;
the config-only checks below do not measure their effects.

Before another native run, a separately authorized 0.26.1 config-only helper
imported the actual `settings-IMTJFJRU.js` export under the same Seatbelt and
owned settings/cwd/environment, with all network blocked. It passed nine closed
checks: effective UI follow-ups false, hooks disabled, MCP empty, fake OpenAI
auth/model selected, user/system/default settings paths owned, and minimal settings
not applying the UI false value. Kernel read/write denial and a separate network
guard positive control passed; the settings helper attempted zero network calls,
started no provider and requested no model inference. Protected/artifact/producer
fences were unchanged. This is a 0.26.1 settings-module observation, not native Q2
or a 0.27.0 config-only measurement.

0.27.0 shipped source supports the same paths and gates: `chunk-5VB4YX3Z.js:3`
(QWEN_HOME), `chunk-ERGT5BD3.js:3` (system/default overrides),
`llm-ALJILG6S.js:16` (bare/full settings choice), `chunk-PJZT7LRF.js:3` (UI and
memory schema), `startInteractiveUI-ITNOUVXX.js:49` and
`start-opentui-ui-5QU4WJHW.js:316` (UI follow-up gates). These source reads are
separate from the following native observations. The previous extra POSTs remain
unattributed; their latest user bodies were not retained.

## Matched native Q2 results

Both final runs bind the public producer at HEAD
`b20080aaaad3cd81ba55ceb2329d35437a39d72e`, SHA-256
`33e729d26279a7ba82977c52be23fb38f456a99c594bc0e764c382adda6b714a`.
Private controller SHA-256 is
`94bd25b750dd537dd7e0890fc679e3bf98136b600cb8d5f8aa4ba44f2743fb1b`;
bridge SHA-256 is
`e68f1ec610d16e440095af338a2bd3a60e4a9cadffc1638f6d8bfce90994f448`.
Neither bridge nor controller appends user submits; the actual adapter writes
the input file. Bun 1.4.2 and Node 24.18.1 are unchanged. Each run has a fresh
owned home, project and settings, private loopback-only fake provider and explicit
fake key/model. No original T0 gateway/key harness or existing terminal is used.

The 0.26.1 normal private installation has the official SRI recorded above.
0.27.0 reuses the exact private package qualified by task #849, not a global
launcher. Its package/bin/lock identify 0.27.0 with official integrity
`sha512-efZt0LUm/raGUjR/SNN6pp8cpuNHnmE0hQvcvXzWHtVX9oVtDDgukq2IZNwYDErFYqHRj1xq2NQ5Jjt2SHUr/Q==`.
Both derive `cli-entry.js` from package metadata (same entry SHA above), verify
canonical private binding, and fence the entire actual prefix before/after.
Native `session_start` must report the exact selected version and protocol 2.

| Observation after owned stop and final evidence freeze | Control 0.26.1 | Candidate 0.27.0 |
| --- | --- | --- |
| UTC interval, 2026-11-09 (2026-11-10 KST) | 17:17:54-17:18:06 | 17:22:51-17:23:03 |
| Native session version / protocol | 0.26.1 / 2 | 0.27.0 / 2 |
| Submit count while first response held / second envelope queued | 1 / true | 1 / true |
| Exact second envelope left Bus queue and was delivered by Bus | true | true |
| Final user / final Stop / message_stop / orphan Stop counts | 2 / 2 / 2 / 0 | 2 / 2 / 2 / 0 |
| First final Stop < second user < second final Stop indices | 9 < 10 < 17 | 9 < 10 < 17 |
| Ordinary provider requests / message counts / user counts | 2 / 2,4 / 1,2 | 2 / 2,4 / 1,2 |
| Response format absent / title schema absent, both requests | true / true | true / true |
| Final input/events/provider evidence closed and passing | true | true |
| Owned stop / group gone / drain joined / bridge exit | true / true / true / 0 | true / true / true / 0 |
| PTY bound passed / provider fault | true / false | true / false |
| Kernel / protected / artifact / producer fences | all pass | all pass |
| Result | PASS | PASS |

The source-bound causal barriers observe native readiness, first provider hold,
first stream consumed by the driver, second envelope queued with one submit,
provider release, then distinct native turns and second Bus delivery. Assertions
are repeated on final frozen evidence after stop; no extra ordinary/unclassified POST or late user/Stop
can bypass those checks by arriving during cleanup. Each run ended with no controller/bridge
failure and no failed after-fence attempt. No phase sleep manufactures a turn.

Private latest-user diagnostics retain at most 4096 bytes per request and closed
SHA/byte-count/truncation/source-prefix metadata. The two measured requests have
FIRST/SECOND markers and no suggestion prefix; neither run has an extra request.
This does not establish the earlier third requests' purpose. No raw user body or
private path is published here.

## Protected fences and retained provenance

The approved task #849 hash-only method protects configuration/auth/extensions,
the installed active/managed global package, launcher/selection metadata and
resolved entry. Exact root-relative runtime exclusions are the four Qwen live
state directories `file-history`, `projects`, `tmp`, `memories`; monthly
`usage/token-usage-*.jsonl`; `user-memory-meta.json`; root patterns
`.openai-logs-cleanup-*`, `.subagent-cleanup-*`, `.debug-logs-cleanup-*` and exact
`.file-history-cleanup`. The latter exclusions follow the
conductor's metadata/top-key classification of runtime bookkeeping, not a broad
usage or memory exclusion. The top-level `updates` archive is excluded only from
the configuration walk, while active global artifact/selection coverage remains.
Config/auth symlinks into excluded trees stay protected. Pi retains its historical
runtime exclusions (`sessions`, `logs`, `cache`, `install`, `bin`, `node_modules`,
`.git` at the original levels). Configuration/Pi per-file bound is 64 MiB, global artifact
128 MiB, each snapshot 512 MiB/30000 entries/depth 24; errors and instability fail
closed. Task #849's deterministic fence controls remain the method provenance.

Both final runs have protected count 7016 and unchanged digest
`ddef2fe32e285bf7b3cd7f2cdd87101a5ede56d885eade626a7edc6d7a7555c3`.
Control full-prefix count 1694/digest
`05e7875b72dd69932523becb2f6d1270ccd3695abc998f5d1470eae61a43b9c5`
and candidate count 1723/digest
`ba1c58e46b3a9bd7073befe0ea92b1c24db0b3a72519cf1c9b237d567cf80c58`
are each identical before/after. Producer sources are also unchanged.

Retained closed evidence is resolved by these workspace-relative pointers under
`scratchpad/temp/task850`; each native root includes source copies, commands,
causal records, input/events, full per-scope fences and owned cleanup evidence.
Only the new final runs retain bounded latest-user diagnostics.

| Pointer | Closed result | SHA-256 |
| --- | --- | --- |
| `native-control-root.json` | initial failed `q2-result.json` | `9854a19930571f6a8b05d446ea1140b60549dec9a9a2e329c4fb357794e15809` |
| `native-control-v2-root.json` | second failed `q2-result.json` | `e5f95e56e6fec13bfb930c0c1a352ad1b8f391cfa3b1aebe4b68725cc38349b9` |
| `config-only-root.json` | 0.26.1 `config-only-result.json` | `84c1ee0feea6dc06230699e6a71e950fb4026b54c3e457e59b5c986afdc7656e` |
| `native-control-v3-root.json` | passing control `q2-result.json` | `3a5099589ff9df657686e7af0fc964041b3d1dcf563105eeb30ee253fec3149d` |
| `native-candidate-root.json` | passing candidate `q2-result.json` | `2583b82d33fee3b56d810d247b0c32bf322a91461d24dc1f6ee78b5aece44e41` |

## Existing ceilings and remaining native evidence

Normal completion uses non-tool-use assistant plus message_stop. Adoption
(qwen-dual.ts:221-241), reattachment (:358) and deny settlement (:558-572) do not
prove native idle in every path. No universal no-active-submit claim or runtime
fix is made. The premature deny/idle follow-up is outside this task.

Q2 now passes for the matched pair using the approved normal Bus path. Control
and candidate Q3-Q7 remain **NOT RUN**; direct-native-busy-submit remains historical
characterization, not a new 0.27.0 observation. Real accounts/models, a person's
live TUI, Linux and lifetime containment remain unverified. No COMPAT verified
set, version line, receipt pointer or automation admission changes follow from Q2
alone. Source focused checks at b20080aa passed (10 controls, 84 assertions plus
typecheck/inventory); the final repository gate and hosted CI are separate and
not supplied by these native observations.
