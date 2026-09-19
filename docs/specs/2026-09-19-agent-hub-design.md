# agent-hub design spec

Date: 2026-09-19. Status: M1 to M5 merged; M6 implemented on `feat/m6-packaging-inference` (phase spec: issue #2 of the public repository). Version 0.1.0.
Owner: Young Joon Lee. Repo: STAIxBWLB/agent-hub.

Facts below are tagged **verified** (measured on 2026-09-19 on the owner's Mac) or
**inferred** (from docs or schema, not yet exercised).

## Context

- Goal: three coding agents on one machine (Claude Code, Codex, Kimi Code) plus a
  hub-owned local-LLM worker collaborate efficiently as peers in one project: real-time
  push messaging with busy-state coordination, role-based task split with cross review,
  subscription-quota relay, and task-aware model selection that can send bulk or
  low-stakes work to self-hosted models.
- Prior art: raysonmeng/agent-bridge v0.1.31 (Bun/TS, MIT). Verified on 2026-09-19: its
  v1 pair is two-party by construction (single Claude seat, `source: "claude" | "codex"`),
  its v3 rooms carry signals only, and a third agent can only join through the room
  broker. A room MCP adapter for Kimi was built and verified end to end
  (kept as a private memo). Decision: do not fork; reuse its
  protocol ideas (agentMessage-only forwarding, marker tiers, busy guard, turn watchdog).
- Native control surfaces, all verified on 2026-09-19:
  - Claude Code 2.1.277: channels. MCP server declares
    `capabilities.experimental['claude/channel'] = {}`, pushes
    `notifications/claude/channel` with `{content, meta}`; events queue while Claude is
    busy and are delivered as a group on the next turn. Loaded with
    `--dangerously-load-development-channels plugin:<name>@<marketplace>` (hidden flag,
    accepted by 2.1.277). Reply is an ordinary MCP tool.
  - Codex 0.154.0: `codex app-server --listen ws://127.0.0.1:<port>` spawns and answers
    (verified through agent-bridge's daemon). Schema v2 has `turn/start`,
    `turn/steer` (`threadId, expectedTurnId, input`), `turn/interrupt`,
    `thread/start` with `developerInstructions` and `dynamicTools`,
    `account/rateLimits/read`. TUI attaches with `--enable tui_app_server --remote <ws>`.
  - Kimi Code 0.43.1: `kimi acp` JSON-RPC over stdio. `initialize`, `session/new`
    (returns `configOptions` including a `model` select), `session/prompt` round trip
    (`stopReason: end_turn`), `session/update` stream (`agent_message_chunk`,
    `agent_thought_chunk`, `usage_update`), `session/cancel` (`stopReason: cancelled`),
    `session/load`. A second `session/prompt` during a turn fails with
    `turn.agent_busy`. Hooks exist (Stop, SessionStart, UserPromptSubmit, PreToolUse).
- Local serving (verified): OmniRoute 3.8.50 on a campus DGX H100 node, reachable on the
  internal network (VPN), `/v1/models` answers 401 without a key, Anthropic and Responses surfaces exist.
  vLLM serves `deepseek-ai/DeepSeek-V4-Flash-0731`; GLM-5.3-Flash and
  Qwen3.8-27B are planned (internal deployment plan).
  OpenCode 1.18.31 already has a `dgx-dsv4f` provider for this gateway.
- Routing policy engine: NVIDIA-NeMo/Switchyard v0.2.0 (Apache-2.0). Route types
  `llm_classifier`, `stage_router`, `escalation_router`; `auto` needs a source build
  until v0.3.0. Standalone `switchyard-server` proxies `/v1/chat/completions`,
  `/v1/messages`, `/v1/responses` and forwards to any `base_url` upstream. Stability:
  libsy Beta, server Demo ("not for production"), pre-1.0.
- Shared memory (verified 2026-09-19): claude-mem 13.25.1 keeps one store
  (`~/.claude-mem/claude-mem.db`, worker `127.0.0.1:37701`, loopback, no auth) already
  written by three platforms (`sdk_sessions.platform_source`: claude 1211, kimi 55,
  codex 41). Observations carry `project` (git-root basename), `agent_type`, `agent_id`,
  `metadata`. Kimi is captured by the `dot ai memory` transcript bridge (LaunchAgent
  watching `~/.kimi-code/sessions/**/wire.jsonl`); an ACP-driven `kimi acp` session was
  captured the same way. Worker HTTP API: `POST /api/sessions/init
  {contentSessionId, project, prompt, platformSource}`, `POST /api/sessions/observations
  {contentSessionId, platformSource, tool_name, tool_input, tool_response, cwd, agentId,
  agentType, tool_use_id}`, `POST /api/sessions/summarize`, `POST /api/sessions/session-end`,
  `GET /api/context/inject?projects=<chain>[&platformSource=]`, `POST /api/memory/save
  {text, title, project, metadata}`, `GET /api/search`, `GET /api/timeline`, `/api/corpus/*`.
  Each agent's SessionStart hook injects with its own `platformSource`, so today storage
  is shared but recall is siloed per platform (work project: 6.9 KB all platforms vs
  2.7 KB kimi-only). The Codex claude-mem plugin was reinstalled on 2026-09-19
  (`codex plugin add claude-mem@claude-mem-local`).
- Decisions inherited from the owner's infrastructure plan:
  no OmniRoute daemon on the Mac; subscription OAuths (Claude Max, ChatGPT, Kimi plan)
  are never pooled through a gateway; local models are for bulk and low-stakes work;
  PII never leaves the campus network (internal routing criteria).

## Decisions

1. Greenfield hub, not a fork. Bun + TypeScript, one repo, MIT.
2. Peers are equal. One `PeerAdapter` interface; three adapter kinds (channel,
   app-server, ACP) and one hub-native worker. Four default peers: `claude`, `codex`,
   `kimi`, `local`.
3. Kimi runs headless under ACP; the user talks to it through the hub console
   (`ahub say @kimi ...`, `ahub tail`). No Kimi TUI in the loop.
4. Local peer is a hub-native agent loop (model call + tools), not OpenCode. Reason:
   per-call model selection needs the hub to own the call. OpenCode ACP is kept as an
   optional fallback runtime behind the same adapter interface.
5. Model selection has three layers: L1 hub policy (which peer, which route),
   L2 Switchyard (which model per call for hub-owned traffic), L3 OmniRoute (keys,
   provider fallback, usage). Switchyard runs as a hub-managed sidecar on the Mac for the
   duration of a hub session only; it is not resident. The hub must work with L2 absent
   (fixed model ids straight to OmniRoute).
6. All hub-originated model traffic (local worker, internal summaries, triage) goes
   Switchyard -> OmniRoute. Subscription CLIs keep their own auth.
7. Quota relay hands open tasks to the `local` peer first, then waits for the window
   reset for judgment-heavy classes. Task-level escalation on verification failure.
8. Safety defaults: cross-peer text is framed as untrusted; permission prompts stay on
   unless `--unattended`; ports bind loopback only; Kimi ACP permission requests are
   relayed to the hub console. Loopback is not enough on its own (any web page can open a
   WebSocket to 127.0.0.1), so the control WS requires a per-run token and both hub
   servers refuse requests that carry an `Origin` header (amended in M1).
9. Single machine, one hub daemon per project directory. Cross-machine broker is out.
10. Shared memory reuses claude-mem as the single store; the hub never runs its own
    memory database. Native capture stays where it exists (Claude hooks, Codex plugin,
    Kimi transcript bridge); the hub captures only the local worker and adds
    cross-platform recall, task-scoped briefs and explicit shared notes. The bus still
    passes messages, never transcripts.

## Design

### Components

```
Claude Code TUI ── MCP stdio ── plugins/agent-hub (channel server) ──┐
Codex TUI ──── --remote ws://127.0.0.1:<proxy> ── app-server proxy ──┤ ahub daemon (Bun)
kimi acp (child, stdio) ── ACP client adapter ────────────────────────┤ bus · board · budget
local worker (in-process agent loop) ─────────────────────────────────┤ router L1
hub CLI / console ── control WS 127.0.0.1:<ctl> ──────────────────────┘
                                   │ model calls
                     switchyard-server sidecar (127.0.0.1, session-scoped)  L2
                                   │ base_url
                     OmniRoute: internal URL (VPN) / Access-protected public URL    L3
```

- `ahub daemon`: owns the message bus, peer registry and state machines, task board,
  budget coordinator, router L1, and the Codex proxy, ACP child and local worker. Survives
  Claude Code restarts. State in `.agenthub/state/` (pid, status.json, sqlite, logs).
- `plugins/agent-hub`: Claude Code plugin. Its MCP server is the channel; it reconnects to
  the daemon over the control WS with backoff, except after a close no retry can fix: 4000
  (another session attached as the same peer; the newest hello wins, whatever order the
  session-start recalls finish in), 4401, 4403, 4409 and 4426. It then
  stays detached and its tools report why. It exits when its host closes stdin. Exposes tools `hub_send`, `hub_inbox`
  (fallback drain), `hub_task_*`, `hub_review`, `hub_remember`, `hub_checkpoint`.
- Codex adapter: spawns `codex app-server --listen ws://127.0.0.1:<port>`, runs a
  transparent proxy the TUI attaches to (`--enable tui_app_server --remote`). The proxy never
  runs its own handshake: it learns the thread id from the TUI's `thread/start` /
  `thread/resume` responses and sends hub requests with negative JSON-RPC ids whose
  responses are swallowed. It shares one message per turn, the last `agentMessage` whose
  `phase` is not `commentary` (0.154.0 items carry `text` and `phase`, verified), emitted on
  `turn/completed`; injects via `turn/start` when idle and `turn/steer`
  for `important` messages while busy, registers hub tools through `dynamicTools` on
  `thread/start` and answers `item/tool/call`. Per-turn inactivity watchdog.
- Kimi adapter (ACP client): spawns `kimi acp`, `initialize`, `session/new` (or
  `session/load` for resume), injects via `session/prompt`, collects
  `agent_message_chunk` into one outbound message per turn, tracks busy from the
  in-flight prompt, queues on `turn.agent_busy`. Relays `session/request_permission`
  to the console (`ahub tail` shows the request, `ahub permit <id> <option>` answers, 120 s of
  silence cancels; `ahub up --unattended` auto-selects the agent's `allow_once` option). The
  watchdog sends `session/cancel` before forcing idle. `--model` maps to `kimi --model <alias> acp`
  (verified flag). Reusable for `opencode acp`.
- Local worker (amended in M3): a hub-native tool-calling loop over non-streaming
  `POST /chat/completions` with plain `fetch`, no SDK (the repo keeps zero runtime
  dependencies). Tools `read`, `write`, `edit`, `bash`, `git`, `hub_send` (`hub_task_*` with
  M4). Paths are realpath-scoped to cwd with a secrets denylist; `.git` and `.agenthub` are
  not writable. `write`, `edit`, `bash` and mutating `git` go through the console permission
  relay unless the hub runs `--unattended`. Everything that executes runs under seatbelt
  (`sandbox-exec`), attended or not: writes only under cwd, its real git dir (submodule,
  worktree) and temp; the home directory is unreadable except the project, toolchain dirs and
  `local.read_allow` (whatever a command reads can reach cloud-hosted peers through the
  answer); no reads of credential stores or denylisted files, no `.git/hooks` or `.git/config` writes, no network, loopback included, unless
  `local.bash_network`, scrubbed environment; without seatbelt there is no `bash`. 30 steps per
  turn, `reasoning_content` is never stored or shared. Model comes from `routing.toml`:
  a Switchyard route id, or `fixed_model` straight to OmniRoute.
- Console: `ahub tail` (live stream), `ahub say [@peer] <text>`, `ahub permit`, `ahub doctor`, `ahub board`,
  `ahub route explain <task>`, `ahub budget`, `ahub status`, `ahub logs`, `ahub kill`.
- Launchers: `ahub up`, `ahub claude [--safe|--unattended] [--via dgx]`,
  `ahub codex [--new] [--profile dgx]`, `ahub kimi [--model <alias>]`, `ahub local`.
  Launchers inject only the flags the hub owns and refuse user-supplied duplicates.
  M1 accepts `--safe` and `--new` as explicit spellings of the default; `--via` and
  `--profile dgx` arrive with M3. Peers are registered lazily, on first attach, so a peer
  that is never launched accumulates no queue.

### Message model

```ts
interface Envelope {
  id: string; trace: string; hop: number;
  from: PeerId; to?: PeerId[];          // absent = broadcast
  kind: "chat" | "task" | "review" | "status" | "budget" | "presence";
  priority: "important" | "status" | "fyi";
  body: string;                          // agent conclusions only, never tool noise
  refs?: { repo?: string; branch?: string; commit?: string; paths?: string[]; task?: string };
  ts: number;
}
```

- Never delivered back to `from`; `hop` capped at 3. A message produced by a turn the hub
  injected inherits that envelope's `trace` with `hop + 1` (Claude passes `reply_to` on
  `hub_send`); a turn the user started begins a fresh trace at hop 0. Envelopes over the
  cap are dropped for peers but still shown on the console.
- One queue rule per peer (amended in M2): the whole queue goes out as one delivery, a single
  envelope or a digest of up to 10, when the peer is idle and the queue holds an `important`
  envelope, or `batch_max` (3) envelopes, or its oldest one has waited `batch_ms` (15 s).
  `important` to a busy Codex is steered instead. `fyi` is never delivered to a peer: console
  and log now, the task board from M4. A digest is one prompt (Codex, Kimi) or one channel
  notification (`meta.source = hub-digest`, senders in `meta.sources`); its reply answers the
  highest-hop item, so neither a digest nor a steer can reset the hop cap. Important items lead
  the digest; an envelope that failed before is retried alone. The control WS hello carries a
  wire version (2 since digests): a plugin bundle older than the daemon is refused with close
  code 4426 rather than dropping digests silently.
- Markers `[IMPORTANT]`, `[STATUS]`, `[FYI]` at the start of agent text, `hub_send` or `ahub say`
  set the priority and are stripped. Default `status` for agents, `important` for the console
  user (a human typing `ahub say` should not wait out the batch window).
- Every inbound cross-peer body is wrapped as untrusted (Claude: `<channel>` tag with
  `meta.source=<peer>`; Codex and Kimi: a fixed prefix line plus a standing instruction
  injected once per session).
- The fixed prefix includes envelope `kind`; Claude uses `meta.kind` for a single
  item and includes each item's kind in digest headers. Only `hub` / `presence`
  items are reference-only recall. Hub `task`, `review`, and `budget` items are
  workflow events handled through the board and the recipient's assigned role,
  within existing user authorization. Sender and kind grant no higher authority.
  Reply-parent selection skips only hub presence items, retaining workflow hops.

### Peer state and delivery

| State | Enter | Delivery rule |
| --- | --- | --- |
| idle | turn completed / prompt returned | inject now |
| busy | turn started / prompt in flight | Claude: push (Claude Code queues); Codex: steer if important else queue; Kimi/local: queue |
| paused | budget gate (M5) or user `ahub pause` / `ahub resume`; a bus-level flag over the adapter state | queue, never steer; reassign open tasks (M5) |
| offline | adapter disconnected | queue |

Every queue is bounded (`queue_cap`, default 200): on overflow the oldest non-`important`
envelope is dropped and reported on the console.

Inactivity watchdog per busy turn (default 300 s) forces `idle` after cancelling the silent
turn (`session/cancel` for ACP, `turn/interrupt` for Codex); a late result of the cancelled
turn is discarded. Queues are drained in order on `idle`. Delivery is at-least-once with
idempotency by `id`: a failed delivery returns to the queue head and is retried after 1 s, and
after 3 failures it is reported as undeliverable on the console so one envelope cannot block a
peer. Peer ids claimed over the control WS must not be `user` or a hub-managed adapter id.

### Task board and roles

- sqlite table `tasks` (`bun:sqlite`, `.agenthub/state/hub.db`, survives `ahub kill`): `id, title,
  detail, class, owner, reviewer, state, refs, signals, rejections, history`.
- `class`: `plan | implement | bulk_edit | test | review | summarize | triage`.
- `state` (amended in M4): `proposed -> in_progress -> in_review -> approved | changes_requested`,
  `changes_requested -> in_progress`. `accept` and `done` are transitions recorded in `history`,
  not states: they carried no behaviour. A verdict is only accepted on a task in review.
- Roles in `.agenthub/config.json`; default `claude: [planner, reviewer]`,
  `codex: [implementer]`, `kimi: [implementer, verifier]`, `local: [implementer, verifier]`.
- Flow: `hub_task_propose` creates a card and the hub assigns owner and reviewer (L1);
  the owner accepts or declines (decline moves to the next candidate); `hub_task_done` sends a
  `review` envelope with summary and refs to the reviewer, or approves directly when there
  is none; `hub_review` returns the verdict. `changes_requested` reopens as `in_progress`; two
  in a row escalate the task to the next attached peer in `escalate_to`, with its review
  notes (`ahub task escalate` does it by hand). Only the owner, the reviewer or the console
  user may act on a task.
- Tools on every peer (amended in M4): one implementation. The bundled MCP server of the
  Claude plugin has a tools-only mode (`AGENTHUB_MODE=tools`, control WS role `tools`: acts for
  a peer, never a delivery target). Kimi gets it through ACP `session/new` `mcpServers`
  (verified live), Codex through `-c mcp_servers.agent-hub.*` on the app-server the hub
  spawns (verified live with a real Codex turn: tools called without an approval prompt under
  `approval_mode = "approve"`), `local`
  natively. This replaces Codex `dynamicTools`: no rewriting of proxied TUI traffic.
- Role contract: Claude in the plugin `instructions`, Codex, Kimi and `local` with the
  standing instruction of their first delivery, all of them in the `AGENT_HUB` marker
  blocks; `roles` in `.agenthub/config.json` is the source. Codex `developerInstructions`
  injection is dropped for the same reason as `dynamicTools`.
- PII (amended in M4): a task matching `signals.pii_patterns` is owned by `local` or by
  nobody; its envelopes are `private` (console tail and `hub.log` print a stub), lists show
  `[pii]` to everyone but `local`, `ahub task show` is the one place the console reads it; the
  reviewer is the console user; `local` answers such a turn to the console only, keeps it out
  of its history, refuses it when the only gateway is off campus (Cloudflare Access), and
  nothing reaches claude-mem (no brief, no note, no capture), because claude-mem's observer is
  a cloud model (verified: `/api/health` reports `ai.provider: claude`).

### Routing (three layers)

L1, hub policy, `.agenthub/routing.toml`, hot-reloaded:

```toml
[signals]
pii_patterns = ["\\b\\d{6}-\\d{7}\\b"]                    # PII => local_only; add your own
long_context_tokens = 120000

[classes.implement]
peers = ["codex", "kimi", "local"]      # preference order among idle, unpaused peers
route = "sy/coding"                     # Switchyard route id for the local worker
escalate_to = ["kimi", "claude"]        # on verification failure

[classes.bulk_edit]
peers = ["local", "kimi"]
route = "sy/fast"

[classes.review]
peers = ["claude", "codex"]
route = "sy/review"
local_allowed = false                   # never route judgment classes to local

[classes.summarize]
peers = ["local"]
route = "sy/fast"

[constraints]
pii = "local_only"                      # hard: on-prem models only
budget_paused = "skip_peer"
```

L2, Switchyard sidecar (amended in M3, verified against `switchyard-server` 0.2.0 built with
`cargo install --locked switchyard-server`; there is no prebuilt macOS binary).
`routing.toml` carries `[targets.*]` and `[routes."sy/..."]` in Switchyard's own table
shapes; the hub copies them into `.agenthub/state/switchyard.toml` (0600, removed on stop)
and adds `schema_version`, one `[llm_clients.gateway]` (`format = "openai_chat"`, the live
OmniRoute URL, `api_key_env = "OMNIROUTE_API_KEY"`, Access `extra_headers` only for an
Access host), `llm_client` on targets and the public `id` on routes. The key reaches the
sidecar through its environment only. Verified facts: the binary rejects `timeout_ms` on
`llm_clients`; there is no `escalation_router` type, escalation is `llm_classifier` with
`mode = "escalation"` and a mandatory `[routes.<name>.escalation]` table; the default bind is
`0.0.0.0`, so the hub always passes `--host 127.0.0.1`; a route is selected by sending its id
as `model`; the chosen target returns in `x-model-router-selected-model`; tool calls pass
through. The config goes through `--dry-run` first. The sidecar starts on the first
hub-owned model call and stops with the hub. A missing binary, a rejected config, failed
health, an exit or a failed call turns L2 off for the hub run with one log line and the
worker calls `fixed_model` on OmniRoute directly. Until a second model (GLM-5.3-Flash) is served the
shipped routes are `passthrough` to DeepSeek-V4-Flash; the `stage_router` and escalation
blocks ship commented out and validate against the real binary.

L3, OmniRoute (amended in M3): candidates from `omniroute.urls` (for the owner: the internal
URL over VPN, then a public URL behind Cloudflare Access; the tool ships with none)
are probed at the same time with `GET <base>/models`; the most preferred one that answers 2xx
within 4 s wins (a Cloudflare Access 403 is not healthy);
OmniRoute 3.8.50 has `/healthz` and `/api/health` but no `/health` (verified). Key from
`OMNIROUTE_API_KEY` or `omniroute.api_key_file`; the two Cloudflare Access headers, read from
files, go only to hosts in `omniroute.access_hosts`. `omniroute tokens create` issues CLI
access tokens, not inference credentials. Inference keys come from `omniroute api api-keys`
(admin context): the owner issued `agent-hub-local` on 2026-09-19 and `omniroute.api_key_file`
points at it, so the dashboard separates the hub's usage.

Assignment is a pure function of `routing.toml`, the task's signals and the peers' bus states
(idle before busy, paused, offline and detached skipped, `local_allowed`, `long_context =
"skip_local"`, `pii = "local_only"`); `ahub route explain <id | --class <c> <title>>` runs the
same function and prints its trace: signals, every candidate with the reason it was kept
or skipped, owner, reviewer and route. `local` uses the class's `route` / `fixed_model` for a
task turn and `[local]` otherwise. Verification failure (tests fail, review `changes_requested` twice) escalates
the task to the next peer in `escalate_to`; Switchyard handles per-call escalation
inside a peer.

### Budget relay

- Sources (amended in M5). Codex: `account/rateLimits/read` sent through the TUI's
  connection with a hub id, `account/rateLimits/updated` forwarded from the proxy, and a
  turn refused with `usageLimitExceeded` as a hard limit (verified live: the owner's account
  answered `primary {usedPercent: 100, windowDurationMins: 10080, resetsAt}`). Claude: no
  OAuth probe. Claude Code passes `rate_limits.five_hour` / `seven_day` (`used_percentage`,
  `resets_at`) to the status line command (verified in the input this Mac's HUD script
  reads); `ahub claude` puts a tee in front of the user's status line command through
  `--settings` for that session, records the limits in `.agenthub/state/claude-usage.json`
  and runs the original command unchanged. `~/.claude/settings.json` is never edited; a
  user-supplied `--settings` wins and turns the tee off. The `--settings` injection is
  verified live (2026-09-19: `claude-usage.json` appears within seconds, the wrapped HUD
  renders unchanged, `ahub budget` shows both windows). Kimi: `usage_update` tokens over a
  rolling 5 h against `budget.kimi_tokens_5h` (off by default). Verified live on kimi
  2.0.1: one update per turn, payload `{"sessionUpdate":"usage_update","used":<tokens>,
  "size":<context window>}`; `used` is the session's context occupancy against `size`
  (1M), not billed quota; the parser matches it through the `used` fallback and it grows
  monotonically within a session (a compaction reads as a new session). `ahub budget set`
  feeds a reading by hand. `local` has no quota and is never paused.
- Gate at `budget.gate` (default 0.9) on any fresh window; readings older than
  `budget.stale_min` are ignored. Checkpoint first, pause second: the peer gets one
  important envelope asking it to write `.agenthub/checkpoint.md` and call `hub_checkpoint`,
  the hub waits up to `budget.checkpoint_timeout_s`, then pauses it; a hard-limited peer is
  paused at once. Its open tasks are reassigned, `local` first and then the class list,
  through the M4 constraints, with the checkpoint summary (or the peer's platform block
  from claude-mem) and the task brief in the envelope; tasks it was reviewing get another
  reviewer; PII tasks never get handoff text. One open record per peer in `hub.db`:
  repeated readings do nothing, a restart keeps the pause and finishes an interrupted
  handoff. Resume at `resetsAt` plus a minute, or on a fresh reading under `gate - 0.1`,
  with one important envelope from the hub listing what moved; this replaces the per-peer
  resume calls and the `hub_ack_resume` tool; the notice is queued before the peer is
  released, so it leads the first delivery. Moved tasks stay with their new owners. A manual
  `ahub pause` is never lifted by the coordinator; `ahub resume` does not override a budget
  pause, `ahub budget resume <peer>` does, and the coordinator then leaves that peer alone
  until the window that paused it has reset. A handoff waits until another peer is attached
  (right after a restart nobody is), readings keep their own timestamp, and a window whose
  reset time has passed no longer counts. A peer whose window reset while the hub was down is
  not paused again, and still gets the resume envelope once it attaches. With no status line
  of the user's own to wrap, the tee prints a short usage line instead of a blank one.

### Shared memory (claude-mem)

- Capture. Claude: native plugin hooks. Codex: claude-mem Codex plugin. Kimi: `dot ai
  memory` transcript bridge (covers ACP sessions, verified). Local worker: the hub acts
  as the hook client: `sessions/init` on worker start (`platformSource: "agent-hub"`,
  `agentId: "local"`, `project` = git-root basename of the hub cwd), one
  `sessions/observations` per tool call (mirrors `CLAUDE_MEM_SKIP_TOOLS`; a call that names
  a denylisted path is not posted at all), `sessions/summarize` at the end of a turn that used
  tools, `session-end` on stop (awaited, the hub exits right after). Verified live: a
  `summarize` that carries `agentId` is answered `skipped: subagent_context`, so only
  observations carry `agentId = local`. Fail-open: a down worker never blocks a turn; events
  are dropped with one log line.
- Session-start cross recall (amended in M2). Before a peer can receive anything the hub
  fetches `context/inject?projects=<chain>` (chain = git superprojects down to this repo,
  comma-separated, primary last; verified) and trims it to `memory.inject_tokens` (default
  2000, counted as 3 characters per token, cut at a line boundary). Kimi and the local worker
  get all platforms in one call. Claude and Codex already get their own platform from their
  own hooks, so they get one filtered call per other platform, legend stripped, the token
  budget split evenly between the platforms that returned something. The block is
  not a message of its own, which would cost a turn just to be acknowledged: it rides as the
  first item (`from: hub`) of the peer's first delivery. Once per peer per hub run, so a
  restarted peer session does not get it again. A `# claude-mem status` page (unknown project,
  empty filter; verified) or a down worker means no block.
- Task brief on handoff. When a task is assigned, escalated or reassigned by the budget
  relay, the hub runs `search(query = title + refs.paths, project, limit 10)` and
  `timeline(anchor = top hit)`, and attaches a brief of at most `memory.brief_items`
  (default 8) lines `#id time type title` plus one facts line to the task envelope.
  The receiver calls `get_observations([ids])` only for the ones it needs (layered
  workflow). Per peer, the hub keeps a `seen_ids` set for the session so a brief never
  repeats an observation already delivered to that peer.
- Explicit shared notes. Tool `hub_remember(text, title?, tags?)` on every adapter and
  in the console (`ahub remember`) posts `memory/save` with
  `metadata: {peer, task, kind: decision | finding | contract}` (payload verified live). The
  hub auto-saves the transitions that carry content, `done`, the review verdict and
  escalation (amended in M4: `proposed` and `accepted` would add two empty memories per
  task), and checkpoint summaries (M5), so handoff history is recallable next session.
- Budget relay (amended in M5). The hub owns a claude-mem session id only for `local`, so
  `sessions/summarize` cannot be called for Claude, Codex or Kimi. The handoff context is
  the peer's own checkpoint summary, else its platform block from `context/inject`, and it
  travels with the task brief in the task envelope; `.agenthub/checkpoint.md` remains as the
  file the peer writes.
- Efficiency rules. Index first (`search`), then `timeline`, then details; injection
  and briefs are token-capped; project chain filtering only; tool_input containing
  denylisted paths is never posted; no transcript or full observation bodies cross the
  bus.
- `ahub ask` (added after 0.1.0). Retrieval first, model second, read-only. Evidence is gathered from the task
  board, claude-mem (index search plus the timeline around the top hit) and this run's hub log, capped at 6000
  characters; the hub's model (`sy/fast`) answers from that list only and has to cite its ids, and an answer that
  cites nothing from the list is dropped. No evidence means no model call; no model means the evidence is the result.
  Every row is capped and rows that match the question lead, so one long row cannot empty the list. Every cited id
  has to be in the list: one invented id drops the answer. PII task text is evidence only when an on-campus model is
  positively confirmed (a gateway answered, it is not behind Access, and no sidecar points off campus); otherwise
  the row stays as a `[pii]` stub so counts are right. A question that itself carries PII skips the memory worker.
  Such results are marked and never saved. `--remember` saves a real answer as a model-written note attributed to
  the hub, under a title later asks exclude from their evidence; "nothing found" is never saved. The call is
  interactive: its own 45 s clock, outside the backoff that protects deliveries. Console only. claude-mem's corpus endpoints were checked
  (verified 2026-09-19: `GET /api/corpus` lists none, and a corpus has to be built and primed with a model session
  of its own), so search plus timeline stays the retrieval path and the hub still owns no store.
- Config: `memory.enabled` (default true when the worker answers `/api/health`),
  `memory.worker_url` (default from `~/.claude-mem/settings.json`
  `CLAUDE_MEM_WORKER_PORT`), `memory.inject_tokens`, `memory.brief_items`,
  `memory.platform_source` (default `agent-hub`).
- Prerequisites: claude-mem worker running; Codex claude-mem plugin installed; `dot ai
  memory status` green for kimi. `ahub doctor` reports all three.

### Safety

- Untrusted framing on all cross-peer text; standing instruction once per session.
- `ahub claude` and `ahub codex` keep normal permission prompts. `--unattended` opts into
  `--dangerously-skip-permissions` (Claude) and `--dangerously-bypass-approvals-and-sandbox`
  (Codex 0.154.0 documents this flag, not `--yolo`) and prints a warning.
- Kimi and local tools: cwd-scoped, secrets denylist (a secrets directory, `.env*`, keys).
- Loopback binds only; ports per project from a registry (base 4600, stride 10).
- No subscription OAuth through any gateway.

### Configuration and state

- `.agenthub/config.json` (roles, ports, filter tiers, watchdog), `.agenthub/routing.toml`.
- `.agenthub/state/` gitignored: `hub.pid`, `status.json`, `control-token` (0600, per run),
  `hub.db` (tasks, messages, budget; from M4), `hub.log`, `switchyard.toml`, `checkpoint.md`.
- Env: `AGENTHUB_STATE_DIR`, `AGENTHUB_OMNIROUTE_URL`, `OMNIROUTE_API_KEY`,
  `AGENTHUB_SWITCHYARD_BIN`, `AGENTHUB_UNATTENDED`.

### Testing

- Unit: bus routing, priority batching, state machines, L1 policy evaluation, envelope
  framing, marker parsing.
- Fakes: fake ACP server, fake app-server (ws), fake MCP client, fake OpenAI-compatible
  model server. Integration tests spawn the daemon against fakes.
- Live smoke (manual, documented): trio chat, steer during a Codex turn, Kimi
  busy-queue drain, local worker completes a bulk edit through Switchyard -> OmniRoute
  with `x-omniroute-provider` visible, budget pause and resume with a mocked probe.
- One command gates everything: `scripts/check.sh` (typecheck, unit, integration).

## Changes

New repo layout:

```
src/hub/            daemon, bus, peer-registry, state-machines, board, budget, router
src/adapters/       claude-channel.ts, codex-appserver.ts, acp.ts, local-worker.ts
src/switchyard/     config generator, sidecar lifecycle, health
src/memory/         claude-mem worker client, capture for the local worker, recall (inject, brief), remember
src/cli/            up, claude, codex, kimi, local, say, tail, board, route, budget, status, logs, kill, init
plugins/agent-hub/  .claude-plugin/plugin.json, .mcp.json, server bundle, hooks (SessionStart health, Stop announce)
.claude-plugin/marketplace.json
templates/          CLAUDE.md and AGENTS.md marker blocks, routing.toml default, config.json default
scripts/            check.sh, build.mjs, smoke-*.ts
docs/specs/         this file
CLAUDE.md, REVIEW.md
```

## Acceptance criteria

1. `ahub up && ahub claude && ahub codex --new && ahub kimi` in one project: a message from
   any peer reaches the other three within 2 s when idle, with untrusted framing.
2. A message sent while Codex is mid-turn arrives as `turn/steer` if `important`, else
   after `turn/completed`; while Kimi is mid-prompt it is queued and drained on
   `end_turn`, never lost.
3. `[STATUS]` messages from one peer are batched into one digest per recipient.
4. A task proposed by Claude, accepted by Codex, marked done, is auto-routed to the
   reviewer; `changes_requested` twice escalates per `routing.toml`.
5. `ahub local` completes a `bulk_edit` task; OmniRoute log shows the request with the
   per-peer token and `x-omniroute-provider: vllm`; `ahub route explain` shows the
   chosen route.
6. With Switchyard absent, the local worker still works via `fixed_model`.
7. A PII-flagged task never leaves the `local` peer (test with a fake pattern).
8. Mocked Codex quota at 0.95 pauses Codex, checkpoints, reassigns its open
   `implement` task to `local`, and resumes Codex after the mocked reset.
9. `scripts/check.sh` exits 0; live smoke checklist recorded in `docs/smoke.md`.
10. Default launches keep permission prompts; `--unattended` prints the warning.
11. A local-worker task produces observations in claude-mem with
    `platform_source = agent-hub` and `agent_id = local`; `search` from any peer finds
    them without a `platformSource` filter.
12. Starting `ahub kimi` after a Claude session in the same project injects a context
    block that includes at least one Claude-platform observation, capped at
    `memory.inject_tokens`; starting a second Kimi session does not re-inject it.
13. Assigning a task whose title matches an earlier observation attaches a brief with
    that observation id; reassigning the same task to the same peer does not repeat
    ids already delivered.
14. `hub_remember` from Codex creates a `memory/save` note whose metadata carries
    `peer = codex` and the task id; the budget-relay resume prompt for the receiving
    peer contains the paused peer's session summary.
15. With the claude-mem worker stopped, every acceptance criterion 1 to 10 still passes
    and `ahub doctor` reports memory as unavailable.

## Tasks

M1 messaging core and three adapters
- [x] Repo scaffold: Bun, TS strict, `scripts/check.sh`, `CLAUDE.md`, `REVIEW.md`, labels
- [x] Bus, envelope, peer registry, state machines, control WS, state dir, port registry
- [x] Claude channel plugin: capability, push, `hub_send`, `hub_inbox`, reconnect
- [x] Codex adapter: spawn, proxy, agentMessage intercept, `turn/start`, watchdog
- [x] ACP adapter: spawn `kimi acp`, session lifecycle, prompt, chunk aggregation
- [x] CLI `up/claude/codex/kimi/say/tail/status/logs/kill`, `ahub init` marker blocks
- [x] Fakes plus unit and integration tests
- [ ] Live trio chat smoke (`docs/smoke.md`): Kimi leg passed; Codex reply leg blocked by the account usage limit on 2026-09-19; Claude leg needs an interactive session
- [x] claude-mem worker client (`src/memory/`), `ahub doctor` memory check, fake worker for tests

M2 coordination
- [x] Priority tiers and status batching, marker parsing
- [x] Codex `turn/steer` for important while busy (plain busy queue and drain for every peer shipped in M1: without it a second Kimi prompt fails with `turn.agent_busy`)
- [x] Paused and offline queues, idempotent delivery, drop rules
- [x] Session-start cross-platform recall (token cap, once per peer per hub run)
- [x] Live `turn/steer` against real Codex (2026-09-19, after the weekly window reset)

M3 local worker and routing L2/L3
- [x] Local worker agent loop with cwd-scoped tools, secrets denylist, approvals and seatbelt sandbox
- [x] OmniRoute client with Cloudflare Access headers (per-peer inference key: pending an owner-issued key)
- [x] Switchyard sidecar: config generation, lifecycle, health, fallback to fixed model
- [x] `ahub local`, smoke through OmniRoute with provider header check, and through the real sidecar
- [x] Local worker capture into claude-mem (`sessions/init`, `observations`, `summarize`, `session-end`, skip list)

M4 task board, roles, routing L1
- [x] sqlite board, `hub_task_*` and `hub_review` tools on all adapters
- [x] Role contract injection per native surface
- [x] `routing.toml` loader, signals (PII, context length, quota), `ahub route explain`
- [x] Review handoff and task-level escalation
- [x] Task brief on handoff (search + timeline, `seen_ids`), `hub_remember` tool and console command, auto-saved board transitions
- [x] Live: Codex calling hub tools in a real turn (2026-09-19)
- [ ] Live: Claude plugin task tools and digests in a real interactive session

M5 budget relay
- [x] Quota sources (Codex native, Claude status line, Kimi tokens, manual), gate, pause, checkpoint
- [x] Reassignment to local, one resume envelope, idempotency and restart recovery
- [x] Handoff context (checkpoint summary or memory block) plus task briefs in the task envelope
- [ ] Live: the Claude status line tee in an interactive session; a real pause driven by Codex's own numbers with a TUI attached

M6 internal inference, packaging
- [x] Status digests and triage through `sy/fast` (amended: optional and fail-open with a backoff. Only plain status
      chatter over a threshold is condensed, into one item from `digest` that keeps every sender, envelope id and the
      highest hop; important, task, review, budget, preface and private items are never touched. A task proposed
      without a class is labelled from the closed class list, a PII task only when the gateway is on campus. The
      model's output is capped text framed as untrusted or a validated enum, never a route, peer id or instruction.)
- [x] Packaging (amended: no compiled binary, because the daemon re-spawns itself and five places resolve assets
      relative to the source tree; the package ships the tree and installs from GitHub with Bun, verified:
      `bun add -g github:STAIxBWLB/agent-hub`. `package.json` is the one version, stamped into the plugin manifest
      and the MCP server and checked by the gate. `ahub setup` installs or updates the Claude plugin from the
      package after asking. CI runs the gate on Ubuntu and macOS; a `v*` tag matching `package.json` cuts a release.
      npm publish and brew are follow-ups.)
- [x] docs: `docs/quickstart.md`, `docs/security.md`, `docs/smoke.md`, `CONTRIBUTING.md`, `CHANGELOG.md`

## npm distribution amendment (issue #4)

- Publish `@staix/agent-hub` under the `staix` npm organization; installed commands
  remain `ahub` and `agent-hub`. GitHub installation remains available.
- Ship the source tree and relative runtime assets. The gate checks the actual
  `npm pack --dry-run` file list, including hidden marketplace and plugin manifests.
- Use a plain-JavaScript `src/cli/main.js` bin entrypoint that checks for Bun before
  dynamically importing `main.ts`. This refines the issue's proposed guard location:
  a guard in `main.ts` cannot precede its static Bun-only imports, and older Node
  versions cannot load the TypeScript file at all. No preinstall hook or Node build.
- The release workflow validates the tag/version, runs the gate, then publishes
  publicly with provenance and `NPM_TOKEN`. The token belongs to an authorized
  organization member. Organization conversion and credential provisioning are
  owner operations; this implementation does not perform them.
- First registry publication, provenance readback, and real Claude setup from the
  registry installation must be verified after the next approved release tag.

## Out of scope

- Cross-machine broker or rooms, Windows. The web UI was outside the original six milestones; issue #6 adds the local dashboard described below.
- OmniRoute daemon on the Mac; pooling subscription OAuth through any gateway.
- Gemini CLI and OpenCode adapters beyond the ACP fallback note.
- Switchyard `auto` route until v0.3.0 ships.
- Running Claude Code itself on a local model (depends on the Anthropic-to-chat
  translation check in the OmniRoute plan v1, Phase 0).
- A hub-owned memory store, cmem.ai cloud sync, automatic corpus building (a project
  corpus for `ahub ask` is an optional M6 item), and any change to the vault LEARN loop.

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude channels are research preview; flag or protocol may change | Adapter isolated in one file; plugin version pinned to a Claude Code range; `hub_inbox` fallback |
| `switchyard-server` is Demo grade, pre-1.0 | Session-scoped sidecar, pinned version, L1 `fixed_model` fallback |
| Anthropic-to-chat translation drops `tool_use` | Claude never runs on local models in this design |
| Local worker executes untrusted room text | Untrusted framing, cwd scope, denylist, no `--unattended` by default |
| Steering a Codex turn changes its plan mid-flight | Only `important` steers; default tier is `status` |
| Kimi ACP has no quota API | Token-based soft limit only; documented |
| claude-mem worker API is internal and unversioned for third-party clients | Client isolated in `src/memory/`, pinned to a plugin version range, fail-open everywhere, contract test against a fake worker plus one live smoke |


## Post-milestone amendment: local dashboard (issue #6)

Owner instruction to implement issue #6 approves its local, read-mostly dashboard.
The session/origin model is defined in `docs/security.md`, written before the code.
`ahub ui` lazily opens an ephemeral loopback listener and exchanges a single-use
fragment ticket for an HttpOnly, SameSite=Strict browser session. The control link
retains its blanket Origin refusal. The browser receives no control token.

One static HTML file, without a build step or runtime dependency, polls public
snapshots once per second. The latest 200 redacted bus events are retained only
once the listener starts. The API exposes only permission answers, peer
pause/resume, console messages, task proposal and assignment. All task changes
use `Tasks`; budget pauses keep the terminal's override requirement.

Local-worker permission titles may contain PII file contents or commands, so the
page shows a terminal-only stub and offers denial only. Allowing those requests
requires reading `ahub tail` and answering with `ahub permit`. Other agent
approvals offer their original options. Task refs/history and checkpoint summaries
are omitted from browser snapshots. Private envelope bodies retain the tail stub.
