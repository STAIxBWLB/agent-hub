# Live smoke checklist

`scripts/check.sh` covers everything against fakes. The legs below need real accounts and an interactive terminal, so they are run by hand and recorded here.

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
  went through the gateway (omniroute 172.16.229.33:20128) as before.
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
Issue #12's Access and natural-quota prerequisites remain unchanged.

## Install

```bash
bun add -g github:STAIxBWLB/agent-hub      # or: git clone, bun install, bun link
ahub setup                                 # Claude Code channel plugin from this package, then doctor
```

Claude channels are a research preview: `ahub claude` passes `--dangerously-load-development-channels plugin:agent-hub@agent-hub`.

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
6. While Codex is mid-turn on a long prompt typed in its TUI, run `ahub say @codex "status?"`. `ahub status` shows `queued 1` for codex; the message is injected after the turn completes.
7. `ahub say @kimi one`, `ahub say @kimi two` back to back: both answered in order, none lost.
8. Ask Kimi for something that needs a tool (`ahub say @kimi "create /tmp/agenthub-smoke.txt"`): `ahub tail` prints the permission request; `ahub permit <id> <option>` answers it; no answer within 120 s cancels it.
9. `ahub kill`: no `kimi acp` or `codex app-server` process survives (`pgrep -fl "kimi acp|codex app-server"`).

## M2: tiers, digests, steer, recall

1. `ahub pause kimi`, then `ahub say @kimi "[STATUS] one"`, `ahub say @kimi "[STATUS] two"`, `ahub say @kimi "how many agent-hub messages are in this prompt?"`. `ahub status` shows `kimi paused queued 3`. `ahub resume kimi`: one Kimi turn answers for all of them, and on the first delivery of the hub run it also reports the `hub` memory item (`grep recall .agenthub/state/hub.log` shows its size).
2. `ahub say "[FYI] note"` appears on `ahub tail` as `[fyi: record only]` and no peer goes busy.
3. With Codex mid-turn on a long prompt typed in its TUI: `ahub say @codex "[IMPORTANT] stop and summarize"`. The running turn changes course (steer) instead of a new turn starting afterwards; `ahub status` never shows it queued. `ahub say @codex "[STATUS] later"` during the same turn stays queued until the turn ends.
4. Two agents chatting without markers: their replies reach the third agent as digests, not one turn per message.

## M3: local worker

Needs a model gateway in `omniroute.urls` (for the owner: the campus gateway over VPN, or the Access-protected public URL with its two header files) and a key: `OMNIROUTE_API_KEY`, or `omniroute.api_key_file` in `.agenthub/config.json`.

1. `ahub doctor`: `omniroute` healthy, `omniroute key` present, `switchyard` installed or not.
2. In a scratch git repo: `ahub up`, `ahub local`, `ahub tail`, then `ahub say @local "fix the typos in <file>, run git diff --stat and report"`. `ahub tail` shows a permission request for the edit; `ahub permit <id> allow`. The file changes, the answer is a short conclusion, `ahub status` shows `last call: omniroute <model> (provider vllm)`.
3. Same with `AGENTHUB_SWITCHYARD_BIN` (or `switchyard-server` on PATH) set before `ahub up`: `ahub status` shows `last call: switchyard sy/coding -> <model>` and `switchyard: 127.0.0.1:<port>`; `lsof -nP -iTCP -sTCP:LISTEN | grep switchy` shows loopback only; `.agenthub/state/switchyard.toml` is mode 600 and holds no key; after `ahub kill` the file and the process are gone.
4. claude-mem: `sqlite3 -readonly ~/.claude-mem/claude-mem.db "select agent_id, agent_type, project, title from observations order by id desc limit 3"` shows `local | local-worker` rows a minute or two later (claude-mem's observer runs asynchronously).

## M4: task board

1. `ahub up`, `ahub kimi`, `ahub local`, `ahub tail`. `ahub route explain --class bulk_edit "fix typos"` prints candidates, owner and reviewer.
2. `ahub task propose bulk_edit "Fix the spelling mistakes in words.ts" --path words.ts`: `local` accepts, edits, calls `hub_task_done`; `ahub board` shows it `approved` (no reviewer attached) or `in_review`.
3. `ahub task propose test "Check that words.ts contains ..."`: Kimi takes it and reports through the hub's MCP tools (`ahub task show <id>` history: `kimi accepted`, `kimi done`).
4. PII: propose a task whose title matches `signals.pii_patterns`. Owner `local`, reviewer `user`; `grep <value> .agenthub/state/hub.log` and the `ahub tail` output find nothing; `ahub board` shows `[pii]`; `ahub task show <id>` shows the text; `ahub review <id> approved` closes it; claude-mem has no row with the value.
5. With Claude and Codex attached: a task proposed by Claude, done by Codex, reaches Claude as a review; two `changes_requested` move it to the next peer in `escalate_to`.

## M5: budget relay

1. `ahub up`, `ahub kimi`, `ahub local`, `ahub tail`. Give Kimi a task, then `ahub budget set kimi 0.95 --resets-in 2m`.
2. `ahub tail`: Kimi is asked for a checkpoint, writes `.agenthub/checkpoint.md`, calls `hub_checkpoint`; then `budget: kimi paused ...; checkpoint received` and `budget: moved from kimi: #<id> owner -> local`. `ahub status` shows `kimi paused (budget: ...)`, `ahub board` shows the task with `local`.
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
| Unassisted Claude proposal -> Codex completion -> Claude review and escalation | fail, [#11](https://github.com/STAIxBWLB/agent-hub/issues/11) | Task #1 was delivered to Codex at 12:47:05 UTC; it replied `Task #1 noted; no action taken on the hub reference message.` and left the task proposed. Generated instructions classify every hub item as reference-only memory. After a corrective user prompt in the TUI, board history recorded Codex accepted/done, Claude changes_requested, Codex done, Claude changes_requested, and hub escalation to Kimi. Kimi then accepted/done through its real tools, and Claude approved the task. That assisted success does not erase the default-flow failure. |
| Off-campus Cloudflare Access headers | blocked, [#12](https://github.com/STAIxBWLB/agent-hub/issues/12) | Internal gateway reachable; both Access credential-file settings empty; unauthenticated public models probe HTTP 403. Needs authorized Access credentials and an off-campus network. VPN was not disconnected. |
| Natural Codex budget pause with TUI attached | blocked, [#12](https://github.com/STAIxBWLB/agent-hub/issues/12) | Actual TUI-connected weekly reading was approximately 12%, below the gate. No manual budget reading was injected. Needs a naturally near-limit account; parser and manual-injection tests are not this live leg. |

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
it does not replace the live outcomes or unblock #11 and #12.

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
The off-campus Access and natural budget-pause prerequisites in #12 remain open.

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
approval alone. Issue [#12](https://github.com/STAIxBWLB/agent-hub/issues/12)
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
- Real Kimi 2.0.1 and Pi ran in a disposable project using the 0.7.0 code.
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
  remain pending until the tagged artifact is installed. Issue #12 remains open.
