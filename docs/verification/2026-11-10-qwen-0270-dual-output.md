# Qwen 0.27.0 dual-output qualification, Q2 source controls

Date: 2026-11-10. Task #850, Refs #888. **Native qualification: NOT RUN.**
This draft records the reviewed Q2 method and source controls; it admits no new
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
No automation manifest or autoAdmit eligibility is changed.

The [original 0.26.1 receipt](2026-10-25-qwen-dual-output-t0.md) used a real
model/gateway and a changing global install. Its direct-busy-submit queued-turn
claim was not reproduced by v2's private matched 0.26.1 control. The
[0.26.8 attempt](2026-11-06-qwen-0268-dual-output.md) records one user/final-stop
and both markers in one assistant. Extra provider POSTs have no recorded
format/title-schema/role classification, so their underlying cause remains
unknown. That direct-busy experiment is characterization, not a required-Q2
pass/fail and not an assertion about unmeasured 0.27.0 behavior.

## Existing ceilings and pending native evidence

Normal completion uses non-tool-use assistant plus message_stop. Adoption
(qwen-dual.ts:221-241), reattachment (:358) and deny settlement (:558-572) do not
prove native idle in every path. No universal no-active-submit claim or runtime
fix is made. The premature deny/idle follow-up is outside this task.

Matched 0.26.1 and candidate 0.27.0 native PTY/provider Q2-Q7, exact artifact
binding, the reviewed protected-config/global fence, owned cleanup and native
results remain NOT RUN. The original T0 gateway/key harness is never executed
by this procedure. Source checks, native account-free results and hosted CI
remain separate evidence. This draft will be finalized from actual results.
