# Changelog

Issue and pull request numbers in the entries for 0.7.7 and earlier refer to the previous repository, archived on 2026-09-30 when this repository's history was rewritten; the one exception is the open smoke-check issue, formerly #12, which moved here as #1. Numbers in newer entries refer to this repository.

## Unreleased

- `ahub help` groups the commands into sections, starts every description at one column and wraps at word boundaries to the terminal width (80 to 100 columns), colored with the console palette only on a terminal without `TERM=dumb` or `NO_COLOR`. `--help`, `-h` and `help <command>` work, and `ahub <command> -h` (or `--help`) given as the only argument prints that command's help instead of running it, except for claude and codex, which pass it to the agent; an unknown command prints a one-line hint instead of the full list. The console shares the word-aware wrapping, which also covers the wrapping item of #213: the help overlay, approval titles, details and stream lines break at word boundaries. A continuation line starts four columns deeper than its source line (at most half the width), so wrapped peer text in the console stream never starts at column 0 or 2, where headers and event lines start; a wrapped line that starts like a hub header keeps its `> ` marker, now counted in its width (#212).
- A Claude session started without `ahub claude` (`AGENTHUB_CHANNEL=1`) has no channel evidence and attaches tools-only: it declares no channel and never reports a delivery `accepted`; its messages stay queued and `hub_inbox` reads them, one push delivery's worth at a time, as `completed` deliveries, under the same holds as pushes. It stands by instead of taking the peer from an `ahub claude` session, while `ahub claude` takes the peer from it with pushes. `ahub status`, the console and the dashboard name the state and the next action, `ahub claude` (#205).
- Control protocol 16 (hello `channel`, `inbox`). The upgrade coordinator accepts protocol-15 sources (0.12.17 through 0.12.19); the live upgrade from a running protocol-15 hub is still pending.
- Let a task's current owner and reviewer read its public view with history through `hub_task_show`, so a reviewer sees the done summary and check line; PII tasks stay stubs and other peers stay refused (#208).
- Keep `owner` with `after` as a reserved owner offered the task first once it is ready, falling back with a notice when that peer is offline, paused, declined or excluded by PII; let a proposer redirect its own unaccepted task; `ahub route explain` shows the reservation (#207).
- Add session-aware stay/switch for Pi's `hub/auto` and hub stage routes: a hard override escalates at once, a tool loop keeps its tier, other changes wait for a user turn, and a de-escalation over `max_switch_prefill_tokens` stays; no route summarizes or trims the history. Top-level `stay_switch` in `routing.toml` is `off`, `shadow` (default: route events record the planner's verdict, routing unchanged) or `enforce`; `ahub report` counts model changes per session and inside tool loops. Enforce stays opt-in until measured (#197).
- Try the DGX fallback first, keeping MLX behind it, when an efficient `hub/auto` request finds the MLX slot busy past `[pi] efficient_wait_ms` (default 500) or MLX is cooling down; cool a relay alias down after three consecutive transport or startup failures (30 s doubling to 5 min; a busy slot and budget-cut timeouts never count, and any HTTP answer ends it). Load and cooldowns only reorder a request's backends, a moved attempt gets 15 s to answer before MLX takes over, and nothing moves under an execution budget, so they never fail a request MLX would have served. `ahub status` and `cooldown` events show it (#199).
- Events schema stays 1: route events gain optional fields and sources, and `cooldown` is a new event type.

## 0.12.19

- Pi's write, edit, bash and git write approvals offer `Always allow <tool> until Pi restarts`: later calls of that tool by the running Pi skip the prompt, still under the path guard and sandbox. The grant is in memory only, logged by tool name, and the dashboard can still only deny (#209).
- Control protocol stays 15 and events schema stays 1; a running 0.12.18 hub upgrades with the 0.12.19 coordinator.

## 0.12.18

- Attribute token increments, provider usage and completed turns to task ids by delivery or a single open task; add `ahub report --by task` with task/class totals, explicit unknown counters, unattributed shares and a separate historical bucket. Preserve PII id-only exports and derive no prices (#200).
- Add semantic colors to console stream headers, footer and panels with `--color=auto|always|never`; keep plain-text Unicode geometry, sanitize incoming controls before the fixed palette, and restore terminal attributes on exit. Tail, logs, JSON and polling remain unchanged (#201).
- Control protocol stays 15 and events schema stays 1; a running 0.12.17 hub upgrades with the 0.12.18 coordinator.

## 0.12.17

- Add an operator console with confirmed approvals, bounded status polling and optional peer, approval, task, queue and event panels; open it from interactive `up` and preserve the tail renderer (#190, #191).
- Identify agent shell CLI calls as their peer, refuse human-only commands before connecting and record ids-only audit notices without an as-user bypass (#193).
- Grant steering tools only to one explicit conductor role, preserve the actor on task changes and keep conductor holds separate from human, budget and recovery holds (#194).
- Batch public task milestones and human-action reminders through the existing digest window, replace repeated pending notices and report completed native supervision turns with unknown usage preserved (#195).
- Advance the control protocol to 15 for approval lifecycle and supervision metadata, retaining controlled recovery from supported previous sources.

## 0.12.16

- Record source-verification commits for current operating documents and agent notes; fail missing coverage, invalid stamps and README version drift, and report stale source scopes deterministically (#188).
- Require six sequential guard checks to pass without mutation and fail their named assertion with a seeded regression. Reuse full Linux/macOS plus seeded CI only for an identical release tree (#187).
- Add a default-off task-idle sweep with persisted escalation steps, real-activity anchors, PII-safe notices, hold/cohort suppression and explicitly opted-in owner reassignment (#186).
- Preview initialization changes and native launcher arguments through the same builders, without hub writes or native startup; redact arbitrary user values and identify unresolved runtime metadata (#189).
- Show native Claude/Codex context-window readings with freshness and session identity. Optional pressure checkpoints do not pause quota, reassign work or replace sessions; unknown readings stay unknown and private summaries stay out of cloud memory (#185).
- Advance the control protocol to 14 for context status metadata while retaining controlled recovery from supported earlier protocols.

## 0.12.15

- Bind Pi tool-step ceiling diagnostics to the trusted producer's session and turn, retain the rejected pre-effect invocation count, and keep the first active failure cause frozen (#179).
- Add bounded sealed-study status coverage, with audit/ledger/manifest bytes bound to the seal index and planned, scored, passed, unavailable, missing, native end classes and recorded restoration shown separately (#180).
- Carry the shared managed-tool failure verdict through Pi's bridge to native `isError`, preserving result text and compatibility with older bridges (#181).
- Publish Pi benchmark descriptors for the executor's actual source-write and git ls-files policy, with peer messaging only in the joint arm; production descriptors stay unchanged (#182).
- Attest every native bootstrap publication against structural schema and source fingerprints. Reject malformed, mixed, changed or missing final publications before scored generation; permit only the pinned Qwen MCP startup transition. Declare the corrected surface as a new study condition and preserve historical studies (#183).

## 0.12.14

- Normalize the remaining `ps lstart` identity reads to the shared pinned `LC_ALL=C`/`TZ=UTC` contract: the terminal-recovery launcher signature now goes through `processSignature`, and the MLX owner/generation identity read pins the same environment, so a record written under one timezone or locale still authenticates the same live process under another; strict PID/start/command identity and the fail-closed refusal paths are unchanged (#177).

## 0.12.13

- Bind serialized original manifest copies to their own pin in study summary export: the copy's bytes verify against `original_copy_sha256` with the raw source pin kept distinct, the copy must equal the supervisor's canonical serialization of its parsed contents, and the runtime manifest may differ only by the recorded hub-version amendments; legacy provenance without the copy pin refuses explicitly instead of receiving an invented pin (#173).
- Normalize Pi process-signature inspection to one pinned `LC_ALL=C`/`TZ=UTC` ps contract shared by the adapter, the Pi extension and the TUI owner monitor, so a valid native owner is accepted when the parent's timezone or locale differs from the child's; strict PID/start/command identity, owner token and generation/session checks are unchanged (#174).
- Export bounded active-window diagnostics for Qwen's native tool-call loop protection stops: a fixed terminal class bound to peer/session/generation with pinned-message evidence (anything else stays unknown), scalar-only counters that keep update events, distinct call ids, settlements, expected denials, tool failures and repeated announcements distinct, and an allowlist-built public view that cannot carry titles, arguments, paths, raw messages or dynamic keys; no native guard threshold is derived from event totals (#175).

## 0.12.12

- Restore owned native cohorts when a study supervisor is interrupted: bounded orderly cancellation with signal-time verified child identity, restoration settled only when the marker and ledger agree, a bounded identity-checked fallback with explicit restoration-failure records, and the interrupted phase, cause and restoration status persisted before the incomplete exit. Grading never starts after interrupted generation, and no resume, root reuse or retry is added (#168).
- Diagnose native sandbox probe failures with a bounded structured outcome: a fixed-enum, count-only probe trace bound to peer, session and setup window explains why the protected-file evidence predicate was not satisfied (agent behavior, tool event coverage or normalization, with unresolved causes explicitly unknown), exposed as the unavailable setup reason in serialized readiness. The #138 and #150 evidence predicates are unchanged and the safe view cannot carry paths, arguments, answers or arbitrary strings (#169).
- Persist scalar progress for long native studies separately from the verified milestone phase: command kind, repeat ordinal, retained/planned committed-record counts, updated timestamp and verified child identity, with a bounded `status` command that reports stale, crashed, pid-reused and unreadable observations as explicit unknown/stalled and never advances a milestone from progress (#170).
- Export an audited, versioned per-arm study summary (JSON, optional CSV) after the final audit: planned/scored/passed/unavailable/missing counts reconciled with the audited cells, setup and active medians with valid-completed and common-pair denominators, and native usage, relay usage and provider availability kept distinct. The summary is hash-bound to the manifest, audit, grades and ledger, refuses inconsistent bindings or unsealed studies, and is built allowlist-only so private row content cannot enter it (#171).

## 0.12.11

- End native benchmark attempts on terminal Pi or Qwen failures, retain the first failure cause at the final deadline tick, and gate peer-failure patches on active-window tree preservation (#160).
- Validate ACP native counters without treating context occupancy as consumed tokens; record independent request usage and provider coverage with request-bound primary/fallback linkage (#161, #162).
- Add `mlx.enabled=false` to omit local inference while preserving remote `hub/auto` fast/coding selection, with explicit launch/recovery conflict diagnostics (#163).
- Separate exact native-response, primary-route and fallback verdicts in Pi smoke; add optional `--require-primary` (#164).
- Add a durable, version-bound native study supervisor and scalar-only evidence audit; keep generation ahead of evaluation, refuse reused roots and preserve private artifacts (#165).

## 0.12.10

- Preserve each Pi/Qwen peer's observed sandbox-probe result in v3 readiness; failed or missing native probes never synthesize a denial (#150).
- Dispatch native v3 runs through their own coordination ledger, preserving completion, timeout and setup-error classifications independently from official quality; derive model identity and linkage from the request journal and bound timing medians to valid completed attempts (#151).
- Count official native usage only for actors with started sessions, keeping Pi incremental counters and Qwen session totals separate (#152). Apply the same participation gate to v3 ledger aggregates, with known, unknown and absent measurement coverage (#156).
- Allow trusted served-model expectations in relay mismatch checks when a provider-prefixed upstream identifier differs from the physical generation model (#139, #140).

## 0.12.9

- The CooperBench native runner proves each prepared fixture root is still the directory preparation left before anything is locked, written or launched, and each arm checks its own again first (#119): a root replaced after preparation by a symlink to an equivalent outside tree passed the lexical `resolve()` comparison and the baseline content checks and would have redirected setup and agent writes there. The check is read-only (`lstat` and the real path, never a follow), so a substitution is refused without touching its target; a sibling fixture root that is itself a symlink is refused before the sibling-artifact walk reads it.
- The model relay no longer lets a gateway heartbeat name the served model (#137): an SSE event carries model identity only with generation activity (a delta with any field, a role-only first chunk included, a finish reason or a non-streaming message), so a keepalive with `choices: [{index: 0, delta: {}}]` cannot pin `actualModel` to the synthetic `keepalive` label and refuse the real model that follows. A heartbeat-only or cancelled-before-identification stream leaves the served model unknown; no requested alias is substituted.
- ACP tool identity is bound to the announced call, not the permission request title (#138): Qwen 0.24.7 announces an MCP call as `hub_send (agent-hub MCP Server)` and then titles the permission request with the serialized arguments, so the exact-name auto-approval never matched and the manual prompt showed the argument JSON twice. The announced title is cached per call id (cleared on reuse, evicted on completion, bound at the initial `tool_call` only — a later update's mutable display title never rewrites it), and a request resolves to the canonical `mcp__<server>__<tool>` name only when the server half is a server the session was configured with. Argument text never becomes an identity candidate, approval still picks only `allow_once`, and an unresolved or cut payload keeps its conservative manual path, displayed under the announced title.
- The model relay journals request-bound identity and cancellation provenance (#139): every upstream dispatch attempt (a fallback is its own record) closes exactly one sanitized `RelayRequestRecord` — resolved alias, upstream-configured model, observed provider and served model with their source (gateway header, generation SSE event, or local MLX configuration), outcome, duration and a confirmed-mismatch flag — exposed through `relay.requests()` (last 1000) and an `onRequest` hook that can neither break the proxied stream nor reject unobserved. A backend's mutable last-served label is never a request's evidence, HTTP 200 plus the requested alias identifies nothing, a request cancelled before identification stays explicitly unidentified, and a primary/auxiliary role stays unknown without native evidence. Records carry no prompts, tools, keys or Access headers.
- The Pi and Qwen native CooperBench study driver is versioned as manifest v3 and `scripts/benchmarks/native-pi-qwen.ts` (#140), pinning hub 0.12.9: the 2026-10-04 private calibration study (arms solo-pi, solo-qwen, joint-pi-qwen; Pi 1.0.1, Qwen 0.24.7; 60 preregistered attempts) becomes a regression-tested headless path that never touches Orca. The pinned build is the effective one — each native's `--version` runs under the final isolation environment, because Qwen's PATH bootstrap reported the managed 0.24.7 and fell back to base 0.24.1 under `QWEN_HOME` isolation; the protected-file probe counts only with structured denial evidence, never a model-written marker; source guards follow each case's `source_dirs` (`src/` for Click/Jinja, `dirty_equals/` for dirty_equals); new source files enter the binary submission patch (`git add -N`); setup resources are disposed on every exit path without erasing the active-window record; existing attempt evidence is rejected before any record is written (`wx` claims); served-model evidence is each request's own journaled record, where only cancelled-before-identification is non-evidence and an identified mismatch fails the gate whatever the outcome; and Qwen's peer tool approval is the exact canonical name through the adapter's #138 binding, not a title workaround. Grading flows through the same official evaluator adapter with quality, model and request-linkage coverage reported separately. The live cohort, official Docker controls and native readback remain manual live legs.

## 0.12.8

- Port Switchyard's Stage signals/scoring, Plan/Execute, advisor gate and escalation policies in-process with source-based golden tests and Apache-2.0 attribution (#124, #125).
- Add opt-in `hub/` local-worker routes with fixed-model fallback, bounded fail-open judges, completed-turn REDO history and campus-only PII transport. Each local routing decision has an id and exactly one joined outcome label, including failure, cancellation and later escalation; labels contain identifiers and closed values, never text (#126).
- Add Pi's `hub/auto` alias with session-scoped Stage hold, MLX input/output admission and DGX fallback. Preserve explicit backend pins and the class-specific DGX fast/coding defaults (#127).
- Record aggregate peer progress and suggest reassignment only from repeated failures across known native turns or spinning. Exclude PII, group native attempts, ignore replayed Pi receipts and stop judging after latch; retain observation series and coverage limits in benchmark ledgers (#128).
- Preserve retrieval semantics for shell reads, attached output redirections and Unicode fingerprints. Budget escalation anchors to retain the newest trajectory; this intentional upstream correction is documented in the source-port spec.
- The control protocol remains unchanged. Optional typed judges, Pi advisor stream replay, Rust differential verification and sidecar retirement are deferred.

## 0.12.7

- CooperBench runner and recovery (#120): from the moment the runner may change anything, before it locks its first input, `restoration.json` says `restored: false` and names the runner, until the runner writes its outcome. A runner killed after that point sends the recovery in, and the recovery waits while the runner it names still runs. A run directory whose earlier run is not restored is refused first, before the runner reads its inputs or any mode (the refusal names `restore.ts`), and checked again right before the runner locks anything, so a runner does not record locked modes as the originals; two runners started on one directory at the same moment are not guarded against. A directory whose earlier invocation ended restored, with no records, can still be used. `restore.ts` trusts `restored: true` only when the restoration ledger agrees (a ledger from before 0.12.5, with no runner identity, still has its locks restored; when `restoration.json` says `restored: true` or names a runner, its trust entry is kept as it was then), so a stale file over a re-run that died no longer reports a run restored while its inputs stay locked; it checks the runners again right before it restores anything. With no ledger, nothing was locked and nothing is restored.
- CooperBench manifests v2 and the #106 ablation pin hub 0.12.7.
- Bun 1.4.2 in CI, the release workflow and the plugin bundle build. Bun 1.4.2 still throws for a real path with a backslash, so `realPath` stays, and still runs the next test inside an outer spawnSync's event loop after a timeout, so `check.sh` keeps its test timeout and watchdog. On 1.4.2, a model relay that is closed while it streams a response gets an error printed by Bun when it aborts that stream ("model relay closed"): log noise, not a failure (#121).

## 0.12.6

- Agents the hub spawns through ACP (Kimi) and Pi run in their own process group and are stopped as one, as the Codex app-server is since 0.12.5. A stop with or without a group drops the child's pipes, so a process it left cannot keep the hub alive. Once a launcher has exited, its group is followed until it is gone, and members still finishing their exit get a bound before the stop fails. A Codex start that fails reports its own error. The group stop finishes as soon as the leader has exited and a read shows nothing left. As for Codex since 0.12.5, a Kimi or Pi that crashed and left processes in its group (an MCP server, a tool command) is not restarted until they are gone: the error names their pids (#115).
- Split predictions (shadow only): busy counts as taking the task in question only while the peer is still in the turn that task started (delivered at once to the idle peer) or in which it claimed the task. A task queued, held or steered into a turn about something else is not taken, a turn that ended takes its hand-overs with it, and a routed peer busy when the record is taken is not available (#109, #115).
- Claude Code's version is read from the transcript again only when the transcript changed (#115).
- Tests: `scripts/check.sh` runs `bun test` with a 20 s timeout and under `scripts/hang-watch.sh`, which samples and stops a run past its bound. In Bun 1.3.14 a test timeout that fires while `Bun.spawnSync` runs can start the next test inside spawnSync's event loop, where another spawnSync then spins for good: the stacks of two local hangs under load show it, and the macOS CI hang of 0.12.5 matches them (minimal reproductions did not hang). The permission test no longer depends on runner speed (#115).
- CooperBench runner and ledger (#115):
  - The runner never adds or removes an Orca registration, which needs the user's explicit authorization: every fixture of the selection is looked up read-only before anything is changed, a missing or ambiguous one refuses the run, and each arm checks again, before touching its fixture, that its identity is the one preflighted (#117, #118).
  - A trust write that never landed is `not_written`, not `changed_concurrently`, also after a failed restore and in the recovery; its temp files are removed in the runner and the recovery (also one a runner left when it died in its own restore), one that cannot be removed keeps the trust entry open for the next recovery. A write the runner knows never landed is `not_written` on every path, and neither the runner nor the recovery then touches an entry; for a runner that died mid write, the recovery takes back only an entry exactly as the runner would have written it; one the user changed meanwhile is never taken back.
  - The ledger shows normal shutdown errors, and reports records kept in `recovery/` as withheld attempts, not missing; a record caught in the middle of the recovery's move counts once, as withheld, and attempts a still-locked `runs/` hides are `unreadable`, not missing, in the per-arm summary too, where an arm with no record at all is listed with what it owes.
  - Records carry the platform, and the runner refuses non-macOS.
  - An unresolved process's program name is its executable's name as the kernel recorded it (`ps -o ucomm`), checked against its start time, never its arguments; it is omitted when it cannot be read.
  - The end reason is one function, and shared helpers are not duplicated.
- CooperBench manifests v2 and the #106 ablation pin hub 0.12.6.

## 0.12.5

- The Codex app-server runs in its own process group and is stopped as one, with what it started in groups of its own (MCP servers, tool commands): after SIGTERM, to its group and to each recorded process that leads a group of its own, and a grace period in which what it starts is recorded, the tree is frozen, read again and killed, and the stop is done only when the table shows none of it (or, when no table can be read at all, when its own group is gone); a launcher that exited before the stop while its group still has members fails the stop, its group unsignalled. `codex` is a node launcher, and mid-turn the native app-server does not exit on SIGTERM: the SIGKILL that followed reached the launcher alone, leaving the app-server at work under init and the hub process alive after `ahub kill` reported it stopped. The CooperBench runner's teardown is verified (#113): every process an arm starts that the reads see is recorded with its pid, start time and the evidence that it is the arm's (a fixture name in an argv is never proof on its own), read again every 5 s while the agents work and while Claude ends its turn (one that detaches between two reads, outside the fixture and without it in its argv, is not seen); a process with a fixture in its argv or as its working directory that is not proved the arm's is never signalled and keeps the cleanup open; teardown pauses the agents, lets a completed arm's Claude end its turn (up to 30 s, by the transcript's `turn_duration` row proved on the probe turn), asks for the normal shutdown, reads the process table back in the C locale and in UTC (a start time is part of a process's identity), signals only re-read identities, and records `clean`, `clean_with_fallback` or `incomplete_or_unknown` apart from the end reason. Evidence is taken after it, and the read locks and protected inputs come off only after a complete cleanup (otherwise `scripts/benchmarks/restore.ts` does it later, once the runner, every recorded process and anything in the fixture are gone). Run records carry the completion, cleanup, restoration, stage times and a summary of the Codex skills `skills/list` reports (its answer itself is not kept); a record from before 0.12.5 is judged by its own cleanup and trust flags, as then, and its teardown is shown as not verified (0.12.3 and 0.12.4 recorded only that the shutdown steps reported success, with no process readback); `teardown.ts` is pinned with the runner sources; runner commands run in their own process groups.
- Turn-free facts: files seen under a named directory beyond the 200 followed have a notice of their own; it and the touched-limit notice are spent only when an offer carrying them is read back (a name a PII pattern matches is counted, never named; an offer read back after its file was covered again and dropped again does not spend the later notice), and a new session hears only the drops of its own; it also starts its touched list afresh. A directory file rewritten with HEAD's bytes, which git lists until it refreshes its index, is neither named nor counted against `current()`; a file too large to read is compared by git's blob id of its raw bytes while all such files in one comparison total 64 MiB or less, and named otherwise (git's filters are not applied, so an end-of-line conversion or LFS makes it read as changed). The `fact` event carries `named` (directory files named without a diff), and the ledger counts them (#112).
- Split predictions (shadow only, routing unchanged): every hand-over records the new owner's profile (hub version, agent version from app-server or Claude Code's transcript, coordination mode); the other owner of an overlapping task not started yet counts as available while it is busy taking it (an owner goes busy as its task is delivered); observations accumulate across hub runs, one per hand-over (a decline or an escalation away counts against the peer that failed), and count only with the peer's current profile. A prediction is recorded when routing chooses the first owner of a task overlapping another owner's task not started yet (`where: "routing"`, the calibration record; `route explain` shows the same pair); cohort-time records carry `where: "cohort"` (#109).
- CooperBench manifest v2 and the #106 ablation pin hub 0.12.5, Codex 0.160.0 and Claude Code 2.1.288.

## 0.12.4

- A completed-change or edit-conflict notice is checked again for each recipient right before it is handed over, after condensation: a copy whose task has closed, changed owner or is gone is dropped instead of starting a turn, recorded as discarded and as a `stale` event. Other recipients and unrecorded envelopes are delivered as before (#106).
- Opt-in `coordination: "turn-free"` (advisory stays the default): owners of overlapping tasks form a cohort, silent only when every owner's context path is verified and no PII task is open. Messages between members are held back for those members only, with an explicit sender result and no charge against the sender's limits when nobody got them, until the sender has stopped after its task closed; that settlement is never undone, so a member's later turns are new work. A PII task opening lifts silent cohorts for good and says so. The member that finishes last (a console done counts as an intent) is asked to integrate, and its next done counts only for the same owner, cohort revision and files once the others have stopped; after three requests the outcome is recorded as unresolved. After a restart each peer's open overlapping tasks are told that overlaps are settled by message again, with the completed-change notices the silence held (#107).
- Turn-free facts at tool boundaries: what changed in an owner's files since it acknowledged them, with attribution only on effect evidence, offered through Claude's hooks (`ahub claude` adds them before and after every tool call and at Stop) or by steer into a running Codex turn, and acknowledged by a readback in the native session (facts sent with an integration request: by the next done). A Claude Read counts as seen only when it returned the whole file; a diff that matches a PII pattern is not shown. Contained paths, small regular files, tracking reset after PII. Control protocol 13; 0.12.3 (protocol 12) remains an upgrade source (#108).
- The split rule is a shadow prediction only: routing never changes; an overlap that forms or changes a cohort records a `split` event for the task, routed or named, and `ahub route explain` shows the trace, unknown unless its assumptions hold (an overlapping task its owner has started is other work) (#109).
- CooperBench manifest v2 adds a turn-free arm with hooks and status lines equal across arms and a planned-attempt check; a separate manifest is the #106 ablation (`experiments.stale_notices: "deliver"`); the grader grades completed and timed-out attempts and refuses a turn-free attempt whose tasks did not stay in one silent cohort, or any attempt whose records show a hook that is not the hub's; repeats rotate the arm order; run records carry their hook and MCP conditions; `scripts/benchmarks/ledger.py` reports every measure with its unit and coverage over one or several run directories, including in-task and whole-attempt usage per agent with tokens, completion and native settlement times, facts, hook timings and held-back messages, the grader's validity gates, and identifier and fragment contributions (#110).

## 0.12.3

- Fix live Claude delivery settlement holds, add generation-bound explicit completion and pending-settlement status (#100).
- Record local provider usage and optional native Claude usage with served-model provenance and explicit coverage (#101).
- Add opt-in persistent shared execution budgets for instrumented local and Pi peers; preserve legacy step units (#102).
- Version the fixed-sample native CooperBench runner and artifact audit (#103).
- Limit the test leak guard to verified processes owned by the current suite (#104).

## 0.12.2

- An edit approved after another peer changed the file now applies its fragment replacement to current contents. It rechecks that the old fragment still matches exactly once and refuses a stale match. Both write and edit revalidate their paths after approval, so a path replaced with an escaping symlink during the wait is refused (#98).

## 0.12.1

- Exhausted task deliveries escalate with the last error and notify the console. Three consecutive exhausted deliveries exclude a peer from routing until a delivery completes. A local worker validates its gateway, model inventory and a minimal availability call before attaching; doctor flags an unserved fixed model (#89).
- A `needs_review` delivery announces the queue hold once with inspection and resolution commands. Status, task assignment and route explanations identify the held delivery; the operator still decides its outcome (#90).
- Conflict detection includes tasks in review and reports shared files in overlapping completed turns to both owners, once per task pair and file, with their turn ids and without attributing the changes (#91).
- Reviewer candidates include attached peers with the `reviewer` role after the review class's preference list. A task assigned without a reviewer explicitly says that completion approves directly and lists the skipped candidates (#92).
- An idle local worker can be restarted on an explicit model or route; a busy worker refuses the change with a reason, and a failed model validation keeps the existing worker (#93).
- Pi's reported assistant usage reaches turn records and `ahub report`, including tool-loop messages, before the turn settles (#94).
- An idle peer with no open owner or reviewer work and no queued or active delivery is paused without spending a checkpoint turn (#95).
- Control protocol 11 adds queue hold diagnostics. Its recovery coordinator authenticates protocol 9, 10 and 11 sources; upgrade using the target release's coordinator.

## 0.12.0

- The egress proxy logs every refusal: an oversized request header and an unreachable listed host now leave a `network: refused` line too, the latter with its error code, never the error text; a failure after the tunnel opened closes the connection instead of writing an HTTP answer into it (#81).
- Behind NAT64 with the well-known prefix `64:ff9b::/96`, the egress proxy judges an answer by the IPv4 address it carries, so a listed name that resolves to an internal IPv4 host through DNS64 is refused; the local-use prefix `64:ff9b:1::/48` is refused outright, and a scoped IPv6 address (`fe80::1%en0`) counts as internal. A network-specific NAT64 prefix is not recognised (#82).
- `local.sandbox: "allow-default"` is removed: the local worker's and Pi's commands always run under the deny-default sandbox, and a project that still sets it starts normally with a note in `hub.log` and `ahub doctor` (paths a toolchain needs go in `local.read_allow`). `local.bash_network: "direct"` still works until 0.13.0, with the same note naming that release (#83).

## 0.11.0

- Task operations settle model-written arguments before anything reaches the board: an `owner` or `peer` that is not a peer id, or a task id that is not a whole number, is refused with a clear message instead of leaving an ownerless task behind after a database error; `null` and an empty owner mean no owner (#70).
- Review outcomes are credited to the work they judged in more cases: task paths are stored in one spelling (`./src/a.ts` and `src/a.ts` are one file for blame, and `.` blames nobody), and handing a task to the owner it already has keeps an earlier catch; ownership events now record the owner in the task history (#67).
- After a crash, `pi.auto_start` brings Pi back on its recorded headless session, with or without `recovery.auto_resume_after_crash`, and on a fresh session (on the recorded backend and model) if that resume fails; before, a fresh Pi started and the recorded session could not be resumed while it ran (#66).
- Tests cover a refused `hub_send` from the local worker and from Pi, a Pi resumed after `kill -9` on the session file the dead run recorded, and the crash report for Codex and Claude (#68).
- Model-written text on an ordinary task is screened before it leaves the hub: a done summary, a review note, an unmet item or a budget handoff that matches a PII pattern is not saved to claude-mem, and every peer (the local worker included) gets a stub naming `ahub task show <id>`; the board keeps the text, and `ahub ask` shows such a note only on campus (#69).
- With `local.bash_network` on, the local worker's commands can read Python's own CA bundle (`certifi/cacert.pem`, also vendored by pip), so `pip install` and `requests` work over HTTPS; every other `.pem` stays denied (#64).
- Each command the local worker runs gets a temp dir of its own (`TMPDIR`), removed when it ends, a timeout or kill included; under deny-default the shared temp dirs (the user's and `/private/tmp`) are closed, so a command can no longer read what other tools left there (#63).
- Under deny-default, Apple's `/usr/bin` shims (python3 among them) work with a full Xcode selected: the sandbox opens the app's whole `Contents`, since its tools load `SharedFrameworks`; 0.10.0 opened only `Contents/Developer`, so they worked with the Command Line Tools only.
- With `local.bash_network: true` the local worker's and Pi's commands reach the network only through the hub's egress proxy: HTTPS to the hosts in `local.network_allow` (machine-local; by default the npm, PyPI, crates.io and Go module registries and GitHub), with names that resolve to internal addresses refused and each policy refusal logged by method and host; direct egress and loopback to claude-mem or the Codex app-server are denied. `"direct"` keeps the open network for one release (#65).

## 0.10.0

- Review checklists and review outcomes: review requests ask the reviewer to map signatures and call sites to the plan, read the check result and list unmet items (`hub_review {unmet}`); the hub records approved, caught, contradicted and escalated reviews per implementer, reviewer and class, shown by `ahub task show` and `ahub route explain`, and `review.adaptive` (off by default) orders reviewers by that record, after idle before busy and ahead of quota. A record counts tasks, a catch belongs to the owner whose work was caught, and only a failure on the same file or symbol contradicts an approval (#35).
- Recovery after an unplanned stop: the hub keeps each attached peer's session identity while it runs; a hub started after a crash reports what happened to each peer in `ahub status`, resumes Kimi (ACP `session/load`), a headless Pi and the local worker (on its recorded route) when `recovery.auto_resume_after_crash` is on, and gives each peer a notice of its deliveries left in `needs_review` with its next delivery. A stop someone asked for, even one past the shutdown deadline, is not taken for a crash (#37).
- The local worker's sandbox starts from deny default: commands may run and read the system, toolchain and project directories (and the selected Xcode or Command Line Tools dir) and write the project and temp, nothing else; `/Applications`, `/nix`, `/Volumes` and `/Users/Shared` now need `local.read_allow`; `local.sandbox: "allow-default"` (machine-local) keeps the profile of 0.9 and earlier for one release; with network on, the public CA bundles stay readable for TLS. Per-peer `capabilities` (`propose`, `assign`, `remember`, `important`) are enforced by the daemon, a malformed entry grants nothing and every refusal is logged, under deny-default the worker's commands can no longer reach the LaunchServices, CoreServices or SecurityServer brokers, and a test pins that a peer can never answer a permission request (#39).

## 0.9.0

- Early conflict detection: in a git work tree, a turn that changes a file another owner's open task changed earlier warns both owners (and the console, and `events.jsonl`), once per file and task, marked concurrent when another peer worked meanwhile. `ahub check-path` and the PreToolUse hook template `templates/claude-hooks.json` give Claude the same warning before an edit, without blocking it (#32).
- Task dependencies: `hub_task_propose` takes `after: [ids]`; a task waits, offered to nobody and not claimable, until those are approved, then goes through assignment (a task the hub stopped before offering is offered once it runs again). `hub_task_list {ready: true}` and `ahub board --ready` show the ready queue, and existing boards gain the column on open (#34).
- Quota-aware routing: candidates with quota readings are ordered by headroom per hour to their reset, so the window that resets first is drained first; a paused peer whose window resets within `budget.wait_max_min` (30 with a project config) keeps its work unless a task is `urgent`; and a peer whose recent failures in a class outweigh its approvals there is demoted for that class, with a one-day half-life. `ahub route explain` shows both, and `ahub task propose ... --urgent` marks a task urgent (#36).
- Per-sender limits on what agents send: token buckets per sender, per recipient and for `[IMPORTANT]`, plus dropping the same text to the same recipients, answering the same message, within a window. A refused `hub_send` answers with the reason and the seconds to wait; a turn answer over the important budget goes out as status, and one over a rate limit is dropped, the agent hearing why with its next delivery. `[FYI]` and the console user are never limited (#38).
- An upgrade or controlled restart from a 0.9.0 or later source waits for completion checks and console task operations still in flight; one that finished after the commit used to leave the operation blocked at verification, unable to resume or abort. A 0.8.x or older source cannot report them: wait for its checks by hand before upgrading (see the operations guide) (#50).
- Upgrading a running 0.7.x or 0.8.x hub with tasks on its board verifies the board although 0.9.0 adds the `deps` column, like 0.8.1 did for `plan` (#50).
- Turn snapshots no longer miss an edit that keeps a file's size and lands in the second git last wrote the index: the snapshot's copy of the index now keeps the original's time, which git's racy-entry check compares against in whole seconds. A missed edit could leave a file out of `ahub undo`, let undo restore over another agent's later change, or skip an early conflict warning (#60).

## 0.8.1

- Upgrading a running 0.7.x hub that has a task on its board no longer stops at verification ("queue, manual pause, task board or budget preservation was not verified"): the 0.8.0 target digested its tasks with the new `plan` field, which the 0.7.x source never had. The target now also accepts the digest in the source's shape while every plan is empty; any real change to the board still fails the check. Use the 0.8.1 coordinator, not 0.8.0's, for such an upgrade (#57).
- `ahub kill` returns only once the hub has released its registry claim, so an `ahub projects remove` right after it no longer refuses, and an `ahub up` right after it no longer reads the project as starting and starts nothing (#58).

## 0.8.0

- Plans and completed-change notices: `hub_task_propose` and `hub_task_accept` take a `plan` (paths, symbols, signatures, insertion points), overlaps also count plan paths and shared symbols, the owners of overlapping tasks get the plan as a ride-along line, and when a task is done they get a notice of the changed files, signatures and summary. PII tasks are left out on both sides, and a plan matching a PII pattern makes a new task a PII task or is refused on an ordinary one. Overlap mentions, ride-alongs, completed-change notices and overlap events leave out any name that matches a PII pattern, and model-written titles, refs and plan items are folded onto one line. During a PII turn the local worker can no longer finish, review or accept-with-plan an ordinary task, which would carry its words to other peers and claude-mem (#31).
- Per-turn snapshots and undo: in a git work tree, with `snapshots.enabled`, which is on in any project with an `.agenthub/config.json`, existing ones included (off without a config file; `"snapshots": { "enabled": false }` opts out), the hub snapshots the files at each turn boundary, `ahub turns` lists the files each turn changed (shell-made changes included), and `ahub undo <turn> --yes` restores them; it restores nothing when a file changed again since, or when another peer's turn at the same time touched it or left its changes unknown. `--context` also asks Codex to drop the turn from its thread's saved history; whether a running Codex session forgets it too is still to be checked live (#33).
- Structured telemetry: the hub writes `events.jsonl` (envelopes without bodies, peer states, turns with per-turn tokens for Kimi and Codex, board changes, overlaps, quota readings), and `ahub export` and `ahub report` read it (#40).

## 0.7.11

- A project whose path contains a backslash works with the local worker and Pi again: Bun 1.3.14's `realpathSync` throws for such paths, so the sandbox profile, the file tools' path guard and the Pi resume check now resolve paths through `realPath`, which then asks the system `realpath`; it returns each name as stored on disk, so another spelling of `.git/config` or `.env` is still refused (#26).

## 0.7.10

- A `local.deny` entry, or a project path, containing `"` no longer breaks the local worker's sandbox profile (its bash and git tools stopped with a parse error); the deny rules are written as plain SBPL strings, which can hold a quote (#23).

## 0.7.9

- A committed `.agenthub/config.json` can no longer choose what the hub runs, which files it sends as credentials, where task text goes, or how far the local worker's sandbox reaches: those machine-local fields (launch commands, checks, the legacy MLX binary and model directory, gateway URLs and key files, the memory endpoint, sandbox widening) apply only from a file git confirms nobody committed, such as the new `.agenthub/config.local.json`, and are otherwise ignored with a log line and a doctor row. A tracked file is recognised by identity, which also closes a way past the 0.7.8 completion-check gate: a committed file under a spelling macOS opens as `config.json` but git does not match (such as `ſ` for `s`) counted as uncommitted (#17).

## 0.7.8

- README, the operations guide and the upgrade-recovery spec no longer describe protocol 10 and the queue commands as unreleased (#9).
- Codex answers a digest to every sender in it, and a sender steered into its turn, like the other adapters; an answer to a condensed digest no longer goes to the reserved `digest` sender and reaches no peer, also when a steer joined the turn (the bus now maps `digest` for any adapter). A TUI that detaches mid-turn and comes back no longer answers the old turn's senders (#3).
- A waiting approval raises a macOS notification naming the peer and, for Kimi, the tool (never the payload); the approval timeout is configurable as `approvals.timeout_s`, and an unanswered request leaves a console and log line (#5).
- Claims: a self-claim without a class is filed as `implement` when no model can name one; the earlier owner of an overlapping task hears of it with its next message; an owner offline past `tasks.release_after_min` (default 30) loses its open tasks to a peer that can take them (#6).
- A class can carry a completion check (`checks.<class>` in a `.agenthub/config.json` git confirms nobody committed; outside a repository none runs): marking such a task done runs it, sends the task to review with the result on success, and keeps it with its owner with the failure otherwise. A hub stop interrupts a check without a verdict (#7).
- `scripts/overlaps.ts` counts the claim overlap warnings in hub logs per week and names the task pairs, for the two-week measurement that decides whether per-task worktrees are built. The procedure and the numbers go in `docs/smoke.md` (#8).
- Releases publish to npm through trusted publishing (OIDC) instead of a stored token, and the workflows use the Node 24 releases of `actions/checkout` and `actions/setup-node` (#4).

## 0.7.7

- `ahub setup` without a terminal and without `--yes` prints the step it would take and exits non-zero instead of waiting forever at its prompt, as `restart` and `upgrade` already did. A piped answer (`yes | ahub setup`) is no longer read: use `--yes` (#73).
- The smoke ledger no longer names the internal gateway's address, and the package check fails when any published file contains a private IPv4 address, naming only the file and line (#74).
- Kimi's requests for the hub's own tools (`hub_send`, the task tools) are approved once without a console prompt, as Codex's already were, so a Kimi nobody watches can claim work and record notes. Kimi 2.1.1 approval prompts for other tools show the command again: the payload falls back to the streamed argument JSON when the request carries none. A payload too long to show whole is marked as cut and no longer offers a session-wide grant, for every ACP agent (#72).
- The operations guide's upgrade section names each supported source range (0.6.x, 0.7.x before the target) and the unsupported one (0.5.x and earlier): run the target release's coordinator through `bunx`. Dry-runs from running 0.6.4 and 0.7.5 hubs are recorded (#75).

## 0.7.6

- Shared notes reach the agents working now: `hub_remember` has a `fail` kind for approaches that do not work, and every saved note rides on the other peers' next delivery (newest 10, one line each) instead of waiting for their next session. A note that matches a PII pattern is refused. A preface returned by a failed delivery no longer overwrites one created meanwhile (#68).
- Claims: `hub_task_propose` naming the caller as owner starts the task in progress without an offer back to the caller, and overlapping `refs.paths` with another owner's open task are named in the propose result, the offer and the console. Implementers are told to claim unassigned work and to report the check they ran in `hub_task_done` (#68).

## 0.7.5

- A zero-turn Claude session no longer wedges an upgrade after restore either: the commit snapshot records whether the session ever persisted a transcript, coordinator verification re-derives persistence from the terminal binding exactly like the restore gate did, and daemon readiness tolerates a fresh session while the original transcript is absent (snapshots from older sources are re-derived from disk). A session with a transcript keeps the strict identity check in all three places. The status line tee now records the transcript path Claude reports (#64).

## 0.7.4

- A Claude session that never persisted a transcript (zero turns) no longer wedges an upgrade at restore: when the original transcript is absent, the coordinator accepts the fresh session the operator attached, because nothing was preserved and nothing is lost. Sessions with a transcript keep the strict identity check; Codex stays strict in all cases (#21).

## 0.7.3

- A peer that detaches mid-upgrade no longer wedges the recovery: readiness ignores a now-offline peer's stale identity (a reattach with a different thread still blocks), an already-exited terminal is closed as a no-op instead of being waited on, and resume can drive the operation to release once the peer returns (#21).
- The check.sh leak guard matches tmp test roots only, so a real hub in a directory starting with `ahub-` no longer trips it (#56).

## 0.7.2

- Local inference defaults to a bounded Ollama MLX runtime: `ahub models setup/start/stop` manages it, the configured context is advertised to Pi, and the legacy standalone MLX runtime needs an explicit legacy provider (#51, #52).
- `ahub init` writes the managed block to `AGENTS.md` only and never creates `CLAUDE.md`: any `CLAUDE.md` stops Claude Code from loading `AGENTS.md`. A block an older `init` left in `CLAUDE.md` is removed, and a `CLAUDE.md` that held nothing else is deleted; a symlinked or hard-linked `CLAUDE.md` is left alone. The one template now tells every agent how it receives and answers hub messages (#54).
- Stop orphaned hub daemons from leaking and spinning: a rejected peer stop no longer blocks shutdown, a 15 s hard deadline ends a hung stop, the recovery fence waits with backoff and a timeout instead of spinning, and a daemon or manager whose project root or state dir vanished stops itself. A surviving Pi TUI owner is torn down by verified process identity before the hub reports stopped (#56).
- `ahub doctor --orphans [--kill]` lists registrations whose project root is gone and kills only processes whose argv names that project's hub daemon exactly (#56).
- A recovery commit no longer blocks when its stop-poll lands in the moment a stopping hub already refuses connections but has not removed its manifest yet: the inspection reports "unavailable" and the poll retries instead of failing the operation (#21).
- The test suite records and sweeps every hub and manager pid it starts, and `scripts/check.sh` fails the gate on any leaked `ahub-*` test daemon (#56).

## 0.7.1

- Restore native sessions while unrelated agents remain in the same worktree; the coordinator continues to fence uncertain terminal creations (#48).
- Allow a bounded inventory refresh after closing the captured terminal before reporting uncertain shutdown (#48).

## 0.7.0

- Persist queued deliveries and expose uncertain handoffs for explicit operator reconciliation (#46).
- Show disconnected recipients, important pending counts and work needing review in CLI and dashboard; add console queue inspection and resolution (#46).
- Separate adapter acceptance from execution completion, use protocol 10 receipts, and support controlled protocol 9 to 10 upgrades (#46).
- Add an English daily operations and recovery guide with measured evidence and explicit operational limits (#46).

## 0.6.4

- Refuse accidental CLI flags in `say` and `remember`, while preserving message text around the `--` separator (#40, #44).
- Show important queued message counts and keep persisted status current after enqueue, delivery and withdrawal (#41, #44).
- Avoid a transient offline event during Pi handover, while reporting failed replacement accurately (#42, #44).
- Share no-acknowledgement and message-priority marker instructions across peers (#43, #44).

## 0.6.3

- The dashboard follows the system light/dark scheme with two tuned palettes, adds relative timestamps, kind filters for the message stream, a state filter for the task list and colored usage bars for budgets (#38).

## 0.6.2

- Address a peer's reply at whoever asked instead of broadcasting it, so one directed question no longer costs every attached peer a turn (#29).
- Cap the priority a hub-native peer claims for itself: `[IMPORTANT]` on an unsolicited report no longer interrupts the other peers (#29).
- A session whose peer id was taken over stands by and reclaims it once the hub reports the peer offline, instead of staying detached until the whole session is restarted (#30).
- Show the command a Kimi tool call will run in its approval prompt, taken from the `tool_call` update when the permission request omits it; a prompt whose payload cannot be resolved says so and offers no session-wide grant (#31).
- `ahub status` prints a namespaced backend alias once (`dgx/coding`, not `dgx/dgx/coding`) and names the backend Pi asked for on its last turn (#32).

## 0.6.1

- Preserve Pi session identity when handing an empty native session between headless and TUI modes (#27).
- Keep recovery metadata and native terminal restoration bound to the verified project session.

## 0.6.0

- Pi peer with managed local model routing, RPC and native terminal integration (#25).
- Authenticated inference relay for DGX coding/fast aliases and loopback MLX Qwen3 8B inference on Apple Silicon.
- Pi-first task routing with per-class backend selection; PII tasks remain restricted to the existing local worker.
- Hub-approved file and shell tools with persistent session/tool-call receipts to prevent duplicate effects.
- Protocol 9 and Pi session metadata for controlled recovery from protocol 8.

## 0.5.0

- Controlled protocol-8 restart with private queue/session snapshots, manual-pause preservation, instance fencing and verified release (#21).
- Exact-version upgrade planning, immutable package staging, detached resumable operation receipts and machine lifecycle locking.
- Orca-first native terminal recovery: original Codex/Claude conversations, new Kimi/local sessions with task context, and explicit manual blockers for unsupported sessions.
- Running projects transition sequentially; the shared Claude plugin and Claude sessions have a final common phase. Global CLI promotion follows verification.
- Protocols 5–7 require a manual bootstrap using their matching CLI. No automatic legacy shutdown, uncertain side-effect replay or rollback.

## 0.4.1 (included in 0.5.0)

- Synchronize the daemon digest integration fixture without changing batching semantics or weakening digest/FYI assertions (#15).
- Reconcile completed live smoke and npm publication evidence; infrastructure-dependent checks remain tracked in #1 (formerly #12).

## 0.4.0

- Independent repository and worktree hubs with canonical project selection, `--project <path|id>`, `projects`, and `status --all` (#19).
- Transactional machine-wide project/port registration, concurrent startup claims, authenticated instance checks and owned shutdown; legacy port allocations are imported without resetting them.
- `ahub ui --all` opens a separate local manager for project selection, hub start/stop and existing dashboard actions. `ahub ui --all --stop` leaves project hubs running.
- Native memory aliases stay compatible with claude-mem, including worktree parent/composite names. Shared aliases are indicated in the manager.
- A second Codex TUI cannot take over an existing hub connection. Owned child shutdown is awaited before runtime ownership is released.
- Control protocol 7: stop old hubs with their matching CLI before upgrading; refresh the channel bundle with `ahub setup`, then restart hubs and agent sessions. No automatic restarts or account configuration changes.

## 0.3.2

- The channel plugin no longer fights a second session attached as the same peer: the replaced one stays detached and its tools say so, instead of taking the peer back every second (#16).
- The plugin MCP server exits when its host goes away, and stops retrying a hub that refused it (wire version, token, peer id), reporting the hub's reason (#17).
- After upgrading, run `ahub setup` to refresh the Claude plugin and restart agent sessions; stale `server.js` processes from earlier versions have to be ended by hand once.

## 0.3.1

- Hub task, review and budget events are distinguished from reference-only presence/recall in agent instructions and rendered message kinds, including mixed Claude digests.
- Reply-parent selection retains hub workflow events and their hop count.
- After upgrading, run `ahub init` to refresh managed project instructions and `ahub setup` to refresh the Claude plugin, then restart agent sessions.

## 0.3.0

- `ahub ui`: a local dashboard for live messages, peer queues, tasks, budgets and approvals, with console messages, task proposal/assignment and peer pause/resume.
- Browser access uses a short-lived single-use link and an HttpOnly, SameSite=Strict session on a separate, lazily started loopback listener. Strict Host/Origin checks, a closed action list and a hash-based content security policy preserve the control link boundary.
- PII task paths/branches are now redacted from public task lists and private-envelope streams as well as task text. Local-worker permission details and allow decisions stay in the terminal; the dashboard can deny them.
- Control protocol 6: update the plugin with `ahub setup` and restart the daemon and connected agents together when upgrading from 0.2.0.

## 0.2.0

- npm distribution: `@staix/agent-hub`, public publishing with provenance from the tag workflow, tarball content checks, and an actionable Bun requirement when the CLI is invoked with Node or an unsupported Bun version.

- `ahub ask`: answers from the task board, shared memory and the hub log, evidence first; the answer has to cite the ids it rests on.

## 0.1.0

First public release.

- Messaging core: N-peer bus with untrusted framing, hop cap, dedupe, one queue per peer; adapters for Claude Code (channel plugin), Codex (app-server proxy) and Kimi Code (ACP).
- Coordination: `[IMPORTANT]` / `[STATUS]` / `[FYI]` tiers, digests, `turn/steer` for a busy Codex, queue bounds, pause and resume, session-start recall from claude-mem.
- `local`: a hub-native worker on a self-hosted model through an OpenAI-compatible gateway, with scoped tools, approvals and a macOS sandbox; optional Switchyard sidecar with fallback; claude-mem capture.
- Task board with role contracts, routing policy (`routing.toml`), an enforced on-prem path for PII, review handoff and escalation, task briefs and shared notes.
- Budget relay: quota sources, checkpoint then pause, handoff to `local` first, resume on reset.
- Packaging: `ahub` CLI (alias `agent-hub`) installable from GitHub, `ahub setup`, one version across CLI, plugin and MCP server, CI on Ubuntu and macOS, tagged releases.
- Internal inference (optional, fail-open): condensed status digests and task class triage.
