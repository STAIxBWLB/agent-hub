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
| R1 a `constant` named `*_MS`, except unit conversions (`DAY_MS`, `MIN_MS`, ...), `*DATE_MAX_MS` and `*WINDOW_MS` | operational | 51 | 94% |
| R2 an inline literal that is the argument of `setTimeout`, `setInterval`, `Bun.sleep`, `sleep`, `AbortSignal.timeout` or `this.backOff` | operational | 134 | 98% |
| R3 an inline default named `*_s`, `*_min` or `*_ms` (a config-shaped value) | operational | 37 | 100% |
| R5 a `0` or `1` that starts a reduce, loop or counter (`start`, `id`, `count`, `sum`, `i`, `*.reduce`) | operational | 8 | 100% |
| R6 a `.slice` or `.substring` of error, output or message text in `scripts/benchmarks/` | safety floor | 28 | 96% |

R4 (a `maxTokens` or `contextWindow` default, 97%) and R7 (a length bound in `src/adapters`, `src/models`, `src/local`, 91%) agree with the file, but no baseline key was labelled by R4, and R7's five baseline keys have no exact agreeing precedent, so they stay in the baseline. Taken together the rules agree with 303 of the 311 decided keys they cover (97.4%) and with 97% and 98% on the two halves of a by-file hold-out (files split by a hash of their path), which is the same data seen differently, not an independent reader.

Not labelled, on purpose: every length bound and truncation in `src/hub`, `src/cli`, `src/ui`, `src/rooms` and `src/broker`; `Math.min`/`Math.max` clamps of a timeout; default-parameter timeouts (`timeoutMs = 2000`); `MAX_*` and `*_BYTES` constants; unit conversions. #739 settles their convention first and then relabels the inconsistent existing entries by name.
