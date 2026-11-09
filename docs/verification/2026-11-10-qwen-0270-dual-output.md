# Qwen 0.27.0 dual-output qualification, Q2 source controls

Date: 2026-11-10. Task #850, Refs #888. **Candidate 0.27.0 native qualification: NOT RUN.**
This draft records the reviewed Q2 method, source controls and the initial
0.26.1 matched-control attempt below; it admits no new
qwen-dual version. The basic ACP receipt and failed live-setter contract are
independent.

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
  after-fence attempts succeeded. No 0.27.0 or Q3-Q7 attempt followed.

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
and turn-order assertions remain unchanged. Native rerun is pending separate
approval. Cleanup changes are pending the independent source review and do not
use a fixed delay to manufacture success.

Private evidence is located through `scratchpad/temp/task850/native-control-root.json`:
`q2-result.json`, `state/qwen-dual/input.jsonl`, `state/qwen-dual/events.jsonl`,
`cleanup-readonly-inspection.json` and source/causal records. No real account,
gateway, live user terminal or model inference was used.

## Existing ceilings and pending native evidence

Normal completion uses non-tool-use assistant plus message_stop. Adoption
(qwen-dual.ts:221-241), reattachment (:358) and deny settlement (:558-572) do not
prove native idle in every path. No universal no-active-submit claim or runtime
fix is made. The premature deny/idle follow-up is outside this task.

The first 0.26.1 Q2 control was ATTEMPTED/FAILED as recorded above. Corrected
0.26.1 Q2 revalidation, control Q3-Q7 and candidate 0.27.0 native qualification
remain NOT RUN; no admission follows from source controls or the initial attempt. The original T0 gateway/key harness is never executed
by this procedure. Source checks, native account-free results and hosted CI
remain separate evidence. This draft will be finalized from actual results.
