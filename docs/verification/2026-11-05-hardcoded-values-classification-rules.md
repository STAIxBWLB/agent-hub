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

Truncations (`.slice`, `.substring`) are decided by what is cut:

5. A **shortened id, hash or commit** (`commit.slice(0, 12)`, `sha256.slice(0, 16)`, a log timestamp used as an evidence id) is a **contract**: a displayed identity format that other tools and people match on.
6. The **hub's own list** cut to N (`pending.slice(0, 64)`, `history.slice(-5)`) is **operational**, and so is a **display cap on the hub's own report** (`pool.walk.length > 16`, `paths.length > 20`, a held-rows cap).
7. **Text cut for a log line, notice or reply** is a **safety floor** only when the cut text **originates outside the hub process**: a model, a peer, a person, another project, a native hook process, or a subprocess, network, git or file-parse error that can carry external content. The hub's own composed message, or its own internal error text logged locally, is **operational**. Ask where the text comes from, not where it goes.

Rulings of #741 (the conductor, 2026-11-06), added after a fresh blind sample (seed 741001) agreed on 70% and the misses fell into six shapes. They extend lines 1 to 7; where one differs, the later line decides its shape:

8. A cap on **the hub's own cache, set, map or concurrency limiter** is **operational**, and so is the line 3 reading of lists, batches and reports. Exception: decide by **what one insert is caused by, not by the name**. A set or map that gains one entry per event **another process controls** (a peer's envelope, a remote room frame, a native hook's tool call, a file a person or agent writes, an acknowledgement a caller names) is a **safety floor**: it bounds memory against outside input. A set the hub fills only from its own decisions (a check run, a launch candidate, an approval, a prepared review) is operational.
9. A **silent truncation of a tool argument** (the hub cuts it and goes on, with no refusal) is a **contract** when the limit is stated in that tool's schema (`maxLength` in `hub-tools.ts`) or in `docs/operations.md`; otherwise it is a **safety floor**. The same argument in two tools is decided per tool: `hub_backlog_split` states `title` 300 and `detail` 8000, `hub_task_propose` does not, so its cut is a safety floor.
10. **Error or stack text** cut for a log, notice or reply is a **safety floor**, unless the text is a **fixed phrase the hub composed**: then the cut is a display cap and **operational**.
11. A cap on **what a read tool returns** (edges, lines, bytes of one result) is a **contract**: it is the documented shape of that result.
12. A bound on **a field of a documented message or envelope** (a task handoff key's project id, the `refs.paths` of a deferred envelope, a hub task envelope's `refs.backlog`) is a **contract** under line 1, as is a shortened id or hash (`lease.holder.slice(0, 8)`).
13. A bound on something **parsed from git, GitHub or a subprocess** (a path inventory, a control line, a config key listing, a documents list, a tail of runner output) is a **safety floor**: it fails closed against content the hub does not write.

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


### Additional relabels (47, by key, old to new)

A second round, after the first sample showed the convention did not decide truncations. Each change was asserted against its old label when applied; nothing else changed. The 17 truncations that fit no line (for example `action-class.ts` `text.slice(i, i + 256)`, `permission-payload.ts` `full.slice` 600, `envelope.ts` `noteLine`) keep their labels.

#### Shortened id, hash or commit: to contract (6)

| Key | Old | New |
| --- | --- | --- |
| `ask.ts` `l.slice=10` (in `id`) | operational | contract |
| `daemon.ts` `publicStatus.generation.slice=8` (in `generation`) | operational | contract |
| `deliverables.ts` `createHash(sha256).update(${format}\0${path}).digest(hex).slice=12` (in `deliverableId`) | operational | contract |
| `registry.ts` `createHash(sha256).update(root).digest(hex).slice=24` (in `idFor`) | operational | contract |
| `research.ts` `createHash(sha256).update(projectId).digest(hex).slice=16` (in `projectKey`) | operational | contract |
| `task-code-group.ts` `r.head.slice=8` (in `head`) | operational | contract |

#### The hub's own list cut to N: to operational (10)

| Key | Old | New |
| --- | --- | --- |
| `activity.ts` `u.locations.slice=12` (in `updateActivity`) | safety floor | operational |
| `tasks.ts` `(Array.isArray(v) ? v : typeof v === string ? [v] : []).map(text).filter((p): p is string => !!p).slice=50` (in `textList`) | safety floor | operational |
| `tasks.ts` `holders.slice=8` (in `detail`) | safety floor | operational |
| `tasks.ts` `history.slice=-5` (in `publicHistory`) | safety floor | operational |
| `tasks.ts` `[...this.incomingBacklog].sort((a, b) => a - b).slice=64` (in `incoming`) | contract | operational |
| `tasks.ts` `[...pending].sort((a, b) => a - b).slice=64` (in `ids`) | contract | operational |
| `tasks.ts` `pool.walk.slice=16` (in `walk`) | safety floor | operational |
| `tasks.ts` `paths.slice=20` (in `list`) | safety floor | operational |
| `tasks.ts` `[...new Set([taskNode, ...symbols.nodes, ...about])].slice=64` (in `saveNative`) | safety floor | operational |
| `text-projection.ts` `(process.env.PATH ?? /usr/bin:/bin).split(:).slice=32` (in `choices`) | safety floor | operational |

#### Text cut for a log line, notice or reply: to safety floor (origin test noted per entry) (21)

| Key | Old | New | Origin of the cut text |
| --- | --- | --- | --- |
| `ask.ts` `raw.slice=2000` (in `answer`) | operational | safety floor | model output |
| `conflicts.ts` `String(r.title).slice=100` (in `<anonymous>`) | operational | safety floor | another agent's task title |
| `daemon.ts` `sanitize(row.key).slice=160` (in `retainedConfigAfterReload`) | operational | safety floor | a rejected config key the person wrote |
| `daemon.ts` `sanitize(row.reason).slice=1200` (in `retainedConfigAfterReload`) | operational | safety floor | a rejected config reason built from the person's config value |
| `daemon.ts` `${v.title ? ${v.title}: : }${v.text}.replace(/\s+/g, ).slice=160` (in `memoryLine`) | operational | safety floor | memory text written by peers and the model |
| `daemon.ts` `${v.title ?? }\n${v.text}.slice=1500` (in `note`) | operational | safety floor | memory note text written by peers and the model |
| `daemon.ts` `${c.title ?? }\n${c.text}.slice=600` (in `note`) | operational | safety floor | memory note text written by peers and the model |
| `daemon.ts` `JSON.stringify(v).slice=60` (in `peerArg`) | operational | safety floor | the caller's tool argument echoed in a refusal |
| `daemon.ts` `sanitize(e.reason ?? delivery retries exhausted).replace(/\s+/g, ).slice=300` (in `reason`) | operational | safety floor | a delivery retry reason, which can carry a native adapter's error text |
| `daemon.ts` `e.env.body.slice=200` (in `<anonymous>`) | operational | safety floor | a peer's message body logged |
| `daemon.ts` `v.text.slice=600` (in `text`) | operational | safety floor | memory text written by peers and the model |
| `daemon.ts` `msg.tool.slice=64` (in `tool`) | operational | safety floor | a native hook process's tool name |
| `daemon.ts` `msg.toolUseId.slice=128` (in `toolUseId`) | operational | safety floor | a native hook process's tool use id |
| `daemon.ts` `msg.sessionId.slice=128` (in `sessionId`) | operational | safety floor | a native hook process's session id |
| `daemon.ts` `String(msg.question).slice=80` (in `title`) | operational | safety floor | a person's question to ahub ask |
| `daemon.ts` `String(msg.question).slice=300` (in `text`) | operational | safety floor | a person's question to ahub ask |
| `deliverables.ts` `extra[0]!.slice=32` (in `own`) | operational | safety floor | an unknown field name from the caller's deliverable |
| `packs.ts` `(error as Error).message.slice=200` (in `reason`) | operational | safety floor | a project role-pack file's parse error, which echoes the file's content |
| `progress.ts` `tool.slice=80` (in `name`) | operational | safety floor | a native hook process's tool name |
| `progress.ts` `item.name.slice=80` (in `name`) | operational | safety floor | a progress item sent by a peer |
| `progress.ts` `item.source.slice=40` (in `source`) | operational | safety floor | a progress item sent by a peer |

#### Display caps on the hub's own report: to operational (5)

| Key | Old | New |
| --- | --- | --- |
| `tasks.ts` `pool.walk.length > 16=16` (in `walk`) | safety floor | operational |
| `tasks.ts` `paths.length > 20=20` (in `list`) | safety floor | operational |
| `tasks.ts` `result.length < 32=32` (in `outsideIds`) | safety floor | operational |
| `daemon.ts` `guarded.length > 200=200` (in `prepareConfiguration`) | safety floor | operational |
| `delivery-hints.ts` `result.rows.length >= 32=32` (in `heldDeliveryHints`) | safety floor | operational |

#### Bounds on the shape of the person's config (`config-reload.ts`): to contract (5)

| Key | Old | New |
| --- | --- | --- |
| `config-reload.ts` `Object.keys(v).length > 256=256` (in `table`) | operational | contract |
| `config-reload.ts` `v.length > 4096=4096` (in `text`) | operational | contract |
| `config-reload.ts` `v.length > 128=128` (in `peers`) | safety floor | contract |
| `config-reload.ts` `v.length > 16_384=16_384` (in `openValue`) | operational | contract |
| `config-reload.ts` `v.length > 1024=1024` (in `openValue`) | safety floor | contract |

#### Three omissions found by the second sample: to contract (3)

The first list of argument bounds missed three that the convention (line 1) already covers; found when the blind reader labelled them contract.

| Key | Old | New | Why |
| --- | --- | --- | --- |
| `workflow.ts` `p.criteria.length > 32=32` (in `criteriaReceipt`) | operational | contract | the `criteria` argument of `hub_sdlc_record` (schema `maxItems: 32`) |
| `workflow.ts` `c.refs.length > 8=8` (in `<anonymous>`) | operational | contract | the `refs` of one criterion of `hub_sdlc_record` (schema `maxItems: 8`) |
| `claude-launch-proof.ts` `row.launchId.length > 128=128` (in `readClaudeLaunchProof`) | operational | contract | the `launchId` control field, the same bound that `daemon.ts` `onMessage` already labels contract |

### Calibration of the `src/hub` convention (#739)

The population is the 365 decided `src/hub` bounds and truncations (`hub-tools.ts` excluded). Each round is a blind 80-sample read with only the convention, the committed labels hidden.

| Round | Seed | File state | Agreement | Bounds | Truncations |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | 739101 | after the first 44 relabels, lines 1 to 4 only | 56 of 80 (70.0%) | 36 of 44 (82%) | 20 of 36 (56%) |
| 2 | 739202 | after 47 more relabels, lines 1 to 7 | 71 of 80 (88.8%) | 42 of 47 (89%) | 29 of 33 (88%) |

Round 2 clears the 85% bar. It is **in-sample in one respect**: lines 5 to 7 and the 47 relabels were written after round 1's misses, so the sample measures whether the convention now decides what it was extended to decide, not an independent reader. A fresh seed drawn from the relabelled file is the check that matters, and it was drawn only after the relabels were applied.

Round 2's nine misses: three are keys the first list left out (`workflow.ts` criteria 32, criterion refs 8 and `claude-launch-proof.ts` launchId 128, relabelled contract above); `check-runner.ts` `lines.slice(-40)` (a cut of a subprocess's output, which line 7 calls safety floor, labelled by me operational) and `version.stdout.trim().slice(0, 80)` (the converse); `daemon.ts` `schedules pass failed: ...message.slice(0, 160)` and `tasks.ts` `task.title.slice(0, 120)` (a memory title from the task's own title, where whether the origin is outside the hub is a judgement); `execution-budget.ts` `input.id.length > 200` and `delivery-hints.ts` `held.rows.length > 32`. The remaining disagreements are about where text originates, and line 7 is the place to sharpen if a later sample falls short.

No baseline key is labelled in this change. That is #741 (below).

## Batch 1 of #741: 149 `src/hub` length bounds (#741)

Date: 2026-11-06. Refs #1180. The population is the 187 baseline keys in `src/hub` that are a length or size bound and not a truncation. The 38 left in the baseline are the keys no line decides without a ruling or a caller trace: lower bounds that only say "not empty" or "at least N" (`< 1`, `>= 2`, `< 8`, `before.size < 1`), bounds whose message the key does not name (`daemon.ts` `values.length > 256`, `tool-request.ts` scope and bucket 4096, `operational-view.ts` metadata lists, `specs.ts` `base.length > 200`), research-campaign and experiment bounds in `board.ts` (`owners`, `hostEvidence`, runner receipts), and read-side display caps in `publicReadValue`. A key left here is reported for a ruling, not guessed. Truncations (`.slice`, `.substring`) are batch 2.

### Calibration

| Round | Seed | File state | Reader | Agreement | Result |
| --- | --- | --- | --- | ---: | --- |
| 1 | 741001 | after #739, lines 1 to 7 | blind reader, lines 1 to 7 | 56 of 80 (70.0%) | below the bar: 24 misses in six shapes (below) |
| 2 | 741002 | after the 17 relabels below, lines 1 to 13 | blind reader, lines 1 to 13 | 68 of 80 (85.0%) | meets the 85% bar |

Both samples are drawn from the decided `src/hub` bounds and truncations (`hub-tools.ts` excluded), without replacement across rounds (round 2 excludes round 1's 80 keys). The reader read each key at its call site with the committed label hidden and wrote every label before scoring.

Round 1's misses, by shape: 6 bounds on a message or envelope field the file called safety floor or operational (line 12); 5 bounds on content parsed from git, GitHub or a subprocess (line 13); 4 caches, sets and limiters (line 8); 4 cuts of error or stack text (line 10); 3 silent truncations of a tool argument (line 9); 2 caps on a read tool's output (line 11). The conductor ruled each; the rulings are lines 8 to 13 above.

Round 2's 12 misses. Five are **relabelled** in this PR (the rule decides and the file contradicted it, so they follow #739's practice of changing a contradicting entry by name): `plan-conformance.ts` `planPaths.length > 1000` (operational to safety floor, rule 13: it is the same check as `completePlanInventory`, on the plan paths compared with a PR's file list read from GitHub), `usage.ts` transcript size 32 MiB (operational to safety floor, rule 13: it bounds a file a Claude process writes), `github-import.ts` 2 MiB read (operational to safety floor, rule 13: GitHub's output), `deferred-hub.ts` `env.to.length > 256` (safety floor to contract, rule 12: a field of the deferred envelope, like its `refs.paths`) and `deliverable-files.ts` `message.replace(path, "the path").slice(0, 160)` (safety floor to operational, rule 10: a guardPath refusal the hub composed). One is **decided and left**: `delivery-journal.ts` `Object.keys(queues).length > 4096` stays safety floor, because `queues` is a field of the journal snapshot the hub writes and reads back, which no document names, so rule 12 does not apply and rule 13 reads a damaged file as outside content. Six **stay open for batch 2**: `settings.ts` `presetValue` 4096, `dogfood-read.ts` `line.slice(0, 24)`, `claude-launch-proof.ts` `executionCwd` 4096, `board.ts` `failure.head.length > 300`, `code-facts.ts` `a.at.length < 9` and `spec-read.ts` `issues.size > 3`: no line decides them without a ruling.

### Existing labels changed by the rulings (17, by key, old to new; the five round 2 relabels are listed in the round 2 paragraph above)

| Rule | Key | Old | New |
| --- | --- | --- | --- |
| 8 | `check-runner.ts` `this.entries.size >= 3` (in `start`) | safety floor | operational |
| 8 | `code-facts.ts` `this.cache.size>128` (in `query`) | safety floor | operational |
| 8 | `memory-observations.ts` `this.pending.size > 2048` (in `delivery`) | safety floor | operational |
| 8 | `daemon.ts` `injected.size > 512` (in `readTranscript`, one entry per hook line a native process writes) | operational | safety floor |
| 8 | `limits.ts` `this.recent.size > 1000` (in `admit`, one entry per distinct message a peer sends) | operational | safety floor |
| 8 | `daemon.ts` `retainedCliAudits.size > 4096` (in `drainCliAuditsNow`, one entry per audit a CLI process sends) | operational | safety floor |
| 10 | `daemon.ts` `sanitize(error.message).slice=1000` (in `error`, a fixed Pi version refusal) | safety floor | operational |
| 12 | `deferred-hub.ts` `refs.paths.length > 256` (in `validateDeferredEnvelope`) | safety floor | contract |
| 12 | `tasks.ts` `projectId.length > 200` (in `handoffStateByKey`) | safety floor | contract |
| 12 | `bus.ts` `backlog.length > 64` (in `queuedBacklogIds`) | safety floor | contract |
| 12 | `daemon.ts` `g.lease.holder.slice=8` (in `goalLine`) | operational | contract |
| 13 | `plan-conformance.ts` `evidence.paths.length > 1000` (in `completePlanInventory`) | operational | safety floor |
| 13 | `code-facts.ts` `keys.length>128` (in `nativeEnv`) | operational | safety floor |
| 13 | `code-facts.ts` `control.length>64` (in an anonymous stream handler) | operational | safety floor |
| 13 | `sdlc-release-authorization.ts` `value.documents.length > 128` (in `docsVerdict`) | contract | safety floor |
| 13 | `check-runner.ts` `lines.length > 40` (in `cut`) | operational | safety floor |
| 13 | `check-runner.ts` `Buffer.byteLength(result) > 4096` (in `cut`) | operational | safety floor |

(The 17 are the 15 of the first pass and two found when rule 8 was read by cause. `daemon.ts` `error` is the Pi refusal, a fixed phrase, and the other `sanitize(error.message).slice=1000` keeps safety floor.)

### The 149 keys labelled, by label

Each key was read at its call site and decided by the rule named. 25 operational (rule 8 for the hub's own caches and display caps, rule 6 for a hub-built report), 77 safety floor (rule 13 for content parsed from git, GitHub or a subprocess, the config or environment values the hub reads and fails closed on, rule 8 for sets one outside event fills, rule 2 for free text no message defines), 47 contract (rule 1 and 12 for a documented message or envelope field, rule 4 for a documented file the person writes, rule 11 for a read tool's result). The keys are in `scripts/inventory-hardcoded-values.classifications.json`; the baseline file lost exactly those 149 and gained none (1155 to 1006).
