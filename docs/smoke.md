# Live smoke checklist

`scripts/check.sh` covers everything against fakes. The legs below need real accounts and an interactive terminal, so they are run by hand and recorded here.

## Install

```bash
bun add -g github:STAIxBWLB/agent-hub      # or: git clone, bun install, bun link
ahub setup                                 # Claude Code channel plugin from this package, then doctor
```

Claude channels are a research preview: `ahub claude` passes `--dangerously-load-development-channels plugin:agent-hub@agent-hub`.

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
| | M2 step 3, `turn/steer` against real Codex | not run: account usage limit; verified against the fake app-server only |
| 2026-09-19 | M3 step 2, direct path (OmniRoute 3.8.50, DeepSeek-V4-Flash, VPN) | pass: attended edit via `ahub permit`, sandboxed `git diff --stat`, conclusion in about 5 s, `provider vllm` recorded; with no Switchyard installed the hub said so once and used `fixed_model` |
| 2026-09-19 | M3 step 3, real `switchyard-server` 0.2.0 (`cargo install`) | pass after two config fixes found by `--dry-run` (`timeout_ms` rejected, escalation table required): tool-using turn through `sy/coding`, selected model recorded, bound to 127.0.0.1 only, config 0600 without secrets, file and process gone after `ahub kill` |
| 2026-09-19 | M3 step 4, claude-mem 13.25.1 | pass: session `platform_source = agent-hub`, observation 65484 `agent_id = local`, `agent_type = local-worker`. Found live: `summarize` with `agentId` is skipped as subagent context, and an unawaited `session-end` never left the process; both fixed |
| 2026-09-19 | M3 regression after review fixes, attended, through the real sidecar | pass: the approval shows the edit's old and new text; one stalled first probe over the VPN was seen once (both candidates timed out, fine a second later), now retried and no longer turns L2 off |
| 2026-09-19 | M4 steps 1 to 3 (real DeepSeek-V4-Flash `local`, Kimi 0.43.1) | pass: explain trace printed; `local` took a `bulk_edit` task from the board, fixed the file and closed it with its native task tools; Kimi accepted and closed a `test` task through the hub's MCP server given to it in ACP `session/new`, calls attributed to `kimi`; claude-mem notes 65768 and 65771 carry `{peer, task, kind}` |
| 2026-09-19 | M4 step 4, PII | pass: owner `local`, reviewer `user`, file edited, 0 hits for the value in `ahub tail` and `hub.log`, 0 rows and 0 pending messages with it in claude-mem, console review closed it |
| 2026-09-19 | Codex MCP override | partial: `codex app-server -c mcp_servers.agent-hub.*` starts the hub's MCP server and reports `ready` (no model quota needed); a real Codex turn calling a hub tool is not verified |
| | M4 step 5 (review handoff and escalation with Claude and Codex live) | not run: needs interactive Claude and Codex sessions; covered by tests against fakes |
| 2026-09-19 | M5 steps 1 to 4 (Kimi 0.43.1, DeepSeek `local`, `ahub budget set`) | pass: Kimi wrote `.agenthub/checkpoint.md` and called `hub_checkpoint`, was paused after it, task #5 moved to `local` which accepted it, the second 0.97 reading changed nothing, the mocked reset resumed Kimi with the list of moves |
| 2026-09-19 | M5 step 3 after the review fixes | pass: pause with checkpoint, `ahub resume` refused with the hint, `ahub budget resume kimi` lifted it, a following 96% reading did not pause again |
| 2026-09-19 | M5 Codex source, real `account/rateLimits/read` through the proxy | pass: `primary {usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789811966}`, `rateLimitReachedType: rate_limit_reached`, parsed as the weekly window at 100% with its reset time; the answer did not reach the TUI side |
| 2026-09-19 | M5 step 6, Claude status line tee through `--settings` (claude 2.1.278, pty run of `ahub claude`) | pass: `.agenthub/state/claude-usage.json` appeared within seconds of the session loading (`five_hour 69%`, `seven_day 24%` with `resets_at`), the dotfiles HUD status line rendered unchanged through the wrapped command, `ahub budget` shows both windows `[claude status line]` as fresh |
| 2026-09-19 | M5 Kimi token source (kimi 2.0.1, `budget.kimi_tokens_5h: 200000`, live `ahub say @kimi` turn) | pass: `usage_update` is emitted once per turn; raw payload captured from the ACP stream is `{"sessionUpdate":"usage_update","used":47144,"size":1048576}`; `used` is context occupancy against the 1M window, matched by the parser's `used` fallback; `ahub budget` shows `kimi tokens 25% [kimi usage_update (soft limit)]` right after the turn |
| | M5 step 5 with a real TUI (pause driven by Codex's own numbers) | not run: needs an interactive `ahub codex` session |
| 2026-09-19 | M6 step 1 | pass: `bun add -g github:STAIxBWLB/agent-hub#main` into an isolated prefix installed `ahub` and `agent-hub`; from an unrelated directory `ahub help` and `ahub init` worked, templates and the plugin bundle resolved from the installed package |
| 2026-09-19 | M6 step 3, live model (DeepSeek-V4-Flash) | pass: a task proposed without a class was labelled `implement`, history `triaged`, assigned by that class |
| | M3 off-campus path (public URL behind Cloudflare Access) | not run live (on the VPN today); header selection covered by tests |
| | Two-target `stage_router` / escalation routing | not run live: only DeepSeek-V4-Flash is served; both shapes validate against the real binary's `--dry-run` |
| | Codex TUI through `ahub codex` | not run |
| | Claude through `ahub claude` (steps 4 to 6) | not run: needs an interactive Claude Code session |
| 2026-09-19 | Dedicated inference key `agent-hub-local` issued on the gateway (`omniroute api api-keys`, admin context), stored at `~/.agenthub/omniroute-agent-hub-local.key` (0600), `.agenthub/config.json` points `omniroute.api_key_file` at it | pass: `GET /models` 200, chat completion "pong" via DeepSeek-V4-Flash, `ahub doctor` key present; `AGENTHUB_SWITCHYARD_BIN=$HOME/.cargo/bin/switchyard-server` exported in `~/.config/shell/30-ai.sh` (checked: not in `~/.zshrc`; visible in a login shell), doctor finds switchyard 0.2.0 there |
| 2026-09-19 | Gateway choice with both candidates reachable | found: `ahub doctor` picked the off-campus URL while the internal URL was up (sequential probing, a stalled first request, and a non-5xx answer counting as healthy). Fixed: concurrent probes, list order decides, only 2xx is healthy. After the fix the dedicated key answered "pong" through the internal URL in 324 ms, `provider vllm` |
