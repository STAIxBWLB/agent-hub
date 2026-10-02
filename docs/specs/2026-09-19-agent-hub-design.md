# agent-hub design spec

Date: 2026-09-19. Status: M1 to M5 merged; M6 implemented on `feat/m6-packaging-inference` (phase spec: issue #2 of the first public repository, archived). Version 0.1.0.
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
  the daemon over the control WS with backoff, except after a close no retry can fix: 4401,
  4403, 4409 and 4426. It then stays detached and its tools report why. Close 4000 (another
  session attached as the same peer; the newest hello wins, whatever order the session-start
  recalls finish in) is not one of them (amended, issue #30): that session stands by, and
  reconnects only once `status.json` reports the peer offline and not `claiming`, so it never
  evicts the session holding the id - nor one whose hello is still finishing its preface - and
  the two cannot trade it back and forth. The daemon writes the status file at the claim, before
  the preface, so the arriving session is visible for that window. Its tools say it is standing by
  until it has the peer again. It exits when its host closes stdin. Exposes tools `hub_send`,
  `hub_inbox` (fallback drain), `hub_task_*`, `hub_review`, `hub_remember`, `hub_checkpoint`.
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
  prompt names what will run, not only the tool (amended, issue #31): the request's `rawInput`
  when it has one, otherwise what the `tool_call` update announced for the same `toolCallId`.
  A payload that cannot be resolved either way is titled as unresolved and its `allow_always`
  option is withheld, so a blind click cannot grant every later call of the session. The
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
- A reply is addressed, not broadcast (amended after the 0.6.1 measurement run, issue #29).
  An adapter answering a delivery addresses `to` at the senders it answers (`replyAudience`);
  a reply that names no target inherits the sender of the envelope it answers. `user` and `hub`
  are not peers, so an answer to the console or to a hub workflow envelope reaches the console
  and the log and costs no peer a turn - stakeholders already hear about a task through the
  hub's own `task` and `review` envelopes. A peer that wants every peer to hear it leaves `to`
  empty on purpose. Before this, one directed question cost every attached peer a turn, and a
  Pi task report woke the local worker into unsolicited work. A delivery that was condensed is
  answered by what it stands for, not by what the peer was handed: the bus maps the reserved
  `digest` sender back to the senders of the originals it kept next to `out`.
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
- A hub-native peer (Pi, the local worker) may not rate its own urgency: `important` it claims
  for itself is capped to `status` unless the delivery it answers held an `important` envelope
  addressed to it. The whole delivery is checked, not `replyParent` alone - an important request
  can share a hop with a later status item. A message that answers nothing is always `status`.
  Peers driven by their own session keep the priority they claim.
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
  block of `AGENTS.md` (`ahub init` writes no `CLAUDE.md`: one hides `AGENTS.md` from
  Claude Code); `roles` in `.agenthub/config.json` is the source. Codex `developerInstructions`
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

### Execution budgets (issue #102)

- Execution budgets are opt-in records in `hub.db`, separate from provider quota-window budgets. Configure and inspect them with `ahub budget execution configure <config.json>`, `ahub budget execution status [id]`, and `ahub budget execution disable <id>`. The JSON names a stable `id`, `kind` (`task` or `run`), eligible `peers`, optional `taskId` for task scope, and `limits` keyed by `model_calls`, `tool_calls`, `elapsed_ms`, or `tokens`.
- A run budget configuration can be saved as JSON and passed to `configure`, for example `{"id":"run:cooperbench-1","kind":"run","peers":["pi","local"],"limits":{"model_calls":40,"tool_calls":32,"elapsed_ms":180000}}`. A task configuration uses `{"id":"task:42","kind":"task","taskId":42,"peers":["pi","local"],"limits":{"model_calls":8,"tool_calls":12}}`. `status` reports scope, eligible peers, limits, measured usage, and the remaining amount or exhaustion reason.
- Task scope applies only when that task appears in the delivery's `refs.task`; run scope applies across all eligible peers' turns until disabled. If a digest carries several matching tasks, all applicable task scopes and each run scope are admitted atomically. Configuration and counters survive new turns and daemon restarts. Reconfiguring the same id changes limits/eligible peers without resetting consumed usage; a scope id cannot be rebound to a different task or scope kind.
- `model_calls` counts each admitted provider request. `tool_calls` counts each admitted tool execution (including Pi user shell commands). These reservations happen before requests or effects. The existing `pi.max_steps` remains a per-agent-turn tool execution ceiling; `local.max_steps` remains a per-agent-turn model-loop iteration ceiling. Neither legacy default is reinterpreted or disabled.
- `elapsed_ms` starts when the budget is configured and is checked at every model/tool admission. `tokens` is explicit only when usage telemetry is available; because a future request's token cost is not known before sending it, a configured token cap without a safe reservation estimate stops the next model request with `unknown_usage`, rather than treating missing usage as zero.
- Exhaustion ends the delivery without automatic replay. A stop before side effects is reported as `needs_review`; after side effects it reports that partial work may exist and also requires review. Provider quota interruption, budget exhaustion, legacy step caps, and successful native completion remain distinct reasons.
- Only `pi` and `local` are currently accepted as budgeted peers because they expose a pre-request and pre-tool admission point. Native Claude/Codex/Kimi limits are rejected until their adapters can enforce the same contract. With no execution budget configured, the new meter has no effect.

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
  `metadata: {peer, task, kind: decision | finding | contract | fail}` (payload verified live; `fail` and sharing with running peers amended in issue #68). The
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
templates/          AGENTS.md marker block, routing.toml default, config.json default
scripts/            check.sh, build.mjs, smoke-*.ts
docs/specs/         this file
AGENTS.md, REVIEW.md
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
- [x] Live trio chat smoke (`docs/smoke.md`): Kimi, Codex and Claude interactive legs passed on 2026-09-19; the later four-peer broadcast also passed
- [x] claude-mem worker client (`src/memory/`), `ahub doctor` memory check, fake worker for tests

M2 coordination
- [x] Priority tiers and status batching, marker parsing
- [x] Codex `turn/steer` for important while busy (plain busy queue and drain for every peer shipped in M1: without it a second Kimi prompt fails with `turn.agent_busy`)
- [x] Paused and offline queues, idempotent delivery, drop rules
- [x] Session-start cross-platform recall (token cap, once per peer per hub run)
- [x] Live `turn/steer` against real Codex (2026-09-19, after the weekly window reset)

M3 local worker and routing L2/L3
- [x] Local worker agent loop with cwd-scoped tools, secrets denylist, approvals and seatbelt sandbox
- [x] OmniRoute client with Cloudflare Access headers and the owner-issued inference key; the off-campus live path remains blocked in `docs/smoke.md` (#1)
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
- [x] Live: Claude plugin task tools and digests in a real interactive session (`docs/smoke.md`, 2026-09-19)

M5 budget relay
- [x] Quota sources (Codex native, Claude status line, Kimi tokens, manual), gate, pause, checkpoint
- [x] Reassignment to local, one resume envelope, idempotency and restart recovery
- [x] Handoff context (checkpoint summary or memory block) plus task briefs in the task envelope
- [x] Live: the Claude status line tee in an interactive session (`docs/smoke.md`, 2026-09-19)
- [ ] Live: a real pause driven by Codex's own numbers with a TUI attached; the natural near-limit prerequisite remains blocked by issue #1

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
      v0.4.0 was published to npm with provenance; clean registry installation and provenance
      readback remain smoke follow-ups, and brew remains out of scope.)
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
- Amended 2026-09-30 (issue #4 of this repository): publishing uses npm trusted
  publishing (OIDC) with no stored token; npm 11.5.1 or later publishes provenance by
  itself. Registering the trusted publisher on npmjs.com is an owner operation.
- The v0.4.0 release workflow completed registry publication with provenance.
  Registry metadata/provenance readback and real Claude setup from a clean registry
  installation remain to be verified.

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


## Amendment: concurrent projects and unified dashboard (issue #19)

The approved [multi-project specification](2026-09-19-multi-project-design.md)
extends the single-machine model to simultaneous independent repository/worktree
hubs. It replaces the unlocked JSON port registry with a transactional SQLite
project registry and adds explicit project selection, authenticated instance
ownership and a separate optional dashboard manager. Runtime data and routing
remain per project. Native memory aliases remain compatible and shared.
Control protocol 7 adds project/instance identity and console-only dashboard
snapshot/action forwarding. Existing project-local UI security rules still apply.


## Amendment: externally managed Ollama MLX (issue #51)

The `mlx/fast` route retains its name but defaults to `mlx.provider=ollama`.
The hub connects to a loopback Ollama service and a dedicated bounded model,
without spawning Python or owning the Ollama PID. Setup explicitly prepares
Qwen3.5 4B MLX with an 8K context; input and output budgets and shared
cross-process admission bound each request. Status separates catalog
availability, residency, expiry and provider readiness. Shared-service
shutdown/unload is not a hub operation; finite idle eviction is configured
and verified in Ollama. Legacy Python lifecycle functions remain available
only through explicit project configuration for migration/rollback.

The authenticated relay, cancellation, tool streaming, Pi backend aliases,
pre-stream DGX fallback and PII policy remain intact. Ollama model/context
mismatch fails explicitly, and errors do not resurrect a Python runtime.
See issue #51 for the acceptance contract and docs/operations.md for the
non-destructive migration procedure.


## Amendment: shared notes, claims and done evidence (issue #68)

Three mechanisms from Agensh (arXiv:2609.26781, a self-organized multi-agent harness)
that need no new service and cost no peer an extra turn.

- Notes reach peers working now. `hub_remember` gains `kind: "fail"` (an approach that
  was tried and does not work, and why). A saved note is also handed to every other
  peer as one line (`note from <peer> [<kind>]: ...`, at most 300 chars) in its presence
  preface, so it rides on that peer's next delivery and never becomes a delivery of its
  own. A preface keeps the newest 10 note lines; recall and restart context are never
  trimmed, and a line in them that looks like a note is quoted, so peer-written task
  detail can neither pass for a hub note nor be trimmed as one. A note is cut on a whole
  character. Sharing is fail-open: a bus that cannot persist loses the sharing, not the
  saved note. Auto notes (done, verdicts, escalation) are not shared: their stakeholders
  already get task and review envelopes. A note whose text or title matches
  `pii_patterns` is refused like a note about a PII task, because sharing would put it
  in every cloud peer's prompt. A preface that went out with a failed delivery comes
  back ahead of any preface created meanwhile instead of replacing it.
- Claims. `hub_task_propose` with `owner` equal to the caller is a claim: the task is
  assigned through the usual `assign()`, goes straight to `in_progress` with its
  reviewer, and no task envelope comes back to the caller. When a task's `refs.paths`
  overlap an open task of another owner (same path, or one is a directory of the other;
  `.` is the whole project), the propose result, the new owner's task envelope and the
  console say so. The later claimant settles it with that owner: only the new owner is
  told to settle it, a caller proposing for someone else hears that the owner was told
  (or, while nobody owns the task, that whoever takes it will be),
  and the other owner is not interrupted. PII tasks are left out on both sides.
  Implementers are told to claim work nobody assigned them.
- Done evidence. The implementer role, the `hub_task_done` summary and the task
  envelope's closing line ask for what changed, why, and the check that was run with
  its result. The verifier role already asks for what passed and what did not, so it
  stays as it was.

## Amendment: Kimi approvals for the hub's own tools (issue #72)

Measured on Kimi 2.1.1 (ACP stream captured on 2026-09-30): a permission request
carries no `rawInput`; the argument JSON streams before it as `content` text on
`tool_call_update`, and `rawInput` arrives only after the answer. Kimi offers
session modes (`default`, `plan`, `auto`, `yolo`) but nothing per server or tool.

- Kimi's requests for exactly `mcp__agent-hub__<name>`, where `<name>` is
  `hub_send` or a task tool, are answered with their `allow_once` option by the
  hub, without a console prompt, and logged by tool name only. This matches the
  `approval_mode = "approve"` Codex already gets for the same tools. Every other
  request keeps the console path; `allow_always` is never chosen automatically.
- For the other tools, the console payload falls back to the streamed argument
  text once it is a complete JSON object. A partial stream stays unresolved and
  keeps `allow_always` withheld.
- For every ACP agent, `rawInput` included: a payload longer than the 600
  characters the console shows is marked `[cut, N chars]` and withholds
  `allow_always`, because the hidden tail can change what runs.
- Name collisions (inferred from reading Kimi 2.1.1's bundled code, not tested
  live): tool names are qualified as `mcp__<server>__<tool>` after replacing
  anything outside `[a-zA-Z0-9_-]`, and a server passed in `session/new` shadows a
  configured server of the same name, so only the hub's `agent-hub` server can
  produce the approved names.

## Amendment: approval notifications and timeout (issue #5)

- A waiting permission request raises one macOS notification (`osascript`) with
  the peer and, when the adapter reports it apart from the title (ACP), the tool
  name; never the title or payload, which can quote a PII turn. Failures are logged
  once and never affect the request.
- `approvals.timeout_s` (default 120, accepted 30 to 3600, otherwise 120 with a log
  line) replaces the fixed 120 s; an unanswered request leaves a console and log
  line.
- `approvals.notify` defaults to on for macOS when a project config file exists and
  to off otherwise (tests, a hub without a config), so test runs raise nothing; a
  non-boolean value is ignored.
- The ACP adapter keeps its inactivity watchdog alive while a permission request
  waits (as the local worker already did), so a timeout above `watchdog_ms` does
  not cancel the turn. The tool name travels to the notifier only; the console
  `permission` push keeps its shape, so the control protocol is unchanged.

## Amendment: claim robustness (issue #6)

- A self-claim (`owner` equal to the caller) without a class, when triage names
  none, is filed as `implement` and its history says so; a proposal for another
  owner still needs a class.
- When a new owner's paths overlap an open task of another owner, that earlier
  owner gets one line through the preface path (`note from hub [finding]: task #N
  (owner X) now overlaps your #M on <paths>; X is told to settle it`), capped with
  shared notes, never a delivery of its own. PII tasks stay out on both sides.
- An owner offline longer than `tasks.release_after_min` (default 30; 0 disables)
  loses its open tasks, released and reassigned by class routing (not the budget
  handoff's local-first list), but only when routing finds another owner;
  otherwise the task stays. Each task is re-read before it moves, so one changed
  meanwhile (reassigned, finished, owner back) is left alone; runs never overlap,
  and a recovery commit waits for a run in progress. Paused peers and hubs in a
  recovery operation are skipped. A peer never seen attached counts from hub
  start. The gone owner gets a line on its next delivery naming where each task
  went. Reviewers are not moved by this.

## Amendment: completion checks (issue #7)

- `checks.<class>` in `.agenthub/config.json` names a command; `checks.timeout_s`
  (default 600, 1 to 3600) bounds it. The hub runs `checks` only when git
  confirms nobody committed that file (any letter case, nor a symlink or submodule
  at `.agenthub`); without a repository or on a git error it runs none. Keys that
  are not task classes are ignored with a log line.
- `hub_task_done` on such a class records `done (checking)` and answers at once
  (a check can outlast an agent's tool timeout); the task stays `in_progress`. The
  hub runs checks one at a time in the project root, in their own process group,
  killed at the timeout or on shutdown; a check still queued at shutdown never
  starts. A check ends when its command exits: what it left in its process group
  is killed then, and a descendant that left the group gets 0.5 s more to flush
  output and is not waited for. Exit 0: the task
  completes as before, the review envelope carrying `Check: <command> -> exit 0`
  and the output tail; shared memory gets the summary and the outcome line, never
  the output. Any other outcome: the task stays with its owner, who gets a task
  envelope with the command, outcome and tail; no reviewer turn is spent. A second
  `done` while the check runs is refused; a new owner who took the task meanwhile is
  told to try again later, since the result reaches only the owner the check was
  started for. A task with any board event since the
  `done` other than an answer or a reviewer change only records the result
  (`check finished late`); if it is in progress with the same owner again, that
  owner is asked to mark it done again. A check interrupted by a hub stop records
  `check interrupted`, is not resumed, and the owner marks the task done again.

## Amendment: machine-local config fields (issue #17)

- Machine-local fields: `kimi_cmd`, `codex_bin`, `pi.cmd`, `checks`, `mlx.bin`,
  `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`, `omniroute.access_hosts`,
  `omniroute.api_key_file`, `omniroute.cf_client_id_file`,
  `omniroute.cf_client_secret_file`, `memory.worker_url`, `local.read_allow`,
  `local.bash_network` (`MACHINE_LOCAL` in `src/hub/config-trust.ts`).
- `loadConfig` reads `.agenthub/config.json`, then `.agenthub/config.local.json`
  over it block by block. In each file, an empty machine-local value is dropped
  (it means the default); one set to anything but its default applies only when
  git confirms that file is untracked, matching tracked files under `.agenthub`
  by identity (dev and inode) rather than by name, and `.agenthub` not a committed
  symlink or submodule; otherwise it is dropped and the config's `ignored` list
  says which and why. No repository or a git error refuses. A file that sets none
  of them asks git nothing, so a committed copy of the template is quiet.
  The containing repository answers "untracked": a checkout copied into an
  unrelated repository is trusted (documented limit).
- The Claude channel reads `roles` from both files in the same order.
- This replaces the checks-only gate of issue #7: the daemon logs `ignored` at
  start, `ahub codex` and `ahub models` print it, `ahub doctor` shows a row.
  `ahub init` adds `.agenthub/config.local.json` to `.gitignore`.
- `routing.toml` and the shared fields still come from the checkout.

## Amendment: telemetry export (issue #40)

- The daemon appends structured events to `.agenthub/state/events.jsonl` (schema
  version 1, `docs/events.md`): envelopes (no bodies), overflow and undeliverable,
  peer states, turns with per-turn tokens where the adapter reports them (Kimi,
  Codex), board changes (ids and states, no titles), overlap records and quota
  readings. Writes never throw.
- `ahub export [--since]` prints the events; `ahub report [--since] [--json]`
  summarizes them. Both read the file directly, so the control protocol is
  unchanged. Bodies are never exported (the issue's `--with-bodies` option was
  dropped: the file never holds them).
- Codex tokens are the growth of each thread's `total`, with the baseline kept in
  the adapter: Codex 0.156.1 also sends `thread/tokenUsage/updated` for
  compaction, usage-limit refreshes and a replay to a reattaching connection,
  where `last` is not new usage. A thread adopted from `thread/start` counts from
  zero; one adopted from `thread/resume` takes its first total as the baseline.
  Kimi reports a session total, which is turned into increments per session.
- Not in schema 1: per-delivery events and delivery-journal transitions, which
  the issue's design listed. `ahub queue list` and hub.log keep them; a later
  schema version can add them without changing the meaning of a field.

## Amendment: provider usage provenance (issue #101)

- OmniRoute keeps validated optional usage counters from the provider response and sanitized served-model/provider labels. The caller's requested route/model remains separate from the reported served model.
- Local worker records one usage event per successful provider response, including a response with no usage counters so reports can show missing coverage. Credentials, Access headers, prompts, completions, task text, session ids and transcript paths never enter telemetry.
- An optional Claude transcript reader accepts explicit session identity and transcript path, but emits only completed assistant-message usage with an opaque session/message hash. Repeated streaming records collapse to the final record for that message; event reports deduplicate repeated polling and resumed transcript reads.
- Reports sum only provider-reported counters and show per-counter known-record coverage. Missing usage remains unknown. Estimated price and measured provider spend are separate and remain unknown unless sourced; token counts are not prices.
- `ahub report` coverage describes recorded provider calls; it does not claim complete account or billing coverage.

## Amendment: per-turn snapshots and undo (issue #33)

- Backend: git tree objects only, written through a copy of the index
  (`GIT_INDEX_FILE`) with `add -A` minus `.agenthub/state`, then `write-tree`. The
  user's index, HEAD and refs are untouched. The issue's APFS `clonefile` and
  reflink backends were not built: on this repository a snapshot takes 17 ms
  (median) and a three-file turn adds 68 KiB of loose objects, and git objects
  already deduplicate unchanged files.
- Snapshots are taken inside the state transition, before the peer is handed its
  prompt. Turn records (`turns` table in hub.db) keep the last `snapshots.keep`
  per peer. `DEFAULT_CONFIG` has snapshots off, like approvals.notify; a project
  config turns them on.
- `ahub undo` refuses the whole turn when any of its files changed since it
  ended (a file-by-file partial undo would leave a mixed state).
- Codex: the method is `thread/revert {threadId, beforeTurnId}` (codex-cli
  0.156.1; there is no `thread/rollback`). It changes conversation history only.
  The CLI asks for it with `--context` (off by default) through the console task
  op `turn_revert`, a new op name on an existing message shape.
- Claude's turns are not recorded: the channel has no turn boundary.
- Not built from the issue's design: a disk cap (the objects stay until `git gc`;
  `snapshots.keep` prunes only the records) and 0700 snapshots (the objects carry
  the repository's own permissions).
- After review: the undo plan reads the current state with one more snapshot
  and refuses a path when anything at or under it differs from the turn's end
  tree, or when another peer's turn that overlapped this one in time changed it;
  paths reach git as `:(literal)` pathspecs; the plan is made again right before
  restoring; snapshots cover the project prefix only and run with a 10 s git
  timeout; turns of a peer holding an open PII task (any state before review)
  are recorded without snapshots; turns left open by a stopped hub are closed at
  the next start without an end snapshot; undo refuses while an overlapping
  turn's changes are unknown; removals run before restorations (a case-only
  rename on a case-insensitive disk); Codex receives nothing while
  `thread/revert` runs.

## Amendment: plans and completed-change notices (issue #31)

- A plan is a JSON column on `tasks` (`paths`, `symbols`, `signatures`,
  `insertion_points`, each a list of short strings), not part of `refs`: refs ride
  on every task envelope. A plan on accept replaces the old one whole. Boards
  from before 0.8 get the column on open.
- A plan's text counts for PII detection when a task is proposed. On accept the
  task's signals are fixed, so a plan that matches a PII pattern is refused for
  an ordinary task.
- Overlap: paths from refs and plan (same file or a directory of it), or the
  same symbol named in both plans. An overlap that only the new plan reveals on
  accept is announced like one found at assignment (console notice and overlap
  event); one already announced is not announced again, but the other owner
  still gets the new plan.
- The completed-change notice is a normal-priority `task` envelope of its own,
  not a ride-along line: an owner in the middle of those files needs it before
  its next task arrives. It lists the files from refs and plan and the plan's
  signatures, as declared; the hub does not read the diff.
- After review: during a PII turn, `hub_task_done`, `hub_review` and
  `hub_task_accept` with a plan are refused for an ordinary task (its plan,
  summary or note would reach other peers and claude-mem), as `hub_remember`
  and `hub_task_propose` already were. Model-written refs and plan items are one
  line (whitespace collapses), so none can forge a hub.log line; a `null` or
  empty plan on accept keeps the plan there is. The completed-change notice
  leaves out any file, signature or summary line that matches a PII pattern.

## Amendment: early conflict detection (issue #32)

- Shared tree only. The issue's worktree mode (pairwise `git merge-tree` between
  per-agent worktrees, AC2) moves to #41, which provides those worktrees.
- Attribution reuses the #33 turn snapshots: the files a turn changed are
  recorded as `touches` (task, peer, path) in hub.db for each task the peer has
  in progress. A later turn by another peer that changes one of those files, while
  the task is open, is a conflict. A file touched by one agent only is not, even
  when its task changed hands. PII tasks are left out on both sides, and a turn of
  a peer with a PII task in progress is not checked.
- Notices are normal-priority `task` envelopes to both owners, once per (peer,
  task, file) per hub run, plus a console line and a `conflict` event.
  "Concurrent" means another peer had a turn open during this one.
- The PreToolUse hook template runs `ahub check-path --hook`, which reads hub.db
  read-only and answers with `hookSpecificOutput.additionalContext` and a
  `systemMessage`, never a `permissionDecision`. Claude Code adds that context
  with the tool result, so it warns after the edit is allowed, not before.
- After review: a turn's touches leave out files an overlapping turn of another
  peer changed (#33's `Turns.overlapping`), and none are recorded while such a
  turn's changes are unknown; detection runs after the `turn_end` event; the
  hook quotes task titles as JSON strings and says they are agents' text; a
  file name that matches a PII pattern is never named, through the same check as
  overlap mentions (#31): notices and the console line count such files, the
  event leaves them out.

## Amendment: task dependencies (issue #34)

- `deps` is a JSON column of task ids, set from `after` when a task is proposed
  and never changed. It may name only tasks that exist, so the new task closes no
  cycle (nothing can depend on it yet); the issue's cycle check at propose holds
  by construction, and unknown ids are refused.
- A task waits while any dependency is not approved. Waiting is an input to
  `assign()` (`waitsFor`), which then returns no owner and says why, so `ahub
  route explain` and assignment agree. Accept and done refuse a waiting task,
  for the console user too.
- A proposal that names an owner (a claim, or an owner for someone else) and
  would wait is refused: the owner of waiting work is chosen when it is ready,
  by routing or by `ahub task assign`.
- Approval, by review or by a class without a reviewer, releases the
  dependents that wait for nothing else; each is recorded as `ready` and assigned.
  A proposal re-reads what it waits for after its insert, since triage may have
  awaited an approval. An approval is saved before its dependents are assigned,
  so the daemon's 60 s release timer sweeps for ownerless tasks whose last event
  is `blocked` or `ready` and that wait for nothing: each is offered once per hub
  run, once an attached peer can take it, outside recovery operations.
- A recovery commit also waits for task operations in flight and for completion
  checks queued or running: both can write the board after its integrity digest
  (a check the commit's stop kills records `check interrupted`).

## Amendment: quota-aware routing, wait or hand off, demotion (issue #36)

- `assign()` stays pure: quota (per peer, the headroom of the most used fresh
  window and that window's reset, from `Budget.headroom()`), the clock and the
  demotion weights are inputs. Demoted peers go behind the others (owner role
  only; local and Pi lose their place ahead of the cloud peers too); within each
  group, peers with readings swap places by headroom per hour to reset (at least
  15 min), and peers without readings keep their configured place. Idle still
  comes before busy, so demotion orders peers in the same state.
- Wait or hand off is decided at handoff time from the pause record's reset:
  within `budget.wait_max_min` the handoff moves only tasks whose signals include
  `urgent` (set by `hub_task_propose {urgent: true}`), and the pause reason says
  so; beyond it the reason says the work was handed over and why. A wait is
  undone when a later reading moves the reset past the limit: the record is
  unmarked and the next tick hands over the rest, keeping both lists of moved
  tasks. `DEFAULT_BUDGET` has it off, like approvals.notify; any project config turns it
  on at 30 unless it sets another value.
- Outcomes (`peer`, `class`, ok, time) are recorded in hub.db and kept a week:
  approved counts for the owner, by review or done without a reviewer; changes
  requested, a failed check and an escalation by hand count against it (the
  hub's own escalations are not counted: after repeated changes requested each
  one already was, and after a Pi inference failure the backend failed). Demotion: decayed failures reach 1.5 and outweigh decayed
  successes, half-life one day, fixed constants for now.

## Amendment: per-sender limits (issue #38)

- One `Limiter` (`src/hub/limits.ts`) serves both ways an agent sends: the
  control WS `send` (hub_send from Claude, and from Codex and Kimi through the
  tools server) refuses with the reason in `error`, which the channel already
  shows, so the message shape is unchanged; the bus's `admit` option guards
  adapter messages (turn answers, the local worker's hub_send), drops a refused
  one and tells the sender in a ride-along line.
- Both admit the envelope as it will be sent: a reply without `to` goes to its
  parent's sender, `digest` is resolved to the senders it replaced, and the
  priority is capped. The repeat key includes the id of what the message
  answers. `fyi` is never limited: it reaches no peer.
- An `important` hub_send through the control WS (Claude, and Codex and Kimi
  through the tools server) over its budget is refused, not downgraded, and the
  reason says to send it without `[IMPORTANT]`. On the bus path (turn answers,
  and the hub_send of Pi and the local worker) there is no caller to refuse:
  over its important budget a message is lowered to status and delivered, and
  the sender is told.
- A refusal consumes no token and does not count as a send for repeat
  suppression. Limits are off in `DEFAULT_CONFIG` and on with any project config
  (12/min per sender, 6/min per recipient, 6 important an hour, 120 s repeats).

## Amendment: review checklists and outcomes (issue #35)

- A review request carries a checklist: map the changed signatures and call
  sites to the task's plan, or without a plan to the task detail, which the
  request then includes; the result of the class's check, or that none ran; and
  `hub_review`'s `unmet`, one item each, which is appended to the verdict note.
- Review outcomes live in a `reviews` table in hub.db: implementer, reviewer,
  class, kind, task, time. Kinds: `approved`; `caught` (each reviewer who asked
  for changes on the current owner's work, which was then approved);
  `contradicted` (an approval, within seven days, of a task on the same file or
  symbol as one whose check failed or whose review asked for changes, a
  directory or `.` not counting; once per approval; console approvals and PII
  tasks are not judged); `escalated` (the reviewer had asked for changes on the
  work that was escalated, so not an escalation of unreviewed work).
- A reviewer's record with an implementer in a class counts tasks: n = the tasks
  it reviewed (approved, caught or escalated), held = (n - contradicted tasks) /
  n. `assign()` takes the records as input and always shows them in its trace;
  with `review.adaptive` it orders reviewer candidates that have at least
  `min_reviews` by held, others keep their place, and the implementer is never
  a candidate. The record is applied after quota, so the order is idle before
  busy, then the record, then quota.
- Task paths are stored in one spelling (issue #67): no leading `./`, no repeated
  or trailing `/`, the root as `.`; older rows are compared in that spelling.
  Blame needs the same path, so a directory never blames the files under it,
  though two tasks that both claim the same directory still blame each other: a
  path does not say whether it is a directory. Existing rows are never
  rewritten.
  Ownership events (`assigned`, `escalated`, `reassigned`, `unassigned`) record
  the owner they leave, so a reassignment to the same owner does not end the
  window in which a catch counts; rows written before keep the old rule.

## Amendment: recovery after an unplanned stop (issue #37)

- The continuous record is `sessions.json` (instance id, time, and each attached
  peer's `recoveryMetadata()`), rewritten when a peer's state changes and
  removed when a stop of the run that wrote it begins (a stop that then runs past
  the shutdown deadline is still not a crash). Found at start, with no
  controlled-restart state in play, it means the previous run crashed; the new
  run takes the record over at once, so its own clean stop removes it even when
  no peer attaches. A controlled restart's target removes any record it finds.
- Limits: a second crash before the peers attach loses their loss notices (the
  journal rows stay in `needs_review`, shown by `ahub queue list`), and the first
  attach rewrites the record with only the attached peers. A Pi in TUI mode is
  reported with its command, not resumed: the CLI runs its terminal.
- `pi.auto_start` (issue #66) counts as consent to start Pi after a crash too:
  crash recovery, not the plain auto-start, starts it, on the recorded headless
  session first and with a `fresh` start (one that does not inherit the failed
  launch's pending session, keeps the recorded backend and model) if that fails
  or nothing headless was recorded. If crash recovery itself fails, the plain
  auto-start runs after all.
- Resume goes through the same start path as `ahub kimi` / `ahub pi` / `ahub
  local`: Kimi with `sessionId` (ACP `session/load`, refused when the agent does
  not offer `loadSession`), Pi with its session file, the local worker afresh.
  Codex and Claude are reported, not resumed: the TUI and the Claude session live
  outside the hub. The issue's Codex `thread/resume` needs the TUI, so the report
  names the thread instead.
- Loss notices use the bus preface, not an envelope: a peer's `needs_review`
  rows block its later deliveries, so a notice queued behind them would arrive
  only after they are resolved anyway; the preface leads that next delivery. Only
  rows still in `needs_review` when the peer attaches are listed.
- `recovery.auto_resume_after_crash` is off by default, also with a project
  config: an automatic start spends quota the user did not ask for.

## Amendment: deny-default sandbox and capabilities (issue #39)

- The deny-default profile allows exec and reads of the system directories
  (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/opt`, `/private/etc`, the
  dyld and timezone databases), the toolchain directories in home, `read_allow`,
  the project, its external git dirs, the selected developer dir (`xcode-select
  -p`) and a temp dir made for each command (issue #63; the shared user temp
  dir and `/private/tmp` are not open); writes to the project, its git dirs and
  that temp dir; a short list of mach services (directory
  lookups, logging, notifications), plus name resolution and TLS trust when
  network is on, the trust being the public CA bundles allowed by exact path
  after the denies (the `*.pem` key deny matches them), and any path ending in
  `/certifi/cacert.pem` (Python's own bundle, issue #64); no brokers that act
  outside the sandbox (LaunchServices, SecurityServer). The denies at the end (credential
  stores, the denylist, `.agenthub`, git hooks and config) are shared by both
  bases.
- The issue's allowlist proxy for `local.bash_network` is not built here: with
  the flag on, network is allowed as in 0.9 and earlier. Issue #65 builds it
  (amendment below).
- `local.sandbox` ("deny-default" | "allow-default") is machine-local, since
  "allow-default" widens the sandbox. Removed in 0.12.0 (issue #83): the field is
  ignored with a note in `hub.log` and `ahub doctor`, and is no longer
  machine-local because nothing reads it.
- Capabilities: `propose`, `assign` (a proposal naming another peer as owner),
  `remember`, `important`. A peer not listed in `capabilities` has all of them,
  which keeps today's behaviour, and a listed peer whose value is not a list has
  none; the console user and the hub are never limited. `remember` gates the
  `hub_remember` tool only, not the notes the hub keeps of done summaries and
  review verdicts. Every refusal, a malformed entry and an unknown capability
  name are logged.
  `important` is checked where messages are admitted, the others in the task
  operations, so in-process tools (the local worker, Pi) are covered too.

## Amendment: egress proxy for the local worker (issue #65)

- With `local.bash_network: true` the daemon runs an HTTP `CONNECT` proxy on a
  loopback port for the hub run (`src/local/proxy.ts`, built-ins only). The
  profile allows outbound network only to that port, looks up TLS trust but no
  DNS (the proxy resolves), and commands get the proxy variables.
- The proxy opens a tunnel only to a host in `local.network_allow`
  (machine-local): a name also covers its subdomains, an address only itself,
  port 443 unless an entry names one (`host:port`). A name that resolves to a
  loopback, private, link-local or carrier-grade NAT address is refused; an
  address is reached only when listed. Plain HTTP is refused. No TLS
  interception. Each refusal is logged with the host only.
- Decisions recorded in the issue: the default list holds the npm, Yarn, PyPI,
  crates.io and Go module registries and GitHub's code hosts, so a project that
  already had network on keeps installing packages; `"direct"` keeps the open
  network of 0.10 and earlier until 0.13.0 (issue #83).



## Reliability follow-ups, 0.12.1 (#89-#95)

- Delivery retries exhausted for an owned open task trigger escalation through `Tasks`, with a redacted reason and a console notice. Delivery health skips peers after three consecutive exhausted deliveries until a completed delivery clears the streak.
- `needs_review` continues to hold a peer's queue. Console notices, status and assignment explanations identify the hold and operator commands; moved or approved task references are context for the operator, never automatic discard authorization.
- Local attach and idle model/route replacement require a reachable authenticated gateway, served models and successful minimal availability calls. Busy workers refuse replacement; validation failure leaves the current worker intact. Controlled recovery can reconstruct a manually paused local worker without gateway availability, but manual resume validates its restored choice before lifting the pause. Doctor checks the fixed model against the inventory.
- Reviewer routing appends attached peers holding `roles.reviewer` after the review class's candidates. Without a reviewer, task results and console notices explain direct approval and the skipped candidates.
- Conflict detection includes `in_review` work. Completed overlapping snapshots that share files generate one concurrent-edit notice per task pair/file, containing both turn ids and attributing the changes to neither peer. Private tasks and sensitive file names remain redacted.
- Pi assistant usage is forwarded through the authenticated bridge and recorded before settlement, without counting the same message both at `message_end` and `agent_end`.
- An idle peer with no open owner/reviewer task and no queued or active delivery skips the quota checkpoint turn; the pause proceeds immediately and the log records the skip.
- Control protocol 11 adds queue hold metadata; the current coordinator supports authenticated protocol 9, 10 and 11 recovery sources.


## Approval-time file validation, 0.12.2 (#98)

The hub-native write and edit tools validate paths before requesting approval and
again after approval, at mutation time. Edit retains its early exact-fragment
check, then reads current contents after approval and requires the old fragment
to occur exactly once. The approved replacement applies to those current bytes,
so another peer's unrelated edits made during the wait are retained. A changed
fragment or an escaping path returns an error without a write.

## Live channel settlement (issues #100-#104 follow-up)

Wire protocol 12 separates live notification acceptance from recovery uncertainty.
A live `accepted` Claude notification remains visible as `liveAccepted` in status
while later notifications can arrive. A correlated reply settles only its own
message. Task acceptance, completion and approval are independent of delivery
settlement and cannot complete unrelated messages.

The Claude channel API does not expose a verified native turn-end event. Instead,
channel metadata supplies `delivery_id` and a connection `delivery_generation`;
`hub_delivery_done` is an explicit acknowledgement of handled work. The daemon
requires the current peer socket, matching generation, a delivery actually handed
to that socket, and a live accepted journal row. This acknowledgement is not proof
of a native turn boundary. Failed notifications, disconnects, replaced sessions
and interrupted daemon instances retain `needs_review`, with no automatic replay.
A person inspects and resolves uncertain work through the existing revision-fenced
`ahub queue` commands. Older source protocols 9, 10 and 11 remain authenticated
upgrade sources; ordinary clients must use protocol 12 (13 from 0.12.4, with 12 a source).

## Amendment: stale overlap notices (issue #106)

- The completed-change notice (#31) and the edit-conflict notices (#32, #91) are about an open task of their recipient. `Tasks.whileOpen` publishes each to one recipient and remembers the condition (the newest 1024). The bus asks `Tasks.relevant(peer, env)` per recipient when it builds a delivery and again right before it hands the delivery over, after condensation; it is false only for a recorded notice to that peer whose task is gone, has another owner, or left the states it was about: `proposed`, `in_progress`, `changes_requested`, and for conflict notices also `in_review` (#91 reports conflicts with work under review). A dropped copy is a journal row `discarded` with `stale: task #N is no longer open for <peer>`, a `STALE` log line and a `stale` event; other recipients and other deliveries are untouched.
- An envelope without a record (another kind, a restart, an evicted record) is delivered as before: its purpose is never guessed from its kind. Assignments, approvals, check results, review requests and budget, permission and recovery messages are never conditional.
- In the release pilot the advisory arm on 0.12.4 is the stale-notice-only ablation against 0.12.3's advisory arm (#110).

## Amendment: turn-free cohorts (issue #107)

- `coordination` in the project config: `"advisory"` (default) or `"turn-free"`; anything else is advisory with a log line. While a PII task is open the project is advisory.
- `src/hub/cohorts.ts`: owners of overlapping open tasks (#31) form a cohort when the overlap is found (assignment, an accept with a plan). Members are tasks with their owner and owner generation (ownership events); every change of membership, owner or completion intent bumps the cohort's revision. A cohort is silent if, when formed, every owner's context path is verified (#108); it never becomes silent later, and it is lifted (members told) when an unverified owner joins or a path is lost.
- Silence is a per-recipient bus policy (`BusOptions.silence`), applied once the audience is final (implicit replies and `digest` resolved): an agent's chat from a member that has not settled to another member is not queued for that member; the other recipients get the envelope unchanged, so correlation, priority caps, dedupe and hops are untouched. A `quiet` bus event goes to the log and `events.jsonl`; `hub_send` answers with the held-back peers (an error when nobody got it); a native turn answer's sender hears it as a note. A member settles once its task left the open states and its native turn has ended after that (Codex's adapter going idle, Claude's Stop hook); a settled member's next turn is new work.
- Texts: in a silent cohort, overlap results and notices, task envelopes and the conflict notices name the plans and say not to message; `hub_task_accept` returns the overlapping plans with every accept; `ahub check-path` asks the hub (`silenced` control request); no completed-change notice is sent. Otherwise the advisory texts stay.
- Integration: a member's `hub_task_done` records an intent. The member whose intent completes the set is selected in one synchronous step and gets an integration request as its done result (the others' files, signatures and summaries, plus its facts); the request is recorded as `integration requested`, not done. Its next done is accepted (`integrated`, then the usual done) only for the same owner generation, cohort revision and file hash, with its facts acknowledged and every other member's native turn ended after its intent. Otherwise it is asked again; past three requests the done is recorded with `integration unresolved`. A failed check or changes requested withdraws that member's intent; a check of the integrating member that passes after its target moved counts as finished late. After a restart an open request is recorded as unresolved.

## Amendment: turn-free facts at tool boundaries (issue #108)

- `src/hub/facts.ts` keeps three things apart per peer: what the hub observed in the tree (latest version and transitions per file), what it offered (bounded offers with their file versions and plans), and what the peer acknowledged (its view). Only an acknowledgement moves a view; a later boundary offers everything since the view again. Files are the plan and refs paths of the peer's overlapping open tasks, contained in the project as real paths, plus the last 64 it touched; only regular files of 256 KB or less are read.
- Attribution: a transition is credited only with effect evidence: a Claude Edit, MultiEdit or Write whose result equals its input applied to the file as observed at PreToolUse with no observation in between, or a Codex `fileChange` whose changed lines equal the observed diff. Everything else is shown with its attribution unknown; an agent's own verified writes advance its view and are not shown back.
- Acknowledgement and capability: Claude's hook runs before and after every tool and at Stop (`ahub claude` injects it in a turn-free project); the pre answer's text becomes `additionalContext`, and the row Claude Code writes in its transcript for it (matched by tool use id and offer id) is the readback. Codex's offer goes in with `steerText` (bound to the running turn), and the steered input coming back as a `userMessage` item is the readback. A readback marks the peer's path verified; a new session or three offers past a minute without one unverifies it. Until verified, a peer gets a one-line probe at most three times per session.
- The control contract is protocol 13: `facts` carries the phase, tool, input, tool use id, session id and transcript path; `silenced` serves check-path; `send` results name held-back recipients. Protocol 12 stays an authenticated recovery source.
- While a PII task is open nothing is observed or offered; when tracking resumes everything observed is dropped and each peer is told which files earlier changes are not covered for.
- `events.jsonl`: `fact` (bytes, build time, the hook's own time), `fact_ack` (latency), `capability`, `native_turn_end`.

## Amendment: shadow split prediction (issue #109)

- `predictSplit(input)` is a pure function next to `assign()`, which no longer takes a split option: assignment never changes. For the pair formed by the peer routing picks and the owner of an overlapping open task, it compares a split (the later of each peer's orientation plus one unit) with the best peer alone (orientation plus two units). It is unknown unless the units are equal and known (one task of the same class is one unit), both peers are available with no other open work, and each has five measured tasks in this hub run with at most 30% failures and work times whose IQR does not exceed their median; a difference under a tenth of the single time is inconclusive.
- `Tasks.splitObservations` reads only tasks handed out in this hub run (one version and hook profile), leaves out claims, types failures (failed check, changes requested, escalation, release, decline, unresolved integration) and leaves the stages unknown for an accept recorded by the done itself.
- A routed assignment with an overlap records a `split` event; `ahub route explain <id>` appends the same trace. Rerouting needs held-out evidence through #110 first.
