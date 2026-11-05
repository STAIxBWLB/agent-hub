# Hard-coded values inventory: how a key is classified (#1180, task #738)

Date: 2026-11-05. Refs #1180. `scripts/inventory-hardcoded-values.classifications.json` is plain JSON that the generator parses as a map from key to class, so it has no place for a header: this file is that header. It was written **before** any key of the baseline was labelled, from two sources only: the K01 to K18 reasons of [the closure](2026-10-30-operational-settings-closure.md) and the finding of [the ratchet record](2026-11-05-hardcoded-values-ratchet.md) that a reader who knew only the closure agreed with the committed file on 58% of a sample. It is not fitted to the sample that checks it.

A key names one literal in one function (`file:function:kind:name=value#n`). Ask the questions in order and stop at the first that answers. The class says **why the value is a constant**, not how important it is.

1. **Test seam.** The literal is the fallback of an injection point that exists for tests, and the code or its name says so: a `/** Test seam ... */` option, a `*ForTest` helper, a port a test replaces, or an environment variable that only a test, a gate or a benchmark sets (`AHUB_CHECK_HANG_S`, `AHUB_*_MS` knobs read with `${VAR:-N}` or `process.env.X ?? N`). A default parameter (`ms = 90000`, `limit = 20`) or a bare `opts.x ?? N` is **not** a test seam: see rule 5.
2. **Contract.** The value is part of a representation, a wire or storage shape, or an accepted API: a protocol or schema number, a format or identifier width, a unit conversion (`1000`, `86400000`, `60`), an index or position in a stored or parsed structure, a bound that is part of a control message's or a tool's documented shape, `?? 0` or `Math.max(x, 1)` that gives the meaning of an absent or zero stored value, and a default that is **exported or published**: the default of a configuration key (`DEFAULT_CONFIG`, a `*_SETTING.defaultValue`), a tool schema's `minimum` or `maximum`, a declared model context size. A default that only lives in the function that reads it is not published: it is operational (rule 5). Changing a contract changes what stored or exchanged data means.
3. **Safety floor.** The value bounds what comes from outside the hub's own control, or what could exhaust it: a cap on a path, name, id, command, request, model or foreign-hub text, a truncation of such text before it is shown or stored, a limit on a parser, a proof or a diagnostic read, a native-session ownership record limit. Changing it changes what untrusted input the hub accepts or shows.
4. **Operational.** Everything else that tunes how the hub behaves without changing what its data means or what it accepts: timeouts, deadlines, polling and batching intervals, retry and backoff numbers, retention and window lengths, TTLs, hub-internal caps on its own queues, caches and lists, display and page sizes, benchmark and smoke-script deadlines and sizes, the numbers inside a backoff expression.
5. **The three confusable cases, which the first reader got wrong** (the committed file treats each as operational unless rule 1 to 3 applies on its own):
   - a **hub-internal cap** on the hub's own lists, queues, caches or batches (`slice(0, 50)` of the hub's own rows, a queue cap) is operational, not a safety floor. A cap on text that came from a peer, a model or another project is a safety floor.
   - an **injected default** (`opts.x ?? N`, `config.x ?? N`, `input.x ?? N`) and a **default parameter** (`function f(ms = 90000)`, `list(limit = 20)`) are operational: the injection point or the parameter makes the value tunable, it does not make it a seam. They are a test seam only under rule 1 (an environment knob or a documented test seam), and a contract only under rule 2 (exported or published).
   - a **script or smoke deadline** (`scripts/`, `AbortSignal.timeout(N)`, a benchmark's window or size) is operational.

A key that none of these decides is **not labelled**: it stays in the baseline and is reported for a ruling. The rules are the reason a label is written, so a label that needs a new rule adds that rule here first.

## How a batch is checked

Before a batch is written, a fresh blind sample of 80 already-decided keys is drawn at random with a recorded seed, each is labelled from the code with only these rules (the committed label is not shown), and the labels are compared with the file. The batch is written only at 85% agreement or more, and the figure and the disagreements go in the batch's PR. A sample that fails the bar sends the disagreement back to these rules before any key is labelled.

## What a batch labels, and what it leaves in the baseline

A batch labels only shapes where the committed file is consistent with these rules: module constants, timers, deadlines and `Math.min`/`Math.max` clamps, injected defaults, script and benchmark values, and bounds and truncations in `src/adapters`, `src/models`, `scripts/` and `src/local`. The baseline keeps every length bound and every truncation (`.slice`, `.substring`) in `src/hub`, `src/cli`, `src/ui`, `src/rooms` and `src/broker`: the file labels those inconsistently (in `src/hub`, 91 safety floor, 61 contract and 63 operational for length bounds), so no reading of the code can reach the bar there, and their convention is a separate decision by the conductor (the working rule: a bound on text, ids or input from a peer, model or another project is a safety floor; a wire-shape limit on our own protocol is a contract; the hub's own list caps are operational). The sample that checks a batch is drawn only from the same population.

## Calibration record

| Round | Seed | Population | Reader | Agreement | Result |
| --- | --- | --- | --- | ---: | --- |
| 1 | 738001 | every decided key | blind reader, these rules | 62 of 80 (77.5%) | below the 85% bar: 18 misses, 12 of them in length bounds, truncations and defaults; the rules were corrected for default parameters and environment knobs and the population narrowed |
| 2 | 738002 | decided keys outside the `src/hub`, `src/cli`, `src/ui`, `src/rooms`, `src/broker` length bounds and truncations | blind reader, corrected rules | 56 of 80 (70.0%) | below the bar: 24 misses (below) |
| 3 | 738005 | the 303 decided keys the mechanical rules below cover | the mechanical rules | 78 of 80 (97.5%) | passes, **in-sample**: the rules were written after reading the file's labels |

Round 2 misses, by cause (the starting evidence for #739): 10 literals read as a contract that the file calls operational (a `= 0` reduce start, a `?? 2048` max-tokens default, config-shaped `*_s = 90` defaults, a `timeout_s > 86_400` bound, `hops = 2`, `id = 0`, `start = 0`); 7 read as operational that the file calls a safety floor (200-character error and output truncations, `Math.min(8000, ...)` timeout clamps); 4 read as operational that the file calls a test seam (default parameters such as `timeoutMs = 2000`, `idleTimeoutMs = 600_000`, `opts.pollMs ?? 2000`); 2 read as a safety floor that the file calls operational (`MAX_FILES = 4096`, `totalBytes = 512 MiB`); 1 read as operational that the file calls a contract. The file itself is internally consistent only 78 to 88% on these shapes (default-parameter timeouts 78%, `Math.min(<ms>, ...)` 87%, constants named `MAX_*` 50%), and for `src/hub` length bounds and truncations it is 42% and 48%, so no reading of the code reaches 85% on them.

## The mechanical rules of the first batch (#738)

A key is labelled by a rule only when the rule is a pure function of its name, kind, value and file, and the committed file agrees with that rule on at least 94% of the keys it already decides. The rules, with how the file agrees with each over every decided key (the whole file, not the sample):

| Rule | Label | Decided keys it covers | File agrees |
| --- | --- | ---: | ---: |
| R1 a `constant` named `*_MS`, except unit conversions (`DAY_MS`, `MIN_MS`, ...), `*DATE_MAX_MS`, `*WINDOW_MS` and the security exclusion R1x below | operational | 51 | 94% |
| R1x a `*_MS` constant that bounds replay, revocation or rate: the window in which a replayable request is still accepted, how long a revoked or rotated credential stays valid, or the floor on how often an agent turn may be triggered | safety floor | 0 | none |
| R2 an inline literal that is the argument of `setTimeout`, `setInterval`, `Bun.sleep`, `sleep`, `AbortSignal.timeout` or `this.backOff` | operational | 134 | 98% |
| R3 an inline default named `*_s`, `*_min` or `*_ms` (a config-shaped value) | operational | 37 | 100% |
| R5 a `0` or `1` that starts a reduce, loop or counter (`start`, `id`, `count`, `sum`, `i`, `*.reduce`) | operational | 8 | 100% |
| R6 a `.slice` or `.substring` of error, output or message text in `scripts/benchmarks/` | safety floor | 28 | 96% |

R1x is the conductor's ruling on the review of PR #1212, not a calibrated rule: the committed file had no decided key of that kind (its decided `*GRACE_MS` keys are process-kill grace periods and `RATE_LIMIT_MS` throttles a log line, all operational), so its agreement is not measured. It labels four baseline keys: `tool-request.ts` `MAX_FUTURE_MS` (the replay window of request ids), `broker/store.ts` and `rooms/store.ts` `GRACE_MS` (how long a rotated epoch's frames stay accepted, which bounds how long a revoked member's key still works) and `schedules.ts` `MIN_EVERY_MS` (the floor that stops a schedule triggering an agent turn more often than every 15 minutes, a spend guard).

R4 (a `maxTokens` or `contextWindow` default, 97%) and R7 (a length bound in `src/adapters`, `src/models`, `src/local`, 91%) agree with the file, but no baseline key was labelled by R4, and R7's five baseline keys have no exact agreeing precedent, so they stay in the baseline. Taken together the rules agree with 303 of the 311 decided keys they cover (97.4%) and with 97% and 98% on the two halves of a by-file hold-out (files split by a hash of their path), which is the same data seen differently, not an independent reader.

Not labelled, on purpose: every length bound and truncation in `src/hub`, `src/cli`, `src/ui`, `src/rooms` and `src/broker`; `Math.min`/`Math.max` clamps of a timeout; default-parameter timeouts (`timeoutMs = 2000`); `MAX_*` and `*_BYTES` constants; unit conversions. #739 settles their convention first and then relabels the inconsistent existing entries by name.

## The `src/hub` convention for bounds and truncations (#739)

Ruled by the conductor on 2026-11-05. It decides bounds (`x.length > N`, `Object.keys(x).length > N`, a byte limit) and truncations (`.slice(0, N)`, `.substring`) in `src/hub`. Ask in order:

1. A validation bound on an argument of a **documented tool or control message** is a **contract**, whether or not `hub-tools.ts` repeats the number: it is part of that message's shape.
2. A bound or truncation on **free text, ids or raw input that no message shape defines** (a peer's body, a model's output, another project's or GitHub's text, a person's input) is a **safety floor**.
3. A cap on **the hub's own lists, batches or reports**, which the hub trims, pages or reports as truncated, is **operational**.
4. A bound on the **shape of a documented file format the person writes** (config, profile, role, extension, text projection) is a **contract**, like a documented message.

A number is never evidence by itself. Many unrelated schema entries share `32`, `64`, `256` or `4096`, so "the same number appears in `hub-tools.ts`" decides nothing: the first measurement of #739 counted 280 of 378 `src/hub` bounds as mirrors of a schema by number, and only a handful really repeat a tool schema's limit once the call sites are read.

### What the committed file did before this change (measured on `8e44babc`)

| Shape | Decided keys | operational | safety floor | contract |
| --- | ---: | ---: | ---: | ---: |
| `src/hub` length bounds | 213 | 63 | 91 | 59 |
| `src/hub` truncations (`.slice`) | 151 | 73 | 47 | 31 |

Among the 213, those that refuse or validate input (171) were 77 safety floor, 53 contract and 41 operational, and the file labelled the same kind of check differently by file: `tasks.ts` 19 of 20 contract, `sdlc.ts` 14 of 22 safety floor, `test-integrity.ts` 6 of 6 safety floor. Across the whole decided file 214 expressions appear in more than one place and 28 of them carried conflicting labels (133 keys), mostly default-parameter timeouts and `Math.min`/`Math.max` clamps, which this change does not touch.

### Existing labels changed by this convention (44, by key, old to new)

All 173 decided `src/hub` validation bounds (outside `hub-tools.ts`) were read at their call sites. 44 contradicted the convention and are changed; every other decided bound already agrees with it and was left alone, including `deferred-hub.ts` `env.body.length > 1_000_000` and `delivery-hints.ts` `row.id.length > 256` (a peer's raw body and a hub-built hint, no message shape: safety floor). Group membership is a reading of each call site, reviewed by the conductor.

#### A. Argument of a documented tool or control message: to contract (19)

Reason: Each is an argument of a documented tool or control message (`taskOpBody`, `uiAction`, `recoveryOp`, `onMessage`, the check runner's `files`, the planning `deps` list). The bound is part of that message's shape, whether or not `hub-tools.ts` repeats the number.

| Key | Old | New |
| --- | --- | --- |
| `check-runner.ts` `request.files.length > 32=32` (in `start`) | operational | contract |
| `daemon.ts` `a.files.length > 32=32` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `a.delivery_id.length > 256=256` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `a.delivery_id.length > 256=256` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `a.reason.length > 2000=2000` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `a.superseded_by.length > 2000=2000` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `a.release.length > 100=100` (in `taskOpBody`) | safety floor | contract |
| `daemon.ts` `liveIssues.length > 32=32` (in `uiAction`) | operational | contract |
| `daemon.ts` `a.to.length > 32=32` (in `uiAction`) | operational | contract |
| `daemon.ts` `msg.operationId.length > 128=128` (in `recoveryOp`) | operational | contract |
| `daemon.ts` `msg.launchId.length <= 128=128` (in `onMessage`) | operational | contract |
| `daemon.ts` `msg.launchId.length <= 128=128` (in `onMessage`) | operational | contract |
| `daemon.ts` `msg.launchId.length <= 128=128` (in `onMessage`) | operational | contract |
| `daemon.ts` `msg.reason.length > 2000=2000` (in `onMessage`) | operational | contract |
| `daemon.ts` `msg.id.length > 256=256` (in `onMessage`) | operational | contract |
| `daemon.ts` `msg.reason.length > 2000=2000` (in `onMessage`) | operational | contract |
| `daemon.ts` `(msg.liveIssues ?? []).length > 32=32` (in `onMessage`) | operational | contract |
| `daemon.ts` `(msg.liveIssues ?? []).length > 32=32` (in `onMessage`) | operational | contract |
| `planning.ts` `value.length > 64=64` (in `planningPatch`) | operational | contract |

#### B. Text or replies from GitHub, another project or a person: to safety floor (6)

Reason: Each bounds text or a reply that comes from GitHub, another project or a person, which no tool or control message defines, so it limits untrusted input.

| Key | Old | New |
| --- | --- | --- |
| `dogfood-read.ts` `r.pull_requests.length <= 100=100` (in `validRun`) | operational | safety floor |
| `github-import.ts` `row.title.length>300=300` (in `<anonymous>`) | operational | safety floor |
| `github-import.ts` `row.body.length>8000=8000` (in `<anonymous>`) | operational | safety floor |
| `sdlc-queue.ts` `p.baseRefName.length > 200=200` (in `<anonymous>`) | operational | safety floor |
| `sdlc-queue.ts` `threads.nodes.length > 100=100` (in `finalSnapshot`) | operational | safety floor |
| `sdlc-queue.ts` `checks.nodes.length > 100=100` (in `finalSnapshot`) | operational | safety floor |

#### C. The hub's own derived list: to operational (1)

Reason: A cap on the hub's own derived list, which the hub builds itself and reports as truncated, so it tunes a list size and is not an input bound.

| Key | Old | New |
| --- | --- | --- |
| `task-code-symbols.ts` `brief.reviewable.length > 500=500` (in `buildTaskCodeSymbols`) | safety floor | operational |

#### D. Shape of a documented file the person writes: to contract (18)

Reason: Each is the bound on the shape of a documented file format the person writes (config, profile, role, extension or text projection), which is a contract like a documented message (the conductor's wording of the convention).

| Key | Old | New |
| --- | --- | --- |
| `github-import.ts` `value.length<=100=100` (in `selectionText`) | operational | contract |
| `path-policy.ts` `raw.length > 64=64` (in `policyPaths`) | safety floor | contract |
| `config-tier.ts` `part.length > 64=64` (in `<anonymous>`) | safety floor | contract |
| `text-projection.ts` `Object.keys(raw).length > 16=16` (in `projectionConfig`) | safety floor | contract |
| `text-projection.ts` `argv.length > 16=16` (in `projectionConfig`) | safety floor | contract |
| `text-projection.ts` `arg.length > 2000=2000` (in `<anonymous>`) | safety floor | contract |
| `profiles.ts` `Object.keys(data.classes).length > 32=32` (in `resolveProfile`) | safety floor | contract |
| `profiles.ts` `Object.keys(data.role_text).length > 8=8` (in `resolveProfile`) | operational | contract |
| `profiles.ts` `data.example_checks.length > 16=16` (in `resolveProfile`) | operational | contract |
| `profiles.ts` `data.review_checklist.length > 16=16` (in `resolveProfile`) | safety floor | contract |
| `profiles.ts` `value.length > 500=500` (in `<anonymous>`) | operational | contract |
| `planning.ts` `Object.keys(input).length > 64=64` (in `planningWipLimits`) | operational | contract |
| `roles.ts` `sanitize(body).length > 2000=2000` (in `parseRole`) | safety floor | contract |
| `roles.ts` `files.length > 64=64` (in `loadRoleCatalog`) | safety floor | contract |
| `roles.ts` `Object.keys(raw).length > 64=64` (in `catalogAssignments`) | safety floor | contract |
| `roles.ts` `ids.length > 2=2` (in `catalogAssignments`) | safety floor | contract |
| `roles.ts` `roles.length > 2=2` (in `catalogSection`) | safety floor | contract |
| `roles.ts` `text.length > 2000=2000` (in `taskRoleText`) | safety floor | contract |


### Calibration after the 44 relabels (#739): the bar is not met, no baseline key is labelled

A blind 80-sample (seed 739101) was drawn from the 365 decided `src/hub` bounds and truncations of the relabelled file and read with only the convention above, the committed labels hidden: **56 of 80 (70.0%), below the 85% bar**. By shape: bounds 36 of 44 (82%), truncations 20 of 36 (56%). The convention decides bounds but not truncations. Of the 16 truncation misses, the file labels a truncation by what it is used for and the convention does not say so:

| What the truncation is | Decided in the file | Majority |
| --- | ---: | ---: |
| shortened id or hash for display (`commit.slice(0, 12)`, `sha256.slice(0, 16)`, `instanceId.slice(0, 8)`) | 23: 18 contract, 4 operational, 1 safety floor | 78% |
| the hub's own list or report cut to N (`pending.slice(0, 64)`, `history.slice(-5)`) | 20: 16 operational, 3 safety floor, 1 contract | 80% |
| error or message text into a log line or a notice (`error.message.slice(0, 120)`, `title.slice(0, 100)`) | 45: 28 safety floor, 17 operational | 62% |
| other | 57: 31 operational, 15 safety floor, 11 contract | 54% |

The 8 bound misses are display caps the file calls safety floor (`pool.walk > 16`, `paths > 20`, `guarded > 200`, `held rows >= 32`) and a gap in this change's own application: the `config-reload.ts` bounds on the shape of the person's config (`table`, `text`, `peers`, `openValue` strings and lists) fall under line 4 of the convention and were left out of the 44. So baseline labelling waits for a ruling on truncations and on those five config bounds.
