# Routing-time evaluation proposal for #109

Status: design preregistered on 2026-10-11 with owner approval: controlled matched task pairs, 120 pairs (60 development and 60 held-out). No study has been collected. Execution manifests, profiles and source/check hashes must be sealed before collection. Solo implementation in #324 runs no ahub-coordinated research arm.

## Approved design and remaining execution freeze

- Selected design: 120 preregistered matched work-unit pairs, 60 development and 60 held-out, with a fixed split arm recording predictions in shadow mode and both solo controls. Unit-family membership, task/check hashes, native versions, model/hook/coordination profiles and the chronological split are sealed before any scored attempt. Warmup attempts establish the minimum five past observations per peer; they are identified separately and never enter held-out scores.
- Ordinary-work observations may be reported separately as diagnostics. They do not replace the selected controlled design or supply its counterfactual.
- 120 is the approved sample budget, not a power result. Fewer than 30 valid known held-out opportunities, an invalid profile or inadequate comparability makes the result inconclusive. No retries or additional samples are selected by scores. A larger sample requires a dated amendment before collection resumes.

## Input and outcome boundary

Only a recorded `split` event with `where: routing`, made when routing first assigns an unnamed task overlapping another owner's still-proposed task, enters the prediction sample. Claims, named owners, reassignments, relays and cohort-time predictions are retained but excluded with their reason. A task's own future outcome never enters its input history.

Persist the immutable decision-time peer profiles, previous eligible observation ids, comparability/work-unit declarations, backlog, availability, verdict, assumption trace and predicted times. Failures and time-limited attempts are typed observations, not deleted survivors. Missing durations, version/hook identities and usage remain unknown.

Accept-to-first-done and assignment-to-accept are workflow stage proxies. They do not establish clean model orientation or service time. Queueing, tool/model work, approval/check time and coordination are reported separately when observable, otherwise unknown. Equal class is the current board's normalization assumption; it is not proof of equal task size.

Outcome joins happen only after terminal settlement. In the controlled design, paired split and solo durations, check outcomes, resource use and end causes are report outputs. Hidden evaluator results are applied only after outcomes are sealed and never influence forecasts, exclusions or collection order.

## Report and enablement boundary

- Report all attempted opportunities and exclusions; known/unknown/inconclusive counts; failure/censoring rates; absolute and relative stage-time errors; bias; predicted/observed gain sign confusion; and seeded, family-cluster bootstrap intervals with the seed and family count.
- Predeclare unknown handling. Unknown/inconclusive predictions have no numeric error and are never counted as correct. Failed/time-limited outcomes have their own table rather than an invented zero duration.
- The observational result cannot supply a causal team-versus-solo gain. The controlled result separately checks quality and resources against both solo controls; prediction accuracy alone cannot enable routing.
- Automatic rerouting remains off. This proposal does not tick AC5, complete T3, implement T4 or treat the historical equal-half calculation as a bound. This study is non-enabling regardless of its result: it reports prediction errors and paired quality/resource outcomes. Any future enablement study must preregister numerical acceptance thresholds before collecting new held-out data and obtain a separate explicit opt-in.

## Reproducibility record

The frozen preregistration goes into `docs/cooperbench.md` next to the existing v2 preregistration, per #109's dated decision. Archive the source/profile/check hashes, split membership and budget before data; publish only sanitized counts, ids and timing summaries. Native prompts, gold solutions, user task text and credentials stay out of repository materials. Resource admission and settled owner teardown apply to every live arm.
