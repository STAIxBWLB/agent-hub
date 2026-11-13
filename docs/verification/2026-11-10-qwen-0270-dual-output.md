# Qwen 0.27.0 dual-output qualification

Date: 2026-11-10 (KST). Task #850, Refs #888. **Required normal-Bus Q2 and Q3/Q5/Q6/Q7 PASS on matched 0.26.1 and
candidate 0.27.0.** This receipt supports exact 0.27.0 admission for the separate
qwen-dual contract; Q4 retains its existing unsupported external-stop limit. Basic ACP and the live-setter contract are independent. These
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
pass/fail and not evidence for the later 0.27.0 measurements recorded separately below.

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

## Required-suite corrections and matched results

The remaining manual producer is `scratchpad/temp/task850/run-q3-q7-native.ts`
with a separate Python PTY/provider controller. It extracts only the pinned v2
assertions/readers/guard, never the original gateway/key harness. The final runs
measure repository HEAD `b8f2b20d0e62f316a9044f74ce57f2db6aab793a`; the public Q2
code at that head has the same SHA as the earlier b20080aa native Q2 runs.
Final required-suite/direct-characterization controller SHA-256 is
`c75379e644551fb5f79d20902a2214e11f4cd05e0dc43245ec89ba551102e480`, Python
producer SHA-256 is
`24c459b7c0ae84a4c11d082f32800a97985c4cef4e3f238cb264c24ee364dfd3`.
The reviewed manifest binds nine original/copied producer sources, exact clean
repository HEAD, private package/bin/lock/settings export and the whole-prefix
count/digest already measured by Q2. The actual before snapshot must match those
qualified bytes, not just a version or SRI string; before/after source copies,
project imports and command boundaries remain bound to the reviewed inputs.

Two additional control failures are preserved:

- First required-suite control (18:27:54-18:32:04 UTC): Q7 passed, Q3 allow timed out before its marker
  effect, and Q5/Q6 were not reached. The retained tool result reports
  `posix_openpt failed: Operation not permitted`; the guard blocked `models.dev`.
  Native owned stop/provider close/final closure and all fences passed, while
  the overall result failed. An uncleared suite-race timer held the controller
  until 250 seconds; that controller exit time is separate from native cleanup.
- After supported refresh/PTY corrections (19:04:23-19:04:51 UTC), Q7 and all five Q3 cases passed.
  Q5 raised `NotImplementedError` during FIFO setup before a Q5 native generation;
  Q6 was not reached. This is a host helper failure, not a Qwen FIFO protocol
  failure. Cleanup, guard closure and all fences passed; the controller exited
  in 27.4 seconds. The unsupported Apple Python 3.9.6 `mkfifo(dir_fd=...)` call
  was replaced before the next native run, without opening the FIFO.

Shipped 0.26.1 `chunk-Q3NSK7FV.js:48` and 0.27.0 `chunk-576P2HBP.js:48` return
from `refreshModelCatalog` before fetch/cache refresh when
`QWEN_CODE_MODELS_DEV_REFRESH=off`. That supported override is supplied to both
case and native-generation environments; network is still restricted to the
owned provider port. No ambient catalog cache is injected. The OS profiles
`application.sb` and `com.apple.neagent.sb` supply the three narrow PTY rules:
`pseudo-tty`, exact `/dev/ptmx` access, and numeric PTY slaves requiring the
`com.apple.sandbox.pty` extension. No broad slave write rule is added. A separate
kernel-only control (19:01:13-19:01:17 UTC) proved a newly owned external decoy slave was write-open
blocked inside the sandbox while a sandbox-created PTY allocated, round-tripped
and closed its FDs. The external holder exited with drains/owned cleanup proved;
that control imported no vendor module and ran no Qwen CLI or provider.

The FIFO helper uses the fresh owned absolute pathname because this host's
Python lacks `mkfifo`'s dir-fd support, retaining parent/leaf identity checks.
Its explicit ceiling is a pathname race in that owned setup operation before
native start, not a general atomic path guarantee. Q5 never opens or reads the
FIFO, including for readiness. Settled race timers are cleared, and bounded
producer timeouts carry closed checkpoints; the old failure records are unchanged.

Both final required-suite runs used the same assertions and bounds (240-second
suite, 300-second controller, bounded files/streams), normal no-bare mode and
fresh per-case homes/settings with a fake local provider. The 0.26.1 settings
export is `settings-IMTJFJRU.js`, SHA
`c21299bbd8c7cc7d18089d3088b74d5ce4d4cbdd4a4d9984a72a1306a57a25a5`;
0.27.0 uses `settings-LVFIAIC2.js`, SHA
`bc1d0a513cc5c15bfb8750228e49321424960b103773ab5442179085de44646f`.
All nine closed configuration checks passed in each prepared case on each version.

| Required-suite observation | Control 0.26.1 | Candidate 0.27.0 |
| --- | --- | --- |
| UTC interval, 2026-11-09 (2026-11-10 KST) | 19:11:53-19:12:29 | 19:14:03-19:14:40 |
| Q7 exact version / positive network guard / kernel controls | PASS | PASS |
| Q3 allow / deny / own fixture TUI Enter / read-only / real fixture MCP handler | 5 PASS | 5 PASS |
| Final duplicate RID response count and exact unchanged/append-once effect | 1 / PASS | 1 / PASS |
| Q5 unread FIFO, provider request, visible answer, native alive | PASS | PASS |
| Q6 same session, old input prefix, no replay, prior assistant context | PASS | PASS |
| Q6 old input bytes / assistant context token / user context token | 133 / true / false | 133 / true / false |
| Owned native generations, all groups gone/drains joined | 8 / true | 8 / true |
| Provider closed / remaining handlers / provider fault | true / 0 / false | true / 0 / false |
| Global final closure / closure failures / guard errors | true / none / none | true / none / none |
| Protected / Q2-qualified whole prefix / nine producer fences | unchanged | unchanged |
| Controller and producer exit / requiredPassed / safetyAccepted | 0 / true / true | 0 / true / true |

The final snapshot occurs only after all owned native generations stop and the
provider closes. Q3 effects and all duplicate ACKs are revalidated on frozen
observations. Q6's registered final callback rechecks its same-session recording,
no replay and assistant-only context against final frozen data; global
`finalClosurePassed` is true with no closure failures. The serialized Q6 object
was spread before that callback, so it has no propagated
`finalClosureRevalidated` or `finalRecordingProof` fields. Those absent fields are
not invented here. Q5 leaves event output unread by design and binds identity by
the unchanged qualified artifact, normal command, owned PID/guard and Q7 exact
version. Fixed responses establish context transport, not real-model recall quality.

## Direct native busy-submit characterization

This independent report-only pair ran after the required pair, once per version
with the same frozen sources and containment. Both preparations and final
closure completed safely; neither is a required-Q2 pass/fail.

| Final observation | Control 0.26.1 | Candidate 0.27.0 |
| --- | --- | --- |
| UTC interval, 2026-11-09 | 19:16:12-19:16:28 | 19:17:23-19:17:39 |
| User / assistant / message_stop events | 1 / 1 / 1 | 1 / 1 / 1 |
| Provider requests / marker order | 2 / FIRST,SECOND | 2 / FIRST,SECOND |
| User < combined-marker assistant < Stop indices | 2 < 11 < 12 | 2 < 11 < 12 |
| Premature second user / observation window expired | false / false | false / false |
| Final characterization status / requiredPassed | observed-not-admission / null | observed-not-admission / null |
| Final closure / owned stop / fences / controller exit | true / true / unchanged / 0 | true / true / unchanged / 0 |

A single assistant contains both markers on both measured artifacts. This again
does not reproduce the original native-busy-submit two-turn claim; it does not
contradict the separate normal-Bus Q2 proof, which waits for the first final Stop
before the second delivery. The earlier unclassified extra POSTs remain
unattributed; these new requests do not retrospectively establish their purpose.

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
The Q2 final runs retain bounded latest-user bodies; the remaining producer records
closed request metadata only. Original failed results and unused stale inputs are
preserved separately from later corrected runs.

| Pointer | Closed result | SHA-256 |
| --- | --- | --- |
| `native-control-root.json` | initial failed `q2-result.json` | `9854a19930571f6a8b05d446ea1140b60549dec9a9a2e329c4fb357794e15809` |
| `native-control-v2-root.json` | second failed `q2-result.json` | `e5f95e56e6fec13bfb930c0c1a352ad1b8f391cfa3b1aebe4b68725cc38349b9` |
| `config-only-root.json` | 0.26.1 `config-only-result.json` | `84c1ee0feea6dc06230699e6a71e950fb4026b54c3e457e59b5c986afdc7656e` |
| `native-control-v3-root.json` | passing control `q2-result.json` | `3a5099589ff9df657686e7af0fc964041b3d1dcf563105eeb30ee253fec3149d` |
| `native-candidate-root.json` | passing candidate `q2-result.json` | `2583b82d33fee3b56d810d247b0c32bf322a91461d24dc1f6ee78b5aece44e41` |
| `required-control-v2-root.json` | first failed `control/q3-q7-result.json` | `b3c150a790cb1ade935390b444f92551a036ec46c147e0219a3d3f6ef98eb53e` |
| `kernel-pty-control-root.json` | passing `control/kernel-pty-result.json` | `31afa5cc282b92d3a05819981df3407d3323338a78234c82f2c55eafe7bf345f` |
| `required-control-v3-root.json` | FIFO-helper failed `control/q3-q7-result.json` | `cfe56022aae265e9884ab9a629b2277b4f3fb85e6e5f1b05b302ddd8db4908e2` |
| `required-control-v4-root.json` | passing control `control/q3-q7-result.json` | `5f54732ce6ffb21cce8330659e957027d8917f9794b62eb6f2a06b614bf0480c` |
| `required-candidate-root.json` | passing candidate `control/q3-q7-result.json` | `f9ee01b511b33edeff215a710e6f95a609d7b18ed3eddbed74e9361c692d90d5` |
| `direct-control-root.json` | control characterization `control/q3-q7-result.json` | `3b476a90a829a08e00864c78eb579491937b4f372c1b41b6c46fe04ab268995d` |
| `direct-candidate-root.json` | candidate characterization `control/q3-q7-result.json` | `e4f4c61326e060f7c8b913db371a92a7abff02d02a17baf3c436a097ed4077b0` |

## Existing ceilings and remaining native evidence

Normal completion uses non-tool-use assistant plus message_stop. Adoption
(qwen-dual.ts:221-241), reattachment (:358) and deny settlement (:558-572) do not
prove native idle in every path. No universal no-active-submit claim or runtime
fix is made. The premature deny/idle follow-up is outside this task.

The matched pair passes required normal-Bus Q2 and Q3/Q5/Q6/Q7. Q4 is report-only:
no new external-cancel behavior is qualified. Exact 0.27.0 admission uses this
receipt without widening to 0.27.1/0.28.0 or changing the independent basic ACP
or setter contracts. No automation manifest eligibility or runtime adapter/Bus
behavior changes.

## Not verified

Real accounts/models, this repository's live dual-output TUI use, Linux and
lifetime containment remain unverified. The source focused checks at b20080aa
passed (10 controls, 84 assertions plus typecheck/inventory); final repository
checks and hosted CI are separate from these native observations. Native measured
HEADs remain b20080aa (Q2 code) and b8f2b20d (required/direct suites), regardless
of later documentation/admission commits.
