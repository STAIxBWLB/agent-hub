# Live smoke checklist

`scripts/check.sh` covers everything against fakes. The legs below need real accounts and an interactive terminal, so they are run by hand and recorded here.

## Settings from the dashboard and the terminal (#269, part 1)

Not run live yet (unverified). `test/settings.test.ts` drives a real daemon, its
dashboard listener over HTTP and the real CLI; no browser was opened and no
native agent was started. `ahub ui --settings` and `ahub settings` are a
person's commands, so the live leg is run by hand, on a scratch project:

1. `ahub up`, then `ahub ui`. The Settings section lists Permissions, Start,
   Routing and Switches; each row shows its source file and when it applies.
   Record the look in a light and a dark theme and at phone width.
2. In that ordinary session, set `research.enabled` (saved), then try to raise
   `permission.kimi` to ask-when-needed (refused, naming `ahub ui --settings`).
3. `ahub ui --settings`. With Kimi attached, set `permission.kimi` to
   ask-when-needed, then never-ask with the peer id typed; `ahub permission`
   and `ahub status` show each mode, and `ahub tail` shows each change with
   `(dashboard)`.
4. Preview a new order for `routing.classes.implement.peers` with a task open,
   save it, run `ahub route explain --class implement x` (it names
   `routing.local.toml`), then "Undo last write".
5. `git status` shows no change to `.agenthub/config.json` or
   `.agenthub/routing.toml`; `ahub settings` in the terminal shows the same
   rows as the page.

Record the date, the hub version, the browser and each step's result.

Part 2, start modes (not run live either; `test/start-modes.test.ts` uses a
recording terminal provider and a scripted hub, and no terminal was opened):

6. In an Orca terminal of the project, `ahub up` with Pi enabled. `ahub pi`
   opens Pi's TUI in that terminal; in another, `ahub pi --headless` moves it
   to the background.
7. Stop Pi. In the dashboard's Peers panel the Start control for pi says
   "Start mode tui: opens ahub pi --mode tui in a terminal through orca".
   Press it: a new Orca terminal runs the TUI and Pi attaches.
8. In a settings session set `peers.pi.start_mode` to headless, stop Pi, press
   Start again: Pi comes up headless and no terminal opens.
9. Outside Orca with no `terminal.open`: the Start control shows no button and
   the command to run; typing `pi` in `ahub console` prints the same refusal.
10. With `terminal.open` set to a tmux or wezterm template in
    `config.local.json`, Start opens Pi's TUI there.

## Codex resumed approval policy (#270)

2026-10-10: installed version read back as `codex-cli 0.162.1`. The live
stickiness leg is unverified: a hand-run `codex --remote` resume and a human-only
`ahub permission codex ask` require a person's interactive terminal. The approved
fallback is implemented: keep restoration owed per thread and send the captured
native policy once on that thread's next accepted turn, whether or not the native
override is sticky across resume. Fake app-server coverage verifies both overlays,
other-thread visits, either resume/ask order, rejected restoration and restoration
only once. The proxy protects the one restoring turn; a repeated policy on the
next TUI turn is indistinguishable from a person's explicit native choice.

Manual leg in a disposable project:

1. Start `ahub codex`, record its thread ID and native approval policy, then run
   `ahub permission codex never-ask --yes` from a human shell and complete a benign turn.
2. Close the TUI without stopping its hub proxy. Run `ahub permission codex ask`.
3. Hand-run `codex --remote <the existing proxy URL>` and resume that same thread.
   Record what the TUI sends as `approvalPolicy` on its first turn after a resume,
   including any echo of the resume response. Observe the policy before and after
   that benign turn; record whether the override persisted across resume and
   whether the original policy was restored.
4. Send the TUI's second turn after that resume; record its outgoing policy and
   the effective native policy. A repeat of the reported override is passed through
   after the one restoring turn, just like an explicit choice.
5. Repeat with `ask-when-needed` and with resume before switching to ask. Record
   the Codex version, thread ID, policies and outcomes. This checklist is not
   evidence that any live leg has passed.

## Interactive upgrade (#272)

Not run live yet. Covered by tests with a scripted terminal and, for `restart`,
by a real detached operation driven through the plan screen
(`test/upgrade-cli.test.ts`, with standard input and output marked as a terminal).
The live leg, at a real terminal with Orca-launched peers:

1. With a hub on the previous release, run
   `bunx --package @staix/agent-hub@<version> ahub upgrade`. Expect the plan
   screen: the project, each peer's fate, `in progress:` when a peer is busy, no
   blocker.
2. Press `a`. Expect the steps in order, `waiting for:` while a peer is busy, and
   `upgrade to <version> completed`; `ahub --version` and `ahub status` report it.
3. On a scratch project, start `ahub restart` while a peer is busy, press `a`,
   then Enter during the wait and `c` on the operation screen. Expect `operation
   <id> is cancelled; the recovery lock is free`, the reset question, and the hub
   still running.
4. With an installed CLI one release behind, run `ahub upgrade`, confirm the
   hand-over, press `a`, then Ctrl+C during the wait. Expect the `left:` line, a
   clean shell prompt, and `ahub recovery` showing the runner still working.

5. On the plan screen press `k`, then `t`, and confirm. Expect each TUI agent's
   terminal closed and the next plan showing them offline; with a hub of 0.12.22
   or newer, `h` stops the headless agents the same way.

Record the versions, the screens' text and what differed.

## ahub reset on a scratch project (#214)

Not yet run. A person runs it in a terminal, on a scratch project only, never
on a project whose hub state matters:

1. `ahub init`, `ahub up`, attach Claude with `ahub claude` and one headless
   peer; queue work for an offline peer with `ahub say @<peer> ...` and
   `ahub pause <peer>`; propose one task.
2. Quit Claude Code (its status line tee writes into the state directory) and
   run `ahub kill`, so nothing else changes the state files, and take their
   checksums. `ahub reset`: the listing shows ids and counts only, and
   `hub.db`, `hub.db-wal` and the other state files keep their checksums
   (`hub.db-shm`, SQLite's shared-memory index, may change on any read).
3. `ahub up` and `ahub claude` again, then `ahub reset --yes`: the hub stops
   first; `ahub up` then shows no queued or needs_review delivery
   (`ahub queue list`), no hold or pause, and the same board; the reset says
   to relaunch Claude with `ahub claude`.
4. `ahub reset --all --yes`: `.agenthub/archive/state-<UTC time>/` is 0700 and
   git-ignored, the state directory holds only `project.json`, and `ahub up`
   starts with the same project id, an empty board and an empty queue.
5. Restore the archive as `docs/operations.md` describes (the current state
   directory goes into `.agenthub/archive/` too) and check the board from
   step 1 is back.

Record the version, the commands, each result and anything that differed.

## Operator console and conductor candidate (#190, #191, #193-#195)

Candidate 0.12.17, protocol 15, observed on 2026-10-09 KST. The final Claude
observer runs used immutable source `20ad5e6`; their native completion receipts
and actual console effects were checked independently. The Kimi new-tool leg
remains quota-blocked, as recorded below.

- Actual Codex 0.146.0 (`gpt-5.5`) and Claude 2.1.295 (Opus 5.5) TUIs started
  real local and headless Pi peers, proposed exactly two tasks owned initially
  by local, reassigned Beta to Pi, and placed and released their own holds.
  The real owners checked their outputs and called `hub_task_done`; the native
  conductor independently read the exact files before approving both tasks.
  Real CLI calls retained the agent actor, and human-only queue/permission
  actions were refused from an agent shell.
- The person authorized `alpha.txt = ALPHA` (5 bytes) and `beta.txt = BETA`
  (4 bytes), both without a newline. Separate selection and confirmation keys
  reached the actual console PTY and produced allow-once console audit records.
  Out-of-scope directory-list commands were cancelled. The final Claude own
  run used three allow-once answers because Pi combined its exact write and
  bounded byte checks in one approved command; it also recorded two cancelled
  local directory-list requests. No permission or task completion was fabricated.
- The final Claude own run recorded nine completed native turns and nine
  matching daemon Stop records, 27 unique native usage records, and
  1,888,242 tokens including cached input. Eight completed native turns contained
  supervision, with 1,292,922 recorded tokens. Its final message UUID/id,
  `end_turn`, `turn_duration`, instance/session/launcher and opaque Stop receipt
  matched; native idle and an empty pending delivery queue were verified before
  owned-process cleanup. Local recorded three turns and 72,046 gateway tokens;
  Pi recorded two turns and 47,177 native tokens.
- A read-only Claude feed-off continuation on the final observer preserved the
  existing approved tasks and exact files. It verified one completed native turn,
  four usage records and 263,413 cached-inclusive tokens, with matching daemon
  Stop, native idle and delivery settlement. An obsolete review hold was first
  discarded through the authenticated public operator API after fresh approved
  task/history and exact BETA readback. That discard is not native execution.
- A real console with two pending cards and no operator input consumed 0.07 CPU
  seconds over 40.018 wall seconds in stream mode (0.175% of one CPU). A separate
  actual Peers panel, 120x40, with two pending cards and no operator input used
  0.07 CPU seconds over 40.012 wall seconds (0.175%). These are cumulative `ps`
  process CPU samples in distinct modes/runs, not whole-host idle measurements.
- In a plain Claude TUI without the development-channel flag, one actual
  `hub_status` MCP call succeeded and the daemon audited the Claude status
  action. A unique directed operator push was accepted by the bridge, but no
  pushed native user row or answer appeared in the observed 20.075-second window.
  This proves tool access separately from the bounded negative push observation.
  The real channel-enabled runs above received actual review and supervision
  pushes. The plain probe and cleanup completed in 56.724 seconds, with no model
  file, shell, task or settings actions.
- Real Kimi Code CLI 2.1.1 completed ACP initialization and `session/new`, then
  rejected the single prompt with HTTP 403 for its weekly account usage limit.
  No requested native tool event or role-refusal result occurred. The reset time
  was not supplied. The owning CLI listed only the managed OAuth Kimi provider
  (four models, default `kimi-code/k3`), so no configured alternative provider was
  found. This is an incomplete external prerequisite, not a new-tool pass. No
  purchase, provider/configuration change or model retry was performed; owned
  processes were stopped after 3.142 seconds.

The user explicitly approved release 0.12.17 with only the Kimi native new-tool
and ordinary-role refusal T0 evidence deferred on 2026-10-09. That native
prerequisite remains unverified; the quota rejection is not a tool pass. This
decision does not defer the other native/source gates or authorize a purchase,
credentials, provider/configuration change or account retry. The same isolated
read-only Kimi probe remains required before its native coverage is marked verified.

Earlier captures remain part of the evidence:

- Codex feed-off included an interrupted original and read-only continuation:
  six logical native turns, 49 increments and 1,979,016 tokens. Codex feed-own
  recorded nine turns, 34 increments and 1,399,470 tokens. Their journals were
  independently checked after cleanup. The first baseline interruption and
  operator reconciliation are preserved; neither native task completion nor
  board approval was substituted by the harness.
- The original Claude runs approved the actual files but an early idle-based
  harness stopped their final review answers. Subsequent `da2ebbc` feed-off
  completed five native turns and 1,451,782 tokens but certified only one daemon
  Stop. A `6034dd9` read-only continuation completed another native turn and
  261,483 tokens, while its Stop remained unavailable during the native hook.
  Both incomplete observer captures are preserved alongside raw and audited
  summaries. The final post-ACK observer above closes the fresh completion proof;
  it does not retroactively certify the earlier missed Stop records.

All token totals describe whole native/model turns, including cached input and
other work. Operator waiting, cancelled requests, marker probes, interrupted
continuations and differing source revisions make these observations unsuitable
for a causal feed-overhead or model-efficiency comparison. Unknown measurements
and the Kimi prerequisite remain explicit.

The harness uses real Python PTYs. Operator-file-input forwards only
chat-authorized keys, removes inherited Orca terminal ownership from fixture
children, and generates no approval automatically. Private original and
continuation captures remain separate. The shell-marker probes and vendor
limits are recorded in [the identity T0 ledger](verification/2026-10-09-agent-shell-t0.md).

## Approval race live reproduction and candidate verification (#98)

Measured on 2026-10-02 KST with installed 0.12.1 and the correction candidate,
using real Kimi 2.1.1 and Pi 0.86.0 in disposable git projects:

- Pi requested an edit of only `PI_MARKER`, and its allow-once approval waited.
  Kimi changed the separate `KIMI_MARKER` line. Approving Pi restored the old
  Kimi value (`pending`) while retaining `pi-live`. The hub emitted one concurrent
  conflict event with both turn ids, so conflict detection worked while the tool
  still overwrote unrelated current contents.
- The candidate repeated the same real-agent interleaving and kept both
  `kimi-live` and `pi-live`. One concurrent conflict was recorded, and Kimi's
  reviewer role produced an actual `pi:accepted -> pi:done -> kimi:approved`
  task history. This is the runtime fix included in 0.12.2.
- Regression checks cover a fragment changed while approval waits and write/edit
  paths changed into out-of-project symlinks during approval. Existing approval
  denial and initial exact-match checks remain intact.
- The same live acceptance session used real Codex 0.159.3 (reply `pong`, no hub
  negative RPC ids leaked), the real local worker, and real Switchyard routes.
  Controlled gateway 503s verified escalation, three-exhausted-delivery routing
  exclusion, recovery after a completed delivery, and a post-write needs-review
  hold with one notice and explicit resolution. Idle model/route replacements and
  busy refusal were observed; doctor flagged an unserved fixed model.
- Pi native session usage independently totalled 36,390 tokens, exactly matching
  hub events. A candidate session's complete native and hub totals also matched
  at 100,940 tokens. Real Kimi submitted a 1,430-character checkpoint summary and
  handed open work to Pi after a controlled 95% reading.
- The real Codex weekly reading was 2%, so natural near-limit pause remains
  unverified (issue #1). The injected 95% empty-work check spent zero extra
  checkpoint turns; it is separate evidence from the natural provider leg.

The gateway outages, response barriers and manual quota readings were controlled
fault inputs. Native/model replies were verified against files, task history,
events and native session usage. Disposable test hubs were stopped and removed
from the registry; credentials and raw conversations remain outside the ledger.

## Reliability and self-development run (#89-#95, 0.12.1)

Measured on 2026-10-01 in an isolated worktree of this repository:

- Started the installed 0.12.0 hub, with real Kimi 2.1.1 and Pi 0.86.0 peers. The console created tasks, agents accepted them with plans, and the hub recorded completion. Kimi implemented reviewer routing and delivery-health inputs; Pi located the installed usage contracts. The console completed Pi integration after stopping its prolonged exploration and inspected/discarded the superseded uncertain deliveries explicitly.
- The initial fake-based gate passed 560 tests with `check: OK`; the final review also adds coverage for self-claims made during a running turn. Coverage includes task escalation, failing-peer routing and recovery, queue-hold notices/status/assignment/explanation, reviewer roles, idle local model replacement and busy refusal, concurrent edits and in-review overwrites, Pi bridge usage dedupe, and owner/reviewer checkpoint behavior.
- `bun scripts/smoke-recovery-09-10.ts` ran the real published 0.6.4 package (protocol 9) into the working tree (protocol 11), preserving queued envelope ids, task identity/state digest and manual pauses. Operation `7acefb22-2eef-4f28-a241-73990ffbee88` completed with queue readback.
- The target coordinator then restarted the actual development hub from 0.12.0/protocol 10 into 0.12.1/protocol 11. Operation `d42beca5-856b-46f8-8cb9-7694213eb799` completed with its project verified and the board/queues retained.
- A real Pi DGX probe answered as FYI and reported 42,967 tokens in `ahub report`. Its usage was forwarded from native `message_end` events; the earlier 0.12.0 Pi turn had no recorded token count. This proves accounting, not a comparison of model efficiency.
- Manually paused local recovery can retain its queue while the gateway is unavailable. Manual resume validates its model choice before lifting the pause. Native Claude/Codex account smoke legs remain separate from this Kimi/Pi run.

## Hub collaboration measurement (issues #29-#32, 0.6.2)

Measured on 2026-09-20 against a live 0.6.1 hub and a disposable project, before the fixes:

- Pi answered a file-read question correctly on both backends: 2.53 s through DGX
  (glm-5.3-flash) and 3.95 s through the local MLX Qwen3 8B. Per-class backend selection
  (`implement` to DGX, `summarize` to MLX) matched `ahub route explain`, and a routed
  `implement` task ran propose -> accept (0.81 s) -> approved with the file written correctly.
- One console message addressed to Kimi alone produced three extra agent turns across two
  peers: Kimi answered to `*`, Pi spent a turn restating it, Kimi acknowledged. The chain
  stopped at the `fyi` rule and the hop cap. Issue #29.
- A Pi task completion marked `[IMPORTANT]` by the model interrupted the idle local worker,
  which began verifying work nobody had asked it to check. Issue #29.
- A running Claude Code session kept the hub tools refusing with "restart it to take the peer
  back" while `ahub status` reported the peer offline. Reproduced with two channel servers.
  Issue #30.
- A Kimi shell approval reached the console as the four characters `Bash`, with
  `approve_always` beside it. Issue #31.

Re-measured on 2026-09-20 after the 0.6.2 rollout — see the next section.

## Hub collaboration re-measurement (issues #29-#32, 0.6.2)

Re-measured on 2026-09-20 against a live 0.6.2 hub in the disposable project
`/tmp/agenthub-smoke-062-recheck`, with real Kimi 2.0.1, installed Pi 0.85.1
and the local worker:

- #32 backend alias: Pi answered a file-read question in ~2.4 s on the
  `dgx/coding` backend (glm-5.3-flash through the gateway) and ~4 s after a
  `ahub pi --mode headless --backend mlx` re-attach, whose handover preserved
  the session identity. `ahub status` printed each alias exactly once — the
  peer line `model: dgx/coding` plus one backend line
  `dgx/coding ready ... requested dgx/coding actual glm-5.3-flash` — and
  `grep -c "dgx/dgx\|mlx/mlx"` over the log returned 0. `ahub say` has no
  `--backend` flag: a flag passed in message text is absorbed as body (seen
  once in the log), so per-class changes only go through re-attach.
- #29 unsolicited `[IMPORTANT]`: the local worker's `hub_send` delivered an
  unsolicited `[IMPORTANT]` to a busy Kimi. No interrupt: the status snapshot
  during the slow turn showed `kimi busy queued 1`, and the message was
  delivered right after the turn ended (log: `idle` at 09:16:47.551, `busy`
  at 09:16:47.552), with the turn's own reply first. An idle Kimi started a
  turn immediately instead, as designed. Code basis: `AcpPeer` has no
  `steer`, so `bus.publish` can only enqueue for it; `capPriority` demotes an
  unsolicited hub-native report to `status` only when the peer claims the
  marker itself — the console's own `[IMPORTANT]` is delivered as sent.
- #29 hop ceiling: Kimi's `fyi` acknowledgement of the hop-1 message arrived
  at hop 2 and was dropped (`NOT DELIVERED(fyi)` in the log), so both the
  `fyi` rule and the hop cap stopped the chain after one round trip. The
  hop-1 delivery itself reached an idle Kimi and was answered in ~8 s.
- #31 permission payload: Kimi 2.0.1's `session/request_permission` carries
  no `rawInput`, so the hub keeps the arguments from the announcing
  `tool_call` update (previous session's leg; covered by `scripts/check.sh`).
- Task #1 reached `approved` with its file written. The local worker served
  `sy/coding` through the switchyard on 127.0.0.1:4813
  (`vllm/deepseek-ai/DeepSeek-V4-Flash-0731`), and Pi's `dgx/coding` traffic
  went through the internal gateway as before.
- Kimi stayed healthy through the run (KIMI-IDLE-AGAIN, KIMI-FINAL-MARKER
  markers, zero queued at the end). The disposable hub and manager were
  stopped after recording.

## Issues #40-#43 re-measurement after the review fixes (2026-09-20)

Measured against a live hub built from the PR branch in the disposable project
`/tmp/ahub-measure-44`, with real Kimi 2.0.1, Pi 0.86.0 on MLX, and a control-WS
peer standing in for Claude.

- #40 flag absorption: `ahub say --backend mlx hi` and `ahub say @codex "try
  this" --verbose` both refuse before touching the daemon. `ahub say -- --backend
  is broken, check it` reaches the log verbatim
  (`msg user -> * important hop=0: --backend is broken, check it`), and
  `ahub remember --backend mlx note` refuses the same way while
  `ahub remember -- --backend is a flag` saves. The `--` escape exists because
  the first version of the fix left a message that is about a flag unsendable.
- #41 queued important: a paused peer with one `[STATUS]` and two console
  messages printed `queued 1`, `queued 2 (1 important)`, `queued 3 (2 important)`,
  and status.json carried `queuedImportant` only from the second message on.
- **status.json was one message behind** (found by this run, fixed here): the
  file said `queued 3, queuedImportant 1` while `ahub status` said 4, and it kept
  `queued 4` after the queue had drained to 0. `publish` emits its envelope event
  *before* it enqueues, and a delivery emits nothing at all, so the daemon's
  `writeStatus` tap always recorded the previous count and was never called again
  once the queue emptied. The bus now reports a queue change (`onQueues`); after
  the fix the file tracked 1 -> 2 -> 3 -> 0 exactly, with the field absent at 0.
- #42 Pi handover: `ahub pi --mode headless --backend mlx` then
  `--backend auto` produced exactly one state line in the log
  (`state pi -> idle`), `ahub tail` showed only `pi is idle`, and status.json read
  `idle` before and after. The other half - a handover whose replacement never
  arrives - is not reachable from the CLI on a healthy install and is covered by
  `test/pi-daemon.test.ts` (verified to fail without the restore).
- #43 no-ack: the new wording reaches Kimi verbatim (asked to quote it, it
  returned `"Do not acknowledge a message that needs no answer; every reply costs
  the other agents a turn."`). **It did not stop the ack**: a no-action note from
  the console was answered with "Noted, no action needed on my side." (14 s), and
  the same note from another agent with "Noted." (6 s), both delivered at
  `status` priority and costing the recipient a turn. The instruction never told
  Codex, Kimi or the local worker that the markers exist - only the Claude channel
  did. With `[FYI]`/`[IMPORTANT]` added to the shared instruction, an unprimed
  Kimi on a fresh session answered the identical note with
  `msg kimi -> claude fyi hop=1 NOT DELIVERED(fyi)`: recorded, nobody's turn spent.
  Kimi still chooses to answer; what changed is that the answer is free.

## 0.6.3 release gate and isolated install (2026-09-20)

- `bun run check` on the 0.6.3 checkout: 301 tests, 37 files, 1600 expect()
  calls, `check: OK`; `bun run build` produced `plugins/agent-hub/server.js`
  (543 KB) and `src/cli/main.js`.
- Global install from an `npm pack` tarball (`@staix/agent-hub-0.6.3.tgz`,
  281 KB) into an isolated `BUN_INSTALL` prefix: `ahub --version` → 0.6.3,
  both `ahub` and `agent-hub` bins linked, and `ahub init` from an unrelated
  temp directory wrote config.json, routing.toml, CLAUDE.md, AGENTS.md and
  .gitignore.
- Installing the workspace root directly does not work: `bun add -g .` writes
  a nameless dependency (`"" -> "."`) into the global package.json, later
  attempts fail with `DependencyLoop`, and `bun add -g @staix/agent-hub@./`
  installs only bun.lock/package.json without `src/` or bin links. Use
  `npm pack` + the tgz, `bun link`, or the GitHub source.

## Pi local inference checks (issue #25, 0.6.0)

Verified on 2026-09-20 on Apple Silicon with installed Pi 0.85.1:

- `scripts/check.sh`: 280 tests passed, 0 failed, 1549 assertions; typecheck,
  plugin freshness and npm package contents also passed.
- A disposable project ran the real hub daemon and Pi headless peer. Pi called
  the managed `read` tool and returned an exact marker from a project file,
  once through DGX and once through MLX. Both returned to idle with zero queued
  messages. The MLX result reported the configured Qwen3 8B model path.
- Direct DGX relay streaming completed with `[DONE]`, `finish_reason: stop`,
  and a reported DeepSeek V4 Flash model. Requested gateway aliases are not
  treated as proof of the physical model.
- A real PTY Pi TUI moved to headless RPC and back to TUI through an authenticated MLX relay (`mlx/fast`). All three modes invoked the managed read tool, and the same session ID/file was preserved. The model paraphrased final prose, so the tool callback was checked against the exact fixture text. Smoke-owned Pi processes exited after teardown.
- Pi also reviewed the tool-call receipt implementation through DGX. Its
  suggestions were checked against the code; shutdown fencing was fixed and
  regression-tested. Model-generated review remains advisory.
- A real disposable protocol-8 hub from 0.5.0 completed a controlled restart into 0.6.0/protocol 9. Its proposed task, manually paused local peer and one queued message survived; the target reached `released`. The disposable daemon and manager were stopped after verification.
- `ahub models start` returned promptly while the owned MLX process remained
  healthy; a subsequent status check returned the same PID. Project relay
  teardown left the shared MLX runtime running.

Production hub cutover is a separate operation. These checks do not claim that
existing protocol-5/7 production sessions have been upgraded.

## Controlled recovery implementation checks (issue #21, 0.5.0 development)

Verified on 2026-09-20, without upgrading the developer's running hubs:

- The local release gate passed: 228 tests, 0 failures, 1352 assertions,
  `check: OK`. Tests used an isolated `AGENTHUB_HOME` and no inherited project
  state overrides.
- An actual detached daemon in a temporary initialized project was restarted by
  the detached coordinator from a preserved package tree. Its instance changed,
  its project identity and task board survived, and ordinary task commands worked
  after release. This scenario had no native agent peers attached.
- Fake-service tests cover two-project ordering, shared plugin sequencing,
  busy/approval blockers, snapshot validation, manual pauses, terminal identity,
  account-home isolation and lost commit/start/release responses.
- Read-only inspection of the installed runtime still found protocol 7 in this
  project and protocol 5 in hwp-cli. The new CLI's dry-run returned a bootstrap
  blocker instead of trying to stop them.
- The installed Orca CLI's read-only TUI-idle query returned its documented
  `result.wait.satisfied` shape. No production terminal was closed or relaunched.
- During merge review, the published 0.4.0 package was installed into an isolated
  staging directory. Registry integrity and repeated cache verification passed;
  no global package or Claude plugin store was changed.

Still pending: a real Orca smoke with native Codex/Claude sessions after an
attended protocol-8 bootstrap; actual registry package/plugin upgrade; production
rollout. Fake terminal receipts do not establish native conversation restoration.
Issue #1's Access and natural-quota prerequisites remain unchanged.

## Install

```bash
bun add -g github:STAIxBWLB/agent-hub      # or: git clone, bun install, bun link
ahub setup                                 # Claude Code channel plugin from this package, then doctor
```

Claude channels are a research preview: `ahub claude` passes `--dangerously-load-development-channels plugin:agent-hub@agent-hub`.

## Claude without channel evidence (#205)

Not run live yet. On a candidate with the rebuilt plugin bundle (protocol 16),
record only what was observed:

1. Start a plain `claude` in the project (not `ahub claude`). `ahub status`
   shows `claude` `idle` with `tools-only: messages wait for hub_inbox; ...`.
   Run `ahub say @claude "<unique text>"`: status shows `queued 1`, `ahub queue
   list --peer claude` has no `accepted` or `dispatching` row, and no pushed row
   appears in the TUI. Ask the session to call `hub_inbox`: it returns the text
   under an `[agent-hub message from "user"` header, status shows `queued 0`,
   and the queue list shows one `completed` row `read through hub_inbox`.
2. Start `ahub claude` in the same project (AC3). It takes the peer and the
   plain session stands by. A new `ahub say @claude "<unique text>"` appears as
   a native channel row, its delivery reaches `accepted`, and `hub_delivery_done`
   or a correlated reply settles it `completed`. Status shows no `tools-only`.

## npm package preparation (issue #4)

Verified locally on 2026-09-19 with Bun 1.3.14, using an actual `npm pack` tarball:

- Global installation into isolated `BUN_INSTALL_GLOBAL_DIR` / `BUN_INSTALL_BIN`.
- Both `ahub --version` and `agent-hub --version` return the package version.
- `ahub init` resolves the installed templates and creates project configuration.
- `ahub setup --yes` installs the real Claude Code plugin using an isolated
  `CLAUDE_CONFIG_DIR`; `claude plugin list --json` reports the expected version,
  and its cached `server.js` matches the packaged bundle byte for byte.
- Node invocation of the JavaScript bin exits 1 with one Bun-required line.
- The v0.4.0 release workflow accepted the matching tag, passed its gate with
  197 tests passing, 3 skipped and 0 failures, published `@staix/agent-hub@0.4.0`
  to npm with provenance, and created the GitHub Release ([workflow run](https://github.com/STAIxBWLB/agent-hub/actions/runs/35448132456)).

Still pending: registry metadata/provenance readback and installation by registry
name on a clean machine. The local tarball check and release log do not establish
those results or an interactive Claude channel session from the registry package.

## Issue #15 batching fixture

The failed v0.3.1 release attempt was a test scheduling race, not a production
delivery defect. The daemon test used a 30 ms batch window while sending the two
status messages through sequential WebSocket request round trips. Under CI
scheduling, the second request could be accepted after the first status envelope's
timer fired, producing two valid status deliveries and `channel.length === 3`.

The test now pauses the recipient before those requests, resumes it after both are
accepted, and keeps the original digest and FYI assertions. This synchronizes the
fixture without changing production batching semantics, increasing sleeps or
weakening expectations.

## M1: trio chat

In the project directory, one terminal each:

1. `ahub init && ahub up`, then `ahub tail` (keep it open).
2. `ahub kimi`. `ahub status` shows `kimi idle`.
3. `ahub codex`. The TUI opens; after its first thread starts, `ahub status` shows `codex idle`.
4. `ahub claude`. `ahub status` shows `claude idle`.
5. `ahub say "Each of you: reply with your name and nothing else."` Expect three replies in `ahub tail`, each within its turn time, and each agent seeing the others' replies framed as untrusted (`<channel source="agent-hub">` in Claude, `[agent-hub message from ...]` in Codex and Kimi).
6. While Codex is mid-turn on a long prompt typed in its TUI, run `ahub say @codex "status?"`. `ahub status` shows `1` in the codex row's `Q` column; the message is injected after the turn completes.
7. `ahub say @kimi one`, `ahub say @kimi two` back to back: both answered in order, none lost.
8. Ask Kimi for something that needs a tool (`ahub say @kimi "create /tmp/agenthub-smoke.txt"`): `ahub tail` prints the permission request; `ahub permit <id> <option>` answers it; no answer within 120 s cancels it.
9. `ahub kill`: no `kimi acp` or `codex app-server` process survives (`pgrep -fl "kimi acp|codex app-server"`).

## M2: tiers, digests, steer, recall

1. `ahub pause kimi`, then `ahub say @kimi "[STATUS] one"`, `ahub say @kimi "[STATUS] two"`, `ahub say @kimi "how many agent-hub messages are in this prompt?"`. `ahub status` shows `3` in Kimi's `Q` column and a `paused` detail. `ahub resume kimi`: one Kimi turn answers for all of them, and on the first delivery of the hub run it also reports the `hub` memory item (`grep recall .agenthub/state/hub.log` shows its size).
2. `ahub say "[FYI] note"` appears on `ahub tail` as `[fyi: record only]` and no peer goes busy.
3. With Codex mid-turn on a long prompt typed in its TUI: `ahub say @codex "[IMPORTANT] stop and summarize"`. The running turn changes course (steer) instead of a new turn starting afterwards; `ahub status` never shows it queued. `ahub say @codex "[STATUS] later"` during the same turn stays queued until the turn ends.
4. Two agents chatting without markers: their replies reach the third agent as digests, not one turn per message.

## M3: local worker

Needs a model gateway in `omniroute.urls` (for the owner: the campus gateway over VPN, or the Access-protected public URL with its two header files) and a key: `OMNIROUTE_API_KEY`, or `omniroute.api_key_file` in `.agenthub/config.json`.

1. `ahub doctor`: `omniroute` healthy, `omniroute key` present, `switchyard` installed or not.
2. In a scratch git repo: `ahub up`, `ahub local`, `ahub tail`, then `ahub say @local "fix the typos in <file>, run git diff --stat and report"`. `ahub tail` shows a permission request for the edit; `ahub permit <id> allow`. The file changes, the answer is a short conclusion, `ahub status` shows the served model in the local row's `MODEL` column and `vllm` in the backend table's `PROVIDER` column.
3. Same with `AGENTHUB_SWITCHYARD_BIN` (or `switchyard-server` on PATH) set before `ahub up`: `ahub status` shows the served model in `MODEL`, `switchyard` in the backend's `PROVIDER` column, and a `switchyard` detail with `127.0.0.1:<port>`; `lsof -nP -iTCP -sTCP:LISTEN | grep switchy` shows loopback only; `.agenthub/state/switchyard.toml` is mode 600 and holds no key; after `ahub kill` the file and the process are gone.
4. claude-mem: `sqlite3 -readonly ~/.claude-mem/claude-mem.db "select agent_id, agent_type, project, title from observations order by id desc limit 3"` shows `local | local-worker` rows a minute or two later (claude-mem's observer runs asynchronously).

## M4: task board

1. `ahub up`, `ahub kimi`, `ahub local`, `ahub tail`. `ahub route explain --class bulk_edit "fix typos"` prints candidates, owner and reviewer.
2. `ahub task propose bulk_edit "Fix the spelling mistakes in words.ts" --path words.ts`: `local` accepts, edits, calls `hub_task_done`; `ahub board` shows it `approved` (no reviewer attached) or `in_review`.
3. `ahub task propose test "Check that words.ts contains ..."`: Kimi takes it and reports through the hub's MCP tools (`ahub task show <id>` history: `kimi accepted`, `kimi done`).
4. PII: propose a task whose title matches `signals.pii_patterns`. Owner `local`, reviewer `user`; `grep <value> .agenthub/state/hub.log` and the `ahub tail` output find nothing; `ahub board` shows `[pii]`; `ahub task show <id>` shows the text; `ahub review <id> approved` closes it; claude-mem has no row with the value.
5. With Claude and Codex attached: a task proposed by Claude, done by Codex, reaches Claude as a review; two `changes_requested` move it to the next peer in `escalate_to`.

## M5: budget relay

1. `ahub up`, `ahub kimi`, `ahub local`, `ahub tail`. Give Kimi a task, then `ahub budget set kimi 0.95 --resets-in 2m`.
2. `ahub tail`: Kimi is asked for a checkpoint, writes `.agenthub/checkpoint.md`, calls `hub_checkpoint`; then `budget: kimi paused ...; checkpoint received` and `budget: moved from kimi: #<id> owner -> local`. `ahub status` shows a `paused` detail for Kimi naming the budget reason, `ahub board` shows the task with `local`.
3. `ahub budget set kimi 0.97` again changes nothing. `ahub resume kimi` is refused while the record is open; `ahub budget resume kimi` overrides it, and further readings over the gate do not pause Kimi again until that window has reset.
4. `ahub budget set kimi 0.1` (the mocked reset), or wait for the reset time: `kimi resumed`, and Kimi gets one envelope listing what moved.
5. Codex: with a TUI attached through `ahub codex`, `ahub budget` shows its windows from `account/rateLimits/read`; on a limited account Codex is paused until `resetsAt` without a checkpoint.
6. Claude: start with `ahub claude` and check that `.agenthub/state/claude-usage.json` appears and the status line looks as before; `ahub budget` shows `claude 5h` and `week`.

## M6: packaging and internal inference

1. Install from GitHub into a clean Bun prefix (`BUN_INSTALL=<dir> bun add -g github:STAIxBWLB/agent-hub`), then from an unrelated directory: `ahub --version`, `ahub init`, `ahub up`, `ahub local`.
2. `ahub setup` shows what it will run, asks, installs or updates the plugin; `ahub doctor` shows `agent-hub@agent-hub <version>` equal to `ahub --version`.
3. `ahub task propose "Rename X to Y in file.ts"` without a class: the board shows a class and `ahub task show <id>` has a `triaged` history entry.
4. Six or more unmarked messages to a paused peer, then `ahub resume <peer>`: the peer's prompt holds one `digest` item that names every sender and id. With the gateway unreachable the plain digest arrives.
5. Release: tag `v<version>`; the workflow checks the tag against `package.json`, runs the gate and creates the GitHub Release.

## Record

| Date | Leg | Result |
| --- | --- | --- |
| 2026-09-19 | Kimi: `ahub up`, `ahub kimi`, `ahub say @kimi`, `ahub tail`, `ahub status`, `ahub kill` (kimi 0.43.1) | pass: reply "pong" in about 10 s, no orphan process |
| 2026-09-19 | Kimi adapter alone: `bun scripts/smoke-acp.ts` | pass: session ready in 0.6 s, reply at hop 1 |
| 2026-09-19 | Codex adapter: `bun scripts/smoke-codex.ts` (codex-cli 0.154.0) | partial: real thread adopted, `turn/start` accepted, `turn/started` and `turn/completed` tracked, peer returned to idle. The turn itself failed with `usageLimitExceeded` on the account, so the reply leg is not verified live |
| 2026-09-19 | M2 step 1 with Kimi 0.43.1 | pass: three paused messages delivered as one prompt; Kimi counted 4 items including the `hub` memory block (6037 chars, cap 2000 tokens) |
| 2026-09-19 | M3 step 2, direct path (OmniRoute 3.8.50, DeepSeek-V4-Flash, VPN) | pass: attended edit via `ahub permit`, sandboxed `git diff --stat`, conclusion in about 5 s, `provider vllm` recorded; with no Switchyard installed the hub said so once and used `fixed_model` |
| 2026-09-19 | M3 step 3, real `switchyard-server` 0.2.0 (`cargo install`) | pass after two config fixes found by `--dry-run` (`timeout_ms` rejected, escalation table required): tool-using turn through `sy/coding`, selected model recorded, bound to 127.0.0.1 only, config 0600 without secrets, file and process gone after `ahub kill` |
| 2026-09-19 | M3 step 4, claude-mem 13.25.1 | pass: session `platform_source = agent-hub`, observation 65484 `agent_id = local`, `agent_type = local-worker`. Found live: `summarize` with `agentId` is skipped as subagent context, and an unawaited `session-end` never left the process; both fixed |
| 2026-09-19 | M3 regression after review fixes, attended, through the real sidecar | pass: the approval shows the edit's old and new text; one stalled first probe over the VPN was seen once (both candidates timed out, fine a second later), now retried and no longer turns L2 off |
| 2026-09-19 | M4 steps 1 to 3 (real DeepSeek-V4-Flash `local`, Kimi 0.43.1) | pass: explain trace printed; `local` took a `bulk_edit` task from the board, fixed the file and closed it with its native task tools; Kimi accepted and closed a `test` task through the hub's MCP server given to it in ACP `session/new`, calls attributed to `kimi`; claude-mem notes 65768 and 65771 carry `{peer, task, kind}` |
| 2026-09-19 | M4 step 4, PII | pass: owner `local`, reviewer `user`, file edited, 0 hits for the value in `ahub tail` and `hub.log`, 0 rows and 0 pending messages with it in claude-mem, console review closed it |
| 2026-09-19 | M4 step 5 happy path, live (claude 2.1.278 and codex-cli 0.155.1, both interactive through the hub) | pass: task #1 assigned by L1 to owner codex / reviewer claude; codex accepted, read the budget code, closed with `hub_task_done` (summary + refs `src/hub/budget.ts` etc.); the review request reached Claude, which approved with a note matching the implementation (`approved` on the board, full history `user:proposed -> codex:accepted -> codex:done -> claude:approved`). Escalation (two changes_requested) still covered by fakes only |
| 2026-09-19 | M5 steps 1 to 4 (Kimi 0.43.1, DeepSeek `local`, `ahub budget set`) | pass: Kimi wrote `.agenthub/checkpoint.md` and called `hub_checkpoint`, was paused after it, task #5 moved to `local` which accepted it, the second 0.97 reading changed nothing, the mocked reset resumed Kimi with the list of moves |
| 2026-09-19 | M5 step 3 after the review fixes | pass: pause with checkpoint, `ahub resume` refused with the hint, `ahub budget resume kimi` lifted it, a following 96% reading did not pause again |
| 2026-09-19 | M5 Codex source, real `account/rateLimits/read` through the proxy | pass: `primary {usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789811966}`, `rateLimitReachedType: rate_limit_reached`, parsed as the weekly window at 100% with its reset time; the answer did not reach the TUI side |
| 2026-09-19 | M5 step 6, Claude status line tee through `--settings` (claude 2.1.278, pty run of `ahub claude`) | pass: `.agenthub/state/claude-usage.json` appeared within seconds of the session loading (`five_hour 69%`, `seven_day 24%` with `resets_at`), the dotfiles HUD status line rendered unchanged through the wrapped command, `ahub budget` shows both windows `[claude status line]` as fresh |
| 2026-09-19 | M5 Kimi token source (kimi 2.0.1, `budget.kimi_tokens_5h: 200000`, live `ahub say @kimi` turn) | pass: `usage_update` is emitted once per turn; raw payload captured from the ACP stream is `{"sessionUpdate":"usage_update","used":47144,"size":1048576}`; `used` is context occupancy against the 1M window, matched by the parser's `used` fallback; `ahub budget` shows `kimi tokens 25% [kimi usage_update (soft limit)]` right after the turn |
| 2026-09-19 | M5 step 5 components with a real TUI | partial: with a TUI attached through `ahub codex`, the daemon's `account/rateLimits/read` returned the post-reset window (`week 1%, resets in 167h`) as a fresh reading in `ahub budget`; an over-gate pause cannot be triggered naturally today (the weekly window reset this evening). The 100% reading and the refused-turn hard path are the rows above |
| 2026-09-19 | M6 step 1 | pass: `bun add -g github:STAIxBWLB/agent-hub#main` into an isolated prefix installed `ahub` and `agent-hub`; from an unrelated directory `ahub help` and `ahub init` worked, templates and the plugin bundle resolved from the installed package |
| 2026-09-19 | M6 step 3, live model (DeepSeek-V4-Flash) | pass: a task proposed without a class was labelled `implement`, history `triaged`, assigned by that class |
| 2026-09-19 | Codex after the weekly window reset (codex-cli 0.154.0, real account), `bun scripts/smoke-codex.ts` | pass: hub message injected with `turn/start`, final answer "pong" shared at hop 1. Closes the M1 reply leg that the usage limit had blocked all day |
| 2026-09-19 | Codex hub tools over MCP, `bun scripts/smoke-codex-hub.ts` leg A | pass: `agent-hub` MCP server `ready`; a task assigned to Codex was accepted and closed with `hub_task_accept` / `hub_task_done` (history `codex:accepted`, `codex:done`), with no approval prompt: `approval_mode = "approve"` works as assumed |
| 2026-09-19 | Codex `turn/steer`, `bun scripts/smoke-codex-hub.ts` leg B | pass: with a user-started turn running, `ahub say @codex "[IMPORTANT] ..."` went in as `turn/steer` (queue stayed 0), the turn's final answer ended with the requested marker line and came back at hop 1, and no hub request id reached the TUI side. `ahub budget` showed Codex's real weekly window through the daemon |
| 2026-09-19 | `ahub ask` against the real board, claude-mem 13.25.1 and DeepSeek-V4-Flash | pass: "which tasks touched words.ts and who did them" was answered from seven board rows, three memory rows and log lines, every claim with its id; a question with nothing to find returned "Nothing found in the hub's records." |
| | M3 off-campus path (public URL behind Cloudflare Access) | not run live (on the VPN today); header selection covered by tests |
| 2026-09-19 | Two-target `stage_router` / escalation routing, live (GLM-5.3-Flash now served on the gateway as `glm53/glm-5.3-flash`, `.agenthub/routing.toml` with `sy/coding` stage_router + `sy/review` llm_classifier) | pass: sidecar up with routes `sy/coding, sy/fast, sy/review`; a trivial and a hard prompt through `sy/coding` both recorded `last call: switchyard sy/coding -> glm53/glm-5.3-flash` (efficient_first picker, no escalation on confident answers); a proofread and a code-review prompt through `sy/review` classified to the weak target and answered correctly (`the quick brown fox`; NULL-deref found); `ahub local --route sy/review` pinning works |
| 2026-09-19 | Codex TUI through `ahub codex` (pty run, codex-cli 0.155.1) | pass: TUI chrome rendered against the hub proxy, a hub-driven turn ran through the TUI-attached adapter (`busy -> reply -> idle`), Ctrl-C detach took the peer `offline`; no orphan app-server after `ahub kill` |
| 2026-09-19 | Claude through `ahub claude` (pty run, `--unattended`; the dev-channel dialog needs one Enter) | pass: attach shows `claude idle` with the recall preface; the M1 step 5 broadcast was answered by all four peers (`claude` at hop 1, chatter hop-capped correctly); `hub_task_list` over the plugin answered the live board; the review envelope from Codex's task was approved by Claude (row above). A late `/exit` typed into the pty does not reliably quit the TUI — kill the process instead |
| 2026-09-19 | Dedicated inference key `agent-hub-local` issued on the gateway (`omniroute api api-keys`, admin context), stored at `~/.agenthub/omniroute-agent-hub-local.key` (0600), `.agenthub/config.json` points `omniroute.api_key_file` at it | pass: `GET /models` 200, chat completion "pong" via DeepSeek-V4-Flash, `ahub doctor` key present; `AGENTHUB_SWITCHYARD_BIN=$HOME/.cargo/bin/switchyard-server` exported in `~/.config/shell/30-ai.sh` (checked: not in `~/.zshrc`; visible in a login shell), doctor finds switchyard 0.2.0 there |
| 2026-09-19 | Gateway choice with both candidates reachable | found: `ahub doctor` picked the off-campus URL while the internal URL was up (sequential probing, a stalled first request, and a non-5xx answer counting as healthy). Fixed: concurrent probes, list order decides, only 2xx is healthy. After the fix the dedicated key answered "pong" through the internal URL in 324 ms, `provider vllm` |
| 2026-09-19 | `ahub setup` after the M5/M6 commits | pass: `ahub doctor` flagged the morning's plugin as stale (same version, bundle differs), `ahub setup --yes` uninstalled and reinstalled `agent-hub@agent-hub 0.1.0`, doctor then shows `claude plugin ok` |
| 2026-09-20 | #32 backend alias, live 0.6.2 hub (Pi 0.85.1, dgx/coding + mlx) | pass: file-read answer ~2.4 s on dgx/coding (glm-5.3-flash) and ~4 s after `ahub pi --mode headless --backend mlx` re-attach with handover; status printed each alias once, `dgx/dgx`/`mlx/mlx` 0 hits; `ahub say` has no `--backend` flag (absorbed as body) |
| 2026-09-20 | #29 unsolicited `[IMPORTANT]` to busy Kimi via local `hub_send`, live 0.6.2 | pass (no interrupt): `kimi busy queued 1` during the slow turn, delivered right after turn end (idle 09:16:47.551 → busy 09:16:47.552); idle Kimi started a turn immediately; AcpPeer has no steer, capPriority demotes only the peer's own unsolicited marker |
| 2026-09-20 | #29 hop ceiling, live 0.6.2 (Kimi 2.0.1) | pass: hop-1 message answered by idle Kimi in ~8 s; its fyi ack arrived at hop 2 and was dropped (`NOT DELIVERED(fyi)`) |
| 2026-09-20 | #31 permission payload, Kimi 2.0.1 | pass (previous session): `session/request_permission` carries no `rawInput`; hub kept `tool_call` arguments, no bare-tool approval shown |
| 2026-09-20 | #40-#43 after the review fixes, live hub from the PR branch (Kimi 2.0.1, Pi 0.86.0 MLX) | pass: say/remember refuse an absorbed flag and send it after `--`; paused peer printed `queued 3 (2 important)`; Pi mlx->auto handover emitted one `state pi -> idle` and no offline; unprimed Kimi answered a no-action note as `fyi` (`NOT DELIVERED(fyi)`) once the shared instruction named the markers |
| 2026-09-20 | status.json queue depth, live hub | found: the file was one message behind (`queued 3` vs live 4) and kept `queued 4` on an empty queue, because `publish` emits before it enqueues and a delivery emits nothing. Fixed: `bus.onQueues` -> `writeStatus`; re-measured 1 -> 2 -> 3 -> 0 exact, field absent at 0 |
| 2026-09-20 | 0.6.3 gate + isolated install | pass: `bun run check` 301 tests / 1600 expect / `check: OK`; npm pack tgz (281 KB) → isolated BUN_INSTALL prefix, `ahub --version` 0.6.3, `ahub init` wrote all five files; direct `bun add -g .` of the workspace root fails (nameless dependency, DependencyLoop) |

## Issue #7 verification ledger (2026-09-19)

This ledger supersedes the unchecked issue description. A pass applies only to
its stated observation; scripted app-server clients do not count as a real TUI.
Blocked legs remain live-verification work, not passing tests.

The agent-session probes used an isolated temporary git project, the installed
`@staix/agent-hub 0.3.0`, Claude Code 2.1.278 and Kimi 2.0.1. The Switchyard
probe used a separate temporary directory and the checkout's Sidecar/OmniRoute
helpers. Commands in the agent-session project explicitly unset `AGENTHUB_STATE_DIR`: a shell launched inside a hub
session inherits the parent hub's state directory, regardless of its cwd.
No production task or source file was used as a test target.

| Leg | Result | Evidence and remaining boundary |
| --- | --- | --- |
| Actual Claude plugin store setup | pass | `ahub setup --yes` completed against the existing user store; doctor read back `agent-hub@agent-hub 0.3.0` with a matching bundle. No plugin change was necessary. |
| Claude channel, batched digest and explicit reply parent | pass | A real `ahub claude` PTY session received `ISSUE7-DIGEST-A` and `ISSUE7-DIGEST-B` in one channel item with `source="hub-digest"`, `sources="user"`. Its transcript contains actual `hub_send` calls with each input's `reply_to`; daemon log recorded both replies at `hop=1`. |
| Kimi real permission allow | pass | Bash requested approval `f7ee4fcc` at 12:43:20 UTC; `ahub permit f7ee4fcc approve_once` released it, and the actual file contained `permission-shell-ok`. The earlier Write tool did not request approval and was not counted. |
| Kimi real permission timeout | pass | A second Bash request, `371ff686`, arrived at 12:43:47.928 UTC and was left unanswered with the default 120-second timeout. Kimi reported cancellation at 12:45:52.459 UTC, returned idle, did not retry, and `permission-timeout.txt` did not exist. |
| Switchyard two-target routing and escalation | pass (model selection and escalation) | Real Switchyard 0.2.0 selected GLM for the initial `sy/coding` request and DeepSeek after a synthetic critical tool-result fixture. In one `sy/review` session with `confirmations=2`, selection was GLM, GLM, then DeepSeek after two trouble-history submissions. Evidence came from `x-model-router-selected-model`; real router, classifier and targets were used. |
| Claude task proposal and review tools | pass | The actual plugin `hub_task_propose` created scratch task #1, `ISSUE7-REVIEW-FLOW`, at 12:44:20 UTC, attributed to `claude`. The first assignment remained empty because the Codex peer had been detached; proposal success is separate from handoff success. Claude subsequently issued two actual `hub_review` calls with `changes_requested` at 12:47:50 and 12:47:59 UTC. |
| Real Codex TUI queue and MCP tools | pass | With Codex 0.155.1 TUI attached, a typed user turn ran `sleep 30`; the status message showed `busy queued 1`, appeared in the transcript only after the user turn completed, and invoked the actual `hub_task_list` before replying `QUEUE-DELIVERED`. |
| Real Codex TUI steer | pass | In a second typed user turn, the TUI prompt explicitly authorized a console marker update while `sleep 20` ran. An important message arrived at 12:48:15 UTC; queue remained 0; the same turn ended at 12:48:39 UTC with `STEER-VERIFIED` at hop 1. The first probe delivered its steer but the model retained the original user instruction, so that attempt was not counted as behavioral success. |
| Unassisted Claude proposal -> Codex completion -> Claude review and escalation | fail, #11 (previous repository) | Task #1 was delivered to Codex at 12:47:05 UTC; it replied `Task #1 noted; no action taken on the hub reference message.` and left the task proposed. Generated instructions classify every hub item as reference-only memory. After a corrective user prompt in the TUI, board history recorded Codex accepted/done, Claude changes_requested, Codex done, Claude changes_requested, and hub escalation to Kimi. Kimi then accepted/done through its real tools, and Claude approved the task. That assisted success does not erase the default-flow failure. |
| Off-campus Cloudflare Access headers | blocked, [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) | Internal gateway reachable; both Access credential-file settings empty; unauthenticated public models probe HTTP 403. Needs authorized Access credentials and an off-campus network. VPN was not disconnected. |
| Natural Codex budget pause with TUI attached | blocked, [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) | Actual TUI-connected weekly reading was approximately 12%, below the gate. No manual budget reading was injected. Needs a naturally near-limit account; parser and manual-injection tests are not this live leg. |

### Environment findings

The first scratch Codex TUI resolved a different installed executable than the
interactive shell's `codex --version`: the Homebrew-prefix binary was 0.146.0,
whereas the fnm-prefix binary was 0.155.1. The old TUI rendered but its first
model turn failed with HTTP 400, requiring a newer Codex version. That attempt
is not a successful model turn. Pinning `codex_bin` in the scratch configuration
to the verified executable avoids PATH-dependent selection for both the TUI
and app-server; no global installation or user configuration was changed.

The first isolated Switchyard run returned five HTTP 502 responses with
`invalid upstream JSON`; direct calls to both models succeeded. One fresh
sidecar repeat completed all five routing selections above. The transient 502
is not explained by this verification. GLM's bodies were empty at the probe's
192-token limit, so the pass establishes model selection and escalation, not
answer quality. Both temporary sidecars were stopped and generated configs
removed.

### Verification gate

`scripts/check.sh` completed successfully on this checkout:

```text
156 pass
0 fail
1014 expect() calls
Ran 156 tests across 16 files.
check: OK
```

This gate covers type checking, bundle freshness, package contents and tests;
it does not replace the live outcomes or unblock #11 (previous repository) and #1.

## Issue #11 default workflow retest (0.3.1)

Verified on 2026-09-19 with fresh real Claude Code 2.1.278, Codex TUI 0.155.1
and Kimi 2.0.1 sessions in an isolated project. `ahub init` generated the new
managed instructions; `ahub setup --yes` installed the rebuilt 0.3.1 Claude
plugin and read back a matching bundle. The daemon and Codex/Kimi MCP servers
ran the same patched checkout. Control wire protocol remains 6; only prompt
rendering and instructions changed.

The console asked Claude to propose a read-only smoke task for Codex and to
request two deliberate revisions before approving. No user prompt or corrective
instruction was entered into the Codex TUI. Real board history for
`ISSUE11-DEFAULT-FLOW`:

- 12:55:08 UTC: Claude proposed and assigned task #1 to Codex, reviewer Claude.
- 12:55:18: Codex accepted it using `hub_task_accept`.
- 12:55:23: Codex read `smoke.txt` and submitted `issue11-workflow-ok` using
  `hub_task_done`, without changing the file.
- 12:55:28: Claude requested the first deliberate revision.
- 12:55:36: Codex resubmitted through `hub_task_done`.
- 12:55:41: Claude requested the second revision; the hub automatically moved
  ownership to Kimi, retaining Claude as reviewer.
- 12:55:45: Codex acknowledged the handoff and stopped work.
- 12:56:58: Kimi submitted the same file value through its real task tool after
  normal console permission approval. No corrective prompt was sent to Kimi.
- 12:57:04: Claude approved the task. Board readback was `approved`, owner Kimi,
  reviewer Claude; `smoke.txt` still contained its original one-line value.

This closes the default acceptance/review/escalation failure found in the
0.3.0 issue #7 run. The earlier failure is retained above as historical evidence.
The off-campus Access and natural budget-pause prerequisites in #1 remain open.

Regression gate: `scripts/check.sh` completed with `159 pass`, `0 fail`,
`1045 expect() calls`, `check: OK`. Added coverage exercises rendered workflow
kinds, mixed Claude channel metadata and hop-preserving reply-parent selection.

Upgrade existing projects with `ahub init` and refresh the Claude plugin with
`ahub setup`; restart the daemon and agent sessions to load the new instructions.
Updating the plugin alone leaves an old managed AGENTS block in place.


## Multi-project manager source smoke (issue #19, 0.4.0)

Verified on 2026-09-19 from the feature branch, with an isolated `AGENTHUB_HOME`
and two temporary initialized projects. These were actual detached hub/manager
processes and a real Chromium session driven by `agent-browser`; model inference
and memory capture were disabled in the temporary project configurations.

- Opened the unified manager before either project was running; both registered
  roots appeared with disabled project mutation controls until selected and ready.
- Started alpha and beta from the browser and observed distinct authenticated
  project/instance identities and control ports through `projects --json`.
- Proposed `Beta browser isolation check` through beta's task form. Beta showed
  task #1; alpha's board stayed empty. The registry summary reported beta's one
  proposed task rather than counting the number of task-state categories.
- Switched away from alpha with an unsent message and returned: its text draft was
  restored while beta's draft remained separate. A subsequent peer-roster change
  also preserved text currently being typed.
- Held a beta snapshot response in the browser, switched to alpha, then released
  it. Alpha's root/board/draft were unchanged and polling continued afterward.
- An additional delayed action-response check retained the newly selected
  project's draft and did not show the previous project's notice there.
- Used alpha's Stop button and accepted the confirmation naming its full root.
  Independent CLI readback showed alpha stopped and beta still running with its
  task retained.
- Stopped the manager, verified beta was still running, then reopened the manager.
  Browser sessions were replaced without restarting beta.
- Cleaned up the temporary manager and hubs after verification.

Automated fixtures cover native Claude/MCP, ACP and Codex protocol behavior,
parallel registration/startup, cross-token refusal, stale instances, incomplete
shutdown, occupied ports, worktree aliases and manager crash recovery. Simultaneous
live provider-account sessions were not launched in this smoke; npm publication
and upgrading existing user sessions are separate release actions.

## Pi empty-session handover (0.6.1)

Verified with installed Pi 0.85.1 and the authenticated MLX relay on 2026-09-20:

- An explicitly selected session ID survived empty headless-to-native-TUI handover before its transcript existed.
- A managed `read` tool call through `mlx/fast` returned the fixture marker and caused Pi to persist its transcript.
- Headless RPC then resumed the exact session ID and persisted file.
- Disposable Pi processes exited after the test. This check did not restart hwp-cli or prove the agent-hub production cutover.

## 0.6.4 live measurement correction and 0.7.0 status

Measured on 2026-09-20 against the released 0.6.4 runtime. The following
records the actual measurements without private filesystem paths or session
identifiers:

- A production Pi read through the MLX backend returned the exact temporary
  file marker in 5.800 seconds. Pi remained attached with its session identity,
  all peers were idle, and the queue depth was zero after the probe.
- The installed-package run used real Kimi 2.0.1 and Pi, with a synthetic
  control-WebSocket Claude peer. That peer observation does not claim a real
  Claude model round trip.
- Pi returned the exact marker through MLX in 2.234 seconds and through DGX in
  1.324 seconds. MLX-to-DGX handover took 208 ms and preserved the same session
  identity.
- Unknown flags were refused with exit 1. The `--` escape preserved a message
  body containing a flag. CLI and status-file queue readings both showed three
  queued messages and two important messages.
- Withdrawing an expired envelope changed persisted counts from 4/3 to 3/2.
  Resuming a paused peer drained the queue and delivered one batch.
- A Kimi no-action note took 12.242 seconds and returned an FYI reply with zero
  extra recipient deliveries.
- Authenticated recovery readback preserved the task and budget digests. Two
  envelopes for a disconnected Codex peer retained identical IDs before and
  after recovery; general status lists attached peers and did not display this
  latent backlog. No messages were deleted.

These are individual observations, not a latency benchmark or reliability
estimate. Kimi spent its own turn acknowledging, and no handover failure was
deliberately induced. The first synchronous harness run blocked the disposable
daemon event loop; its pass/fail flags are excluded. The corrected asynchronous
run was repeated successfully. Strict response formatting is not guaranteed by
these measurements.

The 0.7.0 protocol-10 durable-delivery implementation, source-9-to-target-10
transition, queue CLI, receipt reconciliation, and attended Claude
confirmation remain pending live verification. Do not claim a successful
0.7.0 production cutover from package installation, tests, or synthetic
approval alone. Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1)
remains open for off-campus Access credentials and a natural near-limit budget
pause.


## 0.7.0 pre-release validation (2026-09-20)

- The local repository gate passed with 324 tests, 0 failures, 1717 assertions
  before the final packaging-only documentation inclusion. Final CI remains
  authoritative for the merged head.
- Test-owned subprocesses were killed at queued and handoff boundaries. Queued
  work and manual pauses survived; uncertain handoffs were held for review and
  were not automatically replayed. Invariant tests cover concurrent publication
  during condensation, recipient-scoped resolution, repeated retry decisions,
  stale-instance writes, corrupt metadata and rejected snapshot import.
- `bun scripts/smoke-recovery-09-10.ts` ran the published 0.6.4 artifact with its
  npm integrity against the new coordinator. Protocol 9 to 10 migration reached
  `released`; exact queued envelope IDs, manual pauses and task identity/state
  digest were preserved. The disposable daemon was stopped afterward.
- Real Kimi and Pi ran in a disposable project using the 0.7.0 code.
  Kimi requested a read-only task-list approval before answering the no-action
  note as FYI; 85.361 seconds includes operator waiting and is not model latency.
  No follow-on recipient delivery occurred.
- Pi returned exact random file markers in 21.370 seconds on MLX and 2.238
  seconds on DGX (`glm-5.3-flash`). MLX-to-DGX handover took 211 ms, retained
  the session and emitted only `idle`. These single observations are not a
  performance comparison with earlier runs. Temporary processes were stopped.
- The synthetic Claude control peer acknowledged bridge receipt and replied
  with a correlated FYI. This does not establish a real Claude inference turn.
- Production application, attended Claude restoration and post-deploy readback
  remain pending until the tagged artifact is installed. Issue #1 remains open.


## 0.7.0 attended production cutover and follow-up

The published 0.7.0 package passed integrity staging and completed protocol 9
to 10 recovery in the production project. Task/budget state and queued Codex
messages were retained. General status now displays the disconnected Codex
recipient and its two pending messages.

Attended recovery exposed #48: the pre-create terminal check treated unrelated
Codex/Qwen terminals as an ambiguous earlier Claude creation. The original
Claude conversation was manually reattached with the captured session identity,
the native development-channel confirmation was accepted, and recovery resume
verified the existing replacement without creating a duplicate. The operation
reached `completed` with its project `verified`.

0.7.1 removes the redundant worktree-wide create blocker while retaining the
coordinator's pending-create fence and returned terminal/session verification.
Regression tests include unrelated terminals and delayed close inventory.
The 0.7.1 attended repeat is recorded separately after application.


## 0.7.1 verified production application (2026-09-20)

- Local full gate: 328 pass, 0 fail, 1732 assertions, `check: OK`. Ubuntu and
  macOS CI passed for the merged patch. npm publication with provenance and
  GitHub Release completed; the staged package matched registry integrity.
- The patched coordinator recreated the captured Claude session while the
  unrelated Codex and Qwen terminals remained open. It did not require manual
  terminal creation. The native development-channel confirmation still required
  an attended acknowledgement; resume adopted that same replacement terminal.
- Recovery completed with the project verified and the live daemon released.
  Global CLI, daemon and Claude plugin report 0.7.1, control protocol 10.
  The installed runtime digest matches the verified staged artifact.
- Claude and Pi session identities match the pre-0.7.0 plan. Kimi reattached
  with a fresh session by design. Queue/manual-pause/task/budget integrity
  matched the recovery snapshot; the board still has three approved tasks.
- The disconnected Codex recipient is visible with the same two queued
  messages. They were neither dispatched nor discarded during validation.
- A production Pi read returned an exact random marker through MLX in 6.067
  seconds. Its journal receipt reached `completed`; its FYI answer triggered
  zero other-peer turns. The daemon instance and Pi session stayed unchanged,
  and the temporary file was removed.
- `ahub doctor` reported all configured checks healthy, including the delivery
  journal and Claude recovery identity. The hwp-cli hub remained stopped.
- These are supervised live checks. Native confirmation screens, uncertain
  delivery review, and the infrastructure prerequisites in #1 remain explicit
  operator responsibilities; this does not certify unattended operation.


## 0.7.1 live status re-measurement (2026-09-21)

Read-only checks against the running production daemon one day after the
verified application; no daemon, plugin, terminal, or journal mutation.

- `ahub --version` returned 0.7.1 and `ahub status` showed the daemon
  (pid 48154, control 127.0.0.1:4600) with claude offline (queued 0), kimi
  idle, pi idle on `mlx/fast`, and the disconnected Codex recipient still
  carrying two queued messages (`oldest 68615s`). The board still shows
  three approved tasks.
- `ahub doctor` reported all 14 configured checks ok, including delivery
  recovery (`journal healthy; no deliveries need review`), the Claude plugin
  at 0.7.1, omniroute and switchyard 0.2.0, Pi MLX, and claude-mem 13.25.2.
- `ahub queue list --json` (protocol 10) read back the two Codex receipts as
  `queued` at revision 16 with their envelope IDs unchanged from the 0.7.1
  validation, and the Pi read receipt as `completed` with `important: true`.
  Neither Codex message was dispatched or discarded.
- `bun run check` on the current HEAD passed with 328 tests, 0 failures and
  1734 expect() calls, `check: OK`. The count is two above the 1732 recorded
  for the 0.7.1 application; no source change is present on HEAD.
- Kimi reports 2.0.2 in doctor; earlier live legs on this page used 2.0.1.

Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) remains open
for off-campus Access credentials and a natural near-limit budget pause.


## Ollama MLX migration validation (issue #51, 2026-09-22)

The repository gate passed with 343 tests, zero failures, and `check: OK`.
A source-build smoke on Apple silicon/macOS 27.0 with Ollama 0.34.2 verified:

- Official `qwen3.5:4b-mlx` was prepared as the dedicated model
  `agenthub-fast-mlx:4b-8k` (digest prefix `975ef418e0df`). Model metadata and
  resident status both reported context length 8192; output is capped at 2048.
- `bun scripts/smoke-ollama.ts` sent a completion, streamed a `get_status`
  tool call, and sent back a synthetic tool result through the authenticated
  AgentHub relay. The final response was nonempty and the relay reported
  actual model `agenthub-fast-mlx:4b-8k`. No real tool or DGX fallback ran.
- Ollama logged `starting mlx runner subprocess`. A short direct completion
  recorded approximately 3.87 GiB peak; after tool calls the resident model
  was approximately 4.6 GB by Ollama's accounting. These are short smoke
  samples, not a long-context peak-memory guarantee or a controlled
  like-for-like comparison with the former Qwen3-8B Python process.
- A separate native-API 15-second keep-alive probe expired and `/api/ps`
  became empty. The OpenAI relay requests independently reported a five-minute
  expiry from the external service configuration. After the last relay
  request at 08:19:21 KST, `/api/ps` was empty at 08:24:27 without an explicit
  unload. This does not mean the relay sets a per-request keep-alive on the
  OpenAI endpoint.
- The Homebrew Ollama build logged a missing optional xgrammar library.
  Ordinary text and tool calls passed; grammar-constrained structured JSON
  output is not certified by this smoke.

The live harness is opt-in and is not called by the hermetic repository
check. `AHUB_SMOKE_PROJECT` selects a project configuration without starting
its daemon or replaying its queue. It deliberately forbids remote inference.


## 0.7.2-0.7.4 attended upgrade smoke (issue #21, 2026-09-27)

Attended registry package/plugin upgrade on a scratch project
(`~/ahub-smoke`, Orca-managed worktree) with claude, codex and kimi attached
to a 0.7.1 hub installed from npm. Pre-upgrade state: task #1 in_progress
(owner codex, reviewer claude), kimi manually paused with one important
envelope queued, live Claude session and live Codex thread captured by the
dry-run plan. This run closes the attended leg left open by the 0.7.1
cutover; it also exposed three recovery defects that became 0.7.3 and 0.7.4.

### What the runs proved

- The coordinator blocked safely, twice, when the Codex TUI detached
  mid-prepare: "no terminal was closed", the 0.7.1 source kept running, and
  the board, pause and queue were verified unchanged afterwards. Blocked
  operations were resumable or cleanly resolvable once their cause was
  removed.
- The fifth attempt (0.7.3 coordinator, codex offline at plan time) drove
  prepare, commit, source stop, staged-target start and native peer restore
  without operator intervention; the new daemon reported version 0.7.3 with
  a new instanceId, kimi still paused with its queued envelope intact, and
  the task board unchanged. Claude restoration paused at the documented
  attended step (development-channel confirmation in the captured terminal),
  then resumed.
- Final state after completion: daemon, CLI and plugin all 0.7.4
  (pid 12483, new instanceId, protocol 10), claude idle, kimi idle with
  queued 0. The important envelope queued at 03:16 on 0.7.1 was delivered
  after resume and answered by kimi at 04:53 ("Received the upgrade
  preservation check envelope"). Task #1 remains in_progress on the board.

### Defects found and fixed by this smoke

- A peer detaching between prepare and commit wedged the operation:
  readiness never recovered, resume refused, abort refused. Fixed in 0.7.3
  (PR #60): an offline peer no longer fails the identity comparison, and an
  already-exited terminal closes as a no-op.
- A zero-turn Claude session (no transcript on disk) made restore fail with
  "No conversation found" and wedged the pending-restore identity gate.
  Fixed in 0.7.4 (PR #62): with the original transcript absent, a fresh
  operator-attached session is accepted.
- The same zero-turn case still cannot pass the coordinator's verify step
  or the daemon's release gate; tracked as issue #64. This operation was
  completed manually (restart snapshot removed, daemon restarted), which is
  an operator action, not a designed path.

### Environmental limits recorded

- An active native Codex TUI could not be kept alive on this machine: the
  Orca runtime closed three `ahub codex` terminals in-process
  (`origin: in-process`, `ptyKilled: true`) 35-90 seconds after each attach,
  while the Claude terminal survived. The Codex leg therefore ran with
  codex offline at plan time, as in the 0.7.1 cutover; this run does not
  claim an active native Codex TUI restoration either.
- The recovery runner for an existing operation always executes the
  operation's preserved source, so a coordinator fix released after an
  operation was created does not reach that operation's resume. The
  sourceRoot digest guard correctly refused a hand-patched receipt.
- `ahub setup` is interactive (one confirmation gates all steps); piping an
  answer works, running it detached does not.
  (Changed in 0.7.7: without a terminal it no longer reads a piped answer; use
  `--yes`.)

Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) remains open
for off-campus Access credentials and a natural near-limit budget pause.

## Shared notes and claims live run (issue #68, 0.7.6, 2026-09-30)

Measured against the released 0.7.6 package (global CLI and Claude plugin both
0.7.6 after `ahub setup`) in a disposable git project, with real Kimi 2.1.1 under
ACP and real Codex (codex-cli 0.156.1) behind the hub's app-server proxy. A script
stood in for the Codex TUI (the `scripts/smoke-codex.ts` pattern, attached to the
live daemon's proxy). No Claude peer was attached. No console message named a tool
or a note kind; the role text and the AGENTS.md block in the peers' prompts do, by
design. Times are hub.log timestamps (UTC).

- Fail note, kind chosen by the model: asked at 03:07:24.886Z to "record this for
  the other agents so nobody retries it" (a WeakMap cannot replace this
  string-keyed Map), Codex called `hub_remember` with `kind: "fail"` on its own,
  with a title and "Do not retry this replacement without a different key model
  or new evidence". The log showed `note from codex [fail]: ...` at 03:07:32.331Z
  (7.4 s); Codex closed with `[FYI]`, so nobody's turn was spent on the answer.
- No turn of its own: Kimi was idle with nothing queued and made no `busy`
  transition between the note and the next console message.
- Ride-along, once: the next console question to Kimi at 03:07:48.827Z ("Should
  src/cache.ts switch its Map to a WeakMap so entries can be garbage
  collected? ...", without mentioning the note) was delivered with the note in the
  same prompt. Kimi's session transcript has the note in the first of its three
  turn prompts only. Kimi answered "No" at 03:08:06.398Z (17.6 s) and said the
  answer "rests on the code itself plus codex's earlier recorded fail note". The
  same first prompt also carried 1042 chars of claude-mem recall from an unrelated
  earlier project: claude-mem keys a project by its directory name, and this one
  was `proj`. Later runs should use a unique directory name.
- Self-claim: told to claim unassigned work without editing, Kimi picked
  `hub_task_propose` with `owner: kimi` and `refs: src/cache.ts` itself. Task #1
  went straight to `in_progress` (`proposed` at 03:11:40.342Z, `claimed by kimi`
  at 03:11:40.343Z, reviewer codex), and no task envelope came back to Kimi.
- Overlap: Codex then claimed "everything under src/" (`owner: codex`,
  `refs.paths: ["src/"]`). Its tool result carried `Overlaps #1 (owner kimi) on
  src/. Settle it with that owner via hub_send before editing those paths.`, the
  console printed `... Overlaps #1 (owner kimi) on src/. codex is told to settle
  it.` at 03:12:01.494Z, and Kimi received nothing. Codex acknowledged the overlap
  in its `[FYI]` answer (in Korean, translated: coordination is needed before
  editing) and did not message Kimi in the claim turn: it had been told not to
  edit yet, and the guidance asks for settlement before editing.
- Environmental limit: Kimi 2.1.1 asked approval for both of its
  `hub_task_propose` calls (its `Read` call asked for none), and sent no
  `rawInput` before the approval, so unlike 2.0.1 the hub had nothing to show:
  the console read `mcp__agent-hub__hub_task_propose (payload not reported by
  the agent)` with `approve_once` / `reject` only (the always option is withheld,
  as designed). Kimi's own transcript records the approval before its tool-call
  event, so the arguments seem to arrive after the request (inferred, not
  captured on the ACP stream). The first request (03:08:48.088Z) went unanswered,
  was cancelled at the 120 s permission timeout, and the claim was lost; Kimi
  reported that accurately at 03:10:58.585Z. Codex called the same tools without
  an approval. A Kimi that should claim or record notes unattended needs a
  tool-approval policy of its own for the agent-hub server; the hub does not
  change it.
- The disposable hub was stopped and its registration removed after recording.

## Kimi approvals for the hub's own tools (issue #72, 2026-09-30)

Kimi 2.1.1 under ACP. The capture used a small ACP client of its own with the hub's
tools server; the live run used a disposable project and a hub built from the PR
branch. Times are hub.log timestamps (UTC).

- ACP stream, captured for `mcp__agent-hub__hub_task_list` (saved) and observed in a
  second capture for `Bash` (`echo probe-72`; output not kept, and the live run
  below shows the same command on the console): `tool_call` (`pending`) names the
  tool and has no `rawInput`;
  `tool_call_update` (`in_progress`) streams the argument JSON cumulatively as
  `content` text (`{"command":"` ... `{"command":"echo probe-72"}`); then
  `session/request_permission` arrives with no `rawInput` and Kimi's own line
  (`Requesting approval to Running: echo probe-72`); `rawInput` appears only on the
  update after the answer. Options: `approve_once`, `approve_always` ("Approve for
  this session"), `reject`. `session/new` offers modes `default`, `plan`, `auto`,
  `yolo` and nothing per server or tool.
- Unattended claim and note: with no console tail open, one message at
  05:40:04.837Z asked Kimi to claim unassigned work and record why a WeakMap cannot
  replace the string-keyed Map. hub.log shows
  `permission auto-approved for kimi: mcp__agent-hub__hub_task_propose`
  (05:40:17.083Z), `... hub_remember` (05:40:17.104Z), the note
  `note from kimi [fail]: ...` (05:40:17.126Z, kind chosen by Kimi), and a second
  auto-approved `hub_task_propose` (05:40:22.741Z) that claimed task #1
  (`claimed by kimi` at 05:40:22.749Z). Kimi's first propose had no `class`; this
  hub had no triage model, so it answered `class is required` and Kimi retried with
  `implement`. Kimi closed with `[FYI]` at 05:40:26.318Z. Nobody answered anything.
- Other tools still ask, now with the arguments: asked to run `echo probe-72`, Kimi's
  request reached the console at 05:40:58.696Z as `kimi asks permission: Bash:
  {"command":"echo probe-72"}`, with `approve_always` offered again because the
  payload was complete. It was rejected; Kimi did not run it and said so at
  05:41:04.397Z.
- The disposable hub was stopped and its registration removed after recording.

## Upgrade sources for the operations guide (issue #75, 2026-09-30)

Two disposable projects, each the only running registered project at the time,
ran a released hub through `bunx --package @staix/agent-hub@<version> ahub up`:
0.7.5 (hub.log `ahub up` at 05:43:12.894Z) and 0.6.4 (06:13:57.001Z).

- From 0.7.5 (protocol 10): `bunx --package @staix/agent-hub@0.7.6 ahub upgrade
  --to 0.7.6 --dry-run` exited 0 with plan `kind: upgrade`, `version: 0.7.6`, no
  plan blockers; the project read as `running`, source 0.7.5, protocol 10, no
  project blockers. The installed 0.7.6 CLI's dry-run showed the same project,
  source and blockers (its `sourceRoot`, and so its fingerprint, differ).
- From 0.6.4 (protocol 9): the same 0.7.6 dry-run exited 0 with no plan or
  project blockers; the project read as `running`, source 0.6.4, protocol 9.
- Nothing changed: each hub kept running, and its hub.log gained no line until it
  was stopped for cleanup.
- Code basis: `RECOVERY_SOURCE_PROTOCOLS = [9, PROTOCOL]`
  (`src/hub/control-client.ts`) admits a running protocol-9 or protocol-10 source
  (`makeUpgradePlan` in `src/cli/upgrade-runtime.ts`); an older one is refused as
  `manual-bootstrap-required`; the staged target must report the coordinator's own
  `PROTOCOL` (`stage` in the same file).
- Not measured here: an applied (`--yes`) upgrade from either source (last proven
  with the 0.7.0 coordinator, see above), and session or terminal planning: no peer
  was attached, so `peers` and `terminals` were empty.
- Both hubs were stopped and their registrations removed after recording.

## Approval notice and timeout (issue #5, 2026-09-30)

A disposable project initialised by the PR branch (`approvals: { timeout_s: 120 }`
from the template, `notify` left to its macOS default) with real Kimi 2.1.1. Times
are hub.log timestamps (UTC).

- Asked to run `echo notify-live-5`, Kimi's request was logged at 11:33:43.793Z as
  `permission 8743d41c requested by kimi (38 chars, shown on the console; cancelled
  after 120s)`. Notifications were on by the macOS default (the template sets no
  `notify`), and no notifier failure line appeared (it logs a spawn error, a
  non-zero exit or its 5 s kill). A clean exit does not prove a banner showed: that
  is visual and not captured here, so the owner confirms it on the next use.
- The request was rejected from the console; Kimi said so at 11:34:03.468Z and ran
  nothing.
- The disposable hub was stopped and its registration removed after recording.

## Overlap measurement (issue #8, from 2026-09-30)

Whether per-task worktrees get built depends on this: two weeks of normal use with
the claim overlap warnings (0.7.6 and later), then the owner decides in issue #8.

- Count, from a checkout of this repository: `ahub projects --json | jq -r
  '.[].stateDir + "/hub.log"' | tr '\n' '\0' | xargs -0 bun scripts/overlaps.ts
  --since <start date>`. It reads only the hub's overlap notice lines and prints,
  per week (Monday, UTC), the number of warnings and each pair of tasks once per
  project, with its owners, shared paths, first warning and count. A registered
  project without a hub.log is skipped with a note.
- Per pair, decide whether it led to conflicting edits: from that project's root,
  with its hub running, `ahub task show <id>` for both tasks, and `git log --since
  <first warning> -- <shared paths>`. A conflicting edit is a commit that
  overwrote or reverted the other task's change, a merge conflict between the two,
  or a build or test run broken by the other task's half-done change.
- Record only the numbers and the verdicts below. The script's output names tasks
  and paths of private projects: it stays local.

| Week of | Warnings | Task pairs | Pairs with a conflicting edit | Notes |
|---|---|---|---|---|
| 2026-09-28 | 0 | 0 | 0 | baseline counted on 2026-09-30 over every registered project; the issue #68 live run's project was already removed |

## Per-turn snapshots (issue #33, 2026-10-01)

- AC1, measured on a clone of this repository (156 tracked files; Apple M5 Max,
  git 2.55.0) with 10 turns that each change three files: a snapshot takes 16.8 ms
  median, 47.6 ms max; each turn adds 68 KiB of loose objects. A turn that changes
  nothing writes no objects.
- Live leg, pending: `ahub undo <turn> --yes --context` against a real Codex TUI,
  checking that the TUI drops the reverted turn from its view on `thread/reverted`,
  and that Codex's running session no longer knows the turn (ask it about the
  reverted turn): the schema says `thread/revert` changes only the saved history.

## 0.7.11 to 0.8.0 attended upgrade (2026-10-01)

A scratch project (a git work tree whose `.agenthub/config.json` predates 0.8.0
and has no `snapshots` block) ran a 0.7.11 hub with one proposed task and no
peers attached.

- `bunx --package @staix/agent-hub@0.8.0 ahub upgrade --to 0.8.0 --dry-run`
  exited 0: one project, source 0.7.11, protocol 10, no blockers.
- `--yes` prepared and committed the source, started the 0.8.0 target and
  reached the restored-peers phase (no peers were attached), then stopped at
  verification: `phase: blocked`, "queue,
  manual pause, task board or budget preservation was not verified". The
  global CLI stayed at 0.7.11.
- Cause: the 0.7.11 source digested its task rows without `plan`, and the
  0.8.0 target's rows carry `plan: {}` after the #31 migration, so any board
  with a task failed the check. Fixed in 0.8.1 (#57).
- The blocked operation could not resume (the same target fails the same
  check) or abort (the source was already stopped), and its recovery lock
  refused `up` and `kill` for every project. The scratch hub was stopped under
  the operation's environment, and the operation was marked cancelled with its
  lock released: an operator step, not a designed path.
- The release gate for v0.8.0 (Actions run 36807880478) failed once on
  "removing a running project is refused"; the rerun passed and published. Cause: `ahub kill` returned before
  the hub released its registry claim. Fixed in 0.8.1 (#58).

## Edit conflict detection (issue #32, 2026-10-01)

- AC3, on a clone of this repository (156 tracked files) with 10 open tasks of
  other owners holding 200 touches: the turn-end path (end snapshot, diff,
  touch query, match) takes 57.6 ms median, 59.6 ms max; the detection part
  alone (diff, query, match) 7.1 ms median. The machine was under load from
  other work; the snapshot alone measured 17 ms median earlier the same day.
- AC4, Claude Code 2.1.286 headless (`claude -p --settings <hook settings>
  --permission-mode acceptEdits`, model Haiku 4.5) in a scratch repository whose
  hub.db had kimi's open task claiming `notes.txt`, asked to edit `notes.txt` and
  quote any agent-hub note:
  - Runs 2 and 3: the hook fired (logged input and output in run 2), Claude
    quoted the warning verbatim, and the edit went through under the session's
    permission mode.
  - Run 1, before the hook was logged: Claude answered NONE. Whether the hook
    did not fire or the model left the reminder out was not determined; that run
    also had no stdin redirect (`< /dev/null`), which runs 2 and 3 had.

## Recovery after an unplanned stop (issue #37, 2026-10-01)

- AC1 baseline, released 0.7.11 in a scratch project, the fake ACP agent standing
  in for the Kimi binary (`kimi_cmd`), `kill -9` of the daemon:
  - the ACP child exited with the daemon;
  - `ahub status` failed to reach the stale manifest's port;
  - `ahub up` started a hub with no peers attached; nothing recorded Kimi's
    session, so it could only start a new one.
- The same run with this branch and `auto_resume_after_crash` on: `ahub up`
  reported the crash and `kimi resumed: ... session s1 ... (ACP session/load)`,
  and Kimi was idle on its recorded session id.
- Pending, needs real accounts: Kimi 2.x (does it offer `loadSession`, and does
  the resumed session keep its context), Pi with a real session file, and Codex
  and Claude reattachment after `kill -9`.

## 0.8.1 to 0.9.0 attended upgrade (2026-10-01)

A scratch project (a git work tree whose `.agenthub/config.json` was written by
the 0.8.1 `ahub init`) ran a 0.8.1 hub with two proposed tasks, one with a path
and a detail, and an open budget pause: a peer had attached once and gone
offline, and `ahub budget set` fed it a 95% reading. No completion check was
configured or running, and no peer was attached at the upgrade.

- `bunx --package @staix/agent-hub@0.9.0 ahub upgrade --to 0.9.0 --dry-run`
  exited 0: one project, source 0.8.1, protocol 10, no blockers.
- `--yes` scheduled the operation, which completed in about 10 s with the
  project `verified`.
- After release the hub ran 0.9.0 under a new instance id. Both tasks were on
  the board unchanged, now with `deps: []` (the column the target adds on open),
  the budget pause kept its reset time, and the `outcomes` table was created.
- The coordinator promoted the global CLI to 0.9.0, and `ahub setup --yes`
  installed the 0.9.0 plugin.
- For about two minutes after the publish step logged `+ @staix/agent-hub@0.9.0`,
  `npm view` still showed `latest: 0.8.1`; the registry caught up without any
  action.

## 0.9.0 to 0.10.0 attended upgrade (2026-10-01)

A scratch project (a git work tree initialized by the 0.9.0 `ahub init`) ran a
0.9.0 hub with tasks on its board and a completion check for the review class, set in
`.agenthub/config.local.json` (`"review": "sleep 40"`, timeout 120 s). No peer
was attached. Times are UTC.

- At 05:54:46 the console marked task #1 done, which started its 40 s check.
  `bunx --package @staix/agent-hub@0.10.0 ahub upgrade --to 0.10.0 --yes` right
  after, about 90 s after the publish, failed with "registry metadata
  unavailable for @staix/agent-hub@0.10.0" and scheduled nothing; the 0.9.0 hub
  kept running. This is the registry lag from the 0.9.0 entry, met here as an
  error instead of a stale `npm view`.
- At 05:55:03 the console marked task #3 done, which queued its check behind
  #1's (checks run one at a time), and `--yes` was applied in the same second.
  Its plan listed one project, source 0.9.0, no blockers. The source did not
  commit while a check was running or queued: #1's passed at 05:55:26 and #3's
  at 05:56:07, the source committed and stopped at 05:56:07.1, and the 0.10.0
  hub was up at 05:56:07.7. The operation, global install included, completed
  at 05:56:15.
- After release the hub ran 0.10.0 under a new instance id. All three tasks
  were on the board with their full history (#1 and #3 approved by their
  checks, #2 still proposed), and no history entry recorded an interrupted
  check.
- The coordinator promoted the global CLI to 0.10.0, and `ahub setup --yes`
  installed the 0.10.0 plugin.

## 0.10.0 to 0.11.0 attended upgrade (2026-10-01)

A scratch project (a git work tree initialized by the 0.10.0 `ahub init`) ran a
0.10.0 hub with `"local": { "bash_network": true }` in
`.agenthub/config.local.json`, two tasks (#1 with the path spelled `./a.txt`),
and an open budget pause: a peer had attached once and gone offline, and `ahub
budget set` fed it a 95% reading. No peer was attached at the upgrade. Times are
UTC, from `hub.log` and the operation record.

- 0.11.0 was published at 08:43:45 (the registry's `time` field); a
  cache-busting registry read, observed at the console at 08:43:58, showed it
  as `latest`. `bunx --package @staix/agent-hub@0.11.0 ahub
  upgrade --to 0.11.0 --dry-run` then listed one project, source 0.10.0, protocol
  10, no blockers.
- `--yes` created the operation at 08:44:19.4. The source committed at 08:44:19.5
  and stopped; the 0.11.0 hub started its egress proxy (13 allowed hosts) at
  08:44:19.7, found the pause still open with its reset time, and was up at
  08:44:19.7. The operation, global install and plugin install included,
  completed at 08:44:27.7.
- The tasks' refs and history and the pause row's columns, dumped with `sqlite3`
  before and after (the latter once the 0.11.0 hub was up), were byte-identical: #1 still reads `./a.txt` (0.11.0 normalizes paths only on new
  writes).
- Through the proxy, `curl` reached registry.npmjs.org (200, observed at the
  console: the proxy logs no successes) and was refused example.com, logged as `network: refused example.com:443 (example.com:443 is
  not in local.network_allow)`.
- After `ahub setup --yes`, `claude plugin list` showed the 0.11.0 plugin.

## 0.11.0 to 0.12.0 attended upgrade (2026-10-01)

A scratch git project ran a 0.11.0 hub whose `.agenthub/config.local.json` set
both settings 0.12.0 retires, `"local": { "sandbox": "allow-default",
"bash_network": "direct" }`, with two tasks and an open budget pause (a peer had attached once and gone offline, and
`ahub budget set` fed it a 95% reading). No peer was attached at the upgrade.
Times are UTC, from `hub.log`, the operation record and saved command output.

- 0.12.0 was published at 10:35:02 (the registry's `time` field); a saved
  cache-busting registry read at 10:35:17 showed it as `latest` with SLSA
  provenance.
- `bunx --package @staix/agent-hub@0.12.0 ahub upgrade --to 0.12.0 --dry-run`
  listed one project, source 0.11.0, protocol 10, no blockers.
- `--yes` (10:35:35) created the operation at 10:35:36.0; the source committed at
  10:35:36.1 and stopped. The 0.12.0 hub logged both notes at
  10:35:36.3 (`local.sandbox "allow-default" was removed in 0.12.0 ...` and
  `local.bash_network "direct" ... goes in 0.13.0 ...`), found the pause still
  open with its reset time, and was up at 10:35:36.4. It started no egress
  proxy, as `"direct"` asks. The operation, global and plugin install included,
  completed at 10:35:44.2.
- The tasks' refs and history and the pause row's columns, dumped with `sqlite3`
  before and after, were byte-identical.
- `ahub doctor` in the project showed both notes as `--  retired setting` rows,
  and after `ahub setup --yes`, `claude plugin list` showed the 0.12.0 plugin.

## 0.12.0 live use with real agents (2026-10-01)

A disposable git project (`textkit`: `slugify` with three failing tests, `mean` without `median`) ran the released
0.12.0 hub with real Kimi 2.1.1 under ACP, Pi 0.86.0 headless on the DGX backend, the local worker and real
codex-cli 0.156.1 behind the hub's app-server proxy. A script stood in for the Codex TUI, and another for the console
approver: it answered each relayed permission with allow once. No Claude peer was attached. The console proposed the
work. Times are `hub.log` UTC. Issues #89-#95 come from this run.

- **Codex's own quota reading paused it.** Its `rateLimits` read the week window at 95%. The hub sent the checkpoint request at
  12:47:42.1, paused Codex at 12:48:00.3 with "checkpoint received", and recorded the hand-off (reset in 3208 min,
  beyond `wait_max_min` 30). That one checkpoint turn cost 172,176 tokens (#95).
- **Without a gateway the local worker attached, failed and kept its task.** No model gateway was configured for
  the project, yet `ahub local` printed "attached" (observed at the console). Its first task envelope (#2) failed
  three times and was given up at 12:48:09.2 (`hub.log` and the console tail say so), and the task stayed with
  `local`, not escalated (#89).
- **Pi's failed turn was escalated.** It failed for the same reason, and #1 moved to Kimi at 12:48:23.2.
- **Unanswered approvals were cancelled.** Kimi's two `bun test` approvals went unanswered: the approver script had not
  subscribed to permission pushes yet, a harness error. They were cancelled after 120 s, and Kimi reported that it
  could not run the tests. #1's completion check (`bun test`) passed, and #1 was approved with no reviewer at
  12:53:34.6: Claude was absent, Codex paused, and Kimi owned it. Kimi's `reviewer` role in `config.json` counted
  only once `routing.toml` listed it in the review class, which was edited mid-run (12:49); that is why Pi's #2, #3
  and #5 got Kimi as reviewer (#92).
- **A controlled restart carried the queues.** After the gateway settings were added, `ahub restart --yes` with
  Kimi, Pi and local attached took 13:02:26 to 13:02:30, project verified. Pi's queued and needs_review deliveries
  carried over.
- **The pinned model was not served.** With the gateway reachable, the template's `[local] fixed_model` was answered
  with HTTP 401 ("No active credentials for provider"). #2 was given up again at 13:03:05.8 and 13:04:31.6.
  `ahub local --model coding` answered "already attached" (observed at the console; #93).
- **A needs_review delivery held Pi's queue.** #2, reassigned to Pi, waited behind it until the console discarded
  it (#90). Pi then accepted #2 at 13:07:13, its check passed, and Kimi approved it at 13:07:43.9 with a review
  note against the plan.
- **The dependent task became ready, and went to a failing peer.** #3, after #1 and #2, became ready at 13:07:44.0 and
  was assigned to `local`, whose delivery was given up at 13:07:45.3 (#89). Reassigned to Pi, it was done and
  approved by Kimi at 13:11:39.6.
- **The overlap was settled by the agents.** #5 (Pi) was proposed while #4 (Kimi) claimed the same two files, and
  the claim warned at 13:09:22.3. Pi sent Kimi its plan before editing. Kimi proposed a shared options object and
  Pi agreed. Both landed, and the suite passed with 18 tests. The hop cap stopped their acknowledgements at hop 4.
- **The concurrent edit went undetected.** The two turns overlapped on those files, and no conflict was logged:
  `ahub report` shows `edit conflicts: 0` (#91).
- **The egress proxy held.** In a Pi turn, `curl` reached registry.npmjs.org (200, in Pi's answer). example.com got
  "CONNECT tunnel failed, response 403", logged at 13:12:01.0 as `network: refused example.com:443`.
- **Undo worked both ways** (observed at the console; `ahub undo` writes nothing to `hub.log`). It refused a turn
  whose files changed later, and listed, then restored, a safe one.
- **Crash recovery brought the peers back.** `kill -9` hit the daemon while Kimi was in a turn (its turn started
  at 13:17:56.7; the kill at 13:17:59 was observed at the console). At 13:18:11.6 the next start reported one in-flight delivery in needs_review. Kimi resumed by ACP `session/load` at
  13:18:12.5, Pi from its session file at 13:18:12.8, and local started fresh; a process check at the console found
  no orphan from the killed run.
  Retried from the console, the question reached Kimi led by the loss notice ("The hub stopped unexpectedly ...",
  with the delivery id), and Kimi answered at 13:19:26.6.
- **Pi's tokens were missing from the report** (#94).

### Channel settlement and usage (0.12.3, protocol 12)

With real Codex and Claude sessions in a disposable project, deliver a workflow
assignment to Claude, then a directed Codex question. Reply to the question and
approve the workflow task. Confirm `ahub status` still lists the workflow delivery
as awaiting settlement, without a queue hold, and a later important message arrives.
Call `hub_delivery_done` with the workflow channel's delivery ID and generation.
Confirm only that row becomes completed. Wrong peer, stale generation and unrelated
IDs must be refused. Disconnect during another accepted delivery; confirm
`needs_review` survives reconnect and requires explicit inspected queue resolution.

Compare Claude usage events against its explicit native session transcript, deduped
by assistant message ID. Compare local usage events with actual successful provider
response counters; absent counters remain unknown and model aliases remain separate
from reported served-model provenance. Do not infer dollar spend from token counts.

## Native Pi auto-route dispatch verdicts (#164)

Run `bun scripts/smoke-pi-route.ts` for permissive connectivity, or add
`--require-primary` to require a successful primary dispatch without fallback.
`AHUB_SMOKE_PROJECT` selects the project configuration; the smoke creates a
separate temporary Pi workspace, permits no tools and leaves existing hubs alone.
The project `mlx.enabled = false` capability excludes local routing from this
smoke as well as the daemon. The response must equal `PI_HUB_AUTO_OK` exactly.

The JSON verdict separates `nativeResponse`, `primaryRoute`, `fallbackRoute` and
`fallbackOccurred`. `choices` records routing intent. `dispatches` records actual
upstream attempts, with dispatch IDs and `fallbackOfId` linking a fallback to its
failed primary; model identification comes only from that dispatch's journal.
Backend readiness, a selected tier and a previous model label cannot certify
that a generation completed. Failure diagnostics contain only bounded categories
and HTTP status; raw errors, URLs, headers and native answer text are omitted.

For an unavailable MLX primary followed by a completed DGX fallback, expect
`nativeResponse: passed`, `primaryRoute: failed`, `fallbackRoute: passed` and
`fallbackOccurred: true`. Connectivity passes, but the local route failed.
The same evidence fails with `--require-primary`. Primary-only completion reports
`fallbackRoute: unknown`; a cancelled primary reports `primaryRoute: cancelled`.
If both attempts fail, connectivity fails even if unrelated answer text contains
the sentinel. Missing served-model evidence remains `identified: false`.

Before recording live acceptance, run a bounded unavailable-local/healthy-remote
leg and retain the sanitized JSON plus process cleanup confirmation. Fixture
verdicts do not certify provider availability or a real local generation.

## 0.12.18 live checks: task attribution and console colors (#200, #201, 2026-10-09)

The agent-hub project's own hub was upgraded from 0.12.17 to 0.12.18 by the
user with the 0.12.18 coordinator, run from a plain terminal (an agent shell is
refused by the identity gate). Claude (the session writing this) and Pi on
`dgx/coding` were attached for the checks. Times are UTC.

- **The upgrade left Claude held.** Operation `c671d786` (source 0.12.17,
  protocol 15, running) was created at 05:26:55, the 0.12.18 daemon started
  the same second, and the operation completed with the project verified. Ten deliveries Claude had accepted but never settled (three board review
  requests, seven Codex chats, all handled before the upgrade) were moved to
  `needs_review` with "peer disconnected before delivery settlement", and
  Claude's queue was held behind them. `ahub queue resolve` is a console
  command, so only the user can release it; the unsettled acceptances are #205.
- **#200 AC4, attribution on a live turn.** Board task #19 (class `test`,
  owner Pi) was proposed at 05:30:03, accepted at 05:30:07, done at 05:34:52
  and approved at 05:35:16. `ahub report --by task` at 05:35:06 attributed Pi's
  one turn and 602,255 tokens to #19 by its delivery. Unattributed: 2,159,396
  of 38,171,695 token increments (5.7%) and 21 of 116 usage records (18.1%),
  all Claude's own user-driven turns, which have no task-bearing delivery and
  no single open task. The `before attribution` bucket held 35,410,044 tokens
  and 95 records from before the upgrade. Both shares equal the JSON
  `unattributed` counts over `totals`, and the JSON carried task ids, class and
  outcome but no title or detail text.
- **Pi could not run the check itself.** Its sandbox denies
  `.agenthub/state/` (the `ahub` binary under the bunx cache and `events.jsonl`
  both failed with EPERM). It reported every check as not run instead of
  passing it, and the reviewer ran them.
- **#201 AC7, idle console CPU.** Sampled with `ps` cumulative CPU time while
  nothing happened on the hub: plain `ahub console`, 0.11 s over 60 s
  (about 0.18%); `ahub console --panels`, 0.46 s over 120 s from 05:52:30
  (about 0.38%, 0.21 to 0.25 s per minute, not growing).

## Console layout and readability: how to check (#213, #201 AC2)

Not run yet. Record the terminal, its theme and the result per step.

- In a light and a dark terminal profile, run `ahub console --panels` at 80x24
  with at least one pending approval, one task and one `needs_review` delivery.
- Check that the rules, the bracketed active tab, the tab counts, every table's
  header row and the footer hint are readable, and that titles, approval details
  and body text use the default foreground.
- Repeat with `--color=never`: the active tab, selection marker and states must
  still read without color.
- Press `?`, Enter on an approval and Tab back to the stream; check that the key
  table, the labeled detail and the stream's rule above the footer read in both
  themes.

## `ahub bench` live run (#251)

Not run yet (unverified). In a scratch git repository kept for benchmarks (`"bench": { "enabled": true }`, `.agenthub/`
untracked), with at least two real peers attached:

- Run a two-task suite with `--repeat 2` under one arm; check each attempt's outcome against its `verify` command and
  that the tree is reset between attempts.
- Let one task run past its `timeout_s`; check the run stops, names the open task and reads `stopped`.
- Press Ctrl-C during a `verify`; check the attempt reads `interrupted` and nothing it started keeps running.
- Run a second arm, then `ahub bench compare <arm> <arm>`; check the dashboard's Benchmarks section shows both.

## Permission modes (#240, #242), 2026-10-10

Installed native versions: Kimi 2.1.1, Codex 0.162.0, Claude Code 2.1.296,
Pi 1.0.1. Checks use disposable scratch fixtures outside this repository, one
short file-edit plus harmless `printf` shell prompt per non-ask mode. Native
runs go through `dot admit`; no production permission command or sandbox
change is used. Two admission attempts were deferred before any prompt by
unrelated rsync jobs; a later attempt admitted the sequential fixture run.

| Agent | Mode | File edit | Harmless shell | Permission evidence |
| --- | --- | --- | --- | --- |
| Kimi | ask-when-needed (`yolo`) | `file-edit-ok` read back | `shell-ok` read back | 0 ACP permission requests |
| Kimi | never-ask (`auto`) | `file-edit-ok` read back | `shell-ok` read back | 0 ACP permission requests |
| Codex | ask-when-needed | Unverified, no file produced | Unverified, no file produced | Proxy turn emitted userMessage but no tool/completion within 180 s; 0 approval requests |
| Codex | never-ask | Not run, unverified | Not run, unverified | Omitted after the first bounded failure, preserving prompt quota |
| Claude | ask-when-needed | edit.txt changed to after | shell.txt read back shell-ok | Historical earlier policy: bound native hook identity; 0 denials. Current scoped policy unverified |
| Claude | never-ask | edit.txt changed to after | shell.txt read back shell-ok | Historical earlier policy: bound native hook identity; 0 denials. Current scoped policy unverified |
| Pi | ask-when-needed | Unverified, no tool ran | Unverified, no tool ran | Fixture had no model gateway configured; RPC prompt accepted but no model/tool execution |
| Pi | never-ask | Unverified, no tool ran | Unverified, no tool ran | Same missing fixture gateway; no successful model/tool execution |

The Kimi trace records set_mode replies before each prompt. session/new lists
`default`, `plan`, `auto`, `yolo` and currentModeId default; loading the same
session after never-ask reports default, with no extra prompt. Fake regressions
also cover a resumed session retaining auto/yolo, which is reset to default
before prompts under the project's ask policy.

Kimi's CLI calls `yolo` Ask When Needed and says routine edits and commands run
automatically. The observed harmless shells agree. These two benign prompts do
not prove risky-action policy or distinguish the two modes on risky actions;
the contradictory ACP mode descriptions do not justify reversing the CLI/UI
mapping. Codex similarly uses its native on-request policy rather than the
Claude/Pi read/edit allowlist.

Claude Code completed both isolated headless native runs with exit 0. Its
ask-when-needed hook allows file tools and returns no override for Bash;
the harmless shell was permitted by the existing native policy. A zero
permission_denials array is not evidence that an interactive dialog appeared.
The hook's matching instance/launch metadata confirms its transport ran.

No additional native prompts were sent for the subsequent launcher metadata
and permission-only idle fixes; their behavior is pinned by focused daemon/launcher
regressions. Pi's missing gateway was a fixture configuration limitation, not
evidence of an account outage or a permission-mode failure. Codex's timeout
cause remains undiagnosed. These legs remain unverified rather than being
replaced with fake evidence. Fixture process groups were stopped afterward.

The historical Claude benign checks above used the earlier hook policy. The current scoped-path policy, expanded native configuration exclusions, startup reconciliation, and private settings retirement are covered by fixtures but remain native unverified. No additional account prompts were used for the second review corrections.

Unverified natively (Codex 0.162.0): whether a thread that got a `never` or `on-request` override keeps it when the
same thread is resumed through the hub's proxy by a hand-run `codex --remote` after `ahub permission codex ask` was
given while no TUI was attached. The status says ask; the current proxy keeps restoration owed per thread and
sends the captured native policy once on the resumed thread's next accepted turn, including when the TUI echoes
the resume response's sticky override. This protects only the restoring turn; a repeat on the second TUI turn
cannot be distinguished from an explicit choice and passes through. Both turns' TUI traffic remain natively unverified. `ahub codex` always starts
a new proxy, which is not affected. See the current #270 manual checklist above.

## Whole-board task progress and dashboard themes (#246)

Live console and dashboard light/dark inspection: **unverified**. No native
sessions or model prompts were started for this change. The review pass admitted
a real dependency install and focused tests, recorded separately from native
visual/theme qualification.

When admitted, inspect an empty board and a mixed board (approved, waiting,
working, review and changes requested) at 80x24, 120x40 and 200x60. Confirm the
stream count is in the footer and the scroll region starts at row 1 and the Tasks summary/row meters agree
with the dashboard. In the dashboard select Light, Dark and System, reload each
choice, change OS theme on System, and check text, bars, stage labels and controls.
Repeat with cookies blocked and across two dashboard ports; verify unchanged
progress snapshots do not repeatedly announce the live region. Record the exact head and verdict here.

## One-shot command output (#284 phase 1)

Human visual inspection: **not run**. Automated geometry and color checks are separate evidence.
At the PR head, run `ahub status`, `ahub board`, `ahub budget` and `ahub doctor` in a light and a dark terminal,
at 80 and 120 columns. Inspect Korean and long task titles, settlement and hold details, modes and quota windows.
Confirm readable state/level words with `--color=never`, matching visible text with `--color=always`, and no cut fields.
Compare status's shortened informational ids with `status --full`; suggested command ids must always be whole. In `ahub console`,
run `status`, `board` and `budget` and confirm their rows stay within the four-column indent and output remains plain. Run `ahub doctor` in the terminal outside the console.
Record the exact head and visual verdict here after the owner performs this leg.

## Remaining command output (#284 phases 2 and 3)

Human visual inspection: **not run**. At the PR head, use light and dark terminals at 80 and 120 columns.
Run `ahub projects`, `ahub status --all`, `ahub queue list`, `ahub turns`, `ahub doctor --orphans`,
`ahub queue show <id>`, `ahub models status`, `ahub budget execution status`, `ahub report` and `ahub report --by task`.
Inspect long Korean paths, all changed filenames, public private-delivery stubs, nested labelled fields, relative times and report coverage sentences.
Compare `--color=never` with `--color=always`. Confirm turn, queue, project and execution budget ids are whole without `--full` and can be copied into their commands.
In the console run `status --all`, `queue list`, `queue show <id>`, `turns`, `budget execution status`, `report` and `report --by task`;
run `ahub projects`, `ahub doctor --orphans` and `ahub models status` in the terminal outside the console. Status's informational ids can be compared with `status --full`.
Confirm JSON output stays plain under `--color=always`. Record the exact head and visual verdict here after the owner performs this leg.
