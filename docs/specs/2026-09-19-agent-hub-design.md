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

## Amendment: retire the Switchyard sidecar (#553, 2026-10-20)

- All model routing runs in process. Remove `src/switchyard/`, the external binary,
  generated config, lifecycle, health/status/doctor entries, `AGENTHUB_SWITCHYARD_BIN`
  and `x-switchyard-session-id`. Port offset `SWITCHYARD = 3` remains reserved and
  unused; other port offsets do not move. Keep `src/models/route/` Apache-2.0
  notices and `scripts/check-switchyard-upstream.ts` as algorithm provenance.
- Translate `stage_router` to a hub `stage` route: `efficient_target` becomes
  `efficient`, `capable_target` becomes `capable`, and `confidence_threshold` is
  unchanged. Translate passthrough to the class's `fixed_model`, without a route.
  The old unshipped classifier escalation uses the existing hub escalation route.
- Existing `[targets]` and `[routes]` tables load as retired settings, are ignored
  and produce startup/doctor diagnostics naming their hub-route replacements.
  Every selection without the `hub/` prefix, including legacy named routes and
  `sy/` selections, uses its fixed-model fallback with one warning, not a
  process start. Never rewrite an operator's routing files during load or reload.
- The shipped template uses `[hub_routes]`, local/implement `hub/stage` and direct
  `fast` fixed models for former `sy/fast` classes. A class with a `fixed_model`
  and no `route` explicitly selects direct inference rather than inheriting the
  global local route. A fixed-model fallback remains required.
- Internal digest, triage and other hub inference calls use only their configured
  fixed model through OmniRoute, preserving bounded, optional, fail-open behavior.
- Doctor compares every local/class fixed alias and every hub route's effective
  efficient/capable/judge alias with gateway inventory: one failure per missing
  alias, or one passing row when all are served. An unavailable inventory is not
  proof that an alias is served. PII keeps positive campus admission and
  `onCampusOnly`; no model-route selection may bypass either guard.

This decision supersedes earlier active sidecar deployment and fallback wording
below. Historical binary observations remain evidence of the former integration,
not instructions to install or run it. Phase 5 of the source-port design records
the same retirement decision.

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
   L2 in-process hub routes (which model per call for hub-owned traffic), L3 OmniRoute
   (keys, provider fallback, usage). Fixed models go straight to OmniRoute (#553).
6. All hub-originated model traffic (local worker, internal summaries, triage) goes
   directly to OmniRoute, optionally selected by an in-process route. Subscription CLIs keep their own auth.
7. Quota relay hands open tasks to the `local` peer first, then waits for the window
   reset for judgment-heavy classes. Task-level escalation on verification failure.
8. Safety defaults: cross-peer text is framed as untrusted; permission prompts stay on
   unless `--unattended` or an operator-selected permission mode (issues #240,
   #242); ports bind loopback only; Kimi ACP permission requests are
   relayed to the hub console. Loopback is not enough on its own (any web page can open a
   WebSocket to 127.0.0.1), so the control WS requires a per-run token and both hub
   servers refuse requests that carry an `Origin` header (amended in M1).
9. One hub daemon per project directory, with a local bus. Amended by #446:
    opt-in encrypted rooms may connect hubs through an untrusted broker; the room
    boundary does not federate their boards, roles, approvals or memory. X1 defines
    crypto and wire primitives only. X2 supplies a standalone broker; the hub link
    and local delivery integration remain X3/X4. Memory replication through git (#258) remains a separate mechanism.
10. Shared memory reuses claude-mem as the single store; the hub never runs its own
    memory database. (Amended in #258: the hub owns a long-term store and its graph,
    `docs/memory.md`; claude-mem stays the optional capture and session-recall source.) Native capture stays where it exists (Claude hooks, Codex plugin,
    Kimi transcript bridge); the hub captures only the local worker and adds
    cross-platform recall, task-scoped briefs and explicit shared notes. Hub tool calls
    are not captured; Tasks alone decides what screened tool text reaches memory.
    The bus still passes messages, never transcripts.

## Design

### Components

```
Claude Code TUI ── MCP stdio ── plugins/agent-hub (channel server) ──┐
Codex TUI ──── --remote ws://127.0.0.1:<proxy> ── app-server proxy ──┤ ahub daemon (Bun)
kimi acp (child, stdio) ── ACP client adapter ────────────────────────┤ bus · board · budget
local worker (in-process agent loop) ─────────────────────────────────┤ router L1
hub CLI / console ── control WS 127.0.0.1:<ctl> ──────────────────────┘
                                   │ model calls
                     in-process model routes                              L2
                                   │ base_url
                     OmniRoute: internal URL (VPN) / Access-protected public URL    L3
```

- `ahub daemon`: owns the message bus, peer registry and state machines, task board,
  budget coordinator, router L1, and the Codex proxy, ACP child and local worker. Survives
  Claude Code restarts. State in `.agenthub/state/` (pid, status.json, sqlite, logs).
- `plugins/agent-hub`: Claude Code plugin. Its MCP server is the channel; it reconnects to
  the daemon over the control WS with backoff, except after a close no retry can fix: 4401,
  4403, 4409, 4430 (ended launch) and 4426. It then stays detached and its tools report why. Close 4000 (another
  session attached as the same peer; the newest hello wins, whatever order the session-start
  recalls finish in) is not one of them (amended, issue #30): that session stands by, and
  reconnects only once `status.json` reports the peer offline and not `claiming`, so it never
  evicts the session holding the id - nor one whose hello is still finishing its preface - and
  the two cannot trade it back and forth. The daemon writes the status file at the claim, before
  the preface, so the arriving session is visible for that window. A retry after 4000
  carries `standby: true`; the daemon checks its actual attached or claiming sockets
  before allowing a reclaim, even when the status file was missing, stale or unreadable.
  The push-over-pull exception below remains, but never displaces a pending claim. Its tools say it is standing by
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
  watchdog sends `session/cancel`. A durable delivery goes offline with `needs_review`;
  without a journal, the peer stays busy until its cancelled prompt reports, bounded by
  30 s, then goes offline with queued work retained if no report arrives. `--model` maps to `kimi --model <alias> acp`
  (verified flag). Reusable for `opencode acp`.
- Local worker (amended in M3): a hub-native tool-calling loop over non-streaming
  `POST /chat/completions` with plain `fetch`, no SDK (the repo keeps zero third-party runtime
  dependencies; the first-party memory core is an exact-pinned library). Tools `read`, `write`, `edit`, `bash`, `git`, `hub_send` (`hub_task_*` with
  M4). Paths are realpath-scoped to cwd with a secrets denylist; `.git` and `.agenthub` are
  not writable. `write`, `edit`, `bash` and mutating `git` go through the console permission
  relay unless the hub runs `--unattended`. Everything that executes runs under seatbelt
  (`sandbox-exec`), attended or not: writes only under cwd, its real git dir (submodule,
  worktree) and temp; the home directory is unreadable except the project, toolchain dirs and
  `local.read_allow` (whatever a command reads can reach cloud-hosted peers through the
  answer); no reads of credential stores or denylisted files, no `.git/hooks` or `.git/config` writes, no network, loopback included, unless
  `local.bash_network`, scrubbed environment; without seatbelt there is no `bash`. 30 steps per
  turn, `reasoning_content` is never stored or shared. Model comes from `routing.toml`:
  an in-process hub route, or `fixed_model` straight to OmniRoute.
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
  `important` to a busy Codex or a busy owned Jcode is steered instead: Jcode takes it as a soft interrupt through its own private server socket, injected at its next tool boundary, and the turn answers its sender too (#572). The hub never cancels a turn to deliver; a peer with no steer (headless Kimi, Qwen) keeps it queued, and status reports how long it has waited once that passes `budget.stale_min`. `fyi` is never delivered to a peer: console
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
| busy | turn started / prompt in flight | Claude: push (Claude Code queues); Codex, Jcode: steer if important else queue; Kimi/local: queue |
| paused | budget gate (M5) or user `ahub pause` / `ahub resume`; a bus-level flag over the adapter state | queue, never steer; reassign open tasks (M5) |
| offline | adapter disconnected | queue |

Every queue is bounded (`queue_cap`, default 200): on overflow the oldest non-`important`
envelope is dropped and reported on the console.

The inactivity watchdog per busy turn defaults to 300 s. ACP sends `session/cancel`: a
durable delivery goes offline with `needs_review`; on a bus without a journal, the peer
stays busy until the cancelled prompt reports, then drains on idle. After the 30 s bound
without a report it goes offline with queued work retained, never idle. Cancelled results
and errors are discarded; an error during that wait leaves one log line. Other adapters
keep their cancellation rules (`turn/interrupt` for Codex). An ACP tool call announced
and not yet `completed` or `failed` is running work, not silence: it keeps the turn alive
up to a 30 min tool ceiling (never below `watchdog_ms`), past which the cancel above runs
with a log line naming the open tool (#542 D4). Queues drain in order only
when the adapter is idle. Delivery is at-least-once with
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
  `[pii]` to everyone but `local` inside a PII turn; `ahub task show` is the one place
  the console reads it. The reviewer is the console user; `local` answers such a turn
  to the console only, keeps it out of its history, refuses it when the only gateway
  is off campus (Cloudflare Access), and
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
route = "hub/stage"                     # in-process route for the local worker
escalate_to = ["kimi", "claude"]        # on verification failure

[classes.bulk_edit]
peers = ["local", "kimi"]
fixed_model = "fast"

[classes.review]
peers = ["claude", "codex"]
route = "hub/review"
local_allowed = false                   # never route judgment classes to local

[classes.summarize]
peers = ["local"]
fixed_model = "fast"

[constraints]
pii = "local_only"                      # hard: on-prem models only
budget_paused = "skip_peer"
```

L2 in-process routing (2026-10-04 source port): `[hub_routes."hub/<id>"]` selects
stage, plan_execute, advisor or escalation policies inside the hub. The host retains
transport, budget admission and complete-turn history ownership; algorithms make decisions
from normalized chat input and bounded session state. See
[the source-port contract](2026-10-04-switchyard-source-port-design.md) for upstream
provenance, intentional fail-open escalation and REDO history differences. These tables
run without a sidecar. Legacy selections without the `hub/` prefix use only their fixed-model fallback. The Pi `hub/auto` alias uses the same stage signals with session-scoped
hold and context admission; peer progress observations suggest but never execute reassignment.

Legacy L2 compatibility (#553): `[targets]` and `[routes]` are retired, ignored
settings. Every selection without the `hub/` prefix falls back directly to its
fixed model with one warning, including legacy route ids without a prefix.
No binary, generated model-router config or model-router listener remains. The
migration mapping is in the retirement amendment above; historical native binary
observations remain in `docs/smoke.md`.

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
task turn and `[local]` otherwise. Verification failure (tests fail, review `changes_requested` `tasks.escalate_after` times in a row, default 3, #488) escalates
the task to the next peer in `escalate_to`; hub routes handle per-call escalation
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
  renders unchanged, `ahub budget` shows both windows). Kimi has an optional soft
  rolling 5 h ceiling for validated consumed-token readings, `budget.kimi_tokens_5h`
  (off by default), and the observed Kimi Code CLI 2.1.1 five-hour provider refusal
  is a hard source (#306). Only the pinned rejected-prompt text is recognised,
  bound to verified native identity and the current turn. It reports `5h`, used 1,
  source `kimi ACP usage-limit refusal`, and a conservative 300-minute reset
  estimate; weekly/monthly limits and other ACP providers remain unverified. Verified live on kimi
  2.0.1: one update per turn, payload `{"sessionUpdate":"usage_update","used":<tokens>,
  "size":<context window>}`; `used` is the session's context occupancy against `size`
  (1M), not billed quota. ACP records this shape as context occupancy diagnostics,
  never as cumulative consumed tokens. Since #285 phase 1 it is also the peer's
  native context reading (source `acp_usage_update`), shown in `ahub status`, the
  console and the dashboard like Claude's and Codex's; the adapter accepts the
  update whenever it names the current session, since 2.1.1's source text emits it
  after the prompt resolves (an order read from the source, not yet observed live
  through the hub; docs/smoke.md). A gate crossing records the
  event and notice for an ACP peer but sends it no checkpoint request yet. Since #285 phase 2 the soft ceiling's counter is the
  hub's own count of Kimi's session wire log (`src/adapters/kimi-wire-usage.ts`, wire protocol 1.5, read on Kimi 2.3.0; the issue
  read 2.1.1), not an ACP total: each `usage.record` row of the owned session, sub-agents included, is a `usage` event
  (`source: kimi_wire`) and a `tokens` event, and the rolling 5 h sum of `inputOther + inputCacheCreation + output` (cache reads are
  recorded, never counted) is the `tokens` window, source `hub count, kimi wire log, of kimi_tokens_5h N`. Any read the reader
  cannot trust gives unknown (one notice, the reading dropped), never a short count. `ahub budget set`
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
  until the window that paused it has reset, unless a provider refuses another turn:
  that hard refusal ends the override and supersedes a pending soft checkpoint. An
  untouched ACP refusal is requeued only after the hub confirms its budget pause;
  otherwise it stays held for review. After activity, the delivery remains held
  even though open tasks are relayed, and the queue stays held after the budget
  reset until a person inspects and resolves it. Keep one pending resume notice carrying
  every public move since the previous notice was delivered; retain an older unstructured
  notice as public text. Within one hub run, retain a still-future reset bound for the same
  window across an override, while an explicit provider reset remains authoritative. A
  restored pause without per-window reading identity starts a fresh estimate at the next refusal.
  A handoff waits until another peer is attached
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
  characters; the hub's configured fixed model (default `fast`) answers from that list only and has to cite its ids, and an answer that
  cites nothing from the list is dropped. No evidence means no model call; no model means the evidence is the result.
  Every row is capped and rows that match the question lead, so one long row cannot empty the list. Every cited id
  has to be in the list: one invented id drops the answer. PII task text is evidence only when an on-campus model is
  positively confirmed (a gateway answered and it is not behind Access); otherwise
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
- `ahub claude` and `ahub codex` keep native permission defaults unless the person
  selects a permission mode (issues #240, #242). `--unattended` opts into
  `--dangerously-skip-permissions` (Claude) and `--dangerously-bypass-approvals-and-sandbox`
  (Codex 0.154.0 documents this flag, not `--yolo`) and prints a warning.
- Kimi and local tools: cwd-scoped, secrets denylist (a secrets directory, `.env*`, keys).
- Loopback binds only; ports per project from a registry (base 4600, stride 10).
- No subscription OAuth through any gateway.

### Configuration and state

- `.agenthub/config.json` (roles, ports, filter tiers, watchdog), `.agenthub/routing.toml`.
- `.agenthub/state/` gitignored: `status.json` (with the daemon's pid and process signature, #226; daemons up to 0.12.20 also wrote `hub.pid`), `control-token` (0600, per run),
  `hub.db` (tasks, messages, budget; from M4), `hub.log`, `checkpoint.md`.
- Env: `AGENTHUB_STATE_DIR`, `AGENTHUB_OMNIROUTE_URL`, `OMNIROUTE_API_KEY`,
  `AGENTHUB_UNATTENDED`.

### Testing

- Unit: bus routing, priority batching, state machines, L1 policy evaluation, envelope
  framing, marker parsing.
- Fakes: fake ACP server, fake app-server (ws), fake MCP client, fake OpenAI-compatible
  model server. Integration tests spawn the daemon against fakes.
- Live smoke (manual, documented): trio chat, steer during a Codex turn, Kimi
  busy-queue drain, local worker completes a bulk edit through in-process routes -> OmniRoute
  with `x-omniroute-provider` visible, budget pause and resume with a mocked probe.
- One command gates everything: `scripts/check.sh` (typecheck, unit, integration).

## Changes

New repo layout:

```
src/hub/            daemon, bus, peer-registry, state-machines, board, budget, router
src/adapters/       claude-channel.ts, codex-appserver.ts, acp.ts, local-worker.ts
src/memory/         hub memory integration: claude-mem client, capture, briefs and recall; portable core is @staix/agent-mem
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
   reviewer; `tasks.escalate_after` consecutive `changes_requested` (default 3) escalate per `routing.toml`.
5. `ahub local` completes a `bulk_edit` task; OmniRoute log shows the request with the
   per-peer token and `x-omniroute-provider: vllm`; `ahub route explain` shows the
   chosen route.
6. All model routes run in process; retired selections without the `hub/` prefix use `fixed_model`.
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
- [x] Historical M3 Switchyard integration, retired in #553; fixed fallback remains.
- [x] `ahub local`, smoke through OmniRoute with provider header check; historical sidecar receipts in smoke.md.
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
- [x] Status digests and triage through the configured fixed model (default `fast`; amended: optional and fail-open with a backoff. Only plain status
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

- Windows. Cross-machine rooms are an opt-in extension under #446, described below. The web UI was outside the original six milestones; issue #6 adds the local dashboard described below.
- Room v1 excludes hosted multi-tenant service, multi-owner rooms, forward secrecy, traffic-metadata hiding, approval or permission-request relay, and cross-machine instances. Shared boards, remote roles and remote task ownership remain excluded; memory crosses only through the separate agent-mem git sync. No hub server is exposed.
- OmniRoute daemon on the Mac; pooling subscription OAuth through any gateway.
- Gemini CLI and OpenCode adapters beyond the ACP fallback note.
- Switchyard `auto` route until v0.3.0 ships.
- Running Claude Code itself on a local model (depends on the Anthropic-to-chat
  translation check in the OmniRoute plan v1, Phase 0).
- A hub-owned memory store, cmem.ai cloud sync, automatic corpus building (a project
  corpus for `ahub ask` is an optional M6 item), and any change to the vault LEARN loop.

## Encrypted rooms: X1 crypto and wire contract (#446)

This amends decision 9 and the original cross-machine exclusion. The [frozen
D1-D5 design](https://github.com/STAIxBWLB/agent-hub/issues/446#issuecomment-6242775004),
[person's O1-O4 answers](https://github.com/STAIxBWLB/agent-hub/issues/446#issuecomment-6242885199)
and [implementation go-ahead](https://github.com/STAIxBWLB/agent-hub/issues/446#issuecomment-6391889660)
are binding: a self-hosted zero-dependency broker, person-only owner-hub invitations
and revocations, no task notices in v1, and remote priority capped at `status`.
X1 adds source modules, with no listeners, CLI, daemon startup imports or room delivery.
X2 supplies the broker; X3 supplies durable state/link/enrollment integration; X4
supplies message boundary enforcement; X5-X7 supply status, invocation and the
person's two-machine live receipt. None of those later proofs follows from X1 tests.

### Algorithms and local identity

`src/rooms/crypto.ts` uses built-in WebCrypto only: Ed25519 signatures, X25519 key
agreement, HKDF-SHA-256, AES-256-GCM with a 128-bit tag, and HMAC-SHA-256. Definitions
follow [WebCrypto](https://www.w3.org/TR/webcrypto-2/), [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)
and [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869). `ROOM_MIN_BUN_VERSION` is
`1.4.2`, also the repository's Bun floor. `assertRoomCryptoReady()` caches a
fail-closed version/capability self-test, including known-answer and negative
checks for every primitive. Every asynchronous crypto/wire operation awaits it;
X3 must also await it before opening any room link. A failure disables rooms,
without changing local hub operation. Supporting a version requires both the
version floor and the actual self-test, not a version-string assertion alone.

A hub has separate signing and agreement key pairs. Its fingerprint is lowercase
SHA-256 hex of its raw Ed25519 public key. Both public keys and the fingerprint
are authenticated together by joins, wraps and rosters. Private runtime handles
are opaque WeakMap-backed identities; explicit `exportHubIdentityForStorage` and
`exportEpochKeyForStorage` are machine-local persistence boundaries, never wire
fields or diagnostics. X3 must store them in a private 0700 directory and 0600
files. A same-user process can steal those files; pinning is not a sandbox.

A random 256-bit epoch root is wrapped separately for each member using a fresh
X25519 ephemeral pair, 32-byte HKDF salt and 12-byte GCM nonce. HKDF info is SHA-256 of the full
versioned, domain-separated derivation transcript, keeping provider input bounded
without dropping context; GCM AAD and signatures still bind the full transcript. The owner's
signature binds the full owner/recipient public-key tuples, room/epoch/membership
context, ephemeral key, salt, nonce and ciphertext. Zero shared secrets refuse.
Every roster change, including label or exposure changes, advances the epoch and
creates a fresh root. A removed member receives no new wrap. This has no forward
secrecy against later theft of a member's long-term agreement key and recorded wraps.

### Wire v1 and privacy

`src/rooms/wire.ts` defines strict canonical UTF-8 JSON: recursively sorted ASCII
object keys, exact known fields, safe integer timestamps, positive canonical
uint64 decimal strings for epochs/sequences, and unpadded canonical base64url.
Decoders reject unknown/duplicate fields, whitespace or alternative encodings,
invalid UTF-8, unsorted/duplicate collections and exceeded ceilings. Canonical
bytes are the signed/hashed transcript; signatures use separate versioned domains
for frames, rosters, wraps and joins. IDs/labels are bounded ASCII identifiers,
never arbitrary display text. Errors contain fixed codes, no input or key material.

| Record or collection | v1 ceiling |
| --- | --- |
| Plain frame payload | 65,536 bytes |
| Encoded frame | 131,072 bytes |
| Encoded roster | 524,288 bytes |
| Invite or join | 16,384 bytes |
| Members, frame recipients, exposed local peer ids per member | 64 each |
| Local label or exposed peer id | 32 characters |
| Broker URL | 2,048 characters |

These are protocol ceilings, not measured capacity claims. Raising one requires a
versioned contract review. Broker URLs are canonical `wss:` without credentials or
fragments; `ws:` is permitted only for literal `127.0.0.1` or `[::1]` testing.

The signed roster has public room/epoch/owner, member fingerprints and public keys,
wraps, and an encrypted private roster. The encrypted portion contains the matching
member tuples, unique local labels and exposed peer ids. This resolves the freeze's
signed-roster requirement without exposing labels or peer ids to the broker. All
public and encrypted components are covered by the owner signature. A receiver
pins room, owner fingerprint and its persisted minimum epoch. Initial enrollment
uses `minEpoch="0"`; positive values name an installed epoch, whose exact digest
is mandatory when accepting that same epoch again. Missing or mismatched digests
refuse even an otherwise valid owner-signed retry. It verifies the signature, its exact key tuple, wrap,
private roster and identical membership before accepting a candidate. X3 must
atomically install that candidate against its persisted pin. Replaying an old
candidate must never reset the minimum epoch or a grace deadline.

A frame's public header is `{v,type,room,epoch,sender,recipients,seq}` plus nonce,
ciphertext and signature. Recipients are hub fingerprints, not local peer ids.
The body is opaque encrypted bytes, including any eventual local addressing,
kind, trace and text. Frame AAD is exactly UTF-8 `room|epoch|sender|seq`. A
sender-specific AES key is HKDF-derived from the epoch root and room/epoch/sender/
roster digest context. Every encryption attempt draws a fresh random 96-bit nonce
from WebCrypto, independent of the sequence counter. A counter rollback therefore
does not deterministically reuse a GCM nonce; per-sender subkeys also separate
senders. Random-nonce collision bounds and a functioning runtime RNG remain
cryptographic assumptions. The sender's
signature additionally binds recipients, nonce, ciphertext and all header fields.
X1 encryption authenticates bytes; X4 must still screen what those bytes may mean
before any local bus delivery, including untrusted framing and the `status` ceiling.

### Required durable host ports and epoch settlement

There is no production in-memory fallback. `sealFrame` requires `SequencePort`:
`reserve` durably consumes a strictly increasing room/sender counter that survives
restart and epoch rotation, checking the installed roster digest. `isCurrent` is
a final synchronous fence after crypto; X3 must additionally fence durable outbox
publication. Failed attempts consume sequence numbers; each encryption attempt draws a fresh random nonce. Counter durability still protects replay/order state, rather than determining encryption nonces.

`openFrame` verifies current sender/recipient membership, signature, epoch, nonce
length and GCM authentication before invoking `ReplayPort.accept`. In one transaction that
port must recheck current and selected roster digests, current membership and its
own local clock/grace deadline, compare the room/sender high-water mark, and commit
accepted digest plus inbox delivery before release. Only `accepted` returns
plaintext. `duplicate` means an identical previously accepted frame digest and
returns no plaintext; an unknown lower sequence is `stale`, never a completed ACK.
D5 receipts may be resent only for that stored identical digest. Gaps are recorded,
not treated as proof that missing messages arrived. Callback failure refuses.

Only the immediately preceding epoch may have a persisted 60-second local grace
deadline. X3 must derive and persist that deadline as the local successful rotation
installation time plus exactly 60,000 ms, never from caller or remote expiry input. Both sender and receiver must still be current members with unchanged
keys; revocation therefore refuses immediately, including during grace. The port
must refuse after expiry even if crypto crossed the deadline, and restarts or
replayed rosters must not extend it. X1's optional `previous` and `nowMs` parameters
are trusted-host inputs/test clocks, not remote authority. No caller can substitute
for X3's durable atomic installation, clock and publication fences.

An out-of-band invite carries room, broker, pinned owner fingerprint, expiry,
random invite id and random 256-bit one-time secret. Never send it to the broker or
log it. A join exposes only its member public-key tuple and encrypted private
label/exposure data. HMAC binds the full invitation claims and signed request;
the member signature binds the same claims and request. Before consuming the
invite, a trial X25519 agreement rejects unusable/low-order member public keys.
This checks key usability, without claiming a separate private-key possession
proof. A broker cannot replace keys or repurpose a request under a changed invitation. Owner expiry is exact;
a joiner's preflight allows at most 10 minutes of clock skew, which grants no
owner-side extension. `EnrollmentPort.consume` must compare the original stored
invite digest and expiry, consume once, and persist identity/request outcome with
membership publication. Only the exact same request may be a duplicate. Owner-hub
person authorization and OOB secret handling remain X3 integration obligations.

### Acceptance and limits

Real built-in crypto tests cover vectors, private/public binding, wrap tampering,
wrong recipient/context, revoked old-key failure, domain separation and sanitized
errors. Wire fixtures cover canonical bounds, owner pins, metadata hiding,
unsigned/tampered frames, replay/concurrent duplicates, stale sequences, epoch
rotation, current-member grace, invite substitution/expiry/one-time consumption
and refused state ports. Memory fake ports prove API ordering only, not durability
or restart safety. Full gate and exact-head CI are separate from native/account or
two-machine receipts. No room transport, real invite, remote delivery, production
storage permission, crash-restart replay or X7 receipt is verified by this slice.

## Encrypted rooms: X2 blind broker (#446)

The frozen O1 is self-hosted, zero-dependency `ahub broker serve`. X2 adds a separate
Bun HTTP/WebSocket process. The hub daemon, local bus, board, roles, approvals and
memory are untouched. X3 supplies the hub link, person-only room operations and
one-time enrollment; X4 supplies framing/privacy/priority enforcement. X2 auth
proves a hub signing identity against membership, not a remote person's consent.
There is no invitation-secret or pre-enrollment endpoint here: X3 must supply that
control path before an invited hub opens its member data connection.

### Process and public verification

The command is `ahub broker serve [--hostname <host>] [--port <0..65535>]
[--public-url <ws[s]://host/>] [--owner <fingerprint>]... [--state-dir <dir>]`. Agent markers and `--live-test`
delegation refuse before importing the command. Help/parser/audit labels agree;
audit labels never contain path operands. Default bind is `127.0.0.1:8788`; port 0
asks the OS for an ephemeral fixture port. Default state is `broker/` beneath the
selected hub state directory, with an explicit machine-local override available.

The reference listener uses HTTP/WS behind operator-managed TLS termination.
Public audience is a canonical root URL without credentials, query or fragment;
`ws:` is loopback-only, and a non-loopback bind requires an explicit WSS audience.
Proxy `/v1/rooms/<room>` as binary WebSocket and preserve `Origin`. Every HTTP
request/upgrade carrying any Origin header, even empty, refuses. `GET /health`
returns fixed version/status only. Audience comes from startup config, never Host.
No proxy, certificate or firewall is configured by this command, and fixture
success is not a live TLS receipt.

`--owner` is a repeatable exact signing-fingerprint allowlist for first-roster
admission. Public WSS audiences (including loopback behind a proxy) and non-loopback
binds require a nonempty allowlist before storage/listener effects. Other owners
cannot consume a room slot or squat a room id. Existing room membership remains
pinned and is not revoked merely by changing this creation allowlist. Loopback with
no public audience may omit it for development; that open mode is a ceiling, not a
public service configuration. Do not expose open mode through a proxy.

`startBroker` awaits X1's minimum-Bun/capability self-test before database/listener
effects. `verifyPublicRoster` and `verifyPublicFrame` share X1's canonical signature
and pin checks. Their immutable WeakMap-issued products contain public ids, keys,
epoch/digest metadata only; byte accessors copy their storage, Buffer included.
They carry no epoch root, private identity, plaintext labels/exposures or body.
The broker never unwraps a key or opens ciphertext.

### Socket protocol

Input is binary canonical UTF-8 JSON: control cap 1 MiB, challenge cap 8 KiB, with
X1's smaller roster/frame caps still enforced. Unknown fields, alternate encoding,
text messages and invalid signatures refuse with fixed codes, no reflected input.

1. `/v1/rooms/<room>` emits `{v:1,type:"challenge",room,broker,nonce,expiresAt,rosterDigest}`.
   Nonce is 32 random bytes; deadline is local issue time + 10 seconds. Digest is
   current pinned roster digest, or null for a new room.
2. The hub replies `{v:1,type:"auth",member,roster,signature}`. New rooms require
   base64url owner-signed roster bytes and the owner's private-key proof. Existing
   rooms require `roster:null` and a signer in the current pinned membership.
   A non-owner cannot bootstrap a former member's old roster into a fresh room.
3. The Ed25519 transcript is canonical bytes of
   `["agent-hub.rooms.broker.v1","auth",challenge,member,initialRosterDigestOrNull]`.
   The existing digest is already in the challenge; the final array item is null
   for existing rooms. The client builder requires trusted expected broker URL and
   room. Thus audience, room, socket nonce, deadline, digest and member are bound.
   The server consumes its one-use challenge before await, then rechecks expiry,
   current membership/digest and socket generation before effects.
4. The broker sends current signed roster bytes and
   `{v:1,type:"ready",room,member,epoch,digest}`. The client verifies the roster and
   sends `{v:1,type:"roster_ready",digest}` before queue delivery. This ACK is flow
   control, not proof of epoch-key possession. New rosters require a fresh ACK;
   stale ACKs cannot restore authorization. One socket per room/hub is current;
   replacement closes the older socket and fences its awaited work.

Only an authenticated owner publishes newer X1 rosters. Owner fingerprint stays
pinned; older epochs and same-epoch digest changes refuse. Exact replays are
idempotent. An adjacent predecessor alone has grace: persisted successful local
installation time + 60,000 ms. Epoch gaps get no predecessor grace. Replays and
restart never extend the deadline. Removed/key-changed members disconnect; their
sender floors and inappropriate queued recipients are purged. During grace only
still-current sender/receiver keys authorize old frames.

### Bounded ciphertext queue

A raw X1 frame must match its authenticated socket's sender. After signature awaits,
the latest socket generation/current membership is rechecked. Store admission
again checks selected current/previous digest, grace clock, replay floor and caps
inside a synchronous transaction before writes. No unauthenticated frame persists
or fans out. Control and frame processing is serialized per socket, so ACKs may
wait behind an outgoing signature check without racing authentication state.

| V1 ceiling | Value |
| --- | --- |
| Rooms | 64 |
| Open sockets / concurrent handlers | 128 / 16 |
| Pending input per socket | 8 packets, 2 MiB |
| Pending input globally | 32 MiB |
| Queued packets per room / globally | 200 / 1,000 |
| Queued packet bytes per room / globally | 4 MiB / 32 MiB |
| Queue TTL | 24 hours |
| Per-socket native backpressure limit | 1 MiB plus the final message allowance |
| Roster ACK deadline | 30 seconds |

Storage holds original sealed wire bytes plus public recipient fingerprints. It
commits before `{type:"stored",digest,seq,duplicate}`. Sender sequence/digest floors
survive queue ACKs/restart: the last accepted digest or an identical retained older
packet is idempotent without requeueing; conflicting or
unknown lower sequences refuse. FIFO uses SQLite admission row order, never lexical
sequence strings or clock ties. Full queues refuse new packets without evicting
accepted ones. Prior-epoch grace may expire a packet before its ordinary TTL.

One packet per recipient socket is in flight. `{v:1,type:"received",digest}` removes
only that identity from the packet's remaining recipients, then returns
`{type:"queue_ack",digest}` and pumps the next packet. Unknown ACKs change nothing.
These are transport/storage ACKs, not D5's signed recipient application receipt;
X3 must handle completion and uncertainty in its journal. Disconnect/backpressure
retains only bounded ciphertext. Revocation, replacement, expiry and shutdown fence
pending work before storage or fan-out.

The versioned built-in SQLite store uses DELETE journal and EXTRA synchronous
commits, a private 0700 directory and 0600 database. Exclusive mode retains kernel
ownership until close; second processes fail closed, and crash releases ownership
without stale-lock unlink. Existing empty, malformed or unsupported state refuses,
never silently initializes new pins. Restore validates signed rosters/frames,
metadata and floors before delivery; expired grace is normal cleanup. See
[SQLite locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode) and
[exclusive access](https://www.sqlite.org/atomiccommit.html#exclusive_access_mode).
Native buffering includes the [Bun final-message allowance](https://bun.com/docs/runtime/http/websockets).

Schema v2 stores each queued packet's epoch as indexed metadata and has an expiry
index. Known v1 state migrates in place, retaining pins, floors, ciphertext and
admission order. Ordinary current lookups are pure; next/ACK use targeted metadata
expiry and only read the selected ciphertext, while timer/admission sweeps expire
indexed rows and bounded room pins without parsing every packet. Rotation inspects
only the changed room's authenticated metadata. Newly admitted packets obey the
4 MiB per-room share; existing valid larger queues are grandfathered and block new
admission until ACK/expiry reduces them, never evicted to retrofit the share.

Existing populated directories are accepted only as private recognized broker
state; unrelated files or non-0700 mode refuse without changing contents or mode.
Empty directories may be tightened to 0700. Offline operations require an existing
database and never create a new store to repair a misspelled path.

`ahub broker room drop <room> --yes [--state-dir <dir>]` is person-only, including
under `--live-test`, and requires the broker stopped: the same exclusive database
lock refuses an online attempt. It transactionally forgets only the named room's
pins, sender floors and queued packets, freeing its slot; other rooms stay intact.
This is an explicit broker-side room reset, not member revocation, secure erase,
or an application-delivery receipt. Clients retain their own pins/replay state.
Remove an unwanted owner from the creation allowlist before restarting, otherwise
that still-approved owner may bootstrap the dropped id again. Use a fresh room
lifecycle rather than deleting the whole database to regain capacity.

Logs/stats contain fixed event/error codes, public ids, counts and byte totals.
Canary fixtures separate the encrypting client from the broker process and inspect
transmitted bytes, retained ciphertext, database and logs. Only clients open the
body. This is an input/retained-state invariant, not a full runtime heap-dump
receipt or a claim that malicious input cannot deliberately contain plaintext.
Traffic analysis, availability attacks, malicious owners, same-user compromise,
hosted multi-tenant accounts and forward secrecy remain frozen exclusions.
X3/X4 integration and live TLS/account/X7 two-machine receipts remain separate.


## Encrypted rooms: X3 outbound membership and presence (#446)

X3 adds a machine-local `RoomStore`, an outbound `RoomLink` and person-only room
administration. The broker remains the X2 blind relay. No listener, remote bus
peer, chat egress, task sharing, permission relay or cloud/model call is added.
X4 still owns envelope screening, remote identity delivery, signed application
receipts and the application journal's completion/uncertainty lifecycle. X5 owns
room dashboard integration; X7 owns the person's two-machine live receipt.

### Person commands and out-of-band enrollment

The person runs these commands in an ordinary terminal, with a running local hub:

- `ahub room create <name> --broker <ws[s]://host/> [--label <id>]`
- `ahub room invite <name>`
- `ahub room join <token> [--name <name>] [--label <id>]`
- `ahub room invite <name> --accept <request>`
- `ahub room join <name> --roster <signed-roster>`
- `ahub room leave <name>`
- `ahub room revoke <name> <fingerprint>`
- `ahub room expose <name> [<peer>...]`
- `ahub room list [--json]` and `ahub room status [<name>] [--json]`

Names, labels and exposed ids are bounded ASCII identifiers. The label defaults
to `hub-<fp8>`, never a hostname. Broker audiences are canonical root WSS URLs;
plain WS is allowed only for literal loopback. Read forms publish only local room
names, room ids, owner/member fingerprints, epochs and link states. Agent shells
may read them. All mutations refuse agent markers and `--live-test`, including
conductor delegation. Daemon mutations require a console connection, and every
operation, unknown or refused included, answers its `rid`.

A mutation first prepares a connection-bound, one-use, 30-second ticket. The CLI
prints both owner and member fingerprints before executing it. The person must
compare them and explicitly confirm: a TTY asks y/N (default No), and a non-TTY
requires `--confirm <member-fingerprint-prefix>` with 16..64 matching lowercase hex
characters. No, EOF, missing or mismatched confirmation executes nothing. The
daemon also matches confirmation to the ticket's member fingerprint. The ticket binds
the captured action and arguments; execute accepts no replacement action/input.
Socket ownership, shutdown and recovery holds are rechecked after crypto awaits
and inside the final state transaction. Preview does not install a room or consume
an invitation. Creating a private local identity is not room enrollment.

The [X3 operand ruling](https://github.com/STAIxBWLB/agent-hub/issues/446) keeps
pre-enrollment out of the broker:

- The owner creates the room and prints an invitation with `invite <name>`. Only
  this invitation contains the one-time secret. Share it privately out of band,
  never with the broker, repository, shared logs or an agent.
- The joining person runs `join <token>` and returns the printed signed/HMAC'd
  request to the owner out of band. It contains neither the invitation secret nor
  any private key. The pending invitation pins room, broker and owner locally.
- The owner runs `invite <name> --accept <request>`. HMAC, signature, member keys,
  expiry and the invitation's original digest are verified before one transaction
  consumes it and installs the next signed roster. The committed roster is the
  recoverable publication; the outbound link sends those same persisted bytes.
  An identical accepted retry does not consume or rotate again. Changed requests
  refuse. Owner expiry is exact; joiner preflight allows the X1 ten-minute skew.
- The joining person imports the returned roster with `join <name> --roster ...`.
  Owner authentication comes from its own pending invitation, never from the
  broker or the offered roster itself. Exact own signing/agreement keys must be
  included. Subsequent explicit roster imports use the retained owner/epoch pin.
- A retry after saving a pending request returns the identical saved request when
  token, label and exposure selection agree, including after a lost CLI reply.
  A changed pending selection refuses. `leave` cancels a pending enrollment so the
  person can retry without editing private state. Expired pending entries are
  bounded and pruned on new admission.

A non-owner's `expose` prints a signed exposure request, bound to its installed
room, owner and roster digest. The member sends it out of band; the owner accepts
it with the same `invite --accept` form and returns the next signed roster. It
cannot change another member's exposure or be replayed after rotation. A later
slice may fetch an already signed roster from the broker and remove the manual
`--roster` step; this slice does not add that endpoint or trust the broker to enroll.

`rooms.<name>.expose` lives only in an untracked `.agenthub/config.local.json`.
Shared/committed configuration and generic settings cannot enable it. The live
local policy and the verified roster are intersected before any presence is sent;
loss of config trust removes exposure. Writable local policy is checked before
the owner's own exposure rotation, not only when saving the policy afterward. Empty exposure is the default. Room keys,
broker binding, pending invites and membership are private machine-local state,
not project config or synced memory. A hub stop closes links and retains membership.
`leave` disconnects locally and retains owner/epoch/replay pins; an owner uses
`revoke` to remove a former member from the signed room and rekey other members.
A person may explicitly import a pinned signed roster to reactivate a left room;
automatic link traffic cannot reactivate it.

### Durable state and outbound link

`<hub-state>/rooms/rooms.db` is schema version 1, SQLite DELETE/EXTRA with exclusive
process ownership and a 1 ms busy bound. Directory mode is 0700 and database mode
0600. Symlinks, hardlinked files, unrelated contents, unknown schema, corrupt or
unverifiable existing pins refuse, never initialize a new identity over old state.
Private keys remain opaque at runtime; only X1's explicit local storage codec is
used. This protects against other users, not a hostile same-user process.

Epoch installation compares the captured current digest in a transaction, refuses
rollback and same-epoch digest changes, and preserves only the adjacent predecessor
for local successful install time + exactly 60,000 ms. Restart/replayed rosters do
not extend grace. A persisted local clock high-water refuses rollback. Sequence
reservation commits before sealing and never resets on rotation. Replay atomically
checks current membership/keys, installed digests, local grace clock and sender
high-water, and persists the accepted digest plus inbox before returning plaintext.
Identical retained receipts may be duplicate; unseen lower sequences stay stale.
Gaps are recorded. Inbox bodies are removed after validated presence observation;
bounded digest receipts remain for duplicate handling.

Limits are 64 rooms, 128 invitations, 64 pending joins, 200 pending inbox records
per room, 16 MiB aggregate inbox bytes, 1,000 retained digest receipts per room,
256 retained historical sender floors per room (new senders refuse at the cap),
and host outbox ports capped at 200 records per room/16 MiB aggregate. Outbox broker
storage is only `accepted`, never application `completed`. X3 presence is ephemeral
and uses durable sequence/replay without filling the application outbox. Signed
application completion, nack and needs-review expiry are activated with X4 delivery.

Every link awaits the crypto self-test before dialing out. Authentication binds
its configured audience, room, broker nonce and membership digest. Current
owner/epoch pins are verified before roster ACK; an owner may republish a locally
newer roster after offline rotation without downgrading its pin. Non-owners never
bootstrap an empty broker room. Input is binary canonical JSON, serialized with
at most 8 pending packets/2 MiB per link, 1 MiB packet/backpressure limits and a
30-second handshake bound. Disconnects use jittered reconnect capped at five
minutes and do not block local work. Stop, leave, replacement and rotation fence
all awaited work by link generation.

Presence is an encrypted, signed frame containing only exposed peer ids and closed
idle/busy/paused/offline states. It is sent on connection and coalesced peer-state
changes, never titles, bodies, private task context or credentials. Unknown payload
types and unexposed ids refuse before replay commit. Broker ACKs are transport
facts only. A canonical room/recipient-bound frame that is refused or stale is
recorded in a durable metadata-only drop ledger before transport retirement ACK.
This does not accept plaintext, advance a replay floor or assert application
completion. Fixed refusal codes, digest and local timestamp are retained, capped
at 1,000 diagnostics per room; eviction removes only old diagnostic rows, never
cryptographic replay state. Wrong/missing session or membership authority and a
failed durable record produce no ACK. Noncanonical/foreign-room packets still
refuse without a transport ACK. Later valid packets are not blocked behind a
retired refused packet. A failed room state or crypto initialization disables rooms and leaves
local hub work available. Fake-hub/broker tests are not a live TLS/proxy or X7 receipt.


## Encrypted rooms: X4 screened chat and application receipts (#446)

This implements frozen D3/D5 from issue #446, comment 6242775004, with the
approved X4 refinements and R1 clarifications. X5 metadata views are described
below; X6 invocations and X7 live two-machine receipts remain separate.

### Egress and authority

Each signed-roster remote id is a host-owned `RemotePeer`, outside the native
adapter catalog. Its `deliver` calls `roomBoundary` once to build the outbound
view. Only explicitly addressed `chat` and `status` from an exposed local peer
or the local console may cross. The boundary refuses hub/digest/remote senders,
workflow kinds, private envelopes, a private sender turn, and PII or unknown task
references. Private-turn/task provenance is captured at enqueue and retained
while offline. An unknown authority check refuses; it never becomes a grant.

The screen reuses memory promotion's secrets, PII patterns and private-path
rules. When the model screen is enabled, the existing device/campus-only screen
owns model admission. Failure or an unknown verdict sends a fixed ids-only
withheld stub. Refs are removed. Immutable host proofs recheck current roster,
exposure, privacy and policy after awaits and before publication. No room payload selects callbacks, native effects or provider credentials. The
host's existing fixed-model configuration owns model choice.

X4 accepts at most **one remote target per send**. More than one is refused before
any local or remote effect, naming the targets and directing separate sends.
One remote target plus local targets retains local fan-out. Multi-remote support
needs target-derived stable wire ids and per-delivery cap accounting. Implicit
broadcasts never include remote peers. Remote delivery has one original, no
preface, no condensation and no memory observation. Incoming remote bodies are
also excluded from condensation/memory; emitted events and logs contain ids and
fixed stubs. Native/role/board/control/recovery actor paths refuse ids containing
`@`; a remote console sender is `user@label`, never the local `user` authority.

The private roster binds labels to fingerprints. Ambiguous global `peer@label`
addresses across rooms are inert. Queue recipient bindings survive active and
uncertain journal rows; neither a restart nor a person retry may substitute a
new fingerprint reusing the label. Unknown legacy bindings become uncertainty,
not newly inferred identity. Native peer delivery requires a current exposed
local native target. On an X4-only receiver, a reply to `user@label`
receives a signed `failed_safe/person_inbox_unsupported` NACK with the fixed
reason "person inbox not supported yet (X5)"; no person queue or admission is
invented. X5b below adds durable person admission; X5 metadata views alone do not.

### Encrypted application wire

X1 frames carry canonical version-1 `chat` or `receipt` payloads. Chat carries
id, trace, hop, local from/to ids, chat/status kind, capped priority, body and the
sender-claimed timestamp. Receipt carries the exact original frame digest,
application id, destination peer, closed outcome and fixed reason (including the explicit unsupported-person-inbox NACK). Unknown
fields or kinds refuse. Only the expected recipient hub's authenticated receipt
can settle an outgoing application. Receipt frames produce no application
receipt of their own. Incoming ids are fully validated before framing, bodies
use `sanitize`, priority is at most status, and sender/hub rate admission shares
one atomic limiter decision.

The first presence on a new link session may carry the optional encrypted,
signed boolean `requestReply: true`; absence means false. An accepted request
elicits one ordinary presence without that request, never a reply loop. This
refreshes discovery after a restart while the other hub's peers remain idle,
without a periodic heartbeat. A transient disconnect retains the last signed
peer states, but delivery remains gated on the current authenticated link and
roster. A roster change invalidates the cached states.

Ciphertext publication requires the ready socket's verified roster to match the
local installed roster. While a verified owner upgrades an older broker roster,
one canonical same-room, own-recipient ciphertext may wait inside the existing
packet/byte bounds while roster controls continue. It is not decrypted, replayed
or ACKed before ready for the current roster. Generic premature or second
deferred frames refuse.

### D5 settlement and bounded retention

`completed` means the remote hub durably admitted **one screened chat to its
exposed local peer's queue**. It does not mean native or model execution. Person
views say **completed (admitted)**. Broker `stored` means accepted ciphertext
only; a transport retirement ACK is not application completion.

Schema3 of the private `rooms.db` migrates schema1/2 without replacing identity,
pins, counters, floors or retained traffic. A receiver commits its crypto inbox,
then application `pending -> dispatching` before publishing into the separate
Bus journal. A crash or failure in that cross-DB publication window becomes
`needs_review`, with no automatic republish or fabricated receipt. Sender
`dispatching`/`accepted` rows become `needs_review` at restart. A same-process
reconnect drains never-handed offline queues once. A late signed receipt is kept
as evidence on `needs_review` and shown with the person's disposition view; it
never auto-settles. Known safe refusals retain the Bus's existing poison policy.

Signed seq/floors are the permanent primary replay protection. Duplicate seqs
are retired without a second admission; a known identical completed application
can resend its saved outcome. The extra `(sender, env.id) -> content hash` guard
refuses changed content while retained. Identical uncertain duplicates never
republish. Tombstones retain 30 days, at most 10,000 per room; at capacity the
oldest settled rows are evicted first. Pending, dispatching and unresolved
`needs_review` are never evicted. An all-unsettled cap refuses with the room and
count. Outside retention or after settled eviction, there is no historical
app-id dedupe claim; an old signed frame is still refused by its seq floor.

The trace high-water mark is kept for the tombstone retention (30 days / 10,000
per room, settled rows evicted first); outside it there is no historical trace
claim, and MAX_HOP 3 still bounds every trace. Before local admission a hop below
the retained maximum for that trace refuses; equal or higher hops remain allowed.
There is no second trace ledger. Sender timestamps do not order messages or
supply host expiry provenance; gaps are accepted and reported as signed frame
sequence counts, never waited on. They do not prove which chat bodies were lost.

Offline Bus queues count toward the 200-per-room ceiling before transport starts;
`hub_send` refuses beyond it. Original host deadlines survive handoff and restart.
Unknown legacy deadlines fail closed to `needs_review`. Machine-local
`rooms.ack_timeout_s` defaults to 600 (1..86,400); `rooms.queue_ttl_h` defaults to
24 (1..168). A single deadline-driven host timer handles ack/queue expiry. No
uncertain work is silently retried. Explicit terminal-history retries without
recipient proof refuse; the person can author a fresh message deliberately.
An expired or missing original enqueue deadline also refuses a person retry
before any disposition is recorded; a retry never invents a fresh TTL.

The ACK deadline starts at durable application handoff, before a broker `stored`
reply, and is never extended by that reply. An unstored frame therefore becomes
`needs_review` within the same ACK timeout instead of holding the peer for the
queue TTL. Known pre-admission capacity or journal-unavailable refusals retain
their pending plaintext for the next online/disposition retry without preventing
later room packets and receipts from being processed. Status reads apply no
disposition. Settled chat plaintext rows are pruned independently of presence
traffic; permanent floors and retained application outcomes survive that pruning.

The crypto inbox has a separate durable reserve of at most eight receipt rows
per room, each canonical receipt payload at most 1,024 bytes, with at most
64 * 8 * 1,024 additional bytes globally. Before taking a reserved slot, the
authenticated sender and receipt frame/application/peer must match this hub's
outstanding `dispatching`, `accepted` or `needs_review` outgoing row. Junk or
non-matching receipts cannot use the reserve. Normal chat remains bounded to
200 pending rows and 16 MiB; presence caps, signatures and floors do not change.
A matched receipt settles and frees its slot immediately. The durable
`receipt_reserve` marker preserves its admission across a crash after settlement;
open validates the canonical payload, size and reserve bounds and refuses an
over-cap store as corrupt. Migration marks every legacy row ordinary and never
infers reserved authority from its JSON.
At the physical cap only, an authenticated current-member receipt with no
matching outstanding row is durably recorded as the existing metadata-only
`invalid_frame` refusal and transport-ACKed, without advancing the floor or
sending a signed receipt. Below the cap its normal handling is unchanged.
A matching receipt with all eight reserved slots occupied remains unACKed until
a slot frees; it is never retired as junk.

At the ordinary physical cap, a fresh fully authenticated chat frame is durably
refused with metadata-only `invalid_frame` and transport-ACKed, without a floor
advance, admission or signed receipt. Its plaintext is not retained in the full
inbox. The sender's application stays unsettled and expires to `needs_review`;
matching receipts behind the refused chat can still reach the reserve. Known
exact-duplicate and stale sequence handling precede this fresh-frame cap check.

At the ordinary physical cap, a fully validated signed current-member presence
is recorded as metadata-only `invalid_presence` and transport-ACKed. It consumes
no reserve slot, advances no floor and produces no `onPresence` observation.
Runtime and other store errors remain unACKed. After room/global capacity has
space for the retired presence again, one coalesced `requestReply` presence
refetches the current remote state per drop-below-cap transition. There is no
periodic capacity poll or permanent reliance on a dropped state observation.

### Person disposition

`ahub room resolve <name> --frame <digest> --action accept|discard` uses the
existing console-only preview ticket and fingerprint confirmation. Agent markers
and `--live-test` refuse it. It records only local `disposed` metadata: the
person's action, time and actor. Accept means the person vouches that the local
peer got the chat; discard means drop it. Neither re-admits or republishes.
Views say **disposed (accept|discard, by person)**, never completed. A disposed
row is settled for retention/cap eviction, but never creates or resends a signed
completed/failed_safe receipt. A retained duplicate remains non-publishable.
Outgoing person queue dispositions likewise do not manufacture remote proof;
late signed proof remains evidence-only.

Explicit room status is metadata-only and bounded: up to 200 outgoing rows
prioritizing unresolved traffic, up to 200 incoming rows with uncertainty first,
counts/truncation and remote addresses/states. Native turns, task roles and
recovery sessions are never invented for remote transports. Real TLS/proxy,
account and two-machine X7 proof remain unverified until their own live legs.

## Encrypted rooms: X5 metadata views (#446)

The console's Rooms panel (`8`) and the dashboard's Agents > Rooms section are
read-only views of the same canonical room metadata: local room name/id, epoch,
owner/self fingerprints, member count, link state and exposed remote peer
ids/states. Missing room metadata from an older hub and an empty room list hide
the views; unavailable metadata is explicit rather than retaining old readings.
Status reads create no room storage or keys.

Relay counters describe only this daemon session, starting at daemon startup and
resetting on restart. Outbound counts successful handoffs; inbound counts
confirmed local admissions. Withheld counts are a subset of outbound handoffs,
not an additional total. Missing or unreadable values stay `null`/unknown, never
zero. These counters do not prove application completion or lifetime traffic.

The projection contains no message body/title, reason, broker URL, key material
or delivery history. This projection never reads a person inbox body; X5b below
provides that separate person-only CLI. Native/account and X7 two-machine
receipts remain separate live verification.

## Encrypted rooms: X5b person inbox (#446)

Authenticated eligible chat to local `user` is admitted to a durable person
inbox, separately from native peer delivery. The signed
`completed/inbox_admitted` receipt, displayed as **completed (inbox)**, means
durable inbox admission only. It does not mean the person read or acted on it.
Admission, duplicate identity and receipt commit together before publication;
duplicate frames cannot admit or count the message again. Done, discard and
expiry never change that receipt or manufacture another outcome.

The RPC gate admits only the console role. As with X3 room mutations, the CLI
refuses agents, conductors and `--live-test` before connecting. A console RPC
connection carries no delegated/live-test marker, so that flag is not independently
classified at the RPC gate. Dashboard, status, logs, memory, models and observers
receive no inbox body:

```sh
ahub room inbox [<name>] [--json]
ahub room inbox show <id>
ahub room inbox done <id>
ahub room inbox discard <id>
```

One operand always names a room, including `show`, `done` and `discard`; only
an action followed by an exact local inbox UUID performs that action. Only the
metadata list accepts `--json`; none of these forms accepts `--confirm` or adds a
fingerprint prompt. Show returns one untrusted framed body through `sanitize`
and terminal control stripping, and never marks it done. Done/discard are local
metadata changes and immediately purge the body. Expired or disposed entries
show metadata stubs only: no archive or read-after-done path exists.

A person done/discard commits and replies before firing a background retry, so
a retry failure or socket drop during that work cannot change its acknowledgement.
It and an actual TTL purge create one capacity-release opportunity for existing
X4 deferred traffic. The disposed or expired entry gets
no new outcome or receipt; unrelated authenticated pending chats may resume.
Idle expiry ticks never retry or poll retained plaintext.
Cleanup performed during show or admission retains a committed purge signal until
the host consumes it once; rollback restores the prior signal.

Limits are 100 unread messages per room, 64 KiB decoded body per message and
4 MiB retained canonical payload bytes globally (the stored BLOB length, including
JSON envelope overhead and escaping). Metadata `bytes` remains decoded UTF-8 body
size. The existing 64 KiB entire
application-wire cap is unchanged, so envelope overhead makes the actual
sendable body smaller. Schema 4 records the first durable local crypto arrival;
the inbox TTL is 30 days from that time, not the remote timestamp, admission
retry or restart. Legacy pending person traffic with unknown local arrival age
receives fixed `failed_safe/inbox_age_unavailable`; native peer handling is
unchanged. Other fixed refusal reasons are `inbox_full`, `inbox_oversize` and
`inbox_expired`.

Retain up to 1,000 settled metadata stubs per room for 30 days after settlement,
evicting oldest settled stubs first. Unread messages and their matching admission
identities remain protected, as do unsettled identities under the shared
10,000-per-room application cap. Inbound session counts increment once at
admission, never on duplicate delivery, show or disposition. One 30-second
loaded-state daemon hook expires bodies even when all rooms were left; it opens
no empty store and creates no keys.

Lists return complete metadata, with at most 1,100 rows (100 unread plus 1,000
stubs for one filtered room). A larger global list explicitly refuses with
`inbox_list_limit` and guidance to choose a room, never silently truncates.
ponytail: this complete-list ceiling keeps the first slice bounded; pagination
is the follow-up for cross-room inventories. Inbox reads and dispositions refuse
during recovery or a Bus hold in this slice.

Bodies are plaintext in the private local store under its existing directory/file
modes; this adds neither at-rest encryption nor secure-erasure guarantees.
Older X4 codecs reject the new receipt reasons and leave their sender outcome
uncertain; no mixed-version success is claimed. Native/account and live
two-machine receipts remain separate verification.

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude channels are research preview; flag or protocol may change | Adapter isolated in one file; plugin version pinned to a Claude Code range; `hub_inbox` fallback |
| Model routing algorithm drift | In-process golden tests, Apache-2.0 notices and upstream provenance check |
| Anthropic-to-chat translation drops `tool_use` | Claude never runs on local models in this design |
| Local worker executes untrusted room text | Untrusted framing, cwd scope, denylist, no `--unattended` by default |
| Steering a Codex turn changes its plan mid-flight | Only `important` steers; default tier is `status` |
| Kimi ACP has no quota API | Optional token soft ceiling plus the observed five-hour provider refusal as a hard source; conservative reset, other limits unverified |
| claude-mem worker API is internal and unversioned for third-party clients | Client isolated in `src/memory/`, pinned to a plugin version range, fail-open everywhere, contract test against a fake worker plus one live smoke |


## Post-milestone amendment: local dashboard (issue #6)

Owner instruction to implement issue #6 approves its local, read-mostly dashboard.
The session/origin model is defined in `docs/security.md`, written before the code.
`ahub ui` lazily opens an ephemeral loopback listener and exchanges a single-use
fragment ticket for an HttpOnly, SameSite=Strict browser session. The control link
retains its blanket Origin refusal. The browser receives no control token.

One static HTML file, without a build step or runtime dependency, polls public
snapshots once per second. #391 Task A keeps this `/` surface and poll while
splitting its sections into Board/Office/Stream/Agents/Message/Memory/Settings
views with a cookie-backed selection. Compact task cards open a native dialog;
one `taskDetail` function renders both the dialog and expanded-column cards.
Filters, exact-id attention navigation and existing workflow controls remain. The latest 200 redacted bus events are retained only
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
snapshot/action forwarding. Existing project-local UI security rules still apply. #391 Task A changes only client view selection;
project/instance fencing still invalidates open task details and stale controls.
No additional project route, request or timer is introduced.


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
  request keeps the console path unless the person opts into the permission modes
  below (issues #240, #242); `allow_always` is never chosen automatically.
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

## Amendment: operator permission modes (issues #240, #242)

- Modes: ask leaves native decisions unchanged; ask-when-needed uses native
  Kimi/Codex policies or scoped Claude/Pi/local grants; never-ask suppresses
  prompts within each peer's existing execution boundaries.
- Runtime CLI permission changes are refused from ordinary agent shells.
  Never-ask needs --yes; console mode selection needs a separate y. These
  policy/role checks do not contain a hostile same-user shell: Kimi can clear
  markers, use --yes or read the control token and impersonate the console.
  The security and operations guides name that boundary explicitly.
- permission_modes defaults merge per peer across config files. Automatic
  effects stop at ask-when-needed. Never-ask from an applied untracked config remains ask until
  a person's source-labelled console y at hub start; no boot --yes applies it.
  Git-tracked mode defaults are ignored and never offered for confirmation.
  Every non-ask start logs mode and source (config file or runtime choice). Successful
  runtime changes clear pending config confirmations; startup choices are reconciled
  under the peer fence before a new adapter is exposed to bus delivery. Runtime changes and
  confirmations remain daemon-local and expire on stop.
- Newly added native peers replay their non-offline state to drain queued work,
  publish state telemetry and persist sessions. Offline/absent ask clears only
  the hub choice. Unattended metadata is saved after successful startup, and
  concurrent joined starts with different flags are refused. Refused default
  confirmation remains handled until state changes; Esc defers without declining.
- Kimi mapping requires the actual Kimi Code CLI identity: yolo for
  ask-when-needed, auto for never-ask, default for ask. Another ACP agent starts fresh or resumed as unmanaged: its reported mode is
  untouched, and runtime changes are refused until its table exists. Set-mode replies precede prompts;
  missing ids/refused startup changes fail. A timeout is unknown/offline and
  the owned process group stops, so a late reply cannot restore a live peer.
  Loaded non-default Kimi modes are reset for project ask.
- Codex overlays on-request/never on every outgoing turn/start without changing
  sandbox fields. Ask restores a known native policy once after an accepted
  turn; rejected restoration remains pending. Restoration debt and captured
  policies are per thread and survive proxy detach and thread/start or thread/resume.
  A known restoring turn retains its baseline even if the TUI echoes the resumed
  response's sticky override, in any hub permission mode. After restoration is
  admitted, a later repeated TUI policy is indistinguishable from an explicit
  native choice and passes through; only the restoring turn is protected.
  Unknown native baseline refuses restoration while attached, with instructions
  to close the TUI and run `ahub permission codex ask`; detached ask succeeds and
  returns a CLI-visible note about the old thread's unchanged native policy. Actual native unattended flags, not broker-wide flags, govern
  the refusal to change a bypassed session.
- Claude ask-when-needed allows only Read/Edit/Write/MultiEdit/NotebookEdit/LS
  and bounded Glob/Grep targets resolved with realPath beneath project root,
  outside .agenthub/.git/.claude/.codex/.qwen/.kimi/.kimi-code/.pi/.mcp.json. Missing/nonresolving or escaping targets,
  protected case aliases, symlinks and uncertain wildcard/filter targets yield
  no decision. Never-ask answers allow; ask and transport errors decide nothing.
  Merged/generated settings are 0600 state files passed by path, never inline
  in argv. Preview writes no settings file. The owning launcher removes its settings file
  after native exit; earlier active or unknown launchers retain theirs. Verified
  dead wrapper and native identities permit crash fallback cleanup. Direct binary
  launches publish the native child PID/signature while running, bound to the exact
  launch record; crash cleanup additionally requires its PID absent from a verified
  process table. Script/interpreter native ownership remains unknown. Without
  separate native identity proof, prior files remain for manual inspection. Every
  launch atomically publishes its managed hook/session record without depending
  on the native-proof lock. Exact-binding native proof is stored separately, so
  an old callback cannot replace a later launch record. The populated signed
  native-proof lock waits up to 250 ms for a live owner; an unknown/busy lock
  disables only native identity/crash cleanup with exact-path guidance. Managed
  hooks keep working for the current launch.
- Permission-only Claude PreToolUse never drives busy state. Only the former
  observation purposes retain native turn bookkeeping. Hook identity/purpose
  are launch/session bound; unverified hook status reads unverified.
- Pi/local read never asks. Ask-when-needed grants write/edit inside the project, outside the shared native
  configuration segments (.claude/.codex/.qwen/.kimi/.kimi-code/.pi/.mcp.json, compared folded and by the path within the
  project) and never through a hard link; bash and mutating
  git retain console approval. Never-ask grants once, retaining sandbox and
  path guards; no mode gives allow-always. ACP tools have no hub sandbox and
  the never-ask confirmation names that difference.
- Console-role permission and permission_default requests are additive;
  ordinary tools/conductor/messages cannot change or confirm modes. Status
  includes non-ask/unverified/unknown mode state and pending defaults; facts
  replies include permission and authenticated projectRoot. Unknown requests
  are answered, so PROTOCOL remains unchanged. permission_mode events retain
  schema 1 and include only peer/from/to, never tool arguments.
- Live benign Kimi/Claude results and unverified Codex/Pi limits are recorded
  in docs/smoke.md. No extra account prompts accompany these review corrections.

## Always-ask action foundation (#636 slice 1)

This slice provides the pure classifier, machine-local policy, host-only per-session budget ledger and per-peer status. Adapter pre-tool enforcement is a later slice. Until a runtime actually consumes the policy before execution, its status says `always-ask not enforceable: adapter integration pending`; native modes, sandboxes and approval frequency retain their existing behavior. The default-on configuration is not a claim of active enforcement.

- `action_policy` may be set only in untracked `.agenthub/config.local.json`, never in `config.json` even when that file is untracked. `ALL_MACHINE_LOCAL` trust drops a tracked/unknown local source. Default: `enabled: true`, all four classes in `always_ask`, budgets `publish: 1`, `destroy: 3`, `external-write: 5`, `install: 2`. Budgets are integers 0..1000; zero caches no follow-up grant. Empty `always_ask` selects no classes. The settings registry exposes enabled and each budget; the closed class set is changed in the local file with a person-confirmed reload. Weakening on live reload requires existing person confirmation; shared-file policy edits are refused before any confirmation offer. Startup adopts the untracked local policy without a retained confirmation and surfaces attention in status when it disables enforcement, omits a class or increases a default budget (ponytail: retain a person-bound startup confirmation). Reload never imports code or changes a sandbox.
- `classifyAction(tool, args, executionRoot)` returns all matching classes for bounded literal tool/argv or shell forms. Quotes, command/group separators, fd duplication and plain input/output redirections are parsed without evaluation; known wrapper prefixes and literal shell -c forms are unwrapped. Multi-class chains retain every class, so narrowing the ask set cannot hide another class. Publish covers remote Git/package/release publication, external-write covers known non-read HTTP/gh/mail/chat calls, destroy covers destructive Git and recursive deletion/force-overwrite outside the lexical execution root, and install covers known global installs. Unsupported syntax stops parsing while retaining classes from earlier complete segments; the unsupported current segment remains unknown. Hard input/segment limits still return no classification. Unknown forms retain native policy, never an automatic permission. Literal cwd/workdir, home spellings conservatively treated as outside, and conservative literal cd candidates are covered; aliases, functions, expansion, scripts and symlink targets are not attested. The ceiling is bounded syntax/lexical evidence; the upgrade path is typed native tool arguments and canonical path evidence from each adapter.
- The first selected action asks. One explicit person approval of the class allowance authorizes that invocation and caches at most budget minus one follow-up invocations of each selected class. An ordinary allow_once answer never seeds this cache; adapter prompts must describe the class allowance they request. The next invocation after exhaustion asks again. Requests consume all selected class slots synchronously or none; an unselected/unclassified action returns `native`, which means the existing permission decision still runs. No ledger result overrides a denial, suppresses a prompt required by the native mode, or grants a tool capability. Session identity comes from the host's current runtime port; missing or changed identity cannot use a grant. New sessions, owner revocation and policy publication invalidate grants. One-use approval challenges are bound to the exact session handle and policy, so a late answer cannot grant to a replacement session or changed policy.
- Status reads never create/bind/reset a session. Status carries only classes, limits, remaining counters and enforcement state, without native session ids or command/task text. Approval copy is built through `actionApprovalText`, which takes the host's `publicView`, private-turn decision and whole-command privacy projection; private commands are withheld. Adapter integrations must retain the existing timeout-denies and generation/privacy rechecks after awaiting a person. Slice 1 creates no approval requests itself and makes no per-adapter A2 or live/native enforcement claim.

## Always-ask enforcement: Claude and ACP (#636 slice 2)

- **Claude.** The `facts` reply to a PreToolUse hook call carries `actionClasses` when `classifyAction` classes the tool and its arguments under the peer's execution root and the policy selects at least one class. `factsHook` then emits `permissionDecision: "ask"` (with `permissionDecisionReason: "agent-hub always-ask: <classes>"`) in every permission mode, and the `ask` replaces any `allow` the mode would add. The managed hook's contract is therefore: it may add `allow` as before and `ask` for a classed call, never `deny`; a hub that is down, slow or refusing decides nothing (`docs/agent-notes/daemon.md`). A value that is present but unreadable asks as well; an absent or empty one leaves the mode. Claude's dialog cannot carry a class-budget choice, so the ledger is never consulted for Claude: every classed call asks. A hub that cannot answer, or a call outside a verified hub hook, leaves Claude's own policy.
- **ACP.** `AcpPeer.answerPermission` consults `AcpOptions.actionGate` before `autoApprove`, with the announced and canonical tool names, the ACP kind and the arguments from `rawInput`, the announced `tool_call` or complete streamed JSON. A call with no reported payload is not classed (unknown follows the mode). A verdict (a classed call with no session budget left) is never auto-approved, drops `allow_always`, replaces the title with `actionApprovalText` (the task title only through `publicView`, the command only through the PII screen, withheld for a private turn or an open PII task) and sets `classed` on the `PermissionRequest`, so `--unattended` does not answer it. A throwing gate asks. The request uses the existing approval timeout and a timed-out request denies.
- **Class budget.** When a selected class has a budget above one, the request carries the hub's own option `agent-hub:action-budget` (kind `allow_once`). Only a person's choice of it calls `ActionBudgets.approve`, which spends the allowance for the current native session and policy; the agent is answered with its own `allow_once` id and never sees the hub's. A refused approval (changed policy, replaced session, no slot left) answers cancelled. An ordinary allow never seeds the ledger. Requests are concurrent, so several challenges can be open while a class is spent: the first approval opens the allowance, a later approval of a challenge issued before it consumes one slot instead of opening another (refused whole when any class has none left), so a budget of N lets through at most N approved calls. The ledger entry is revoked whenever an ACP owner goes offline, is stopped or removed, or a new owner is created, so a resumed session id never brings an allowance back. A call inside the cached allowance follows the permission mode as before.
- **Visibility.** `status.actionPolicyInfo[peer].enforceable` is true only where the call is seen before it runs: a Claude session with the launcher's PreToolUse hook that is not `--unattended`, and a hub-owned ACP peer in native mode `ask` (Kimi's `yolo` and `auto` send no request for a call they allow). For Claude the launch record alone is not proof (it outlives the process): the attached session must be online and its current generation must have run the hub's hook (`claudePermissionGenerations`). Live local/Pi tool boundaries and a managed headless Claude implementer with a current busy child generation are enforceable. Codex remains conservatively not enforceable because native policy may omit a request; every other peer without a hub pre-tool path says `always-ask not enforceable: <reason>`.

- **Remaining adapters (#636 slice 3).** Codex command approval RPCs (v2 command execution, excluding writeStdin, and legacy exec argv) consult the shared gate before native forwarding. A classed request is answered only once, bound to its link/thread/turn; cancellation, disconnect and stale answers deny. Unknown payloads and other approval schemas retain native handling. This proxy cannot intercept a native call that emits no request, so status never claims complete Codex enforcement. Local/Pi tools pass parsed arguments into their existing permit boundary and classify before mode or tool-wide grants. Pi's persisted call receipt encloses the gate, so replay spends no allowance twice. Only verified person-authored idle shell requests retain their existing bypass.
- **Rendered approvals.** Public/native command views are privacy-screened before rendering. A cut or withheld view offers deny only and cannot authorize even one invocation or a class budget. Local/Pi use their exact full host-generated tool title with a class line on the person's on-prem console, PII turns included; logs, public status, other peers and dashboard projections still withhold it. The same explicit class-budget choice, session/owner revocation and final-answer fence apply to received Codex, local and Pi approvals. Managed Claude forms keep asking through their native prompt path.

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
  output and is not waited for. A check killed at the timeout or on shutdown
  settles 1 s after the kill even if its exit and pipes never report
  (#558). The runner starts the command with `Bun.spawn` and reads its exit and both
  pipes as values, not `node:child_process` events: under `bun test` on a loaded
  macOS host the node layer can reap a quick child inside `spawn()` and emit its exit
  and close before any listener exists (oven-sh/bun#45483), which made a trivial
  check report a timeout and an empty tail after its limit plus the grace. Exit 0: the task
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
  config turns them on. The daemon shares a monotonic 250 ms Git budget across a
  synchronous boundary burst, including repository/HEAD probes and end diffs. Each
  subprocess timeout uses only the remaining budget. Exhaustion or failed diff
  evidence records an unknown boundary, emits a diagnostic once per burst and
  grants no undo/attribution; I/O gets a turn before a new budget is available (#576).
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
- Overlap (#476): each task has one repository key, chosen from explicit
  `refs.repo` (GitHub owner/name slug or checkout path), else the common Git
  top-level of outside-project absolute refs (bounded hardened Git and realPath),
  with common-parent fallback, else this project. Confirmed GitHub remote slugs
  connect path/SSH/HTTPS aliases; without that evidence a path key stays distinct.
  Relative plan paths belong to that task's key. Paths from refs and plan (same
  file or directory prefix), symbols, sections and sources are compared only
  within one key, including contradiction, replay and held-change comparisons.
  Existing project-only display spelling, notices, cohorts and telemetry stay
  unchanged. Repository/root and failed Git probes are cached for the daemon's
  lifetime; new metadata resolves new inputs, and a restart refreshes prior probes. No network
  lookup, directory scan, execution-root change or filesystem grant is implied.
  Propose reports one ids-only notice when refs and absolute plan evidence name
  different repositories. Both propose and accept tools expose `refs.repo`;
  acceptance may correct that repository metadata only, with ordinary authority,
  privacy, spec and plan gates retained. A changed repository leaves its previous
  cohort before joining any new same-repository overlaps. An overlap that only the new plan reveals on
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
  would wait stores that owner as the task's reserved owner (issue #207 below
  replaced the refusal this bullet first specified).
- Approval, by review or by a class without a reviewer, releases the
  dependents that wait for nothing else; each is recorded as `ready` and assigned.
  A proposal re-reads what it waits for after its insert, since triage may have
  awaited an approval. An approval is saved before its dependents are assigned,
  so the daemon's 60 s release timer sweeps for ownerless tasks whose last event
  is `blocked` or `ready` and that wait for nothing: each is offered once per hub
  run, once an attached peer can take it, outside recovery operations. An offer
  is used up only by an assignment, after an approval and on the timer alike;
  failed dependent reads, ready writes or assignments do not escape a saved
  approval. Their notices are best effort because notification can read the
  same unavailable board. An ownerless task stays eligible once a peer can take it.
- Readiness respects the reserved owner's planner WIP cap (#655). A ready task is
  handed to its reserved owner only while that owner's `wip()` (plus claims in flight)
  is under `wipLimit()`, the count `accept` refuses at. Otherwise the task keeps its
  reservation, stays ready in To Do (no owner, no offer, no stall) and the hub records
  one quiet `ready held` history entry naming the owner and its count; later passes add
  no second entry. Dependents are offered in priority (none is P2, `urgent` is P0), then
  rank, then id order, so a free slot goes to the first of them. When an owner's slot
  frees (an approval of its task, a cancellation or an untouched return to backlog), its
  held ready tasks are offered in that order and the cap stops the offers; the 60 s
  release timer does the same for a slot freed any other way. Planner-pulled work was
  admitted by its pull and is not held, a reservation the task excludes is not
  honoured by routing and holds nothing, and the idle sweep's automatic reassignment
  never overrides a hold. An offer takes its reserved owner's slot in the same
  synchronous step as the cap check, before assignment can yield, so concurrent
  offers cannot exceed the cap; the release timer also offers a held task whose
  latest move is a planner edit.
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
  `remember`, `memory_correct` (screened correction candidates only, never acceptance), `memory_read` (the `hub_memory_search`, `hub_memory_show` and
  `hub_memory_graph` read tools, #412 P2), `important`. A peer not listed in `capabilities` has all of them,
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
- `needs_review` holds uncertain work that still matters. The hub settles a row `completed` only when every original is a hub presence item or a hub task/review notice provably moot for its recipient: an approved or cancelled task (except its cancellation stop notice), a review no longer in review for that reviewer, or a notice whose authoritative `refs.taskRecipient` audience (`owner` or `reviewer`) is no longer current. Hub producers tag current-owner notices, reviewer reminders and planner coordination separately; former-owner stop notices and former-owner/former-reviewer withdrawal notices use untagged kind `task` and stay held until task approval or cancellation, because their purpose is to tell the former role to stop. An owner task offer (kind `task`, `refs.taskRecipient: "owner"`, positive safe-integer `refs.taskOffer`) also becomes moot once that recipient still owns its task in `in_progress`, `in_review` or `changes_requested` and its own `accepted` entry follows the latest ownership event. A person's assignment or acceptance does not count for the peer; a replacement-owner offer under review stays live until that peer accepts. The pure check inspects at most 4096 recent history entries, with absent or out-of-bound proof retaining the hold; approval/cancellation keep their existing rules. The ids-only reason is `superseded: task #N accepted`. This applies on hold entry, restored startup, recovery release and board changes, using the same hub-actor resolution path; it never records an offer read or changes the task. A plain owner reminder without the offer marker, an unaccepted offer and any mixed peer/user row stay held. Task-kind reviewer reminders remain live while the recipient is that in-review reviewer. Planner notices and untagged legacy task-kind notices stay held until approval or cancellation: without an audience marker, sender/kind/task id cannot prove that an owner assignment moved. This conservative legacy ceiling preserves still-live coordination and guidance. Unknown tasks, live recipient notices and mixed peer/user rows remain held. Rows whose recorded reason starts with `requested stop:` are never completed automatically, even when their tasks become approved. `supersededDeliveryReason` alone authorizes completion; a separate pure `deliveryTaskContext` retains ids-only approved/moved task context for mixed rows without authorizing settlement. Status, console notices and console/peer/tool route explanations list every hold once, including sender, kind and age; public explanations screen appended hold lines through the current privacy policy and keep task context ids-only. Classify on entry, after restore, after the daemon releases its recovery hold and on board changes; use the existing resolve path with a recorded hub actor, preserving pauses and Tasks state. Hub completion restores presence originals through the same preface merge and transaction rollback path as retry, preserving shared notes for the next queued delivery; person completion remains consumed (#434).
- A Claude session without channel support returns `failed_safe` before the push reaches the model, preserving originals for pull. If an older daemon rejects that receipt, the plugin falls back once to its prior generation-bound `needs_review` receipt instead of leaving the row dispatching. A thrown `server.notification` remains `needs_review`: the MCP SDK delegates to a transport whose stdout write can already have emitted bytes before an exception is observed, so the exception alone cannot prove no frame left. Existing proven pre-acceptance guards in Codex, ACP, Pi and the local worker remain unchanged. Console-only command refusals name only the inherited identity marker keys actually present (never their values), explain `!` commands, and direct the person to a separate terminal or `ahub console` (#434).
- `hub_delivery_retry { delivery_id }` lets an authenticated recipient retry only its own current `needs_review` row. This option is offered only to transports with an independent tool turn (Claude channel/pull, Codex and Pi). The delivery-only local worker and headless ACP peers cannot start a tool turn through their own hold, so they do not advertise this tool and the daemon refuses a manual call before mutation. Their held hints ask the person to resolve the row; ordinary messages never bypass the hold. Kimi TUI remains pull-only and keeps the recipient option. An ephemeral delivery-only MCP marker controls exposure and hint copy only; the current adapter class is the authority. There is no action or reason input: `completed` and `discard` remain person-only. Any explicit retry in that recipient's lineage, including a person's retry, consumes this allowance; a redelivery held again stays for the person. The existing resolution transaction records `peer:<id>` and a fixed reason, keeps original envelopes unchanged and requeues them through the existing put-back path. A busy recipient may consent to this queue-only operation, but delivery waits for idle and all pause/recovery and active-delivery fences remain. The rendered clone reserves the existing journal body cap for the warning, clipping only the clone at a Unicode character boundary with an explicit cut marker when needed; originals remain unchanged. Jcode project MCP entries carry the same delivery-only exposure marker as other headless ACP peers, preserving their own configuration and peer identity rules. Final rendered output, after condensation and on pull or steer, starts with the fixed sanitized header `Hub redelivery warning: An earlier attempt of this delivery is uncertain; check for its effects before acting.` Explicit retry history is scoped by recipient and original envelope ids. A separate monotone consumed-proof projection records one proof id and warning provenance per original, leaving resolution audit rows unchanged. Explicit resolution and coalesced handoff inherit that proof atomically for every grouped non-context original; a rejected checkpoint consumes no fresh allowance. Hub presence originals carry mutable recall/shared context whose id survives merging, so their ids never participate in retry proof lookup, inheritance, warnings or unknown marking. A preface shared with earlier work cannot consume an unrelated new message's retry allowance; actual task/chat originals retain their consumed lineage. Safe-failure requeue, withdrawal of an earlier original, terminal-state changes, pruning, restart or older-writer audit replacement cannot renew the allowance. Older attempt-bearing rows backfill this projection on return. Recovery snapshots without history and unmappable pruned pre-feature retry records mark only their affected recipient/original ids unknown: those lineages require a person, while unrelated new messages keep their allowance. Tool results expose held metadata only (total count, ids, senders, kinds and age), at most 32 rows/4 KiB with explicit truncation; no body or task text enters the hint. These hints work independently of channel mode and do not wait behind the held queue (#434).
- Local attach and idle model/route replacement require a reachable authenticated gateway, served models and successful minimal availability calls. Busy workers refuse replacement; validation failure leaves the current worker intact. Controlled recovery can reconstruct a manually paused local worker without gateway availability, but manual resume validates its restored choice before lifting the pause. Doctor checks the fixed model against the inventory.
- Reviewer routing appends attached peers holding `roles.reviewer` after the review class's candidates. Without a reviewer, task results and console notices explain direct approval and the skipped candidates.
- Conflict detection includes `in_review` work. Completed overlapping snapshots that share files compute one concurrent-edit change set across the completed overlapping turns and publish at most one conditional notice per affected task, containing both turn ids and attributing the changes to neither peer. Per-task-pair events remain research evidence, while notice persistence grows linearly in the affected tasks (#576). A bounded, per-worktree HEAD reflog cursor classifies moves appended during the turn. Incoming checkout, merge, pull and proven fast-forward reset paths are excluded from attributed changes and undo paths; normal peer commit, amend and cherry-pick paths remain attributed, as do sequencer pick/reword/edit/squash/fixup/continue/finish paths under native command prefixes. The start checkout of rebase or pull --rebase classifies incoming paths from `merge-base(old, upstream)..upstream` instead of `old..upstream`, so replayed own commits do not overlap and true upstream paths are excluded (#612); any remaining path overlap or ambiguity stays unknown, never attributed as upstream work. Fast-forward reset stays incoming even if its descendant target contains commits made by the peer in another worktree during the turn, safely excluding external commits from local turn attribution and undo (#612). Paths still dirty between end HEAD and the end workspace snapshot are never excluded (including autostash and checkout -m). Independent working-tree edits remain attributed. Missing, rotated, truncated, unrecognized or ambiguous move evidence is unknown, never an exclusion; paths shared by own and incoming moves are ambiguous. A HEAD change during snapshot capture makes that capture unknown. Status probes the checkout branch once per synchronous burst, then screens the cached raw branch through the current privacy policy for every rendering; the cache ends before the next control turn. Pi terminal reconciliation reads an owner observation maintained by the existing 500 ms monitor and expiring after 1 s; fresh signature checks remain mandatory at tool/effect admission and teardown. Private tasks and sensitive file names remain redacted.
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
`ahub queue` commands; #434 also permits an addressed peer with an independent tool turn one explicit
`hub_delivery_retry`, with the transport, warning and lineage limits above. Older source protocols 9, 10 and 11 remain authenticated
upgrade sources; ordinary clients must use protocol 12 (13 from 0.12.4, with 12 a source).

## Amendment: stale overlap notices (issue #106)

- The completed-change notice (#31) and the edit-conflict notices (#32, #91) are about an open task of their recipient. `Tasks.whileOpen` publishes each to one recipient and remembers the condition (the newest 1024). The bus asks `Tasks.relevant(peer, env)` per recipient when it builds a delivery and again right before it hands the delivery over, after condensation; it is false only for a recorded notice to that peer whose task is gone, has another owner, or left the states it was about: `proposed`, `in_progress`, `changes_requested`, and for conflict notices also `in_review` (#91 reports conflicts with work under review). A dropped copy is a journal row `discarded` with `stale: task #N is no longer open for <peer>`, a `STALE` log line and a `stale` event; other recipients and other deliveries are untouched.
- An envelope without a record (another kind, a restart, an evicted record) is delivered as before: its purpose is never guessed from its kind. Assignments, approvals, check results, review requests and budget, permission and recovery messages are never conditional.
- The ablation is the advisory arm with and without stale-notice dropping on the same release (`manifest-v2-ablation-106.json`, #110); comparing with 0.12.3's advisory runs would confound it with that release's Codex hooks.

## Amendment: turn-free cohorts (issue #107)

- `coordination` in the project config: `"advisory"` (default) or `"turn-free"`; anything else is advisory with a log line. While a PII task is open the project is advisory.
- `src/hub/cohorts.ts`: owners of overlapping open tasks (#31) form a cohort when the overlap is found (assignment, an accept with a plan). Members are tasks with their owner and owner generation (ownership events); every change of membership or owner, a withdrawn intent and a lift bump the cohort's revision. A cohort is silent if, when formed, every owner's context path is verified (#108); it never becomes silent later, and it is lifted for good (members still at work told at once, with the held notices) when an unverified owner joins, a path is lost or a PII task opens. Cohorts live in memory: after a restart, each peer's first attach tells its open overlapping tasks that overlaps are settled by message again and replays the completed-change notices of overlapping tasks finished since they were handed over.
- Silence is a per-recipient bus policy (`BusOptions.silence`), applied once the audience is final (implicit replies and `digest` resolved): an agent's chat from a member that has not settled to another member is not queued for that member; the other recipients get the envelope unchanged, so correlation, priority caps, dedupe and hops are untouched. A `quiet` bus event goes to the log and `events.jsonl`; `hub_send` answers with the held-back peers (an error when nobody got it); a native turn answer's sender hears it as a note. A member settles once its task left the open states and its native turn has ended after that (Codex's adapter leaving its turn, Claude's Stop hook; a member already between turns when its task closes settles at once; a paused peer counts by its adapter's state, and Claude's channel going offline says nothing about its session). Settlement is recorded as it happens (`Cohorts.turnEnded`, `Cohorts.closed`) and never undone: a settled member's next turn is new work, and a cohort whose members all settled is over. A message held back from all its recipients is not admitted against the sender's limits.
- Texts: in a silent cohort, overlap results and notices, task envelopes and the conflict notices name the plans and say not to message; `hub_task_accept` returns the overlapping plans with every accept; `ahub check-path` asks the hub (`silenced` control request). A member's completed-change notice to another member is held (`Cohort.held`), never dropped: it goes with the lift notice when silence is lifted, with the done result of a member for whom no integration step runs (turn-free off, a PII task open), or to the console when the console finishes the task (its done still counts as that member's intent). Notices to open tasks outside the cohort go as usual. Otherwise the advisory texts stay.
- Integration: a member's `hub_task_done` records an intent. The member whose intent completes the set is selected in one synchronous step and gets an integration request as its done result (the others' files, signatures and summaries, plus its facts); the request is recorded as `integration requested`, not done. Its next done is accepted (`integrated`, then the usual done) only for the same owner generation, cohort revision and file hash (named files, for a directory git's changed, new and deleted files under it against HEAD, and the files each member wrote with an edit tool the hub saw (Claude's Edit, MultiEdit and Write; Codex's patches) between being handed its task and settling; reads never count, nor shell writes outside the named paths, and a file the hub reads whole whose bytes equal HEAD's is no change there), with its facts acknowledged (the done first acknowledges the facts sent with the request) and every other owner stopped after its intent (a native turn end after it, or idle when it was recorded); the integrating owner's own other tasks never count as running. A cohort whose members have all settled is over, whoever asks first, and is never lifted or reopened after that. A done within two seconds of a request is a retry and gets the same request, with nothing acknowledged or counted. Otherwise it is asked again; past three requests the done is recorded with `integration unresolved`, and that revision asks nothing more (the member's check counts as usual). A failed check or changes requested withdraws that member's intent; a check of the integrating member that passes after its target moved within the same revision counts as finished late; once the revision moved (another member reopened), the former integrating member is an earlier finisher and its check counts. After a restart an open request is recorded as unresolved.

## Amendment: turn-free facts at tool boundaries (issue #108)

- `src/hub/facts.ts` keeps three things apart per peer: what the hub observed in the tree (latest version and transitions per file), what it offered (bounded offers with their file versions and plans), and what the peer acknowledged (its view). Only an acknowledgement moves a view; a later boundary offers everything since the view again. Files are the paths every task of each live cohort in which the peer has an open task names (a directory expands to git's changed files against HEAD, staged or not, and its new and deleted files, 200 at most, with a note when more were cut, told until it is read back and again in a new session), contained in the project as real paths and never `.git` or anything the denylist (`src/local/deny.ts`, `local.deny`) keeps from agents, plus the last 64 it touched in its current session; a file that falls out of those is named in every offer until one naming it is read back (#112). A file the peer touched before it had a view of it is compared with its version at that touch, so a change in between is shown, not absorbed into a first look; a file it saw under a named directory stays covered after git stops listing it (put back to HEAD's bytes, or the directory moved away; 200 at most, the rest named as no longer followed until that is read back; a new session hears only the drops of its own). A directory file it has neither seen nor touched is named without a diff when it appears with bytes that differ from HEAD's (a rewrite with HEAD's bytes, listed until git refreshes its index, is no change, for the fact and for whether the peer is current; a file too large to read is compared by git's blob id of its bytes, hashed in-process, while all such files in one comparison total 64 MiB or less, and is not compared otherwise (so the answer never depends on what an earlier comparison hashed); the bytes are the raw working-tree bytes, without git's filters, so with an end-of-line conversion or LFS such a file reads as changed and is named; #112) (diffing it against HEAD would show what changed while tracking was off, a PII window, and credit unseen changes by elimination), and counts as not yet shown until that fact is read back. Only regular files of 256 KB or less are read, re-resolved at every read and opened without following a final link or blocking; a larger file is compared by size and mtime, except that one whose last change (ctime) is under 2 s old and 4 MiB or less is named by git's blob id of its bytes (git's racily-clean rule: Linux before 6.13 stamps files from a coarse clock, so a same-size rewrite within one tick keeps every stat field; #428), hashed once per version in a public entry point and 16 MiB in all per store per event-loop turn, the stat stamp alone beyond either; the HEAD comparison above keeps its own 64 MiB bound and is not limited by these. A version seen racy keeps its version once it settles with the same bytes, and an integration target (`tree()`) counts large files by their stat stamp only, so it does not move when one settles. Known ceilings: a racy file over the cap or past the budget misses a same-tick same-size rewrite; a racy file first seen past the budget (kept stat-only) reads as changed once when a later turn hashes it with the same bytes; a file written continuously is hashed at every look within the budget; a settled file made racy with the same bytes (chmod, `cp -p`) reads as changed once; a version first seen racy costs an open and a stat at every later look. A history longer than the 64 kept transitions makes the change's attribution unknown.
- Attribution: a transition is credited only with effect evidence: a Claude Edit, MultiEdit or Write whose result equals its input applied to the file as observed at PreToolUse with no observation in between, or a Codex `fileChange` whose changed lines equal the observed diff. Everything else is shown with its attribution unknown; an agent's own verified writes advance its view and are not shown back. A Claude Read advances its view only when it returned the whole file (no offset or limit, at most 2000 lines, none over 2000 characters); a Codex read action never does (it may be partial). A diff that matches a PII pattern is replaced by a note naming the file, and a changed file whose name matches one is counted without its name.
- Acknowledgement and capability: Claude's hook runs before and after every tool and at Stop (`ahub claude` injects it in a turn-free project); the pre answer's text becomes `additionalContext`, and the row Claude Code writes in its transcript for it (matched by tool use id and offer id) is the readback. Codex's offer goes in with `steerText` (bound to the running turn), and the steered input coming back as a `userMessage` item is the readback. A readback marks the peer's path verified; a new session or thread, the peer going offline, or three offers past a minute without one (checked at boundaries and every 30 seconds; facts sent with an integration request wait for the next done and never count, a refused steer is dropped, not unread, and an unanswered one stays pending, since it may have gone in) unverifies it. Until verified, a peer gets a one-line probe at most three times per session, and no offers at all once three are unread; a Claude session whose transcript the hub cannot find gets none at all and loses a verified path.
- The control contract is protocol 13: `facts` carries the phase, tool, input, tool use id, session id and transcript path; `silenced` serves check-path; `send` results name held-back recipients. Protocol 12 stays an authenticated recovery source.
- While a PII task is open nothing is observed or offered; every board change re-checks this, so tracking switches at once. When tracking resumes everything observed is dropped and each peer is told which files earlier changes are not covered for. Turn ends and tool starts are recorded in every regime.
- `events.jsonl`: `fact` (bytes, build time, the hook's own time, the steer round trip), `fact_ack` (latency), `capability`, `native_turn_end`, `hook_stats` (every facts hook call of a Claude turn, at its Stop), `cohort`.

## Amendment: shadow split prediction (issue #109)

- `predictSplit(input)` is a pure function next to `assign()`, which no longer takes a split option: assignment never changes. For the pair formed by the peer routing picks and the owner of an overlapping open task, it compares a split (the later of each peer's orientation plus one unit) with the best peer alone (orientation plus two units). It is unknown unless the units are equal and known (one task of the same class is one unit), both peers are available (idle, or busy taking the task in question: in this hub run, it is still in the turn that task started (the task delivered at once to the idle peer) or in which it claimed the task; a task queued, held, or steered into a turn about something else is not taken, and once that turn ends, busy is another turn; for the other owner while the overlapping task is not started; the routing record, and a cohort record formed as a task is assigned, are taken before the task is sent, so a busy routed peer is not available then; #115) with no other open work (an overlapping task its owner has started counts), and each has five measured tasks with its current profile and at most 30% failures and work times whose IQR does not exceed their median; a difference under a tenth of the single time is inconclusive.
- `Tasks.splitObservations` reads one observation per hand-over to the peer with the profile it has now, across hub runs of the project (what happened from that hand-over up to and with the next one is that peer's: a decline or escalation away is its failure, never the next owner's), never the routed task itself, leaves out claims, types failures (failed check, changes requested, escalation, release, decline, unresolved integration), ends the work stage at the first done call (checks and integration are not work) and leaves the stages unknown for an accept recorded by the done itself. The `split` event carries the trace.
- An overlap that forms or changes a cohort records a `split` event for the task, routed or named (a benchmark names every owner); `ahub route explain <id>` appends the trace as it would be now. Rerouting needs held-out evidence through #110 first.
- 2026-10-03 (T3 calibration data, issue #109 amendment): every hand-over records the new owner's split profile on its history entry: the hub's version, the agent's version (Codex's from app-server's `initialize` answer, Claude Code's from its transcript rows) and the hook profile, which is the hub's own (the coordination mode: a turn-free project runs the facts hooks in Claude). Observations count for a prediction only with the peer's current profile; while a version is unknown there is no profile, and the prediction is unknown. The prediction calibration reads is the one recorded when routing chose the first owner (no single named candidate, no claim; not an escalation, budget relay or reassignment of work already begun) of a task that overlaps another owner's task not started yet (`where: "routing"`), and `route explain` prefers the same unstarted pair; cohort-time predictions stay in the log with `where: "cohort"` and are not calibration data. The user's and plugins' hooks are not seen by the hub (ponytail: read them from the native records as the benchmark ledger does), and only Claude and Codex report a version so far.

### Optional local MLX capability (0.12.11)

`mlx.enabled` is an optional boolean, defaulting to true. When false, the daemon
omits local MLX relay capability while remote `hub/auto` retains fast/coding
selection. Explicit MLX backend/model, project policy and recovery conflicts are
refused before local startup. Model diagnostics report disabled without probing
that endpoint. The switch never starts or stops shared Ollama.

Relay native-session counters and per-dispatch transport usage are separate
measurements. Request usage and provider availability are optional metadata,
bound to their own dispatch IDs; provider absence does not change model
qualification. Primary and fallback dispatches have independent outcomes.


## Task idle sweep (#186, 2026-10-09)

Body-free memory-reference markers do not count as owner or reviewer activity: they preserve the inactivity threshold and the current sweep ladder activity index.

`Tasks.sweep(now)` owns a deterministic, default-off between-turn sweep. It
classifies proposed tasks with an owner as unaccepted assignments, in-progress
tasks with an idle owner as idle-owner findings, and in-review tasks with a
reviewer as review-pending findings. Separate minute thresholds and a ladder
interval are configured through the strict `task_sweep` config block described
in operations. The daemon ticks only an enabled sweep and clears its timer on
shutdown. No control message shape changes.

The activity identity is the last real history entry index, so simultaneous
real events are distinct. Typed sweep entries persist finding kind, activity
index, step and injected sweep time in the existing hub.db task history. They
never reset activity or invalidate a pending completion check. Persisting a
step precedes its notice: restart does not repeat the step, but a crash between
write and publish can leave the attempted notice unpublished or uncertain.
This is not an exactly-once delivery claim.

The ladder sends one ordinary task reminder to the responsible peer, then
notifies the console and available planner-role peers, then suggests an
alternative from pure `assign()`. Every notice uses public task titles and
numeric task refs only; PII text and task refs/plans are absent from notices and
ladder records. Busy/paused/offline/native-active peers, unresolved dependencies,
completion checks, queued/in-flight/held deliveries, recovery/shutdown and live
silent cohorts suppress the sweep. Human review reminders go to the console.

The Claude launcher and preview share one native-observation hook selector.
Turn-free coordination selects facts observations; an enabled task sweep also
selects the existing PreToolUse/PostToolUse/Stop transport in advisory mode.
Advisory observations update native turn evidence without enabling facts
injection. A delivery receipt or task transition never counts as a native Stop.
Explicit caller settings remain authoritative, with a diagnostic that the
managed idle observation hooks are disabled for that session.

Automatic reassignment remains off. Explicit `auto_reassign: true` enables only
an owner handover to an available routed alternative through Tasks' existing
assignment path; reviewer handovers remain suggestions. No failed-work outcome
is inferred from elapsed time. Existing route-explain behavior is unchanged,
and offline-owner release and delivery-journal retries remain separate policies.

## Initialization and launcher previews (issue #189)

Initialization provides a read-only action/path/reason plan with managed-block
insert/replace/remove metadata. Normal initialization applies the same planner.

Claude/Codex/Kimi/Pi launcher previews share native command builders with actual
launches. Preview exits before project registration, runtime setup or terminal
ownership records. JSON contains argv/settings with arbitrary user-supplied
values and custom executable overrides redacted, environment names only, and
explicit reasons for unresolved native-assigned endpoints/session identities.
A preview does not assert runtime, account or executable readiness.
Claude/Codex previews report the conditional daemon/Orca launcher identity
environment names and unresolved reasons without reading runtime identity,
querying Orca, allocating a launch id or exposing values. Existing Pi launch
behavior and its builder-derived environment preview remain unchanged.



## Native context telemetry and checkpoints (issue #185)

Context occupancy is separate from quota and accumulated billable session usage.
Claude reports `context_window.used_percentage` and `context_window_size` from
its status-line payload. A valid `current_usage` counter tuple is required;
null, malformed or missing current usage is unknown, including immediately
after compaction. Its input occupancy excludes output and sums input tokens,
cache creation and cache reads, matching the [official status-line schema](https://code.claude.com/docs/en/statusline).
Codex reports `tokenUsage.last.totalTokens / tokenUsage.modelContextWindow` in
`thread/tokenUsage/updated`. The [native protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts)
and [native TUI](https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs)
distinguish the last active context from the accumulated `total`; the displayed
raw occupancy does not apply the TUI's baseline-adjusted remaining percentage.
The Kimi peer reports `used / size` in `usage_update` (source
`acp_usage_update`, #285 phase 1; only Kimi is wired): the session's context
occupancy, accepted whenever it names the adapter's current session, including
outside a turn; 2.1.1's source text emits it after the prompt resolves (read
from the source, not observed live), when the peer may already be idle.
Pi's RPC state exposes no measured native counter. Its extension context API
returns an estimate, so Pi and unsupported peers remain unknown here.

Each reading records source and measurement time. Claude's status-line file is
bound to the daemon instance, managed launcher and native session; Codex's
notification is fenced by its owning link and native thread; an ACP reading is
bound to the adapter's own session id and dropped when that is not the daemon's
current session. Stale, invalid,
disconnected or replaced-session readings expose unknown occupancy, never zero.
`context.gate` defaults to 0 (off); `context.stale_min` defaults to 30.
A valid above-gate reading emits one metadata-only `context_pressure` event
and one crossing notice. Invalid or stale readings do not rearm a crossing;
a valid below-gate reading or a new native session does. A crossing held by pause or recovery remains unlatched and is reconsidered after release using only a still-fresh, current-session reading; no new native sample is required.

Context and quota checkpoints share the same request/wait path. Only one
request per peer may wait at a time. Context responses must carry the supplied
`request_id` and match the attached peer and native session. Timeout,
disconnection, recovery hold, shutdown and session replacement invalidate the
request. Context requests leave quota records, task assignments, pause state,
native compaction settings and session ownership unchanged.

A valid non-private context response is saved in the state directory as a
0600 `context-checkpoint-<peer>.json` note. With memory enabled, its text is
also saved as a handover note only after the active-turn, task PII and text
pattern checks. It is never broadcast to peers or quoted in logs/events.
Private turns and all non-approved PII tasks associated with the peer as owner or reviewer, including tasks already in review, block requests and completion. The current routing PII policy is rechecked at both boundaries. The operator chooses
whether to continue the native session or restart; this change provides no
automatic session replacement. Status, tail and dashboard expose readings with
source, measurement time and freshness beside quota information.

Release 0.12.16 uses control protocol 14. Recovery sources 9 through 13 remain
supported; protocol 13 identifies releases 0.12.4 through 0.12.15, while
0.12.16 uses protocol 14.

## New-work context admission (issue #802)

`context.max_assignment_used` defaults to 0 (disabled), is a machine-local
finite fraction in `[0, 1]`, and is independent of `context.gate`. Only an
untracked local source and a confirmed person reload (or deliberate restart)
may enable it. A known occupancy greater than or equal to the configured
nonzero threshold excludes a candidate from a new automatic owner offer.

`assign()` remains pure: its host inputs include the threshold, freshness
limit, clock, attachment, current native session and a copy of that peer's
native reading. Validate timestamp, session equality and finite occupancy
before comparing. Missing, invalid, stale, future, mismatched or unsupported
readings are unknown, never zero or evidence of headroom. Unknown does not add
an eligibility refusal; the ordinary gates still apply. Traces show the same
context decision as actual assignment without exposing session identifiers.

Only new automatic owner offers use the guard; reviewer admission is unchanged,
including owners of review-class work. A name or reservation is not an override.
A host-authorized explicit person/conductor nomination or self-claim can bypass
only this context guard; all other privacy, roster, quota, capability and manual
assignment constraints remain. Re-evaluate at the existing post-await owner
admission boundary. No reading triggers pause, compaction, replacement, task
reassignment or a new retry timer. Checkpoint pressure semantics stay unchanged.

## Operator console and conductor (issues #190, #191, #193, #194, #195)

`ahub console` owns one authenticated console connection. It shares tail's
renderer, renders a DECSTBM stream and footer, and provides optional alternate
screen panels. `up` opens it only with terminal input and output, unless
`--no-console` is given. Tail remains a plain stream. Console commands use an
allowlisted argv with stdin closed; lifecycle and native launches are excluded.
Allow options require confirmation and never interpret nonempty input as an
approval. Deny is direct. Pending requests include expiry and are withdrawn by
`permission_closed` on any answer or cancellation. Answer audits have no title.
Panels expose Peers, Approvals, Tasks, Queue and Events with bounded polling and
Unicode cell widths, fall back below 80x24, and restore terminal state on exit.
Tabs change with the digits 1 to 5 or with Left and Right, wrapping at both
ends, with the digit's guards and resets (an arrow under a confirmation dismisses
it like any key but y, without moving a tab); a read holding nothing but arrow
or Home/End sequences is that many key presses, never a paste. Home or `<` selects
the first row of a panel and End or `>` the last (Home tops an open view); the
Events panel follows new events while its selection is on the last row, keeps a
row the person moved to, and opening it or changing its filter selects the newest
row (#441). Outside the Peers panel, `w` opens the project dashboard (`ahub ui`);
in Peers it opens the selected peer's WIP limit edit (#532 W1-W3). `o` opens the
pet window (`ahub pet --window`) as a person's console command; the `:` line
also accepts `ui` and `pet` (#452). An Events row's header is
tokenized by the stream's own tokenizer on the same tab-flattened text, with the
event's tone and kind; body lines stay plain, and selection changes only the
`>` marker. The tail prints a peer's context reading once and repeats it only
when the printed line changes apart from its time (the printed percentage, the
freshness, the source, or known against unknown).

Whole-board progress (#246) uses one pure `taskProgress` function shared by the
console and hashed dashboard script. It reads only public id/state/deps fields;
PII stubs count like other tasks. Waiting partitions proposed tasks whose public
dependencies are not approved, including unknown dependencies. Approved/all gives
the done fraction (zero on an empty board). Four stages are proposed, in progress,
in review and approved; changes requested returns to stage two and is marked.
The console Tasks panel has a 20-cell ASCII summary bar and fixed four-cell row
meters, preserving width and color-off geometry. Cells and percentage round down;
count labels use importance order changes requested, review, waiting, in progress,
proposed, then unknown when nonzero, and drop only from the end. The stream count is in the fixed footer,
from existing all-state status counts; it makes no board fetch and retains a
row-one scroll region for terminal scrollback. Loading/failed reads never imply
confirmed empty progress. Dashboard filters affect rows only, not totals. Its
full-width stacked SVG and stages have text equivalents; the existing signature
guard prevents unchanged snapshots from mutating the progress live region.
System/Light/Dark choice is applied as `data-theme` before first paint, persists
in a one-year host-scoped `SameSite=Strict` cookie through guarded access and
follows OS CSS preference on System. Cookie port independence shares the choice
between hub starts and projects. The shared model is injected before the page's
own inline script/style CSP hashes, with no new control message or CLI JSON change.
UI public rows expose optional public-view deps for waiting. This is additive
metadata enrichment of the existing ui_snapshot payload, not a changed control
message envelope/operation, so it does not bump PROTOCOL. Unknown task states
count in an explicit unknown bucket with stage zero; no NaN or prototype-key
updates are permitted. Approval fraction is derived from counts/total at display
time, avoiding a redundant floating-ratio field.

Console semantic colors (issue #201) use spans with a fixed terminal-native
palette: cyan information, bold cyan active/selected labels, green availability
and success, yellow attention/waiting, red failure/intervention, and restrained
bright-black metadata. Offline peers, ordinary titles, action details and body
lines use the default foreground. Existing labels, selection markers and
confirmation prompts remain sufficient without color. Console stream headers
color meaningful tokens only (#239; dated issue Decisions): Claude bright blue
(94), Codex bright cyan (96), all other peers default; `task` magenta (35, never
bold), numbers bold default foreground (1), task references magenta underlined
(4;35), and other issue references underlined default foreground (4). No token
SGR equals a state or peer SGR. Green/yellow/red remain states/approvals/failures,
cyan remains navigation. Case-insensitive `task #N`, `Task #N`, `[task #N]` and
`[review #N]` identify task references; unbracketed prose `review #N` remains an
issue reference. Ordinary words keep default foreground;
there is no hashing or user theme.
Only hub-written peer slots, state words and structural markers receive their
semantic tones; title words and markers cannot choose them. Numeric tokens have
whole-token boundaries, so UUIDs and ISO identifiers stay plain. Legacy notices
lack typed reference ranges: the task/review prefix heuristic is bounded by a
`ponytail:` comment; other `#N` tokens use the issue tone until structured notice
spans classify assign/which references. Header text crosses `terminalText` before tokenization. Wrapped headers normalize
tabs to spaces first; plain headers retain their original tabs in both color modes. Wrapped spans retain the source classification. After a projection
miss on the first physical header, only structural tones remain. A missed
continuation and all later continuations are fully plain. Projection advances
a span index through the source once, keeping long permission titles bounded. Bodies and every
command-output line stay plain. Denial requests and observed expiry/cancellation
are red; an answered remote closure lacks option-kind metadata and is not
guessed to be a denial.

`--color=auto|always|never` affects styling only. Auto requires terminal input
and output, a non-dumb TERM, and absent/empty NO_COLOR. Always overrides those
checks even for redirected stream output, without enabling panels or raw mode;
never disables styling. Invalid values fail with usage text before connection.
Plain `renderConsole` remains available, while `renderConsoleLines` exposes
semantic spans. Geometry is computed from sanitized plain Unicode text before
painting. Wrapping breaks at whitespace and splits only a word longer than a whole
line; a wrapped line's continuations start four columns deeper than
its source line; a source indent and a continuation indent are both capped at half the width, so wrapped peer text in the stream
never starts at a column where hub-written lines start (#212). `paint` sanitizes every span, inserts only fixed palette SGR sequences
and resets each styled span. Interactive exits, signals, disconnect and errors
retain the console restoration sequence. No new dependencies, protocol changes,
polling or redraw triggers are added. Tail, logs and machine-readable output
remain unchanged. Native light/dark readability and idle-CPU observations are
separate smoke evidence, not inferred from fake-terminal tests.

Console layout (issue #213) separates the panel header (the project root's
directory name, since the registry id is a hash, then the tabs), the body and
the footer with ASCII `-` rules, and puts one rule above the stream footer; the
console emits no box-drawing or other ambiguous-width glyph. The active tab is
bracketed; the Approvals and Queue tabs count pending requests and
`needs_review` deliveries. Peers, Approvals, Tasks and Queue are tables: a
header row, columns two spaces apart sized with `Bun.stringWidth` from every
row (at most a third of the width), the last column taking the rest. Peers'
columns are PEER, STATE, MODE, LINK, Q, !, WIP, REVIEW, PAUSE, QUOTA and MODEL;
MODE appears only when at least one peer has a non-`ask` mode. WIP reads
`wip/limit` from the peer's `taskWip` entry, preserving zero (for example `0/2`),
or `-` when absent. It uses the attention tone at `wip >= wipLimit`. WIP is
optional at narrow widths and drops before PEER, STATE and QUOTA, with or
without MODE. The Peers hint includes `w WIP limit`, shortened to `w WIP`
through the existing width adaptation alongside `m permission mode`/`m mode`.
Tasks has a `b` toggle between open work and backlog (#532 B1-B5), using the
same public board response. Backlog rows sort by rank (missing last), then id;
the heading counts them. Its columns are ID, PRI (priority/rank), RESERVED,
DEPS (ready or unapproved dependency ids), CLASS, AGE and TITLE. PII titles stay
stubs. Narrow widths drop metadata before ID, RESERVED and TITLE.

Backlog row keys prefill the existing person CLI: `p` is
`backlog pull-ready <id> <planningRevision> <reason>`, `a` is `backlog plan`
with a reservation JSON object, `e` is `backlog plan` with priority/rank/deps,
and `c` is the existing flow-revision-bound `task cancel`. `n` in either Tasks
view adds backlog work (`backlog add <class> <title...>`, or the command line's
`task propose --backlog` with paths/deps). On proposed or in-progress open work,
`R` returns an ownerless proposal with `backlog return <id>` or accepted,
untouched work with the planning-revision-and-reason form. The hub retains its
execution-evidence refusal. Row commands preserve id and revision through
editing and confirmation, reject stale rows, and execute only after explicit
confirmation; Esc sends nothing. Backlog mutations on the `:` line confirm too,
while `backlog list` is read-only. Refusal notices preserve the hub's reason.
There is no new write path or actor authority; person CLI and planner revision
checks remain authoritative. Hints follow the selected row's available actions.

LINK reads `tools-only` when the optional `toolsOnly` status field (#205) is
present. Other zero counters read `-`, durations `45s`, `12m`, `3h05m` or `2d03h`, and
resets and pauses are relative. Detail views and the Approvals panel's request
block put labels at column 0 and values one column past the longest label; a
list puts `- ` before each item, and every other line of a value (its own
newlines, wrapped continuations) starts two columns deeper, so untrusted text
passes neither for a label nor for an item. Only a field's own string shows as
written: every agent-written string below it (nested pairs and lists, list
items) and every option name or id in the Approvals block, the prompts and the
stream's permission line is JSON-quoted unless it is a plain word starting with
a letter, so `;`,
`,`, `)`, quotes and newlines in it cannot pass for hub structure. Values show
no JSON objects, epoch milliseconds or ISO times. Allow options keep one line
each; `d deny` always stays in view, options that do not fit are counted on a
`(more)` line, table rows give way, and a cut title is marked `(more)` in the
label column. The selected request is tracked by id: only the first request is
selected on arrival, `[`, `]` and j/k move the selection, `a`, `d` and `v` act on
it alone, and its detail is rendered from the live request. When it closes, the
selection and its detail clear with a notice; `a`, `d` and `v` act on nothing
until `[`, `]` or j/k select again, so a request that arrives as the person
reacts is never acted on. Everything pending on a request belongs to the
selected one, checked after every key and every prune: an option choice or
confirmation for another request is dropped, an open detail follows the
selection from its top, and the option prompt names the request. `a`, `d` and
`v` act only while the request list or its detail is shown, and a task or
delivery detail that arrives after the person moved to another panel or row is
dropped; with a task, delivery or peer detail open, the row keys act on the item
the detail shows, by its id. A pushed request's agent-supplied fields are kept as
strings, so a malformed one cannot throw on a draw. The key table is modal: only
`?`, Escape and `q` act under it, and a paste is dropped. Offline peers keep the default foreground, also
when selected, and a tab counts as one space when a line is cut. The footer
hint lists only the keys valid in the mode, panel and state, and `?` shows a
key table grouped by panel (in stream mode it is printed into the stream, as
`v`'s copy of a request is, without entering the Events buffer). Errors and refusals take the failure tone, informing notices (a closed or
missing selection) the attention tone. A notice clears at the next key, or once 10 s have passed when the
existing 1 s tick redraws. In the stream, `v` prints the selected request with
the push's framing, and `:` command output lines start at column 4. `fit`
measures a cut line as `paint` prints it, so a cut that ends a span in
`[agent-hub` cannot widen the line with a `> ` marker. A context reading in the
console stream and Events panel shows its measurement time as local time, as
event headers do; `ahub tail` and `ahub status` keep the ISO time.

Agent shell CLI calls connect as the detected peer in tools mode. Hub launches
set `AGENTHUB_PEER_ID`; the pinned installed Codex shell injects
`CODEX_THREAD_ID` after environment filtering, and Claude uses `CLAUDECODE`.
Malformed or conflicting markers fail closed. Console-only commands are denied
before connecting, with no as-user escape. Refusals enter a bounded ids-only
local audit spool which a running daemon consumes; this preserves the no-connect
rule while making refusals visible on the console and in the log. A stopped
daemon cannot show a live notice; it consumes remaining records on startup.
This does not establish a security boundary against an unrestricted shell
which can read the token. Native source evidence and live probe results remain
separate in the smoke ledger.

Exactly one explicit conductor role may be configured. Default-allow
capabilities do not grant it; role authority is checked on each operation and
refreshed on a subsequent connection. Shared MCP tools provide public status,
public task history, actor-preserving assign/escalate, headless local/Kimi/Pi
start, and conductor-owned persistent holds. TUI starts return launch commands.
Assign/escalate need `assign` if the peer has a capabilities entry. Approval
answers, durable queue resolution, budget overrides and lifecycle remain human
operations. A conductor cannot release human or budget holds. Audit events are
ids-only and report counts their actions.

The conductor feed defaults to own tasks, also supports all and off, and uses
the existing bus digest window. Repeated queued task/kind milestones replace
the earlier pending notice; accepted or in-flight deliveries are preserved.
Structured milestones carry public titles or PII stubs, never raw history
notes or check output. Only aged approval summaries and needs-review delivery
ids are important. Role/feed revocation withdraws pending feed notices. A
completed task set produces one round notice until a new task joins; subsequent
rounds count only newly joined tasks. Pure status supervision queues wait for
the existing digest deadline rather than flushing at the ordinary batch-count
threshold. Mixed traffic retains the ordinary admission behavior. The existing
10-original digest ceiling and 200-entry queue ceiling still bound admission;
larger windows may require multiple bounded deliveries.

Supervision cost counts completed native turns that received feed notices,
with whole-turn token readings when available. Other work may share a turn;
these readings are not per-notice token attribution. Missing measurements are
unknown. Native TUI conductor, sandbox and feed-on smoke results must be recorded
as observed outcomes, separately from unit/fake protocol tests.

Managed Claude launches with turn-free facts, task-idle sweeps or a conductor
role install native observation hooks. A conductor receives them even when facts
injection and task-idle sweeps are disabled; ordinary non-opt-in launches remain
unchanged. SessionStart registers the native
session and UserPromptSubmit starts observation; PreToolUse keeps a tool turn
active and Stop closes it. Explicit caller settings remain authoritative and
produce a warning when they replace these hooks. An ordinary terminal records a
private launcher identity without creating an Orca terminal-recovery record.
The facts control request accepts session/start/pre/post/stop phases and carries
nativeInstanceId and nativeLaunchId alongside sessionId and transcriptPath.
The command hook forwards launcher identity only for its matching state directory
and peer; library calls targeting another hub do not inherit that identity.
The daemon fences observations to its current instance and launcher, validates
the session transcript, and rejects stale stop/post observations. Native prompt
text is never included in those requests or events.

A genuine native Stop requires the current daemon/launcher binding and an actual
assistant end_turn transcript message at or after the native turn's first start,
distinct from the completed-message baseline recorded at that start. Later tool
activity does not move this turn-start boundary. Missing start evidence or a
start from another session, launch or channel claim leaves completion unknown.
Accepted completion consumes that start before the peer becomes idle, so another
message cannot reuse it. Completion and baseline lookup scans backwards in fixed
4 MiB chunks, up to 64 MiB plus one boundary byte (#528). Complete UTF-8 JSONL rows
are reconstructed across chunks; a row starting outside the bound stays unknown.
A near-EOF completion costs one chunk even in a 200 MiB transcript. The separate
32 MiB cap applies only to usage accounting (#517). A Stop refused because
no completion is found tells the console once per turn start that the peer stays
busy and its messages wait in its queue. A valid bound Stop request receives one prompt
acknowledgement with pending=true, within the existing two-second hook deadline.
The acknowledgement records observation only, never completion. After the hook
can return, a deferred observer waits up to 1200 monotonic milliseconds for its
transcript append to become visible. Each read and final consumption revalidate
the captured start, session,
launch, peer and claim. A seen previous-turn baseline still waits while a new
current start exists; a consumed duplicate remains a no-op. Timeout, malformed or
oversized evidence and superseded context leave completion unknown. This wait
does not retry a user action or relax authority.
The observer sends no second request reply and never changes global hook settings.
The live harness also binds its final receipt to the current private launch id.
Its opaque
deduplication id binds session, launch and message; transport replacement or new
activity cannot turn a replay into another completion. Unbound or idless legacy
Stop events cannot certify completion or finish supervision. A current private
launcher marker takes precedence over an older terminal-recovery launch id for
native observation, while preserving the recovery records and their authority.
Claude turn reports
prefer unique native Stop events; historical logical-state counts are labelled
as such, and an unobserved completion remains unknown. Channel idle, watchdog
expiry, board approval and a tool reply do not independently establish native
completion. The live harness waits for the current fixture/instance/session's
final transcript end_turn and turn_duration after its last review before
reporting a completed case or terminating its native TUI. It also requires the
matching opaque native completion event, an idle peer and settled delivery rows.

These additions use control protocol 15. Supported recovery sources include
protocol 14 (0.12.16) alongside the previous source protocols.

For release 0.12.17 only, the user explicitly accepted deferral of real Kimi ACP
new-tool invocation and ordinary-role refusal T0 evidence on 2026-10-09. The
managed OAuth account rejected its prompt with HTTP 403 for the weekly quota
before any tool event; reset time is unknown and no configured native alternative
was found. This prerequisite remains unverified. Actual Claude/Codex conductor
workflows, Claude shell/channel observations, shared MCP/fake-adapter authority
checks, real Kimi ACP initialization/session creation and full source gates are
separately qualified. The deferral authorizes no purchase, credentials,
provider/configuration change, account retry or authority relaxation. Once quota
is available under an authorized account, the same isolated read-only status-tool
and ordinary-role refusal probe must record a native tool event and daemon result
before this Kimi prerequisite can be marked verified.

## Amendment: per-task usage attribution (issue #200)

Task usage is attributed by a rule at write time, never by a proportional guess:

- A turn whose original delivery names exactly one distinct positive `refs.task` uses that id and `attribution: "delivery"`, even when the peer does not own the task. Two distinct delivery task ids fall through to the next rule.
- Otherwise a peer with exactly one owned `in_progress` task uses that id and `attribution: "single_open"`.
- Otherwise the record carries `attribution: "unattributed"` and no task id.

The bus calls `onDeliver(peer, originals)` immediately before `peer.deliver`,
after retaining the original delivery. The daemon consumes pending delivery
identity during the synchronous busy/turn-start transition and clears it on
delivery admission/failure. A user-started native turn cannot inherit an older
delivery. Tokens and usage use the rule at write time; turn ends preserve the
start-time attribution. Local worker usage carries its request-bound route
policy task when one exists. Relay usage would use a route decision's task when
present; the current daemon has no such relay usage writer, so collection is
unchanged. Attributed PII records carry only a task id and `pii: true`.

`ahub report --by task` and `--by task --json` use only events, never the board or
task text. They report latest task class/outcome, attributed turn ends, first
accept-to-first-approval wall time (unknown while not approved or without both
boundaries), per-peer token increments and provider counters, and class rollups.
Usage deduplication uses peer/source/id. Missing counters stay unknown, distinct
from reported zero, and known-record counts identify measured subsets.

Unattributed token and usage-record shares always appear. Older records without
`attribution` stay in a distinct `before attribution` bucket, never redistributed
to a task; both buckets appear even when empty. A zero denominator has unknown
share. Export carries the new fields without task text. No prices or savings
counterfactuals are derived. These additive fields retain events schema 1 and
the existing control protocol. Plain `ahub report` remains unchanged.

## Amendment: Pi "always" approvals (issue #209)

Pi's `write`, `edit`, `bash` and `git` write calls ask with three options:
`allow` (`allow_once`), `always` (`allow_always`, named `Always allow <tool>
until Pi restarts`) and `deny` (`reject_once`). `always` allows the call and
every later call of the same hub tool by that Pi start without asking. The grant
is held in memory by the Pi start: stopping or replacing Pi, or restarting the
hub, drops it, and nothing is persisted. A granted call is logged by tool name
only. The path guard, denylist and sandbox still apply to each call; the
dashboard still offers Pi only deny; unattended mode still picks `allow_once`;
the local worker keeps allow and deny. The console and `ahub permit` already
handle more than one allow option, so the control protocol is unchanged.

## Amendment: Claude sessions without channel evidence (issue #205)

Claude Code without `--dangerously-load-development-channels` drops channel
notifications without an error, so a plain `claude` session used to mark every
push `accepted` and show none of them.

- Evidence: `ahub claude` passes the flag and, in the same launch, sets
  `AGENTHUB_CHANNEL=1` in Claude's environment (`nativeLaunchEnv`);
  `peerChildEnv` removes the marker from every other native child. The plugin's
  MCP server inherits Claude Code's environment (a local check on 2026-10-09,
  not a live smoke: a plain session's plugin server inherited a shell-only
  `AGENTHUB_*` variable, and the plugin's `.mcp.json` sets no env), as it
  already does for
  `AGENTHUB_STATE_DIR` and `AGENTHUB_PEER_ID`. Only the value `1` counts. With
  the marker the server keeps
  the push and settlement contract of "Live channel settlement" unchanged.
  Without it (a plain `claude`, an IDE session, or the flag passed by hand) the
  session attaches tools-only.
- Decision: the launch marker is sufficient evidence, and no positive readback
  is required before the first `accepted`.
  - The marker and the flag come from the same launch, so the marker shows that
    this Claude process got the flag. A readback would add per-push proof of
    display, which stays out of scope: `accepted` means the bridge handed the
    notification over, and `hub_delivery_done` or a correlated reply settles
    handled work.
  - A readback (a native turn citing the pushed id) would hold every first
    delivery until the model chose to answer, and a session that never answers
    would look the same as one that never rendered.
  - Launch fencing (#551): peer hello carries `AGENTHUB_LAUNCH_ID` when present.
    A Claude-channel hello that differs from this daemon instance's recorded
    per-peer `claude-launch.json` is refused before claiming, with terminal close
    4430. The plugin stops reconnecting and its tools explain how to start a new
    session. An absent launch id or absent current launch record keeps the prior
    behavior, including `ahub claude` started before `ahub up`.
  - Limits: the marker is inherited by the session's own shell children, so a
    plain `claude` started inside an `ahub claude` session reads as
    channel-capable (it also inherits the peer id and takes the peer over); so
    does `claude -p` run by a hook or script inside such a session, with its
    state dir and peer id. The marker is per process while the flag names MCP
    servers: `ahub claude --mcp-config <candidate>` without
    `--strict-mcp-config` loads channels only for `server:agent-hub`, yet the
    installed plugin server in the same process also sees
    `AGENTHUB_CHANNEL=1`. A session started with the flag by hand reads as
    tools-only and is pointed to `ahub claude`.
- Channel activation ceiling (#551 D2): the MCP server observes its inherited
  environment and the host's `initialize` client information/capabilities through
  the SDK. The current bridge contract has no positive signal that this specific
  server was selected by the host's channel flag. Advertising the server's own
  `experimental["claude/channel"]` capability is not host activation evidence;
  client name/version and an inherited environment marker cannot establish it
  either. Therefore a nested host inheriting the current launch id and channel
  marker remains indistinguishable here. Do not invent a client capability or
  infer activation from successful notification writes. The stale-launch fence
  blocks obsolete launch identities; no-marker sessions remain pull-only. A
  positive per-server host activation signal would permit tightening this rule.
- Tools-only attach: the server declares tools only, sends `channel: false` in
  its `peer` hello and lists `hub_inbox` but not `hub_delivery_done`. It never
  reports `accepted`: a `deliver` it is handed anyway goes back as a
  `needs_review` receipt. The daemon attaches its `WsPeer` as `pullOnly`; a
  push drain needs the peer deliverable (`Bus.deliverable`: not held, idle, not
  pull-only), checked at each loop and again after condensation, so a plain
  session that takes the peer while a push is condensed gets nothing. Its
  messages stay queued and count as `queued`. Board routing still sees it as attached, but automatic owner/reviewer
  selection excludes pull-only peers; only explicit role-specific naming or an
  honored owner reservation permits assignment.
- `hub_inbox` sends `inbox`. The daemon answers "not attached yet; retry"
  between welcome and attach. Since #493 the current channel owner may also
  explicitly pull its queued work, including while its native turn is busy.
  `Bus.pull` is held by every hold a drain respects (`Bus.held`: recovery, an
  uncertain delivery, a console, budget or conductor pause), though unlike a
  drain it does not wait for the peer to be idle; a held pull journals nothing
  and the refusal names the hold and the next action. Otherwise it takes what one
  push delivery would (the preface, then `take`'s batch of at most ten,
  important first; the reply says how many still wait) and checkpoints it like
  a push, so queued journal rows of the same envelopes (an operator retry) are
  grouped into it, then marks it `completed`, reason `read through hub_inbox`,
  in the same transaction: the tool result that returns them is the readback,
  so nothing waits in `accepted`. What it hands over is registered (and moved
  to the newest end of the cache) for `reply_to` like a push, and a read clears
  the peer's failure streak as a completed push does. If that journal write fails, only this peer's queue
  and preface are put back (every pause stays) and the bus stops with
  `delivery journal unavailable`. A refused or failed `resolveDelivery` likewise
  puts back only that peer's queue and preface and keeps every pause. Queue
  contents change in place, preserving arrays held by a suspended drain; only
  the constructor and recovery restore reload a bus snapshot. A pull is not a native turn and is not
  counted as supervision. The row is completed at hand-out, before anything
  shows the model saw it: a reply lost on the way, a tool call cancelled with
  Esc or a plugin that dies loses the batch (a `ponytail:` ceiling in
  `Bus.pull`), and `ahub queue resolve --action retry` refuses a terminal row.
  The completed row keeps the envelopes, so the operator reads them with `ahub
  queue show <id>` and sends what matters again.
- Who holds the peer: an `ahub claude` session takes it from a plain session
  as any newer hello does, a standing-by one included (its standby check does
  not wait for a holder that status reports `toolsOnly`); attach clears
  `pullOnly`, the waiting queue is pushed to it, and the plain session stands by
  (close 4000). A plain session
  never takes it from a session with pushes, attached or still arriving: its
  hello is closed with 4000 and it stands by the same way, so an IDE or plain
  `claude` with the user-scope plugin cannot strand the channel session's
  unsettled deliveries. It attaches once that session leaves.
- Status: `status.json` peers carry `toolsOnly`, a line naming the state and the
  next action (`ahub claude`); `ahub status`, the console footer and the
  dashboard show it.
- Control protocol 16 adds the hello `channel` field and `inbox`. Recovery
  sources add protocol 15 (0.12.17 through 0.12.19); the transition from a real
  0.12.19 hub is not yet proven.

## Amendment: channel queue visibility and explicit pull (issue #493)

- A channel session's `hub_inbox` reads the daemon queue through the same
  authenticated `peer` socket as a tools-only Claude session. The daemon checks
  current socket ownership and the shared roster, pause, recovery, lifecycle and
  uncertain-delivery holds. It does not require an idle native turn. Tools-role
  sockets cannot consume another transport's queue.
- `Bus.pull` claims one batch synchronously and completes it with its bus
  checkpoint in the existing journal transaction. A later idle drain or another
  concurrent inbox call cannot hand those originals out again. Existing accepted
  pushes remain independent; a pull does not complete them. The hand-out-before-
  model-read ceiling documented above remains. Framing, `sanitize`, public PII
  projections and task-offer read evidence retain their existing paths.
- The plugin also returns its existing bounded local buffer of failed pushes
  without journal ids. Journaled failed pushes stay in `needs_review`; the plugin
  never consumes them from this local buffer. A daemon refusal or an unavailable
  connection cannot prevent reading that local fallback.
- `delivery_holds` adds optional same-peer `queued` and `important` counts, with
  no bodies or caller-selected target. Every agent-hub tool-call result can show
  fresh counts when important work waits. Channel and tools-mode sessions remain
  silent when an older daemon supplies no counts. Plain pull-only sessions keep
  their old advisory nudge compatibility. A current zero clears old nudges;
  unavailable metadata never changes a saved result or its effect classification.
  Inbox replies show counts without suggesting a repeated refused read, and a
  tools-mode hint does not grant an inbox capability to that transport.
- `[FYI]` remains record-only. PR ready, done or submitted, ruling-needed,
  blocker and changed-contract/path messages require an unmarked or important
  update. `hub_task_done` and `hub_review` already notify the assigned audience;
  an extra chat with the same outcome is unnecessary.
- Native busy-notification evidence and the decision about channel steering are
  recorded separately in `docs/verification/2026-10-18-493-claude-busy-channel.md`.
  Claude Code 2.1.302 / Sonnet 5.5 returned the random notification token before
  the original interactive turn ended. Push-capable `WsPeer` therefore exposes
  important-only steer through the existing journal/generation-bound push path;
  detach and pull-only attach remove that capability. Ordinary messages remain
  queued while busy. A notification write alone is not proof that the native
  model saw it; the earlier print-mode probe was inconclusive.
- Known limit and hint behaviour (#221). Mid-turn consumption of an important
  steer was proven only on Claude Code 2.1.302, yet push-capable `WsPeer` offers
  steer to every push-capable Claude session. On an older client a dropped
  mid-turn notification stays `accepted` until a person resolves it. No client
  version gate is added: the hello does not carry the client version, and the
  oldest version on which steer works was never probed, so a gate would be a
  guess that could disable a working path. A gate needs a probe of the older
  client and an optional hello field. A tool result that carries a held-delivery
  hint keeps the queued and important counts but drops the advice to call
  `hub_inbox`, because `Bus.pull` refuses under that hold. A `hub_inbox` result
  that already states how many messages remain unread adds only the important
  count.

## Amendment: owner and reviewer read their task (issue #208)

`hub_task_show` stays a conductor tool, and a task's current owner and current
reviewer may also call it for that task. They get exactly the conductor's
view: `publicConductorTask` over `Tasks.publicView(task, true)`, so the whole
history with its done summary and check line, notes that match a PII pattern
withheld, and a PII task as a stub with no history. Any other peer is refused
with the conductor-role error, whatever the task, except the configured planner,
which reads any task through the same view (#812, below). That refusal is about the
tool, not a secret: the view holds nothing private beyond the PII stub, and the
control op `task_show` (`ahub task show` from an agent shell) already returns
the same public view to any peer. These reads write no conduct audit event, as
task list polling does not. `hub_status` stays conductor-only.

## Amendment: reserved owners and proposer redirects (issue #207)

- `reserved` is a nullable text column on `tasks`, added to existing boards
  like `plan` and `deps` (old rows reserve nobody). `hub_task_propose` with an
  `owner` and an `after` that still waits stores the owner there instead of
  refusing; the capability check for naming another peer is unchanged. With
  nothing left to wait for, a named owner is assigned as before.
- The reservation is an input of `assign()`, read from the task, so `ahub
  route explain` and assignment agree. When no candidate list is given, the
  reserved owner is the only candidate if `blocked()` passes it; otherwise the
  trace says why it is not honored and routing proceeds through the class
  peers. PII, capability limits (`local_allowed`, Pi's context limit),
  exclusions, failing peers and offline or paused peers all pass it over, so a
  PII task still goes to `local` or nobody.
- Lasting exclusions are refusals only: a plain decline records the owner it was
  declined for in its history entry's `from` (also when the console declines
  for that owner), and an escalation with reason `rejections` (a reviewer's
  repeated changes_requested) or `manual` (by hand) records the owner it took
  the task from the same way. `excluded()` reads both (older decline rows name
  only the decliner), so those peers stay out of every later reroute and of
  `route explain`: the reservation never hands the task back to them. The
  hub's own escalations after a failed delivery or inference
  (`delivery_failed`, `inference_failed`), and an owner released as gone, moved
  by the idle sweep or relayed for its budget, exclude that owner only from
  that move's own reroute: none of these is a refusal, so a later reroute may
  give it the task again from its reservation. A person's explicit assign
  (`ahub task assign`, the dashboard) is not blocked by lasting exclusions and
  clears an agent's reservation, so a later reroute does not hand the task to
  the agent's choice; the conductor's and a proposer's assigns respect the
  exclusions and keep the reservation.
- A capacity decline is not a lasting exclusion (#531): `hub_task_decline` with
  `capacity: true` says the owner has no room right now. Its history entry
  records `from` and `capacity: true`, `excluded()` skips it, and the owner is
  left out of that move's own reroute only, like the budget relay and the idle
  sweep, so a later reroute or planner pull may offer the task to it again from
  its reservation. Entries without the field, all older rows included, read as
  refusals. A planner pull that finds no owner names the cause (the peers a
  lasting exclusion keeps out, a peer at its WIP limit with wip/limit, a held
  queue, needs_review), by peer id and count only, and `hub_backlog_plan`
  refuses a reservation for a peer `excluded()` returns for that task.
- A named candidate list (console or conductor assign, escalation, budget
  relay, the idle sweep's auto-reassignment of its suggestion) replaces the
  reservation; the idle sweep's step-3 suggestion itself is an `assign()`
  without candidates, so it consults the reservation like routing does. A task
  that waits shows its reservation in the trace before the readiness check,
  which then stops; the trace says whether routing would honor it only once
  the task is ready. `route explain <id>` also names it in the header. The
  reservation stays after it is honored or passed over.
- Passing over a reservation is a console and hub.log notice naming the
  reserved peer and the reason, from assignment and from the idle sweep's
  suggestion alike, and the assignment's history note keeps it, appended to a
  note the caller gave (a gone owner's release). Only news is said: nothing
  when the reserved peer is the owner the task moves away from (its decline,
  escalation, release or idle sweep), and nothing once it refused the task for
  good (the decline or escalation said that). The reserved peer is not
  messaged.
- `Tasks.assignTo` on a task that waits records a `reserved` event with reason
  `manual` and changes the reserved owner instead of the silent no-op it was;
  this applies to the console, the conductor and a proposer alike. The release
  timer treats a `reserved` last event like `blocked`.
- `hub_task_assign` stays a conductor tool, and the task's proposer (the `by`
  of its first history entry) may call it while the task is `proposed` and its
  history has no `accepted` entry: a decline or a release puts a task that was
  worked on back in `proposed`, and that task is no longer the proposer's to
  redirect. Handing it to another peer needs `assign` when the proposer has a
  capabilities entry; redirecting to itself does not. The conductor needs
  `assign` for any assign when it has a capabilities entry. The proposer path
  is refused while the last owner or reservation change of the task
  (`assigned`, `reassigned`, `escalated`, `unassigned`, `reserved`) that the
  hub did not make itself was made by the console user: a person's assign or
  reservation stands until the conductor or the console moves it, also after
  the hub carried it out or passed it over. The id is taken as `Tasks.need()`
  takes it, a whole number or a digit string. Any other non-conductor peer, and
  the proposer once the task was accepted or a person moved it, get the
  conductor-role error. A proposer's redirect goes through `Tasks`, keeps the
  proposer as the actor with reason `manual` (on the `reassigned` or `reserved`
  entry), and writes no conduct audit event; during a PII turn it is refused
  like the conductor's.

## Amendment: revision-safe console task and queue operations (issue #424)

- Task list/show responses add `flowRevision`, the monotonic history length,
  separate from `planningRevision` and the delivery journal revision. This is
  additive public metadata and does not bump the control protocol. `Board.update`
  can check an expected value in its synchronous read-check-write section.
- A revision-bound `ahub task assign` uses the new console-only
  `task_assign_checked`; unchecked `task_assign` remains compatible. The new
  console-only `task_unassign` and checked operation are unknown to an older hub,
  which therefore refuses rather than ignoring the revision. A console whose
  rows lack `flowRevision` refuses task row actions and asks for an upgrade.
  `ahub queue resolve` accepts an optional displayed revision and otherwise keeps
  its existing fresh-show behavior. New operations and optional fields preserve
  the protocol version.
- Tasks and Queue selections follow ids across refreshes, never indices into
  replacement rows. A row-started action fixes its id and revision while peer,
  reason and final role/action remain editable; confirmation uses the validated
  final command and its consequence. Refresh follows every completed console
  command, including failure and saved-but-unconfirmed assignment, without an
  automatic resend. Existing `AssignmentUndeliveredError` semantics remain.
- Tasks `a` assigns owner in `proposed`, `in_progress` and `changes_requested`,
  and reviewer in `in_review`; waiting owner assignment is a reservation. `u`
  unassigns, and `r` reviews only in `in_review`. Direct owner reassignment or
  unassignment in `in_review`, physical task deletion/cancellation and roster
  removal stay outside this feature.
- `Tasks.unassign` is person-only. It refuses `approved` and `backlog`, an
  already absent role and owner removal in `in_review`. Owner removal clears the
  owner and reservation and returns active work to `proposed`; reviewer removal
  keeps the current state. The human reviewer of PII work cannot be removed.
  Owner removal writes `unassigned` and leaves turn-free cohorts; reviewer
  removal writes `reviewer changed`. Neither operation routes a replacement,
  adds a decline exclusion, stops a native process or rolls back effects.
- A person `unassigned` event suppresses later automatic owner offers across
  dependency release, planner pulls, release timers and restart recovery until
  an explicit assignment or reservation. The marker is derived from history, so
  no schema migration is needed, and it also fences planner undo and re-pull.
  Former queued task/review requests are withdrawn, but accepted, dispatching
  and needs_review deliveries are never implicitly resolved. Withdrawal notices
  use delivery evidence or accepted/claimed board evidence, never an unread
  queue alone. Former agents fail current-authority checks while the person's
  explicit review override remains.
- Assignment/review publication has a role-specific fence after every await and
  immediately before publication. Existing supersession events, role generation
  and task state suppress obsolete envelopes; accept, done and approval count as
  supersession even when the owner id is unchanged. Supersession returns the
  current task rather than aborting the remaining operation. Current metadata is
  re-read before constructing a still-valid envelope, so reviewer-only changes
  refresh reviewer content and quiet bookkeeping does not suppress valid owner
  delivery.
- Queue `r` prefills `discard` for `queued` and `retry` for `needs_review`, never
  `completed` by default. Every resolve needs reason and confirmation. Queued
  discard removes queued originals; needs-review discard settles its receipt and
  hold. Retry creates one linked attempt. None cancels a task or claims native
  or external rollback. Task and queue projections retain their distinct PII and
  envelope-privacy redaction.

## Amendment: delegated agent live verification (#408)

- Decision, 2026-10-16: an agent explicitly authorized by the user to perform a live test may use the global `--live-test` flag, before the command and in either order with `--project`. Duplicate global options refuse. Default command classification and malformed/conflicting identity refusals stay unchanged.
- Console-class operations and conductor-class peer starts/pause/resume may use console authority after the original caller is validated; allowed-class commands retain peer identity and capability checks. Flagged task assign/escalate refuse rather than writing user-attributed history. A mandatory ids-only audit records its peer, closed command label and `delegated` outcome before execution. The daemon emits an `agent_cli` event with `delegated: true`, `refused: false`, and a console notice naming the peer. User impersonation, person labels and person-authored workflow writes refuse. Delegated dashboard tickets/sessions allow operational controls but refuse user-attributed content and history actions on both project and unified surfaces; request bodies cannot widen the session.
- This is a user-authorized operating policy, not a sandbox or authenticated grant. It includes console mutations and requires the agent to remain within the authorized targets and operations. Command-specific confirmations, process ownership, provider identity and recovery locks still apply.
- Audit compatibility (#410): ordinary delegated execution requires `cli_audit_delegated` in the authenticated running daemon's welcome, not protocol 16 or a disk feature hint. Reuse the authenticated connection for execution, pin helper connections to the welcomed instance and check it before local command dispatch; replacement control connections refuse. Before effects, require console-only `cli_audit_ack` for the exact audit UUID and authenticated instance, positive only after an actual event append. A bounded 4096-id live-instance acknowledgement window fails closed on eviction/restart. This retains attribution across later local waits without relying on another daemon draining the spool. Reserve its bounded private pending audit before connecting; unsupported/unavailable consumers get only a legacy-compatible `refused` ready row and an upgrade remedy, with no command effects. Upgrade/recovery and local bootstrap commands with no daemon manifest use compatible `run` spool rows. Recovery additionally stores bounded ids-only `delegatedAudits` (peer, closed command, timestamp, operation id) in the schema-1 operation receipt before runtime/target effects; append under the runner claim for resume handoff, runner, abort and dispose. Preserve the initiating row through source replacement and old-coordinator whole-object saves; refuse further delegated attempts at 256 entries. Receipt evidence never supplies invocation authority. Source preservation remains preflight, preceded by the compatible spool audit; the operation receipt precedes staging, prepare and commit. Existing target-support and native-restoration fences remain unchanged.
- No settings/environment opt-in persists. Native argv does not receive the flag. Ahub's own daemon launch, console subprocesses, recovery runner, interactive continuation commands and newer-version coordinator handover carry it explicitly; older CLIs cannot accept it. The recovery driver's target CLI environment preserves the initiating peer for its delegation audit. Staging checks the target's pinned LIVE_TEST_SUPPORTED declaration before its cached-stage return and before prepare/commit; unsupported old targets refuse without source effects. Headless-native restoration uses the ordinary target CLI with the operationId on its delegated console connection; no headless staging ceiling is added. External computer-use policies remain outside this change. No #273 live success is inferred from this implementation.

## Amendment: ahub reset (issue #214)

`ahub reset [--all] [--yes]` returns a project's hub to a clean state. It is
console-only by default (explicit authorized delegation is described in #408) and a dry run
unless `--yes`: the dry run reads `hub.db` read-only (with `immutable=1` when
`hub.db-wal` or `-shm` is absent, so it creates neither) and prints delivery ids,
peer names and counts per category, never task or message text. With `--yes`
it stops a running hub through `stopProject`, the path `ahub kill` takes, then
acts on the stopped state directory.

- Refusals, each before anything changes: the machine's recovery lock is held
  (`recoveryLock()` read directly: a reset is never part of an operation, so
  `AGENTHUB_RECOVERY_OPERATION` does not let it through as it lets the
  operation's own processes through `assertLifecycleAvailable`); no
  registration matches this root and state directory, running or not (`ahub
  up` registers a stopped project; when this root is registered with another
  state directory the error names `ahub --project <id> reset` instead, since
  `ahub up` would register the default directory and orphan that state); the
  hub's ownership is not verified (any inspection state other than stopped, running
  or stopping); a running hub reports a recovery operation whose phase is not
  `released`; `--all` with a state directory other than the literal
  `<root>/.agenthub/state` (an override or symlink elsewhere would cross file
  systems or pull outside state into the tree); `--all` when `.agenthub` or
  the state directory is not a real directory of this user, when
  `.agenthub/archive` exists as anything else (a symlink could carry hub.db,
  PII included, out of the project), or when its `.gitignore` is not a regular
  file (a symlink would truncate the file it names). These are checked before
  the stop and again right before the rename (`archiveProblem`); a hard-linked
  `.gitignore` is replaced by a temp file and rename, never written through.
  Checked, then renamed by path: a symlink swapped in between still wins
  (marked `ponytail:`; `renameat` on a held descriptor would close it).
- Between stop and act: after `stopProject` the CLI takes the project's
  registry claim (`Registry.claim` with its own pid and process signature), the claim a daemon must
  hold to run, and checks that no manifest names a daemon whose pid is alive
  or uncertain (`processLiveness`, the rule `inspectProject` uses, #226); either failing
  means a hub started in between and nothing is reset. A reset's claim carries
  the instance prefix `reset-`, so losing the claim to a concurrent reset says
  so. A crashed daemon's manifest (`status.json`, `control-token`, `hub.pid`
  with a dead pid, after SIGKILL or the forced shutdown exit; an empty or
  garbled `hub.pid` beside a dead `status.json` included) does not count: the runtime reset
  removes it and `--all` archives it. With the claim held, the CLI checks the
  machine's recovery lock again, so an upgrade or recovery that took it in
  between does not run beside the reset. The claim is released when the reset
  ends; a reset that dies leaves a dead or reused pid with its signature, which the next claim takes over.
- Failures: the plan is read only for the dry run, so `--all --yes` archives a
  state directory it cannot read as it is (its dry run says what it could not
  read). A failure after the stop says how far it got. A runtime reset that
  cannot read the state (a corrupt `hub.db`, malformed JSON or valid JSON of
  the wrong shape, which `planReset` checks as the journal would, a journal the
  constructor refuses: root mismatch, corrupt metadata, too many rows) fails
  the same way on a rerun, so its error points to `--all`; any other runtime
  failure is finished by a rerun, every step being idempotent. `--all` prints
  the archive path as soon as the rename happened; a failure before it says
  the hub is stopped and nothing was moved. JSON and SQLite errors are printed
  by class and code only (`failureText`): a parser's message can quote the
  data it choked on, envelope bodies and task text included.
- Runtime scope (default): the CLI opens the journal as a new instance, which
  turns the stopped run's dispatching and accepted rows into `needs_review`,
  and settles every `queued` and `needs_review` entry of `Bus.queueList`,
  including queue entries without a row, with `resolveDelivery(..., "discard",
  "reset")`: one `resolution_history` entry each. It clears manual holds
  through the bus, deletes the `budget_pauses` and `conductor_holds` rows and
  removes `sessions.json`, `claude-session.json` and `claude-context.json`,
  and a crashed run's manifest.
  The board, turns and touches, execution budgets, logs, `events.jsonl`,
  `cli-audit/`, recovery records, `pi-sessions/` and configuration stay.
- Full scope (`--all`): the state directory is renamed, unchanged, to
  `<root>/.agenthub/archive/state-<YYYYMMDDTHHMMSSZ>/` (0700); an existing
  target refuses the move. The archive directory gets a `.gitignore` of `*`
  (checked on every `--all` and rewritten when it differs) because `hub.db`
  holds task text, PII included; turn snapshots exclude `**/.agenthub/archive/**`
  as they exclude the state directory, also when the user's index tracks it or
  the `.gitignore` is gone; and `.agenthub/archive` is a
  `DENY_SEGMENTS` entry (`src/local/deny.ts`), so the local worker's and Pi's
  path guard, seatbelt profile and memory capture refuse it like
  `.agenthub/state`. A new 0700 state directory (created with `recursive`, as
  the status line tee may have re-created it) holds only a copy of
  `project.json`; the project id is the hash of its root,
  so the registration and id are unchanged. Archives are never pruned.
- Output says that claude-mem is not touched and that attached Claude Code
  sessions must be relaunched with `ahub claude`. The control protocol is
  unchanged: reset never talks to a running hub except to inspect and stop it.

## Amendment: model-based PII screen (issue #198)

- `routing.toml` `[signals] pii_screen = "off" | "local"`, default `off`; any other
  value fails the load like a bad pattern. With `off`, or with `constraints.pii =
  "off"`, nothing changes and no screen call is made.
- Order. With `local`, `Tasks.propose` screens the task's title, detail and plan
  text right after the pattern check and before triage. "Held as private" is met
  by holding the task back entirely: until the verdict it is not on the board, so
  no envelope, notice, triage call, brief or note of the hub's can read it. The
  local worker never captures hub tool calls (#230), so a proposal's arguments
  cannot bypass the verdict through capture. Writing it as
  a PII task first was rejected: a PII task opening lifts every silent turn-free
  cohort for good and switches facts off (#107, #108), so every proposal would do
  that. The proposal's tool call waits for the verdict, as it already waits for
  triage: for an ordinary task at worst the screen (8 s), triage (8 s) and a brief
  (2 x 2 s), 20 s; for a task the screen marked PII, triage first runs its own
  on-campus probe (two 4 s rounds when the gateway stalls), so about 24 s. Both
  stay under the plugin's 30 s control timeout. `hub_task_done` and `hub_review`
  put the screen (8 s) ahead of their existing waits, such as the briefs
  `releaseDependents` fetches for the tasks an approval releases.
- The screener (`screenPii`, `src/hub/inference.ts`): the on-device model when
  `mlx.enabled` and it can be had (`ensureMlx`, loopback only; a legacy MLX runtime
  is started the way Pi's relay starts it and keeps running until `ahub models
  stop`), else the gateway's `local.fixed_model` only while the
  daemon's `onCampus()` holds, with `onCampusOnly` so the client refuses an Access
  host once more before transport. One call per item,
  an 8 s deadline over the whole call, and a generation slot of its own: it asks
  for one without waiting (`acquire(abort.signal, 0)`: one look, then
  `MlxBusyError`); with all taken (Pi generating, another screen) it uses the
  campus gateway when `onCampus()` holds and otherwise waits for the slot under the
  deadline. On campus the device gets 60% of the deadline: an error reply or a
  device still loading then hands over to the gateway within the rest; off campus
  it keeps the whole deadline. `max_tokens` 32, temperature 0 and `reasoning_effort: "none"` on both
  paths, so a reasoning model does not spend the budget thinking. The
  prompt frames the text as data and carries Korean and English examples and hard
  negatives. The answer must be exactly `clear` or `pii <category>` with a category
  from `name, student_id, phone, address, grade, health, other`.
- Fail closed: an answer outside that form, a timeout, a failed or missing model,
  an off-campus gateway, or text over 6000 UTF-8 bytes (every token is at least a
  byte, so text and prompt fit the 8k on-device context; Ollama could otherwise
  judge cut input) is `unknown`. `pii` and `unknown` add the `pii` signal,
  so the task takes the whole existing PII path (local or nobody, user review,
  private envelopes, redacted views, no claude-mem). A pattern match is PII without
  a call. The source is recorded as a `screened` history entry (`pii: regex`,
  `pii: screen, <category>`, `pii: unknown, <reason>`, `clear`) and a `pii_screen`
  event; an unknown verdict is a console and hub.log line with the task id and the
  closed reason only. `route explain` on a draft does not call the screen and adds
  a trace line saying a proposal would. The cost of `unknown` is the cost of any PII
  task, even if a re-screen clears it later: it lifts every silent turn-free cohort
  for good and turns facts off while open, and off campus triage is not asked, so a
  classless proposal that is not a claim is refused with an error naming that.
- Re-screen. Off campus with the device slot taken, the verdict is `unknown`. A
  task whose last `screened` entry is `pii: unknown` (not `too long`, which a
  second look cannot change), that is still `proposed` and that no peer ever owned
  (no history entry carries an owner) has had nothing private sent anywhere, so
  `Tasks.rescreen()`, on the daemon's 60 s release timer (one task per tick, the
  least tried first, at most 10 tries per task in a hub run, in memory), screens it
  again. `clear` lifts the `pii` signal through `Board.update` (a `screened` entry
  `clear, screened again`), notifies by task, and routes it through the class
  peers (a named owner or a claim is not remembered; a reserved owner, #207, is
  offered first as `assign()` always does); `pii` settles it; another `unknown`
  changes only the event record. A task an owner took (`local`) keeps its PII path,
  also after it was declined back to nobody: its review notes, summary and decline
  reason were never screened.
- Free text (#69): the done summary, the review note with its unmet items, a
  budget hand-off (once per hand-off, however many tasks it moves) and a
  `hub_remember` note go through the same screen on an ordinary task when they
  match no pattern; a match is recorded as a `regex` verdict without a call. The
  call's cheap checks (owner, state, verdict, a running check, memory enabled) run
  first, then the screen, then the checks again on a fresh read. An escalation's
  reason is the hub's own text and stays pattern-only. `pii` or `unknown` withholds the
  item exactly as a pattern match does (stubs, no memory note, no summary line in
  completed-change or integration notices; `hub_remember` is refused). The board
  keeps the text and marks the history entry `withheld: true`, so public views,
  later reviewers, held cohort notices and `ahub ask` keep withholding it after a
  restart without another call. The check output tail of a done note, a plan given
  at accept, a decline reason, refs (paths, branch) and context checkpoint
  summaries stay pattern-only.
- Calibration (AC4): `test/fixtures/pii-screen.json` holds synthetic Korean and
  English positives across the categories and hard negatives (roles,
  placeholders, field and function names, ports, codes); none is copied from the
  prompt, and its account, passport and resident numbers have impossible lengths
  or dates. `bun scripts/pii-screen-eval.ts [--project <dir>] [--out <file>]` screens
  each item once, in order, through `screenPii` with the project's configuration
  and reports recall, recall as handled (pii or unknown), precision, the unknown
  rate, held negatives, category agreement and latency. The bound, fixed here
  before any measurement: the model itself labels at least 90% of the positives
  `pii` (an unknown verdict counts as a miss). The report goes to
  `docs/verification/`; the script exits 1 under the bound.

## Amendment: research records (issue #247)

- Opt-in per project (`research.enabled`, off by default). When a task is approved, the daemon builds its record from
  the project's `events.jsonl` with the same function `ahub research backfill` uses (`taskRecords` in
  `src/hub/research.ts`), so live and backfilled records agree, and appends it to the machine-wide store
  `~/.agenthub/research/<sha256(project id)[0:16]>.jsonl`. Records hold ids, states, counts, tokens and times only,
  because the events do; schema and fields: [research](../research.md).
- The board has no terminal state but `approved`, and it is final, so each approved task gets one record; a person's
  later verdict (`ahub task label`, including `abandoned`) is a separate label record bound to the task's proposal
  time. A task is keyed by project, id and proposal time, because `ahub reset --all` restarts the ids and the store
  keeps the older records. Measures (success, first pass, rework, check failures over checks run, tokens and wall time
  per task) are derived when reported, never stored.
- The record counts everything attributed to the task, the turn that approved it included: that turn ends after the
  approval and its usage arrives later, so the writer waits until no open turn is attributed to the task (polled every
  10 s, at most 30 minutes; a stopping hub writes once its peers have stopped). The first record written for a
  task is final; a label binds to the current board's task, else to the store's only record with that id, or with
  `--created` to a named one from before a reset. Task events carry the board's move `reason` (a closed
  list) so reassignments are counted by reason.
- Recording never blocks or fails the task flow: the writer runs after the board event, and a failure is one
  hub.log line per run. ponytail: it reads the whole events file for each record; an incremental per-task index
  if that file grows large.
- Agents may read the measures and export. `research backfill` is the person's or the configured conductor's, and an agent labels only its own task, where a person's label always wins (#933 amendment; identity gate).

## Amendment: proven Pi tool refusals and idle exit recovery (issues #254, #255)

- A trusted guard uses `PreEffectToolRefusal` only when that operation has performed no task or board effect; PII screening and its telemetry record may precede the refusal. Pi receives the same `error: <message>` refusal as the control client, and its session/call receipt is `done`. Initial task ownership/dependency/state checks and conductor entry peer/mode/assignment/escalation validation opt into the type; shared helpers default to ordinary errors, and conductor checks after an awaited release validation stay ordinary. Generic errors, board readback failures after a write, and receipt settlement write failures remain uncertain/pending and are never repeated. A legacy pending row has no pre-effect proof in its stored fingerprint/state/result, so startup preserves it; neither present board state nor a matching error message establishes historical refusal.
- Each Pi owner reports one exit with cause, exit code or signal, whether startup completed, whether a turn/tool was active, whether teardown was expected, and the last validated tool name only. TUI shutdown/owner-loss and verified stop teardown lack observed OS status and record unknown. A successfully stopped claimed TUI owner reports once; a never-owned launch reports no invented exit. Replacement teardown says the owner stopped for a new Pi owner even if replacement startup is refused. Internal teardown notices direct inspection and `ahub pi`, without claiming a person requested them. Replacement, failed-start and active-turn guidance takes precedence over the automatic-start-disabled notice. Console notices name the next action or automatic-start state; headless code 0 is still an exit and settles active deliveries as uncertain.
- With `pi.auto_start`, an unexpected idle headless exit attempts its verified persisted session once in a 60 s window. The daemon owns the attempt/window across adapter replacements, blocks throughout an in-flight attempt, and rearms the 60 s window when that attempt settles. It checks current-owner identity, completed startup, turn/tool inactivity, start serialization, shutdown and recovery before and after awaited receipt drain/session capture. Missing or invalid persisted state leaves Pi offline with `ahub pi` guidance, with no fresh-session fallback. A second exit inside the window stays offline. Requested stops, stale owners, startup failures, active turns/tools and native terminal exits never trigger this automatic path; crash recovery's existing #66 behavior remains separate.
## Amendment: benchmarks (issue #251)

- `ahub bench` runs a person's suite file (tasks with a starting commit, an optional setup and a verify command)
  against the peers attached to a hub, in a project opted in with `bench.enabled`, because every attempt resets the work
  tree (`git checkout --force --detach <commit>` with HEAD checked against the pin, `git clean -ffdx -e /.agenthub`, then a
  clean-tree check). Before
  anything changes the runner requires the project to be the root of its repository, nothing tracked under `.agenthub/`
  (in any letter case) in the tree or in any suite ref, every ref to be a commit, which it pins for the run, and a
  clean tree. The runner is a console client: it proposes each
  task as the console does and polls the board, so the task flow is unchanged and no new control request exists.
- `setup` and `verify` run in their own process group, bounded; the group is stopped at the bound, on an interrupt and
  when the command exits. An approved attempt's measures come from #247's `taskRecords` for the task proposed last with
  that id, read once the turns started since its proposal have ended (waiting only while their peers are busy or
  paused, at most 10 minutes, outside the attempt's duration); a timeout, an error, an interrupted wait, a wait that
  runs out with the turn still open, or a hub status that cannot be read while it is open leaves none, never partial
  ones. The fingerprint lists only the peers attached at the start.
- Results go to `~/.agenthub/bench/<run>.jsonl` (ids, outcomes, exit codes, counts, times; never suite text or command
  output). A run's state comes from its end record or its runner's liveness (`processLiveness`). Comparisons are
  derived when asked: an arm is every run of it that is over (a stopped run included), runs of different suites or
  suite versions are not mixed unless asked, and each difference has a seeded 95% bootstrap interval, inconclusive
  below five attempts counted for that measure per arm (errors are not counted for pass rate or wall time).
- A task that times out stops the run, because an agent may still work in the tree the next attempt would reset.
  ponytail: a board state to withdraw an open task would let the run continue. The fingerprint holds what the hub's
  status reports (a requested model for Pi, permission modes once #242 lands); ponytail: read each peer's launch
  settings for the rest.
- The dashboard snapshot carries run summaries and per-arm measures only. `bench run` is the person's or the configured conductor's (#933 amendment; identity gate,
  wherever `--json` stands); reading results is not. Schema and commands: [bench](../bench.md).


## Amendment: Pi/local approval expiry and cancellation (issue #253)

- An unanswered Pi/local approval returns an explicit expiry result: no person answered, do not retry that call, hand off or stop. It is not an answered denial. Two consecutive expiry results in the same native Pi turn or local worker turn end that turn with a console notice. An expiry counts toward the streak only when no person answered a request of that peer while it was pending (a per-peer answer epoch makes a parallel batch safe for an answering person); a grant served from the always cache or a permission mode is not an answer and does not reset the streak, and an actual new turn resets it. The turn ends through the same abort path an execution-budget stop uses, so Pi stays attached and the sender is told the approval reason. Supported Pi and local complete that correlated delivery after the reason reply, allowing the next queued message without an operator release. Pi clears the turn-only approval state at settlement and failure, so idle human shells remain usable and later failures cannot inherit its reason; a delayed approval abort rechecks that the same turn is still running. An extension that cannot abort a turn (one that does not advertise `approvalTurnAbort`) leaves Pi offline instead, with `ahub pi` restart and held-delivery settlement guidance. The second result remains an expiry tool failure before the abort. Approval stops do not invoke automatic safe replay or inference handoff.
- Tool cancellation reaches the central approval registry. Settlement atomically removes the request and timer/abort listener before publishing closure or resolving. Late answers fail, cannot populate Pi's exact-tool always cache, and do not hold recovery waiting for approvals. Tool and budget continuations retain their captured session/generation; an admission response rechecks the owner and controller before changing a timer or recording a stop, and an old extension callback never aborts a later turn. Normal tool requests carry the session and generation captured before budget admission; the bridge refuses missing/stale lineage before registry, receipt or effect work, with restart guidance for an older extension. Spawned headless owners are pinned by the actual child process signature and its proven RPC session; TUI owners require the native claim. A Pi native abort is scoped to the verified owner, session, turn generation and call id; it withdraws only that call. Early native aborts fence a bounded set of call ids, with overflow failing closed for the remainder of that running turn. A managed tool that does not settle within the stop grace does not block the teardown: the stop goes on (shutdown, owner teardown, process stop) and reports the failure at the end.
- A person's TUI shell command uses the existing authenticated idle reservation, session/owner/generation validation, sandbox and run-budget admission. It bypasses hub approval only in that trusted context and returns the sandbox's structured exit code through the receipt and native extension. Model tool arguments or printed output cannot establish human origin or exit status.
- The dashboard counts waiting Pi/local approvals and directs the person to the console or `ahub tail` / `ahub permit`. It keeps those rows deny-only and never reveals private titles.

## Amendment: requested headless peer stop (issue #278)

- A console-role `{ t: "peer_stop", peer }` request stops a hub-owned headless ACP, Pi or local runtime through its adapter's owned-runtime teardown. Success is `{ ok: true, state: "offline" }`; refusal or incomplete stop is `{ ok: false, error }` naming the reason and next action. New requests already receive an unknown-request reply on older hubs, so `PROTOCOL` stays unchanged.
- Refuse agent/tools-role callers, unknown or offline peers, Claude/Codex and Pi TUI owners, and recovery/shutdown-held mutations. Starts, requested stops and permission changes are fenced per peer; recovery preparation waits until requested stops finish. A TUI is ended in its terminal, or by the upgrade plan's verified terminal binding.
- A requested stop marks each in-flight delivery `needs_review` with a fixed ids-only stop reason, cancels pending approvals, and fences stale native completion/failure callbacks. It never completes or implicitly redelivers interrupted work, invokes failure escalation, or triggers Pi's idle auto-restart. The operator inspects effects and explicitly resolves the delivery before replay. Queued unattempted work remains for the next manual start under existing holds/pauses.
- `ahub stop <peer>` is available to the person or the selected project's configured conductor in `classifyPeerCommand` (#812). The conductor retains its authenticated peer identity and audit; other agents receive the person guidance promptly, including when the hub is unreachable. It prints the returned state and reports an older hub's unknown request as requiring an upgrade, with a nonzero exit. The upgrade plan's headless `endPlannedPeer` uses the same console request; the daemon does not close a native terminal.

- Requested stop admission also holds per-peer drain, pull and steering before any teardown await, without changing operator/budget pauses. Arriving work remains queued for explicit restart. Idle Pi captures live empty-session proof before stopping; a first accepted prompt with unpersisted history is not silently recreated as empty.

## Amendment: settings from the dashboard and the terminal (issue #269, part 1)

- The dashboard stops being read-mostly for one closed list: a settings registry in `src/hub/settings.ts`, one entry per editable setting (key, type and allowed values, the store, when it applies, and whether it can raise authority). The dashboard's Settings section and `ahub settings list|get|set|undo` render from it and write through it; a key outside it cannot be written from either. Keys that choose what the hub runs or where secrets and task text go (`kimi_cmd`, `codex_bin`, `pi.cmd`, `checks`, `mlx`, `omniroute`, `memory.worker_url`, `local.read_allow`, `local.bash_network`, `local.network_allow`, `bench.enabled`, `terminal`) are refused by name from every surface.
- First list: `permission.<peer>` (the running mode, the console's `permission` request), `permission_modes.<peer>` (the default at hub start), `pi.auto_start`, `routing.stay_switch`, per class `routing.classes.<class>.peers`, `.escalate_to`, `.route` and `.pi_backend`, and the switches `research.enabled`, `approvals.notify`, `snapshots.enabled` and `coordination`. Start modes (`peers.<id>.start_mode`, the terminal provider, Pi's TUI default) are part 2 of the issue.
- Stores: config values go to `.agenthub/config.local.json`; routing values go to a new machine-local overlay, `.agenthub/routing.local.toml`, which may hold only those routing keys and is merged over `routing.toml` key by key by the one loader (`parseRouting`). `assign()` stays pure; its trace, and so `ahub route explain`, names the keys the overlay set. The tracked `config.json` and the hand-written `routing.toml` are never written, a machine-local file that git tracks is refused, and `ahub init` adds the overlay to `.gitignore`. A write is validated by the real loader first (a scratch copy for the config, the parser for the overlay), replaces the file through a temp file and rename, and keeps one previous version: undo restores it, refuses when the file changed since, and validates what it restores. The undo record is written after the file, so a write that failed leaves the earlier undo in place. A write that would change nothing (the same value again, or removing a value that is not set) writes no file, keeps the undo record and records no event. A config setting is refused in a project that has no config file at all (neither `config.json` nor `config.local.json`): its first config file would switch the project defaults on (snapshots, limits, the budget relay), and that is `ahub init`'s to do. In a repository where git cannot say whether the file is tracked, nothing is written; a project outside git has nothing tracked. Removing a machine-local value (`inherit`) is a write like any other. When config trust (#17) drops the written field at load (`permission_modes` in a file git cannot vouch for), the reply and the setting's row say that the hub does not read the value.
- Authority. An ordinary dashboard session reads settings, lowers a mode to `ask`, turns `pi.auto_start` off and changes the safe switches. A settings session, opened by `ahub ui --settings` (a console command behind the identity gate, a console-role `ui` request with `settings: true`), may also raise: a non-ask mode or default, routing, `pi.auto_start`, removing a machine-local value, and undo. Its ticket marks the session for 15 minutes; afterwards the session continues as an ordinary one until its hour ends. `never-ask`, running or stored, needs the peer id as the confirmation (typed in the dashboard, `--yes` in the terminal); a stored never-ask default still waits for the console's `y` at each hub start (#242). No other path puts never-ask on disk: an undo that would restore it is refused (set it again with its confirmation), and `inherit` that would uncover a never-ask from the shared file needs the same confirmation. Tool approvals stay deny-only for Pi and local in every session. The unified dashboard forwards settings actions with ordinary authority.
- A mode set from the dashboard or `ahub settings` is `changePermission` inside `permissionChange`, the console's path, with its refusals (not attached, unverified Claude hook, unattended Codex or Claude, a stop in progress) and its `permission_mode` event.
- Preview before save: a routing change returns `route explain` for up to 20 open tasks under the policy in force and under the candidate (PII tasks are counted, not shown); a mode change returns the peer's bounds and what the mode grants.
- Every change is announced in `hub.log` and open consoles with its source and recorded as a `settings` event: key, value before and after, source (`dashboard` or `terminal`), `undo`. Values are closed words, booleans, peer ids or route ids, never free text.
- Control protocol: `settings_get`, `settings_set`, `settings_undo` and `settings_preview` are new console-role requests, and `ui` takes an optional `settings` flag and echoes it; an older hub answers the requests as unknown, and the CLI refuses a `ui` reply without the echo, so `PROTOCOL` stays 16. The `ui_snapshot` reply gains an optional `settings` object. Events schema stays 1.
- `ahub settings` talks to the running hub (ponytail: a file-only path if setting a start-time value on a stopped hub is ever wanted).

## Amendment: structural configuration from the console and the dashboard (issue #689)

- The registry (`src/hub/settings.ts`) stays closed and unchanged. A second path, `src/hub/config-edit.ts` (plan and write) with `src/hub/config-tier.ts` (the tier rule) and `src/hub/config-edit-host.ts` (authority, confirmation, audit, scoped publish), edits structural keys. Tier 2: `instances.<id>.{kind, roles, start_mode, review_mode, readOnly, worktree, permission_mode}`, `review.{adaptive, min_reviews, pool, rerotate}`, `snapshots.keep`, `approvals.timeout_s`, `context.gate` (all `config.local.json`) and `sdlc.toml` `mode` and `required_checks`. Tier 3: the rest of `NEVER_EDITABLE` and an instance's `jcode_home`, `provider`, `model` and `provider_profile`. `roster`, `tasks.wip_limits` and the other registry keys are refused here with the registry command.
- Validation is the daemon's own: `parseConfigSources` (raw bounds and instance declarations through `readInstanceConfig` and `validateInstances`), `loadConfig`, `checkJcodeInstanceHomes` for `config.local.json`, `sdlcConfig` for `sdlc.toml`. A loader's reason is returned as it is with the `field` it names. A candidate is built from the file on disk, and a request that would drop a tier 3 field of an existing instance (by replacing it with a tier 2 object) is refused.
- Writes: revision check against the disk when planning and again before writing (sha256 of the file, or `absent`); a bounded backup in `<state dir>/config-backups/` (the newest five per file); a temp file and rename in the same directory with the file's mode; never a git-tracked `config.local.json`, a symlink or a file over its size limit (1 MiB, 64 KiB for `sdlc.toml`). `sdlc.toml` is edited line by line for `mode` and `required_checks` only, and the result is parsed and compared with the intended change before it is accepted.
- Tiering reads the file: `configTier(file, path, value, held)` makes `instances.<id>` tier 3 to remove or replace when the instance holds `jcode_home`, `provider`, `model` or `provider_profile`, and `maskTier3` shows every tier 3 value in a reply, a diff line or a notice as `(set)`. `readEditable` refuses a symlinked `.agenthub` as well as a symlinked file, `viewRevisions` reports `unavailable` instead of throwing, and the sdlc editor keeps each untouched line's own line ending.
- Authority: the console role (`config_edit_get`, `config_edit_preview`, `config_edit_apply`; `settings_get` also carries the file revisions) or a dashboard settings session (`config_edit_preview` and `config_edit_apply` actions; the manager forwards both). An ordinary session, a tools or peer connection and any agent shell are refused. A tier 3 key is refused for a dashboard session by the hub and is console only, with the key's name typed as the confirmation (one key per write). Recovery or shutdown holds edits.
- Publication: `reloadConfig` stays the only path. The editor publishes each changed leaf with its own scope and registers that scope for the one reload (`structural` in `authorizeConfigLeaf`, admitted only for `config.local.json`, source `config` and `structuralLeaf`), so a settings session can publish a structural edit and nothing else it could not before. Instance declarations are restart-bound (`pending restart: instances`); `sdlc.toml` is read once at start and is added to `pendingRestart` in `status.json`, the console snapshot and the settings view until the running lifecycle equals the file.
- Audit: a `config_edit` event (`file`, `paths` as `{path, before, after}` short value hashes, `fileBefore` and `fileAfter` revisions, `tier`, `source`, `by: "person"`, optional `reason`, `backup`). No value, no secret and no home path enters the event, the notice or `hub.log`.
- Console: Settings key `c` (what to edit, each field, the hub's diff or loader reason, a reason, `y`; a tier 3 key asks for its name instead of `y`), `R` while a restart is pending prefills `restart`. CLI: `ahub settings edit` and `ahub settings backups`. Dashboard: a Structure group in Settings (forms inside a settings session, read only outside one, tier 3 as text with the console command, restart-pending badge, backups), both themes, 44 px targets, one column at phone width.
- Control protocol: three new console-role requests and two new dashboard actions; no `PROTOCOL` bump, an older hub answers unknown and the CLI says to upgrade and restart it.
- Unverified: a live `ahub ui --settings` browser session and a real restart that picks up an edited `sdlc.toml` (the person's leg).

## Amendment: TUI by default, headless as opt-in (issue #269, part 2)

- `peers.<id>.start_mode` (`tui` or `headless`, for pi, codex, kimi and jcode; `tui` when unset) is the mode a start takes when nothing more specific was asked. Claude has only a TUI; Kimi defaults to its own pull-only TUI, with ACP selectable; local stays headless. The loader refuses a malformed `peers` block.
- A person typing `ahub pi` gets that mode: the TUI in their terminal by default. `--mode headless` or `--headless` asks for headless. Without a terminal (the console's command line, a script) and with the default asking for the TUI, the CLI sends the console-role `peer_start` request and the hub opens a terminal, or refuses with the command; an option given then is refused, because the fixed command carries none. An explicit `--mode tui` is taken at its word. `ahub codex` and `ahub claude` typed by a person are unchanged.
- A start the hub makes itself is `hubStart(peer)`: the dashboard's `start_peer` action, `peer_start`, the conductor's `hub_peer_start` and `pi.auto_start` at hub start. With `headless` it starts the peer as before (for Codex: the app-server only). With `tui` it opens a terminal running `<runtime> <CLI entry> --project <root> <peer>` (`--mode tui` for Pi), assembled from the hub's own words and quoted word by word; no caller text is part of it. The peer is reserved before the provider is asked, so starts that arrive together open one terminal, and a second start within 30 seconds of an opened terminal is refused instead of opening another (a failed open frees it at once). A start mode of headless never takes over a Pi that runs in a terminal.
- Terminal providers, in order: `terminal.open`, a machine-local argv template (`{command}` in exactly one element, plus `{title}` and `{cwd}`; a `MACHINE_LOCAL` field under config trust and on the never-editable list), then Orca (`orca terminal create --worktree id:<id> --command ...`) when the hub runs in an Orca worktree or a recorded launch of the project names one. Each template placeholder is substituted once; only `{command}` is shell-quoted. The opened terminal's environment carries no agent marker and no Orca terminal identity of the hub's own. A provider's error text is logged, not returned. With no provider the start is refused with the manual command; it never falls back to headless. Only the running product wires the real providers; a daemon constructed without them opens nothing.
- The conductor's `hub_peer_start` no longer takes a mode: it takes the peer's start mode, and a `mode` argument that differs is refused. It may now start claude and codex through the provider, and codex headless when a person set that.
- Recovery restores each peer in the mode its recorded session had. After an unplanned stop, `pi.auto_start` no longer starts a fresh headless Pi in place of one that ran in a terminal (with or without a recorded session file), unless headless is Pi's start mode. `peers.<id>.start_mode` may be set in the shared config file too: it is not a machine-local field.
- Settings: `peers.pi.start_mode`, `peers.codex.start_mode` and `peers.kimi.start_mode` and `peers.jcode.start_mode` join the registry (group Start, stored in `config.local.json`, raising except to `tui`). They are the one stored setting a running hub takes up: after a settings write the hub re-reads the block, so the mode applies at that peer's next start. The dashboard gains a Start control per peer that is not attached, saying the mode and the provider (or why there is none); it offers no button when the start would be refused. An ordinary session may press it: it runs only the fixed start. The page blocks repeat starts while the request is in flight and unlocks after a confirmed answer, leaving the hub's terminal reopen guard authoritative. The manager waits 35 seconds (the terminal provider cap plus its margin); a slower headless start can end unconfirmed. After an unconfirmed manager result the page holds that project/instance/peer control for `PEER_START_RETRY_MS` (the same 30-second bound as the hub's reopen guard), or until the `starts` snapshot confirms attachment, and names the retry bound. A confirmed project-local dashboard start behaves as before; no manager or settings authority changes.
- Control protocol stays 16: `peer_start` is a new console-role request an older hub answers as unknown, and `ui_snapshot` gains the optional `starts` list.
- Migration: Pi's default changes from headless to its TUI. `ahub settings set peers.pi.start_mode headless` (or the same key in `config.local.json`) keeps a headless auto-started Pi; scripts add `--headless`.

## Live peer roster (#315)

The native catalog comes from `KNOWN_PEERS`. A boolean `roster.<peer>` setting
controls participation through the existing settings registry, store, preview,
write, undo and authority. Without a roster entry, the existing defaults apply;
Pi uses pi.enabled only as that fallback. A future catalog member defaults off.
External ids retain their existing admission rules.

Only a person changes the roster. Removal is available to an ordinary dashboard
session, while adding requires a settings session or terminal. The active
conductor cannot be removed. Removal is previewed and confirmed; an active turn
requires --now. Owned runtimes stop and personal native terminal sessions detach
without closing their native process. Removed peers receive no new messages or
assignments and cannot start or attach. Queued and uncertain work is retained,
with off-roster rows visible while work remains. Runtime permission overrides
are cleared; configured defaults govern return, with existing pauses preserved.

The roster view shows the whole catalog; status remains lazy. Owner and reviewer
work uses the existing reassignment. No eligible replacement means the previous
assignment remains with a public-title notice. Membership enters the pure
assignment function as data, so route explain states the same off-roster reason.
A live write or undo changes only its authorized key, not other config edits.
Tracked defaults and machine-local overrides are read normally on the next hub
start. The CLI and dashboard use the settings API and no roster hub tool exists.

Removal orders its steps as membership fence, detach or stop, then handoff. Its
preview and result name the peer whose retained terminal work the person must
stop, and the result lists the saved task moves with public titles. Detached
sessions receive no forced stop notice or journal bypass. Codex 0.146.0 exits
its TUI on close 4000 rather than retrying. Its app-server/proxy and terminal
window remain; preview/removal/return print ahub codex resume with the full
thread id when known, or the native resume picker. After adding it back the
person runs that command. Automatic return is guaranteed for the Claude
channel, not this observed Codex version. The preview names
roles offered and those without a replacement; the result names every saved
move and every assignment that stays. An unconfirmed stop reports the skipped
permission reset and handoff after the roster write.

Removal includes in-review ownership (keeping its review state) and reviewer
roles. Later task messages follow the current owner/reviewer. An explicit
off-roster recipient is retained, including one recipient of a mixed audience,
with one public notice to the person; native senders get a decision note and
console/channel senders get the existing notice field. A removed personal Pi TUI
whose verified native owner is alive still blocks controlled recovery under the
existing settlement fence; the person ends that retained TUI before restart. Broadcasts omit removed
peers, and a person or agent addressing only removed peers is refused before
publication. The dashboard roster undo carries peer confirmation.

Pi detached/unowned native activity preserves only monotonic generation from
the authenticated bridge and verified owner (the legacy unnamed event uses
that current-session binding; an explicit session mismatch is refused). Personal
output, tokens and managed turn state remain unclaimed. That activity revokes
an earlier empty-session resume proof; stale unowned completion cannot release
the queue.


## Amendment: Kimi TUI as the default pull-only peer (#316)

- One id, kimi, owns either an attached pull-only WsPeer or headless ACP. The unset
  start mode is tui for existing and new projects; upgrade announces the change
  once with `ahub settings set peers.kimi.start_mode headless`. A person's one-start
  mode override also controls that launch's admission, without changing the setting.
- Only a person's launcher atomically merges or removes the agent-hub entry in
  `.kimi-code/mcp.json`. It preserves foreign meanings, warns if tracked, and a
  preview writes nothing. Init ignores the untracked machine-path file. A daemon
  headless start refuses a stale entry with the human cleanup command. TUI argv
  derives only from a single executable or an exact trailing acp word.
- In TUI mode only a peer hello with channel false is admitted. It reads queued
  chat/task/review via hub_inbox, journaled completed once, and answers via hub_send.
  It has no push, steer, busy state, watchdog, console approval, hub permission
  mode, automatic quota pause/handoff, context reading, shared final answer or
  session resume. Status surfaces pull-only, waiting and last read. Stop belongs
  to the person in the native terminal. A live TUI blocks headless replacement;
  after detach the same queue and open tasks reach ACP, without continuing its
  session in the TUI.
- Pure routing excludes every automatic Kimi pull-only candidate, including automatic
  singleton escalation/handoff. Explicit proposer owner/own claim, validated owner
  assign and honored persisted reservation are named. Reviewer assign is person or
  conductor only, preserves task state and uses the existing guarded review request;
  dependencies must be approved first. No roster/PII/pause/capability guard is bypassed.
- Kimi Code 2.1.1 source preflight confirms trusted ACP workspace MCP file discovery
  and a separately connected same-name session overlay. The engine does not carry
  MCP initialize instructions into its model request: tool descriptions and the
  managed AGENTS block carry the pull rules. Live trust/discovery and model tool
  use remain unverified in smoke.md.
- Recovery for #316: an attached Kimi TUI carries `launch.mode: tui` and blocks controlled upgrade/restart planning before effects, with the human end-and-replan instruction. It is never restored as an ACP worker. Headless restoration explicitly selects headless when the staged target catalog includes Kimi modes; legacy targets retain their old no-mode command. The target catalog read is a stated source-capability shortcut.
- A person/conductor changing the reviewer of an in-review task withdraws unread prior requests and sends the former reviewer a withdrawal notice. Already-delivered requests cannot be recalled; current reviewer authority rejects a late verdict. Publication failure remains guarded after the saved board change.

- Compatibility: Tasks supplies Kimi TUI ids to the generic pure pull-only filter. Legacy Claude pull-only sessions retain existing automatic owner/reviewer selection and queued inbox requests. Init adds the Kimi ignore for an existing untracked MCP file, preserving previous ignore bytes when the file is absent.
## Amendment: offline ACP approval fencing and lexical scoped-path checks (#311, #322)

- ACP cancels new permission requests while offline or waiting for watchdog cancellation, before consulting either approver. Pending permissions carry abort signals to the daemon approval registry and are withdrawn on watchdog cancellation, offline transitions and stop. Late answers cannot grant them; a restarted session may request approval normally.
- An acknowledged ACP permission-mode change waits for watchdog cancellation cleanup only when that prompt response has already been observed. A mode acknowledgement while the prompt is still unreported returns without declaring it idle or delaying cancellation diagnostics. Native prompt cleanup releases the gate; its existing bounded deadline, stop and transport loss also release it, preserving offline and stale-turn fences.
- Pi and local write/edit approval passes the original path separately from the `guardPath` real target, through every wrapper. Scoped automatic grants require both project-relative forms to avoid protected names. A protected directory symlinked into an ordinary project directory and an ordinary alias into a protected directory both require a person. `realPath` and the post-approval target check remain the authority for effects. Explicit approval and never-ask keep their meaning.

## Amendment: further scoped-grant exclusions and instruction option (#323)

- `.agents` and `.claude.json` join the folded protected configuration names. The dated source inventory records the supported project locations and discovery limits; `.claude.json` is excluded conservatively without a project-loading claim.
- `protect_instruction_files` is machine-local, boolean, false by default. Only the settings registry exposes it, as `scoped_grants.protect_instructions`, in Permissions, applied live after a write or undo. A person may change it; no agent surface gains a setter. Lowering protection from an ordinary dashboard session is refused.
- Enabled protection withholds scoped automatic writes/edits to `AGENTS.md`, `CLAUDE.md`, `QWEN.md`, folded like configuration names in both lexical and resolved paths. Reads and explicit approval/never-ask retain their meaning. Default grants remain unchanged. The daemon downgrades a Claude scoped grant reply for a protected write as well as supplying the optional flag to the current hook, so an older hook cannot silently ignore protection.

## Amendment: initial head-bound SDLC gates (#257)

- Optional .agenthub/sdlc.toml selects off/advise/enforce, off by default, with a fixed built-in stage order and bounded explicit required check names. The initial delivery has no custom stage/gate language.
- Tasks owns optional board artifact receipts and every mutation. Repository, issue/PR ids, claimed local result/head and a reviewed full SHA are distinct from fresh external evidence. Only the owner/reviewer/person records; only the reviewer/person binds a review head. Invalid identities, unsupported externally supplied facts and private-turn cloud records are refused before effects.
- Enforce rechecks the current PR head, successful required checks, local receipt on that head, GitHub review and complete unresolved-thread readback before approval. Missing/unknown data blocks, a new head invalidates derived readiness, and changes requested needs no green CI. Advise exposes gates without additional blocks; off retains existing transitions. Historical board approval is not approval of a new head.
- CLI sdlc status/explain reads bounded structured metadata, not remote bodies. Shared console/dashboard views expose unknown external evidence and the next actor/action; they cannot certify freshness. No merge/release authority is granted.
- Later custom definitions and read-only merge/release reports are described below. #481 supersedes the original lifecycle vocabulary and workflow option; a full native advise cycle remains pending. See docs/sdlc.md.
## Amendment: optional Qwen Code 0.25.0 ACP peer (#256)

- `qwen` joins the known catalog with default participation off. Only the project's roster selects it; no second enabled switch or default routing preference is added. Its flow roles default to implementer/verifier, which is guidance, not a claim of native reliability.
- `qwen_cmd` is machine-local, default `["qwen", "--acp"]`. The CLI, conductor and dashboard share the normal start/stop/permission fences. `ahub qwen --print-command` previews without execution; only headless is offered before #286 native TUI verification.
- Production Qwen explicitly requires the ACP native identity `qwen-code`, version `0.25.0`. The mode table is ask/default, ask-when-needed/auto-edit, never-ask/yolo; auto and plan are unmapped. Available mode ids and successful set-mode acknowledgement precede every first prompt. Fresh/resumed sessions start at the operator's selected mode, including ask. Wrong identity/version is refused without a model turn. Existing benchmark ACP instances do not opt into this production table and retain their native policy.
- Qwen runs its own tools and has no hub sandbox. Never-ask text and confirmation say yolo approves every tool. Exact canonical hub-tool approval remains bound to the announced call id and this session's server names.
- Context occupancy carries the native session and acp_usage_update source. No unobserved quota is inferred or automatically paused/handed off; manual pause stays available. Native startup errors and stderr diagnostics withhold host/payload details. A source using Qwen cannot stage a target without Qwen support and then strand its restore after shutdown.
- CLI/source version drift was observed locally: the installed CLI prints 0.25.0, its package and ACP source say 0.24.1. That installation is not native readiness evidence. Real 0.25.0 provider/turn/quota verification remains owed; fake tests and strict runtime verification are separate proof.

## Amendment: optional owned Jcode peer (#332)

- jcode is optional on the roster, default off, with implementer/verifier guidance and no default routing replacement. Its native identity is jcode from 0.98.0 (the minimum; verified live on 0.98.1) up to, not including, 1.0.0 (the assumed breaking version); the minor is not pinned. Lower the breaking version when a release is shown to break the contract (#529).
- A private foreground daemon/socket and ACP client belong to this peer. The global daemon is never adopted or stopped. No automatic update, self-dev or credential copy. The native MCP store must already exist to avoid implicit Codex import.
- ACP session MCP arrays are ignored natively, so the person launcher manages only agent-hub-jcode, shared:false, in project .jcode/mcp.json. Later override layers, foreign names and links refuse. Daemon starts verify read-only. .jcode is outside scoped grants.
- Native policy is unmanaged and has no hub sandbox. Hub permission mappings refuse; native quota/consumption are not inferred. Every task mutation stays in Tasks and PII remains at existing redaction/routing boundaries.
- Jcode's default start mode is `tui`; `--mode headless` and `peers.jcode.start_mode: headless` retain the owned headless driver. Mode precedence is the explicit flag, the running hub's accepted mode, then the file/default. A console `peer_start` opens the same waiting launcher through the terminal provider, including when ACP is already running; a conductor `hub_peer_start` or dashboard start of an attached jcode answers `already` and opens no terminal, so a repeated call never adds another TUI writer to the live session (#559). With no provider the answer is an actionable terminal command, never a headless downgrade.
- J1.4 (#464): the 0.98.1 native receipt disproved persistence after `session/new`. A person launcher opens the top-level `jcode --socket S --resume ID` only after bounded native saved-session evidence for the same launch, socket and session. Until then it prints once: `jcode's TUI opens after its first hub turn; send it work, or Ctrl-C`. Ctrl-C ends that wait without stopping or cancelling ACP. No artificial production prompt or hub-created native session JSON is allowed. The native prerequisite and account limits are recorded in `docs/verification/2026-10-20-jcode-tui-0.98.1.md`.
- The actual private tuple is available only through the authenticated console-only, feature-negotiated `native_tui_launch` request, never status, tools replies or generic start replies. Pure dry previews remain redacted and start nothing; a person's print-command may resolve an already-saved running session. TUI argv preserves the owned command prefix, model and provider profile; its environment selects the same native home/socket and telemetry opt-out. No `jcode connect` path or external/global daemon is adopted.
- J3's lack of a single-writer guard is accepted: a person's TUI input may interleave with a hub ACP turn. Closing the TUI keeps the owned ACP runtime alive. Owned ACP recovery metadata remains headless. The TUI terminal is not recorded as a managed terminal binding (#564): controlled recovery of Jcode is refused at plan time, so, like Kimi's TUI, it has no terminal recovery adapter; native session/load identity refusal is unchanged.
- The private socket name ends in `.sock`: jcode names its debug socket by replacing that suffix. Every owned jcode process runs with `JCODE_NO_TELEMETRY=1` (#529).
- Native ACP load (verified on 0.94.0 and 0.98.1) lacks identity proof. Controlled recovery refuses before effects, crash recovery is manual and a load without an exact echoed id refuses before a prompt or restored claim. Real provider/tool/teardown evidence and comparative measurement remain unverified.

## Amendment: extra Jcode instances (#685, #368)

- `instances.<id>` accepts `kind: "jcode"` only from the untracked `config.local.json`, up to 8 Jcode instances per project. Instance-only, machine-local fields: `jcode_home` (required: absolute, control-free, at most 4096 bytes), and optional `provider`, `model` and `provider_profile` (one bounded printable word each, passed as `-p`, `--model` and `--provider-profile` exactly as written). Any other field is refused. The definition declares `instances.nativeHome`; no other kind accepts these fields, and settings never edit them. `checkJcodeInstanceHomes` runs once at daemon startup and refuses a `jcode_home` equal to the base `jcode_home`, equal to another instance's, or nested inside or around either (their native stores would overlap). Homes are compared by the directory they name: resolved with `realPath` (symlinks and system aliases such as `/tmp` and `/private/tmp`, the nearest existing ancestor for a home not created yet), compared case-folded on a volume that folds case, and by device and inode when both exist. `instances.nativeHome` is a fixed-builtin capability: `assertNativeCapabilityScope` refuses it on any configured or external definition. `ahub jcode --as <id> --print-command` and `--dry-run` preview the same `-p`, `--model` and `--provider-profile` flags the daemon passes (values redacted).
- The person authenticates inside Jcode against each home. The hub handles no model credential, key, token or provider URL, and there is no hub model relay for Jcode (the on-prem model is a provider profile the person configured). The start preflight is read-only: `jcode_home` must exist as a directory owned by the person (`jcodeHomeRefusal`), otherwise the start is refused with the instance id and no path. The hub's argv for an instance is the base Jcode argv plus its own three values, with its own `JCODE_HOME` and socket. It reads or writes nothing under `jcode_home`; only Jcode and the existing owned-state paths do. Usage is reported only if Jcode itself reports it, otherwise `unknown`, never 0.
- Each instance is one `JcodePeer` under its own id: its private `jcode serve` and `jcode acp` pair (never standalone `jcode acp`, #559), socket, roster row, launch record and `--server-name agent-hub-<id>`. Its owned children run with `peerChildEnv(<id>)`, and `recoveryMetadata` names the id. `ahub jcode --as <id>` starts it headless; an instance has no TUI. Stopping it stops only its own group. An extra implementer needs the same managed worktree as every extra implementer (`resolveInstanceExecutionCwd`).
- Hub tool identity (#368). The project's `.jcode/mcp.json` entry is shared by every Jcode in the project, and jcode gives an entry's own env precedence over the process env (probed on 0.99.0). The entry therefore names no `AGENTHUB_PEER_ID`; every owned launch path supplies its own (serve and ACP through `peerChildEnv`, the TUI launch env) with an `AGENTHUB_LAUNCH_ID` that `JcodePeer` generates per launch. The tools-mode MCP server fails closed: without `AGENTHUB_PEER_ID` it never connects and refuses every tool with a reason, and never defaults to `jcode` or any other id. The daemon binds the `tools` hello of a peer whose definition runs the owned ACP engine to its current owned launch: the hello must carry that launch id (`JcodePeer.ownsLaunch`, a launch that is stopping admits none), so a process that forges `AGENTHUB_PEER_ID` has no admission. An entry written before this still names `jcode`: `jcodeMcpReady` is false for it once after the upgrade, with the existing remedy text, until `ahub jcode` rewrites it.
- Every instance stays a cloud peer (`trust.onPrem: false`): whatever provider it was configured with, its native policy stays unmanaged with no hub sandbox, and it never owns PII work. Status carries `modelSource` for an instance (the declared provider, model and profile names, or `native default`), shown in `ahub status` and the dashboard; `ahub doctor` lists the MCP servers each rostered instance's own home would load. None of them carries a URL, token, key or home path.
- Evidence: on jcode 0.99.0 an MCP entry naming neither id gives its child `AGENTHUB_PEER_ID` and `AGENTHUB_LAUNCH_ID` from the owned process env (probed under an isolated home with a probe entry, not the hub bundle).
- Evidence: the committed bundle ran as the MCP child of a real jcode 0.99.0 started by the daemon for an extra instance, with that instance's peer id and launch id in its env and one established connection to the hub (docs/smoke.md).
- Ceiling: a real Jcode sign-in, provider and model, and a model turn that calls a hub tool, are not verified by source or fixtures (`docs/smoke.md`, "Extra Jcode instances").

# ACP watch amendment, 2026-10-11 (#286)

- Headless Kimi/Qwen expose `watch` to console-role clients: bounded memory replay followed by activity pushes, no protocol bump, no peer input or approvals from the view. The CLI displays safe wrapped text; private/PII turns display a stub.
- Activity contains delivery ids/senders, message/thought chunks, bounded tool summaries, plans, permission request/outcome ids and turn end. It never enters persistent events/logs, UI, tools or cloud memory. Existing final answers still travel through the answer bus.
- Kimi TUI defaults remain pull-only. Qwen TUI and native visualizer support remain gated by unverified T0 checks. See [verification](../verification/2026-10-11-acp-watch-t0.md).

# Qwen dual-output TUI amendment, 2026-10-25 (#286 Part 3)

- T0 ran live on Qwen Code 0.26.1 under an isolated HOME ([verification](../verification/2026-10-25-qwen-dual-output-t0.md)): Q2, Q3, Q5 and Q6 pass, Q4 fails. The owner decided on 2026-10-25 to build Part 3 with the two limits below stated, so AC9's condition reads "Q2, Q3, Q5 and Q6 pass; Q4's limit is stated".
- Launch: `ahub qwen --mode tui` runs `qwen --input-file <in> --json-file <out> --mcp-config <hub server> --approval-mode default` in the person's terminal, as `ahub pi --mode tui` does. Both files live under the project state dir, mode 0600. The event file is a regular file the adapter tails from a saved offset.
- Version gate: a separate compat entry for the dual-output contract, verified 0.26.1 only. It does not widen the headless `qwen` entry, whose ACP receipts are separate.
- Delivery: `deliver()` sets busy synchronously and appends one `{"type":"submit","text"}` line with the digest. Qwen queues a submit that arrives during a turn and runs it after that turn ends.
- Turn end: Qwen emits no `result` event in this mode. A turn ends at an `assistant` event whose `stop_reason` is not `tool_use`, followed by `message_stop`; that assistant text is the turn's shared answer. A `result` event, if a later build emits one, also ends the turn.
- Approvals: `control_request` with `subtype: can_use_tool` goes to the hub approval path, and the answer is `{"type":"confirmation_response","request_id","allowed"}`. Allow or deny only. The hub's own tools are approved by the exact `tool_name` (`mcp__<server>__<tool>`), never by prefix. A `control_response` for a pending request that the hub did not answer means the person answered in the TUI: withdraw the hub's pending approval. A `control_response` error for a stale id is logged, never retried.
- Limit 1, deny: a hub deny cancels Qwen's whole turn and Qwen emits nothing for it. After sending `allowed: false` the adapter ends the turn itself (idle, no shared answer, a notice that the turn was denied).
- Limit 2, no external stop: the input protocol has only `submit` and `confirmation_response`, and SIGINT does not stop a turn. The inactivity watchdog never cancels a Qwen TUI turn. It reports the stalled turn to the person (status, console and dashboard: "stalled; press Esc in the Qwen terminal") and keeps the peer busy. The hub never types into the terminal or signals the process to stop a turn.
- Prompt channel: the input file is a prompt channel. Qwen's own write and shell tools reach it only through approval, and the hub's approval path refuses any write or command that names the state dir. No other peer can write it.
- Detached: the TUI keeps working when nobody reads the event file (T0 Q5). A daemon that cannot read the file treats the peer as detached, not idle; on reattach the adapter resumes from its saved offset.
- Recovery: `qwen -r <session_id>` with the same two files resumes the conversation, does not replay earlier submits, and appends to the event file. The adapter records `session_id` from `system/session_start` and resumes from its saved offset, so events from before the restart are not processed twice.
- Implementation notes (#449, measured on 0.26.1 where stated):
  - Files and state: `<state dir>/qwen/qwen-dual/{input.jsonl,events.jsonl,mcp.json,state.json}`; `state.json` holds `session_id`, the read offset, a generation counter and the bound owner (pid with its `processSignature`). `ahub qwen --mode tui` is explicit only: Qwen's `start.forms` stays `["headless"]`, so Qwen is not a start-mode peer and the hub never opens this terminal itself. The TUI driver is the definition's `start.createTui` on the `qwen-dual` daemon port, a fixed-builtin capability.
  - Gate: checked twice, by `qwen --version` against `COMPAT["qwen-dual"]` before any file is made, and by the TUI's own `session_start` (version, `protocol_version` 2, the events the adapter reads). An unverified TUI is not attached and the person gets a notice.
  - Event file: Qwen opens an existing `--json-file` at byte 0 without truncating it (it overwrote the head of a 3 KB file in place), so appending after a restart is not what it does. A fresh or resumed launch therefore starts from empty files (the old event file is kept as `events.prev.jsonl`, the saved offset restarts at 0 for the new file), and a hub restart while the person's Qwen keeps running adopts it and reads on from the saved offset with no launch. Qwen starts reading the input file at its size at start, so earlier submits are not replayed either way.
  - Owner: bound from the host's process table (the one process whose argv contains `--input-file <this adapter's file>`; two matches is no owner), at `session_start` and then every second. No launcher message is trusted for it. When the owner is gone the peer goes offline, an open hub turn settles `needs_review` and a notice says the terminal ended. The hub never signals it.
  - A prompt in the event stream that is not the hub's submit (matched by its text) is the person typing: the peer is busy, nothing is shared, and a `can_use_tool` request in that turn is the person's own (the console is not asked). A hub turn that a person's prompt cuts off (Esc, then a new prompt) settles `needs_review`.
  - `ahub stop qwen` refuses for the TUI (end it in its terminal); a headless Qwen cannot be started while the TUI runs, and the reverse. Crash and upgrade recovery refuse to restore this terminal as a headless worker (`recoveryRefusal`), as for Kimi's own TUI.
  - Not verified live: the T0 receipt covers Q2 to Q7 on 0.26.1; this PR's tests use a fake dual-output Qwen (`test/fakes/qwen-dual.ts`) and no live model, so end-to-end use with a real account remains the person's check (`docs/dogfood.md`).

# Historical workflow amendment, 2026-10-11 (#257, superseded by #481)

- The original optional workflow selector used existing SDLC receipts and Tasks authority; its current replacement is the #481 amendment below. A reviewer/person-owned checklist stores bounded criterion ids, hashed evidence refs and verified/failed/unverified claims bound to the reviewed head.
- Existing task/predecessor ids must match current Tasks.after edges; missing/cyclic/private cross-links are refused before effects. Imports do not change task ownership, reservations or dependencies.
- Required unknown/failed criteria and stale heads keep readiness false. Advise remains nonblocking; enforce adds these only to existing approval gates. Route explain, console/dashboard lifecycle views and read-only hashed exports derive the same board/config state. No second writable workflow store, automatic advance, permissions, merge/release or study execution.

# Role catalog amendment, 2026-10-11 (#295)

- Separate optional catalog guidance from unchanged flow roles/authority. Eleven shipped dev/research definitions and bounded project overrides carry flat headers, six fixed sections, content hashes and source notices.
- Session selections contain up to two ids and must match an existing flow base. Default absence preserves legacy contracts. Native preambles and Claude instructions publish guidance through existing paths; tools-mode instructions omit catalog text to avoid duplicate headless publication.
- Metadata-only prepared events and read-only list/show/doctor diagnostics do not attest native ingestion or execution. Project text is sanitized at rendering; invalid definitions disclose no contents. No new permission, routing, sandbox or tool authority follows from a catalog role.
- Task roles, person/settings assignment, pending/session attribution surfaces, later groups and measurement remain follow-up slices. See docs/roles.md for the current contract.

# Project profile amendment, 2026-10-11 (#259)

- Four shipped data profiles map optional named classes onto the unchanged seven base classes. Non-dev proposals persist profile/alias metadata beside the base; routing, reviewers, budgets and outcomes keep consuming the base. Default dev template/contracts/schema and legacy rows retain their prior shape.
- Profile-aware init preserves existing config and refuses conflicting explicit selections before writes. Peer contracts and task schemas derive from profile data; guidance grants no authority. Non-dev plans carry bounded paths/sections/sources/claims through Tasks and the existing privacy screen, with declared anchor/source overlap.
- Explicit machine-local alias check commands precede base check commands; profile selection installs no automatic command. Profile/base/alias metadata is shown in board/route/UI and #247 records without task text. Document projections, shadow repositories, path policy and custom data overrides remain subsequent slices. See docs/profiles.md.

- Accept schemas expose all supported plan fields because an open task keeps its stored profile across a project profile change. Tasks still normalizes by that stored profile; no new plan field changes authority.

# Data path policy amendment, 2026-10-11 (#259)

- Optional bounded project-relative pii.paths and data.readonly lists preserve defaults when absent. Declared private paths receive a hard local-only signal before triage/board/notice/memory; a new private plan cannot enter an ordinary task without re-proposal.
- Managed local/Pi write/edit check lexical/real paths before and after approval and refuse hardlinked targets under an active read-only policy. Managed command profiles/runner remove broad filesystem write grants, including owned temporary writes, when data.readonly is active. Reads/stdout and /dev/null remain available; unprotected outputs use managed write/edit. The stricter command boundary closes the reproduced hardlink-alias bypass of path-only denies.
- These controls do not contain the owner or other native same-user processes. Config policies apply at daemon start; no permission mode overrides managed data policy. Native-account/research legs remain unverified. See docs/data-policy.md.

- Parent directory task scopes containing a configured private path are private too. Automatic facts omit configured private files before reading/showing them, including outside an open private task.

# Text projection amendment, 2026-10-11 (#259)

- Optional machine-local extension/argv mappings use immutable bounded input snapshots, no-network/read-only converters, process-group deadlines and bounded output. Shared/tracked config cannot choose execution. Default absence preserves raw facts.
- State cache keys bind raw content and argv/program/script metadata. Conversion failure/absence falls back once per extension without leaking stderr. Private paths are excluded before conversion.
- Facts retains raw hashes/blob identities and renders projected text as presentation only; projected reads/patches never establish raw-file attribution. Review/undo and shadow-repository surfaces remain follow-ups. See docs/text-projection.md.

# Task catalog role amendment, 2026-10-12 (#295)

- An optional proposal role names a validated catalog id compatible with the stored base class. Tasks validates before the board write; the board persists only the id. Role guidance never affects routing, authority, checks or policy.
- Owner assignments and reassignments carry sanitized bounded role guidance; a native session whose role contract was prepared by this daemon gets the id without a repeated body. Review requests always carry the role id and its Review duties only. Unknown prior definitions yield an id-only notice.
- Public PII stubs may expose the role id, never task text. Role/task events and research records carry id/layer/hash only. Default absent roles preserve old notices and row shapes.
- This slice does not add person role mutation commands/settings or infer that an externally started Claude/plugin session consumed its roles. Those assignment surfaces and native ingestion/measurement remain follow-ups.

- Complete task role guidance, header included, is capped at 2000 characters. An oversized definition is refused before proposal storage; a saved task whose definition later exceeds the cap keeps an id-only notice. Definitions are never truncated.

# Person role control amendment, 2026-10-12 (#295)

- Catalog-role settings are person-only registry entries, stored only in config.local.json and applied at the next peer start. At most two compatible ids per supported peer; explicit empty disables and inherit restores shared/profile defaults. Flow authority, routing and permission policies remain independent.
- Existing task roles change only through Tasks for a console person, before approval. The saved change keeps ownership/class and sends bounded sanitized guidance to current holders. It never rewrites the original proposal identity in research evidence.
- Status/UI role preparation and pending fields are advisory transport/configuration metadata, not proof of model consumption. External plugin/TUI sessions without a receipt remain unconfirmed. Session research attribution and #263 board-card work remain follow-ups.

# Session role research amendment, 2026-10-12 (#295)

- Turn start freezes the native preamble role identities; attributed completion events carry that snapshot to the shared live/backfill research builder. Records contain peer/turn/id/layer/hash only, never role or task text. Pending configuration edits cannot rewrite an open turn.
- Empty preparation is distinct from an unknown external session or an older event without metadata. The additional fields preserve the existing event/research schemas and CSV summary. Preparation is not evidence of native model consumption; #263 cards and role effectiveness measurement remain pending.

# Rich-document review and undo amendment, 2026-10-12 (#259)

- Machine-local bounded converters may project regular historical git blobs for review notices and reverse undo previews. Raw snapshots remain the attribution and restore identities; converted text is presentation only.
- A task's exact proposal baseline is persisted by id/proposal time outside task history. Replacements and restart reuse it, never a guessed current or later baseline. Private windows do not capture it; missing/pruned/disabled evidence is explicitly unavailable.
- Review remains within declared task refs/plan/section files. Denylisted and declared private paths are not converted, private-data patterns are withheld and inserted headers are sanitized. No projected document body is added to task history or memory.
- Previews share an 8-second monotonic deadline, at most 8 files and 12000 UTF-8 presentation bytes. Individual converters remain limited to 5 seconds, no network or writes, with owned-group cleanup on timeout or termination. Format participates in the content/command cache key; changing converter identity invalidates a pair.
- Raw undo planning, overlap/later-edit refusal and the final pre-restore readback stay authoritative. Linux conversion and native/account/measurement legs remain unavailable or unverified as documented; shadow repositories and override/glob work follow separately.

# Non-git shadow repository amendment, 2026-10-12 (#259)

- Explicit init `--shadow` creates a validated bare `.agenthub/shadow.git` with the project as its explicit work tree; previews contain action metadata only. Real Git projects retain their selection and are refused for shadow creation. No `.git` entry is added.
- Repo-aware hardened git calls supply snapshot/facts/projected-diff/undo operations. Shadow calls ignore global/system git config and honor the owner-managed `.agenthub/ignore`. Own shadow/runtime/local metadata never enters snapshots or facts, and remains unwritable to managed workers.
- Snapshots and restore leave HEAD/index unchanged. Metadata links at any depth, shared alternate object stores and invalid directories are refused. Each shadow Git call revalidates the metadata walk (20000 entries and 32 levels maximum), even for a previously discovered handle. Missing evidence and later/concurrent raw edits retain existing conservative refusals.
- Non-dev profiles without a repository disable these features with one notice. Dev named-file facts retain the existing #108 behavior and tests; Git directory facts and snapshots/undo remain unavailable without a repository. This reconciles the profile proposal with its explicit unchanged-dev contract.
- Native research/account/measurement and custom profile/glob work remain follow-ups, not claims of this source delivery.

# Per-project profile data amendment, 2026-10-12 (#259)

- Pure `profile_overrides` resolution supplies per-project class maps, supported plan-key selection, flow-role guidance, catalog defaults, managed AGENTS content, advisory example checks and review checklist lines (#507). Shipped defaults are not mutated. Map fields merge across shared/local layers; lists/text replace.
- Base flow meanings, routing, budgets and permission checks stay unchanged; aliases persist beside their bases even for custom dev data. Ordinary tasks under custom dev data also retain profile semantics for document overlap; unmodified dev data keeps the legacy row shape. Unknown fields/base meanings, duplicate/unknown plan fields and oversized guidance fail before task effects.
- Schemas, CLI classification, Tasks, daemon/native contracts, plugin instructions, both local-worker tool-building paths, check-name allowlists and init use the same resolved data. No-override dev contracts/schemas/instructions remain byte-identical. Old accept schemas support existing task fields.
- Flow authority remains the separately validated `roles` map; executable checks remain trusted `checks`. Example checks are display data and do not execute. Managed instruction content keeps surrounding text and quotes forged headers.
- Acceptance criteria with ids (#507b) reuse the #481 S8 `criteria` checklist, the only criteria model: `sendReview` lists the recorded criteria (`- <id>: <result>`, `(optional)` for a non-required one) ahead of the profile's checklist lines in every profile, and `Tasks.review` records on the verdict the ids that the reviewer's `unmet` items name, through the pure `unmetCriteriaIds` (an item names a criterion only by starting with its exact recorded id, followed by the end of the item or a delimiter; each id once, in first-named order). The ids come from the board's checklist at the verdict, never from the caller, and are stored as `HistoryEntry.unmetCriteria` (validated: at most 32 distinct bounded ids, on a saved review verdict only) and shown in the public history. The note text is unchanged. A PII task lists and records none; a task with no checklist, a verdict with no unmet items and an item with no matching id add nothing, so every existing request and verdict is byte-identical. #513 packing and #514 learning refer to these ids.
- Recurring unmet criteria (#514a, `src/hub/learning.ts`, `Tasks.proposeCriterionCandidates`) reuse the #481 S3 recurrence path: after a saved verdict that named criteria, the pure `groupUnmetCriteria` groups the ids reviews recorded as `unmetCriteria` in the last 30 days by profile, profile class (the alias when the task has one) and criterion, over rows that are not PII and whose text the candidate screen allows. A group that this verdict named, that has at least 3 tasks forming at least 2 separate pieces of work (`workUnits`) and no card yet (`Criterion candidate key: <profile>:<class>:<id>` in a hub-filed backlog card's detail, the same dedupe as `Review finding key:`) files ONE backlog `plan` card for a person: ids and counts only, plus the `profile_overrides.review_checklist` fragment as text (`overridesDiff`). Nothing is applied: `profile_overrides` is not machine-local (it is read from the tracked `.agenthub/config.json` and the untracked `config.local.json`, layers merged, and is in neither `MACHINE_LOCAL` list), so the person chooses the layer and merges the line into their own checklist, which replaces as a unit. `selectGroups` applies those filters before the per-pass cap of 64 cards, so groups that are settled (already carded, unnamed, under threshold) never use up the cap and starve a new one. A withheld verdict, an evidence-only verdict (#852), a private turn and a PII task file nothing and count for nothing. Per-profile `profile_overrides` application, thresholds as config and decay are not part of this step.
- `ahub learn list|accept|reject` (#514b, `Tasks.learnCandidates|learnAcceptPlan|learnClose`, the `learn_*` task ops) is the person's verdict on those cards, and it amends the #514a card text: "nothing in the hub writes it" became "the hub writes it only when the person runs `ahub learn accept`" (cards filed earlier keep their old sentence, which is harmless: the command reads only the key line). Person only end to end: `classifyPeerCommand` gives `learn` no entry (so `console`, no `CONDUCTOR_*` entry), the daemon's generic console-op gate refuses every non-person caller including the configured conductor, and each `Tasks.learn*` method refuses any `by` but the person. `parseCandidateCard` reads ONLY the first line of the detail (`Criterion candidate key: <profile>:<class>:<criterion>`) from a `plan` card whose first history entry is the hub, re-checks the three parts against the shapes the loaders accept and the title against the key; the task count and the line are recomputed from the board (`learnEvidence`, `overridesDiff`), so no text of the card is parsed as a value or written. Accept refuses a card for another profile than the project's, a config that does not load, a list that would pass the loader's 16 lines, and a card with no evidence left; it extends the checklist the profile uses now (the person's, else the shipped one) because `review_checklist` replaces as a unit, skips a line already present, and writes through `settingsSet` with the one managed definition `LEARN_CHECKLIST` (`src/hub/settings.ts`): a function argument that no request field can supply, resolved by no ordinary lookup (`settingDef` does not know it; `undoableDef` does, for undo only), so `settings set`, a dashboard session and a conductor see an unknown setting. The write is to `config.local.json` only, through the same loader check, tracked-file refusal, atomic replace and single undo record as every setting, `restart` class. The card closes through `Tasks.cancel` after the write succeeded (a failed write leaves it open), the verdict in its history and its dedupe key kept, so the criterion is never filed again. The settings event, notice and undo reply for this key carry the line count, never the person's lines.
- Override maps are bounded to 32 class entries and existing base classes; plan selections use existing fields. Role text is 2000 characters, agents 16000, examples 16 strings of 2000 characters, review checklist 16 lines of 500 characters (#507). Native ingestion/retention/measurement remains unverified; configuration changes apply after daemon/MCP restart.


## Amendment: bounded data policy globs (#259)

pii.paths and data.readonly accept exact paths/subtrees and *, ? and whole-segment ** patterns. Validation keeps 64 entries, 200 characters each and at most 16 wildcard characters. Unsupported bracket/brace/negation/escape syntax, absolute paths and parent traversal refuse. Matching folds case, protects matched subtrees and treats parent task scopes as private when a future matching descendant is possible. Resolve both declared and real paths; wildcard alias discovery is uncached and bounded to 4096 directory entries per decision and 32 levels. Wildcard resolution/discovery failure conservatively matches an active policy. Exact entries and trailing-** roots also protect the targets of symlinks directly inside the matched directory, one level only (#385): a dangling child protects its lexical target, an ELOOP child is skipped, a root whose scan does not complete within the shared budget contributes no child aliases, and an unreadable root matches; * keeps its matched-link resolution. Managed local/Pi tools retain hardlink and read-only command protections. Only an authenticated pre-tool ask-when-needed write grant evaluates the daemon-side read-only matcher; other phases/modes perform no grant-policy discovery. Protected grants are withheld without exposing policy paths; explicit approval/never-ask remain native authority, with no new sandbox claim. No account/research pilot is implied.

## Amendment: custom lifecycle data (#257)

Optional ordered stage definitions map at most 32 bounded ids to the semantic bases, existing actor guidance and closed entry/exit gates (updated to nine bases and the criteria gate by #481 below). Explicit after edges name at most eight earlier configured ids; missing/self/forward/cyclic references refuse. Review and merge base destinations are required by existing Tasks completion transitions. Built-in names cannot change base. Existing holder/person authority and the full approval floor remain; enforce additionally checks an explicit custom stage-change actor without granting a new caller authority. Off/advise preserve claim behavior. Config-aware receipts, projections and every managed native/local task schema use the same stage ids. Historical removed definitions remain unknown, not silently remapped. No new state, executable gate, auto-advance, merge, release, import authority or native success is introduced.


### Custom lifecycle review corrections (#257)

The original phase gate validation is superseded by the criteria gate and compatibility window in #481 below. Authenticated daemon status gains optional lifecycleStages metadata, with no protocol bump. Separate MCP tools lists use that active snapshot; a live legacy daemon without the field keeps seven stages, while unknown/unavailable metadata withholds the lifecycle-record tool. Editing project data during a live daemon no longer changes its advertised stage ids.


## Backlog foundation (#263)

`backlog` is a durable task state for known, unoffered work. Its only flow edge is
`backlog -> proposed`; `proposed -> backlog` requires no current owner. Backlog
rows have no owner or reviewer. Existing rows and proposal history are unchanged.

`hub_task_propose(backlog: true)` still validates class, plan, role, dependencies,
roster reservation and PII before persistence. A named owner is a reservation,
never a claim. No routing, offer, overlap announcement, sweep or conductor feed
occurs. The person alone uses `Tasks.moveBacklog` through console task operations
and `ahub backlog pull|return`; peers cannot invoke these transitions. Pull uses
existing dependency and assignment delivery rules, recording a durable ready or
blocked marker for restart recovery. Return clears transient ready-offer state.

Public progress counts Backlog separately at stage zero only when present.
Ordinary agent list/show/explain and conductor task tools exclude staged work;
future explicit planner tools provide its agent read path. This foundation does
not implement ranks, undoable planner grooming, release states, planned dates or
dashboard drag/columns. Those remain required by #263. The live planner grooming
cycle into two releases remains unverified.


### Backlog execution boundary (#263)

First `backlog pulled` is equivalent to the first offered proposal for snapshot
initialization, projected-review baseline lookup, role provenance and research
creation identity. Backlog itself has no execution baseline. Repeat unstarted
staging preserves that first identity; reset-generation `backlogged` events
separate old research records, and an unpulled current generation takes no label.

Structured accepted/done/check/review/integration history is execution evidence.
Tasks refuses an ownerless proposed row's return when that evidence exists; the
Board shares the same floor before its write. Free-text history is never read
to infer execution. Native projected-converter validation remains separate from
the portable stored-tree regression.


## Project board presentation (#263)

Five fixed state-derived columns share a structural public model with tests;
unknown states stay explicit. To Do waits derive from authoritative dependency
states and peer availability/holds. Priority P0/P1 has a star plus a text label;
legacy urgent maps to P0 and ordinary work to P2 until planning data exists.

One identity palette supplies terminal board/status tones and dashboard CSS.
Owner markers are filled, reviewer markers outlined, with text names. Legend
state, WIP and active task ids derive from the same snapshot and permission
display used by status. Filter/lane actions are read-only. Recent Done records
precede collapsible older work. Responsive columns stack at phone width.

Only assignment and eligible Backlog/To Do staging have drag controls, each with
labelled buttons/selects. Origin/project/instance/generation fences prevent
stale gestures, including standalone dashboards on different loopback ports.
Server authority and all task writes remain in existing console/session gates
and Tasks. A capability bit prevents an older hub silently ignoring Backlog
intent. CSP hashes include the injected model/palette, with no outside assets.

Planner grooming, releases, editable planning data, dates and one-way import
remain required source slices. Browser visual and the native planner/two-release
cycle remain unverified until their independent checks run.


## Planning and release persistence (#263, in progress)

Tasks owns planning and release mutations. Optional rank, P0-P3 priority, release
id, UTC planned start/due and pin metadata migrate without inventing a legacy
plan. Planning revisions fence stale edits; history records screened reasons,
changed fields and previous values. The configured planner role changes only
unpinned backlog work outside frozen releases and preserves a person's rank.
Undo refuses an intervening change or another planner's edit.

Planner backlog notices carry at most 64 ids per recipient. Recovery coalesces
ids already present in that recipient's restored queue or unresolved journal
originals. Configured planners retain staged ids while off roster; roster and
attachment gate publication only. An overflow retains
only that recipient's pending ids and waits for its queue to change before
retrying, using the existing scheduler without another timer.

Releases persist planning, active, frozen, shipped and dropped states and planned
start/cut/ship. Only a person freezes, drops, ships or changes a frozen release.
Shipping requires every scoped task approved or moved out, records its first
ship time and runs no external release process. Public name/goal must pass the
existing PII boundary. Actual task dates derive structured execution, review and
approval history, including reviewerless completion; no input supplies actual
start/review/done. Old absent evidence remains unknown.

CLI/dashboard/tools, batched planner notices, dependency edits/splitting, WIP
pull, bounded undo surfaces, research metadata and optional GitHub import remain
in progress. Source/fixture/platform/seed/visual/native proof is not yet complete.


## Planner dependency and reservation grooming (#263, in progress)

Planning may replace at most 64 unique existing positive dependency ids and a
rostered peer reservation (or clear it). Tasks checks transitive cycles, current
unstarted backlog state, ownership and existing revision/pin/frozen/person-order
floors before screening the reason and again afterwards. Board saves metadata,
dependencies, reservation, revision and prior values in one compare-and-swap.
Undo restores the same fields only when the latest eligible edit still applies.
Public planning history excludes previous values. Suggested owners remain
reservations; editing never offers or starts work. Native grooming remains
unverified; split, WIP pull, batched notices and import are still required.


Incoming backlog ids accumulate through Tasks and are flushed on the existing
one-second daemon tick as one task-kind notice to attached rostered configured
planners, at most 64 ids per notice. No task prose enters the notice. Pulled or
removed ids are omitted, no planner means pending work is retained, and a new
hub run regroups its currently staged backlog. This is advisory grooming; no
ownership or execution state changes. Planned reservation edits participate in
the conductor's latest ownership-decision check, preserving a person's decision
when the hub later carries it out. Full proof remains pending.


## Planner pull admission and undo (#263, in progress)

Planner pull reserves a bounded per-peer WIP slot and moves ready backlog work
into To Do through Tasks. A proposed planner-pull reservation counts as WIP
before assignment; its own slot is excluded while the normal routing path offers
it to that reserved peer. Capacity and recovery/review holds are checked again
at offer time. Default capacity is one per peer; machine-local integer limits
0..32 use the existing settings registry and loader.

Pull requires current revision and a screened reason, unstarted/unowned/unpinned
backlog, approved dependencies and unfrozen scope. Person P0 order and explicit
reservations remain protected. Board saves the pull provenance and previous
reservation in one CAS. The latest eligible pull can return to backlog only
while unowned and unstarted, restoring its previous reservation; it never claims
to cancel a dispatched native turn. Native/visual proof remains unverified.


## Backlog split contract (#263, in progress)

The manager split deadline includes the shared 8-second screening bound, the
hub SQLite busy wait and a five-second margin. A missing answer is unconfirmed
and requires task readback before retry. Stored parent role IDs remain guidance
metadata when the current catalog entry is unavailable; they confer no authority.

Task-scoped memory note/link attempts record one body-free board-history marker
before external persistence. Split undo preserves that fence even when memory
is disabled or unavailable; failed attempts conservatively retain the child.

Splitting keeps the original card as integration/acceptance responsibility and
adds two to eight unoffered child cards as prerequisites. Existing prerequisites
and conservative privacy/phase planning are retained. Per-part dependencies may
name existing tasks or earlier parts; no child may transitively depend on its
parent. Tasks screens and revalidates the entire bounded request before writing.
Board commits all children, parent edges and undo provenance in one transaction;
change callbacks run only after commit.

Latest eligible owned split undo restores original edges and deletes only unused
unchanged unstarted backlog children, refusing later edits, owners, execution or
external references. Role, revision, pin/person and frozen scope floors remain.
Public projections expose child ids without private prior values. Source/native
verification remains pending; no live operation or release process is implied.

## One-way GitHub backlog intake (#263, in progress)

A person may import open issues selected by a required label and optional
milestone/repository, using fixed read-only gh argv. The existing reader bounds
stdout and execution; intake uses a 2 MiB output ceiling for the 33-row sentinel
page, including worst-case escaped title/body JSON. Other SDLC reads retain
their 256 KiB default. One page stages at most 32 issues and reports truncation.
Comma-containing and double-quote-containing labels are refused because gh --label uses CSV-style parsing;
selection must never silently broaden. The entire returned page must validate before any staging. Repository/issue
identity is stored persistently and deduplicated across restart and concurrent
screening. Tasks screens imported content and stages unoffered backlog; links
are shown only through the central public projection, with no source identity
exposed for PII cards. No GitHub comment, label, assignment or close is written.
Current source/native proof remains pending.


## Remaining board projections (#263, in progress)

Terminal `board --columns` uses the same state/ready/waiting model as the
dashboard, retaining public rows and unknown states. `board --release <name> | --release-id <id>`
filters read-only through the existing task-list authority; it never exposes
backlog to an unprivileged peer. Frozen/phase views flag ids of approved tasks
outside the release whose structured approval time is after its planned cut.
Missing cut or approval evidence stays unknown, not inferred from notes.
Source/native/phone proof remains pending.
## Console attention foundation (#280, in progress)

The self-contained needs(input,now) model receives structural console-owned
approval/default/delivery/storage/message/budget/recovery facts. It copies only
bounded ids, peers and known timestamps into sorted act/watch items. Approval
expiry is checked against now; watch items never override state.
Delivery action counts require positive `needsReview` evidence. A `heldBy` id
alone also names dispatching/accepted holds, which cannot be resolved by the
person, and does not create an action item. No title,
message/error/option text, path, network call or timer enters the model. Phase1
console line/keys/configuration now uses a read-only console-local config reader,
the existing redraw/poll requests and body-free unread metadata. The line is
ASCII only, with STAI/off session choices; alternate artwork remains gated.
Review/offline/act-level recovery and
artwork variants remain later explicit phases. Native/visual proof is unknown.

## Global attention status and CLI (#280, phase 3 in progress)

Global needs summaries contain only act/watch counts, the known state and the
first structural item. Console-local unread messages are excluded at the
allowlisted summary boundary. Person review is one act item per in_review task
whose reviewer is user; offline ownership is one watch item per offline peer
with proposed/in_progress/changes_requested work, using its lowest task id.
Only an observed absent runner makes an open recovery operation an act item;
an unreadable/unknown runner remains watch. This phase is independent of the
owner-held larger artwork/variant selection. Daemon/status.json, existing
console input and CLI pet/status wiring and full verification remain pending.
No protocol/event schema, authority, mutation, timer or account scope is added.

The authenticated console-role reply to the existing status request also carries
attentionItems, the complete structural global item list, so stream-mode next
navigation can reach review/offline ids without a new task-list request. This
optional read-only projection contains only the NeedItem allowlist; it is not
written to status.json, returned to peer/tools status callers, or sent to memory.
The persisted needs field remains counts/state/first, excluding console messages.

Status task facts are selected once from the board as id/state/owner/reviewer
columns, excluding approved rows, and reused for retained off-roster peer ids and
attention. No task JSON payload is decoded for this projection. Reserved
pseudo-peers user and hub never produce offline-agent attention; a task reviewed
by user still produces its normal review action.

## Approved terminal characters and sizes (#280, phase 2)

The owner approved the STAIx reductions and public distribution on 2026-10-13,
and selected gyul, lantern, cursor-cat and boxbot. All five built-in characters
have complete line/mini/full ASCII and block data; no image is loaded at build
or run time. The ASCII STAI line remains byte-compatible. Actual consoles
advertise the five choices and P cycles through them and off; older embedding
states without advertised choices retain the former STAI/off toggle.

Mini fits at100 columns, full at100 columns/40 rows, otherwise the next smaller
size is used. Full reserves the catalog maximum of eight sprite rows plus the
unchanged full-width prompt, independent of state and session character. Mini
shares the existing four footer rows. Stream scroll bounds and panels body
height use the same footer geometry. Notice/source prose is excluded beside
expanded frames. Only a live approval deadline permits the waiting blink;
C/dumb/linux/unknown locale surfaces use ASCII even when blocks were requested.
Body foreground is uncoloured; only the Gyul leaf uses an existing accent tone.
Native terminal/font/tmux proof remains a separate verification leg.

## Shared dashboard attention (#280, replaced by #391 Task A)

The authenticated snapshot retains optional body-free needs input. The same
injected pure needs function drives global nav action/watch counts and the
existing tab-title action count; status/file readers retain their summary/items
projection. The Agents button separately shows live pending approvals. The
in-page character, SVG, character frames and pixel injection are removed; the
standalone #391 Task B window owns that presentation.

Attention activation switches views and selects only the exact visible
approval/task id. Default/delivery/budget items without a visible exact target
show their related heading and fixed id-only guidance, never a peer or first-row
fallback. Filters and workflow state are unchanged. Signature guards suppress
unchanged DOM writes, invalid legacy input stays unavailable, and project
changes reset attention and close stale dialogs. CSP/header policy remains.

## Amendment: hub memory, tiers and graph (#258, phase 1)

Decision 10 is amended: the hub owns a store of its own in `~/.agenthub/memory/`, machine-wide, and claude-mem stays
where it is installed as the capture and session-recall source (notes still go to both). Append-only JSONL segments are
the truth (`log/<machine>.jsonl` long-term, `local/<machine>.jsonl` short-term and never synced); `index.db` is derived,
content-addressed rows inserted idempotently, so an incremental index equals a rebuild in any order. Notes on an open
task are short-term; approval copies decision, contract and fail notes to long-term and starts the short-term clock
(`memory.short_ttl_days`, 14); `hub_remember` takes `horizon` and `scope`. Deterministic edges (refs, plan paths and
symbols, existing paths in the text, `#N`, `task #N`) are fixed at write time. Task briefs, session-start recall and
`ahub ask` read the graph first; superseded entries are dropped and a linked fail leads. PII task text never enters the
store, and secret-looking text is refused. `ahub memory` reads and, for a person, promotes, demotes, forgets, supersedes
and rebuilds; the dashboard's Memory section is read-only inside the existing CSP. On with any project config
(`memory.native`). Proposed defaults 1 to 5 of #258 are taken as confirmed by the request to implement it. Machine sync,
long-term tasks with leases (decision 9's amendment), claude-mem import and model-suggested edges follow in later phases.


## Dashboard attention projection (#280, superseded by #391)

#391 Task A replaces the in-page pixel widget with nav/title counts as defined
in Shared dashboard attention above. Native character presentation is the
standalone Task B window; browser attention uses no character data or frames.

## Amendment: hub memory between machines and long-term tasks (#258, phase 2)

Decision 9 is amended for memory only: the memory directory is a git repository that tracks `log/*.jsonl` and syncs
through a private remote a person sets (`ahub memory sync --remote`); each machine commits only its own segment and
merges others' unrelated histories, so a merge never conflicts. A GitHub remote that `gh` reports public is refused;
an unknown one warns. Sync is fail-open (one log line), runs at hub start and every `memory.sync_interval_min`, one at a
time per machine. Git calls keep the hub's safe configuration except the person's credential helper, for this
repository only. Long-term tasks (`goal`, `goal_state`, `goal_link`, `lease`, `lease_force` entries) carry state,
milestones, dependencies and linked board tasks (project, id and proposal time). A hub working on a linked board task
holds the lease (4 h, renewed past half) unless another machine holds it; a person's `ahub goal take --force` voids
earlier claims. The lease is advisory: claims inside one sync window both stand and show as a conflict, the earlier
holding (`ponytail:` no consensus; a broker if concurrent cross-machine work needs one). A peer links its own board task
through `hub_task_propose(goal)` to this project's long-term tasks only; a person links across projects. Status, the
console at hub start, recall and the dashboard's Long-term tasks tab show state and lease.


Queued planner batches retain bounded ids-only backlog references and recheck
the board at actual delivery. A batch containing pulled/removed work is discarded
before reaching the planner; its remaining backlog ids join the next batch. This
floor also applies during the legacy stale-notice delivery experiment. No task
text is copied and no routing/ownership state changes.
## Amendment: claude-mem import, suggested edges and the memory measurement (#258, phase 3)

`ahub memory import claude-mem` (a person's) copies claude-mem observations whose metadata names a `peer` into
long-term hub memory as `source: claude-mem`, opening claude-mem's database read-only and skipping model answers,
PII-pattern and secret-looking text; ids are deterministic, so a re-import adds nothing. `memory.suggest_edges` (off by
default) lets the hub's model suggest `contradicts` / `same_topic` between a new entry and up to six near ones, checked
against that closed list and stored as `hub-model` suggestions; they are drawn dashed and excluded from briefs, recall
and `ahub ask` until a person confirms them. Measurement: `memory_brief` events (counts), research records' `briefs`
and the report's by-memory-brief split, and `ahub bench run --memory off|claude-mem|native|both` arms checked against
the project's settings. Whether hub memory helps stays a research result, not an acceptance claim.


Planner notice retries are per recipient. A stale copy requeues current backlog
ids only for the planner whose copy was discarded; a planner that already read
its original copy is not sent the retry. Queue overflow returns that recipient's
ids to pending state on the existing bus event, including immediate eviction
during publication. Pending ids are removed before publication so overflow can
restore them; no extra timer, route, ownership change or task text is introduced.

## Automatic control port exclusion (#375)

When controlPort is zero, the daemon excludes requested positive Codex app and
proxy ports from its automatic listener selection. A rejected owned listener
stays bound until a distinct replacement is selected; only these temporary
listeners are closed, including on binding failure. Selection is bounded by
the number of excluded ports plus one. Explicit control-port behavior and
existing Origin/token/native ownership refusals remain unchanged.

Split child external-use checks include persisted SDLC phase checklist task ids and predecessor ids, as well as Tasks dependency edges. An undo preserves referenced children and the original board when it refuses.

Declining rework in changes_requested returns it to proposed before rerouting, just as declining in_progress work does. The Board permits that transition; the Tasks owner/person authority remains required. Planner-pulled work without destination WIP is retried from To Do once capacity becomes available.

Split undo preserves children referenced by persisted task-scoped execution budgets. The person may disable the budget through the existing budget action before undoing otherwise-unused children; a run-scoped budget alone is not a child reference.

Split screening retains the initial deterministic child and inherited parent privacy signals across asynchronous screening and final policy revalidation. Removing a routing pattern while a screen is pending cannot publish an unscreened private child or invent a new screening verdict.

Final deterministic split signals also determine classification provenance. A pattern added during a pending model screen records regex-private history/telemetry instead of retaining an obsolete clear model verdict; inherited parent privacy remains distinct.

The outer dashboard HTTP request for backlog_split receives a per-request idle bound above the manager forwarding deadline, derived from the shared screen and hub database bounds plus margin. Other actions retain their existing HTTP policy. The boundary regression observes actual native timeout allocation; Bun 1.4.2 pending-handler idle expiry is not assumed.

Split reasons retain deterministic privacy from both initial validation and final revalidation, including inherited parent privacy. Later routing policy removal cannot expose an already-withheld reason in public history.

Ask evidence ignores body-free memory-reference bookkeeping when selecting the latest task event and note. The selected meaningful note retains its PII and withheld provenance under the existing on-campus boundary.

GitHub intake rechecks its total staging deadline after every awaited proposal, including the final issue. A late confirmed write returns its ID with partial=true and complete=false; it is not represented as an unconfirmed write or rolled back.

After a confirmed GitHub task insertion, failure in later bookkeeping triggers canonical source-identity readback. A recovered row is returned among imported IDs with partial=true/complete=false; unavailable readback remains unconfirmed. A recovered backlog row is queued for the planner notice even when earlier bookkeeping prevented the normal enqueue.

The per-issue intake failure boundary includes existing-row lookup and profile preparation as well as proposal staging, so a later lookup failure retains prior confirmed IDs in the partial response.

Release snapshots group scope rows once and read approval dates once per task. Cross-release audit previews contain at most 32 IDs per category plus exact counts, with truncation disclosed in the UI. Sorted date indexes preserve strict after-cut semantics without rescanning every task history for every release. Full audit pagination remains a future extension.

Release-card invalidation includes the task-state snapshot, so approval of a prerequisite outside the release refreshes blocked counts even when the release row and audit preview are unchanged.


## v0.12.24 audit corrections (#378)

Planner grooming cannot clear, replace or reassert a person-owned reservation;
only a person may change that decision. Pull and grooming share the same
reservation provenance, including a return to Backlog after a planner pull.

A personal Pi roster return rejects its snapshot if authenticated, current
native lifecycle activity was observed while the snapshot was in flight. The
session remains detached, and a fresh snapshot retry is required before hub
admission. The owner process and queued deliveries are retained.

Goal and suggestion reads retry deferred segment indexing just as note reads
do. This adds no log format change and does not invoke unrelated note promotion
for an already fresh goal or suggestion read.

The board's existing polling notices deadline crossings through derived overdue
state in its render cache. Unchanged overdue state preserves the current DOM.

The current Pi extension negotiates fenced prompt admission at verified session
startup. It checks native idle state immediately before synchronous prompt
insertion, refuses insertion while its settlement callback is active, and tags
hub prompt lifecycle events with the command id. A delayed personal lifecycle
must not consume a hub audience or receipt. Only a verified command/session-bound
pre-effect refusal permits safe requeue; uncertain delivery stays held. Roster
rejoin without this extension capability is refused, requiring a current native
session instead of assuming that an older extension provides the fence.

Prompt lineage lasts until logical `agent_settled`: native retry, compaction or
continuation starts inside that run retain the same command id. A later personal
run has no hub command lineage.

## Amendment: standalone attention window (#391 Task B, supersedes #280 dashboard pet)

The #280 phase-4 dashboard pet is replaced by an optional standalone macOS JXA
window. Task B adds the window first; #391 Task A removes the existing in-page
character and retains shared attention counts/navigation. Terminal characters
and read-only `ahub pet` behavior remain.

`ahub pet --window` / `--window --close` are console-identity commands;
`pet.window:true` opts into startup from `ahub up`. Non-macOS reports unsupported.
One detached Bun host per project holds a signed pidfile in stateDir, reads
`readPet` and `loadPetConfig` every second and atomically writes state, act/watch,
character, blink and the full built-in `petPixels(CHARACTERS[...])` frame. No
item ids/text/titles or external image assets are included. Unavailable status
writes exactly `{offline:true}`; JXA displays Offline for two seconds, exits,
and the host follows. A closed/crashed JXA also ends the host. A stale owner
requires explicit close; an unconfirmed owner is retained.

`osascript -l JavaScript` creates an accessory, borderless nonactivating
NSPanel subclass that can become key, uses NSFloatingWindowLevel and
canJoinAllSpaces | stationary, and embeds a transparent local WKWebView. Its
one-second NSTimer loads the atomic view and calls `update(json)` with an
explicit no-op completion function (a JS null completion block crashes on the
verified macOS). The fixed bridge moves/saves position, makes the pencil's
inline text box key, sends a console message through NSTask argv to `ahub say`,
opens the dashboard through `ahub ui`, or closes. Enter sends; Esc cancels.
No shell evaluation, new dependency, compile step, HTTP listener or network
request is added. Message contents are not logged by this surface.
Working animates only the pixel SVG through a 0.7-second stepped CSS bob, disabled by prefers-reduced-motion; no frame, timer or view-file change is added.

The repaired Mac spike verified a transparent floating key panel and both
bridge directions. Real input/drag/Spaces and end-to-end stream delivery remain
manual acceptance evidence on the implementation PR, not inferred from the
spike's process metrics or automated fixtures.

## Amendment: dashboard views and task detail (#391 Task A)

The existing page has one nav button per view, with `aria-current`; sections
carry `data-view` and selection toggles only `hidden`. A shared cookie helper
stores theme, Office mode, selected view and optional board column focus.
The one-time ticket keeps exclusive use of the URL fragment. Projects and
Benchmarks join peers, approvals and budgets under Agents.

Compact task cards retain drag/drop, id/title, priority, owner dot and
check/overdue markers. Click/Enter opens a native `dialog` via `showModal()`.
`taskDetail` supplies full current public content and existing controls to that
dialog and to a focused column's one-wide-list cards. Each snapshot updates the
open detail; disappearance/project reset closes it. Back restores compact mode,
and state/peer/release filters remain active in focus. Attention targets exact
visible row ids with heading guidance when absent. No new route, API request,
timer, source text/ref/history projection or external asset is introduced.


## Explicit offline Pi history selection (#403)

A person may run `ahub pi --replace-session --session-file <managed-file>` only
for an existing offline, settled Pi owner with a proven-gone native process.
Pending tools, receipts, approvals and recovery hold replacement. The console
control path alone authorizes this operation; peer and conductor tools cannot
supply that authority. Validate the selected managed path and project/session
header before any prior owner teardown, then durably write private previous
and selected metadata. Retain all session files, queues and journal records.
Start the selected persisted identity through the existing permission policy
and verified teardown. There is no automatic fallback, implicit empty-session
proof or effect retry; ordinary restart and captureResume remain strict.

## Amendment: pull-only latency (#398)

A pull-only peer learns of important work only when its model calls a hub tool,
and repo-heavy work was coordinated over chat it read too late.

- When an `important` envelope is queued for a pull-only peer, the bus calls the
  advisory `onImportantQueued` hook and the daemon sends that peer's control
  socket `{t:"queued", queued, important}`, as it does when a pull-only session
  attaches with important work already queued. It is not a delivery: nothing is
  dequeued, steered, journaled or settled, and the queue still waits for
  `hub_inbox`. The `inbox` reply adds `waitingImportant`.
- The plugin caches the counts and appends one line naming the important count
  to every hub tool result except `hub_inbox` until a read reports none. An older
  plugin ignores the unknown push; an older hub never sends it.
- `scripts/check.sh` takes a heavy-job slot, a directory in the git common dir
  shared by every worktree, before any step. A second gate waits up to
  `AHUB_CHECK_LOCK_WAIT_S` (1800 s; 0 fails at once) and names the holder; a
  holder whose pid is gone is reaped. The slot works with no hub running. It is
  not bus-visible; moving it into the hub is the upgrade if pid reuse or reap
  races bite.


## Amendment: consume the first-party agent-mem package (#412, P5)

The portable core is the first-party `@staix/agent-mem` library, initially exact-pinned at `0.1.1`; agent-hub keeps zero third-party runtime dependencies. Its store, sync, claude-mem import, project/home helpers and raw memory/goal commands are imported from the package root, with no vendored copies. Platform helpers use the public Node-safe `@staix/agent-mem/platform` subpath: `0.1.0` exposes only a root that loads `bun:sqlite`, which cannot load in Node-hosted Pi extensions. `0.1.1` supplies the required compatibility export without changing the platform algorithms. The package is the single implementation of deny, hardened git, realPath and process identity, re-exported through the existing local/hub/Pi modules so their callers retain one contract. Package storage semantics and the compatibility schema/hash/path invariants are unchanged.

`src/memory/` retains only hub integration: briefs, recall, the optional claude-mem worker client and capture. The hub owns `src/hub/memory-policy.ts` (`withoutPii`, `promotionScreen`, `mentionsPrivatePath`), `src/hub/read-tools.ts`, task lifecycle writes, lease renewal, model-suggested edges, ask and dashboard consumers. Current project policy is injected through `StoreOptions.screen` and the raw command callbacks. Tasks remains the write authority; PII-turn refusals, current-policy screening before counting/truncation, capture exclusion and the peer read-tool byte budgets remain unchanged.

`ahub memory` and `ahub goal` keep the hub's argument and identity contract, screened agent-readable views, project configuration and TTL. The standalone person-only `amem` CLI is the package's interface; its `--policy-free` acknowledgement is not an ahub option or a reason to bypass host privacy policy. Memory availability and sync remain fail-open for hub turns, while privacy checks keep their existing fail-closed behavior. Data directory precedence is supplied by the package's `memoryHome()` without migration: `AMEM_HOME`, then `$AGENTHUB_HOME/memory`, then `~/.agenthub/memory`; explicit `StoreOptions.home` retains its parent-directory meaning.

`docs/memory.md` documents hub integration; [agent-mem](https://github.com/STAIxBWLB/agent-mem) owns the portable data model and CLI documentation. Portable-core import boundary checks belong to the agent-mem package CI. The former hub-local core boundary checker and its check.sh step are removed with the core; the hub keeps its exact first-party dependency pin. Consuming the package does not complete the owed live legs: copied-home old/new parity, source-unchanged checks, rollback and unrun account/device/sandbox receipts are reported separately. No release, runtime replacement or live proof is implied by the source change.

The consumed package requires Bun >=1.4.2; the hub manifest, plain-JavaScript startup guard and installation guide share that minimum. Node still receives the actionable refusal before any TypeScript or Bun-only import.

Recovery source preservation retains the exact first-party memory package under the preserved runtime, without copying any other node_modules content or linking to the mutable global install. Package identity/version and all retained dependency bytes participate in the recovery digest; cached or preserved dependency drift is refused. Preserved-source verification requires the package inside its own node_modules, refusing a missing or symlinked copy rather than falling back to a mutable ancestor installation. Staged release verification similarly binds dependency lookup to its retained install directory, including cached releases and a fresh coordinator. Releases without runtime dependencies keep their historical digest.


## Amendment: P7 Stage A read-only memory presentation (#412 P7-1)

The exact first-party pin is `@staix/agent-mem` 0.2.0. Agent-hub adds advisory plan-matching live fails to owner briefs and reviewer checklists, optional labeled fail text validated before the 4000-byte cap, person-only decay review, and privacy-filtered bounded read-time staleness markers. The task/PII boundaries remain in Tasks and the daemon. Details and ceilings are in `docs/memory.md`; no new v1 op, stored marker, candidate writer or live-leg claim is introduced.

The P7-1 hint C3 probe gate assumes the tree is not modified during a call: no probe reaches a declared private/denied path in that scope. Concurrent ancestor swaps by a process running as the person are outside the security threat model and may expose one existence bit; this ceiling has a deterministic witness test.


## P7 candidate producers and local observations (#412)

Tasks produces a fail candidate from a public changes-requested review with unmet items, after the current Tasks privacy screen clears the complete candidate text. The review evidence identifies the task, review event and reviewed head (explicitly unknown when absent). Missing cause or retry conditions remain explicitly unknown. Candidate failure never changes the saved review outcome.

`hub_memory_correct {id, text, reason}` requires its own `memory_correct` capability and refuses a PII turn. Input caps are checked before logging or storage; exact or unique visible-prefix resolution uses the current project and full-record screening. Tasks checks the proposed text like `hub_remember`, then rechecks context and target after asynchronous screening. A successful call records the full target id and revision in CandidateStore and returns only its candidate id and person-review guidance. MCP/Pi/local share the tool definition; capture excludes both arguments and results.

Journal handoff observes rendered native memory lines in the final preface/brief payload. First positive journal acknowledgement observes delivered for that delivery and its original render context, not a later turn; pull's completed read is the existing journal acknowledgement contract. Peer messages and cleared task completion summaries observe visible `mem:<id8+>` citations. Counter keys use full entry id, project and known task/turn/session plus journal delivery id for rendered/delivered. Unattributed citations use message:<envelope-id> or summary:<task>:<history-index> observation keys with rendered/delivered unknown; these are citation counts, not proof of a causal per-delivery ratio. Absent observations and identities remain unknown. A bounded in-memory render-context map does not reconstruct acknowledgements after restart, so those delivered values remain unknown. Private envelopes, PII tasks and PII turns produce no rows. There is no usage sync or note mutation.

The machine-local candidate/counter sidecar remains outside native import, recall, briefs, ask and graph evidence. A person accepts or rejects through `amem review` with its existing TTY/policy authority. Dashboard acceptance is deferred. No new v1 operation, note kind or scope is introduced.

## Amendment: selected memory profiles in the hub (#412 P9)

The exact first-party dependency pin is `@staix/agent-mem` 0.3.0. The memory root `M` follows the package's existing home precedence independently of project state. An absent `M/profile.json` binds shared v1; an explicit generation binds `M/generations/G` through the package profile API. The hub supplies current promotion/privacy policy and TTL at that open boundary. Generation reads include the package's readonly legacy bridge; writes and generation sync stay in `G`, outside legacy logs and legacy-main history. No hub tool gains migration or prune authority, and shared-v1 operation semantics remain unchanged.

One explicit profile binding is used by daemon Tasks, read tools, briefs/recall/ask/dashboard, lease renewal, suggestions and sync. Hub memory and goal CLI opens use the same profile resolution. Invalid selector or missing/corrupt active generation makes native memory unavailable while bus/task service continues, with no automatic shared-v1 fallback. Daemon status distinguishes the memory package/profile binding and availability from hub health. Existing handles remain bound: periodic checks and explicit checks at hub operation entry fence later stale calls rather than rebinding the daemon. No proxy/private core ABI is used. These checks are not atomic with an in-flight core operation, so in-flight cutover is excluded: consumers must be quiesced and closed before migration/selector changes. A public core pre-write hook is the named upgrade path for an atomic fence.

Candidates/counters remain at the independent root `M/candidates.db` using the package's explicit sidecar home API. They are neither migrated into `G` nor synced. Selector changes fence Tasks candidate producers and retained telemetry callbacks as well as native note operations; asynchronous privacy work rechecks binding before side effects. Standalone generation `amem review` remains unsupported and refuses; this change adds neither candidate acceptance nor dashboard acceptance for generations.

PII authority, complete-row host screening, capture exclusion, byte budgets and fail-open task delivery remain unchanged. Memory/goal domain JSON remains unchanged; `memoryProfile` is additive only in daemon status, profile-check and the decay object. Synthetic integration must show bridged legacy reads, cross-writes through the package CLI and daemon tools, failure without fallback for invalid/missing generation state, and no note/candidate/counter writes for calls begun after a selector change while bus service remains available. Source/fixture evidence does not authorize real installation, migration or session restart. Real rollout requires separately approved deployed versions and matching live root/profile/selector bindings, synthetic canaries and quiesced/closed/reopened handles. Every running hub using this home needs an authenticated receipt: a matching ready binding, or a generation-capable unbound receipt (`disabled` when native memory is off, `unavailable` when opening failed) proving it holds no memory handle. An unbound daemon and zero running hubs are quiesced for memory; a stale bound handle, unreadable registry or unknown runtime is not ready. Native capture, account/device sync and real memory receipts remain open until observed.

### Bounded sandboxed-peer capabilities (#418)

The frozen issue #418 contract supplies task-bound `hub_task_spec` and the finite `hub_check_start/result/cancel` tools; memory reads reuse #412 P2. `checks.runner = "container"` or `"remote"` remains an untracked, person-owned opt-in; the remote grant and destination require `config.local.json`. Specs include validated canonical GitHub intake identity as well as bounded textual references and remain complete-or-refused; checks run immutable Git source in a credential-free, isolated Linux VM/container with fixed commands and binding-scoped receipts. Default sandbox permissions remain unchanged. The remote backend (#793) streams a metadata-stripped, owner-normalized archive to non-root `docker exec -i ... tar` extraction in its work tmpfs, rather than Docker cp into a read-only-root container. Readiness proves that same transfer and readback path plus network isolation; project/name-filtered inventory reads individual hub labels and confirms cleanup. Each remote run proves or prepares a Docker volume of `node_modules` keyed by the commit's `bun.lock` hash, a digest of every manifest and install configuration file (`package.json`, `bunfig.toml`, `.npmrc`, `patches/`), and the Bun version, architecture and image digest the readiness probe observed (#793b). The one container with a network runs exactly `bun install --frozen-lockfile`; a separate offline container verifies the volume read-only; the check runs offline with the volume mounted read-only and never installs. A commit whose manifests declare an install lifecycle script is refused, because that output depends on source outside the key. Pruning keeps the newest three of the project's own volumes and touches only volumes whose name, project label and key label agree. Preparation is one `prepareDeps` seam on the transport (ownership, install, marker, verify and discard are internal steps, so none can be skipped), `dependencyKey` and `dependencyVolume(projectKey, key)` name the volume, and `dependencyManifest(source)` is asynchronous because the inputs are several files in the staged source.

Apple container 1.5.0 requires a running VM for `copy`. The implementation therefore uses `run --detach --rm` with the fixed bounded idle process, copies the validated source/dependencies, executes only the selected finite check argv and confirms cleanup. A create/copy/start probe failed on the stopped-container copy and left no container; the run/copy/exec probe passed. `--internal` is verified as network configuration `mode: hostOnly`, not an inferred network name. Inactive sandboxed peers establish the cached spec authentication probe at first start/use rather than making unrelated host-embedding fixtures contact real accounts. Source and dependency staging ceilings are 100,000 entries each, 512 MiB source and 1 GiB dependencies; exceeding one refuses the check.

Without a GitHub project identity, bare title issue numbers require no spec capability; qualified GitHub references, issue URLs, explicit repository refs and imported external issues still require it and fail closed at the repository boundary. Malformed receipts remain visible as unknown ids and never prevent startup. Unknown receipt bytes, full output and source staging are retained until ownership/inactivity can be established or the receipt is removed, an explicit exception to normal retention. Unknown containers require confirmed ownership/inactivity before cleanup; removing a receipt never authorizes their removal. Unknown payloads are never deleted through path-based entry checks, which cannot prevent a same-user parent-directory swap at this boundary. Removing the receipts directory is an empty record set, clearing obsolete unknown warnings and allowing normal expired staging cleanup.

Evidence: `docs/verification/2026-10-17-418-probes.md`. The feasibility probe is Linux/arm64 Apple-container evidence, not a managed-Pi or macOS security acceptance receipt. Issue #418 stays open until its managed-Pi live and independent review gates pass.

## Amendment: designated planner (#455)

`config.roles` is derived from the policy roles (defaults, then each file's `roles` block) by `settlePlanner` in the daemon, in place, so Tasks reads the same object. A `planner` key (`config.json` or `config.local.json`, local wins; one of `PLANNER_PEERS`, which excludes the hub-sandboxed pi and local) makes that peer the only planner. With no key the `roles` planners stand; when none of them is on the roster, the first rostered `PLANNER_PEERS` entry plans (`automatic`), recomputed at start, on each policy refresh and after a roster change, never written to disk. The `planner` setting (group Roles, live, risk raises) is the one write path; status carries `planner: { peers, source }` and `roleInfo[peer].planner`. Planning authority and backlog notices follow at once; role text in a peer's instructions follows at its next start. A pinned planner that leaves the roster leaves the project without a planner until a person changes the setting. Planning operations that await a PII screen (pull, plan, split, new release) recheck planner authority after the await, before their board write.


## Amendment: task stalls, exact offer attention and cancellation (#438)

- Ready ownerless tasks retain the ordinary routing decision and reservation guards. A persisted cause/replanning signature admits one ids-only console and supervision notice for an ineligible reserved peer, no eligible peer or a cancelled dependency. Repeated release passes with the same cause add neither history nor notices; a changed cause or explicit replanning admits one new notice. The designated planner (the settled configured planner roles) receives bounded ids-only advice in its next preface, while the configured supervision stream receives the structured item under its existing scope. Advice does not manufacture an ordinary task turn beside a stale backlog batch. Without a planner, the console attention list remains the recipient. Existing owner/reviewer ladders remain unchanged.
- A current proposed offer to a pull-only peer remains console attention until acceptance, decline, supersession or positive delivery evidence for that exact offer envelope and recipient. Tasks records the original envelope id, assignment revision and offer-time pull-only classification before publication. This classification survives detach and restart; current attachment is not evidence that an unread offer disappeared. Actual adapter completion, a correlated reply or a completed pull records positive evidence atomically with journal completion, surviving terminal pruning and reopening. Accepted-only receipts, unrelated inbox activity and operator/hub completion are not read evidence. Advisory queries never dequeue, steer or settle work. Decoded offer/stall candidates are cached by board revision and live eligibility inputs; positive journal read evidence is checked afresh. The derived revision advances atomically with task and stall writes, independently of unrelated delivery-journal writes.
- The disabled-by-default sweep adds `ready-unassigned` with `ready_min: 60`. A ready proposed ownerless task follows the existing deterministic, restart-safe ladder, without treating quiet stall/offer bookkeeping as activity. A person-unassigned task stays suppressed until explicit person assignment or reservation. Planner-pulled work retains reserved-only/WIP admission, and a saved-but-undelivered reassignment does not stop the remaining sweep. Cancellation does not satisfy a dependency. This change does not enable any project's live sweep configuration.
- `cancelled` is terminal and retained. The person may cancel backlog, proposed, in-progress, in-review or changes-requested work, never approved work. A configured planner tool may cancel only its own backlog/proposed task with no execution evidence: never started, or accepted and then declined or returned untouched (#812, which replaces the earlier rule of no historical acceptance). `Tasks.cancel` validates the optional flow revision, screens the reason/reference and rechecks authority, revision and recovery/shutdown exclusion after asynchronous screening before the sole board mutation. History retains actor, reason and optional supersession reference. After the cancellation write commits, advisory cleanup and notices cannot change its successful result. No outcome memory, native cancellation, branch deletion or dependent release occurs.
- Cancellation releases overlap/reservation participation and sends each distinct former owner/reviewer one stop notice. Its trusted cancellation revision marker keeps that stop notice relevant; earlier notices for the cancelled task become moot under #434. The classifier never uses timestamps alone to identify the stop notice. Dependents keep waiting and receive the cancelled-dependency cause. List, show, explain, dashboard and release projections treat cancellation as closed, retaining the current privacy screen and distinguishing cancellation from successful approval.
- The daemon advertises `task_cancel` in hello and status features. Current clients refuse cancellation without that feature. Upgrade and restart persist the verified target's exported features with its immutable root/digest before prepare, including cached targets, and reuse that receipt on resume after verifying the same bytes. A legacy staged receipt without feature evidence is probed only while a project is not yet past commit; fully committed projects do not require another probe. This preserves #215: a transient probe failure cannot refuse a target that was already staged with verified evidence. Preflight checks only uncommitted sources and refuses a target lacking `task_cancel` while cancelled rows exist. Source prepare/commit recheck before holds/snapshots and around asynchronous work; cancellation cannot write through recovery preparation. Refusals name task ids and never rewrite rows. An older binary started manually can misclassify cancelled rows as open or fail to move them; this is the explicit unsupported compatibility ceiling. Never map cancellation to approval.
- The post-release live step remains separate: do not cancel the historical task or enable the project's sweep from implementation tests. AC7 needs installed-runtime receipts.

## Amendment: live configuration reload (issue #439)

The daemon validates one captured candidate containing config.json, config.local.json,
routing.toml and routing.local.toml before applying any part of it. Missing files use
existing defaults; unreadable, malformed, unknown or invalid configuration refuses the
whole candidate. The accepted routing snapshot remains authoritative until another
complete candidate succeeds; last-good parser fallbacks never authorize a reload.
Settings writes, undo, explicit `ahub settings reload`, dashboard reload and debounced
file changes share this path. One invalid candidate produces one bounded notice naming
the file/key and validation error, without echoing configuration values.

Every setting and configuration block has one apply class. Leaf rules override block
rules. `live` changes future decisions immediately; `next use` changes the next task,
request, batch or peer start; `restart` retains the running value and reports its key
and reason. The registry exposes the running and file values separately.

| Apply class | Configuration |
|---|---|
| live | runtime permission choices, authorized roster changes, roles/planner/conductor, instruction-file protection, approvals.notify, research.enabled, snapshots.enabled/keep, task_sweep, tasks.wip_limits, capabilities, routing classes/stay_switch/signals/constraints/hub_routes/max_switch_prefill_tokens |
| next use | permission_modes and catalog_roles at the next peer start; peers.*.start_mode and native launch argv; coordination for newly created tasks; task release/review policy; new approval timeouts; bus batch/admission limits; budget/context/inference/limits; peer watchdog and step limits; recovery and experiment decisions; memory brief/injection/suggestion limits |
| next use | pi.auto_start changes a later startup/recovery auto-start decision; reloading it never starts or replaces a running peer |
| restart | memory.enabled/native/worker_url/short_ttl_days/sync_interval_min: open consumers, selected profile binding, client and sync timer must be quiesced together |
| next use | local model selection at the next local peer creation; retired tables never execute; existing native sessions retain their model contract |
| restart | pi.dgx_coding/dgx_fast and routing.pi: model catalogue and context publication belong to the existing Pi relay; a reload must not replace a live native relay |
| restart | omniroute: credential and gateway clients are bound to relay ownership |
| restart | mlx: model/runtime ownership and device resources belong to the running instance |
| restart | checks: bounded runner and completion-check execution contracts are constructed together |
| restart | pii, data and local deny/read/network policy: existing native sessions and generated sandbox/proxy contracts must not acquire a different trust boundary mid-session |
| restart | profile/profile_overrides and text_projection: session tool schemas, role/profile contracts and converter/cache ownership are bound at startup |
| restart | terminal.open: the terminal provider is supplied by the daemon lifecycle |
| restart | bench.enabled: the benchmark execution environment is selected before work starts |

Listener ports and the state directory are startup options rather than editable
settings; their already-bound sockets and state ownership require a new daemon.
Changing the external memory selector likewise requires the existing quiesce/reopen
lifecycle and is never a hot reload or automatic migration.

Trust is checked against the actual source files and their last accepted raw layers,
not against a scratch project's Git status. Effective guarded changes are also
checked when unchanged raw declarations acquire different Git provenance. A
settings ticket never authorizes command/policy fields outside the editable registry.
Changed MACHINE_LOCAL values and raising
registry values are refused from tracked or unverifiable files. Ordinary dashboard
and watcher authority cannot adopt a raise hidden in an unrelated local edit. A
settings session or terminal may adopt an untracked value within its existing
settings authority; neither bypasses the tracked-file rule or the never-ask and
roster confirmation/lifecycle fences. Runtime permission mutation still uses
permissionChange/changePermission exclusively.

A sweep reload validates its next-pass policy and reschedules its timer without
changing a pass already in progress. Bus scheduling changes retain queued originals,
prefaces, manual pauses, recovery holds and inflight delivery. Coordination preference
is pinned when a task is created (including split children); changing it neither
retroactively silences an existing task nor lifts an existing silent cohort. Current
PII and capability fences remain authoritative. Snapshot enablement applies to a
later turn; a running turn retains its capture decision and is never stopped.

The console's sixth Settings tab reads the same registry as the dashboard. It edits
through the authenticated daemon client: value, preview, nonempty bounded reason,
then explicit y; undo also previews and confirms. In the Peers tab, `w` enters
this same editor in place on Peers for `tasks.wip_limits.<peer>`, prefilled
with the selected peer's current limit. Bounds (currently 0..32), the `raises` risk label and
`applies: live` come from the setting definition. A missing `taskWip` entry
produces a notice and opens no edit. Esc cancels without a write; `6`, then
`u` invokes the existing Settings undo preview/confirmation operation. The shortcut creates no
write path or authority: Settings remain person-only and `ahub settings` keeps
its agent-shell refusal. Stale preview replies cannot arm a
write, and pasted confirmation text never executes one. The daemon accepts additive
settings_reload and undo-preview requests only from console roles. The dashboard's
setting_reload action uses its existing authenticated session; manager forwarding
has ordinary authority. No client writes configuration files directly. Pending
restart keys and reasons appear in status, console and dashboard. These requests and
optional projections are additive; older daemons refuse unknown requests and the
control protocol remains 16.

### Reload authority and publication scope (#439 review amendment)

Malformed syntax, unknown keys and invalid values still refuse the complete candidate
before any publication. A valid but unauthorized key is different: retain that key's
accepted value, report its name and reason, and continue applying independently
eligible changes. A refused key never wedges an unrelated setting write.

An individual setting write or undo publishes only its named registry path. Its
preview and confirmation do not authorize other edits in either config file or either
routing file. This includes catalog guidance: only the named peer is prepared (#295).
Unapplied edits remain pending for a later explicit reload; accepting another key must
not acknowledge them in the accepted source baseline.

Privacy tightening is automatic from tracked or untracked files: enabling local PII
constraints/screening, adding PII patterns, removing nonholder role memberships and narrowing an explicit capability list cannot
be mistaken for a raise. Deleting a restricted capability entry restores the default of all capabilities and is a guarded widening. Roster membership changes always use their named confirmation and peer lifecycle, even when removing a peer; generic reload never bypasses those steps. Registered floors and known semantic reductions in admission
or permission likewise remain available without authorizing a wider policy. Other
agent-relevant policy, including limits, supervision feed, inference, review and crash
resume, receives a per-key authority check even outside the settings registry.

`ahub settings reload` is the explicit adoption path for guarded file edits. The daemon
first returns the exact guarded keys and a confirmation token bound to the candidate
bytes and accepted configuration revision. The person reviews that list and confirms
from an interactive terminal; only then may the same candidate be adopted. Changed
bytes or accepted state invalidate the token. An ordinary watcher or dashboard never
confirms a raise; a settings session remains restricted to registry keys. Tracked or
unverifiable MACHINE_LOCAL command and credential declarations cannot become trusted
through confirmation. Refusal notices name each key and say to review and run
`ahub settings reload` or revert the file; tracked machine-local declarations also
require moving the declaration to an untracked machine-local source.

Coordination pinning is local to a daemon lifetime. A setting reload preserves each
existing task's captured mode and existing cohort silence; a daemon restart re-pins
retained task rows to the startup mode. This is an explicit compatibility ceiling,
not durable task metadata or a migration.

Inheritance and undo use the actual destination source trust. They may restore an unchanged effective startup value after explicit consent, but a shadowed edit that was never authorized is not an accepted fallback. New lower-layer raises remain refused even when an unchanged local overlay previously hid them.

Reserved prototype path components are refused throughout nested routing extension tables before publication. Configuration path writes never traverse inherited object properties.

Hub-route dictionaries retain opaque quoted keys, including dots. Each active dictionary is one guarded value for reload confirmation and publication; retired targets/routes never enter publication. Privacy fields and ordinary registry settings retain leaf-level decisions.

### Settled authority and reviewable confirmation (#439 round-2 amendment)

A role-list subset is automatic only when the settled planner and conductor holder
sets stay unchanged. Removing the last explicit planner can hand that authority to
the automatic fallback; removing a settled holder therefore requires guarded
confirmation even though the raw role list shrinks. The same pure role resolver
serves publication and the authority comparison.

The console preview shows a complete bounded before -> after value for every guarded
key, including full executable argv, and describes any settled holder change. Values
stay out of notices and events. A value that cannot fit the review budget is retained
with an actionable rejection, never silently truncated and authorized. Each before
or after representation is at most 16 KiB, an effect description at most 2 KiB, and
the complete confirmation at most 128 KiB.

The confirmation token proves candidate/state freshness. It does not independently
prove a person's presence: console-role authority is the existing server trust
boundary, while the CLI enforces interactive TTY, explicit y and the deadline.
The roster exact-key mutation guard observes admission while teardown is held,
before reload can repair a wrong whole-roster assignment. The roster authority seed
covers the dashboard authority boundary; its separate leaf check is defence in depth.

Console undo binds its confirmation to the previewed setting key and the SHA-256
of the exact undo record. A changed or missing record refuses without writing;
same-key replacement also invalidates the preview. These optional request fields
preserve protocol 16 for older direct CLI clients. The Settings panel never forces
a busy roster removal: it names `ahub roster remove <peer> --now` and the active-turn
stop/detach consequence so the person can make that choice explicitly in the CLI.


### Adapter registry A1 (#451)

A1 introduces API 1 definitions for the seven existing kinds and separates a peer
id from its adapter kind through `kindOf`, `definitionOf` and `familyOf`. With no
instance declarations, only builtin ids resolve. A suffix is never guessed. This
phase does not enable instance configuration, account changes or new native modes.
Existing external-client admission and lazy roster behaviour remain unchanged.

Qwen is the first migrated ACP kind. Its definition owns the existing headless
launch/factory, exact 0.25.0 identity, permission-mode mapping and session rules.
The direct `AcpPeer` `qwen025` option and public helper exports remain compatible;
legacy benchmark ACP without that flag stays unmanaged. Other kinds retain their
existing runtime paths until A2; their registry metadata is not proof of a running
or authenticated native client.
Unmigrated definitions delegate launch plans to the existing CLI and keep existing
runtime permission handlers authoritative. Claude, Pi and local keep empty partial
native-mode maps where API 1 cannot express their scoped write/edit hooks; this is
an A1 compatibility ceiling, not an unmanaged policy or a refusal. A2 must migrate
those handlers and their representation before interpreting a missing mapping.
Display-only permission grants remain exact copies of the existing explanations.
The bounded Qwen doctor CLI-version probe and its 0.25.0 pin remain unchanged in
the transitional guard baseline. A2 moves all version probes together and amends
`VersionContext` once; A1 adds no observed-version input or native readiness claim.
The native Kimi mode-id constant moves to a dependency-free leaf while its public
re-export remains intact, so either registry-first or definition-first imports work.

Two additive fields complete source inputs omitted from the A0 type sketch:

- `LaunchContext.nativeCommand?: readonly string[]` carries the already-validated
  native argv, including wrapper arguments. Only core config or the existing
  redacted preview supplies it; definitions never load daemon config or recover
  commands from environment text. Model tool schemas do not expose this field.
- `permission.grants?: Partial<Record<PermissionMode, string>>` carries existing
  operator explanations as static data. It changes no approval decision, scope or
  native mode. The frozen `CreateContext` and transport-specific options stay intact.

The guard inventories AST comparisons, closed-list imports and vendor literals,
including inline dashboard scripts, under stable file/symbol scopes. Its reviewed
A1 baseline records the current source, rather than claiming the old A0 grep's
265 line matches equal AST node counts. A new group, count growth or stale entry
fails; later phases may only shrink this baseline. A1 originally exempted kind-aware comparisons from real, unshadowed registry
resolver imports; the A2 amendment below counts them instead. Native adapter implementations and
explicit non-peer config semantics remain the narrow exceptions. Existing literal
catalog exports used by older recovery source probes are retained until their
replacement compatibility proof is available; a refactor must not silently make a
Qwen-capable target appear unsupported.

The reviewed inventory distinguishes the historical grep from AST nodes: at
`71253098`, the same AST scanner counts 364 sites in 142 groups (222 comparisons,
19 closed-list imports, 123 vendor literals). At A1's main base `4bcf62fa`, it counts
395 in 156 groups. The first A1 snapshot has 382 in 155 groups: thirteen Qwen/raw
watch comparisons are removed, and the seven-entry role object becomes a
seven-entry legacy-order list whose role values come from the registry. No raw
Qwen comparison remains outside the native definitions. The initial baseline is
reviewed data, never regenerated by the test; changes brought by a newer main
must be reconciled explicitly before this first baseline ships.

Before the first A1 review, main `b9efa131` merged #463. Its recovery guidance and
reattach logic add 33 sites in 16 groups, with 19 changed baseline entries. The
same scanner reports 428/172 on that main and 415/171 on the combined A1 source.
Every added or increased baseline entry matches that main-only delta; A1 still
removes thirteen sites and one group. This explicit reconciliation precedes the
first shipped baseline and does not permit later phases to grow it.

## Adapter registry A2 amendment (#451)

A2 counts native-name comparisons even when a trusted registry resolver supplies
its left or right operand. These sites use the `kind-aware-comparison` inventory
pattern and the same lexical file/symbol group as a raw comparison, including
switch cases. Replacing a raw comparison with `kindOf` or `definitionOf(...).kind`
therefore does not shrink a baseline group. Alias and shadowing checks remain in
force. The pre-existing kind-aware preview site is counted explicitly; the A1
source has 415 other sites plus that one site. A2 removes the transitional
baseline by migrating policy, rather than by adding resolver exemptions.

Session metadata distinguishes native resume arguments from daemon startup
restoration. `session.resumeById` means that recovery passes the verified native
session id to the start command (Qwen). `session.restoreOnStart` means that the
daemon restores recorded startup options before automatic startup (Pi). Neither
flag proves that a conversation can be resumed or permits a fresh replacement.
Crash recovery tests `resumeById` and uses `crashIdentity`; transport choice or the
presence of a factory does not establish that capability.

A2 preserves literal `KNOWN_PEERS` and `OPTIONAL_PEERS` exports in
`peer-catalog.ts` for released coordinators that inspect their source. The guard
records these exact file/symbol exceptions separately with the reason
"cross-release source probe", and tests their values against the typed registry
catalog. The same exception preserves `start-mode.ts`'s literal `START_MODE_PEERS`, which released coordinators inspect before restoring Kimi headlessly. The three probes are counted separately (5 + 3 + 4 sites). The native vendor baseline is otherwise empty. A retained coordinator's
existing source probe must accept the A2 target; no unsupported-target ceiling is
introduced. ponytail: retire these compatibility literals only after a separately
approved minimum supported upgrade source no longer reads them.

Native recovery hooks return read-only facts over the existing narrow DTOs.
`zeroTurn({ stateDir, binding, phase })` reads Codex's existing event proof only
for planning, and Claude's existing transcript absence only for attachment or
verification. `restoreArgs(peer)` and `recoveryRefusal(peer)` are pure over the
captured peer. `personFresh` and `missingEvidence` are policy data, not authority.
`resumeArgv(binding, fresh)` returns the CLI tail; the coordinator supplies the
interpreter, entrypoint and project prefix and retains all receipt, repair,
waiver and unknown-state decisions. The restore oracle, supplemental matrix and
transition code remain byte-unchanged.

Quota and context readers are pure normalizers:
`QuotaReader.read(value: unknown): UsageWindow[]` and
`ContextReader.read(value: unknown, sessionId: string, measuredAt: number): ContextReading`.
They preserve the existing malformed-input results. The coordinator still binds
transport generation, native session and measurement time before reporting.
Palette data additionally carries optional `tone` and `ansi`, preserving the
existing terminal palette and rendered CSS bytes.

P4 conformance is transport-specific. Delivery-only native drivers set busy
synchronously at admission; pull-only WebSocket peers receive no unsolicited
delivery or busy mutation; Claude push keeps its existing receipt/native-start
busy contract. Native production behavior does not change to satisfy a generic
conformance case. The kit also covers the existing generation fences, process
groups, approvals, quota refusals, mode acknowledgement/timeout and recovery
contracts for each applicable transport, with explicit unsupported outcomes.

`resumeArgv` accepts the existing `SessionRef` (session id/file, backend and model),
which withholds terminal and launch identity from a pure argument formatter.
`recoveryRefusal(peer, phase?: "plan" | "restore")` defaults to planning and keeps
both existing phase-specific native messages. Fixed private compatibility data
`legacyTargetSupport` and `legacyHeadlessArgv` name only the existing catalog or
start-mode literal exports; their old read points and regexes are unchanged.

`start.daemonPort` is a closed, data-only engine tag (`codex-appserver`, `acp`,
`owned-acp`, `pi-rpc`, `local-worker`), required when `start.create` exists. Unknown
values are refused at registry load. Channel/pull definitions without a factory
leave it absent. Typed registry-owned wrappers retain the existing `DaemonPorts`
union; core selects the engine and retains lifecycle/authentication closures,
while the definition factory remains the only native constructor.

The trusted CLI host may supply `LaunchContext.pi` using the existing Pi builder
options, extension path and live bridge port/token. A redacted preview supplies
only redacted placeholders; bridge tokens never reach previews, logs or events.
`LaunchPlan.env` preserves Pi's existing child environment. Definitions never
load daemon config or infer executable commands from environment text.
`VersionContext` adds `observedVersion`, `nativeCommand` and `projectRoot` once:
the host still performs each probe, while definitions validate or display it.
`cli.authority` and `cli.personOnlyFlags` can only restrict existing authority;
identity.ts stays authoritative and missing/unknown metadata retains today's
rule. `start.passthrough` is data only. MCP installation, ordering fences and
finally cleanup remain in the existing CLI host; A2b removes the unconsumed
`init.mcpPlan` sketch instead of advertising another installation path.

### A2 internal native host projections (2026-10-18)

The remaining AST inventory after the first A2 checkpoint has 260 policy sites in
113 lexical groups. Native CLI entrypoints and previews, configuration validators,
settings rows, plugin inventory and recovery presentation need explicit definition
projections in addition to the original frozen transport factory hooks. These are
moves of existing built-in policy, with the same host-owned effects, argv, ordering,
errors, privacy, permission and timing fences. They add no instance support,
capability or native behavior.

Private, statically imported built-in preview helpers implement the frozen
`start.launch` / `publicLaunch` redaction path. They preserve current validation,
JSON order and placeholders, and cannot execute a native process, connect to
control, allocate runtime state or write authoritative state. They are not public
`AdapterDefinition` / `NativeHooks` extension points; configuration cannot register
a helper. Person CLI entrypoints are relocated into a fixed private built-in
dispatcher for C1, without adding a public `cli.run` or `NativeHooks` callback.
The dispatcher cannot load external modules or accept caller-selected callbacks;
its typed context contains only the original CLI host operations. Identity,
command access, live-test delegation, audit and project/lifecycle admission remain
in the host before dispatch, and each moved body retains its native effects,
ordering, errors, environment and cleanup. Doctor projections carry existing probe
metadata; the host retains probe execution and output. Configuration projections receive the current validator vocabulary and
return the existing schema/settings entries. Recovery projections carry the current
crash plan, continuity decoder/bookmark and unrecorded-terminal classification.
Reporting flags, tool classification, recall source and display tones are semantic
data; a consumer must not replace raw comparisons with kind-name wrappers or
constant aliases. Plugin inventory takes the existing home/cwd/env context and
returns the existing typed Addon rows, correcting the unused string-array
placeholder. Arbitrary daemon callbacks and caller-chosen executables, paths,
permissions or policy remain forbidden. External module publication/validation is
still A4 and must freeze its accepted subset separately.

Claude's channel is native-hook-driven: delivery insertion remains idle until an
authenticated native-start observation. Its conformance case asserts that behavior;
transport adapters retain the synchronous-busy requirement. Unsupported native
quota or process ownership is an explicit applicability result, never synthetic
success. Every applicable P4 behavior is exercised with the real adapter and fake
transport, without changing existing assertions or claiming live-account evidence.

The P4 late-result probe exposed an existing Codex watchdog defect on the unchanged
54e631d8 adapter: a completed agent message could refill the answer after watchdog
invalidation, then its stale turn completion could broadcast it without its former
audience. A2 repairs this intended generation fence in source. It discards answer
notifications without an active turn and notifications naming an inactive turn,
retains the legacy unknown-turn compatibility path, and clears expired deltas.
The new probe keeps its strict no-message/needs-review assertions. Supported native
RPC behavior, approvals, quota classification and existing tests stay unchanged.

The watchdog fence also covers acceptance before a queued `turn/started` report
and unanswered hub `turn/start` RPCs. Cancelled named ids remain retired until their
exact completion or session teardown; late acknowledgements cannot restore a
cancelled audience or relabel uncertainty as `failed_safe`. Ordinary legacy
unknown-id starts keep their fallback. After an invalidation with no provable
native identity, unnamed lifecycle reports cannot be safely attributed: keep the
peer offline and require a verified reattachment rather than guess a new turn.

### A2 daemon semantic projections (2026-10-18)

The daemon constructs every native driver through `start.create` and the fixed,
transport-typed `DAEMON_PORTS` wrappers. Protocol lifecycle dispatch may select the
actual engine; provider policy does not select an unrelated capability as an alias
for a kind. Existing host callbacks retain their original effect authority,
privacy, owner checks, ordering and timing.

The internal definitions additionally carry the existing start-only enable-switch
membership rule, exclusive-start refusal, tool-refresh requirement, explicit
headless-mode argument, attached-worker reconfiguration rule, dashboard start
command and pure ACP argv builder. Attach metadata serializes recovery launch
identity and carries the existing pull-only admission and status guidance.
Permission status text is separate from the existing permission refusal text;
`permission.trackUnattended` keeps native unattended ownership accounting distinct
from protocol dispatch.
Budget metadata names the soft-token reset on resume. Session metadata declares
native conversation revert support; the host still checks the actual driver and
latest turn and owns the pause while reverting. CLI metadata formats retained
terminal and roster-return notices and supplies the existing preview argument
tail. These fields only move native policy, preserving existing output bytes and
behavior. The version hook consumes the already frozen `observedVersion` and peer
fields; the daemon retains the bounded native transcript probe.

The doctor command consumes fixed built-in metadata and pure observed-value
projections exported through the registry. Native tool order, plugin probe argv,
optional roster checks, section/severity, recovery identity fields and legacy
capture labels stay in the built-in implementation. The CLI retains every spawn,
source-verification, connection, gateway and memory effect in its existing order
and privacy boundary. This private data adds no public definition member,
executable callback or configurable probe; unknown names retain their existing
Hub/unknown classification.

A2 reanchors thirteen seeded mutants to the same moved semantic guards: explicit Pi
roster precedence, supported roster keys, retained-terminal result text, Kimi TUI
recovery refusal and admission cleanup, Qwen opt-in/session/crash resume, planning
reservation support, active Kimi TUI settings floor, live headless Kimi watch,
disabled Codex plugins and bounded
regular-file tooling reads. Seed ids and test targets remain unchanged; the other
406 seed objects remain byte-identical. The mutation pairs must still demonstrate
green production behavior and failure with that guard removed.

The final A2 AST inventory is empty for core policy: zero sites and zero lexical
groups. The reviewed policy baseline is explicitly `[]`; it is never generated
from source during tests. Three cross-release literal probes remain separate
(`KNOWN_PEERS` five, `OPTIONAL_PEERS` two, `START_MODE_PEERS` three). Precise
screening-provider/lifecycle enum false positives remain scoped by file, symbol
and AST shape; negative fixtures still catch vendor comparisons in those scopes.

Quota participation and execution-budget instrumentation are independent.
`budget.quotaExempt` preserves native quota exemption while retaining `account`
and instrumented execution limits: local sets it, Pi does not. Registered kinds
without budget metadata remain quota-exempt; external ids retain manual quota
accounting. The A1 named compatibility metadata export preserves its original
wrapper plans and observable shape, while the registry consumes separate native
runtime definitions. Native display constants retain reference identity; private
stream tone selection does not add fields to that observable display object.

Configurable start-mode fallback reads the registered definition's default form,
retaining explicit overrides and existing unknown-id behavior. The Kimi default
mutant changes that native metadata from TUI to headless, so the original default
assertion observes it directly; it does not remove a settings row or mutate the
retained cross-release source literal.

A2 preserves the recovery tests' assertion contract while reconnecting their
execution harnesses to production code. The Pi CLI parser harness imports its
extracted pure parser rather than extracting a removed main.ts declaration.
The reattach parser VM receives the real registry resolver, and the attachment
wait VM receives the real exported session-field resolver. Every existing
`expect` line in these three files remains byte-identical; no fallback, mock
policy, weaker condition or changed expected result is introduced.

### A2 round-1 parity and capability-scope constraints

Quota handoff uses the registry's native platform projection, preserving exactly
Claude, Codex, Kimi, Qwen and Jcode. The per-delivery `recallInjected` flag remains
independent: adding Kimi/Jcode handoff platforms does not make their own sessions
part of injected-platform exclusion.

Routing reads on-prem trust for PII admission. Legacy fixed-model/relay policy,
local-allowed refusal text, context handling, preference tier, relay ordering and
trace labels are native definition data. Host routing and task flow retain their
existing policy calculations, messages and candidate ordering (including class
fallback duplicates). This native routing data is not an external configuration
surface.

Registry loading calls `assertNativeCapabilityScope` before publication. A
non-builtin definition cannot declare `start.acpCommand`, `attach.admission`,
`budget.resetSoftTokensOnResume`, `session.crashIdentity`, a `pi-rpc` daemon port,
or the native `routing` policy block. Fixed builtin membership is object identity,
not a caller-supplied kind name. Current consumers combine these fields with fixed-builtin assumptions or
host-global native state; generic shapes are follow-up work before A3/A4 loading. Other ordinary ACP
metadata remains valid.

The Qwen conductor refusal uses the original generic CLI text. Pi terminal
observation reads only observed top-level/nested session-file metadata, never
launch `args.sessionFile`. Pi TUI recovery bindings preserve the captured
`CLAUDE_CONFIG_DIR` fallback while retaining Codex's `CODEX_HOME` selection.

The guard resolves immutable peer-id constant aliases and supplied-source
import/reexport bindings through lexical symbols before classifying comparisons.
Shadowed and unrelated bindings remain independent; named non-peer enum exceptions
keep their exact scope. It performs no filesystem or package lookup.

### A2b consumed contracts and conformance (2026-10-21, #451, #625 phases 2-3)

Runtime `start.launch` is optional and supplies only real native argv planners.
Kimi, Pi, local, Jcode and fresh-review children use verified host startup ports,
not unused CLI-wrapper plans. The frozen A1 export retains its old compatibility
shape under a separate legacy type and is never selected by runtime consumers.
Remove unused `start.ownsTerminal`, `init`, `QuotaReader.resetOnWindow` and hooks
`agentIdentity`, `onAttach`, `onDetach`, `conversationRevert`, `replaceSession`.
Actual terminal ownership, identity, revert, replacement and MCP writes retain
their existing transport/host paths. The consumed native facts hook remains.
Remove unconsumed runtime `permission.modes` and `permission.readOnly`; native mode
mappings, host approval gates and fresh-review isolation receipts remain
unchanged and authoritative. Missing metadata never grants permission.

`attach.externalHello` explicitly admits an authenticated external process.
`instances.mode` separately selects external or headless declaration policy,
with an optional fixed role ceiling. MCP configuration shape grants neither.
Claude keeps human-owned external planner/reviewer instances and its fresh
headless reviewer exception; agy now refuses ordinary extra instances at config load (older declarations could load as inert pull-only extras).
Qwen context is now unknown because it has no verified occupancy source; it no
longer borrows Kimi's context parser.
Declaration admission never proves execution-root ownership or isolation.

Daemon normalization dispatches through the resolved definition's `budget.reader`
and `budget.context`. Preserve source timestamps and current session, launch,
generation and privacy fences. Missing readers stay unknown, including ACP kinds
without a verified occupancy source; never borrow another kind's parser or
manufacture empty quota readings or zero occupancy.

The fixed-builtin restrictions above remain ceilings: `acpCommand` selects the
Kimi-specific host startup path; `attach.admission` consumes its native TUI launch
receipt; `resetSoftTokensOnResume` resets host-owned soft accounting;
`crashIdentity` validates released native recovery records; `pi-rpc` owns the
verified relay, sandbox and process-monitor lifecycle. Configured definitions
cannot opt into these host-global assumptions. Their upgrade path is typed,
kind-neutral host ports before external loading, not removal of scope guards.

Registry coherence validates base and reviewer-variant attach, factory and reader
structure without invoking a reader or performing I/O. Conformance enumerates
every definition and variant with distinct enrollment or an unsupported reason
naming dedicated coverage. Driven fixtures use `definition.start.create`; Claude
uses its real external channel. Jcode exercises its owned-ACP watchdog and Kimi
separately exercises TUI pull-only queue behavior. Unsupported native permission
or quota legs never imply readiness.

The AST guard additionally checks native defaults, source-proven peer/kind call
arguments, exact native regexes, startsWith/includes/hasOwn predicates (including
constant bracket spellings), and adapter-origin native instanceof dispatch.
Aliases and shadowing remain source-bound; generic hub classes, dynamic keys and
prose are not native identity policy. Keep the frozen core baseline empty and
existing seed entries unchanged except the reviewed search/replacement-only
reanchors of `roster-detached-pi-recovery` and `kimi-watch-live-owner` from
instanceof to the equivalent native predicates. Their identity and named tests
stay unchanged, with green-to-named-assertion proof through the seed runner. Add a
registry START_MODE_PEERS membership mutation seed.
Native type predicates and the external channel implementation live in adapters;
authentication and lifecycle authority remain in the daemon. Stable hub leaf
exports preserve source compatibility for native state readers.

After unidentifiable Codex cancellation, status carries a fixed
`unidentified-cancellation` notice while its existing offline latch holds. Late
completion cannot clear it; verified native reattachment does. No native ids or
provider text reach the notice.

### Peer capability ports (#625 phase 6, slice 1)

`PeerAdapter` optionally exposes a readonly `sessionGeneration` (string or number),
readonly `permissionModeState` (a permission mode, unknown or unmanaged), and an
acknowledged `setPermissionMode(mode)` operation. Generic runtime permission and
generation dispatch uses these ports without native-class enrollment. An absent
generation port retains the existing recovery-session/owner-token fallback; a
present but undefined generation is unknown and refuses bounded checks.
Checkpoints fence a present generation unless `checkpointUsesSessionGeneration`
is explicitly false. Pi keeps that exception so its owner/session-only checkpoint
behavior is unchanged. BasePeer installs no default generation property.
Read-only and unmanaged ceilings, never-ask confirmation, serialization and the
current-owner/not-offline check after acknowledgement remain authoritative.
Codex proxy/startup/restoration-debt and Claude launch-generation/unattended-hook
proofs remain native branches; typed semantic ports for those proofs belong to a
later slice.

## Amendment: playbook lifecycle and criteria checklist, 2026-10-18 (#481 S0/S8)

- The AI-Native SDLC Playbook supplies the built-in stage model of an enabled lifecycle: intent (Plan), spec (Design), plan and build (Build), test (Test), review, merge and release (Deploy), maintain (Maintain). `mode` advise or enforce without `stages` selects this list. Off (no file, or `mode = "off"`) keeps the seven #257 stages, so its config, receipts, `hub_sdlc_record` schema and status output stay byte for byte. An explicit #257 list still loads: off keeps it as written, and an enabled lifecycle keeps its order under canonical ids (spec, plan, build, review, test, merge, release). Any other list needs definitions.
- Valid bases are the nine playbook stages plus the #257 names `implement` and `verify`, which mean build and test. A stored `implement` or `verify` receipt resolves to `build` or `test` in a playbook config; a write with the old id stores the id the config lists. Custom definitions keep loading with their old base names; a playbook-only built-in id (intent, build, test, maintain) cannot take another base. The test base takes the reviewer actor, like verify. Status carries `playbook` (the playbook stage) whenever the mode is not off; the dashboard shows it beside the stage.
- The head-bound acceptance-criteria checklist (`criteria` in a receipt) belongs to the Compliance pass. It keeps id, head, 1..32 criteria with required, result and hashed refs, reviewer- or person-only writes and the reviewed-head binding; criterion ids may name issue AC ids (`AC8b`). Once recorded it adds its blockers in any enabled lifecycle; off ignores it unless the retired setting below asks for it. A `criteria` entry or exit gate needs no workflow selector: a missing checklist is a blocker the reviewer can clear.
- Checklist task import is removed. A non-empty `tasks` list is refused before any write; dependencies stay with `Tasks.after` (`ahub task propose --after`). A receipt stored under `phase` reads as criteria, and its task list is shown with a note and never gates readiness. Board split-undo still treats such a stored list as a reference.
- Deprecation window (constant `RETIRED_WORKFLOW_FROM`, 0.13.0): before it, `workflow = "none"` loads silently, `workflow = "gsd-lite"` loads with a `hub.log` warning and requires a criteria checklist on every task, the `phase` gate loads as an alias of `criteria` with a warning, and the `phase` receipt name is accepted silently. From 0.13.0 each is refused with a field-level reason; the aliases and their tests are then deleted.
- Tool schema: when the mode is not off, daemon status carries `lifecycleCriteria: true`, and every managed surface (the channel and tools MCP servers and the local worker) advertises `criteria` instead of `phase` in `hub_sdlc_record`. Custom stage ids and the checklist rename are independent: off and older daemons, custom stage lists included, keep `phase`, because they accept only it. That off schema changes once, when the alias is removed at `RETIRED_WORKFLOW_FROM`.
- `ahub sdlc export`: a plain off lifecycle (no retired setting) keeps the #257 export bytes (schema 1, `workflow: "none"`, `phase: null`). An enabled or retired-setting lifecycle emits schema 2: sanitized state (id, state, stage, criteria view or a private stub), `stateHash` and `sourceHash`, without the workflow field. In off, a `phase` receipt write also keeps its #257 bytes (`tasks: []`); task import stays retired in every mode, so a non-empty list is refused.
- Contract amendment, seeds (419 before and after: 414 byte-unchanged, 3 modified, 2 removed, 2 added; the registry baseline is unchanged). Modified, each with the same id, test file, test name and mutation intent: `workflow-reviewer-only` (the criteria/phase check), plus `override-local-schema` and `lifecycle-native-schema`. The person approved the last two on 2026-10-18, because the `lifecycleCriteria` plumbing changed their call sites. Removed with the code they mutated: `workflow-exact-after` and `lifecycle-phase-view-required`. Added for the new guards: `criteria-task-import-retired` and `sdlc-workflow-window-closes`. Tests that pinned the retired gsd-lite behaviour (task import, phase naming, the workflow projection, the implement id stored in an enabled config) are amended in the same PR; every other test is unchanged.
- S0/S8 implement none of S1-S7 and S9-S11. The issue stays the spec, Tasks owns mutations and GitHub owns PR, check and tag facts.
### S3 structured findings clarification (#481, hub task #196)

Open Important findings carry across reviewed heads until the reviewer explicitly marks fixed or false_positive, or the person accepts with a rationale; nits do not carry. Review requests list carried public ids, pass, severity and optional path, with private details limited to counts. Use a shared valid-head resolver (PR, reviewed, local, then valid commit metadata); enforce refuses a non-empty report with no resolvable head. Recurrence uses semantic pass/id pairs excluding false positives and a durable card marker rather than its title.

## Reviewer separation amendment (#450, hub task #223)

Owner decision 2026-10-18 (#450 comment 6248184754), R1-R5. R3's mechanism, chosen by the person: a new headless Claude session per review request.

- **Declaration.** `"claude-review": { "kind": "claude", "roles": ["reviewer"], "start_mode": "headless" }` declares a headless reviewer. `start_mode: "headless"` on a Claude instance is accepted only when the roles are exactly `["reviewer"]`; `worktree` stays refused. It resolves to a fixed builtin variant of the claude definition (hub-native transport, env MCP identity, a headless factory); the builtin `claude` keeps its terminal-only definition, and external definitions cannot declare a variant. A channel instance (I3, no `start_mode`) may still hold reviewer; it is started from a terminal and its verdicts are recorded as `continuing`.
- **Start.** `ahub claude --as <id>` asks the running hub to start the reviewer (the console and dashboard Start do the same); it takes no launch arguments, runs nothing in that terminal, and `ahub stop <id>` stops it. It holds no process while idle.
- **R3, one session per verdict.** For each `review` envelope the peer runs one `claude -p` child (own process group, watchdog, `peerChildEnv(<id>)`) with: `--output-format stream-json --verbose --no-session-persistence --session-id <new uuid> --strict-mcp-config --mcp-config <agent-hub tools-mode server for <id>> --setting-sources "" --tools Read,Grep,Glob --allowedTools mcp__agent-hub__hub_review mcp__agent-hub__hub_task_show Read Grep Glob --permission-mode dontAsk`, prompt on stdin. It never passes `--resume` or `--continue`, so no session sees an earlier round. No user or project settings, hooks or plugins load. A delta review also runs fresh (R3 allows continuing; not needed). The child's final text is not published; the verdict is the `hub_review` call.
- **R2, review-only delivery.** A declared instance whose effective roles are exactly `["reviewer"]` (headless or channel) receives only hub `review` envelopes, hub `task` envelopes addressed to it and the person's own messages. Every other item (agent chat, digests, presence, budget, `[FYI]`) is discarded and journaled with that reason; an agent that addressed it directly is told why. A headless reviewer starts a session only for a review request; anything else it receives settles without one. The headless reviewer's prompt is built by the hub from facts, not from the envelope text: the task title and detail, the linked spec issue, refs (branch, head commit), check results, the earlier `changes_requested` notes and unmet items, and a diff of the head bounded in size (ponytail: a cap, the reviewer reads files with Read/Grep/Glob for the rest). The implementer's done summary is builder narrative and is left out.
- **R4, recorded context.** `hub_review` writes `reviewContext` on its history entry, set by the hub: `fresh` when the verdict comes from a headless reviewer's child started for that task's review, `continuing` from any other peer, absent from the person.
- **R1/R5, routing.** `assign()` prefers a dedicated reviewer (holds `reviewer`, not `planner`) among the eligible peers, busy or not; family independence and the PII rule (the person reviews) are unchanged. When a dedicated reviewer is declared but not eligible (offline, not started, paused) the planner reviews as before and the assignment note says `reviewer=planner (fallback)`. With no dedicated reviewer declared nothing changes. The reviewer is chosen at assignment, as before (ponytail: a task assigned during a fallback keeps the planner; re-pick at done if that matters).
- **Budget.** The reviewer shares the `claude` account and its pauses; usage from each child's `result` event is added to the peer's tokens. No quota is classified from its text.
- **Privacy.** The diff lists changed paths first, with rename and copy detection, and leaves out every change touching a path that `local.deny` or `pii.paths` covers (a move or copy whole, when either side is private), noting only how many were withheld (ponytail: git's 50% similarity decides what counts as a move); a diff that matches a private-data pattern is withheld whole. Those entries are also passed to the child as Claude `Read` deny rules (Claude evaluates them, not the hub's path policy). A private review is never given to it.
- **Narrative on the read tool.** `hub_task_show` from a review-only instance keeps history notes on `approved` and `changes_requested` entries and the bounded planner-ruling exception below; the done summary and all other notes are dropped.

- **Planner-ruling exception (#835).** Review requests and review-only task views also carry `plan reviewed` notes after the current ownership boundary, the latest `accepted` or `claimed` event (none without either). The author must be the current effective `taskPlanner(task)`, including its legacy role-holder fallback, and still hold the planner role. Keep the oldest five rulings, screen and sanitize each full note before cutting its displayed text to 1000 characters, and retain the withheld marker. PII tasks show none. Each ruling names its author and timestamp; these rulings inform the reviewer and amend review context only. They do not accept a plan departure: departure acceptance stays the person's and `accepted: false` remains unchanged.
- **Verdict authority.** A headless reviewer's `hub_review` is accepted only while the child that started for that task still runs (a per-child token, so a replacement child for the same task is a new authority). It is captured when the call starts and rechecked before every write, after each await. The leader's exit, a watchdog or a stop revokes it first. A review ends only when the child's whole process group is confirmed gone; survivors hold the delivery as `needs_review` and keep the peer busy with its handle: a stop fails and leaves it busy (never offline), and a start is refused, until they exit.
- **Settlement.** A start failure before any review in a delivery ran is `failed_safe`; after one ran, the delivery is held as `needs_review`. A failing facts or verdict-check callback is logged, and the review counts as without a recorded verdict.
- **Never an owner.** The reviewer variant carries `routing.reviewOnly`; assignment refuses it as an owner for every task class and when named.

## Reviewer pool amendment (#519, hub task #229)

Historical planner ruling, 2026-10-19 (#229 scope; Kimi follow-up and agy scope superseded by the person ruling below): #229 implements R3-R6 for Claude and Codex; admission is receipt-gated. Only proved reviewer profiles ship as runnable variants. The existing #223 Claude variant is retained; Codex is restricted to its verified 0.146.0 profile and a passing runtime receipt. Kimi and agy remain unavailable with metadata reasons and outside the default pool; #229 adds no launch code for either. Kimi launch and task-bound MCP work continues in #533 (hub task #234). The person reassigned agy to the implementer peer work in #485; its retained reviewer slot is unavailable with reason `agy is an implementer peer (#485)`. The [isolation evidence report](../verification/2026-10-19-reviewer-isolation.md) records primary sources, offline probes and untested native legs. Source integration and model-free admission are verified; final-head verification remains the required PR gate.

- **Pool and routing.** Planner ruling 2026-10-19 (#234 M5/M6) supersedes the earlier fixed configured-slot denominator. The default logical kind order is Claude, Codex, Kimi. Modulo uses only configured kinds with at least one declared reviewer candidate, including blocked/offline/paused/quota/failing candidates; availability does not renumber these declared kind slots. Configured undeclared kinds are appended as `no declared reviewer` trace entries after the declared-candidate walk and do not bias the seed denominator. `review.pool` accepts registered reviewer kinds (Claude, Codex, Kimi and the retained unavailable agy slot); agy is excluded from runnable reviewer candidates with reason `agy is an implementer peer (#485)`; local/Pi are refused. An explicit pool with no declared candidates blocks for the person. An omitted pool with no fresh reviewer declaration retains legacy routing. With an omitted pool, exhaustion retains the #223 R5 eligible-planner fallback, preserving the exhausted pool walk and reason in trace/history; absent an eligible planner, the person reviews with a blocked result. This applies also to unavailable-only declarations outside the default pool. An explicit required pool remains blocked for the person on exhaustion; explicit nominations cannot bypass backend unavailability. Unavailable never means pass. Pure `assign()` starts at PR number modulo the declared kind-slot count when linked, otherwise task id modulo that count, walks unavailable/paused/quota/failing candidates and skips the implementer's family while another can run. Delta review keeps the preceding reviewing family by default when it remains eligible and independent, with configurable re-rotation. Family independence still takes precedence over continuity after an earlier same-family fallback. A start failure or any child ending without a saved verdict walks the remaining candidates for that review; no quota category is inferred from vendor text. Explicit named reviewer choices remain outside automatic pool replacement; a failed pinned review stays held for the person. Board transitions still go through Tasks. A same-family fallback uses a different fresh child and is recorded. Exhaustion records `blocked: no reviewer can run` and leaves planner/person review available; it never auto-approves.
- **Variants and authority.** Fresh variants require a declared headless instance with roles exactly `["reviewer"]`. Codex and Kimi additionally require `review_mode: "fresh"`; without that opt-in, existing headless reviewer-role instances retain their native app-server/ACP transport, worktree and permission semantics and do not join the fresh pool. Claude retains #223 automatic selection for its headless reviewer-only declaration; agy remains an unavailable metadata-only reviewer declaration with reason `agy is an implementer peer (#485)`, and #533 adds no agy reviewer launch contract. An unsupported fresh backend refuses without falling back to a native continuing session. Ordinary implementer instances retain their native adapters. The common lifecycle starts a fresh child per review, never resumes, filters builder narrative/shared memory, retains private-diff/read/verdict fences and permits only `hub_review` and `hub_task_show` from the hub. Process-group cleanup and the per-child verdict token retain #223 semantics. A missing receipt refuses before a model starts.
- **Codex receipt.** The producer resolves a host executable outside the project and binds its native binary hash and config metadata. It checks the exact supported version, performs bounded model-free MCP inventory/readback, disables ambient stdio/HTTP servers with self-contained stubs and verifies the fixed hub's two-tool allowlist. Plugins, hooks and Apps are disabled and the physical project is untrusted. Because `mcp list` omits runtime ChatGPT Apps contributions, a separate bounded `features list` readback must prove Apps disabled; inventory alone is not a strict-MCP receipt. The policy requests disabled web search and is passed to exec. There is no effective-turn web-search readback; managed requirements can override this request to Cached at the pin, as recorded in the verification ceiling. A named filesystem profile is read-only with portable core deny rules, explicit private-path/subtree rules, standard host credential directories/files (including configured XDG/tool-home overrides, deepest-existing-ancestor canonical paths for absent descendants and existing real-path aliases), the hub state directory and network disabled; a native temp-fixture proof, including synthetic gh/kube/docker credential reads, precedes the ephemeral exec launch. These standard credential denies supplement the portable core and project policy; they do not classify arbitrary personal files elsewhere on the host. The binary is hashed once during preparation, with dev/ino/size/mtime/ctime rechecked before spawn along with config metadata. PATH Codex 0.163.0 is unsupported, not an inferred pass. No credential copy or blanket approval bypass is added.
- **Read-only meaning.** Codex retains sandboxed shell under that filesystem/network policy; it does not have Claude's Read/Grep/Glob-only whitelist. The offline fixture measured filesystem denial, not a model turn or network-denial result. No recorded run shows exec selecting `ahub-review` through `default_permissions`; the configured exec argument and explicit-profile sandbox proof remain separate evidence. Post-check same-user mutation remains a documented ceiling. Kimi plan mode alone is not an isolation receipt.
- **Registry contract.** The #229 data-only agy declaration is separate from the native runtime catalog and does not extend the legacy supported-peer or optional-peer lists. Their existing pinned expectations and the empty registry-guard baseline stay intact. Only declared unavailable reviewer instances can name that metadata, with reason `agy is an implementer peer (#485)`; it adds no agy reviewer adapter or launcher. Native implementer work belongs to #485.
- **Selector contract regression amendment (#234 M5).** `test/reviewer-pool.test.ts` intentionally changes the three old undeclared-slot expectations: mixed declared/undeclared seed selection, the missing-kind denominator case, and missing-kind trace-before-selection. New seeds 0..5 with Claude/Codex declared and Kimi undeclared require three selections per actual kind; a blocked declared Codex retains its slot. Availability, family-independence, continuity, exhaustion and registry guards are not loosened.
- **Recovery compatibility.** A configured pool or declared fresh reviewer requires target feature `reviewer_pool`; an older target cannot drop `review_mode: "fresh"` or silently restore it under ordinary adapter policy.
- **History compatibility.** Keep `reviewContext` as its existing `fresh`/`continuing` string. Add host-recorded `reviewerFamily` and `reviewerReason` fields for rotation, implementer skip, unavailable skip and same-family fallback. `ahub route explain` renders the same pure routing walk; agent prose never supplies routing authority or a passing receipt.

## Kimi reviewer and task-bound MCP amendment (#533, hub task #234)

Person ruling, 2026-10-19 (8281ec35), supersedes the earlier agy reviewer implementation, global-admission, project-permission and live-check rulings: #234 includes only Kimi and task-bound MCP. Agy becomes an implementer peer under #485; its retained reviewer slot is unavailable with exact reason `agy is an implementer peer (#485)`, including explicit pool requests. No agy reviewer code, admission, personal configuration write or live leg is authorized by #234. Earlier agy OAuth/listener, permission and meta-tool findings remain historical evidence in the [R0 report](../verification/2026-10-19-kimi-agy-reviewer-isolation.md), not an active reviewer contract. Kimi retains the native permission/shared-account contract below, superseding its earlier R0-only hold and kernel-isolation prerequisites. Kimi 2.2.0 is runnable when runtime `prepare` passes; an unsupported version or failed preparation remains unavailable with its refusal reason. The default logical pool is Claude, Codex, Kimi with declared-kind modulo as specified above; agy stays outside it. Completed account-free and authenticated fresh-verdict receipts are distinguished from actual interactive-TUI and usage-observation ceilings in the R0/live report, including the original complete-collector aggregate failure and its later account-free observer reproduction. Availability is not inferred from version metadata alone.

- **Common authority and evidence.** Each review uses a fresh child and a host in-process, revocable, task/head/review-revision-bound two-tool MCP capability. The child receives only `hub_review` and `hub_task_show`, never the full hub control token. The reviewer obtains source evidence through the screened `hub_task_show` review brief and host facts, with no native Read/file/shell tool. Builder narrative/shared memory filtering, private-review refusal, current-child/generation/head checks, verdict authority, cleanup-before-settlement, same-family exclusion/fallback and existing approval gates remain in force. Native permissions replace the earlier kernel boundary for Kimi; this is not a claim of filesystem or network isolation from same-user native code.
- **Kimi 2.2.0.** No Seatbelt wrapper. A private `KIMI_CODE_HOME` is initialized with host-produced managed-provider configuration and MCP/profile data; its `credentials/` and `oauth/` are directory symlinks to the person's native locations, and `device_id` points to the person's native device identity. Directory links preserve native atomic credential rename and the same `proper-lockfile` refresh lock as the attached TUI; no token extraction, snapshot copy or static-API-key provider is introduced. Native OAuth owns refresh on the shared account. `KIMI_DISABLE_OAUTH_LOCK` is never set. The child uses a clean temporary cwd, an explicit empty skills directory and an agent tools list exactly `mcp__agent-hub__hub_review` and `mcp__agent-hub__hub_task_show`, without native read/subagent tools. It never edits the real project's `.kimi-code/mcp.json`. Shutdown revokes verdict authority first and allows bounded TERM grace during OAuth lock ownership before verified process-group teardown. The person accepts that interruption during refresh may require re-login; it cannot become a verdict or a hidden auth repair. Kimi quota remains the existing shared account, not a separate reviewer allowance.
- **Residuals and verification.** This is a native tool-authority boundary, not a kernel read-only or universal private-home guarantee. Completed account-free native OAuth-race and two-tool disclosure checks and authenticated fresh-verdict/host-MCP observations retain their individual receipts and limits. Actual attached interactive-TUI refresh/lock coexistence and usage-source coverage remain unverified. End-state project/config parity does not prove write-then-restore absence or every native model schema, and the failed original complete-collector aggregate is not relabelled a full pass. The [R0 report](../verification/2026-10-19-kimi-agy-reviewer-isolation.md) preserves historical findings and their limits; [Kimi smoke legs](../smoke.md#kimi-reviewer-and-task-bound-mcp-533) track the active checks without counting earlier probes as passes. Agy's historical meta-tool/resource and broad-global permission findings do not become Kimi evidence or an agy reviewer acceptance criterion.

Kimi 2.2.0 print stream-json does not expose token counts. Shared account quota/manual pauses still apply through the registry budget account and fan out to the TUI/reviewer instances; print output is not counted as zero usage or parsed into invented token measurements. The optional soft-token ledger can only include actual readings from other supported account sources. This is an observation ceiling, not a separate account or quota bypass.


## Review brief amendment (#520, hub task #228)

ahub builds the review brief that the workspace gate used to take from `ocr delegate preview` and `rule`, and gives the same brief to every reviewer.

- **Range.** The task's commit (`refs.commit`, resolved to its full SHA) against its merge base with the remote default branch (`origin/HEAD`, else `origin/main`, else `origin/master`). There is no fallback to the checkout's `HEAD`, which may be the head itself or another session's branch: without a default branch, or when the commit has no changes against it, the brief is unavailable. Any failed git read makes it unavailable too, never partial. the Git inventory is bounded (500 files, 8 rule files of at most 32 KB each); the brief never touches the board.
- **Files.** Each change comes with its status and line counts; a rename or copy lists both sides. A change touching a `local.deny` or `pii.paths` path, or a path that fails the private-data screen, is withheld whole (both sides of a move) and only counted. Excluded only when every side of a change is (a move keeps its source's obligation), with the reason, status and both sides shown: files marked `linguist-generated` in `.gitattributes`, lockfiles (a fixed list) and binary files. They are listed so a reviewer can still read them. Unlike `ocr delegate preview`, markdown and test files stay reviewable: the workspace gate required reading them anyway, and coverage now records it. Compared on PR #506 (head e305a17e against 3f258a41), OCR excluded 3 markdown and 3 test files and kept the generated bundle; ahub keeps those 6 and excludes the bundle once the `.gitattributes` this PR adds is on the default branch.
- **Rules.** `REVIEW.md` applies to every reviewable file. A path whose `.gitattributes` entry sets `ahub-review-rules=<repository path>` also gets that file, and a move gets the rule files of both sides. Files are grouped by the rule files that apply. Attributes and rule files are read at the merge base, not the head, and every diff the brief runs uses `git --attr-source=<merge base>`, so a checkout at the head cannot reclassify files either (for example `* -diff` making them binary): a change cannot lift its own review obligations (marking everything generated, weakening `REVIEW.md`); its own edits apply from the next change after it merges. A rule file's name and whole body pass the private-data screen before any cut; a file that fails is named but not shown. A configured rule file the brief cannot load (missing at the merge base, or beyond the 8-file cap) is listed with the reason; a private or non-nameable rule path is left out unnamed. Deviation from the issue: per-path settings are git attributes, versioned with the change, instead of new `review.exclude` and `review.rules` config keys.
- **Cross-check.** The plain `--name-only --no-renames` list of the same range is compared with the brief. A path it shows that the brief does not list is named for a direct read.
- **Contract.** The review request already carries the spec issue reference, the task plan and the detail. The brief does not fetch the issue body: the hub reads issue metadata only (S1), so the acceptance checklist stays in the issue.
- **Delivery.** `sendReview` appends the rendered brief to the review request (after #215's admission, body only). `hub_task_show` adds a `brief` field while the task is `in_review`. `ahub review brief <id>` prints it for a person. A task without a commit, or a private task, has no brief.
- **Coverage gate.** `hub_review` takes `coverage: { reviewed: [paths], skipped: [{ path, reason }] }`. An approval must account for every reviewable path. The gate follows the lifecycle mode (deviation from the issue, which refuses always): `enforce` refuses before any write, naming the paths, and also refuses when the brief is unavailable (an unknown inventory is never an empty one); `advise` records `Coverage gap (N): ...` or `Coverage unknown: ...` in the verdict note; `off` and a person's own verdict skip it. The commit under review is the task's commit, else the head the verdict names, else the head its lifecycle receipt records. Code work (a task with a commit, branch or PR) for which none of these is known, or whose brief cannot be built, has an unavailable brief. Work with no commit, branch or PR is exempt, with nothing to account for. So is a `Tasks` built without a brief provider (library use and tests; the daemon always provides one). One head throughout: the head the verdict names, or the `reviewedHead` it would inherit from an earlier review, must equal the brief's head (with a PR, the lifecycle approval gate already binds the reviewed head to the PR head). The task's commit and its lifecycle receipt (which holds the inherited `reviewedHead`) are pinned when coverage is checked and rechecked before every write after an await, so a commit or receipt that moves during the verdict is refused.


### Optional changed symbols (#682, #684 phase 1a)

`src/hub/code-facts.ts` is the sole runtime caller of optional ripwire. The initial verified CLI contract is 0.6.7: strict `ripwire.pr-context/v1` and `ripwire.at/v1` XML (these verbs do not support JSON), and validated callers/callees JSON keys. Unknown versions, schemas, malformed/capped output, tool failures and timeouts give `unknown`, never a passing gate. The rendered advice has a 16000-byte ceiling (oversize is unknown). Parse metadata values only; discard raw text, owners, author email and source fragments. Calls have a 5 s execution deadline and an owned-process cleanup bound; cache successful values by canonical repo, SHA and query (including the base for a diff). A busy reader gives new distinct queries unknown instead of making review wait in a queue. Name-only graph edges are marked ambiguous and hidden; graph count floors are retained.

The reader always creates a temporary detached worktree with no checkout, populates its index and materializes bounded raw regular-file Git blobs. It never runs ripwire in main or reuses a tracked-clean owner tree: untracked/ignored analysis inputs would contaminate SHA evidence. Disable native Git filters, hooks, external diff and fsmonitor too. The ceiling is 4096 regular files, 4 MiB/file and 32 MiB total; symlink/gitlink trees or unavailable cleanup stay unknown. Temporary worktree removal follows owned CLI teardown. No heavy-job slot or runtime dependency is added.

Prepare optional code facts asynchronously before the review request, under the existing task/head/owner/privacy admission fences. Failure never refuses the request. PII tasks perform no query; other tasks' names and paths pass `publicMetadataText` at display time. The synchronous file/rule brief and its coverage gate remain authoritative and unchanged.

**0.6.7 ceiling and amended acceptance:** `--pr-context` reports head symbols and omits deleted definitions; it has no stable both-tree identity or new/modified/removed marker. Show per-file observed name, kind and span with `change: "unknown"`. Label plan lists `changed and planned`, `changed, not planned`, and `planned, not seen as changed`, and state that ripwire 0.6.7 does not report deleted symbols. These are advisory observations, never evidence that a plan is satisfied or untouched. The upgrade is a ripwire both-tree inventory, or bounded base/head `--at` probes if real use shows that the advice is too noisy (person/planner ruling, 2026-10-22).

### Task/head symbol observations (#684 phase 2a)

The data slice may follow phase 1a independently of phase 1b's plan-name normalization. It stores one current, explicitly head-bound `codeSymbols` receipt per task, rather than a code index or historical source inventory. The receipt carries the full head and merge-base SHAs, an internal repository place key, known/unknown and observed-completeness flags, and at most 500 `{id,path,name,kind}` entries (64 KiB total; each string at most 512 bytes). IDs use `symbol:<name>@<path>`. The separate `task_code_symbols` table prevents an older daemon's `SELECT * FROM tasks` from exposing an unrecognized payload on recovery; the task update and payload write share one transaction. No spans, raw output, source fragments, plan text or model input are stored. The native 0.6.7 deleted-definition/count-floor ceiling above still applies: `complete` certifies that the observed envelope survived screening, never that every changed definition was found.

`Tasks` obtains the already prepared brief at an admitted `done` or `done (checking)` write and saves metadata in that same Board update, with a flow-revision fence. Optional preparation is bounded and fenced in every lifecycle mode, including completion without a reviewer; preparation-only adds no remote review gate. Refusals save no metadata. A failed or unavailable observation never reuses another head's data. A head, repository-ref/path change or PII transition drops the old receipt; PII tasks store nothing. The current brief analyzes a validated project execution root, so a foreign task repository remains unknown until independent repository provenance is carried by the brief.

Console task detail and the UI task snapshot carry the same public metadata. Every public read binds the current head and repository and re-screens IDs, paths, names and kinds through `publicMetadataText`; internal repository keys are omitted. Filtering marks the observed envelope incomplete. Status and rendering remain read-only. The formatted Code group and symbol-to-memory navigation are a later phase 2 presentation slice.

Completed-change notices and the console task detail (#379 follow-up) may say `same file, different symbols`: both tasks must have current, public, known and complete observed envelopes, and each exact shared path must have non-empty symbol sets with no intersection. Unknown, stale, filtered, ambiguous or empty evidence retains the ordinary notice. The wording explicitly says observed names only and that deleted definitions may be missing, and still asks the recipient to check the completed work. No notice is suppressed, no authority or coverage gate changes, and plan-time overlap/routing remain unchanged.

The read-only `task_show` reply also carries `symbolOverlaps: [{task,files,sameFileDifferentSymbols}]` (#379). It uses the existing open-task/other-owner overlap selection and the same `taskCodeSymbolsDisjoint` predicate with the current `publicMetadataText` screen as completion notices. Both sides exclude tasks marked `pii` or `pii_path`, even when routing locality is disabled; shared paths are screened before display. Unknown, incomplete, stale or filtered observations keep a plain overlap, never a different-symbol claim. No pair result is stored and no task mutation occurs on a read.

The console consumes this server verdict without computing a second rule from plans or receipts. Task detail replaces the raw pair field with an `overlaps` block beside its symbols block and the ceiling `observed names only, deleted definitions may be missing`. A missing field on an older hub shows no block; an empty server list says `none`; a private or non-task detail shows no block. Task IDs and shared paths use the existing quoted field renderer. At most 40 pairs and 40 paths per pair are listed, with omitted counts. Related-note counts remain phase 4.

## Claude peer instances I3 amendment (#450)

- Superseded by A2b `instances.mode` and explicit role policy (MCP shape grants no instance admission): a declared instance of a channel-plugin kind (Claude) was admitted when its declaration names `roles`, reviewer and/or planner only. `start_mode` and `worktree` are refused: the instance starts only from the person's terminal with `ahub claude --as <id>`, so the hub never starts, watches or owns writes for it, and it is neither startable nor reserved from external admission.
- The launcher sets the child's `AGENTHUB_PEER_ID` to the instance id; the channel plugin and the statusline tee already key on it. Launch, session and context state files stay `claude-launch.json`, `claude-session.json` and `claude-context.json` for the builtin and become `<base>.<id>.json` for an instance (`src/hub/claude-state.ts`). Account usage stays shared. The daemon's context and usage readers, the permission-launch check, the facts handler, terminal recovery (project root, no worktree), the upgrade blocker check and `ahub reset` read each instance's own files.
- The Claude version probe stays on the builtin peer (ponytail: instances are reviewers started by hand); zero-turn detection reads each peer's own evidence, as below.
- Status, which the console and dashboard read, lists each declared instance right after its kind. `ahub <kind> --as <id>` starts only an instance the running daemon bound at startup (status `activeInstances`); otherwise it asks for a restart or an upgrade before any effect.
- Each Claude peer reads only its own `terminal-recovery.json` row. Transcript evidence comes from the path that peer's status line reported; an instance without one counts as persisted, because the hub cannot see its `CLAUDE_CONFIG_DIR`. Upgrade runs plugin setup once per distinct Claude profile, under that profile.

## Headless peer instances I2 amendment (#450)

`instances` is a person-authored, machine-local object in an untracked
`.agenthub/config.local.json`. Each additional `<kind>-<name>` id names its kind
explicitly and may set `roles`, `start_mode`, `permission_mode` and `worktree`.
The bound catalog belongs to one project/daemon; there is no process-global
registration or suffix inference. Declarations are validated before trust
filtering, cloned and frozen, and limited to 64 additional ids of at most 32
ASCII characters. Settings cannot create or modify declarations. Identity,
execution directory and account membership are restart-bound; a live reload
cannot publish their derived defaults ahead of that restart.

I2 accepts definitions with a native headless factory and environment or ACP
session MCP identity. Additional Claude/channel peers belong to I3. Jcode's
project-file MCP identity was not isolated by this phase and was refused for extra
instances; #685 lifts that, see "Extra Jcode instances" below. Additional instances start headlessly; the existing Codex native TUI
still initializes and attaches to its instance's own app-server proxy. The hub
never initializes that app-server on the TUI's behalf. `ahub <kind> --as <id>`
selects the declared identity; selection is removed from native passthrough.
Missing `peer_instances` evidence on an old daemon/upgrade target is a refusal
before instance runtime effects, rather than a guess that the instance is a base
peer, but only while a declared instance is live or unreadable: a source whose
status shows every declared id offline proceeds, because there is no extra
identity left to reinterpret. The refusal asks the person to end extra native
sessions and, only when an extra session cannot be ended, to remove the
declarations temporarily. A roster key left behind by an undeclared instance
loads as inert and `ahub roster remove <id>` deletes it; any other unknown key
is still an unsupported peer.

Each additional implementer requires an explicit registered Git worktree at
`<project>/.worktrees/<id>` with an attached branch. I2 creates no worktree or
branch; I4 owns automatic worktree orchestration. A supplied reviewer worktree
is checked by the same real-path, repository and registration boundary. Without
a supplied directory, a reviewer may share the project checkout. The native
process executes in that directory while its MCP environment retains the
canonical project's hub binding. Launch/restore receipts keep canonical
`projectRoot`, optional extra-instance `executionCwd` and observed `terminalRoot`
separate. The terminal grouping root may be only that project root or the
verified execution directory; exact live launcher, handle, incarnation and
worktree evidence is still required. Native kind metadata alone never binds an
extra instance. Revoked declarations or changed directories refuse reuse.
Effective roles resolve from declaration roles, exact-id policy roles, kind policy
roles, then definition defaults; launch validation uses the same order.

Terminal ownership (#482): an authenticated start response supplies an extra
Codex launcher's execution-root binding, but is not native ownership proof.
Every managed terminal launch first captures an Orca candidate without changing
the recovery ledger. A daemon advertising `terminal_owner` admits at most 64 live
or unknown candidates through the console-only `terminal_launch` request. It
publishes only after the current native owner is bound: the adopted Codex link's
launch nonce, the attached Claude channel's launch id, or Pi's verified owner
process descending from that launcher. Orca root, handle, incarnation, worktree,
launcher signature and current native generation are checked before publication;
a failed second launch preserves the incumbent row. Claude's hook record remains
pre-spawn and does not wait for this terminal proof. The coordinator retains
durable pending creation and attachment-wait evidence until ownership is proven;
no pre-start candidate is restoration evidence.

Background Orca queries have a 30-second deadline and 1 MiB output ceiling. Their
owned process groups are cancelled and awaited on shutdown before reconciliation
settles. A cleanup failure is logged without preventing other peer teardown or
daemon finalization; native TUI foreground execution is unchanged.

Without the advertised feature a current launcher runs unrecorded and names the
upgrade remedy. Attached native TUIs without a live launcher or independent exact
Orca session proof are shown as `attached, launcher unrecorded`, with person end
or native resume guidance, never a fresh headless restart. Plain same-protocol
Claude keeps its unmanaged reconnect-only path. An orphaned but connected pane
requires the person to run `orca terminal switch --terminal <handle>` and refresh;
it does not authorize another restore. Historical rows are retained, including
invalid rows; current ownership is scoped to project, instance and peer, and a
publication replaces only that scope's valid row. This current-source guarantee
does not fence older binaries that directly rewrite the shared ledger.

Past-commit resumes do not repeat pre-commit instance
compatibility checks. Abort and stop-and-archive validate historical receipt structure
and authenticated runtime ownership independently of mutable declarations; restore,
fresh and reattach retain current declaration authority.

Routing expands a kind preference to its declared members and considers idle
state, board WIP and queued load with stable ties. Exact manual candidates,
reservations and nominations stay exact ids. Assignment and explain use the same
pure decision and name the chosen instance. Reviewer independence compares
families (the kind); an eligible other family takes precedence even when busy.
Only when no other family is eligible may an assignment use its own family,
recording `sameFamilyFallback=true` in assignment history. This independence rule
also applies to an explicit same-family reviewer nomination. `review.same_family = "never"` (#820, default `"fallback"`) removes that last resort in the pool and the legacy path: the planner reviews when it holds the reviewer role, is not the owner, is of another family and is not blocked, else the person, and a same-family nomination is refused with `same family as <owner>; review.same_family is never`. A declared owner of
implement, bulk-edit or test work requires the current implementer role and positive
host evidence tied to the actual adapter generation started in a verified noncanonical
worktree; a role-only reload cannot promote a canonical reviewer process. External
ids, including console recipients, retain their existing admission and explicit
nomination behavior without acquiring native metadata or automatic kind expansion.

Quota readings, pause records and reset windows are shared by the definition's
account (one account per kind in I2). Member telemetry retains its exact reporter
id, native context remains per instance, and the shared account's quota pause,
checkpoint, handoff and reset notice cover all its members. Existing manual
pauses remain in force. A startup migration conservatively merges old alias
pause rows, retaining their provenance and moves; no pause is discarded.
Per-instance ports, native session paths, Pi tool ledgers and model relay
callbacks do not borrow another instance's process or conversation.

Worktree facts and native turn snapshots use the validated execution checkout,
while task and turn ids remain in the canonical hub database. An additive
`turn_workspaces` receipt stores the exact extra-instance root and its snapshot
fields atomically with turn creation. The legacy `turns` snapshot fields remain
unknown for those rows, so an older CLI cannot restore their files into the
canonical checkout. New readers hydrate the same public turn shape from the
receipt. An absent receipt preserves historical external-peer undo behavior;
an existing receipt requires the current trusted declaration and the same
validated root before context changes or file restoration. Pruning a turn also
prunes its workspace receipt. Review projections resolve converter programs, task
paths and private-path policy in the execution checkout while their sandbox denies
other canonical project file data, including when read_allow encloses that project.
Overlap refusal remains conservative across
separate worktrees; it may refuse an undo rather than assume independence.

The I2 seed contract amendment re-anchors only `roster-r-pi-override`,
`roster-r-catalog`, `roster-result-stop-text`, `roster-detached-pi-recovery`,
`data-pi-factory-wire`, `projection-local-trust`,
`planning-reservation-supported` and `planner-reserved-status-row` to the
contextual resolver, aggregate Pi ledger, execution directory and declared-id
forms. Each keeps its id and named test and removes the same guarantee. The
projection mutant still removes only `text_projection`; the status mutant still
removes only reservations. The other 411 seeds and registry baseline are
unchanged. The PR records every old and new search/replacement and its clean
and mutant result, per the reviewer's explicit ruling.

## Amendment: roster membership in status, 2026-10-18 (#484)

- The authenticated `status` reply carries `roster: {peer, on}[]` for every supported peer, optional peers included, with the same `on` that `ahub roster list` shows. The field is additive, with no protocol bump; older CLIs ignore it.
- Launchers that check membership before starting (`ahub jcode`, `ahub kimi --mode tui`) read it through `rosterInStatus` in `src/hub/status-roster.ts` (no imports, so the registry's native CLI entries add no cycle). A reply without the field (an older hub) is unknown: the launcher stops with an upgrade-or-restart remedy and starts nothing. It never reads unknown as off (the jcode bug) or as on (the dead kimi guard; daemon admission still refused off-roster Kimi, so that one was harmless).
- `settings_get` stays console-only.
- With declared headless instances, status includes each startup-bound extra id as well as every built-in and optional peer, with its own roster membership. No undeclared suffix acquires a row.

## Amendment: planner plan review and board governance, 2026-10-18 (#481 S9)

- The person's mode-boundary ruling separates board governance from lifecycle enforcement. WIP-at-accept and planner/person return of accepted work without work evidence apply in every `sdlc.mode`; only the current plan-review receipt gate uses enforce/refuse, advise/report and off/no gate. Existing lifecycle schema aliases and ordinary off-mode receipts are unchanged.
- Tasks owns plan-review receipts, accepted-untouched returns and all offers/acceptances. Review evidence contains the planner, planning revision, recorded time and fixed-query GitHub issue metadata. An issue body or comments are never fetched or stored by this readback. A changed body edit time or planning revision invalidates the receipt, except the complete contiguous release-only revision history defined by S11; issue identity/edit and cost-scope checks still apply; missing evidence remains unknown. The synchronous acceptance API cannot bypass the fresh enforce readback.
- S1 person spec acceptance and S9 planner review remain independent. `acceptReviewed` reads both against one task snapshot before the acceptance write. A `done` that implicitly accepts proposed work checks WIP and both readbacks before any cohort or board write; the missing-spec refusal retains precedence over missing-plan admission. Off keeps its synchronous ungated acceptance path apart from the all-mode WIP rule.
- The accepted-untouched exception is a distinct, revision-bound return transition with a screened reason. It preserves history and planning fields, withdraws former role requests and enables replanning. Historical acceptance still protects cancellation and undo. Done/check/review/integration evidence or branch/commit/PR/local/review artifacts refuses this exception; it does not grant a general planner unassign permission.
- Grooming is an ids/codes-only read projection with repository-scoped comparisons, explicit unknown/truncated evidence and person-only actions rendered as commands. It does not infer a ruling from arbitrary task prose, fetch issue bodies, mutate dependencies or invoke a model. Limits are 500 task rows, 256 findings and eight metadata reads within four seconds; a future paginated repository resolver supplies exhaustive coverage.
- Existing seeds and the registry baseline remain byte-identical. Source guards retain the original ordinary backlog and dependency floors outside the explicit untouched-return branch. S10/S11 and the remaining lifecycle slices are not implemented here.

## Amendment: the daemon's plugin bundle in status, 2026-10-18 (#502)

- The authenticated `status` reply carries `pluginBundle`, the absolute path of the plugin bundle the running daemon serves and checks against. It is additive, with no protocol bump.
- `ahub jcode` and `ahub kimi --mode tui` write that path into their project MCP entries, read through `bundleInStatus` in `src/hub/status-roster.ts`, which accepts only an absolute path ending in `plugins/agent-hub/server.js`. Before this, they wrote the path of the CLI copy on PATH, which can be a different install than the daemon's (for example a global install against a retained release), so the daemon refused Jcode's entry as stale. A hub that reports no bundle gets the CLI's own copy, as before. Kimi's headless start removes the entry, so no path is involved.

## Amendment: spec acceptance, 2026-10-18 (#481 S1)

- `ahub sdlc accept <task> --issue <n> [--repo owner/repository]` is person-only (console-role `sdlc` op `accept`; agent shells and live tests are refused). The daemon reads `lastEditedAt` and `updatedAt` with a fixed GraphQL query and `Tasks.acceptSpec` stores `{repo, issue, lastEditedAt, updatedAt, acceptedAt}` as the receipt's `acceptance`; no issue body is fetched or stored. `hub_sdlc_record` refuses the field, and a receipt relinked to another repository or issue drops it.
- Build entry (an `implement` or `bulk_edit` task's acceptance, its `hub_task_done` without a separate accept, a self-claim, or a non-person stage change into a build base) in enforce needs a current acceptance. `Tasks.accept` refuses a missing one synchronously; the daemon awaits `Tasks.specGate` first, and `done` and `specStageGate` await the same reread, which refuses a changed body (`lastEditedAt` differs; comments move only `updatedAt`) or an unreadable one. A self-claim without an acceptance stays assigned to the claimant, still proposed, until the person accepts the spec and the claimant accepts the task. A task that changed during a readback (flow, link, acceptance, owner or privacy) is refused before any write. Advise notifies instead, stage changes included; off reads nothing. PII tasks never read the issue, so in enforce their accepted spec reads as unknown, like their PR evidence.
- Status shows `spec: {issue, state}` when the lifecycle is enabled and the receipt names an issue. It is not a readiness blocker, so existing approval and merge gates are unchanged.

### S9 redo admission clarification (#481, hub task #214)

An acceptance by the current owner since the latest ownership change retains its WIP slot for both in_progress updates and changes_requested redo, including re-accept and implicit done, in every mode. An unaccepted offer does not block that redo. Acceptance from a former ownership span gives no exemption. In enforce, changes_requested re-acceptance and done still re-read spec acceptance and plan-review freshness: an issue body edit requires renewed person acceptance and planner review before resubmission. This WIP exemption does not waive lifecycle review gates.

S9 privacy and notice ceilings: private build work with an issue ref remains inadmissible in enforce because its issue metadata cannot be read, with no metadata-free person override. Grooming pointers are coalesced per queued board revision but have no minimum delivery interval.

### S10 cost governance amendment (#481, hub task #215)

- Task plans carry explicit review scope (none/delta/full, bounded reviewer count) and CI scope (focused/full/reuse); S9 receipts copy the planner-selected values. None uses zero reviewers; other scopes use one to eight. Legacy scope is unspecified, readable and never guessed. Advise reports the gap; new enforce receipts require both scopes, while old scope-less receipts remain valid to their next non-release planning revision under the complete-history S11 exception. Omitted cost keys on an owner file-list update retain the reviewed scope; explicit prospective drift refuses enforce acceptance. Scope does not change reviewer authority or bypass CI; S2 owns actual conformance comparison.
- Review admission is separate from #520 brief/coverage. Before done/cohort writes, enforce requires the task's exact PR head, successful configured checks (native default: both OS checks and seeded guards), and no unanswered pending bot thread. Resolution settles a thread; an unresolved thread needs a user reply after the last bot comment. Only metadata is fetched. Advise reports gaps, including a generic unknown-readiness notice when a private turn finishes its own PII task without remote metadata; ordinary work remains refused during a private turn. Off adds no readback. Identity/privacy/owner and runtime authority are rechecked across awaits and each external read. Background role maintenance may retain a saved role while holding an unadmitted review envelope; a manual reviewer resend performs fresh admission.
- CI controllers are serialized per pull request (`check-pr-<number>`, `queue: single`: a newer pending run replaces the older pending one) and for main pushes and ordinary dispatches (`check-main`, `queue: max`; a macOS timing dispatch has its own `macos-timing` group), for the whole workflow and without cancelling an admitted controller (#609). A superseded PR head that is already running completes; this is a cost ceiling, not a proof gap. Two groups admitting one tree at the same instant can run it twice; the duplicate costs one run and never yields a false green. A visible active same-tree gate in any group still refuses admission. Required check names and read-only permissions are unchanged. Identical-tree successful full proof is reused for PR and push. Reuse expands both OS matrix names and reports the required seeded aggregate, using only a `Reuse verified identical-tree full gate` marker step with the original run id. These successful reporting jobs and skipped jobs are not fresh full proof; duplicate active full gates and unknown active coverage refuse admission. Pending controllers do not run gates. CI proof searches are bounded; missed older success can require a new gate, never invent green evidence.
- Cost reporting is read-only over bounded current public board links plus merged-PR/check metadata: review handoff rounds and elapsed time, CI run ids and extra attempts, full re-reviews versus deltas, and unknown scope. Private/relinked counterparts are excluded at each read and projection. Pure band-breach proposal data is delivered here; the S7 baseline/configuration/automatic board-card scheduler is deliberately not implemented in S10.
- The nonblocking policy ceilings deferred to hub task #230 are settled in the follow-up below.

### S10 policy ceilings follow-up (#481, hub task #230)

These rules are settled here and land with hub tasks #284-#286; until then the S10 behaviour above holds.

- CI admission separates lost proof from active-coverage uncertainty. If a commit or jobs read for one prior successful run is missing (404), times out on its own per-read limit or is malformed, that run is dropped as reuse proof; if the success list itself fails that way, all reuse proof is dropped. Admission then continues and can require a fresh full gate, never reuse. Any other read failure (5xx, 403, 429, the response size bound, authentication) stays unknown, and an exhausted read budget or overall deadline is unknown even when it surfaces as a per-read timeout. Unknown active coverage still refuses admission, as before: an unreadable, truncated or unidentifiable in-progress inventory, or an exhausted read budget or deadline. The release reader (`--require`) still refuses without a verified identical-tree proof. Degrading unknown active coverage to a fresh run is not adopted; it would need a person ruling against #609.
- Review-thread authors are classified only by `__typename`. A `User` comment answers. Every other author counts as a pending bot comment: `Bot`, a null or deleted author, `Organization`, `Mannequin`, `EnterpriseUserAccount` or any unlisted kind. An unresolved thread is therefore settled only by resolution or by a `User` comment after its last non-`User` comment. Invalid timestamps and truncated pages remain unavailable evidence. No comment body, login or other author field is read.
- In advise, a done or delayed-completion review-admission readback during which only quiet events (`QUIET_EVENTS`: answer, reviewer changed, idle sweep, memory reference started) were appended to the task is discarded, and the transition continues with a generic unknown-readiness notice and no further external read. A quiet `reviewer changed` entry, or a changed reviewer field, does not refuse in advise: the transition re-derives the reviewer from the current task before it sends the review. Any other drift still refuses in advise: another history event, a change of mode, owner, privacy or receipt, a revoked conductor authority, or a private turn on ordinary work. Each transition's final owner/state/check fences run before its writes. Enforce refuses any drift, unchanged. A manual reviewer assignment or retry keeps its own readback rules.
- A delayed check whose completion is refused tells the owner, privacy-screened, to call `hub_task_done` again, but only when the task is still `in_progress` and its owner is the one that started the check (the same condition as the late-result branch of `finishChecked`); otherwise the console notice alone is recorded.
- Fixtures pin each rule before its implementation lands (`test/ci-reuse.test.ts` for admission: a lost row then proof reuses, lost rows without proof run, active-scan failures and budget exhaustion stay unknown, the release refusal stays; `test/cost-governance.test.ts` for thread authors and advise readbacks). The dead `findVerifiedRun` reader is removed with the admission change.

### S11 release-train amendment (#481, hub task #216)

- The existing `release` task field and release planning table remain authoritative. Additive optional train metadata records enumerated hotfix cause/reason, frozen task ids, and bounded actor/time/resource history. Legacy rows omit it.
- "One open release" means one active/frozen train. Future planning rows are permitted as rollover destinations. A dedicated release-only assignment may move approved/in-flight tasks without modifying their execution state, owner, reservation, dependencies or person pins; every move needs a reason and current revision. Public reasons are screened; private scope moves are person-only and retain the reason solely in withheld board history without model screening. Public readiness/cut still refuses private scope. General backlog planning authority is unchanged.
- The planned date is a due trigger, not a waiver. A cut requires nonempty approved scope; unfinished/cancelled tasks move out with a reason before cut. It pins the complete scope and release revision through all awaits and the final transaction. Planner cut is a dedicated operation; legacy planner freeze refusal stays intact. Enabled or configured-train freezes cannot bypass the admitted cut API. Ship/drop remain person-only; a changed frozen scope blocks shipment.
- Cut admission holds a bounded five-second host-controller repository lease through the metadata freeze. The controller executable is host-resolved, its child command is fixed, and the shared gate lock is checked before and at freeze. Unknown admission or unknown/stale attached-peer account quota windows with a real quota source defer. A real source means the adapter definition supplies `budget.reader`, or it uses soft-token accounting with an enabled limit (Kimi: `kimi_tokens_5h > 0`); registered accounts without a configured source are reported as `no quota source` and do not defer for missing readings; unknown external accounts still require evidence. Budget-record and manual pauses still defer for every attached peer. Every later heavy step still needs its own admission.
- Hotfix causes are closed: data/message loss, security/privacy defect, blocked upgrade/start, core flow without workaround. Reason is bounded and screened. No hotfix waives a gate, grants publish authority or starts an upgrade.
- Actual cut/shipment event timestamps and frozen scope drive interval/approval lead-time metrics. Hotfix rate uses shipped releases. Bounded CI counts refer to planned-task PR metadata at cut, including attempts; review counts refer to board verdict history. Unavailable/legacy evidence remains unknown, and release-preparation PR costs require separate receipts. S7 owns bands/proposals; S6 owns authorization. The per-release "gates run" record is explicitly deferred to S6/S7; a cut record is not gate-execution evidence. No GitHub body, publish, merge or tag write is added.

- Person ruling 2026-10-19 supersedes the earlier planner ruling on S11 upgrade admission: upgrade is excluded from S11 host-admission, quota and additional all-idle gates. Recovery retains the pre-S11 `recoveryReady()` requirement (no busy peers, pending approvals resolved and completion checks settled), operation-identity checks and existing lifecycle fences. Quota/manual pauses, missing/shadowed `dot` and nested host admission add no S11 upgrade refusal. The person's existing recovery-operation selection remains the confirmation; no separate receipt or agent upgrade authority is added. Release-cut host/quota gates remain unchanged.

- Configured cut dates are positive safe UTC millisecond timestamps within the Date range; null, coercible values and invalid numbers refuse at the Tasks boundary before screening or board writes. The additive `release_trains` daemon feature is required of a recovery target while a configured train is active/frozen, before source holds/capture and again after awaits/before commit. Legacy and queued future release rows do not add this downgrade floor. Protocol 16 remains unchanged.

- Release-cut deferrals name their applicable exits: stop or resume paused peers, adjust the relevant `ahub budget set` setting, or drop the train with `ahub release drop`. Missing or shadowed `dot` requires installing the resource controller or fixing PATH; nested admission requires retrying the cut outside the outer admission lease. These host/quota gates do not apply to upgrade.

- S11 follow-up invariants: contiguous planning revisions changing exactly `["release"]` retain the S9 reviewed execution plan; other or missing planning history invalidates it. Cut-time CI cost reads are limited to the scoped PR ids (at most 16 in one repository); read errors or unbounded/mixed scope remain unknown and cannot abort a valid cut. Train history is capped at 256 events: configuration no-ops append nothing, meaningful configuration reserves cut/shipment slots, and capacity refusals are pre-effect.

### S7 metrics and control bands amendment (#481, hub task #200)

- `ahub sdlc metrics [--since]` and the planner tool `hub_sdlc_metrics` are a pure projection of board history (`src/hub/sdlc-metrics.ts`: no clock, no I/O, no model). `Tasks.sdlcMetrics` is the one read, for a planner or the person, refused during a private turn; private tasks are counted as withheld and read for nothing else. Anything the board cannot derive is `null`/`unknown` and counted, never 0.
- Scope cuts, each deliberate:
  - **PR readback is the merge's, not the report's (#442).** The report still reads only the board. The guarded merge reads the merged PR once, after it observes the merge, and records `cost: { mergedAt, ciRuns, ciReruns, reviews }` on the task's merge record (`readPrCostHistory` under an 8 s bound, host-written, never a tool input, never part of the merge decision). The report then reads those recorded figures, so it keeps the board as its only source and makes no GitHub call: a second reader of the same surface would duplicate `ahub sdlc costs`' bounds and privacy checks, which this does not. A task whose merge was not read stays `unknown`, never 0. The cut that remains: a PR merged by hand or before this record has no figures.
  - **S10's `costBandProposals` is not consumed.** It returns per-PR upper-limit breaches over complete merged-PR rows, a different data set (review rounds, CI runs and reruns per merged PR) from board-history metrics, and it takes absolute limits rather than a rolling baseline. S10 left the baseline, configuration and automatic card scheduler to S7 and delivered the pure breach data only; S7 builds the scheduler for its own metrics and leaves the PR cost metrics' bands for the slice that also reads PRs, so one configuration and one dedupe rule cover both.
  - **Security-scan baseline is an opt-in read of GitHub's own alerts (#442).** No scan source existed in the repository, and inventing a scanner would claim a control nothing enforces, so the hub runs none. `[security_scan]` (no default source) names which of Dependabot, secret scanning and code scanning to read; the daemon reads their open-alert counts on the configured interval, records counts only in `security_scans`, and `security_open_alerts` is a band over the totals, so a breach is the existing one-card-per-episode path. A source GitHub will not read makes the total unknown and unknown is not a point, never a zero. The cut that remains: no scan runs unless the person configures one, and a repository that exposes no alert source records nothing.
  - **Release metrics and the `hotfix_rate` band are built; the gates-run record is not (#442).** The release report shows release interval, lead time from final approval to release and hotfix rate from `releaseMetrics`, with unknown named and never 0, and `hotfix_rate` is a band with one point per shipped release that has recorded train history (a legacy release is left out, never a 0). The per-release gates-run record stays S11's explicit deferral: a cut record is not gate-execution evidence, and recording gates needs the S6 authorization path.
  - **`first_pass_check` is the hub's completion check, not PR CI.** It reads `check passed` and `check failed` at `hub_task_done`, so it is `unknown` wherever completion checks are off (the default). The issue's "first-pass CI success" is the PR-based figure and is not available without the readback above.
  - **Stale-head re-reviews need head evidence.** A review round is stale when its verdict is bound to a different head than its request (`reviewCost.head` on the done against `reviewFindings.head` on the verdict). A task without both is `unknown`. A `done` after an `approved` is not a signal: the board's move table has no way out of `approved`.
- Control bands are optional `[bands.<metric>]` tables of `sdlc.toml`, validated by `bandsConfig` with field-level paths. The newest value is compared with the mean and population standard deviation of the preceding `window` values, on the bad side only, with a per-metric deviation floor, a `min_samples` floor, a `min_delta` floor that every tier including the drift rule honours, and a drift rule (`drift_run` newest values all over one deviation on the bad side is at least `diagnose`).
- Rework rounds and stale-head re-reviews are final only when a task is approved, so a task still in flight is `unknown` for both and a series places them at the approval. Otherwise a provisional value would move at each verdict and could start a second episode inside one shift after its card was closed. Residual ceiling: the verdict head prefers the lifecycle receipt's `head` or `localHead` over `refs.commit` (`findingHead`) while the request head is `reviewCost.head`, so a task whose receipt head and commit disagree can read one spurious stale round; one shared head rule for both sides is the upgrade.
- A breach is an episode: the run of non-ok values for one metric. `BandResult.episode` is the task that started the run, derived from history alone, so a restart finds the same key. `Tasks.proposeFromBands` is the only writer. `log` is one hub notice, recorded in the board's `band_notices` table so it is announced once. `diagnose` is one read-only `triage` backlog task and `propose` one `plan` backlog card, keyed `<metric>:#<episode>:<tier>` in the card. A metric with an open band card writes nothing more, so a value growing from diagnose to propose inside one episode adds no second card, and a sustained shift is one card. Card text is fixed words, numbers and task ids, screened like the recurring-finding card; the hub opens no GitHub issue.
- The daemon evaluates every five minutes, only when the board's status revision or the band configuration moved since the last evaluation that ran, and not while it is stopping, in recovery or has a storage error (the same holds as the task sweep). A pass that was held, in mode off or without bands consumes nothing, so a breach seen then is written when the hold clears and bands enabled by a reload on an idle board are evaluated at the next tick. A failed evaluation is one `hub.log` line. Ceiling: one evaluation reads every task with its history; a history window is the upgrade if a board passes several thousand tasks.
- Bands write cards only in `advise` or `enforce`; in `off` the writer is idle while the report still shows each configured band's tier.
- Two bands are not made of tasks (#442): `hotfix_rate` (a point per shipped release) and `security_open_alerts` (a point per recorded scan). `BandResult.subject` says what `lastTask` and `episode` number (`release` or `scan`), the card text names that subject (`release #N`, `security scan #N`) and the key format `<metric>:#<id>:<tier>`, the open-card rule and the episode derivation are unchanged. The band signature that gates the five-minute evaluation includes the shipped-release count and the newest scan id, since neither moves the task board's revision.

### S5 eval gate amendment (#481, hub task #201)

- Scope: the gate mechanism only. The eval suite and its smoke subset (#266, #251) do not exist, and choosing one is a person decision, so the hub chooses, creates and defaults to none: `eval_check` has no default and an unconfigured gate reports `eval check not configured: ... (suite choice pending the person)` as a note in advise and enforce, never a silent pass and never a blocker, so an enforce setup gains no refusal until the person names a suite.
- `config_paths` (default AGENTS.md, `docs/agent-notes/**`, `templates/**`, `.agenthub/roles/**`, routing.toml and `src/hub/hub-tools.ts`) marks a configuration PR from complete PR file metadata (`src/hub/eval-gate.ts`). An incomplete inventory is unknown, never a code-only PR. A code-only PR is unaffected and off keeps its output byte for byte.
- The configured `eval_check` joins the required checks wherever they are judged (`sdlcStatus`, the queue and `decideMerge`, each reading). The pass rate and suite version come from one exact-head completed check run of that name, parsed only from the `eval_pass_rate=` and `eval_suite=` markers in its title and summary, and are recorded on the approval note. With a check named, gaps (unknown coverage, a pass with no reported rate or suite) are shown in advise and block in enforce.
- Cuts: no suite, no case from an S7 incident, no tag or release gating, and no per-repository `eval_check` table (a repository takes the top-level key). The marker contract is the hub's, not any suite's; the person's chosen suite must emit it, or the gap stays visible.

## Antigravity optional implementer peer (#485 P1)

Planner ownership ruling, 2026-10-19: the person-only `ahub agy` launcher owns exactly `plugin.json`, `mcp_config.json` and `hooks.json` inside `.agents/plugins/agent-hub/`. Apply symlink, hard-link and foreign-entry refusal and managed cleanup to all three files. Never write project-level `.agents/hooks.json`, another `.agents/` path or the person's `~/.gemini` settings. This amends the earlier two-file list in #485 AC3. AC0 must prove plugin-local hooks load without a global setting; failure stops implementation rather than falling back to manual configuration.

The first-party module lives under `src/adapters/agy/`. It is optional, off roster by default, cloud and unmanaged (`trust: { onPrem: false, hubSandboxed: false }`), with implementer/verifier roles only and no budget source until observed. It never admits PII work or runs as a planner or reviewer. Keep the retained reviewer placeholder unavailable with its existing reason. S0 and A2 are complete; the previous A4 ordering preference is waived.

The pinned agy 1.4.2 T0 receipt precedes implementation: isolated HOME/`.gemini`, real-config parity, hook stdin/stdout and plugin discovery, CLI flags/ACP and a native call to an actual scratch hub through the workspace plugin. Distinguish native transport driven by a fixture provider from a real account/model or interactive TUI/IDE observation. Map a permission mode only after its behavior is proved; unverified modes remain unmanaged. The observed plugin MCP namespace is `agent-hub_agent-hub`; do not assume the configured server name survives plugin loading unchanged. [T0 receipt](../verification/2026-10-19-agy-p1-t0.md).

The P1 host introduces additive `native_hook_launch` and `native_facts` control requests. Only the person begins/ends a launch; hook tools cannot grant themselves launcher authority, and conductor starts are refused. The interactive child remains in the launcher's foreground process group. Launch authority belongs to the console socket that began it and is revoked on that socket's close; an old socket cannot revoke a replacement launch. The managed launcher embeds its daemon/launch identity in the plugin hooks, and the host binds observations to one native conversation and socket generation. It acknowledges a normal fully-idle Stop only after a fresh native completion row. Turn-free facts are injected at the observed model boundary and acknowledged only from SDK transcript rows; unobserved native file effects receive no attribution. Hook input over one MiB is refused before decoding or forwarding. Out-of-ceiling agy roles are dropped with a config log notice before conductor validation, preserving other peers' admission.

The collected T0 proves the plugin, hook codec and read transport, not a native prompt override. P1 therefore keeps all runtime modes unmanaged and refuses unattended/headless/resume selectors until those individual mappings are proved. The old daemon refuses the additive launch request rather than silently weakening hook identity. An actual project TUI launch requires a running daemon with this feature; source/fixture verification does not claim that live rollout.

Version line (#589, owner decision 2026-10-20): agy updates itself, so the launcher accepts the 1.4.x line instead of exactly 1.4.2. 1.4.2 launches silently; another 1.4.x patch launches with one stderr warning naming the observed version and the 1.4.2 receipt; any other version, unparseable output or a failing `--version` is refused before a hub connection or plugin write. A T0 re-run on a newer patch is a separate follow-up.


## Amendment: no-write owner advisories (#498)

- A completed native owner turn on an accepted `in_progress` `implement` or `bulk_edit` task counts only when its snapshot diff is known empty, HEAD and shared local/remote branch refs (`refs/heads/*`, `refs/remotes/*`) are known unchanged, and it has no task-tool effect. `task_sweep.no_writes_turns` is a live nonnegative safe integer, default 2; 0 disables it independently of the disabled-by-default time sweep. A change, successful mutation (including accept with a plan), pending or uncertain mutation, or unknown capture breaks the streak. Read-only tools do not reset it. Owner/acceptance changes start a new generation. Counters are run-local; structured threshold stalls persist through the existing stall store and deduplicate notices per cause. The planner notice names the public task title and consecutive count.
- Done remains advisory. For writing classes only, the review request adds the exact line `no writes recorded since acceptance` when there are no branch refs, review heads (`refs.commit`, `sdlc.head`, `sdlc.localHead`) or recorded PR, no owner touches for this task since the first acceptance after its current ownership boundary, and a proven empty diff from that acceptance snapshot to now. Canonical-root D2 evidence is unknown when recorded elsewhere hints or the current worktree scope cannot exclude work elsewhere. Re-acceptance to revise a plan preserves this D2 baseline and earlier touches; D1 still fences each turn against the latest acceptance. The host records the resulting boolean on the done history entry; models cannot supply it. Other classes are exempt. Existing privacy screening and review authority remain unchanged.
- The first explicit acceptance/self-claim of the ownership span captures its baseline through the guarded host `ownerAccepted` callback; later re-acceptance cannot move it. An acceptance manufactured by done has no pre-work baseline and leaves D2 unknown; it adds no capture ahead of the existing review projection. Acceptance and done snapshots use the existing hardened snapshot machinery and shared 250 ms burst budget. Declared instances require their current execution adapter/root binding; canonical-checkout dirtiness cannot substitute for an instance's evidence. Unknown, disabled, private, missing/pruned or restart-lost captures never become empty evidence. Native writing-turn boundaries hash shared branch refs with one budgeted `for-each-ref` probe, without exposing names. HEAD or any shared branch-ref movement is progress, including commit-only turns in ignored worktrees. A canonical-root turn with recorded branch/commit, `.worktrees` paths or SDLC PR/head evidence remains unknown when its visible tree/refs are empty; a canonical tree cannot disprove work elsewhere. Even without recorded hints, negative canonical evidence additionally requires a bounded `git worktree list --porcelain -z` proof of a sole worktree at both boundaries and no ignored `.worktrees` directory. Uncommitted/detached work elsewhere therefore remains unknown before its first ref movement. The shadow repository compares its own private Git directory as the registered bare main-worktree path, preserving the same metadata validation and unknown-on-failure rules. Builtin-owner D1 is deliberately inert while `.worktrees` exists; the upgrade path is binding each owner to its actual execution worktree. Both probes cap output at 1 MiB and share the same snapshot deadline; no raw ref names or worktree paths escape. Check start/cancel, escalation and memory correction are task-tool effects alongside existing mutations; read-only check results are not. No snapshot is added during a private snapshot window; a PII notice, if trusted evidence is available, uses only `publicTitle`. Capturing private evidence and restoring acceptance baselines across daemon restarts remain outside this advisory.
- Structured `no-writes` stalls feed the S9 grooming digest and status. S7 consumers receive additive `stalls.noWrites` and `stalls.doneWithoutWrites` counts from cost reporting over that report's existing bounded, public, repository/PR-scoped tasks; they are not a count of every board row. No model call, automatic reassignment, done gate or new write endpoint is added.

## Amendment: config-only ACP adapters, A3 (#451, #486)

A3 adds declarative ACP definitions. It does not add A4 module loading, executable
callbacks or config-selected imports. `adapters.<kind>` is accepted only from a
Git-confirmed untracked `.agenthub/config.local.json`; the entire declaration is
machine-local authority, not just its command and arguments. A tracked local file
or a shared `config.json` cannot introduce one. Validate plain own-data objects
and bounded arrays before constructing definitions. Unknown fields, accessors,
inherited authority and collisions with builtin or reserved identities refuse.

Each declaration names `transport: "acp"`, `command`, optional `args`,
`displayName` and `roles`, with optional `identity: { name, version }`,
`permission` (hub-mode to native-mode mapping) and `readOnly` (native mode id).
Adapter role defaults cannot appoint a conductor; a person can still select one through explicit project role policy and its existing authority checks. Other kind-meaning capabilities remain builtin-only. A project captures one
immutable catalog at startup; declared kinds and their explicitly declared
instances resolve through that catalog, never a mutable global registry. Adapter
changes, including removal and their derived defaults, require a restart.

Configured kinds are optional, cloud and headless-only, off roster by default.
They do not change default routing or inherit another kind's identity, quota,
context parser or privileged capability. A configured kind may join the roster
through the existing person-controlled path. Roles, exact nominations and
reservations, family independence, instance execution-root admission and PII
refusal use the same host routing rules as builtin definitions. Kind preferences
may expand to declared instances; an explicit instance or canonical id remains
exact. Absence of a permission map means unmanaged native policy. Absence of a
budget block exempts the registered kind from quota accounting; it is not a zero
reading, while unknown external ids retain existing manual accounting.

The identity pin is optional in the declaration schema so an unverified adapter
can be described, but a start without it refuses before a prompt. Initialize must
return the pinned agentInfo name and version. A resumed `session/load` must echo
the requested sessionId; a missing or different echo refuses before a prompt.
No implicit fresh-session fallback repairs an identity failure. Explicit session selectors must be nonblank, bounded and control-free. A configured start in progress refuses another start rather than joining its result; an attached peer accepts an already-running result only for the same requested native session (or no selector). Config argv that
selects a leader or attaches to another native process is refused at load.

Owned-process admission has a deliberately bounded proof. The pinned native
foreground contract must be supported by a T0 receipt; the spawned pid, original
process group and process signature must have positive current evidence before
admission and before stop. Unknown ownership refuses. Stop signals only that
original verified owned group, never a pre-existing leader or any process outside
it. ACP provides no generic kernel-bound responder attestation, and A3 adds no
protocol extension pretending to provide one. A native agent that delegates its
responses to an unowned process is unsupported by this boundary.

The Grok proof target is the config-only `grok agent stdio` command, with no
leader or attach flags and with explicit `--no-leader`. Config load refuses a Grok kind, Grok executable or Grok native-identity pin without that standalone opt-out before argv termination; valued forms such as `--no-leader=false` also refuse. Native `--leader` and `--leader-socket` remain refused even alongside the opt-out. This is necessary because the native default inherits `[cli] use_leader` from ambient config. Its T0 must record that default and run under isolated HOME and Grok home in a
scratch project, preserve the person's config bytes, record the pinned build's
process tree, and inspect sockets/IPC while a prompt runs for links to processes
outside the owned group. It must separately record initialize identity, load echo,
native mode support or absence, usage unknowns and an actual hub tool receipt.
If in-process service and the no-external-IPC boundary cannot be established,
Grok remains explicitly unsupported; the generic ACP path may still ship with a
fake ACP transport receipt. This amendment describes the implementation contract,
not completed Grok live verification. Fixture results are not a native T0 receipt.

The optional definition `readOnly` capability names a native mode; it does not
select that mode for every instance. An instance selects it explicitly with
`readOnly: true`. Admission requires the native mode to be advertised and its
selection acknowledged before a prompt, plus the host's read-only kind/tool gate
and MCP mutation refusal. The selection is non-raisable: runtime and stored
permission changes cannot lift it. A missing mode, failed acknowledgement or
unknown policy refuses rather than falling back to an ordinary permission mode.
Mapped ordinary modes likewise require advertised native support and an
acknowledged selection; no map remains unmanaged and grants no hub sandbox claim.

Configured ACP crash resume reads only a bounded, control-free session id and requires exact session/load echo; it never imports a model override from old launch metadata. Controlled recovery remains explicitly refused for configured ACP because no terminal/recovery driver has been verified. Recovery source and target capability checks require `configured_acp` before reinterpreting configured identities or taking recovery effects. The initial Grok 1.0.62 isolated receipt found no initialize agentInfo and a refused session/new, so it does not establish native readiness; see `docs/verification/2026-10-21-grok-config-acp-t0.md`.

MCP publication appends project start targets only from authenticated daemon catalog metadata, preserving the builtin default enum. Read-only instances publish only the R2 read/review tool set; every mutation remains independently refused at the host boundary. Incomplete catalog metadata withholds configured start targets. If active lifecycle metadata is unavailable, tool discovery may retain the ordinary list until current status arrives; the host still independently refuses read-only mutations, and discovery never grants authority. A malformed generic session/new identity refuses before admission, and failed spawns are released only on positive no-process/empty-group evidence.

Task/conductor MCP refusals retain their existing error text and also set the optional `isError: true` result flag, so SDK consumers observe an unsuccessful tool call instead of an ordinary text result.

Configured ACP permission requests never use hub-tool titles for automatic approval. Requests use the ordinary person approval path unless the explicit permission-mode policy authorizes them, even when a title spells a known hub tool; builtin Kimi/Qwen title handling stays confined to those verified contracts. Owned-group identity across exec is the live child plus PID, parent, process group and start time; command/comm changes are evidence, not a new owner. Group teardown deliberately freezes, re-verifies and kills the original group; unreadable re-verification sends no further signal and retains the owner for an explicit retry.

## Adding an AI tool guide and adapter definitions (#451 A5)

- Human-oriented guide `docs/adding-an-ai-tool.md` documents today's builtin Adapter API 1 path (`AdapterDefinition` in `src/adapters/registry-types.ts` and `src/adapters/registry.ts`), covering:
  - Architecture and core independence: one frozen definition per kind; the core daemon, tasks, and routing inspect definition fields rather than hard-coded vendor name comparisons.
  - Transport selection: `acp` (stdio JSON-RPC), `codex-appserver`, `claude-channel`, `ws-pull` (pull-only workspace MCP plugin), and `hub-native`.
  - Conformance kit (`test/conformance/`): enrollment invariants, delivery occupancy, watchdog expiry, process-group teardown, and explicit reasons in `UNSUPPORTED` (per kind) and `UNSUPPORTED_LEGS` (per ACP leg).
  - Review and verification checklist: T0 receipt, path protection (`AGENT_CONFIG_SEGMENTS`), PII safety (`trust.onPrem`), process isolation, and documentation freshness.
  - Config-only generic ACP adapters (#451 A3, board task #217) follow the A3 amendment above, including its isolated native-proof boundary. External adapter modules (#451 A4, board task #135) follow the A4 trust boundary below.
- `docs/agent-notes/adapters.md` keeps only the per-adapter rules that bind code, pointing to `docs/adding-an-ai-tool.md` and `src/adapters/registry-types.ts` for conceptual architecture and definitions.


### A4 external module trust boundary (2026-10-21, #451)

`adapter_modules: [{ path, sha256 }]` is accepted only from an untracked,
machine-local `.agenthub/config.local.json`. Shared, tracked, cloned or unknown
provenance never evaluates module code. The declaration is person-owned,
never settings-editable, and restart-bound. The daemon imports modules at
startup; a CLI read, preview, reload or watcher never imports them.

Each pinned entry is a self-contained JavaScript bundle inside the canonical
project root. Refuse symlink components, a file outside that root, a
world-writable or nonregular entry, an unreadable/oversized entry and a SHA-256
mismatch. A module bundles its own dependencies; core adds no third-party
runtime dependency. Runtime permits static imports of Node/Bun builtins except
`bun:ffi` and `bun:test`, plus the public `@staix/agent-hub/adapter` entry only.
The `/conformance` export is for the module author's CI, not runtime modules.
Relative imports, other package imports, dynamic/nonliteral imports, require,
eval and Function-based code loading that the loader can detect are refused.
Dependencies must be bundled as ESM; `import.meta.require` and CommonJS loading
are refused. Use Bun.Transpiler's import records and token inspection before
evaluation. After checking the original content pin, compile its scanned static
SDK imports to file URLs of the running daemon's own adapter entry, never a
project-resolved package copy. Re-hash the original captured bytes immediately
before importing the rewritten result; never reopen the mutable source path.
A pin is code authorization, not
a sandbox: approved module code runs with daemon privileges; scanner rejection
is deliberately conservative and is not a proof against obfuscated code.
Refuse a failed module independently with a bounded, body-free status reason;
keep builtins and other verified modules available. When trusted module
declarations exist, unknown roster ids remain inert, including on CLI config
reads while no daemon metadata is available; a roster row grants no adapter identity.

A module exports `definition` with the current `ADAPTER_API`. Validate the
accepted structural subset and fixed-builtin capability exclusions before
publishing it in the immutable project catalog. The initial accepted executable
subset is a headless ACP definition (`transport: "acp"`, `start.daemonPort:
"acp"`), with a factory returning the public AcpPeer transport for its bound id.
Its own family, optional/off-roster defaults and cloud/unsandboxed trust are
mandatory. Native hooks, budgets, configuration callbacks, reviewer backends,
instance policies and other fixed-native fields are refused rather than
advertised as usable extension points. A broader transport needs a reviewed
kind-neutral host-port contract first (#625 phase 6). Builtin collisions, duplicate
kinds, incompatible API and unsupported fields refuse the module. Never add
a module to the process-global builtin registry. Builtin and configured instance
namespaces (`<kind>-*`) are reserved against external module kinds.

The CLI receives external kinds only as bounded id/display metadata from the
running daemon. That projection cannot grant permissions or register code.
A4 refuses declared instances of external kinds with an explicit unsupported
reason; their execution-root, recovery and CLI declaration contracts are a
follow-up. The exported Bun conformance entry exposes callable transport
registrations and packaged fake transports without executing those fakes on
import. Builtins keep their existing applicable contract tests and explicit
unsupported-leg reasons; an external module exercises the same contracts in
its own CI.

### S4 test integrity boundary (#481)

S4 applies only when the linked issue's complete label metadata contains `bug` (case-insensitive); known non-bug issues are exempt. Unknown labels never establish exemption: enforce blocks entering review and approval, advise reports unknown. Off retains its receipt/schema/readback behavior. No issue/PR body, patch or test output is retained.

The optional enabled-lifecycle `redFirst` receipt contains red/green legs, each `{source, head, check, result}`. Sources are `local`, `container` or `ci`; local/container results remain labelled claims, CI results require the exact named completed FAILURE/SUCCESS CheckRun at that commit, never an agent-posted StatusContext. `checkEvidence` labels each leg claimed or observed; verified describes receipt structure plus supplied results. Red is failed, green is passed, check names match, full lowercase SHAs differ, and green equals current PR head. Red must belong to the PR and have one parent with a nonempty commit diff adding only recognized test paths. Its single-parent ancestry within the complete PR commit set must touch only tests; earlier implementation or ambiguous/merge ancestry refuses the proof. Relinking repository, issue or PR drops an unsupplied red-first receipt. In enforce, only USER may change an already-established repository or issue; peers may initially fill missing identity and still relink the PR. This durable identity rule prevents owner-controlled bug-to-nonbug relinks before a first observation or after restart, without status writes; advise/off retain their prior authority.

Complete PR file metadata flags modified/deleted pre-existing test paths; newly added tests are permitted. Test paths have a test/tests/__tests__ directory component or a supported .test/.spec language suffix, plus conventional *_test.go, test_*.py, *_test.py, *_spec.rb and *Test.java names. Missing types, unsafe paths, rename/copy identities and truncation remain unknown. Missing/invalid/unknown red-first proof and changed existing tests block both review and approval in enforce, and appear as advisory findings in advise. Current task/privacy/authority fences hold after asynchronous reads and before effects.

Readbacks use bounded metadata calls within the existing shared 20 s deadline: at most 100 labels, 100 PR commits, fewer than 100 red-commit files and 100 contexts per CI leg; beyond those ceilings proof is unknown (upgrade path: bounded pagination). The merge queue's last remote snapshot revalidates applicability for every linked issue, up to 32 distinct issues (upgrade path: bounded snapshot pagination). Status/queue reports carry source labels and current-host-screened path identities; private metadata becomes neutral unknown, and receipt metadata is screened again on public output. Metadata cannot detect later gutting of newly added test assertions; content-aware review is the upgrade path. These gates never execute checks, merge, publish or confer authority, and source/fixture verification does not certify the separate native lifecycle receipt.

### S2 plan conformance boundary (#481)

Optional proof/risks lists are bounded to 32 strings of 512 characters. Literal file/directory-prefix coverage uses complete current PR file metadata, never patches or glob execution. Root plan entries never cover all files; renamed/copied files whose old identity is unavailable make the inventory unknown. Untouched paths are advisory; uncovered changed paths block enforce approval until plan amendment or person acceptance. Host content revisions are separate from backlog planningRevision. "Plan revisions after the first observed push" binds the first observed remote head to plan fingerprint/revision; earlier pushes are unknown. Pending observations persist only at successful owner/reviewer transitions; status and queue reads never append history, and off mode captures no S2 observations or content revisions. Lost pending intervals remain unknown. The ceiling is no true push-event source; the upgrade path is a webhook or Actions push receipt. Person-only `ahub sdlc accept-departure <task> <head> <reason...>` records complete current repo/PR/head inventory and plan fingerprint/revision, with bounded sanitized privacy-screened rationale; changed identity, plan or inventory invalidates it, including plan edits while reporting is off. Departure consent expires on host restart to prevent unpersisted invalidations from reviving; the upgrade path is a durable host observation journal. Private projections reveal only existence, and unavailable private inventories stay unknown.

## Amendment: general-purpose intake, sources, drafts, schedules and deliverables (#516)

The owner gave the #516 track its go-ahead on 2026-10-22. This section closes the design gaps that blocked coding #508, #509, #511 and #512. Each child issue keeps its own ACs; where this section is stricter, it wins.

### Sources (#508)

- `ahub source add <path|url>` is the person's or, since #933, the configured conductor's (admitted and audited by the hub); other agent shells are refused like the other console commands. The id is `src:` plus the first 16 hex digits of the snapshot's SHA-256, so adding the same bytes twice returns the existing id.
- The snapshot lives in the hub state directory under `sources/<id>/`: `meta.json` (`{id, kind, origin, sha256, bytes, added_at, private}`), the raw bytes, and the projected text. The raw cap is the text-projection input cap (`MAX_PROJECTION_INPUT`, 16 MiB), and the text comes from the existing text_projection converters with their caps and sandbox. Larger inputs are refused with the cap in the reason; nothing is truncated silently.
- A URL is fetched once, by the person's CLI process, over https only, following at most 5 redirects, within the same 16 MiB cap. No agent, sandbox or hub tool fetches a URL. Because the person issues the fetch, a PII project does not refuse it; the snapshot is screened like any file.
- A path under `pii.paths`, or a snapshot whose text the PII screen flags, is stored with `private: true`.
- Privacy is monotonic per id. Because equal bytes share one id, `private` is the OR over every registration of those bytes. Re-adding them from a private path, or with screened text that is now flagged, upgrades the existing record to private. Re-adding from a public path never downgrades it. `meta.json` keeps every origin; a private record shows no origin to anyone but the person. Readers, the CLI and dashboard lists, overlap notices and plan validation always use the record's current flag, never the flag of the registration that created it. Implementation tests cover both orders, public then private and private then public, and show that the second add returns the same id with `private: true`. `hub_source_read` returns the text of a private source only to the on-prem worker inside a PII task. Every other caller gets `{id, kind, private: true}` with no text, origin or excerpt.
- `hub_source_read {id, range?}` takes `range: {offset, length}` in characters but bounds the response in bytes: after `sanitize()` and the PII screen, the text is at most 32 KiB of UTF-8, cut at a character boundary with an explicit cut marker, and the reply returns the `next` character offset. It is excluded from capture.
- The plan's `sources` field is validated against the registry: an unknown id is refused at propose, accept and plan. Overlap notices name registry ids, never origins.

#### Sources reader implementation (#508 AC3, hub task #333)

- `hub_source_read` is a read tool on the common task-tool surface. Offsets and lengths count Unicode code points, starting at zero; both range fields are required when a range is supplied. Length is positive, offset nonnegative, and both are safe integers. The reply contains `id`, `kind`, `private`, `text` and `next`; it never includes an origin. A withheld private reply contains only `id`, `kind` and `private: true`.
- The reader screens the whole stored projection before selecting a range. It reapplies current `pii.paths` to every file origin and current `pii_patterns` to the complete text. With local model screening enabled under `local_only`, it uses the existing bounded host PII screen. A timeout, unavailable model, invalid pattern or oversized input is private. The existing 6000-byte model-screen ceiling applies to the full source; this slice does not classify excerpts as a substitute for the full source.
- Host classification upgrades `meta.json` under the registry's registration lock without adding an origin, so the origin cap cannot prevent an upgrade. A public registration can never undo that classification. A screen failure is withheld, never exposed as a clear result.
- Private text requires the daemon's in-process builtin on-prem worker, a current PII task turn, and a positive on-campus check. A control WebSocket claiming the local peer is insufficient. Authority, policy and record changes across awaited screens or campus checks fail closed. Already-private text is not sent to the model screen.
- Pagination sanitizes the chosen original characters, includes an explicit cut marker when characters remain, and caps that text including the marker at 32 KiB of UTF-8. `next` counts consumed original characters, so sanitation expansion cannot skip text. Tool calls and their results are excluded from local and native memory capture; pending-delivery hints are separate from the source JSON.

#### Sources (#508) implementation notes (hub task #329: `ahub source add|list`, `src/hub/sources.ts`)

Where the code differs from or fixes a detail the section above leaves open:

- **Directory name.** The snapshot directory is `sources/src-<16 hex>/`, not `sources/src:<16 hex>/`: a colon is not a safe path segment on every filesystem. The id stays `src:<16 hex>` everywhere it is shown, stored in `meta.json` and accepted as input; only the folder drops the colon. A reader maps an id to its folder with `id.replace(":", "-")` and refuses anything that is not exactly `src:` plus 16 lowercase hex digits, so an id can never name a path.
- **`meta.json` shape.** The spec's `{id, kind, origin, sha256, bytes, added_at, private}` describes the first registration and is kept exactly. `origins` is added: every registration of those bytes (`{kind, origin, added_at, private}`, at most 256, an exact repeat adds nothing) so "keeps every origin" is data, not a promise. A distinct origin beyond 256 is explicitly refused before any mutation, including a proposed private upgrade; that attempted registration did not occur, and the existing record stays unchanged. Exact repeats remain idempotent at capacity. `private` is the OR over `origins`; a `meta.json` whose flag is lower than one of its origins is damaged and reads as no record, so a hand edit or a stale writer can never downgrade a source.
- **What "the PII screen" is on this path.** `ahub source add` runs in the person's CLI process, which has no daemon and no model gateway, so it applies the deterministic screens only: `pii.paths` for a file, and `signals.pii_patterns` (the same regular expressions the hub applies to task text) to the snapshot's text. The model screen (`signals.pii_screen = "local"`) needs the daemon's on-campus check and is not run here. A pattern that cannot be evaluated counts as flagged (`text could not be screened`), never as clear. A snapshot only the model screen would flag registers public in the CLI; the daemon-side reader (`hub_source_read`, AC3, implemented in task #333) screens it again before exposure and upgrades the record, which the monotonic rule allows. The reasons are fixed words (`path under pii.paths`, `text matches signals.pii_patterns`, `text could not be screened`); the matched text is never printed.
- **Text.** The text is the existing converters' projection (`TextProjections.projectBytes`, with their caps and sandbox) where one handles the extension; otherwise a plain file that is valid UTF-8 without NUL bytes is its own text, and anything else has no `text` file and is not guessed at. A converter that fails leaves the plain-text fallback, never an unscreened empty record.
- **URL.** Redirects are followed by hand so each hop is re-checked as `https:` without credentials; a relative `Location` resolves against the current URL; the sixth redirect is refused without a seventh request. The body is read through a running byte cap, so a response that lies about or omits its length is cut off at 16 MiB and never buffered whole, and a declared `content-length` over the cap is refused before the body is read. The registered origin is the final URL.
- **Authority.** `source list` is `console` in `classifyPeerCommand` by falling through (an unlisted command is the person's), and `source add` is `conductor` (#933: see the amendment "the console class keeps trust, money, attribution and terminals"); a test pins every form, and `cliCommandLabel` names `source add` or `source list` in the audit and in a refusal, never the path or URL. Both registration and listing also refuse `--live-test` delegation under agent markers, through the existing person-attributed-content gate, before any source is read, fetched or written.
- **One registry lock, and caps that match.** Registrations are serialized across processes by `sources/.lock`, published whole by `link(2)` of a temp file that already holds the owner's pid and process signature, so it never exists without an owner. Only its own holder removes it, when the registration ends. It is never taken over: a lock whose owner is proven gone makes the registration fail closed, naming the file for the person to delete, because "check, then unlink" is not atomic and two recoverers could each delete the other's fresh lock and mutate together. A stale-holder refusal rechecks the same inode and owner bytes after the process inspection: a normally released or replaced lock retries within the existing deadline instead of reporting an old observation as stale. No contender removes any lock. A registration that cannot get a live holder's lock within ten seconds fails naming the lock. Reader and writer share one cap per file (`MAX_META_BYTES` 2 MiB, `MAX_SOURCE_TEXT` equal to the raw cap), so what `add` accepts can always be read back. A directory with a `meta.json` that cannot be read is damaged, not absent: `add` refuses it and leaves it as it is, because rebuilding it could drop a private flag.
- **Registry capacity and enumeration.** The 10,000-source cap counts valid metadata records, never lock files, contender temporary files, crash partials or damaged entries. Lists validate records before applying the cap; an already overfull on-disk registry refuses explicitly instead of silently cutting rows. New registrations enforce capacity under the registry lock, including when their target directory is a crash partial. Existing-source privacy/provenance updates remain possible at source capacity, subject to the separate origin cap.
- **Not in the CLI slice.** The reader is implemented separately in task #333 above. The plan `sources` validation, overlap notices and the dashboard list (AC4 and the dashboard half of AC5) remain separate tasks; this one is the CLI half of AC1, AC2 and AC5.

### Intake drafts (#511)

- A draft is a backlog card carrying `draft: true`. Backlog work is never offered, `hub_backlog_pull` refuses a draft, and the draft's children inherit the mark, so AC3 holds by construction.
- `ahub intake "<text>" [--source <id>...]` (person-only) creates one parent draft holding the request, with its sources validated as above.
  - With a planner, the hub sends it a `task` envelope of class `plan` that names the draft id. The request text goes through `publicView`. The planner answers with `hub_backlog_split` on the draft, giving each child a profile class, its sources, dependencies (`after`/`afterParts`) and acceptance criteria in the #507 criteria-id format.
  - Without a planner, the hub model (`inference.ts`) proposes the same split as JSON. The hub validates it against the `hub_backlog_split` schema and writes it; invalid output leaves the parent draft unsplit, with the reason.
  - PII in the request never goes to a planner peer, because PII turns refuse `hub_backlog_split` (`taskOpBody`). The hub's on-prem model proposes the split instead, under the existing triage screen, and the hub writes it itself through `Tasks` as private (PII) drafts, which show as stubs everywhere. Without an on-prem model, the draft stays unsplit for the person.
- `ahub intake approve <id>` (the person's, and since #933 the configured conductor's) clears `draft` on the parent and its children, which then follow the normal backlog pull. `ahub intake discard <id>` cancels them through `Tasks.cancel`.

#### Intake drafts implementation notes (hub task #334: `ahub intake`, `src/hub/intake.ts`)

- **Where the mark lives.** `draft` is a column on `tasks` (added by `ALTER` on an older database, default 0) and `Task.draft?: true`. Only `Tasks.propose` writes it, and only for the person's own `backlog: true` proposal (`by === USER`); a peer's `hub_task_propose` has no such field. `Board.splitBacklog` gives each child its parent's mark.
- **Enforcement is at the board, not only at the callers.** `Board.pullPlanned` refuses a draft, and `Board.update` refuses to move a draft to any state but `backlog` or `cancelled`, so a path that forgot the check still cannot offer one. `Tasks` adds the readable refusals in `pullPlanned` and `moveBacklog`, skips drafts in the reservation auto pull (`topReservedReady`) and keeps them out of the planner's "Backlog items" notice.
- **The request.** One parent draft: class `plan`, title `Intake: <first line>`, detail the text (1 to 7000 characters) and, on a last line, `Sources: <ids>`. Each `--source` must be a `src:<16 hex>` id the registry holds, at most 16 and distinct; all are checked before any card is made.
- **With a planner**, the hub sends the first attached, rostered planner a `task` envelope (`taskRecipient: planner`) naming `hub_backlog_split` on the draft id at its planning revision, with the text from `publicView`, the sources and the criteria format. If no planner is reachable, or the envelope is not queued, the hub model takes it.
- **Without one**, `Inference.split` (interactive clock, 60 s, 3000 tokens) answers JSON. `parseIntakeSplit` takes the bare object, a fenced block or prose around it, checks it against the `parts` property of the running profile's `hub_backlog_split` schema (a small validator over the keywords those schemas use: type, required, additionalProperties, min/max items, lengths, minimum, uniqueItems, enum, pattern) and then the rules `Tasks.splitBacklog` enforces anyway. It also requires every part's detail to carry acceptance criteria in the #507 `<id>: <text>` format and every `plan.sources` id to be one the request named. The hub writes the result through `Tasks.splitBacklog(HUB, ..., { intake: true })`, the only call where `by === HUB` passes the planner check. The hub's exception requires the parent to still be a draft at every validation through the final write: `Tasks.splitBacklog` checks it before and after the awaited screen, and sets `Board.requireDraftForNextSplit` for exactly that write so the board checks it again inside its transaction (an approval clears the mark without moving the planning revision, so the revision alone cannot show it). A person who approves the card while the model answers therefore wins: no child is created, and none is left undrafted. Any failure (no model, no answer, not JSON, schema, criteria, a refusal by `splitBacklog`, a draft that changed meanwhile) leaves the draft whole with a `hub` history entry `intake unsplit` naming the reason; the reason never contains anything the model wrote: it is built only from fixed words, array indexes and the schema's own property names. A property the schema does not list is reported as `parts[i]: an unexpected property`, without its name, so a hostile or private property name cannot reach the draft's history, which is not given the semantic screen the split parts get. A refusal from `splitBacklog` keeps the hub's own fixed refusal text, and any other error becomes `the board refused it`.
- **PII.** A request whose draft is private is never sent to a planner. The model call needs `triage.onCampus()`; off campus the draft stays whole with that reason. On campus the hub's split goes through the unchanged `splitBacklog` screening, so the children are private drafts that show as stubs.
- **Approve and discard.** `Tasks.approveIntake` accepts `USER` or the admitted conductor (#933 amendment), and `discardIntake` accepts only `USER`. The family is the draft and the still-open draft cards in its `deps`. Approval is one `Board.approveDrafts` transaction (every card must still be an unstarted, ownerless backlog draft, or none changes) that clears the mark and records `draft approved`; the cards then follow the normal pull. Discard calls `Tasks.cancel` on each card.
- **The command.** `ahub intake "<text>" [--source <id>...]`, `approve <id>`, `discard <id>`, with the usual `--json` and `--color=`. It is not in `classifyPeerCommand`'s allowed list, so an agent shell is refused (except `approve` for the configured conductor (#933: see the amendment "the console class keeps trust, money, attribution and terminals")), and `liveTestRefusal` covers it. The audit label is `intake`, `intake approve` or `intake discard`, never the text. The request is 90 s at most on the control socket.
- **Not in this slice.** The dashboard text box (AC1's second half) and a dashboard drafts view are #511b. Drafts show in `ahub backlog list` with `draft: true`.

### Schedules and folder triggers (#512)

- `schedules` is a machine-local key: add it to `MACHINE_LOCAL` in `config-trust.ts`, so only `config.local.json` can set it. A committed config that creates tasks is refused, like the other machine-local keys.
- Entry: `{id, every, class, title, detail?, sources?, owner?, queue?: "backlog" | "ready"}`. `every` is `<n>m|h|d` with a 15-minute minimum. `cron` is accepted by the schema but refused with "cron not supported yet; use every", because a cron parser is a new runtime dependency or new code; it is a later slice.
- Due checks run on their own interval timer, started whenever `schedules` or folder triggers are configured, independent of `task_sweep.enabled` (the task sweep's timer exists only when that option is on, and it defaults to off). The timer runs no task sweep, and it is re-armed on config reload. `queue` defaults to `backlog`. Missed runs coalesce: a schedule proposes at most one task per tick, and none while its previous task is still open. A global pause or hold skips the tick and coalesces it. Last and next run times live in `hub.db`, and status and the dashboard show the next run.
- Folder trigger: `{id, folder, glob?, class, title, ...}`. `folder` is resolved with `realPath`, must lie inside the project or a declared data path, and is polled on the schedules timer, not watched. Symlinks that leave the folder are skipped. A new file (by `realPath`, size, mtime and SHA-256 recorded in `hub.db`) is registered as a source (#508) and proposes one task that names it. The trigger therefore lands after the source registry.
- `ahub schedule list|run <id>|pause <id>|resume <id>` is person-only for `list`; `run`, `pause` and `resume` are also the configured conductor's since #933 (implementation notes in #512b below).
- Folder triggers are their own machine-local key, `folder_triggers` (implementation notes in #512c below).

#### Schedules (#512a) implementation notes (hub task #330: `schedules`, `src/hub/schedules.ts`)

Where the code states or fixes a detail the section above leaves open:

- **Where the timer runs.** `schedulesTimer` in `startDaemon` is its own interval (default one minute, `schedulesEveryMs` in tests), armed at startup and re-armed by `reloadConfig` when a `schedules` leaf changes. It exists only while `schedules` is non-empty, and it never reads `task_sweep.enabled`. The pass is `Tasks.proposeFromSchedules`; the daemon only calls it and writes `status.json` afterwards.
- **Period.** A schedule's period starts at its anchor in `schedule_runs` (`hub.db`): the first time the hub saw it, then each run. A schedule never runs at first sight, and a restart or a hold never replays what it missed: a run restarts the period at `now`. Changing `every` takes effect from the same anchor. A schedule removed from the config loses its row.
- **Coalescing.** A due schedule proposes at most one task per pass. While the task its previous run made is open, or while the hub is held (stopping, recovering, a storage error), a due pass proposes nothing and counts a skip (`coalesced`); the next run after the cause ends is the one task they fold into.
- **Which task is "its previous task".** The open card whose first history entry is by the hub and whose detail starts with `Schedule key: <id>`, read from the board, never from `hub.db`. So a task closed by anyone, or a `hub.db` row that was lost, cannot make the answer wrong, and a task a person or peer wrote to quote the marker does not count.
- **Holds are fenced at the write, and stop drains the pass.** `propose` awaits the PII screen and triage, and a hold (stopping, recovery, a storage error, the test seam) can begin during them, so `proposeFromSchedules` hands `propose` a fence that `requestCheck` asks again right before the board write. A run overtaken that way writes nothing and counts as a skip, never as the schedule's error. Normal shutdown clears `schedulesTimer`, waits for a pass in flight (bounded at five seconds, after which the pass is still refused by the fence), and closes `schedulesStore` before the board; a pass that ends during shutdown does not republish `status.json`. A recovery commit waits for a pass in flight (`Tasks.schedulesPending`, in `recoveryReady()` and the blockers as "a scheduled task proposal in flight"), like it waits for completion checks and automatic pulls, so no scheduled run writes after the commit's digest. An ordinary `propose` takes no fence.
- **How the task is made.** Through `Tasks.propose` as the hub (backlog for `queue: "backlog"`, a routed proposal for `"ready"`), so the PII screen, triage, class validation, routing and notices all apply. A proposal `Tasks` refuses is recorded as the schedule's `last_error`, shown in status, and retried at the next tick (the period is not restarted by a failure).
- **Status.** `schedules` in the daemon status holds, per schedule: id, every, class, queue, next run, last run, the task, a state (`scheduled`, `due`, `waiting`, `held`), skipped runs and the last error. It never holds a title or detail, because those are task text. `ahub status` prints one `schedule <id>` line each.
- **Config.** `schedules` is in `MACHINE_LOCAL` and `NEVER_EDITABLE` (a settings write cannot create work), is validated by `schedulesConfig` in the loader and in `config-apply`, and applies live. At most 64 entries, ids of lower-case letters, digits, `-` and `_`, details of at most 7000 characters (so the marker line is never cut off), at most 16 `sources` ids of the `src:<16 hex>` form.
- **Not in this slice.** `sources` is carried into the task's detail as `Source: <id>` lines; it is not yet validated against the registry or attached as `plan.sources` (that is the plan-validation slice of #508). Folder triggers and `ahub schedule list|run|pause|resume` stay with their own tasks.

#### Schedule commands and the dashboard (#512b) implementation notes (hub task #335: `ahub schedule`, `src/cli/schedule-output.ts`)

- **Person or conductor, three layers** (`run`, `pause` and `resume` also admit the configured conductor, #933: see the amendment "the console class keeps trust, money, attribution and terminals")**.** `schedule` is not in `classifyPeerCommand`'s allowed list, so an agent shell is refused before the command runs, `liveTestRefusal` covers it, and the daemon's console-op gate and `Tasks.runScheduleNow` and `setSchedulePaused` each refuse any actor but the person. The audit label is `schedule <list|run|pause|resume>`, never an id (an id is config text).
- **`list`** prints `scheduleViews` as a table: id, every, class, queue, state, next run, last run, task, then the skipped-tick count and the last error as notes. No title or detail appears anywhere: both are task text.
- **`run <id>`** proposes the schedule now, whatever its period says, through `runSchedule`, the same code the timer's pass calls, so a manual run can never do what a due one may not: it is refused as `held` while the hub is stopping, recovering or on a storage error, refused as `waiting` while the task its previous run made is open, and otherwise goes through `Tasks.propose` as the hub (the PII screen, triage, routing and notices all apply). It takes the same single pass guard as the timer (`schedulesRunning`), so it never overlaps a pass and recovery's `schedulesPending` wait still covers it; while a pass runs it is refused with "a schedules pass is running". A successful run restarts that schedule's period at now, like a due run. A refused manual run is not a missed period, so it does not feed the coalescing count.
- **Pause and resume are ordered against a run in flight.** `ScheduleStore` keeps a per-schedule pause generation in memory (`epoch`, bumped by `setPaused`). A timer run captures it when it is admitted, and the write fence `propose` asks again right before the board write also compares it, so a pause or resume that lands while the run awaits its PII screen cancels that run (outcome `changed`, nothing written, no skipped tick): the acknowledged command is what takes effect. `ScheduleStore.ran` also moves the anchor with `MAX(anchor, now)`, so a pass that finishes after a later resume can never shorten the fresh period. A person's own `run` is outside the epoch: pausing during it does not cancel it. A restart ends every run in flight, so the generation needs no storage.
- **A manual run is drained at shutdown.** `schedule_run` is registered in `manualSchedulePasses`, which `stopOnce` waits for (bounded at 5 s, like the timer's `schedulesPass`) before the peers stop and the board and the schedule store close, so a run that created its task and is still awaiting assignment delivery finds its bookkeeping (`ran`, `failed`) written to an open store. A run that arrives once stop has begun is refused by the control layer ("hub is stopping").
- **`pause <id>` and `resume <id>`.** A `paused` column on `schedule_runs` (added by `ALTER` on an older database, older rows read as not paused). The timer skips a paused schedule without a run and without counting a skipped tick. `resume` clears the flag and starts a fresh period at now, so a long pause is never replayed as a run the moment it ends, as a restart never is. A paused schedule still runs on `run <id>`: a pause stops the timer, not the person. `pause` of a schedule not yet seen records it, paused.
- **View.** `ScheduleState` gains `paused`, which wins over every other state. `ahub status` reads `paused (ahub schedule resume <id>); would be next <time>`.
- **Dashboard.** The UI snapshot carries `schedules` (the same views, ids, enums and times only; absent when none is configured, so an older page and an unconfigured project see no change). The Agents view has a read-only Schedules table, built from the existing `usage-table` classes so no style changes, with a next-run column worded by `scheduleNextLabel`: the time for `scheduled`, `Paused (would be <time>)`, `Due now`, `Due, waiting for task #N to close` or `Due, held`, and `unknown` for anything else, never an invented time. The dashboard has no run, pause or resume control: those stay the person's CLI commands.
- **Not in this slice.** Folder triggers (#512c) and cron remain refused or absent.

#### Folder triggers (#512c) implementation notes (hub task #336: `folder_triggers`, `src/hub/folder-trigger.ts`)

- **Config.** `folder_triggers` is a separate machine-local key (not inside `schedules`, whose entries are time-based), in `MACHINE_LOCAL` and `NEVER_EDITABLE`, validated by the pure `foldersConfig` in the loader and in `config-apply.ts`. Entry: `{id, folder, glob?, class, title, detail?, owner?, queue?}`, at most 16. `glob` is a file-name pattern (letters, digits, `. _ -`, space, `*`, `?`; never a path) that matches whole names; a dot file never matches.
- **Where the folder may lie.** `checkTriggerFolder` runs the corpus root check (`checkCorpusRoot`: `realPath`, vault refusal, `local.deny`, `pii.paths`) and then requires the real folder to lie inside the project or a declared `data.readonly` folder, both as real paths, so a link out of either is judged by where it lands. The answer is a reason string, never a throw; a refused folder records `last_error` and proposes nothing.
- **Polled, never watched.** The pass runs on the schedules timer (`runSchedulesOnce`), under the same `schedulesRunning` guard as a schedules pass and `ahub schedule run`, so it never overlaps one and a recovery commit waits for it. While the hub is held it reads and records nothing, so the files wait for the next poll.
- **Baseline.** A trigger's baseline is the files already in the folder when it starts. They are recorded and propose nothing, so adding a trigger to a full inbox does not flood the board. A folder too big to hash in one poll (below) is baselined over several polls: each records what it read, and the poll that reaches the end of the folder completes the baseline (`folder_poll.baselined`); until then nothing proposes, and a file that arrives meanwhile is part of the baseline. A refused folder never begins the trigger: when it becomes readable, what is in it then is the baseline.
- **What is read, and the memory bound.** Regular files directly inside the folder (no recursion), in name order. The listing is never cut (a folder of more than 100000 entries is refused as not an inbox), so a file late in name order is reached once the earlier ones are recorded, however many hidden or unmatched names sort before it. A symlink is never read: one that leaves the folder is skipped as `symlink leaving the folder`, one that stays as `symlink`. A file on the denylist is skipped. The scan keeps no file's bytes: a file already recorded at its real path, size and mtime returns its recorded hash after an `lstat` and is not opened; any other is opened with `O_NOFOLLOW`, checked against its `lstat` (size and inode) and hashed in 64 KiB chunks from that descriptor. At most 200 files and 256 MiB are hashed per scan (the first file always is, so one file near the source cap still goes); the rest wait for the next poll. Registering a file reads that one file again (`readScanned`) and refuses it unless it still hashes to what the scan saw, so at most one file's bytes are in memory and a file that changed in between is tried again as what it became. A file whose bytes change without its size or mtime changing is not noticed (a `ponytail:` note names the upgrade: hash every poll under the same budget).
- **What is new.** `folder_seen` in `hub.db` records, per trigger, the real path, size, mtime and SHA-256. A file is new when its hash is not recorded for that trigger, asked again for each file as the pass goes, so two files with the same new bytes that arrive together propose ONE task. A rename and a touch keep the hash, so they propose nothing; the same bytes under another name are the same file (the source registry keeps one record per hash too). Such a file is still recorded where it now is (`FolderStore.observe`: its new path, size and mtime, keeping the task its content already has), so the next scan finds it with `known` and does not hash it again; otherwise a pile of renamed, touched or duplicate files would spend the hash budget on every poll and a genuinely new file behind them would never be reached; a path whose bytes changed has a new hash and is new. A deleted file never proposes.
- **What a new file does.** At most 20 per trigger per pass, in name order. For each, the hub screens it exactly as `ahub source add` does and registers it, in `registerScanned` (`screenRegistration`: `pii.paths` and `signals.pii_patterns` over the projected text, then `SourceRegistry.add`, private when flagged), the one function the daemon and the tests share, then proposes ONE task through `Tasks.propose` as the hub, behind the same hold fence as a schedule. The task's detail is `Folder trigger: <id>`, a fixed line, the person's `detail`, and `Source: <src id>`; it never carries the file's name or path (both can be private), so a PII file's task is as public as its id. A file is recorded only after its task exists: a failure or a hold between the two leaves it to be tried again, and later files wait behind it so order is kept. A crash in that window can repeat one task; it never loses a file.
- **Not in this slice.** `plan.sources` validation of the task against the registry, a status or dashboard view of triggers, and recursive folders.

### Deliverables (#509)

- In a PII task, or for a deliverable under `pii.paths`, the record keeps the id, format, version and SHA-256 only, never a path or an excerpt, in every view, log and memory call. Hashing still runs on the real path under the existing path guard.

### Knowledge corpus (#510), owner decision 2026-10-22

- The hub indexes plain notes folders only, read-only. `corpus.paths` is a machine-local key.
- A corpus path that lies in, is, or contains an Obsidian vault is refused. The check runs on the `realPath` of the configured root, so a symlink into a vault is caught. It looks for a `.obsidian/` directory in every ancestor of that real path (a root inside a vault, such as `/vault/notes` when `/vault/.obsidian` exists), at the root itself, and below it. The index walk also skips no `.obsidian/` it meets; it refuses the root instead. Evidence it cannot read (an unreadable ancestor or subdirectory, or a realPath failure) refuses the path; it never certifies a plain folder. The reason names MCP: a vault is reached only through the Obsidian MCP tools, never read by the hub from disk.
- AC3 (vault candidates) stays with agent-mem (tasks 112 and 122); the hub adds no vault reader.

#### Knowledge corpus (#510a) implementation notes (hub task #331: `corpus.paths`, `src/hub/corpus.ts`)

Where the code states or fixes a detail the section above leaves open:

- **Config.** `corpus: { paths: string[] }` is validated by `corpusConfig` (`src/hub/corpus-config.ts`, pure, so the channel bundle that reaches the config schema never pulls in file-system code). `corpus.paths` is in `MACHINE_LOCAL` and `corpus` is in `NEVER_EDITABLE`, so only an untracked `config.local.json` sets it and a settings write cannot. At most 16 folders; each is an absolute or project-relative path, and `~` is refused rather than expanded. It applies at startup (the index is bound to its roots then).
- **Root check (`checkCorpusRoot`).** Order: resolve the path with `policyRealPath` then `realPath` (a symlink into a vault resolves to the vault), then look for any entry named `.obsidian` at the real root and in every ancestor of it, then the deny rules (`isDenied` with `local.deny`), then `pii.paths` (`matchesPolicy`). Anything that cannot be read, resolved or listed refuses the root with its cause; only a clean read certifies it.
- **Walk (`CorpusIndex.refresh`).** Bounded at 4096 folders, 100000 entries, depth 24 and 5000 notes of at most 256 KiB. Any entry named `.obsidian` (a folder or a file, folded spelling too) below the root refuses the whole root, and a tree too deep or too big to be shown free of a vault is refused, never cut short. A folder that `pii.paths`, the deny rules or `local.deny` protect is never listed or read, so a vault anywhere below it cannot be ruled out: **a root that holds a protected folder is refused**, naming the folder, the same fail-closed rule as for unreadable evidence (the owner decision). The person points `corpus.paths` at a folder with no protected folder in it. A protected note (a file) is only skipped and counted as `protected`, since a file cannot hold a vault. Symbolic links and multiply-linked files are skipped and counted, and notes are opened with `O_NOFOLLOW` and checked against the walked identity. A note matching `signals.pii_patterns` (or whose pattern cannot be evaluated) is not indexed.
- **Index.** In memory, rebuilt at startup, incremental by device, inode, size and times: an unchanged note is not read again. It stores the id `note:<root label>/<path>`, title, frontmatter, tags, aliases, headings, wikilinks and a SHA-256, never the note's text, and it never writes into the folder. A refusal after a note was indexed drops that root's notes on the next refresh.
- **Parser.** `parseNote` reads flat frontmatter (`key: value`, `key: [a, b]`, block lists), ATX headings and `[[target#heading|alias]]` / `![[embed]]` links outside code, with caps on headings, links, tags and frontmatter size, and it reports `truncated`. It is not a YAML parser (zero runtime dependencies); nested maps are ignored.
- **Departures from the accepted plan.** `CorpusIndex.resolveLink` returns the matching `NoteRecord[]` (not ids), so a caller gets the title and path without a second lookup. `CorpusContext` has no `io` seam: the tests use real temporary folders, so the walk, the identity check and the vault refusal are exercised for real, and `piiPaths` and `deny` are optional (absent means none). Neither changes what the index accepts or refuses.
- **Not in this slice.** No daemon wiring or status line yet, no `ahub ask` or brief citations (AC2), no vault candidates (AC3, agent-mem) and no PII task handling downstream (AC4). The index is a library the next slice calls.

#### Corpus evidence in ask and task briefs (#510b)

- The corpus index retains structure, not bodies. Evidence reads reopen selected notes through current vault, deny and `pii.paths` checks, regular-file/no-follow identity and hash checks, and a full-text privacy screen before selecting any excerpt. A policy revision creates a fresh index. A PII question or private task context never queries corpus notes or shared observers.
- Retrieval is seeded from screened title, path, tags, aliases and headings. At most 32 candidate bodies are read, six evidence items are returned, each text is at most 768 UTF-8 bytes, and complete corpus evidence including ids fits 4096 bytes. A cut excerpt is marked. This bounded metadata-first slice does not claim a full-text search index.
- Evidence ids use `note:<root-label>/<path>#<heading-slug>`. Slugs preserve Unicode letters/numbers and deterministically disambiguate duplicates, including the headingless `top` section. Backslashes, commas, brackets and fragment delimiters inside id parts are escaped with a backslash; Unicode remains literal. Control-bearing or over-1024-byte ids are not published. Models must copy the complete escaped id exactly; invented note ids cause the answer to be discarded.
- Corpus rows supplement amem brief rows within the existing item cap. Plan fails retain priority and library ordering remains authoritative. Delivery dedupe, policy/task freshness and private-turn guards apply before retrieval and again before observation or delivery. Corpus rows are not counted as native memory rows.
- A PII ask remains evidence-only when campus status is false or unknown. On a positively confirmed campus gateway it uses `onCampusOnly: true` and pins the host's `routing.local.fixed_model` before any gateway await, using the existing repository on-prem rule. A changed socket, caller-private context or policy invalidates the result, as does a change to the PII or note-PII verdict of any gathered task row; unrelated board writes and public history/status changes do not invalidate snapshot evidence; a failed campus-only transport never falls back to a cloud call. No stronger provider trust tier is introduced here.

### On-prem web reading (#515), owner decision 2026-10-22

- `web_fetch` is refused for the whole turn of a PII task, whatever the host. The outbound URL or query could carry PII to the web, and `pii.paths` and `sanitize()` do not cover outbound requests.
- Outside PII turns it runs only through the egress proxy, to hosts in a machine-local per-project allowlist, and returns bounded text only.
- `doc_read` is unaffected by this rule; it keeps its own `pii.paths` and `data.readonly` checks.

#### On-prem document reading (#515a) implementation notes (hub task #320: `doc_read`, `src/local/doc-read.ts`)

Where the code states or fixes a detail the section above leaves open. `web_fetch` is a separate task and waits for its owner decision.

- **Opt-in.** `local.doc_read: true` (machine-local: in `MACHINE_LOCAL`, and never editable from settings) gives the local worker a `doc_read` tool. Off by default: `DOC_READ_SCHEMA` is not in `TOOL_SCHEMAS`, the worker offers it only when the daemon passes a `docRead` port, and a model that names it anyway gets "doc_read is not enabled". Pi shares `TOOL_SCHEMAS` and does not get it.
- **What it reads.** The model names `path` (and `offset`, `limit` as for `read`). The path goes through `guardPath` in read mode, the same guard as `read` and the one #418 shares (inside the project after `realPath`, no link out, no secrets denylist, `local.deny`). Then the file must be a regular file with one name and at most 16 MiB. The converter is the person's `text_projection` entry for the extension (PDF, DOCX, HWPX are whatever the person configured), run by `TextProjections` in its seatbelt profile on a private copy of the bytes, bounded by its input, time and output caps and cached by content in the hub state directory. An extension with no entry is refused with the way to configure one. The hub never picks a converter.
- **Screens, in order.** `pii.paths` by the document's path (`matchesPolicy`, so globs and folded spellings count): an ordinary turn is refused before anything is converted. After conversion, a text matching `signals.pii_patterns` (or a pattern that cannot be evaluated) is refused the same way. A PII task turn is the case these refusals point to, so it reads both: that is what the on-prem worker is for. Then `sanitize()` quotes any line that forges a hub header, and the output is cut at the shared output cap with how to continue (`offset`).
- **`data.readonly`.** A read is not a write, so the policy is not a reason to refuse. What it guards holds: the converter runs read-only in its sandbox, its cache is in the hub state directory, and `doc_read` writes nothing beside the document.
- **Never memory evidence.** Converted text is document content (a converter can surface hidden text), so the result is excluded from claude-mem capture and from the research observation on every turn, not only a PII turn.
- **Tests.** Fakes stand in for the projections (the converter itself is `text-projection.test.ts`'s subject); one macOS leg runs a real shell converter through `TextProjections`. The live leg on the on-prem worker with a real PDF, DOCX and HWPX converter is a separate person leg.
- **Not in this slice.** `web_fetch`, which waits for an owner decision, and an async conversion: it is synchronous in the daemon process, bounded by the converter's 8 s timeout (ponytail comment in `doc-read.ts`).

#### On-prem web reading (#515b) implementation notes (hub task #332: `web_fetch`, `src/local/web-fetch.ts`)

Where the code states or fixes a detail the section above leaves open. `doc_read` is unaffected.

- **Opt-in, per project.** `local.web_fetch: { allow: [hosts] }` in `.agenthub/config.local.json`. The tool exists for the local worker only when `allow` names at least one host: with the default (an empty list) `WEB_FETCH_SCHEMA` is not in the worker's tool list, no proxy is started, and a model that names the tool anyway gets "web_fetch is not enabled". Machine-local (`MACHINE_LOCAL`, so a committed config is ignored), never editable from settings (`NEVER_EDITABLE`), bound when the hub starts (`LOCAL_RESTART_REASONS`). Pi shares `TOOL_SCHEMAS` and does not get it.
- **The allowlist.** Each entry is a host name, optionally `:port` (443 unless named): letters, digits, `-` and `.`, at least one dot, never a scheme, path, wildcard, address or bare top-level name. At most 64, lower-cased and de-duplicated. It is checked by the pure `webFetchAllow` (`src/local/web-fetch-config.ts`, imported by the config schema, so it stays free of the disk and process modules the Claude channel bundle must not reach) when the config loads. A name also allows its subdomains, by the same `allowed()` rule the proxy uses.
- **PII, first.** `webFetch` returns the same fixed refusal for the whole turn of a PII task before it reads the URL, the allowlist or the proxy, whatever the host: nothing about the request changes the answer or the timing, and no request is made. The worker passes the turn's PII flag into the tool context (`toolContext`), as it does for `doc_read`.
- **Only through its own egress proxy.** The daemon starts a second `startEgressProxy` for `web_fetch` whose list is `local.web_fetch.allow` and nothing else (it follows a reload through `allowFn`). It is never the bash proxy: that one carries `network_allow` (package registries and code hosts by default), so listing a host for a model to read opens nothing to a shell command and the reverse. The proxy keeps its own rules: CONNECT only (TLS stays end to end), and a listed name that resolves to a loopback, private or link-local address is refused. With no proxy running the tool makes no request.
- **What the model controls.** Only `url`, `offset` and `limit`. The request is a bare GET with a fixed `Accept` and `User-Agent`: no method, header, body or proxy from the model. The URL must be https, at most 2000 characters, with no space or control character, no user name or password, no address literal, and a host (and port) on the list; a fragment is dropped. Redirects are not followed by the client (`redirect: "manual"`): each `Location` is resolved and checked against the same rules before it is requested, at most three.
- **What comes back.** Only `text/*`, JSON and XML types are read; anything else is refused without reading the body. The body is read at most 512 KiB deep (the stream is cancelled past it, never drained) within 15 seconds. HTML is reduced to text (scripts, styles, comments, `svg`, `head` and tags go, block tags break lines, a few entities are decoded), then `sanitize()` quotes a line that forges a hub header and the output is cut at the shared output cap with how to continue (`offset`). A failure is a fixed sentence plus at most an error code, never the error text.
- **Never memory evidence.** The result and the URL are excluded from claude-mem capture and from the research observation on every turn, like `doc_read`: a page is a third party's text and the URL is the model's own request.
- **Not in this slice.** There is no `ahub` command for it: the list is edited in `config.local.json`. A request is not asked of the person (the allowlist is the person's consent, given in advance). `robots.txt`, caching, cookies, authenticated pages and non-text types are not handled.

## Amendment: roles per SDLC stage (#525)

Written against main `8efdba48` (v0.12.45 + #671). Claims about current code carry `file:line` at that commit. "Probe" means a read-only `bun` run of `validateInstances` / `resolveSettledRoles` against that commit on 2026-10-22. Anything marked unverified was not run or read.

This amendment extends, and where stated replaces, the I2/I3 instance amendments (#450), Reviewer separation (#223), Reviewer pool (#519), Designated planner (#455) and S9 plan review (#481). Everything not named here keeps its current rule.

### Current state (what changes and what does not)

- Claude channel instances accept only roles inside `instances.roles: ["reviewer", "planner"]` (`src/adapters/definitions/builtin-metadata.ts:92`, checked at `src/hub/instances.ts:92-93`) and refuse `start_mode` and `worktree` (`src/hub/instances.ts:91`). A headless Claude instance must be exactly `["reviewer"]` and refuses `worktree` (`src/hub/instances.ts:87-89`). Probe: `claude-impl` with `["implementer"]` and a worktree is refused in both forms.
- Codex has no `instances.roles` ceiling (`builtin-metadata.ts:109`), so the headless branch skips the role check (`src/hub/instances.ts:95-98`). Probe: Codex instances with `["planner"]` (headless or no mode), `["reviewer"]` headless (native app-server), `["reviewer"]` + `review_mode: "fresh"`, `["implementer"]` + worktree, and `["conductor"]` are all accepted today. Probe also: a `local-*` instance with `["planner"]` is accepted, although `local` is excluded from `PLANNER_PEERS` (`builtin-metadata.ts:145`, `src/adapters/registry.ts:55`).
- Planner authority today is "holds the `planner` role in the settled map": `planningAuthority` (`src/hub/tasks.ts:833-835`), custom stage actor `planner` (`src/hub/tasks.ts:2511`), planner notices (`src/hub/tasks.ts:397-401`, `:426`, `:2236`). Several planners already work when no `planner` key is set (probe: `resolveSettledRoles` returns `planners: ["claude", "codex-plan"]`, source `roles`). The `planner` key pins one peer and only from `PLANNER_PEERS` (`src/hub/settled-roles.ts:18-23`); the loader throws on anything else (`src/hub/daemon.ts:289-291`) and the setting is an enum of `PLANNER_PEERS` (`src/hub/settings.ts:58`). Probe: `planner: "codex-plan"` is ignored and the source stays `roles`.
- S9 records `planReview: { planner: by, ... }` (`src/hub/tasks.ts:2491`) with no check that `by` did not write the plan (`src/hub/tasks.ts:2460-2491`).
- `assign()` picks owner and reviewer, never a planner (`src/hub/routing.ts:325`, `Assignment` at `:302-319`). The reviewer is never the current owner (`not` = `reviewOwner`, `src/hub/routing.ts:494`, `:541`). Former owners of the task are not excluded (no history read for that purpose; unverified beyond `routing.ts:483-560`).
- A declared extra owns `implement`/`bulk_edit`/`test` only with the implementer role and `ownerIsolation[id] === true` (`src/hub/routing.ts:400-403`); the daemon sets it only for an adapter the hub started in a verified noncanonical root (`src/hub/daemon.ts:1346-1349`). A person-started channel instance never gets it.

### R1. Role capability per kind and form

One capability rule, read by `validateInstances`, `loadConductorPolicy` and `assign()`:

- **Planner** requires the base kind's `projection.plannerEligible === true` (the field `PLANNER_PEERS` is derived from, `src/adapters/registry.ts:55`). True for claude, codex, kimi, qwen, jcode; false for pi, local, agy.
- **Every other flow role** requires membership in the resolved runtime definition's `instances.roles` (`src/adapters/registry-types.ts:205`) when it is set, and in `routing.allowedRoles` (`registry-types.ts:261`) when that is set. Unset `instances.roles` keeps today's behaviour (no instance ceiling).
- The form is the runtime definition: the base definition (terminal/channel form for claude; app-server for codex) or a variant chosen by `resolvedDefinition` (`src/adapters/registry.ts:110-118`). Each variant carries its own `instances.roles`.

Capability table after this amendment (P planner, I implementer, V verifier, R reviewer):

| Kind | Form | Roles | Notes |
|---|---|---|---|
| claude | channel/terminal (base, `instances.mode: "external"`) | P, I, V, R | I or V requires `worktree` (R5 terminal) |
| claude | headless reviewer variant (#223) | R only, exactly `["reviewer"]` | unchanged |
| claude | headless implementer variant (new) | I, V; must include I | requires `worktree`; refuses P and R |
| codex | app-server (headless start, TUI attach) | P, I, V, R, conductor | unchanged; no ceiling added |
| codex | fresh reviewer variant (#519) | R only | unchanged, `review_mode: "fresh"` |
| kimi, qwen, jcode | unchanged | unchanged | planner allowed only through `plannerEligible` (already true) |
| pi, local, agy | unchanged | planner refused | new refusal, see below |

Validator changes (`src/hub/instances.ts`):

1. `builtin-metadata.ts:92`: claude base `instances.roles` becomes `["planner", "implementer", "verifier", "reviewer"]`.
2. New `CLAUDE_IMPLEMENTER_VARIANT` beside `CLAUDE_REVIEWER_VARIANT` (`builtin-metadata.ts:72-81`), exposed as `headlessVariant` on the claude definition, with `instances: { mode: "headless", roles: ["implementer", "verifier"] }`, `transport: "hub-native"`, `start.forms: ["headless"]`, `start.create: createClaudeImplementer`, `budget: { account: "claude" }`, no `routing.reviewOnly`. External and configured definitions cannot declare `headlessVariant` (same rule as `reviewerVariant`, `registry.ts:219`, `:235`).
3. `resolvedDefinition` (`registry.ts:110-118`): order is reviewer variant (unchanged condition), then `headlessVariant` when the declaration is a non-builtin id with `start_mode: "headless"` and roles do not equal `["reviewer"]`, then the base.
4. External branch (`instances.ts:84-94`) becomes:
   - `start_mode: "headless"` with roles exactly `["reviewer"]`: reviewer variant, `worktree` refused (unchanged, `:87-89`).
   - `start_mode: "headless"` otherwise: implementer variant. Roles must be a nonempty subset of `["implementer", "verifier"]` containing `implementer`; `worktree` required; `permission_mode` limited to `ask` or `ask-when-needed` (default `ask-when-needed`); `never-ask` refused with "a headless Claude implementer has no hub sandbox; never-ask is unavailable". `review_mode` refused.
   - No `start_mode` (terminal): roles nonempty and inside the base ceiling. `worktree` required when roles include `implementer` or `verifier`, refused otherwise (planner/reviewer channel instances stay on the project checkout, as I3). `permission_mode` stays refused (Claude's terminal mode is the launcher's, as today).
5. Planner check, all branches: a declared or policy role `planner` on a kind with `plannerEligible !== true` is refused at validation ("this kind cannot plan"). This is new for `local-*` and `pi-*` instances (probe shows `local-x` `["planner"]` accepted today). `loadConductorPolicy` drops a `roles.<peer>` planner entry for such a kind with the existing ceiling notice (`src/hub/daemon.ts:283-286`), never throws.
6. Error text in `:89`, `:91`, `:93` is replaced; no other branch changes.

Still refused: a headless Claude planner (plan from a channel instance); a headless Claude instance mixing reviewer with implementer/verifier (a fresh reviewer is read-only by construction; a writing session never reviews); `worktree` on any reviewer or planner-only Claude instance; external/configured kinds as instance kinds (`instances.ts:68-69`); `start_mode` other than `"headless"` (`instances.ts:107-108`); everything `routing.allowedRoles` excludes (agy).

### R2/R4. Stage holders and independence

Stage to role, fixed:

| Stage base | Holder | Picked by |
|---|---|---|
| intent, spec, plan | the task's planner (R3) | `assign()` planner walk, or the person |
| build, test | the owner: implementer (verifier for `test` class may hold it as today) | `assign()` owner walk (`routing.ts:471-479`) |
| review | the reviewer | `assign()` reviewer walk (`routing.ts:483-560`), pool #519 |
| merge, release | the person, or the task's/release's planner | unchanged authority, now per task/release (R3) |

- Explicit holders per stage are the existing knobs, not a new lifecycle store: `[classes.<class>].peers` in `routing.toml` for owners, `[classes.review].peers` and `review.pool` for reviewers, the `planner` setting (now a list, R3) for planners. Custom stage `actor` (#257, checked at `tasks.ts:2511`) keeps its four values; `planner` there now means the task's planner (R3), `owner/planner` likewise. No per-stage holder list is added to lifecycle config (ponytail: add `stages[].holders` only if a project needs a holder set that differs from the role's holders).
- Each holder is chosen by its own walk over its own candidates. A multi-role peer appears in each walk where it holds the role. The walks share only these independence rules:
  - **I-1 (existing).** The reviewer is never the current owner, by id (`routing.ts:494`, `:541`).
  - **I-2 (new).** The reviewer is never a peer that implemented this task: any peer with an `accepted` or `done` history entry `by` it on this task, read from `task.history` inside `assign()`. Refusal code `policy`, reason `implemented this task`. When this empties the candidates the reviewer is the person (`reviewBlocked`), never a fallback to an implementer.
  - **I-3 (existing, #519).** Other family first; own family only when no other is eligible, recorded as `sameFamilyFallback=true` (`routing.ts:547-550`).
  - **I-4 (new, enforced in `Tasks.recordPlanReview`, not in `assign()`).** The plan author does not record the plan review of that plan. Plan author: `by` of the latest plan-authoring history entry with `planRevision`, then a legacy authoring entry whose `planning.fields` includes `plan`. Exclude `plan reviewed` entries from both paths: review/CI scope bookkeeping never changes the plan-content author. When only the initial proposal remains, use its author only if intent list fields are nonempty; review/CI scope alone leaves the author unknown. A later actual plan edit or explicit intent removal records its own author. If the caller is the author and another planner holder is rostered and not offline, refuse pre-effect ("an independent planner reviews this plan"). If the caller is the author and no other holder is eligible, record the receipt with `selfReview: true` (the single-planner case keeps working).
    - **Independent reviewer authority.** Recording a plan review is the one planner act that is not limited to the task's planner: any current settled planner holder other than the plan author may record it, and so may the person. That is what keeps I-4 from deadlocking against R3's per-task authority. The review is the only power this grants: the reviewing holder still cannot plan, split, pull, undo, cancel, reassign or release the task (R3). When the effective planner is the author and an independent holder is eligible, the hub sends that holder a plan-review request (ids only, through `publicView`), chosen by the same rotation as R3 and excluding the author. Unknown author records `planAuthor: null` and does not refuse. The receipt gains `planAuthor`.
  - Planner and owner may be the same peer; planner and reviewer may be the same peer (today's default `claude: [planner, reviewer]`). I-4 covers the only conflict between them.
- **Purity.** The planner walk runs inside `assign()` with the same inputs it already takes plus `planners` (sorted settled holder ids) and `namedPlanner`. `Assignment` gains `planner?: PeerId` and `plannerReason?: "rotation" | "named" | "kept" | "none"`. Every caller that routes a new or pulled task reads the planner from this result; `ahub route explain` prints the same walk (`planner candidate X: ...` lines, then `planner: X (reason)`), so explain and assignment cannot drift. `Tasks` never chooses a planner outside `assign()`.

### R3. Per-task planner

- **Field.** `tasks.planner TEXT NULL` (board migration beside `src/hub/board.ts:223`). `releases.planner TEXT NULL` likewise. `null` is legacy: any current planner holder acts, exactly as today. Existing rows keep `null`; no backfill.
- **Setting.** `planner` accepts a string (one pinned planner, unchanged) or a list of up to 8 distinct ids. Each id is a builtin in `PLANNER_PEERS` or a declared instance id whose capability (R1) includes planner. The listed ids are the only planner holders (the exclusive rule of `settled-roles.ts:20-23`, applied to each). `SettingDef` type changes from `enum` to `peers` (the type exists, `src/hub/settings.ts:27`). A one-element list is written back as a string so an older daemon still loads it. `loadConductorPolicy` (`daemon.ts:289-291`) validates against the startup-bound catalog instead of `PLANNER_PEERS` alone. `resolveSettledRoles` takes `planner: string | readonly string[] | undefined`; `source` values are unchanged; automatic fallback (`settled-roles.ts:25-31`) still picks one builtin.
- **Choice.** At `propose` (after the PII screen and the board insert, in the same flow that records the owner assignment) and at backlog pull when `planner` is `null`:
  - a person-named planner (`namedPlanner`) is exact, refused like a named owner if not a holder (#601 rule);
  - otherwise rotation: holders sorted by id, start at `task.id mod holders.length`, walk forward skipping off-roster, offline, paused (`budget_paused = skip_peer`), failing and `routing.allowedRoles`-excluded holders; do not renumber by availability (the #519 seed rule). If all are skipped, take the seed holder with reason `rotation (none available)`.
  - PII tasks get `planner: null` and trace `planner: none (pii)`; their planning stays as today (stubs only, person acts).
  - The choice is written on the `assigned` (or `backlog pulled`) history entry as `planner` and `plannerReason`, through the same metadata path as `reviewerFamily`/`reviewerReason`. A fixed pure host port binds every new proposal, split child and generated backlog card in its original insert transaction, with planner metadata on the initial `proposed`/`backlogged` entry. Notifications never expose an unbound intermediate new row, and split undo keeps its original child snapshot.
- **Effective planner.** `Tasks.taskPlanner(task)`: `task.planner` when it is still a settled planner holder and rostered; otherwise all current holders (legacy). A pause or offline state does not move it; the person moves it. Routing explain uses the bound planner as `keptPlanner` and names it as `kept`; a draft or legacy null binding still runs rotation. Explaining either form writes no binding or history.
- **Authority.** `planningAuthority(by)` (`tasks.ts:833`) becomes `planningAuthority(by, task?)`: with a task, `by` must be the person or the task's effective planner; without one (backlog list, release list, new release, grooming read, import) any holder, as today. Every call site that has a task in hand passes it: pull (`:892`), plan (`:1035`), undo (`:1089`), split (`:1148`), assign/configure/cut release (`:1218-1286`, against `releases.planner`), plan review (`:2461`, which follows I-4's independent reviewer rule instead of the task-planner check), planner cancel (`:2247`), and the custom stage actor (`:2511`). Rechecks after awaits keep their places. Grooming reads stay project-wide; grooming, sweep and stall notices (`:397-401`, `:426`, `:2236`, `:938-971`) go to the task's effective planner only.
- **Planner lifecycle stage identity.** The effective task planner may record only `stage`, `repo` and `issue` when an explicitly supplied stage has actor `planner` or `owner/planner`. Existing enforce relink and stage/spec gates still apply; advise retains its existing identity relink behavior. This grants no reviewer evidence, checklist, head or deliverable authority.
- **Naming.** `ahub task assign <id> <peer> --role planner` (person only; `TaskAssignmentRole` gains `planner`, `src/hub/tasks.ts:42`; parsers `src/cli/main.ts:1292`, `:2109`; help `src/cli/help.ts:86`). A planner cannot reassign planning to another peer. The write is a `planner changed` entry (reason `named`), which neither moves nor settles the task, so it never counts as supersession of an owner delivery (tasks.md assignment rule). `hub_task_assign` with role `planner` from a peer is refused pre-effect.
- **Release planner.** `newRelease` records `by` as the release's planner (`null` for the person); cut/configure/assign check it like a task's.
- **Migration.** No `planner` key and one planner holder: rotation always yields it. A single pinned planner: same. Old rows and old releases: `null`, legacy authority. Tests that assert a planner tool succeeds for the only planner stay green unchanged.

### R5a. Headless Claude implementer

Declaration: `"claude-impl": { "kind": "claude", "roles": ["implementer"], "start_mode": "headless", "worktree": ".worktrees/claude-impl" }`, optional `permission_mode: "ask" | "ask-when-needed"`.

- **Worktree.** The I2 rule: an explicit registered worktree at `<project>/.worktrees/<id>` with an attached branch, resolved by `resolveInstanceExecutionCwd`. The hub creates no worktree or branch (I4 orchestration stays a follow-up); the implementer switches task branches inside it. `executionOwners` is set for the started peer, so `ownerIsolation` holds (`daemon.ts:1346-1349`).
- **Start.** `ahub claude --as <id>`, the console and the dashboard ask the hub to start it (as #223). It holds no process while idle.
- **One session per task.** For a delivery the peer groups envelopes by `refs.task` and runs one child at a time, in the worktree:
  - first turn of a task: `--session-id <new uuid>`, session persisted (no `--no-session-persistence`);
  - later turns: `--resume <that task's uuid>`; never `--continue`, never `--fork-session`, never another task's id;
  - the task-to-session map is a per-peer state file named through `claudeStateFile(<id>, ...)` (daemon.md rule), listed in `sessionPointers` (`src/cli/reset.ts`);
  - a newly reserved UUID becomes resumable only after a stream-json frame names that exact session; a failed start before such evidence retries with `--session-id`, never a speculative `--resume`;
  - a missing transcript (positive ENOENT through `transcriptPersisted`) starts a new session for that task and records `fresh` with a console notice; any other read error keeps the recorded id;
  - chat with no task reuses a task's session only when the instance owns exactly one `in_progress` task. With none, or with more than one (a raised `tasks.wip_limits.<id>`), it goes to a one-off child with `--no-session-persistence`, so unscoped chat never enters an arbitrary task's context or attribution.
- **argv.** `-p --output-format stream-json --verbose --strict-mcp-config --mcp-config <tools-mode server for <id>> --setting-sources "" --settings <0600 managed settings file with the PreToolUse facts hook, purpose permission> --permission-mode default --permission-prompts host --permission-prompt-tool mcp__agent-hub__hub_permission_request --allowedTools <implementer hub tools>`. No `--bare` (it skips hooks, `claude --help` 2.1.307). No `dontAsk`, no `bypassPermissions`. Verified on Claude Code 2.1.309 with a real native binary and a deterministic loopback model-protocol/MCP fixture, without account authentication or model inference: `docs/verification/2026-10-23-headless-claude-permissions.md`. Only a compat-admitted native version and unchanged binary may start; the receipt is evidence for the contract, not a runtime receipt gate. Real provider/model/person-approval behavior remains a live leg.
- **Hub tools.** The implementer set (`hub_task_accept`, `hub_task_decline`, `hub_task_done`, `hub_checkpoint`, `hub_send`, `hub_task_show`, `hub_task_propose`, `hub_remember`, `hub_inbox`, `hub_permission_request`) through the ordinary tools-mode server with `AGENTHUB_PEER_ID=<id>` and a per-child `AGENTHUB_LAUNCH_ID`. The daemon accepts a `tools` hello for this id only with the current child's launch id; it is revoked when the child's group is confirmed gone. `hub_inbox` may pull only a batch whose host-resolved task attribution matches the current child, using the same unique-task rule for unscoped chat as delivery. A mixed-task batch is refused before any queue removal, so other tasks reach their own child/session.
- **Permissions.**
  - `ask`: the hook decides nothing; every write, edit and shell call reaches the prompt tool.
  - Both modes run Claude in its `default` permission mode, never `acceptEdits`: `acceptEdits` auto-approves in-worktree edits before the hook's path gate or the prompt tool is consulted, so protected paths (`.agenthub`, agent configuration, unsafe aliases) could be written without a person. File grants come from the hook's explicit `allow`; automatic shell grants use only the host wrapper described below (#845).
  - `ask-when-needed`: the hook answers `allow` only for `projectFileTool` targets with `projectRoot` = the execution root (worktree), so `.git`, `.agenthub` and agent configuration stay protected (`src/cli/facts-hook.ts:20-54`, `:91-96`). Bash reaches the prompt tool; a complete, public command may get the #845 wrapper grant below. Unproven calls and every enabled action-policy class still ask. `never-ask` remains refused (R1).
  - The daemon puts `permission` in a `facts` reply for this instance's current child launch id, as it does for the recorded `ahub claude` launch (daemon.md facts-hook rule extended to this one case).
- **Person approvals.** `hub_permission_request` (tools-mode server, callable only by this variant's current child) puts the request on the existing approval path: console `permission` push, macOS notification (#5), `approvals.timeout_s`. Payload is the tool name plus a public rendering of the arguments made by a bounded generic sanitizer, not `Tasks.publicView` (that takes a `Task`): JSON-stringify, `sanitize()`, the PII screen used for public metadata text (a match replaces the value with `[withheld]`), path values through the same screen, then a cut at a character boundary with a `[cut, N chars]` marker inside the 600-character title bound (#72 rule). It never includes task text. The original arguments stay in the child's pending request and are what Claude's allow response refers to; they are not logged or shown. Options are allow-once and deny; no allow-always. While a request waits, the watchdog is kept alive (as ACP, #5).
  - **No answer.** At `approvals.timeout_s` the tool returns deny with "no person answered"; Claude continues the turn with the denial; the delivery is not failed by the timeout itself; a console and log line is written.
  - **Hub down or refusing.** The prompt tool returns deny. The native model-free fixture observed no write when the permission tool was missing, returned an error or disconnected. A pending native permission request was externally stopped after 25 seconds with no write; a native internal timeout was not established. The hub's own approval deadline returns deny and does not rely on that native timeout.
  - **Hook down.** Decides nothing (`facts-hook.ts:6`), so the call reaches the prompt tool. A valid person allow still authorizes the call; failure of the prompt, its deadline, its connection or its current-child fence supplies no allow. The native fixture observed both deny and allow after a failing hook.
- **Lifecycle.** The #223 guarantees, shared code, not a copy: extract the spawn (`detached: true`, own process group, `src/adapters/reviewer-print.ts:315`), watchdog and group kill from `ReviewerPrintPeer` into one helper used by both. Stop fences the generation before any await, holds the delivery `needs_review`, keeps the peer busy until the group is confirmed gone and offline only after (`reviewer-print.ts:153-164`); a failed cleanup keeps it busy and refuses a start. A start failure before the child runs is `failed_safe`; after, `needs_review`. A watchdog timeout ends the turn, not the task: the task stays `in_progress` with this owner, and the next delivery resumes its session.
- **Delivery.** Ordinary implementer delivery (task and chat items). Inadmissible notices or foreign task refs are dropped without vetoing admissible items in the same batch; a batch with no releasable input settles `failed_safe`. Private envelopes remain refused before spawn. The #223 R2 review-only filter does not apply (it keys on roles exactly `["reviewer"]`).
- **Usage.** Tokens from the child's `result` event `usage` (as `claude-print.ts:82-85`), added to the peer and attributed per task (#200). Account `claude`, shared pauses and readings (I2). Quota windows come only from the account's existing reader (the terminal statusline tee); none is classified from result text. A `result` with an error subtype is a failed turn, not a quota reading (unverified whether 2.1.307 emits a distinct rate-limit result).
- **Done.** `hub_task_done` from the child completes the task through `Tasks` with the ordinary owner check (`by === task.owner`), then the reviewer is notified (I-2 excludes this instance from reviewing it).
- **Recovery.** `session.freshOnRestore` is false; crash resume reuses the per-task map, and each task's session is checked by transcript as above. No terminal row. Controlled recovery requires target feature `role_stages` (below).

### Headless implementer host shell execution (#845)

The 2026-10-26 amendment permits automatic Bash execution only in `ask-when-needed`, for a current non-private task owned by this child in its verified registered worktree. `ask`, PII handling, native `default` mode and enabled action-policy classes retain person approval. A client must explicitly support wrapper protocol 1; an older MCP client cannot receive an automatic allow that would run the original native command.

- The existing #816 `proveReadOnlyShell` supplies read-only authorization, including its parser, executable and path/config proof; there is no second read-only policy. Task commands use the same simple-shell parser and a closed argv grammar: `scripts/check.sh --changed`, `bun run build`, `bun test` with 1 to 16 explicit `test/**/*.test.ts` paths, `git add` with named paths, `git commit -m <message>`, `git push origin <branch>` or `git push -u origin <branch>`, and branch-selected `gh pr view`, `checks` or `create`. Creation requires the default base, bound head, title and exactly one body or body-file. Operators, expansions, extra flags, another remote/branch, background execution and model cwd fields ask.
- The host captures the canonical repository default branch once at daemon startup, before task execution, from a bounded remote `ls-remote --symref` probe against the captured GitHub repository URL with private HOME/cwd and isolated Git configuration. Each request reads attached HEAD against that captured name; a later mutable local origin/HEAD never changes this authority. No credentials are supplied to this probe. Missing/private-remote startup evidence asks until a restart with available remote evidence. A recorded task branch must match. Otherwise the first eligible task-command request may bind a non-default branch, excluding `main`, `master`, detached/unknown HEAD and another open task's branch. `Tasks.bindShellBranch` records `refs.branch` plus a host history entry containing the branch and a hash of the canonical worktree. Restart retains the binding; a later branch or root mismatch cannot rebind it. Path guards and instruction/data policy still apply. Git effects use the core hardened argv/environment; origin fetch and every push URL must match the project's captured GitHub repository for push/PR grants, and `gh` gets an explicit host repository selector. Push executes the explicit same-branch refspec `refs/heads/<bound>:refs/heads/<bound>`; configured remote.origin.push or mirror refuses. A body-file is bounded, public-text screened and captured into the executed `--body` bytes, so the privileged CLI never reopens a mutable file.
- An automatic allow returns fresh `updatedInput` containing a fixed absolute hub wrapper invocation and a random single-use ticket. Native shell cwd, PATH and environment select neither the command nor its authority. The grant record is held in bounded, expiring host memory; its opaque nonce is visible to the requesting MCP call and wrapper argv. A model-selected permission call can therefore receive a ticket and record a branch binding after the same host checks; ticket possession is not native-dispatch provenance. The record binds task, peer, current child generation, canonical root, branch, exact parsed/effective argv, executable, environment and proof recheck. It is consumed before validation or execution; restart revokes all tickets. Unknown, expired, reused or mismatched tickets run nothing and return the fixed refusal `host shell execution refused`.
- The private Unix-socket execution service rechecks current child/task/root/branch and proof immediately before spawning the resolved absolute executable at the proven cwd. Read-only grants and check/test/build task grants retain the local-worker Seatbelt profile and own-temp rules. An additive deny-only profile forbids every write to project Git common/current metadata, including loose/packed objects, HEAD/index, refs/logs, other worktrees and shared/private submodule config/hooks/config.worktree. Directory entries cannot be renamed or replaced. Unknown layouts ask. Closed host Git add/commit run outside that profile, like push/gh: only parsed bounded paths/messages, with root/task/branch proof rechecked. Configured filter and external diff/textconv drivers refuse add/commit only; push/gh do not run clean/smudge and remain eligible with global filter.lfs. The chosen policy is person approval for add/commit, not neutralizing filters. Config includes and partial clones still refuse privileged Git/gh; fixed argv disables signing, automatic maintenance, hooks and fsmonitor. Credential denies remain for code, and canonical live hub state is denied even with a primary-checkout read allowance. Network follows local.bash_network: normal enabled mode uses the configured proxy, while the explicit "direct" setting gives gate code direct network access. Without macOS sandbox-exec these commands ask. Only closed host git-add/git-commit/git-push and gh operations remain outside that profile. Its environment is the #816 host baseline (`PATH`, `HOME`, `LANG`, `TERM`), fixed proxy and peer identity, plus an owned command TMPDIR; Project/worktree PATH entries and aliases are removed before proof and execution. Git receives only the core's fixed hardening variables; gh receives that same core configuration through GIT_CONFIG_COUNT/KEY/VALUE for its Git children. No inherited native environment or authentication value is copied into `updatedInput`. Output streams and numeric exit status pass through. Child abort, disconnect and shutdown terminate only the command's owned process group. A target that deliberately starts a new session with setsid can outlive that cleanup; such a descendant keeps its Seatbelt restrictions and may keep writing the permitted worktree paths. This is not an all-descendants termination guarantee.
- The dated model-free native receipt must cover modified input, an earlier persistent-shell `cd`, spaces/apostrophes, poisoned native `RIPGREP_CONFIG_PATH` and `GIT_DIR`, and ticket replay refusal. Native transport evidence, host fixture tests, package gate and real-account behavior are distinct evidence classes. The executable task commands use the host profile above; this does not sandbox the entire native Claude process.

### R5b. Terminal Claude implementer

Declaration: `"claude-impl-t": { "kind": "claude", "roles": ["implementer"], "worktree": ".worktrees/claude-impl-t" }`.

- `ahub claude --as <id>` (`src/cli/launch.ts`) resolves the execution root with `resolveInstanceExecutionCwd`, starts Claude with that cwd, and records `executionCwd` in `claude-launch.<id>.json` beside `launchId`. The hub never starts it (daemon.md: channel extras stay out of `STARTABLE_PEERS`).
- The channel's hello gains an optional `cwd` (realPath of the MCP server's `process.cwd()`); additive, no `PROTOCOL` bump. Verified model-free on Claude Code 2.1.309: an actual stream-json session initialized its stdio MCP server in the session cwd with no user/model turn. Receipt: `docs/verification/2026-10-23-terminal-claude-execution-root.md`. The optional hello uses that server cwd. Other native versions or intentional native cwd changes are not certified by this receipt; missing or different cwd never proves ownership.
- **Admission as owner.** At attach the daemon sets `executionOwners[id]` only when all hold: the hello's `launchId` is this instance's current launch record (#551); the record's `executionCwd` equals `executionRoots[id]`; the reported `cwd` resolves to the same root; the root is not the canonical cwd. Otherwise the peer attaches as before but `ownerIsolation[id]` stays false, so `assign()` refuses it as a code owner (`routing.ts:402`) and status says why. Detach, a new launch id or a changed root clears it.
- The facts reply's `projectRoot` for this instance is its execution root, so ask-when-needed grants are worktree-scoped. `never-ask` follows the terminal's existing rules.
- Terminal recovery records `terminalRoot` = the verified execution root (I2 permits it); the I3 line "terminal recovery (project root, no worktree)" is amended for implementer channel instances only.
- Ceiling: the root evidence is reported by same-user processes the hub launched, not kernel isolation; it carries the same trust as launch records (#240 boundary).

Headless and terminal forms of one kind coexist as separate ids. Neither reviews a task it implemented (I-2).

### R6. Codex planner and reviewer instances

- Reviewer: done (#535, `review_mode: "fresh"`); native continuing `["reviewer"]` instances keep #519's rule. No change.
- Planner: a Codex instance whose roles hold `planner` and neither `implementer` nor `verifier` is a planner instance. It is accepted today (probe); this amendment adds:
  - no worktree (refused, it plans on the project checkout);
  - its app-server threads start with the read-only sandbox: the host supplies a `CodexOptions.threadSandbox` value or host-only live getter (`"read-only" | "unavailable" | undefined`), and both `thread/start` and `thread/resume` send `sandbox: "read-only"`. The matching native reply must carry the known top-level `sandbox: { type: "readOnly", networkAccess?: boolean }` policy; missing, malformed or writable policy refuses that thread RPC and closes the unconfirmed link before adoption or hub delivery. The live getter is rechecked at thread admission, reply and hub injection: a live role transition cannot reuse a writable or unconfirmed thread as a planner, and a planner with a declared worktree is unavailable. Getter failure is unavailable. The hub start RPC only opens the proxy, never creates a host thread or waits for a TUI-created one. Request/response shapes are model-free schema evidence from Codex CLI 0.164.0, not a native/account execution receipt. Unknown is never read-only. The attached TUI is the person's and may change later native turn policy; this remains a ceiling, not a locked sandbox claim;
  - owner admission already refuses it for code classes (no implementer role, `routing.ts:401`); it may own `plan`-class tasks.
- Claude planner instances stay channel instances (I3). For a declared planner-only Claude instance the authenticated facts pre-reply carries `mutationGrants: false` and lowers the existing `permission` field to `ask` for every non-read call, so older hooks also receive no automatic mutation grant without changing the person's runtime mode; the hook grants nothing for mutating file tools, shell or unknown tool kinds, whatever its permission mode; Claude's own prompt goes to the person in that terminal. The builtin `claude` is unchanged.
- Planning writes go through `Tasks` as today.

### R7. Visibility

Additive optional fields, no `PROTOCOL` bump (daemon.md):

- Status `roleInfo[peer]` (`daemon.ts:2795`) gains `form` (`channel` | `headless` | `terminal-implementer` | builtin form) and `capableRoles`; `planner` (`daemon.ts:2796`) keeps `{ peers, source }`.
- `ui_snapshot` task rows and `ahub task show` gain `planner` and `plannerReason`; owner and reviewer rows show the reason already recorded (`reviewerReason`, `sameFamilyFallback`, reservation, named).
- Dashboard task detail (`src/ui/index.html`) and the console Tasks panel show planner, owner and reviewer with reasons.
- `ahub route explain` prints the planner walk (R2 purity).
- Status lists `ownerIsolation` per extra as `isolated` / `not isolated: <reason>` (ids and fixed reasons only).

### Interactions

- **PII.** Unchanged gate in `assign()`: PII owners only `trust.onPrem` (`routing.ts:408`), reviewer the person. Both new Claude forms are cloud peers and never own PII work. PII tasks get no rotated planner. A headless Claude child never receives a private envelope (refused before spawn, as `reviewer-print.ts` does for reviews). PII-turn refusals (`hub_remember`, `hub_task_propose`, release tools, memory reads) apply to the on-prem worker as today; no new tool is callable in a PII turn. `hub_permission_request` payloads go through the bounded generic sanitizer defined under R5a Person approvals.
- **Planner WIP cap (#655).** Unchanged: `reservedHold`/`acceptanceCapacity` key on the reserved owner and `wipLimit(owner)` (`daemon.ts:1350`, default 1). Each new instance has its own `tasks.wip_limits.<id>`. Planner pull requires the card's effective planner (R3); `plannerRefusal` text stays ids and counts.
- **Budget pauses.** The Claude implementer shares the `claude` account's pauses and readings (I2). A pause holds new deliveries; a running child finishes its turn (not killed by the pause). Rotation skips paused planners at choice time only; a later pause does not move a task's planner. Reviewer pool behaviour is unchanged.
- **Always-ask (#636).** Not a dependency. When #636 lands, its classifier runs in the same PreToolUse hook; an `ask` from the hook in `-p` mode reaches `hub_permission_request`, which carries the class and applies the class budget. Since the headless variant has no `never-ask`, #636 only adds the class label there. #636's adapter table must list both new Claude forms; both have the hook, so neither is "always-ask not enforceable".
- **Recovery.** Target feature `role_stages` retains its Claude implementer and Codex planner-only instance meaning. Slice 525-2 adds `task_planners` to `DAEMON_FEATURES` and `incompatibleRecoveryTarget` (daemon.md floor rule), required while a `planner` setting is a list or names an instance, or a declared instance holds planner, and while any task or release has a non-null `planner` or plan-review authorship markers remain in its receipt/history. A 0.15.0 daemon already advertises `role_stages` but ignores task/release planner bindings; recovery to it must refuse before any effect. The floor reads bounded SQL `EXISTS` evidence, not only config. Old board parsing tolerates the additive nullable columns without changing legacy null authority (verified with the published 0.15.0 Board parser).
- **Settings.** `planner` stays a guarded settled-holder key (`roleHolders`, `daemon.ts:4431-4435`); a list change goes through the same confirmation.

### Acceptance (from the issue, mapped)

- AC-1 Config: Claude `["implementer"]` + worktree accepted as terminal and as headless; Codex `["planner"]` and Codex `["reviewer"]` headless accepted (already true, kept by regression tests); planner on pi/local refused; headless Claude `["planner"]`, `["implementer","reviewer"]`, implementer without worktree, `never-ask` refused.
- AC-2 Pure `assign()` matrix: planner, owner, reviewer picked by separate walks; a multi-role holder never reviews its own or a former implementation (I-1, I-2); planner rotates by `task.id mod n` over three holders; route explain output equals the assignment trace.
- AC-3 Daemon test: one task planned by `codex-plan`, built by headless `claude-impl` in its worktree with `ownerIsolation` true, reviewed by `codex-review` (fresh); each history entry names its holder and reason.
- AC-4 Fake `claude -p`: same-task turns pass `--resume <same id>`, a new task gets a new `--session-id`; writes outside the worktree and to protected paths get no `allow` and reach the prompt tool, which denies on timeout and on hub failure; watchdog, stop and group cleanup match the reviewer tests; `hub_task_done` from the child completes the task; a stale child's launch id is refused.
- AC-5 Planner tools refuse a peer that is not the task's planner, the person still acts, a single pinned planner and `null`-planner rows still work; I-4 refuses own-plan review with another eligible planner and records `selfReview` without one.
- AC-6 Live six-instance run (#138 I4 leg) recorded in `docs/smoke.md`.

### Implementation slices (dependency order)

1. **525-1 Roles capability and validator.** Size M.
   - Paths: `src/adapters/definitions/builtin-metadata.ts`, `src/adapters/registry.ts`, `src/adapters/registry-types.ts`, `src/hub/instances.ts`, `src/hub/daemon.ts` (`loadConductorPolicy` planner drop only), tests `test/instances*.test.ts`, registry conformance.
   - Adds the capability rule, the claude base ceiling, a `headlessVariant` slot (definition stub refused at start until 525-4: "headless Claude implementer is not available in this release"), the new branches and refusals.
   - ACs: AC-1. Registry seeds and baseline unchanged except named reanchors.
2. **525-3 Stage mapping and independence in `assign()`.** Size M. Depends on 525-1.
   - Paths: `src/hub/routing.ts`, `src/hub/tasks.ts` (call sites pass `planners`/`namedPlanner`, explain), `test/routing*.test.ts`.
   - Planner walk, `Assignment.planner`/`plannerReason`, I-2, explain lines. No board write of the planner yet (result unused until 525-2).
   - ACs: AC-2.
3. **525-2 Per-task planner.** Size L. Depends on 525-3.
   - Paths: `src/hub/board.ts` (columns, migration), `src/hub/tasks.ts` (`taskPlanner`, `planningAuthority(by, task)`, notices, I-4 in `recordPlanReview`, release planner), `src/hub/settled-roles.ts`, `src/hub/settings.ts`, `src/hub/daemon.ts` (loader, status, `task_planners` floor for list/instance planner), `src/cli/main.ts`, `src/cli/help.ts`, verify parser/help parity; leave `docs/verified.json` stamps to the release PR, because this feature PR is squash-merged.
   - ACs: AC-5.
4. **525-4 Headless Claude implementer.** Size L. Depends on 525-1 (and 525-2 only for the daemon test's planner).
   - Paths: new `src/adapters/claude-implementer.ts`, shared child helper extracted from `src/adapters/reviewer-print.ts`, `src/adapters/definitions/builtin-metadata.ts` (variant), `src/hub/daemon.ts` (start, facts permission for child launch id, tools hello fence, `executionOwners`, `role_stages` floor), `src/hub/claude-state.ts`, `src/cli/reset.ts`, `src/hub/hub-tools.ts` (`hub_permission_request`, published only to this variant's child) and `src/adapters/claude-channel.ts` tools mode (rebuild `plugins/agent-hub/server.js`), `test/fakes/` fake `claude -p`.
   - Includes the `--permission-prompt-tool` probe gate.
   - ACs: AC-4, AC-3 (with 525-6 for `codex-plan` and #535 for `codex-review`).
5. **525-5 Terminal Claude implementer.** Size M. Depends on 525-1. (#735, before this slice: a person-started Claude channel instance owns no task of a write class. `ownerRoleOfClass(class)` in `src/hub/routing.ts` is the one derivation: `plan` is the planner's, `review` the reviewer's and every other class the implementer's, so a class added later is a write class by default. `assign()` refuses such an instance as owner with `owner admission: a person-started Claude instance owns no write-class task until #525-5 proves its execution root`, named or automatic and whatever `ownerIsolation` says, and `ahub route explain` prints it because it is the same function. This slice deletes that one line and lets the isolation check decide.)
   - Paths: `src/cli/launch.ts`, `src/adapters/claude-channel.ts` (hello `cwd`), `src/hub/daemon.ts` (admission, `executionOwners`, facts `projectRoot`), `src/cli/terminal-recovery.ts`, rebuild bundle.
   - ACs: terminal half of AC-1 at runtime; a test that a mismatched or missing root keeps `ownerIsolation` false and `assign()` refuses with `owner-admission`.
6. **525-6 Codex planner and visibility.** Size M. Depends on 525-2, 525-3.
   - Paths: `src/adapters/codex-appserver.ts` (read-only thread sandbox, refusal on unconfirmed), `src/cli/facts-hook.ts` (no grants for planner-only Claude instances), `src/hub/daemon.ts` (status fields), `src/ui/index.html`, `src/cli/console.ts`, `docs/operations.md`, `docs/smoke.md` (six-instance live leg).
   - ACs: R7 fields in status, snapshot, dashboard, console, explain; AC-3 complete; AC-6 live run.

Spec-first: each slice's PR amends this section where its implementation differs, together with `docs/operations.md`.

### Amendment: write-class owners and the configured ACP planner rule (#735)

- **Write classes are derived.** Before 525-5, a person-started Claude channel instance (`instances.mode: "external"`, declared with `worktree` and the implementer or verifier role) owns no task whose class has the implementer as owner role. That is `ownerRoleOfClass(class) === "implementer"`: every class except `plan` and `review`. Previously only `implement`, `test` and `bulk_edit` were refused (the classes that need tests), so `summarize` and `triage` could still reach such an instance. The role ceiling uses the same function, so the two cannot disagree. The refusal is code `owner-admission` in `RoutingRefusal`, with its reason in the explain trace. A headless instance with a verified root (`ownerIsolation`) is judged by the existing check, as before.
- **Configured ACP agents and `planner`.** Decision: a configured ACP agent may hold `planner`. Its `adapters.<kind>.roles` or a `roles.<kind>` entry keeps `planner`, because the planner filter (`loadConductorPolicy`, `effectiveInstanceRoles`) asks the builtin registry for `projection.plannerEligible`, and a configured kind is not in that registry (`definitionOf` is undefined, so the filter passes). What it cannot do is be named by the `planner` setting or picked as the automatic planner: those read `PLANNER_PEERS`, which is derived from builtin projections, and the capability scope refuses `projection` on a configured definition (#625). No projection is given to configured agents: a projection fixes the host's role and help order and the planner choice, which a project file must not decide. The earlier statement that #725 drops `planner` for configured agents was wrong: it drops it only for the builtin kinds that cannot plan (pi, local, agy) and for instances of them.

## Amendment: typed host ports for the remaining native branches (#625 phase 6, slice 2+)

Audited against `main` @ `bab87cb2` (2026-10-22). Every `file:line` below is at that commit. Line numbers in `src/hub/daemon.ts` move with each slice; a slice cites the enclosing function, not the line.

### Scope and decisions

- Slice 1 (#667, `src/hub/peers.ts:15-22`) made `sessionGeneration`, `checkpointUsesSessionGeneration`, `permissionModeState` and `setPermissionMode` optional `PeerAdapter` ports. This amendment ports the rest of the native-class dispatch in `src/hub/daemon.ts`, or names each remaining site as an intentional native branch.
- Port semantics, as in slice 1: an absent port keeps today's non-native path. A port that is present but `undefined` is unknown and refuses wherever it gates a safety check. Presence is tested with `in`, as `requestCheckpoint` already does (`daemon.ts:1702`).
- **Proofs stay with their evidence.** A port exposes state, never a verdict. The daemon keeps every refusal.
  - Host-held evidence stays in the daemon: launch records in the state dir checked against `instanceId`, the daemon-owned socket claim generation, transcripts, Orca rows.
  - In-protocol evidence stays in the adapter: Codex `turn/start` and `thread/resume` frames, captured native approval policies (`codex-appserver.ts:73-76`, `:521-537`).
  - Why: a port that answered "proven" would make the adapter the authority. A configured or external adapter could then claim a proof it cannot hold.
- **Generic `PeerAdapter` engine: not in scope.** A kind-neutral driver that runs any transport from a definition is a separate design.
  - Reasons:
    - A4 admits only headless ACP that returns the public `AcpPeer` (spec §A4; `daemon.ts:3791`), so an engine would have no second consumer.
    - The branches that remain are proofs or fixed-builtin native lifecycles (pi-rpc relay, Kimi TUI admission, Jcode TUI tuple). An engine would not remove them.
    - Running external code behind an engine needs an isolated host-port boundary that does not exist yet (`external-modules.ts:200` ponytail).
  - Ceiling:
    - External modules stay headless ACP only.
    - A new non-ACP transport needs a fixed-builtin adapter class plus its definition.
    - Every remaining native branch is listed in a committed ratchet table (slice 2a).
  - Upgrade path: an engine issue when a second non-ACP external transport is requested, starting from the port set below.
- No slice changes persisted or recovery shape (restart snapshot, receipts, `claude-launch*.json`, `status.json` fields read by older coordinators, control messages). So no new `DAEMON_FEATURES` entry (`control-client.ts:12`). A slice that has to change one of these first adds a floor to `incompatibleRecoveryTarget` and `DAEMON_FEATURES` (daemon.md floor rule) and amends this section.

### Ports

`src/hub/peers.ts`, added to `PeerAdapter` after the slice-1 members. `StartForm` is a type-only import from `src/adapters/registry-types.ts:22`. `PermissionMode` is already imported (`peers.ts:2`).

```ts
// #625 phase 6 slice 2+. Absent: today's non-native path. Present but undefined: unknown, refuses.
/** Never offered hub_delivery_retry or its hint; the person resolves held deliveries. */
readonly deliveryOnly?: boolean;
/** The hub spawned this runtime and stops it itself; peer_stop admits only these. */
readonly hubOwned?: boolean;
/** A stop or failed start left an owned process whose exit is unconfirmed. */
readonly pendingOwnedProcess?: boolean;
/** The native form running now. */
readonly form?: StartForm;
/** Session persistence settled enough for a recovery prepare. */
readonly recoveryReady?: boolean;
/** Record live resume evidence before a requested stop or a recovery inspect/prepare/commit; throws when unavailable. */
captureResume?(): Promise<Record<string, unknown>>;
/** The native session that context readings, supervision receipts and memory provenance bind to. */
readonly nativeSession?: string;
/** Leave the roster without stopping a person's terminal; resetMode is the hub's next mode choice. */
detachForRoster?(resetMode: PermissionMode): void | Promise<void>;
/** Back on the roster after detachForRoster. */
resumeFromRoster?(): Promise<void>;
/** Fixed builtins only: a person's frontend attaches to the native session through this hub proxy. */
readonly frontendProxy?: FrontendProxyPort;
/** Fixed builtins only: a fixed operator notice; never native ids or provider text. */
readonly statusNotice?: { code: "unidentified-cancellation" | "qwen-detached" | "qwen-stalled"; message: string };
/** Fixed builtins only, and only with session.nativeRevert: roll the native conversation back to before this native turn. */
revertTurn?(nativeTurn: string): Promise<void>;
```

```ts
export interface FrontendProxyPort {
  /** Loopback URL the person's frontend attaches to. */
  readonly url: string;
  /** A frontend link owns the thread and its upstream socket is open. */
  readonly attached: boolean;
  /** The daemon's choice before any frontend attaches. Throws unless fresh: no link, offline, no restoration debt. */
  setStartupPermissionMode(mode: PermissionMode): void;
  /** Clear to ask while detached. Never refused; false when an overridden thread has no captured native baseline. */
  clearPermissionMode(): boolean;
}
```

Who sets what (parity by construction; each value is today's member, renamed at most):

| Port | Set by | Today's source |
|---|---|---|
| `deliveryOnly = true` | `AcpPeer`, `LocalPeer` | the `isLocalPeer \|\| isAcpPeer` pair, `daemon.ts:2123`, `:2257` |
| `hubOwned = true` | `AcpPeer`, `PiPeer`, `LocalPeer`, `ReviewerPrintPeer` | the four-way predicate, `daemon.ts:3555` |
| `pendingOwnedProcess` | `AcpPeer` | `acp.ts:327` |
| `form` | `PiPeer` (its `mode`, `pi.ts:468`), `WsPeer` (`"tui"`), `AcpPeer` (`"headless"`) | `daemon.ts:3553` (WsPeer means tui), `:4727` (Pi mode) |
| `recoveryReady` | `PiPeer` | `pi.ts:143` |
| `captureResume` | `PiPeer` | `pi.ts:172` |
| `nativeSession` | `CodexPeer` (`threadId \|\| undefined`), `AcpPeer` and `PiPeer` (`recoveryMetadata().sessionId` when it is a string) | `daemon.ts:1690-1691` |
| `detachForRoster` | `WsPeer` (ignores the mode, `channel-peer.ts:91`), `CodexPeer` (`codex-appserver.ts:473`), `PiPeer` (`pi.ts:471`) | `daemon.ts:4758-4760` |
| `resumeFromRoster` | `PiPeer` (`pi.ts:496`) | `daemon.ts:4773` |
| `frontendProxy` | `CodexPeer`: `url` = `proxyUrl` (`:137`), `attached` = `proxyAttached` (`:488`), the two methods as at `:494`, `:500` | `daemon.ts:3701`, `:5198-5280` |
| `statusNotice` | `CodexPeer` (`unidentified-cancellation`) and the existing `QwenDualPeer` (`qwen-detached`, `qwen-stalled`), unchanged | fixed-builtin-gated status projection |
| `revertTurn` | `CodexPeer.revert` (`codex-appserver.ts:610`) | `daemon.ts:2446`, `:2459` |

Per-port absent and undefined semantics:

- `deliveryOnly`:
  - Absent or false: retry allowed (today's WsPeer, Codex and Pi path).
  - Undefined: retry refused, and the hint is withheld.
- `hubOwned`:
  - Absent: `peer_stop` refuses with today's "unknown or non-owned peer" text.
  - Undefined: refused the same way.
- `form`:
  - Absent: each site keeps its default (`"headless"` at the stop notice, `undefined` at the retained-terminal notice).
  - Undefined: `peer_stop` and the unmanaged-TUI permission refusal refuse. Display-only uses pass `undefined`.
- `recoveryReady`:
  - Absent: settled.
  - False or undefined: not settled.
- `nativeSession`:
  - Absent or undefined: unbound. Context checkpoints already refuse without a session (`daemon.ts:1704`), and the context view reads unknown (`context-window.ts:58`).
- `detachForRoster`:
  - Absent, or `form === "headless"`: the roster-removal stop path.
- `frontendProxy`:
  - Absent: no proxy, today's non-Codex path.
  - Undefined: permission changes, startup reconcile and the `already` start reply refuse with "frontend proxy state unknown".

Why `nativeSession` is an adapter getter and not `definition.session.currentId`: `currentId` returns the local worker's `sessionId` (`builtin-metadata.ts:52-56`, `:152`), but today `contextSession(local)` is `undefined`. Routing through `currentId` would add a session to local memory provenance (`daemon.ts:1832`). Ponytail: two session readers. Converge them when that difference is settled by test.

### Trust gate (A4)

- Export `isFixedBuiltinDefinition(definition): boolean` from `src/adapters/registry.ts`, the boolean twin of `assertNativeCapabilityScope`'s object-identity check (`registry.ts:26-27`, `:224-225`).
- The daemon reads `frontendProxy`, `statusNotice` and `revertTurn` only when `isFixedBuiltinDefinition(definitionOf(peer))` holds for the resolved definition (instances included). Otherwise it treats them as absent.
  - So an external or configured adapter that declares them changes nothing: it cannot claim a native proof port.
- The Claude launch proof (below) admits an owner only under the same gate.
- `session.nativeRevert` joins the `assertNativeCapabilityScope` restricted list.
  - External definitions already cannot set it (`external-modules.ts:146` whitelist), and configured ACP does not set it (`configured-acp.ts:118`). The scope test makes that explicit.
- At the ACP factory admission (`daemon.ts:3791`), the daemon also refuses an owner unless `deliveryOnly === true`, `hubOwned === true` and `form === "headless"`.
  - A module that returns an `AcpPeer` subclass therefore cannot widen delivery authority by overriding a restrictive port.
  - Unchanged ceiling: a pin authorizes code with daemon privileges and is not a sandbox (spec §A4).
- `deliveryOnly`, `hubOwned`, `pendingOwnedProcess`, `form`, `recoveryReady`, `captureResume`, `nativeSession`, `detachForRoster` and `resumeFromRoster` are generic. They are read from any adapter, configured and external `AcpPeer`s included, as their `isAcpPeer` branches are today.
- The public `/adapter` entry exports no new value. The port types reach module authors through the existing `export type *` (`src/adapters/public.ts:5-7`).

### Claude launch-generation and unattended-hook proof

- The proof logic stays in the host; the typed port is host-side. Extract the existing reads unchanged into `src/hub/claude-launch-proof.ts`, bound once in `startDaemon`:
  - `claudePermissionLaunch` (`daemon.ts:5180-5186`);
  - the `claudePermissionGenerations` map (`:2504`);
  - the hello launch check that closes 4430 (`:5323-5330`);
  - the facts expected-launch read (`:5571-5591`).
- The adapter side contributes only `sessionGeneration` (slice 1; `WsPeer` sets it from the daemon's own claim, `channel-peer.ts:18`, `:43`).

```ts
export interface ClaudeLaunchProof {
  /** This instance's claude-launch record when permissionHook is true; undefined when absent, foreign or unreadable. */
  permissionLaunch(peer: string): { launchId: string; unattended: boolean; hookPurpose?: string } | undefined;
  /** #551: "refuse" closes the hello with 4430; no record or no launchId admits, as today. */
  helloLaunch(peer: string, launchId: unknown): "admit" | "refuse";
  /** Facts: the launch a native hook must name (Orca terminal row, then launch record); undefined admits legacy hooks, as today. */
  expectedLaunch(peer: string): string | undefined;
  /** The daemon-owned channel object of a fixed-builtin claude-channel peer. Holds the one remaining isWsPeer guard. */
  owner(peer: string): WsPeer | undefined;
  /** Record the generation a permission-bearing facts reply was issued for. */
  bindGeneration(peer: string, generation: string): void;
  /** True only while the bound generation equals owner(peer).sessionGeneration. */
  verified(peer: string): boolean;
}
```

- Keyed by `transport === "claude-channel"`, as phase 1 chose (daemon.md Claude state files rule), plus the fixed-builtin gate.
- `owner()` stays class-checked because the proof binds the launch record to the daemon's own socket claim. An adapter-reported generation must never satisfy it.
- Native-hook turn driving (`nativeStarted` and `nativeStopped`, `channel-peer.ts:113`, `:119`) is reached through `owner()`, never through a generic port.
- A second owner class (#677's headless Claude implementer, 525-4) is admitted only by an explicit edit to `owner()` with its own test, never by a generic port.
- Unchanged:
  - `--unattended` refusal;
  - `hookPurpose` permission-only hooks that never drive busy state;
  - `readClaudeTranscriptCompletion` bounds;
  - `facts-hook.ts` decisions;
  - the `claude-launch.json` / `claude-native-*.json` split (daemon.md).

### Call-site inventory

The following inventory is historical, audited at `bab87cb2` (2026-10-22). Counts are call occurrences in `src/hub/daemon.ts` (`grep -o`). `ripwire . --callers=<predicate>` lists the same functions and lines.

Slice 2a freezes the current baseline at `f11a2a1c3e24d1c431937941ecd40b07ca00a5cc` in `test/daemon-native-branches.json`, with executable checking in `test/daemon-native-branches.test.ts` using the shared `scripts/lib/ts-ast.ts` helper. The JSON had 61 predicate/function rows and 85 calls at that baseline; #449 (the Qwen dual-output TUI, #286 Part 3) added three reviewed `isQwenDualPeer` rows (`startPeerBody` 2, `status` 1, `stopPeer` 1: 64 rows, 89 calls) across `src/hub/daemon.ts` and `src/hub/claude-launch-proof.ts` (the launch-proof reader currently contributes zero native predicate calls). Each row carries its current reason; additions and removals both require an explicit reviewed table edit. Tests never regenerate the table.

| Predicate | Historical count | Current count | Delta |
|---|---|---|---|
| `isCodexPeer` | 12 | 13 | +1 |
| `isPiPeer` | 20 | 21 | +1 |
| `isWsPeer` | 25 | 27 | +2 |
| `isAcpPeer` | 12 | 13 | +1 |
| `isLocalPeer` | 6 | 8 | +2 |
| `isJcodePeer` | 1 | 1 | 0 |
| `isReviewerPrintPeer` | 2 | 2 | 0 |

The seven additional calls retain later native proof behavior: `actionEnforcement` adds one call each for Codex, Pi, Ws, ACP and Local; `actionSession` adds Local's intentionally separate action-allowance session; `currentExecutionOwner` adds the terminal Claude socket-generation/worktree proof. Slice 2a removes none of these calls to match the historical plan. The detailed historical assignments below remain context for later slices; the committed table is the current per-function ratchet.

| Predicate | Count | Ported | Intentional |
|---|---|---|---|
| `isCodexPeer` | 12 | 12 | 0 |
| `isPiPeer` | 20 | 11 | 9 |
| `isWsPeer` | 25 | 12 | 13 |
| `isAcpPeer` | 12 | 8 | 4 |
| `isLocalPeer` | 6 | 3 | 3 |
| `isJcodePeer` | 1 | 0 | 1 |
| `isReviewerPrintPeer` | 2 | 1 | 1 |

The brief cited 19 `isPiPeer` and 24 `isWsPeer`. The extra calls are second calls on the same line: `:5036` for Pi, and the `claiming` and `pullOnly` reads at `:2791` for Ws. `isReviewerPrintPeer` is included because `peer_stop` combines it with the others.

`isCodexPeer` (all ported):

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 1690 | `contextSession` | `nativeSession` | 2c |
| 2446 | `taskOpBody` turn_revert | `revertTurn` (gated), error text unchanged when absent | 2d |
| 2791 | `status` | `statusNotice` (gated) | 2d |
| 3701 | `startPeerBody` already | `frontendProxy.url` | 2d |
| 4721 | `codexResumeCommand` | `owner?.nativeSession ?? lastCodexThreads.get(peer)`. Only Codex's notice uses the command (`native-daemon-policy.ts:6-12`), so other kinds' output is unchanged. | 2c |
| 4759 | `changeRosterSetting` | `detachForRoster(resetMode)` | 2b |
| 5198 | `changePermission` offline ask | `frontendProxy.clearPermissionMode()` | 2d |
| 5206, 5215 | `changePermission` | `frontendProxy.attached` / present | 2d |
| 5247 | `confirmPermissionDefault` | `frontendProxy` present and offline | 2d |
| 5278 | `reconcileNativeStart` | `definitionOf(peer).permission.trackUnattended` (Codex only, `builtin-metadata.ts:110`), as `:5246` already does; no port | 2d |
| 5280 | `reconcileNativeStart` | `frontendProxy` not attached → `setStartupPermissionMode` | 2d |

`isPiPeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 1691 | `contextSession` | `nativeSession` | 2c |
| 2549 | `recoveryReady` | `recoveryReady` port; update seed `roster-detached-pi-recovery` (`scripts/seeds.json:325-330`) in the same PR | 2c |
| 3555, 3556 | `stopPeer` | `hubOwned`; `form === "tui"` refuses with `${displayName} belongs to a native TUI terminal; end it in its terminal` ("Pi", `builtin-metadata.ts:133`) | 2b |
| 3565 | `stopPeer` | `captureResume` when idle | 2b |
| 4727 | `retainedTerminalNotice` | `owner?.form`. Only Claude, Codex and Pi define the notice, and Claude and Codex ignore the form (`native-daemon-policy.ts:6-11`). | 2b |
| 4760, 4773 | `changeRosterSetting` | `detachForRoster` / `resumeFromRoster` when `form !== "headless"` | 2b |
| 5036 (x2) | `recoveryView` | `recoveryReady`, `form`; text uses `displayName` | 2c |
| 5070 | `recoveryOp` | `captureResume` on idle peers | 2c |
| 2791 | `status` | **Intentional.** `requestedModel` and relay backends come from the daemon-owned pi-rpc `modelRelays` (spec §A2b ceiling: pi-rpc owns the verified relay). | n/a |
| 3038, 3068 | `settlePiContinuity`, `recordSessions` | **Intentional.** The persisted continuity bookmark is Pi-shaped (`{ pi }`, `native-recovery-continuity.ts:6-12`). Generalizing it changes recovery shape and needs a floor. | n/a |
| 3519 | `hubStart` headless | **Intentional.** A generic `form === "tui"` would also catch an attached Claude or Kimi `WsPeer`, which today reaches `startPeer`. Existing ponytail at `:3516`. | n/a |
| 3657, 3665, 3704 | `startPeerBody` | **Intentional.** Pi replacement and handover (`--replace-session` is a person-only flag, `stopPiForReplacement`). | n/a |
| 3886, 4172 | pi-rpc port wiring, `admitPiRequest` | **Intentional.** Bridge `/budget` admission for the verified owner (adapters.md Pi). | n/a |

`isWsPeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 1418 | `offerPullOnly` | `peer?.pullOnly === true` (existing port, `peers.ts:26`; only `WsPeer` sets it) | 2b |
| 2727 | `permissionStatus` | `pullOnly` | 2b |
| 3553 | `stopPeer` stop notice | `owner?.form ?? (owner ? "headless" : startMode(peer))` | 2b |
| 4758 | `changeRosterSetting` | `detachForRoster`; the Kimi admission clear stays in that branch under `attach.admission` | 2b |
| 5191 | `changePermission` | `owner?.form === "tui"`, or no owner and a tui start mode | 2b |
| 2716, 5213, 5597, 5605, 5628, 5637, 5643 | `permissionDisplay`, `changePermission`, facts | `ClaudeLaunchProof.owner` / `verified` / `bindGeneration` | 2e |
| 802, 5335, 5401, 5411, 5423 | socket close, hello, `delivery_receipt`, `inbox`, `delivery_complete` | **Intentional.** Host channel transport: the daemon constructs this `WsPeer` (`:5334`) and owns socket authentication (daemon.md line 3). | n/a |
| 925 | bus `onImportantQueued` | **Intentional.** Pull-only nudge on the host channel (#398). | n/a |
| 1688, 1704, 2791 (x2) | `contextSession`, `requestCheckpoint`, `status` | **Intentional.** `claiming` and `lastInboxAt` are the daemon's claim window and channel telemetry. | n/a |
| 3642 | `startPeerBody` | **Intentional.** Inside `attach.admission`, Kimi's native TUI receipt, fixed builtin (spec §A2b ceiling). | n/a |
| 5499 | `native_facts` | **Intentional.** The agy managed-hook proof binds to the daemon's socket generation (adapters.md native facts). | n/a |
| 5724 | `watch` | **Intentional.** `attach.admission`; seed `kimi-watch-live-owner` (`scripts/seeds.json:3157-3162`) stays. | n/a |

`isAcpPeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 1691 | `contextSession` | `nativeSession` | 2c |
| 2123, 2257 | `ownHeldHint`, `hub_delivery_retry` | `deliveryOnly` | 2b |
| 2536 | `importantWaitingStatus` | `definitionOf(id)?.transport === "acp"` with no `steer` while busy. The Kimi TUI `WsPeer` under an acp id is never busy (adapters.md). | 2b |
| 3555, 3557 | `stopPeer` | `hubOwned`, `pendingOwnedProcess` | 2b |
| 3624 | `startPeerBody` | `pendingOwnedProcess` (still under `permission.genericAcp`) | 2b |
| 5279 | `reconcileNativeStart` | `owner.permissionModeState === "unmanaged"` (slice-1 port; Codex never returns unmanaged, `codex-appserver.ts:491`). `getPermissionMode()` stays on the typed `AcpPeer \| CodexPeer` parameter: `AcpPeer.permissionModeState` reads `"unknown"` where `getPermissionMode()` does not (`acp.ts:325-330`). | 2d |
| 3634, 5333, 5724 | Kimi admission, hello `kimiPull`, `watch` | **Intentional.** `attach.admission`. | n/a |
| 3791 | ACP factory admission | **Intentional.** The A4 trust boundary: the factory must return the public `AcpPeer`. It gains the port checks above. | n/a |

`isLocalPeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 2123, 2257 | `ownHeldHint`, `hub_delivery_retry` | `deliveryOnly` | 2b |
| 3555 | `stopPeer` | `hubOwned` | 2b |
| 2791 | `status` `servedBy` | **Intentional.** Local relay telemetry, hub-native. | n/a |
| 4205, 4259 | `holdPeer`, `validateRelease` | **Intentional.** `validateLocalChoice` over the local route and model. | n/a |

`isJcodePeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 5858 | `native_tui_launch` | **Intentional.** The owned-acp TUI tuple; only a person's launcher gets it (daemon.md). | n/a |

`isReviewerPrintPeer`:

| Line | Function | Assignment | Slice |
|---|---|---|---|
| 3555 | `stopPeer` | `hubOwned` | 2b |
| 1324 | review authority | **Intentional.** `reviewAuthority` compares `reviewToken`; never widen it (adapters.md Reviewers). | n/a |

After all slices, `daemon.ts` keeps 31 intentional calls (Pi 9, Ws 13, Acp 4, Local 3, Jcode 1, ReviewerPrint 1), plus one `isWsPeer` inside `claude-launch-proof.ts`.

### Slices

Every slice:

- `scripts/check.sh --changed` ends with `check: OK (changed)`.
- No safety default is lowered. A4 holds: no new public export, no external module import path, no field leaves the restricted list.
- Moved lines that `scripts/seeds.json` searches update their seed in the same PR (tests.md).
- An implementation that has to differ from this text amends it first.

Common acceptance criteria:

- **No-branch test:** a plain `BasePeer` subclass with no native class, exposing the port, gets the behaviour in a real daemon. This is the pattern of `test/peer-capabilities.test.ts:61-181`.
- **Parity tests:** the existing native tests for those sites stay green unchanged, and byte-identical error and status text is asserted where text moved to `displayName`.
- **Ratchet:** the table loses exactly the slice's rows.

1. **2a: Ratchet and trust gate.** Area note: `tests.md`. Size S.
   - Paths:
     - new `test/daemon-native-branches.test.ts` and `test/daemon-native-branches.json` (rows `{predicate, function, count, reason}`; TypeScript AST over `src/hub/daemon.ts` and `src/hub/claude-launch-proof.ts`, reusing `scripts/lib/ts-ast.ts` from #684 phase 5; never imports daemon code);
     - `src/adapters/registry.ts` (`isFixedBuiltinDefinition`; `session.nativeRevert` restricted);
     - `test/adapter-capability-scope.test.ts`;
     - `src/adapters/conformance/kit.ts` and `enrollment.ts`, with a ports leg.
   - ACs:
     - The table equals the current baseline above (61 predicate/function rows, 85 calls at `f11a2a1c`); the older inventory remains historical context.
     - An inline fixture with one extra predicate call fails, and so does a row with an empty reason.
     - A configured definition that declares `session.nativeRevert` is refused.
     - Kit leg: a non-fixed-builtin definition whose product has `frontendProxy`, `statusNotice` or `revertTurn` fails the kit. (The proposed `frontendProxy` and `revertTurn` members arrive in 2d; Codex already has `statusNotice`. The foreign-product check is active in 2a and rejects presence even when a value is undefined.)
     - The ACP ports leg (`deliveryOnly`, `hubOwned`, `form: "headless"`) is not part of 2a: no ACP product exposes those members until 2b adds them, so 2a cannot assert them. 2a only reserves the leg in `UNSUPPORTED_LEGS` with the reason "ports added in 2b".
     - Builtins that do not apply name their reason in `UNSUPPORTED_LEGS`.
2. **2b: Delivery-only, owned stop, form and roster detach.** Area note: `adapters.md` (Spawned processes; Turns). Size M.
   - Paths: `src/hub/peers.ts`, `src/adapters/acp.ts`, `src/adapters/local-worker.ts`, `src/adapters/pi.ts`, `src/adapters/reviewer-print.ts`, `src/adapters/channel-peer.ts`, `src/adapters/codex-appserver.ts` (`detachForRoster` signature only), `src/hub/daemon.ts`, tests.
   - Ports: `deliveryOnly`, `hubOwned`, `pendingOwnedProcess`, `form`, `captureResume` (stop use), `detachForRoster`, `resumeFromRoster`, plus the generic `pullOnly` reads.
   - ACs:
     - A plain peer with `deliveryOnly: true` is refused `hub_delivery_retry` and gets no retry hint.
     - With `deliveryOnly` undefined it is refused too.
     - A plain `hubOwned` peer is admitted by `peer_stop`; a `form: "tui"` one is refused with the `displayName` text.
     - Following the `detachForRoster` rule above (stop only when the method is absent or `form === "headless"`): a plain peer with `detachForRoster` and `form: "tui"` or `form` absent is detached, not stopped, on roster removal. The same peer with `form: "headless"`, or without the method, takes the roster-removal stop path.
     - Codex parity: `CodexPeer`, which has `detachForRoster` and no `form`, is still detached on roster removal and keeps its frontend proxy, as at `daemon.ts:4759` today. `stopPeer` still does not admit it as `hubOwned`.
     - ACP factory admission refuses an `AcpPeer` subclass that overrides `deliveryOnly` to false.
     - The conformance kit's ACP ports leg moves from `UNSUPPORTED_LEGS` to active: every ACP-transport definition's `start.create` product reports `deliveryOnly`, `hubOwned` and `form: "headless"`, and 2b's own ports land in the same PR as that leg.
     - `test/kimi-tui.test.ts`, `test/roster-pi.test.ts`, the `peer_stop` and configured ACP tests stay unchanged.
3. **2c: Session binding and recovery settlement.** Area note: `daemon.md` (recovery), with the budget.md context rules unchanged. Size M.
   - Paths: `src/hub/peers.ts`, `src/adapters/codex-appserver.ts`, `src/adapters/acp.ts`, `src/adapters/pi.ts`, `src/hub/daemon.ts` (`contextSession`, `codexResumeCommand`, `recoveryReady`, `recoveryView`, `recoveryOp`), `scripts/seeds.json` (`roster-detached-pi-recovery`), tests.
   - ACs:
     - For every builtin, `contextSession` equals today's value: the local worker and reviewer print stay `undefined`, and an ACP empty string stays `""`.
     - A plain peer with `recoveryReady: false` blocks `recoveryReady()` and is named in `recoveryView`.
     - Undefined blocks too.
     - Memory provenance `session` (`daemon.ts:1832`) is unchanged for local.
     - Seed runner: green, then the named assertion fails, after the reanchor.
4. **2d: Codex frontend proxy.** Area note: `adapters.md` (Permissions, modes and approvals). Size M.
   - Paths: `src/hub/peers.ts`, `src/adapters/codex-appserver.ts`, `src/hub/daemon.ts` (`changePermission`, `confirmPermissionDefault`, `reconcileNativeStart`, `startPeerBody`, `status`, `taskOpBody` turn_revert), `test/peer-capabilities.test.ts`, the Codex permission and revert tests.
   - The restoration debt stays inside `CodexPeer` (`nativeApprovalPolicies`, `overriddenApprovals`, `settlePermissionRestore`). The port changes no frame handling.
   - ACs:
     - A plain fixed-builtin-gated test peer (built in a test catalog that marks it builtin by identity) with `frontendProxy` gets the proxy refusals and startup reconcile.
     - The same peer under a configured definition is treated as absent.
     - `frontendProxy` undefined refuses permission changes and `already`.
     - The `unidentified-cancellation` notice shows only from a fixed builtin.
     - The Codex sticky-override, restoring-turn, detached-clear and attached-refusal tests stay unchanged.
     - The proxy/startup/revert `isCodexPeer` rows leave the table. The later `actionEnforcement` branch remains intentional: it reads Codex `actionGated` to choose the existing enforceability refusal. It is outside 2d and waits for a separately specified action-policy port; no `actionGated` member is added to `FrontendProxyPort`.
5. **2e: Claude launch proof extraction.** Area note: `daemon.md` (Claude launch and hook rules). Size M.
   - Paths: new `src/hub/claude-launch-proof.ts`, `src/hub/daemon.ts` (hello, `permissionDisplay`, `changePermission`, facts), tests.
   - No change to `src/cli/launch.ts`, `src/cli/facts-hook.ts`, `src/adapters/claude-channel.ts` or the plugin bundle.
   - ACs:
     - The existing #242, #551, #517 and #624 daemon tests pass unchanged.
     - `daemon.ts` has no `isWsPeer` row for these functions.
     - A non-`WsPeer` adapter under a claude-channel id never verifies a permission generation, even when it reports `sessionGeneration`.
     - A foreign `instanceId` record and a 4430 mismatch behave as today.

Order: 2a first (it measures everything else). 2b and 2c are independent. 2d after 2b (roster detach). 2e is independent. Run one slice at a time per repo (resource policy).

### Interactions

- **A4.** Covered by the trust gate. An external module cannot reach `frontendProxy`, `statusNotice`, `revertTurn` or `ClaudeLaunchProof.owner`. Its restrictive ports are checked at factory admission, and its CI sees the new kit leg through `/conformance`.
- **Recovery floors.** None added: ports are in memory, the restart snapshot still reads `recoveryMetadata()` (`daemon.ts:3073`, `restart.ts:15-27`), and `lastCodexThreads` stays daemon memory (`daemon.ts:2731`). The floor rule above applies to any slice that has to change this.
- **#525 / PR #677** (open, head `8525ad00`):
  - **525-1** adds a `headlessVariant`. It must join `fixedBuiltinDefinitions` (`registry.ts:26-27` adds only `reviewerVariant`), or the gate treats the variant as non-builtin and ignores its ports. That fails closed, but it breaks 525-4.
  - **525-4**'s headless Claude implementer needs the facts permission proof for a child launch id. It extends `ClaudeLaunchProof.owner` explicitly with its own test (above), and never reads a generic port.
  - **525-5** adds `executionCwd` to `claude-launch.<id>.json` and an attach admission. `claude-launch-proof.ts` is the one reader: whichever of 2e and 525-5 lands second rebases onto the other. 2e changes no record fields.
  - **525-6** adds read-only thread sandbox confirmation in `codex-appserver.ts`. The confirmation is in-protocol evidence, so it stays in `CodexPeer`. If the daemon must refuse on it, add a readonly state member to `FrontendProxyPort` (`threadSandbox?: "read-only" | "workspace-write" | "unknown"`; unknown refuses), never a daemon `isCodexPeer`.
  - The `role_stages` floor belongs to #525. This amendment adds no floor.

### Unverified

- Total parity of `codexResumeCommand` and the retained-terminal notice after `form` and `nativeSession` widen to ACP and `WsPeer` owners. It rests on only Claude, Codex and Pi defining the notices (`builtin-metadata.ts:99`, `:113`, `:142`); 2b and 2c must test it.
- That the Kimi TUI `WsPeer` is never `busy` (the `importantWaitingStatus` move). This is stated in adapters.md, not checked in source here.
- Whether `exactOptionalPropertyTypes` is relevant: `tsconfig.json` does not set it. Presence is tested with `in`, as in slice 1.
- PR #677 line references are from its diff at `8525ad00`, which is not merged.

### S6 person release authorization boundary (#481)

- `ahub sdlc authorize-release <version>` is console-only, never live-test delegated. The daemon binds consent to its candidate checkout's exact HEAD, committed package version, origin fetch/push identity and fresh committed-doc verdict. Caller-supplied expected HEAD must match. Head and origin are rechecked after the bounded package-owned documentation checker. Only ids, hashes, version, timestamp and counts enter the receipt/audit event; no project script or release operation runs.
- Authoritative receipts live only in the current daemon generation's bounded memory ledger (at most 64 candidates). An additive metadata event audits consent but cannot recreate it. Restart revokes all approvals. The release report shows matching/stale consent without certifying native acceptance, changing the tag workflow or publishing.
- Optional `ahub init --release-guard` installs a managed executable Git pre-push hook plus instructions. A regular existing hook is renamed, preserving its inode/mode, and chained with exact argv/stdin after successful guard readback. Linked/hardlinked hooks, occupied backups and custom hooksPath refuse before project writes. Re-init retains the guard; the wrapper pins Bun/package paths and needs re-init if they move.
- Actual pushed `v*` refs must have a valid version and captured source-object/commit matching consent. Missing/mismatched commit/version/remote, unreachable daemon, deletion, unknown evidence or restart refuses the version-tag push. Branch-only pushes work offline. `--no-verify` remains the person's explicit bypass and is forbidden to agents; this is cooperative Git enforcement, not a sandbox.
- Literal CLI preflights support a single named-remote tag refspec, GitHub release creation (existing remote tag readback, or explicit full SHA for a new tag), and current-checkout npm publish. Ambiguous/alternate-repository/bulk/workspace/archive selectors refuse. npm requires a clean tracked worktree and rechecks HEAD and committed documentation; artifact bytes, npm config and lifecycle scripts are outside this receipt. gh/npm instructions and preflight are the S6 boundary; adapter refusal belongs to #312/#313. No release effect is executed and no native/live pass is inferred. AC7 is covered by host-ledger units and actual hook/CLI/daemon fixture tests.

- S6 npm cleanliness uses filter-free cached-index/raw-blob comparison before and after docs readback, never `git status` or content conversions. Unknown modes, gitlinks, transformed bytes, unsafe paths or the 4,096-entry / 4 MiB-file / 32 MiB-total / 250 ms bounds refuse. Untracked artifact content remains outside this consent check.

## Amendment: one version policy for native agent CLIs (#691)

Native CLIs update often: Codex 0.146.0 → 0.163.0, and Kimi 2.2.0 → 2.3.0 by self-update on 2026-10-22. Separate exact pins made each update a refusal that only a hub release could lift, and some reasons hid the version.

- **One module.** `src/adapters/compat.ts` holds every gated kind's `verified` set, an optional compatible `line` (contract gates only) and its gate class. `assessVersion` gives verified, in-line, trusted or refused. The gates are the Codex and Kimi reviewer `prepare`, the Jcode preflight, probe and ACP identity, the agy launcher, the Qwen ACP identity and the doctor's Qwen probe. All of them use it.
- **Person trust on this machine.** `ahub agents trust <id> <version>` writes `<hub home>/agent-compat.json` (schema 1, at most 64 entries, atomic; an invalid file trusts nothing). It is console-only by the identity classifier.
  - An isolation gate keeps every runtime proof after trust. Trust covers only the source-level claims a runtime probe cannot see.
  - Nothing is trusted automatically.
- **Named reasons.** A version refusal starts with `VERSION_REFUSAL` and names only versions and the trust command. The daemon passes it through `sanitize()` for every reviewer backend, while other Codex prepare failures stay generic. The Jcode refusal is named before the owned daemon starts.
- **Seeing drift.**
  - `ahub agents` (allowed for agents) and `ahub doctor` show each verdict.
  - A daily workflow compares the latest published version of every public-source kind with `verified` and keeps one `agent-compat` issue current (#843 widened it from weekly to daily and from npm-only to every public source).
  - Sources: the npm-distributed kinds read npm `latest`; Jcode reads its GitHub releases' latest tag (leading `v` stripped, #843). agy has no public source and is reported as an informational note, never drift; pi has an entry since #847 and is watched like the rest.
  - Local drift (#843 AC3): at hub start and daily the daemon reads each installed CLI's version with the `ahub agents` probe and tells the effective planner once per (id, version) when it is not `verified`: id, version, state and the last receipt path only, deduplicated per planner in `hub.db` across restarts, so a planner that could not be queued is retried alone. A missing executable or an unreadable version is silent. `ahub status` shows one attention line per drifted id.
- **Moving a verified set.** A receipt in `docs/verification/` adds the version to `verified` in the same PR.

## Amendment: lifecycle identity linked by the hub (#694)

Lifecycle status read the issue and the PR only from `hub_sdlc_record`, which agents rarely call, so every task showed `issue identity missing` and `PR identity missing` while its title, refs and PR named both. The hub already trusted the same source for plan review.

- **Issue.** When the receipt has no issue and `planIssueIdentity` resolves exactly one, the hub writes `repo` and `issue` at plan review, at done, and in a groom backfill that runs after every authority check with its own bound (32 per call, separate from the metadata-read budget), so later tasks are reached on later calls.
- **PR.** When the receipt has no PR, the hub links it at done. It reads the open PRs once and takes the one whose head equals the done's full `refs.commit`, or, with no commit, whose branch equals `refs.branch`. Zero or several matches link nothing. A full page of 100 (possibly truncated) or any malformed row makes the inventory unknown, so nothing is linked. Agent text is never parsed.
- **Staged at done.** The done's identities are staged in memory: the lifecycle and review gates read them, and only the admitted done update (or its `done (checking)` record) persists them, so a refused done stays a pre-effect refusal (#254). The missing-issue `next` step says how to supply one; the blocker text stays exact for gate matching.
- **Safety.**
  - A first link keeps every other receipt field, so red-first and local-gate records survive.
  - An existing or foreign identity is never relinked.
  - PII tasks are skipped before any read.
  - A task that turned private during the read gets no link, and a PR read for one commit or branch is never linked to a task whose head changed meanwhile.
  - Plan-review and groom links record `lifecycle linked` with the ids only; a done link is part of the done's own record.

## Amendment: the limit ledger (#683 U1)

- Additive events in `events.jsonl`, no `PROTOCOL` bump, ignored by a reader that does not know them:
  - `usage` with `source: "codex_appserver"` (`reasoningTokens` is new on `usage`): written beside the unchanged `tokens` event from `thread/tokenUsage/updated`, as the growth of Codex's `input`, `cachedInput`, `output` and `reasoningOutput` counters since the previous update, under the existing baseline rule (a fresh thread counts from zero, a resumed one from its replayed total). Cached input is part of input and reasoning part of output, so `inputTokens + outputTokens` equals the `totalTokens` growth. Task attribution is the one `tokens` uses.
  - `budget_pause` and `budget_resume` (`peer`, `reason`, `window`, `resetsAt`, `by: "hub" | "person"`), written at the single pause INSERT and the single resume DELETE in `budget.ts`; an override is `by: "person"`. The pause window is the worst window that crossed the gate.
  - `quota_reset` (`peer`, `window`, `cause`, `resetsAt`, `previousResetsAt`, `used`, `previousUsed`), derived from two readings of one window id: `resetsAt` moved forward by more than 15 minutes (a provider's `resetsAt` wobbles by seconds inside one window: replaying the 177k real readings of this project's log first gave 85 entries, 31 of them jitter, and 54 with the tolerance, the smallest real move being 2.4 h), or `used` fell by 0.5 or more with a `resetsAt` within that tolerance. One entry per peer, window and `resetsAt`, also across a restart (the daemon seeds the dedupe set from the log). A reading older than the last one never counts.
- Ids, windows and numbers only: no checkpoint text, summary, task title or agent-written text. A ledger failure never costs a pause, a resume or a reading.
- Ceiling: `ahub reset` clears `budget_pauses` rows and, by its own contract and test, leaves `events.jsonl` byte for byte as it was, so a pause it clears has no `budget_resume`; a timeline must treat a `budget_pause` with no later resume for that peer and a later `budget_pause` or hub start as ended. A new pause that replaces an expired record writes the old pause's `budget_resume` first, so two open pauses never coexist.
- Ceiling: Codex 0.163.0's `TokenUsageBreakdown` also has `cacheWriteInputTokens`, not read here (0 in the recorded session replayed in `docs/events.md`). A first reading after a restart is a baseline, so a window that rolled while the hub was down is not recorded as a reset (the pause record's own restore note covers a pause). The roll-up, the `usage` query op, the CLI and the console and dashboard views are slices U2 to U4.

### Dogfood scorecard (#687)

`ahub report --dogfood [--since 7d] [--json]` is a read-only projection with the same authority as `ahub report`, including agent callers (the 2026-10-22 correction to task #369's original person-only line). It never invokes a model or creates an issue/task. It reports flow, quality, attributed cost, delivery, hub performance and one evidence row per `docs/dogfood.md` feature. Export metadata only; count PII without text, and skip its known PR readbacks. Preserve unknown rather than zero for missing, malformed, truncated or uninstrumented sources.

Use `summarizeByTask`, `costMetrics` and bounded SDLC GitHub helpers. Bound files, rows, history cells, GitHub pages and total read time. Aggregate multi-task PR readiness at the final linked approval. Expose original first-run CI only when observed, never infer it from a rerun. Count bot-thread timing and explicitly cross-referenced bug issues as associations, not severity/causality. Retained journal counts are labelled as retained; do not infer first delivery from its latest transition. Log-pattern observations and burst-level snapshot notices are labelled separately from exact telemetry. The weekly receipt records its source commit, window and coverage under `docs/verification/dogfood/`; `docs/dogfood.md` specifies the bounded collector and current unknowns.

## Amendment: the usage roll-up, the `usage` op and `ahub usage` (#683 U2)

- `UsageRollup` (`src/hub/usage-rollup.ts`) folds `events.jsonl` into `hub.db` from a stored byte offset: `usage_rollup`, `token_rollup`, `limit_events`, `rollup_state`, `rollup_seen`, `rollup_pii`. A pass is bounded (8 MiB), whole lines only, and commits rows and offset in one transaction. A rebuild from byte 0 equals the incremental result; a log shorter than the offset starts over. Records are counted once by peer, source and id.
- The `usage` control message (`op` `query`, `limits` or `total`; `by` one of `peer|task|issue|pr|release|day|model`; `since`, `until`, `peer`) is answered for the console and for a configured planner (not during that planner's private turn); every other agent gets `{ ok: false }`. Every message gets a reply.
- Every number is `{ value, source }`, source `native`, `count`, `manual` or `unknown` (the labels of #285). A counter no record carried is `unknown`, never 0. `total` and `totalWithoutCache` are both returned and cache reads are their own column. Claude's total is the sum of its four counters when it reports none; no total is derived where cache is part of input. A lifetime total mixing native and counted peers is `count`.
- `issue`, `pr` and `release` are the board's current `sdlc.issue`, `sdlc.pr` and `release` of each task, read per query. A private task shows `#id` and `[pii]`.
- Review rules (#702): a lifetime overall figure with an unknown peer has source `partial` (a lower bound) and `unknownPeers` names them; it is never a sum that counts them as 0. `usage limits` returns `{ total, shown, truncated, omitted, limit, maxLimit }` and the CLI says when older events are cut (`--limit`, 1 to 5000, default 200); it never drops rows silently. A pause the events never ended and the hub no longer holds (`ahub reset`) is `endedUnknown`, not `open`.
- `ahub usage`, `usage limits` and `usage total` (`--json`, `--since`, `--by`, `--peer`, `--limit`); the command is `allowed` for agent shells and the hub refuses non-planner agents. `docs/verified.json` restamps `src/cli/help.ts`.
- Evidence on this project's real log (47 MB, 238k lines): first fold about 170 ms, `ahub usage` about 95 ms, per-task counted tokens equal `ahub report --by task` for all 170 tasks that have any, and Claude's derived total equals the hub's own count for Claude exactly (2,149,669,788). The one place `usage` is deliberately fuller than `report`: the report shows Claude's total as unknown when no `totalTokens` was reported (9 of those 170 tasks), while `usage` derives it from the four counters. The first version read Claude's total as unknown because 5,649 of its 5,656 real records carry no `totalTokens`.
- Ceilings: the day is the UTC day of the event time; a pass is capped at 8 MiB and a log far past that needs several 10 s polls to catch up (reported as `done: false`, never as a failure); the dashboard and console views are #683 U3 and U4; `manual` appears in the type but nothing writes it yet (`ahub budget set` readings are quota windows, not token counts).

## Amendment: the console Usage panel (#683 U3)

- Tab `7 Usage` in the console (`src/cli/console-usage.ts` for the text, `console-state.ts` for the reducer and render, `console.ts` for the fetch). Key `7` and the digit guards of `1`..`6` apply; Left and Right from `7` behave as from Settings (wrap to `1` and to `5`), so the pinned `1`..`5` cycle (#309) is unchanged.
- The refresh loop asks the `usage` op only while the panel is open: `by: "peer"` for the UTC day, for the last seven UTC days and for lifetime, `op: "limits"` with `limit: 1000`, and `by: "peer", task: <id>` for the task that was selected in Tasks when `7` was pressed. A refusal or an error is shown as `usage unavailable: <reason>`, never as empty usage.
- Columns: PEER, TODAY, 7D, LIFETIME, PAUSE, QUOTA, LAST RESET. At 80 columns only LAST RESET gives way. The header drops one space per tab so seven tabs fit beside the project name.
- A peer's tokens are the provider's total when it reported one, otherwise the hub's own count (labelled `hub`), otherwise `unknown`. A period with no records reads `no records`. Enter shows input, output, cache read and cache write each with its source.
- `UsageQuery.task` (the roll-up and the op, a positive task id, refused with an answer otherwise) filters to one task; the result says `taskPii` for a private task, so the console prints `#id [pii]` and never a title.
- The `usage` op now folds the log with `catchUp(250)` before it answers (one 8 MiB pass per poll left a hub that had just started on a big log answering from the first pass: found by the live panel on a copy of the real 47 MB log, where TODAY read `no records` for peers that had used tokens). When the budget runs out the reply has `behind: true`; the console says `still catching up` and the CLI warns on stderr.
- Ceiling: the limits history is the newest 1000 events; the panel only needs each peer's last three resets. The dashboard panel is slice U4 and calls the same op.

## Amendment: the dashboard Usage view (#683 U4)

- The Usage view is part of the Agents view, under Usage budgets (`src/ui/index.html`, `renderUsage`), and reads the same roll-up as `ahub usage` and the console panel: lifetime totals with the peers whose figure is unknown, the last 14 UTC calendar days of stacked tokens per peer, the open budget pauses with the last 20 pause, resume and reset events, and a task table (state, owner, PR, input, output, cache read, cache write, total).
- `uiSnapshot` builds `usage` only when the request names `view: "agents"` (the page sends its open view with every poll, like it sends `memory`), so a hidden view costs no roll-up work on the 1 s poll. It folds the log with `catchUp(100)`; when that returns false the snapshot carries `usage.behind: true` and the view says the figures are a lower bound until it catches up, never the folded part as the whole.
- `UsageRollup.daily(days, now)` returns the last `days` calendar days ending today, clipped to the first day with a record. A day with no record is a row with `empty: true` and the view shows `no record`, never zero. Every counter keeps its source (`native`, `hub` for a count, `at least` for a partial sum) and `unknown` stays the word.
- A private task is the public title `[pii]` on the board (`Tasks.publicView`) or a `pii` roll-up row; the view shows `#id [pii]` and never a title, and the snapshot carries ids and numbers only.
- Colours are design tokens only; the view is one column at 600 px and its tables and chart scroll inside themselves. `test/ui-usage.test.ts` runs the page's own `renderUsage` over a snapshot fixture (PII marker absent, unknown not zero, the lower-bound note) and checks the view's token pairs for contrast in both themes.
- Ceiling: the view recomputes the daily and task aggregates on each poll while the Agents view is open; a materialised daily table is the upgrade if that ever costs more than a few ms on a large log.

## Amendment: the console changed-symbols block (#684 phase 2b)

- `src/cli/console-symbols.ts` (pure data) and `taskFields` in `console-state.ts`: Enter on a task in Tasks adds `symbols` and `symbols note` after the plan field and drops the raw `codeSymbols` field. It reads the public `codeSymbols` that `task_show` already carries (#684 2a) and the task's `plan.symbols`; it asks the hub for nothing new.
- The plan names are `plan.symbols`, the list the review brief reads as `planned` (`daemon.ts` passes `task.plan?.symbols` to `withCodeSymbols`), not a second source.
- Each observed symbol is `matching` (some plan name matches it) or `unplanned`; each plan name that no observed symbol matches is `untouched`. The rule is `planSymbolMatches`, exported from `src/hub/review-brief.ts` and used by the review brief itself, so the console and the brief cannot drift.
- States: no observation or an `unknown` one reads `changed symbols: unknown (no code facts)`; `known` and empty reads `none observed` (with a plan, every planned name is `untouched`); an incomplete observation says `incomplete` and that an untouched symbol may have changed; a private task (`pii` or `pii_path` signal, or a `[pii]` title) shows no block and no raw observation. Only a task_show-shaped detail (numeric id and a state) gets the block, and only the public receipt: a `codeSymbols` that still carries the stored `repositoryKey` was never re-screened by `publicTaskCodeSymbols`, so it reads as unknown and shows no names, whatever feeds the renderer.
- Names go through the console's field renderer, so they are quoted; at most 40 are listed and the rest are counted. The note says deleted definitions are not reported.
- Not in the original 2b slice: overlap lines (the read-only `symbolOverlaps` projection and console block follow in #379 above) and the related-notes count (phase 4, no hub op returns it).

## Amendment: reserved backlog pulls offer their exact owner (#718)
- A planner pull of an existing backlog task with `reserved` set admits that exact peer before any task write. It cannot silently fall back to another peer when the reserved peer is excluded, unavailable, at planner WIP capacity or otherwise ineligible. Existing planning authority, revision, dependency, release, person-order and SDLC plan gates still apply. Authority, routing/WIP eligibility and plan/flow fences are rechecked after asynchronous screening or plan readbacks and immediately before the admitted write.
- `Board.pullAssigned` records `backlog pulled` and the owner assignment in one atomic task transition. Both writes commit or roll back together; board reads and deferred callback payloads both expose the committed assigned row, while history retains both events. Pull increments the planning revision, clears any old `offer`, and the existing assignment path creates a fresh owner offer bound to the new assignment flow revision. A stale prior owner request is withdrawn through the existing delivery path rather than reused as the new offer.
- The committed assignment remains fact if subsequent routing notice or task delivery fails. Existing typed undelivered-assignment handling reports that failure; an assignment superseded while awaiting delivery follows the existing supersession handling, without rollback or a second owner offer. This change adds no separate delivery mechanism.
- An unreserved backlog pull retains its lazy, ownerless To Do transition and existing planning undo. A reserved pull now assigned/offered to its peer cannot be undone through planning; the existing planner-or-person untouched-return path remains the recovery route when its own conditions hold. Acceptance is still a separate peer action and does not occur as part of pull.
- No new model call, role authority, configuration or privacy exception is introduced. Existing screened task/note views, PII routing and refusal boundaries apply. Dogfood starts after release and checks the same-peer `backlog pulled` -> `assigned` -> `accepted` sequence, fresh offer binding, stale/unowned offers and capacity refusals.
## Amendment: the dashboard task sheet's Code group (#684 phase 2c)

- `src/hub/task-code-group.ts` (`codeGroup`) classifies a task's public `codeSymbols` against `plan.symbols` with the review brief's own matcher (`symbolsOverlap`) and is the only place that does for the dashboard (the console classifies with `classifySymbols` in `console-symbols.ts`, over the same matcher); the UI snapshot carries the result as `codeGroup` on each task. The page (`codeGroupSection` in `src/ui/index.html`) draws it and never matches names.
- A private task has no `codeGroup`, so the sheet shows no Code group for it and the snapshot carries none of its plan names. A stored receipt (one that still has `repositoryKey`), a missing one or an `unknown` one is `{ state: "unknown" }` and the sheet reads `unknown (no code facts)`. Symbol ids that fail `publicMetadataText` or the id shape (`symbol:<name>@<path>`) are dropped and the group is marked incomplete, so an untouched symbol may have changed. Every stored plan name is read (the stored plan allows 50 names of 300 characters, and the group uses the same bounds); one that is malformed or fails the screen is counted in `planWithheld`, the group is marked incomplete, and the sheet says a symbol marked unplanned may be in the plan, so a withheld name never shows a plan departure that did not happen. The counts on the sheet are the totals, not the listed part.
- At most 40 symbols and 40 untouched names are listed, with the count of the rest. Advisory only: ripwire does not report deleted symbols.
- A symbol button closes the sheet, sets the Memory view's `node` to the symbol's canonical id (`symbol:<name>@<path>`) and switches to the Memory tab. The daemon's memory view reads a node of up to 512 characters when it starts with `symbol:` (200 otherwise) so a receipt id is never truncated into another node. Memory entries attached to that symbol appear once phase 3 links them; until then the graph shows the symbol node alone.
- Colours are design tokens only, and the group wraps at phone width with 44 px targets.


## Amendment: daemon responsiveness (#719)

Periodic roster and supervision reads use pending delivery metadata/rows rather than materializing terminal envelope history. Queue revisions are metadata reads; explicit queue/history and recovery snapshots retain their full semantics. Usage folding keeps its existing byte cap and atomic rows/offset transaction, with a 20 ms slice checked between whole records; one record remains indivisible. Native launch connects alone retry transient transport failures with bounded backoff up to 15 seconds and one busy notice. Ordinary connect defaults and identity/authentication/protocol refusals stay unchanged.

## Amendment: terminal Claude execution-root admission (#525-5)

Slice 525-5 is implemented. The temporary #735 blanket refusal is replaced by the existing implementer-role and host owner-isolation gate for every write class. The bounded launch-proof reader binds the current daemon instance and launch id; owner proof additionally needs a private, single-link launch record, a matching recorded execution root, the MCP server's real cwd and the validated noncanonical branch worktree. The proof belongs to the exact attached claim generation and socket; a pending preface is not ownership, and detach, replacement or a changed launch record revokes it. Old/missing root evidence attaches without isolation. Facts grants for declared implementers and terminal-recovery publication require the current proof. Canonical planner/reviewer behavior and protocol 16 remain unchanged. The launcher preserves canonical AGENTHUB_PROJECT_DIR for hub identity while passing the execution root as native cwd. These are same-user process/record attestations, not a sandbox.

Status isolation fields and their read-only stall projection use retained host bindings plus cheap current-owner/generation/socket checks. They perform no terminal-root Git validation and grant no authority. Filesystem/branch or launch-record drift may remain unseen in that display until the next routing admission, facts permission reply or terminal recovery owner proof; those paths still revalidate and revoke mismatches before effects. The status snapshot is passed explicitly through read-only stall evaluation only, never through an ambient mode or a request-controlled bypass. Unrelated external-instance evidence and ordinary checkout probes keep their existing contracts.

## Amendment: planner walk and reviewer independence in `assign()` (#525-3)

Slice 525-3 is implemented, as the "Purity" bullet of the #525 amendment specifies; this records what exists and what does not yet.

- **Planner walk.** `plannerWalk` (`src/hub/routing.ts`) is a pure function of the sorted settled holders, the task id, an optional named planner, an optional kept planner and a per-holder `blocked` reason. A PII task has no planner (`planner: none (pii: planning stays with the person)`). A named planner is exact: a name that is not a holder is refused in the trace and never replaced by rotation, and a named holder that is paused or offline is still the choice, with the state shown. Otherwise a recorded planner is kept while it is still a holder. Otherwise rotation starts at `task.id mod n` over the holders sorted by id and walks forward past unavailable holders; the denominator is every holder, so availability never renumbers it (the #519 rule); when all are unavailable the seed holder is taken, `rotation (none available)`.
- **Inputs and outputs.** `assign()` takes `planners`, `namedPlanner` and `keptPlanner` and returns `Assignment.planner` and `plannerReason` (`rotation`, `named`, `kept`, `none`). Without `planners` it walks no planner, so a caller that does not pass them is unchanged. A holder is unavailable when the adapter role ceiling excludes planning, it is off roster, not attached, offline, paused under `budget_paused = skip_peer`, or failing: the same state inputs the owner and reviewer walks read. The walk is independent of both: planner and owner, or planner and reviewer, may be the same peer.
- **Explain parity.** The walk's lines (`  planner candidate X: ...`, then `planner: X (reason)`) are part of `assign()`'s trace, after the owner and before the reviewer. `Tasks.weights()` supplies `planners` (the rostered holders of the settled role map, sorted) to every `assign()` path, so `ahub route explain` prints exactly what assignment ran.
- **I-2.** A peer with an `accepted` or `done` history entry on the task never reviews it (`implementers`), whoever owns it now, a named reviewer and the declared reviewer pool included: refusal code `policy`, reason `implemented this task`. It is the last capability/independence check in `blocked()`, before queue admission, so it only ever removes a candidate that was otherwise eligible: a former implementer that is offline, not attached, paused, failing or off roster is refused for that real reason and leaves the outcome as it was before I-2 (a task with no other reviewer still approves directly). When I-2 removes the last eligible candidate, the reviewer is the person and `reviewBlocked` is set (`every eligible reviewer implemented this task: the person reviews`); there is no fallback to an implementer. The person's own entries are not an implementation. A review-class and a PII task are unchanged.
- **Not in this slice.** Nothing records the planner: no board column, no history entry, no notice, no authority check. `Tasks` passes `planners` and reads nothing back; 525-2 owns recording and the per-task authority. A task proposed today behaves exactly as before.

## Amendment: deliverable records bound to content hashes (#509a)

The only artifact identity was GitHub (`repo`, `issue`, `pr`, `head`, `reviewedHead`); a report, translation or deck had no record of which bytes were reviewed and approved. Slice 509a adds one, with no dependence on git.

- **Claims.** `hub_task_done` and `hub_sdlc_record` (in `receipt`) take `deliverables: [{path, format, version?}]`, one to sixteen distinct paths. `parseDeliverableClaims` (`src/hub/deliverables.ts`, pure) refuses every field the hub does not own: a claimed `sha256`, `hash` or `bytes` is a refusal with the reason, never an input. Paths are relative, forward-slashed, with no `.`, `..`, empty or control segments.
- **Root.** Paths resolve under the owner's execution root, the same one the owner writes in: `TasksDeps.executionRoot(peer)` (the daemon passes `ownerWriteRoot`), falling back to the project directory only when the port is absent. A declared worktree instance whose root is not verified refuses hashing (`DeliverableRefusal`), and a live read reports every file `unknown`, so an approval is refused and a file is never shown `unchanged` from the wrong tree.
- **Hashing.** `src/hub/deliverable-files.ts` is the only code that opens a deliverable. It resolves the path with `realPath` and `guardPath` (read mode), refuses the project's secrets denylist and the hub's own state (`.git`, `.agenthub`, by `isHubWritePath`), a non-regular file, a missing file and sizes over 256 MiB each or 512 MiB together, then opens without following a final link (`O_NOFOLLOW`) and compares device, inode, size and mtime with what was vetted (Linux reuses an inode number at once, so the inode alone does not prove identity) and the size and mtime again after the read, so a swapped or concurrently changing file is refused. Chunked reads with an await between chunks keep the daemon responsive. Any refusal refuses the whole call before a board write.
- **Reads and gates.** A live read (`checkDeliverables`) applies the aggregate limit to the current sizes: files that grew past it are read `unknown` and none is hashed, so `hub_task_show` and an approval attempt stay bounded. `specStageGate` reads a receipt without its `deliverables` field, as `recordSdlc` records it, so naming deliverables never skips the live spec edit-time check in enforce mode.
- **Record.** `HistoryEntry.deliverables` holds `{id, path, format, version?, sha256, bytes, private?}` on `done`, `done (checking)` (carried to the completing `done` by `latestPendingDeliverables`), `lifecycle` and `approved`, validated on write (`parseDeliverableRecords`, which also checks the id against the path and format). `id` is opaque and stable across edits.
- **Approval.** `Tasks.review` re-hashes the delivered files before an approval. Unchanged, the approval carries the same records. Changed, missing or unknown, a reviewer's approval is refused pre-effect (`deliverable changed since it was delivered`); the person may approve the current bytes, which are measured and bound, with a note. The delivered records are rechecked after the awaited hash, so a redelivery during the verdict refuses it.
- **Reads.** `Tasks.deliverableStatus` compares the files as they are now with the approved (else delivered) records: `unchanged`, `changed`, `missing` or `unknown`, and `changedSinceReview` true only for a measured difference. It is added to `task_show` for the console and peers. A file the hub cannot vouch for is `unknown`, never `unchanged`.
- **Privacy.** A record is private for a PII task or a path under `pii.paths` (`matchesPolicy`). `publicDeliverables` is the one projection every peer view, review request and status uses: a private record, or a path matching a PII pattern, shows id, hash and size only. The board keeps the path (as it keeps a PII task's text) so the file can be found again.
- **Not here.** `ahub deliverables` and the dashboard marker (#509 AC3) are the next slice (done in the #509b amendment below). `PROTOCOL` is unchanged: the new tool fields are optional. Known limit: tool input schemas are not enforced on the way in, and a daemon from before this slice reads only `summary` and `refs` from `hub_task_done`, so a newer plugin talking to an older daemon has its `deliverables` silently dropped and the task is recorded without them. The plugin is installed apart from the daemon (docs/agent-notes/daemon.md), so after an upgrade restart the hub before relying on deliverables; a floor like `role_stages` is the upgrade path if that ever matters.

## Amendment: `ahub deliverables` and the dashboard badge (#509b, #317)

The second slice of #509 (AC3): a person-facing list of what tasks delivered and what a reviewer approved, and a dashboard marker. Nothing new is stored: both read the records 509a already writes.

- **Command.** `ahub deliverables [--task <id>] [--approved] [--check] [--json]` was the person's; since #933 it is Allowed, and an agent's list holds only the tasks `hub_task_show` would show it (#933: see the amendment "the console class keeps trust, money, attribution and terminals"). Each row is a task that has delivered files, newest task first: `#id title [delivered|approved]`, then each file's id, path (only where `publicDeliverables` allows), format, version, size and full sha256. A PII task or a `pii.paths` file shows id, hash and size only, and the title is `publicTitle`. `--task` takes one positive integer (a repeated `--task` is refused rather than keeping the last); `--approved` lists only tasks whose approval bound records, and shows those approved bytes.
- **Measured or not.** Without `--check` no file is opened: the list is the board's records, `checked` is false and no row says anything about change. With `--check` every listed file is measured now through `Tasks.deliverableStatus` (the 509a reader, with its limits and its `unknown` for a file the hub cannot vouch for), each file shows `unchanged`, `changed`, `missing` or `unknown`, and the row says `changed since review` only for a measured difference. The row's own reading (`result`) follows the same order: it says `(unchanged)` only when every file did. Consumers of `--json` read `result`: `changedSinceReview` stays false next to `result: "missing"` or `"unknown"`, because it is true only for a measured difference. `Tasks.deliverableList` is the one reader.
- **Dashboard.** The snapshot's task rows gain an optional `deliverables: {state, files, checked?}` (`Tasks.deliverableBadge`): the same public projection of the same records, never a file read, because the page polls every second and hashing up to 512 MiB per task on the poll is not acceptable. `checked: {at, result}` appears only when a live read (`task_show`, `ahub deliverables --check`) measured exactly these records; `result` is `changed`, `missing`, `unknown` or `unchanged` for the whole task, and `unchanged` only when every file measured unchanged (a change outranks a missing file, which outranks one the hub could not read, such as every file under an unverified execution root). The page and the CLI say `a file is missing` or `could not be measured` for those, never `unchanged`; `Tasks.deliverableResult` is the one reducer (the cache is keyed by the record ids and hashes, so a redelivery or a new approval clears it). The card shows a `Deliverables n` chip (with `approved` and `changed` when known); the task sheet gains a Deliverables group with each file's path (or `private file`), format, version, size and a twelve-character hash prefix, and says `not measured now: run ahub deliverables --check` when nothing was measured. `PROTOCOL` is unchanged: the field is optional and an older page ignores it.
- **Interpretation.** The issue says "a dashboard column". The dashboard's board is kanban columns by task state with no per-task table, so a new column of its own has no place; the chip on the card and the group in the task sheet are the equivalent surface. Say so in review if a table was meant.
- **Ceilings.** The dashboard's `changed` is as fresh as the last live read in this daemon's memory (a restart clears it, and a file edited after the last read shows nothing until the next); the command, not the page, is the way to measure now. The list reads the whole board each call (as `ahub board` does); there is no pagination.

## Amendment: window kinds, source precedence and per-peer budget notes (#285 phase 4)

- **Kind.** `UsageWindow` gains an optional `kind: "native" | "count" | "manual"` next to `source` (`src/hub/window-kind.ts`). `windowKind` is the one classifier: a named kind wins; an untagged window is `count` when its id is `tokens`, `manual` when its source is `ahub budget set`, else `native`, so a reader that predates the field keeps working. The Kimi count and `ahub budget set` name their kind; the Claude and Codex readers stay untagged and read as native. `PROTOCOL` is unchanged: `kind`, `superseded` and the reply's `peers` and `kimiSource` are optional fields an older client ignores.
- **Storage and precedence.** `Budget` keeps readings per window id and kind, so a person's number and the provider's for one window never overwrite each other (and `quota_reset` baselines are per kind). `Budget.gating` decides what the gate and `headroom()` act on: a fresh manual reading replaces the other kinds for its window id; while any native or manual reading is fresh, the count is information only. A stale or reset reading leaves `fresh`, so the count gates again when nothing better is left. `status()` marks such a window `superseded`. A hard provider refusal clears the person's number for its window. `forget(peer, id, kind?)` lets the Kimi count drop only its own reading.
- **Notes.** `src/hub/budget-notes.ts` (pure) builds one line per attached peer that shows no number, from the definition and counters, never from a log: `budget.noQuotaReason` (Pi, local) gives `no quota: ...` plus the hub's own 5 h token count for that peer (a `TokenWindow` fed by `addTokens` and seeded from `tokens` events at startup, information only); a peer with a source that has not reported says which; Kimi says by its count state (`KimiUsage.status()`: off, waiting, counting, unreadable with a reason code). The `budget` control reply carries `peers` (the notes) and `kimiSource`; the dashboard snapshot adds `note` and `noteKind` per peer.
- **Surfaces.** `ahub budget` prints KIND, SOURCE and MEASURED per window, `info only` for a superseded count, and each note; the console's Peers detail and Usage detail and the dashboard's Usage budgets row show kind and source. The dashboard keeps its own copy of `windowKind` (`windowKindOf`, the page imports nothing); `test/ui.test.ts` runs it against the source. `ahub doctor` adds `kimi usage source` (Hub section) from `kimiSource`; an older hub without it adds no row.
- **Not here.** The OAuth probe for Kimi's plan quota (AC9) stays undecided, and the live checks (AC11) stay open.

## Amendment: amem runtime (agent-mem#13 P4)

The hub uses exact-pinned @staix/agent-mem 0.7.0 for runtime recall/capture, with no HTTP to the claude-mem worker. The canonical alias-resolved project and selected-profile fence govern every operation. Curated notes remain the evidence for ask and briefs; raw deterministic capture and pending candidates do not become evidence. Explicit task notes use the native store once; auxiliary checkpoint/model answers are candidates. Legacy worker project labels and numeric observation ids are replaced by canonical keys and authentic amem entry ids. Recent recall is curated short-term data, not model-generated tool summaries. Claude-mem is import-only and off by default. Host PII/private-turn/path screening is retained. The supplemental curated view's 4096-row ceiling refuses an oversized view; policy-aware pagination is its upgrade path.

## Amendment: backlog issue planning and phase grooming (#759)

- Duplicate candidates exclude two tasks related by directed `deps`/`after` reachability in either direction. No follow-up field or inference from titles, notes or `supersededBy` is introduced. Overlap findings remain unchanged. A bounded public ID/dependency context may include approved intermediate phases; missing/private context is never read as an invented edge.
- `hub_backlog_plan` accepts an omitted `fields` or `{}` with the existing bounded reason. It records a note-only `planned` revision with an empty field list; authority, stale revision, pins and frozen-release guards remain.
- `fields.sdlc` accepts only `repo`/`issue` on an unstarted, ownerless backlog card, by its effective planner or the person. Null identity members restore a previous absence during undo. Other lifecycle/evidence fields remain unavailable through planning, and ordinary `hub_sdlc_record` still refuses backlog cards.
- Issue relinks use the same identity invalidation as `sdlcReceipt`: old spec acceptance and identity-bound evidence cannot survive a different identity. Existing stage is preserved, or the host's initial stage is used when the card had no receipt. The atomic planning write records the new revision and only previous identity members; undo cannot revive an old acceptance receipt. Authority and task/release/privacy state are rechecked after screening.
- CLI `ahub backlog plan ... <fields-json> <reason>` uses `{}` for a note and nested `sdlc` for an issue relink. Tool descriptions expose the same contract. Actual cards #138 and #287 are relinked to #525 and #754 only after landing and availability in the running hub, through an authorized planner/person identity.

## Amendment: the planner board-changed notice (#758)

The notice "The board changed. Before offering or accepting build work, read `hub_planner_groom` ..." went to every attached planner at every board status revision, including revisions the planner wrote itself, and queued a new copy each time. One planner session received it 12 times in 44 minutes. With the lifecycle on, `flushPlannerNotices` now reads what was added to each card's history since its last scan and decides per planner:

- **Author skipped.** A history entry whose `by` is the planner raises nothing for that planner.
- **Scoped.** Only the card's planners are told (`taskPlanner`, #525-2): a card bound to one planner does not reach another.
- **Task weight only when a plan review is needed.** A history entry that carries `planning` (a planning revision or dependency change), a card's creation (a peer's propose, with or without `after`, a split child, a generated card: new work and its dependencies are what a review consolidates) and any change of a card's `deps` since the last scan, whatever wrote it, is a `task` notice. An earlier copy that is still queued for that planner (never attempted or delivered) is withdrawn and replaced, so there is at most one unsettled notice per planner and it names the latest board revision. A settled notice is not replaced.
- **The hub's own bookkeeping tells nobody.** An entry by `hub` without `planning` (lifecycle links, idle sweeps, holds, plan observations) neither raises a notice nor spends the `fyi` window.
- **`fyi` weight otherwise.** A state move, review or assignment is recorded as an `fyi` task notice (console and log, no turn), at most once per planner per ten minutes (`GROOM_FYI_WINDOW_MS`, bounded by the injected clock `TasksDeps.now`).
- **Restart and offline.** The first notice a planner gets after a hub start is task weight, as before. Changes made while a configured planner was offline stay pending for it.

Ceiling: a scan lists the board once per status revision (at most one per flush); an indexed history read is the upgrade. `PROTOCOL` is unchanged.

## Amendment: canonical memory symbol anchors (#684 phase 3)

- Normalize symbol signatures with the phase 1b normalizer and preserve explicit file qualification in the existing `symbol:<qualified>@<path>` format. No amem operation, schema or code index is added.
- "Link that task's memory entries" means the new completion note carries screened, current-head, actually changed symbols with positive unambiguous code-facts `exists` evidence. Earlier notes remain immutable and connect through their shared reset-safe task node while the existing short-term completion finding is live. `related(... [symbol] ...)` reaches an earlier note at memory hop two; the package graph's literal two-edge cap reaches the task node. No read-time overlay is part of this phase.
- Non-completion notes retain their existing normalized plan-intent associations. Completion notes with unknown observations write no symbols and say unknown, never the plan's guesses. At most 16 candidates are checked; no new check starts after a two-second scheduling allowance, and an in-flight check retains the existing code-facts execution/cleanup bounds. Recheck current privacy, repository/head provenance and the admitted completion observation before writing. PII tasks query and store nothing.
- `ahub doctor --stale-anchors [--json]` is read-only, bounded and advisory. Only positive absence at the reported current head means stale. Private, ambiguous, unverified and exhausted evidence stays unknown with explicit coverage/truncation. It never mutates notes or grants authority.

## Amendment: phase 3 follow-up query and cleanup bounds (#684)

- Reuse a filled exact-tree symbol-preparation key across prepare-only and completion. Within a pass, memoize unknown and known exists results by query name; preserve privacy/provenance rechecks and optional fail-open results.
- Query explicit raw and normalized symbol forms together for historical recall; never copy, supersede or rewrite old notes.
- Unsupported `#`, `->` and `:` name forms remain unknown. Final absence rows are labelled "absent from indexed definitions", retaining existing state/reason compatibility; no imported-package existence claim is inferred.
- The doctor may use transient detached worktrees. Interrupted cleanup can leave prunable registrations; no automatic prune is added. Repeated owned cleanup failure remains neutral and borrowed handles retain caller ownership.

## Amendment: memory code-neighbour projection (#684 phase 4)

- Optional caller/callee edges are computed at read time through code-facts, one hop only, and stamped with the exact current HEAD. Require a unique path-qualified seed; hide ambiguous and name-only edges. Store no code structure or edges in amem.
- Dashboard Memory's default is the stored graph. An explicit Code neighbours toggle adds dashed calls and highlights attached notes, fails first; the accessible edge list includes direction and SHA. Prepare asynchronously outside the synchronous snapshot budget, then recheck current policy/profile/HEAD.
- Symbol-start `hub_memory_graph` merges the overlay inside the existing node/edge and 6144-byte response caps. Code coverage and truncation are explicit, including unknown evidence. Authored about/rules_out associations remain distinct from derived calls.
- Preparation bounds: four seeds, 32 distinct neighbours, 64 call edges, 16 screened notes and a two-second query-start allowance; existing in-flight code-facts timeouts remain. PII tasks/turns query nothing, and names pass publicMetadataText before disclosure.
- Native task briefs may prepare asynchronously, merge direct and neighbour-attached fails/decisions first, and preserve their current combined item/line cap, deduplication and fail-open policy. Snapshot the item cap once before selection; reloads apply to the next brief. The console detail reports the bounded selected-note count, not a complete inventory.

### Round-1 optional-read scheduling bounds

- Keep screened direct task advice independent of overlay eligibility and validity. Board movement, foreign scope or a private owner turn may drop optional code context but must not drop the existing direct brief. PII tasks still make no optional query.
- Default CodeFacts review/completion queries have priority over optional neighbours. Interrupt an active optional CLI, await all existing owned cleanup and then admit priority work; do not run native tree preparations concurrently. Optional unknowns have a bounded five-second TTL and never poison priority cache lookups.
- Dashboard code work requires the Memory view to be open and visible. Derive starts share a five-second floor; known topology lives at most thirty seconds, with current note rows refreshed before publication. A single hardened native HEAD probe establishes a bounded HEAD/ref proof; cache checks do not launch Git.
- Console task counts use cache-only optional context and return unknown on a miss within the existing task-detail deadline. Snapshot the native brief cap before awaits. Preserve stored nodes when adding derived edges and apply tier/kind/peer filters to neighbour notes; a non-symbol selection resets the toggle.

## Amendment: the planner reads any task and cancels its untouched declined task (#812 AC5)

- **Supersedes** the #208 sentence that refuses every peer but the conductor, a task's owner and its reviewer, and the #438 sentence that limits a planner's cancellation to work with no historical acceptance.
- `hub_task_show` also admits the configured planner (a peer holding the `planner` role, `Tasks.isConfiguredPlanner`, `ConductorHooks.isPlanner`) for any task outside the backlog (a staged backlog row stays hidden from agent task tools, #263, and is read through the planner tools; a peer that is also the conductor takes the audited conductor path). It gets exactly the conductor's view (`publicConductorTask` over `Tasks.publicView(task, true)`), so a PII task is still a stub with no history. The read writes no conduct audit event and grants nothing else: the planner cannot assign, escalate, hold or start through the conductor tools, and every other peer is refused with the conductor-role error as before.
- `hub_task_cancel` by the planner keeps every check it had (its own proposal, `backlog` or `proposed` state, planner authority, no private turn on ordinary work, the flow revision, recovery and shutdown exclusion) and replaces only the acceptance test with the evidence test `hub_backlog_return_untouched` uses (`taskHasWorkEvidence`): a branch, commit, PR, recorded local check, done, verdict or reopen refuses with the unchanged text `planner may cancel only its own historically unaccepted backlog or proposed work`. An accepted-then-declined task with none of them (the observed case, #454) is cancellable; the history keeps the acceptance and the decline.
- Reason: the planner could not read a task it had proposed once an owner took it, and could not clear the board of a task its owner declined untouched. The person's cancellation is unchanged.

## Amendment: conductor-bound recovery continuation and task unassign (task 535, #900)

- A configured conductor may create a restart with `ahub restart --yes`, or an upgrade with `ahub upgrade --yes --to <exact-version>`, only when the source hub can issue the operation's private continuation proof. The parser still validates `--to` as an exact version. A target that requires handoff to a newer or otherwise unsupported coordinator is unknown for this purpose and remains person-only.
- The source preflights every planned project for recovery support and current authority before staging. An upgrade stages and verifies its exact target next; a restart has no package stage. Only after target bytes and feature support are verified does the source issue the bounded, fixed-shape per-operation host HMAC record, before publishing the public operation, taking its lock or applying runtime holds. Its mode-0600 key and record stay in host state, separate from public recovery JSON and `delegatedAudits`. The seal binds operation id, initiating peer, project id and canonical root, source instance, target root/package digest, plan fingerprint and a version-neutral digest of bounded raw config/routing texts, source-resolved fallback routing bytes and the fresh actor/privacy decision. It does not hash expanded defaults, default roles or parsed routing; the public `conductorRoutingDefaults` map is advisory and the target inherits the sealed source fallback. The private record stores digests rather than raw config, routing contents or the HMAC key. Upgrade package identity includes the exact hoisted `@staix/agent-mem` dependency; restart uses its verified source dependency.
- The record authorizes continuity only for the same conductor and its own source-created restart or authorized upgrade. Another conductor cannot adopt it, and a public or person-created recovery operation cannot be converted into conductor authority. The person retains the ordinary recovery path. `recovery resume|abort` may continue only that same bound operation; `recovery-run` is not a general conductor command.
- A detached runner or target launcher may continue only the operation's captured, validated argv. No arbitrary CLI command, target selection, fresh-session override or other console authority is conveyed. `--live-test` is a separate existing invocation gate and does not issue this proof.
- The host rechecks the initiating peer's current conductor role and roster membership, project/write authority, and non-PII/privacy policy before every effect and after awaits. Offline continuation is limited to bounded current actor/privacy evidence; unrelated public board writes alone do not invalidate it. Missing, changed or unreadable evidence stops the next effect before it occurs.
- Captured TUI terminal restoration remains person-only: a delayed native launcher cannot re-prove the conductor at its eventual spawn. Conductor continuation refuses captured terminal launches; headless restoration uses the target-owned snapshot through a tools connection.
- An unmanaged reconnect-only Claude channel may reattach itself without a native launch. The source keeps a SHA-256 fingerprint of its observed session identity separate from restoration metadata (the raw unmanaged session id is omitted from the plan) and verifies the exact peer, kind and attachment against the live channel. This exception requires no terminal or restoration arguments, no managed launch proof, and an absent or confirmed-ended launcher; unknown launcher evidence refuses. Other peer identities still compare exactly.
- Recovery does not adopt unpublished protected config or routing changes. Candidate policy must match the source's accepted running policy. The replacement validates the exact captured startup inputs against the private grant before adapter imports and uses those same inputs for config and routing publication; a later file edit cannot replace the verified snapshot. Changed or unknown policy requires the person.
- The proof is a same-host integrity mechanism, not an OS boundary: a process able to replace both the host key and its private record can replace the seal. Native and real-account receipts are not implied by fixture tests.
- `task unassign` is also a conductor operation, executed and recorded as the actual conductor. It does not route a replacement or stop native work. An owner unassign keeps automatic offers suppressed until a later authorized explicit assignment or reservation clears that suppression; other task eligibility and planner rules are unchanged. Open tasks with host-marked conductor assignment history require a `conductor_recovery` target even for person-run recovery, so a downgrade cannot erase manual intent.
- Ordinary peer classifications do not expand: `backlog list`, `release list` and `sdlc costs|metrics` remain Console for agents; existing public read forms and dry-run previews are unchanged.

## Accepted contract: external module-kind instances (#754)

**Status: accepted on 2026-10-27.** The [person's decision on #754](https://github.com/STAIxBWLB/agent-hub/issues/754#issuecomment-6441781951) selects O1 explicit module opt-in, O2 implementer/verifier/ordinary continuing reviewer, O3 live startup catalog only and O4 retained live-module recovery refusal. The contract-only deliverable was board task #287 (PR #892), against main `7a599197`; it enabled no source or feature. Implementation is board task #529, with field names frozen below and A1-A8 as its delivery gate. The original A4 blanket instance refusal applies to earlier hosts; this implementation replaces it only for opted-in, host-verified instances. Source/fixture support is distinct from native/account receipts.

### Existing boundary and accepted scope

- Keep person-owned, untracked machine-local bundle declarations, content pins, daemon-startup-only imports and immutable project catalogs. CLI reads, previews, reloads and watchers never evaluate a module. A tracked, shared, cloned or unknown-provenance declaration grants nothing.
- Keep the A4 executable subset: headless ACP, the public `AcpPeer` transport, bound peer id, `deliveryOnly === true`, `hubOwned === true`, `form === "headless"`, verified owned-group admission and load-session echo. A module pin authorizes daemon-privileged code; it is not a sandbox or a proof that an approved module cannot be malicious. An import timeout is not cancellation or rollback of privileged initialization.
- Keep builtin namespace reservations and every fixed-builtin capability exclusion. No native engine, native/fresh-reviewer variant, host proof port, native home/model/provider selector, native hook, budget callback or arbitrary configuration callback becomes an external-instance capability. `instances` policies reserved for builtin definitions do not become module-supplied callbacks.
- The accepted first slice requires explicit module opt-in and permits implementer, verifier and ordinary continuing reviewer instances within an explicit module-role subset and the kind ceiling. Every instance has its own managed worktree. Existing reviewer independence and MCP restrictions apply; planner, conductor and fresh/isolated reviewer capabilities remain excluded, with no claim of fresh-reviewer isolation. Semantic validation uses the live startup catalog, and live external controlled recovery remains refused.

### Stable module identity and a current startup binding

- A kind name, display label, instance suffix, roster row or adapter-reported generation is not module identity. Startup retains the provenance of each validated definition alongside its captured bundle: canonical project root, normalized project-relative declaration path, full lowercase SHA-256, exported kind, `ADAPTER_API` and a digest of the validated data-only capability/permission ceiling. Duplicate kinds, builtin/configured namespace collisions, wrong hash/API/kind, unsupported fields and unknown provenance refuse independently before any affected native start or bus admission.
- Resolve `instances.<id>.kind` only against that daemon's verified startup catalog. Its module binding is the exact retained tuple, not a later path lookup or an entry from the process-global builtin registry. No kind is inferred from an id prefix to repair a missing declaration, and no missing external kind falls back to a builtin, configured kind or another module with the same label.
- Keep stable identity separate from liveness: a new daemon has a new catalog epoch and new owner generations. Recovery may compare an exact stable tuple, but it never reuses an old catalog epoch as current-owner proof. Pin, declaration-path, exported-policy or instance-policy changes invalidate continuity; no automatic repin, path relocation, native-session rebinding or fresh-session fallback is implied.
- Module and instance declarations remain restart-bound. A reload can report pending changes and revoke affected authority when its evidence no longer matches, but cannot import, repin, create a new catalog or silently publish the desired replacement policy as running policy.

### Implementation field and schema names (#529)

- Module opt-in is `AdapterDefinition.headlessInstances?: { form: "headless"; roles: readonly ("implementer" | "verifier" | "reviewer")[] }`. Only own-data values within the module's roles are admitted. Raw builtin `instances` policy remains forbidden by presence; the host derives its internal headless policy after validation.
- `CreateContext.instanceStateDir?: string` carries the private host-derived namespace at `<stateDir>/instances/<id>`; `stateDir` remains canonical daemon control/MCP state. An instance factory must pass the exact host `daemon.acp` options object to the public `AcpPeer`; copying or replacing those options cannot mint a managed-spawn receipt. MCP children receive a fresh launch id and remain mutation-fenced until owned startup admission completes.
- `ExternalInstanceBinding` schema 1 has exactly `schema`, `projectRoot`, `instance`, `kind`, `modulePath`, `sha256`, `api`, `capabilityDigest`, `policyDigest` and `executionCwd`. Paths and module pin are captured at verified startup, digests cover normalized data-only capability and instance policy. Recovery peers and restart snapshots carry it as `externalInstance`; integrity includes `externalBindingsDigest`. A private `external-instance.json` contains `{ externalInstance, sessionId }` for later same-binding manual resume. A supplied session id requires an exact retained binding; a mismatch refuses before native effects. After restarting to capture changed declarations, a person may instead request a fresh start under the current verified binding, and successful admission replaces the record. A fresh native session never applies instance-policy edits to an already running daemon. These records carry no runtime permission choice or current-owner proof.
- The combined feature is `external_adapter_instances`, requiring `external_adapter_modules` and `peer_instances` even for stopped declarations. The bounded data-only status projection is `externalInstanceCatalog` schema 1, scoped by canonical `projectRoot`, daemon `epoch`, policy `fingerprint` and at most 64 instance rows. Authenticated `ControlClient.readExternalInstanceCatalog(projectRoot)` validates its live epoch and features; it never creates executable definitions. Offline declarations remain separate `declaredExternalInstances` rows with fixed `catalog-unavailable` refusal codes. A kind missing from the live startup catalog stays inert with `kind-unavailable`: the host cannot distinguish a misspelled builtin from a refused module kind without guessing its identity.

### Instance declaration and opt-in policy

- Instance ids retain the existing `<declared-kind>-<name>` grammar, nonreserved ASCII id bound of 32 characters and project-wide maximum of 64 instances; modules retain their 16-entry bound. A kind too long to admit a valid instance id refuses; ids are never truncated or rebound. Existing builtin/configured declarations keep their current rules.
- Under accepted decision O1, a newly pinned module explicitly declares a bounded own-data headless-instance opt-in. Its proposed logical fields are headless form and an allowed role subset. This is a new reviewed external data subset, not permission to declare builtin `instances`, reviewer backends or executable policy callbacks. Field/API compatibility names must be frozen in the separate implementation task plan; older hosts must clearly refuse the new subset rather than treat it as singleton support.
- An instance declares only its kind, role subset, headless form, managed worktree and the existing permission/read-only selection. Command, argv, provider, model, native data home, environment overrides, launch callbacks and fresh review mode are outside the first slice. The host must newly derive a private per-instance state namespace and pass it with the exact instance id, execution root and MCP binding. Today the ACP context carries the shared daemon `stateDir`; it does not already provide that isolation. Keep canonical daemon control/MCP state separate from private instance state, and freeze the context field carrying the new namespace before implementation; config cannot choose a callback or alternate SDK.
- Roles are intersected with the captured kind ceiling, the accepted instance-policy ceiling and host role rules at config validation, effective-role derivation, routing and tool admission. A later id-keyed role list cannot restore a refused role. Conductor and builtin-only planner eligibility stay excluded. Accepted O2 includes ordinary continuing reviewer instances alongside implementers and verifiers, only under the explicit module-role subset and existing reviewer-pool independence and MCP restrictions. An external reviewer instance never reviews a task it owns or implemented; the current reviewer-pool family and same-instance rules apply unchanged, as for builtin reviewers. Fresh mode and isolated builtin reviewer capabilities remain refused; every reviewer instance has its own worktree, without any claim of fresh-reviewer isolation.

### Execution root and non-transferable current-owner proof

- Every external instance, including a verifier, names its own existing `.worktrees/<id>` directory. This is intentionally stricter than today's generic verifier fallback. The host checks real directory identity, exact registered worktree root, same Git common directory and non-prunable inventory; no creation, repair, another checkout or canonical-root fallback occurs. A potentially writing instance requires an attached branch. Detached read-only execution needs an explicitly accepted read-only policy and cannot be used as write-owner evidence.
- Before native spawn, freeze the module/instance binding and the validated cwd. An affected instance joins the bus or gains `ownerIsolation` only after the host has current evidence tying that exact runtime object and owned-child launch generation to that cwd, module tuple, instance policy and daemon/catalog epoch. A native session or MCP environment string alone cannot establish it.
- The implementation must obtain that receipt from the actual managed ACP spawn/owned-process path, through a host-retained non-virtual binding, not a module's `recoveryMetadata().launch.cwd`, arbitrary getter or returned "proven" flag. Bypassing the managed spawn, returning the wrong transport/id/options or failing owned-group verification leaves no admissible receipt and refuses instance admission. A receipt describes the managed runtime; it does not confine daemon-privileged module code or all native tools to a filesystem sandbox.
- Recheck current bus owner, child generation, startup binding, policy and the registered worktree before write/task-owner admission, after intervening awaits and immediately before effects. Replacing a directory, switching the attached branch inside its worktree (including a switch to another attached branch), changing the module/policy binding, losing the owned process or receiving unreadable evidence revokes authority. A branch switch requires an explicit stop and person start to bind the new branch; a commit advancing the same branch does not. An unavailable check is unknown, never isolation; retain a failed-start owner with unconfirmed processes for explicit teardown rather than assigning its id to a replacement.
- Give every instance its own host records, queue/task identity, native session binding and MCP identity. Child environments replace inherited agent markers with the exact instance id. MCP access requires a host-issued current launch binding, rechecked after awaits; an old child, a base-kind child or a client that echoes another instance's env cannot act for it. Native configuration/credential-home isolation is not implied by worktree isolation, and no automatic native-home copying or credential migration is introduced.

### Permission ceilings and lifecycle

- A per-instance choice is machine-local and no wider than the captured module kind's native mapping and accepted host ceiling. An explicit managed mode must be advertised and acknowledged by that native session before bus admission. Missing mapping, failed acknowledgement or unknown state refuses that selection; it never becomes an implicit allow or a falsely claimed native `ask`. An omitted choice may retain the kind's existing unmanaged behavior, visibly unmanaged.
- `readOnly: true` requires the kind's supported native read-only mapping and observed acknowledgement. It also applies the existing host ACP read/search/think restriction and read-only MCP/tool ceiling; neither confirmation, an allow-always choice nor session budgets raise it. Read-only and an independent `permission_mode` selection stay mutually exclusive. Neither read-only acknowledgement nor a pin claims kernel isolation.
- Roster removal first fences dispatch, current tool authority and approvals, then stops the instance through the verified headless owned-process path. It does not detach a person's TUI or widen an external kind to a terminal form. Offline is insufficient if an owned process is pending or its absence is unknown: attempt only verified owned teardown, retain the owner/queue/in-flight uncertainty on failure, and perform no permission reset, task handoff, automatic restart or replacement until teardown is confirmed.
- A successful removal preserves queued work, independent pauses and recorded history. Return to the roster does not itself start or resume a module instance. A later explicit start obtains a new owner/launch proof under the same accepted identity rules; stale tools and replies never revive a retired generation.

### Bounded CLI metadata without code evaluation

- The current `{kind, displayName}` metadata is insufficient for external-instance semantic validation. A supporting daemon must project a separate data-only view of its verified catalog binding and instance policy. Do not manufacture `start.create`, `instances` callbacks or executable `AdapterDefinition` values from display metadata to make a validator pass.
- Proposed public view fields are bounded instance id, kind, display name, role names, headless/read-only and permission-state enums, availability/refusal code and an observation epoch/fingerprint. Keep at most 64 instance rows, kind/id at 32 characters, display names at 256 UTF-8 bytes and fixed refusal codes; truncate display only with an explicit incomplete indication, never silently validate a truncated inventory. Full pins/declaration provenance belong in authenticated person diagnostics. Module bodies, callback source, argv, native ids, provider errors, secrets and arbitrary native text are excluded.
- `status`, `help`, `route explain`, previews and upgrade planning consume declarations plus that bounded host projection without importing modules or invoking module callbacks. Metadata explains observed state; it cannot register code, grant permissions, prove current ownership or authorize a start. A mutating/start request revalidates the current authenticated daemon instance, feature set, startup tuple and declaration revision, not metadata echoed by its caller.
- Accepted O3 requires live-catalog semantic validation and keeps module declarations as `{path, sha256}`. Without a matching daemon, raw declarations may be listed as declared/unknown but cannot be resolved to an executable instance, assigned a guessed ceiling or used to prepare recovery. A cached projection never becomes runtime authority merely because its hash or label matches.

### Recovery compatibility and refusal before effects

- The implementation advertises daemon feature `external_adapter_instances`, in addition to the existing `external_adapter_modules` and `peer_instances`. Retained receipts and restart snapshots must carry a versioned stable binding containing canonical project root, instance id/kind, normalized module declaration path, full pin, API version, capability and instance-policy digests, and validated execution root. Integrity validation covers every field; any recorded native session is bound to that same tuple. Catalog epoch, runtime object identity and launch generation remain live host evidence, never portable ownership proof. Freeze the serialized schema in the separate implementation task plan and add the feature to every source/target incompatibility preflight. Old metadata cannot be silently read as that new proof.
- A supporting coordinator/source must refuse a target missing any required feature before recovery holds, session capture, native stop, terminal close, commit, target startup or module evaluation for that operation. This applies even when the affected instances are offline: a target that cannot interpret their declarations/bindings is not compatible. Apply the same rule to reused staged targets, lease renewal and the last pre-commit read; once committed, retain the verified target/package binding rather than rediscovering identity from mutable config.
- A source lacking the combined feature, an unreadable source feature/inventory response, or a declaration with no verified kind-to-pin binding also refuses before lifecycle effects. An older source's unknown/all-offline rows cannot waive the new external-instance floor. The CLI may conservatively report a possible unresolved module instance to refuse; that is not permission to invent its identity. Existing builtin/configured offline exceptions remain unchanged for those declarations.
- The staged target's host features/SDK and captured declaration pins are checked without importing project modules. A supporting target later validates the same captured module tuple and policy before admitting any affected instance; changed/missing pin, incompatible API/policy, wrong project/root or incomplete retained binding refuses without reusing a session under another identity. Module evaluation already authorized at daemon startup is not rolled back; a post-import exported-kind mismatch must still prevent native spawn, bus admission and owner proof.
- Accepted O4 retains A4's live-module controlled-recovery refusal. Stop affected module instances explicitly before the supported host restart/upgrade path; keep their stopped records and restore builtin peers normally. External instances remain stopped until a person's explicit start with the exact verified module/instance binding. A supplied recorded native session id is bounded and must receive a matching load-session echo; absent proof refuses and never falls back fresh. Automatic external-instance resume would require separately accepted source/target native-session, process-group and restoration receipts, not inference from `resumeById`.
- Feature-aware binaries (and any explicitly designated compatibility backport) must reject unsupported module-instance declarations before project-module evaluation or native start. Already released A4 binaries cannot provide this guarantee: at baseline `7a599197`, daemon startup imports pinned modules before validating instance declarations, so direct execution can evaluate a module and then refuse the instance. A supporting coordinator must refuse that target before starting it; direct legacy execution remains an explicit migration limitation, not a promised safe path. No client attaches an instance id without the combined feature. Removing a declaration to cross an initial unsupported-source upgrade is an explicit person action with stopped/history evidence, never an automatic workaround; a backport/version floor requires separate acceptance.

### Acceptance matrix for the later implementation

These are the implementation delivery requirements. The earlier contract-only PR #892 did not run them or enable support; #529 reports their exact-head results separately. Use fake bundled modules, fake ACP agents, isolated homes and host-side effect counters first; real native concurrency/session restoration needs its own declared receipt.

| Claim | Required positive and negative proof |
|---|---|
| A1 mixed catalog/identity | A builtin extra instance and implementer, verifier and ordinary continuing reviewer instances of an opted-in external kind coexist with distinct roots, native sessions, records, queues and MCP identities. The reviewer is admitted only within the explicit module-role subset and existing reviewer independence/MCP restrictions, with its own worktree and fresh mode refused. Missing opt-in, duplicate/colliding kinds, kind/pin/API/policy changes, ambiguous namespace and malformed/over-limit declarations refuse without rebinding. |
| A2 current execution owner | Registered exact worktrees succeed. Missing, symlink-replaced, prunable, foreign-repository, canonical-fallback and detached-writer roots refuse. Swap the root/pin/policy or owner across each await; no stale write/owner admission occurs. A factory that lies in metadata or bypasses managed spawn cannot mint owner proof. |
| A3 policy ceiling | Implementer, verifier and ordinary continuing reviewer roles and id-keyed overrides cannot exceed the explicit module-role subset or accepted kind/instance ceiling. Continuing reviewers cannot review tasks they own or implemented; existing reviewer-pool family, same-instance and MCP restrictions apply unchanged, and fresh mode is refused and planner/conductor remain excluded. Missing or unacknowledged native modes, read-only escalation and mutating MCP operations refuse before effects. Builtin-only fields, fresh reviewers, TUI/native engines, native proof ports and config callbacks remain refused, including explicit undefined declarations where presence is forbidden. |
| A4 no-import CLI | With import/callback tripwires, exercise online and offline `status`, `help`, `route explain`, preview and upgrade planning. No module evaluation occurs; unknown/stale/foreign-epoch/incomplete metadata cannot enable a factory, guess a ceiling or grant ownership. Outputs respect all row/byte bounds and contain no argv/provider/source data. |
| A5 roster and process lifetime | Fence an active delivery and approval before stop. Repeat with offline-pending and unknown owned groups: no handoff/reset/replacement until confirmed gone; queued and uncertain work is retained. Return and stale MCP/reply attempts cannot revive an old launch. |
| A6 source/target compatibility | Test missing features on source and target, unknown/all-offline old rows, retained/reused target mismatch, changed pins/API/root/policy and feature-aware/backported binaries reading unsupported config. Counter assertions show zero holds/captures/stops/closes/commits/new imports/native starts at a supporting preflight refusal. Separately cover the unpatched A4 startup order with a harmless import tripwire: it may evaluate the pin before refusing the instance, and must not be represented as satisfying pre-import refusal. Legacy builtin/configured recovery remains byte/behavior compatible. |
| A7 supported recovery ceiling | Under accepted O4, live external peers refuse controlled recovery; explicitly stopped instances stay stopped while compatible builtin recovery completes. Manual same-binding session load requires exact echo; missing/foreign echo and stale native ids refuse with no fresh fallback. Automatic resume is outside the accepted first slice; any later extension needs separate acceptance and its additional receipt matrix. |
| A8 delivery gate | Amend the relevant source/target feature checks and docs in the implementation PR; focused mixed regressions, conformance, affected seeded guards and the full `scripts/check.sh` pass at its head with `check: OK`, as required by issue #754 AC5. The earlier docs-only contract PR used documentation checks; that evidence does not satisfy this implementation gate. Report native/account checks and unknown coverage separately from fake/local/hosted evidence. |

### Decisions

The [person accepted these choices on 2026-10-27](https://github.com/STAIxBWLB/agent-hub/issues/754#issuecomment-6441781951). The acceptance authorized the separate implementation task #529 under the required proofs; it enabled no source behavior by itself.

| Decision | Accepted first-slice choice |
|---|---|
| O1 opt-in authority | Require an explicit bounded headless-instance policy in a newly pinned module; an existing singleton module does not acquire multiple ids by config alone. |
| O2 initial roles | Implementer, verifier and ordinary continuing reviewer within an explicit module-role subset and the kind ceiling, with existing independence and MCP restrictions. Every instance has its own worktree. Planner, conductor and fresh/isolated reviewer capabilities stay excluded; no fresh-reviewer isolation is claimed. |
| O3 offline declaration binding | Keep module declarations as `{path, sha256}` and require the matching authenticated live startup catalog for semantic instance resolution; offline rows remain declared/unknown. |
| O4 controlled recovery scope | Preserve the live-module refusal. Stop the instance explicitly, then a person starts it again with the same binding; there is no automatic resume. |

## Queue backpressure for automatic assignment (#800)

`tasks.queue_backpressure` is an opt-in machine-local config block. It does not
change the shipped routing template or frozen routing corpus. Its independently
optional integer fields are `max_queued` (0..10,000 envelopes) and `max_oldest_s`
(0..604,800 seconds). Each defaults to zero, which disables that threshold. Trusted
config layers merge these fields independently. A committed project cannot enable
the policy, and the person-only settings controls write untracked local config.
Reload applies the policy live. Zero disables a guard, so these controls have no
conductor-editable permissive floor.

The guard applies only to new automatic owner/reviewer offers. Counts strictly
above the configured maximum hold an offer; equality is allowed. An oldest pending
age strictly above its threshold also holds. Missing, invalid, future or otherwise
unproven age holds when age policy is enabled, rather than becoming zero or fresh.
A verified empty queue has no pending age and is allowed. Unknown count holds when
a queue policy is enabled. The fixed reasons are `queue-count`, `queue-age` and
`queue-age-unknown`. A queue-blocked automatic reviewer walk never turns into direct
approval: it remains blocked for a person or a later eligible reviewer.

The pure `assign()` receives policy, pending metadata and one host clock as data.
`Tasks` uses the same inputs for real assignment and `ahub route explain`; routing
never reads a journal or clock itself for this guard. The guard does not replace
WIP, capability, privacy, independence, roster or runtime ownership admission.
Planner-pull reservations still count in their own WIP metric, not as queue work.
When both thresholds are off, routing results/traces and delivery behavior stay
unchanged, and no queue metadata query is added to routing.

Only an explicit person/current single-conductor nomination can bypass queue
pressure, and only for that nominated owner or reviewer role. An explicit reserved
pull may bypass the owner's queue guard; an ordinary planner pull, an unreserved
pull choosing its owner automatically, or HUB auto-pull on a planner's behalf may
not. Merely having `namedOwner`, `namedReviewer` or a reservation is not authority.
A self-claim delivers no owner offer and skips owner queue admission only. A
person reservation holds its target under pressure instead of rerouting it.
Override authority and all other admission conditions are rechecked after awaits.
An owner nomination does not waive an automatically chosen reviewer's guard.
Future automatic offers reevaluate current queue conditions; no lasting override
is inferred from free-text history.

`Bus.assignmentQueue()` matches the number of envelopes actually waiting in
`Bus.queued`, not the number of digest batches, active deliveries or WIP tasks.
Age comes from host queue-arrival provenance, not an envelope sender's timestamp.
Opt-in arrival metadata is bounded and persisted with the existing v1 bus snapshot;
default-off snapshots keep their old shape. Legacy, missing or recovery-deferred
arrival provenance remains unknown across resaves/restarts until those entries
leave the queue. Advisory metadata may be omitted at the existing snapshot byte
ceiling rather than refusing an otherwise valid delivery.

When tracking is enabled, the journal keeps small per-peer summaries committed
with the bus snapshot; disabled writes do not rewrite the summary rows. Reads
use summary/count/oldest/revision metadata only, never delivery body JSON or a sort
of full delivery history. A revision mismatch, including an older daemon writing
the snapshot without updating summaries, produces unknown age. Summaries are also
checked against the bus's exact current queue count. Existing queue/delivery
ordering, steering, withdrawals, settlement and recovery traffic are not changed.

Queue-origin holds are reconsidered after queue mutations commit, on relevant peer
state/policy changes and at bootstrap. Rechecks are coalesced and bounded; they do
not poll delivery history or reassign unrelated legacy/person-unassigned work.
Ownerless proposals, including automatic decline/budget reroutes, are identified
by their host-written root queue stall code. A planning revision triggers fresh
admission rather than discarding that origin. A refusal from a separate plan or
policy gate replaces the queue origin, so queue mutations cannot poll GitHub for
plan evidence. Reserved retries pass through the existing WIP/in-flight-slot
admission; a full slot hands readiness back to the existing WIP release path. A held named proposal keeps its
intended target. Continuing reviewers stay bound unless that reviewer is actually
queue-refused (or the existing reviewer-pool rules require selection). Automatic review holds carry a host-only `queueReviewHeld` history marker,
bound to the current review role boundary and an opaque SHA-256 of the selected
head/repository/PR identity; manual reviewer or artifact changes invalidate it.
Candidate pages use board metadata, with fresh role/head/privacy/admission checks
before effects. Shutdown/recovery cancels queued recheck callbacks and fences awaited passes.

Status exposes policy and bounded per-peer queued count, host oldest timestamp,
age and fixed blocked reason separately from WIP. Unknown numeric values are null,
and human output says unknown. With the policy on, an unknown host age does not
fall back to a sender timestamp and appear fresh. The stall view retains the same
queue reason codes; metrics contain ids/numbers/closed words, not envelope bodies
or task text. The policy changes assignment admission only: it never drops,
reorders, auto-resolves or cancels existing delivery.

## Vendor model and effort controls (#266 AC1)

This is the capability snapshot from 2026-10-29, for Codex 0.165.0, Claude Code
2.1.312 and Kimi 2.3.2. It precedes task/role `exec`, execution policy and bench
matrix implementation. The [sanitized receipt](../verification/2026-10-29-model-effort-capabilities.md)
separates native configuration/control acceptance from provider execution.
A successful setter or readback does not identify the model that served an answer.

| Vendor / setting | Launch | After launch | Verified boundary and remaining unknown |
| --- | --- | --- | --- |
| Codex model | `--model` advertised by help; the `model` config override has verified native readback | `thread/start` / `thread/resume` model override and `turn/start.model`; per-turn setting becomes a thread default | A bounded, network-denied turn attempt followed by interrupt and no-override resume returned the requested replacement model. Provider execution is **UNVERIFIED**. |
| Codex effort | `model_reasoning_effort` config override; native config readback verified | Thread config override and `turn/start.effort`; sticky across later turns | Native reasoning-effort readback changed and persisted through the same interrupted attempt. Effort is a nonempty string in this version's schema; eligible values come from each model's `supportedReasoningEfforts`, not a universal four-level enum. Provider application is **UNVERIFIED**. |
| Claude Code model | `--model`; accepted by the isolated print/control session | Session `set_model` control ACK and canonical-family readback verified; `/model` is also documented for the terminal | Session configuration, not an active inference switch. Provider execution and a real interactive/account leg are **UNVERIFIED**. |
| Claude Code effort | `--effort`; launch-level status readback verified | `/effort` changes the session setting for a later message; print-session set/status readback verified | Native status changed from the launch choice to the new choice. Model-specific effort support and actual provider application are **UNVERIFIED**; thinking on/off or a thinking budget is not interchangeable with graded effort. |
| Kimi model | `--model` is advertised for that invocation | Vendor documents `session/set_model` and `session/set_config_option` with `configId: model` | Native initialize succeeded, but `session/new` returned `-32000` in the isolated, unconfigured, network-denied fixture. Selection ACK/readback and provider execution are **UNVERIFIED**, not established unsupported. |
| Kimi effort | No graded-effort flag was advertised by the observed root help; config-driven launch effort is **UNVERIFIED** | Vendor documents a `thinking` config picker; graded ACP effort is **UNVERIFIED** | Do not equate an on/off picker, permission `session/set_mode`, or an arbitrary graded string with supported effort. An open upstream report describes a graded-to-boolean collapse; revalidate the installed model/options before any mapping. |

The native interfaces and the hub's current wiring are different contracts. At
`88e38f3d`, the Codex adapter forwards TUI fields but hub-created turns supply no
model/effort override. Claude's headless writer supplies its declared model when
launching each child, including resumes; its current transport closes stdin after
input and exposes no later setting control. Kimi's ACP path has a launch model
argument and permission-mode control, with no hub model/effort setter or selected
model readback. These observations add no runtime setting or permission change.

The [Codex app-server contract](https://learn.chatgpt.com/docs/app-server),
[Claude model/effort controls](https://code.claude.com/docs/en/model-config),
[Kimi ACP coverage](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
and [graded ACP effort report](https://github.com/MoonshotAI/kimi-code/issues/1486)
corroborate the surface descriptions; moving documentation does not extend this
receipt to another native version. `turn/steer` is not the Codex setting interface.
An unsupported or unverified mapping must remain unavailable to a future policy,
rather than silently retaining a default or treating unknown as supported.
The [remaining smoke legs](../smoke.md#model-and-effort-capability-verification-266-ac1)
are separate from AC2-AC10 and any real matrix, account or provider proof.
## Amendment: domain packs (#513a)

A domain pack bundles a profile with the roles it expects, a review rubric and example checks in one file, so a project adopts a way of working with one command. This amendment records where the shipped implementation differs from the first plan for #318, and why.

- Format. `<name>.pack.json` holds exactly `name` (equal to the file name, never a profile's name), `profile` (one of the four shipped profiles), `summary`, `roles` (at most 8 catalog role ids), `rubric` (1 to 12 criteria, each `id`, `text` and `required`; ids are the #507 criterion ids) and `checks` (at most 8, each `id` and a display `note`). Any other field is refused. A pack is data and never authority: it adds nothing to `checks`, selects no command and grants no permission.
- Checks carry a `note`, not a `command`. The first plan gave a check a display command string. A command-shaped field in a file that `ahub init` writes into the project invites reading it as runnable, and `example_checks` is already the display surface: an example check is advisory text that is never selected or run. The pack's checks therefore become `profile_overrides.example_checks` as `<id>: <note>`. The deterministic check scripts that run are #513b's, and they need their own reviewed way to be selected, since profile selection installs no command (#259).
- Roles are named, not created. The pack lists catalog role ids that must already exist (shipped, or a project `.agenthub/roles/<id>.md`); a pack naming an unknown role is refused whole. `ahub init --profile <pack>` previews and writes the project's config, and does not copy role files: the project assigns roles with `catalog_roles` as before. The first plan had init install role files; that would make the pack a second writer of the role catalog, which has one loader and one validator.
- Layers. A shipped layer (`src/hub/shipped-packs.ts`, files in `templates/packs/`, bundled as text like the shipped roles) and a project layer (`.agenthub/roles/<name>.pack.json`, in the directory the role catalog reads; the catalog takes `.md` only). A project pack of the same name replaces a shipped one. Only the format example ships in #513a; the writing, analysis and ops packs are #513b.
- Init. `--profile` takes a profile or a pack name; a pack's base profile must equal the project's existing profile, and existing `profile_overrides` that differ from the pack's (compared as data, with keys sorted, so key order never matters) are refused rather than overwritten. The preview names a pack by ids only (rubric ids, check ids, role ids), never its text. The apply writes the rubric as `profile_overrides.review_checklist` (each line `<id>: <text>`, optional criteria marked, then the `{check}` line) and the checks as `profile_overrides.example_checks`, keeping every other key of the config; applying the same pack again changes nothing.
- Rubric ids follow the live #507 ids (a letter, then letters, digits or `-`, at most 48 characters, upper case allowed); the lower-case pattern in the first plan was stale. The rubric only words the review checklist: a task's recorded criteria are never added or removed by a pack.

## Amendment: the console class keeps trust, money, attribution and terminals (#933)

Plan of record: ai-workspace#60 decision 8. `classifyPeerCommand` (`src/cli/identity.ts`) is policy; every reclassified form changed its daemon-side check in the same change.

- **The person keeps** `permission`, `agents` beyond `--json`, `role assign`, `budget` changes, every `--as-user` form, a launcher's `personOnlyFlags`, `pet --window`, `watch`, `recovery reattach` and unknown commands, with the unchanged cause line and `OPERATIONAL_PERSON_GUIDANCE`. Also kept, by ruling: `upgrade --yes` (its detached recovery runner inherits the agent markers and the plan covers every running project; deferred to #900 with restart), the memory changes (`promote|demote|forget|supersede|rebuild|machine --label`) and the `goal` changes other than `link` (the pinned amem 0.12.0 records their actor as `user`; the upgrade path is agent-mem 0.13.0 attribution, agent-mem#143, after the pin bump in #958), and `route` beyond `explain` (no such form exists).
- **Settings.** The conductor's keys are `CONDUCTOR_SETTING_KEYS` plus `tasks.escalate_after`. `tasks.wip_limits.*`, `tasks.auto_pull` and `tasks.queue_backpressure.*` stay person-only because they decide how much work the hub hands out unattended; the routing-store keys (`routing.classes.*.peers`, `escalate_to`, `route`, `pi_backend`, `routing.stay_switch`) stay person-only because they decide who gets work.
- **The conductor** runs `board import`, `intake approve`, `schedule run|pause|resume` and `goal link` through their own daemon request, which calls `admitOperational` (role recheck, one `agent_cli` row) before Tasks sees it; Tasks admits the person or the admitted conductor (`TasksDeps.operational`) and records the conductor as actor. `research backfill`, `bench run` (its tasks proposed as the conductor) and `source add` run in the CLI, so the `admit` handshake is their one audit row, sent only after the CLI has checked their arguments. A native launcher with `cli.authority: "person"` starts through `hub_peer_start`, which needs `conductorStartable`.
- **Any agent, on its own task:** `task cancel` through the unchanged `Tasks.cancel` rule of `hub_task_cancel`; `task role` when it owns the task and the task is not in review; `task label` when it owns the task (`task_label_check`), with `by` on the research record, where a person's label for the same record always wins and an agent's counts only without one; `ahub deliverables` filtered by `taskShowAllowed`, the rule `hub_task_show` uses, before any file is read.

## Operational constants settings mechanism (issue #489 H1)

H0-classified operational numbers use fixed metadata in
`src/hub/operational-settings.ts`, consumed by the existing closed configuration
schema, `configApply`, shared settings rows and `DEFAULT_CONFIG`. Registration
is static and each schema leaf is explicit; writes, reload authorization,
inheritance and undo retain their existing paths. No new configuration file,
environment knob or request-level override is added.

The first conversion is `tasks.groom_fyi_window_min`: 1-1440 minutes, default 10,
live at the next planner-notice flush. Its unset behavior is pinned to the
independent pre-conversion `GROOM_FYI_WINDOW_MS = 10 * 60_000`. Only state-change
FYI coalescing changes; initial/planning/dependency notices, ownership and
sessions do not. A new row never grants conductor permission automatically.
Safety floors and contract constants are not converted by H1. A later exposed
safety floor must allow tightening only in schema bounds and have its own test;
wire/storage/protocol contracts remain constants.

## Capability invocation (#445)

Plan of record: the #445 C0 freeze (issue comment of 2026-10-17, owner decisions O1-O5 of 2026-10-18, go-ahead 2026-10-25). Phases C1-C4 implement it in order and amend this section when they differ. C1 (discovery) is implemented, see "C1 as built" below; D3 to D6 and C2 to C4 are not. The [C0 receipt](../verification/2026-10-30-445-capability-probes.md) records what the native sources actually expose.

Delegated execution, never shared execution: a peer publishes capabilities, another peer asks for one, and the target runs it in its own turn with its own permissions and sandbox. The hub never calls a native tool itself (Codex `mcpServer/tool/call` and `command/exec` are excluded) and never hands out credentials or MCP connections.

### Decisions

- **D1 manifest.** An adapter-definition field (`registry-types.ts`), one discovery path per adapter. Each `Capability` has `id` (`${kind}:${name}`, unique per peer id), `kind` (`command|skill|mcp_tool`), `name` (`/^[A-Za-z0-9_.:-]{1,64}$/`), a `sanitize()`d description of at most 300 characters, an optional flat `inputSchema` (absent means `{ input: string }`), the publisher's optional `sideEffect` (`read|write|external|destructive`), `source` (`acp|codex-skills|published`), `invoke` (`native|prompt`) and a `digest` over the canonical fields. Sources: ACP `available_commands_update` (`invoke: native`, the prompt `/name input`); Codex `skills/list` (`invoke: native`, the `turn/start` item `{ type: "skill", name, path }`); `hub_capabilities_publish` for Claude and others and Codex MCP tools (`invoke: prompt`). No cost hint.
- **D2 opt-in and discovery.** `invocation.share` in `.agenthub/config.local.json` only (`invocation` is machine-local and never editable from settings): a positive allowlist keyed by peer id, each entry pinned by digest with the person's `class`. A changed digest unlists the entry until re-pinned; an instance id never inherits its kind's entries. `hub_capabilities { peer? }` lists shared entries only (id, schema, effective class, the target's permission mode); unshared ones appear only in the person's `ahub capabilities`.
- **D3 authority.** Callers hold the new `invoke` hub capability; the conductor gets nothing extra. Effective class is the higher of the declaration and the person's `class` (O1); a side that names no class contributes nothing, and only when neither names one is the class `destructive` (O6). Gates: `read` needs no task and no approval; `write` and `external` need an open task whose owner or reviewer is the caller plus person approval on every call through `requestPermission` with a `personOnly` flag that bypasses unattended auto-allow (O2); `destructive` is refused (O3). Every hub-side refusal is a `PreEffectToolRefusal` with a precise reason before any envelope. A callee refuses with `[REFUSED] <reason>` (outcome `refused`); a native rejection is `failed`. Each invocation is a row in an `invocations` table in `hub.db` (ids, digest, class, task, approval id, args sha256, outcome, times, result bytes) plus an ids-only event; a task-scoped one adds history through `Tasks.recordInvocation`. Bodies are never logged.
- **D4 PII.** `hub_invoke` is refused during a PII turn, for a PII task, and when the Tasks PII screen finds or cannot rule out PII in free-text args. The result is bounded to 8 KiB, `sanitize()`d, given a hub-written untrusted header, addressed to the caller only and never captured to memory.
- **D5 transport.** New envelope kinds `invocation` and `invocation_result`, journalled, delivered alone and never condensed, priority `status`. `hub_invoke` returns `{ invocation, state: "queued" }` at once. Deadline `invocation.timeout_s` (default 600): still queued means `expired`; delivered without a result means `timeout` for `read` and `needs_review` otherwise. No caller cancel; the person uses `ahub queue resolve`. Offline, paused, held, off-roster and pull-only targets are refused (O4). Depth 1: no `hub_invoke` inside an invocation turn. `invocation` joins `DAEMON_FEATURES`; upgrade and restart refuse while invocation rows are open on a target without it.
- **D6 failures.** An uncertain `write` or `external` outcome is `needs_review` and never retried; a `read` may be redelivered once, on a `failed_safe` receipt only.
- **O5.** `invoke: prompt` capabilities are listed and invocable, labelled as model-mediated requests.
- **O6 (2026-10-30).** `destructive` applies only when neither the publisher nor the person's share entry names a class. It relaxes the freeze's "undeclared reads as `destructive`", which with O1 would have refused every native capability, since no native listing declares a class.

### What C0 found (binding on C1)

Probed on Kimi 2.3.2, Qwen 0.26.1 and Codex 0.166.0 in isolated, credential-free homes; the card's older versions were not probed.

- **Pins.** A source lists only on the version its receipt names. Any other version lists nothing until a new receipt covers it.
- **ACP listings need a session.** Both agents refuse `session/new` without auth (`-32000`) and send `available_commands_update` only after a session exists, so C1 reads the list from an authenticated peer's session, never from a probe of its own.
- **Builtins must be filtered.** Kimi and Qwen mix session builtins (Kimi `compact`; Qwen `clear`, `config`, `export`, `update`, `remember`, `forget`, `auth`) into the same list as skills. C1 lists only entries it can tell are skills: Qwen by `_meta.source`, Kimi by its `skill:` prefix. A builtin is never listed.
- **No schema, no class.** No native listing carries an input schema or a side-effect class (Kimi and Qwen give only an `input.hint`), so native capabilities get `{ input: string }` and their effective class is the person's share `class` (O6). A share entry without a class leaves the capability `destructive`, so refused.
- **Names.** Kimi names contain `:` and `.` and fit the regex. The id of a Kimi skill is `command:skill:<name>`; C1 keeps the native name unchanged rather than stripping the prefix.
- **Native rejection.** Qwen rejects a command outside its ACP set with `-32603`; Kimi ends the turn normally with an "Unknown ACP command" text chunk (source reading). C2 maps Qwen's error code and matches Kimi's text to `failed`.
- **Codex.** `skills/list` answers with no thread and no auth. The `skill` input item is in the stable schema; a live skill turn is unverified. `mcpServer/tool/call` has no approval gate in the 0.166.0 source, which confirms its exclusion.
- **Unverified until C4.** Executing a skill through `/name input` on Kimi or Qwen and a Codex `skill` turn (each needs an account), and listings under a real login.

### C1 as built (#445, task 178)

C1 lists capabilities and nothing else: no `hub_invoke`, no `invoke` capability, no envelope kinds, no `invocations` table. These points are where the build fixes or differs from the freeze above.

- **Where.** `src/hub/capabilities.ts` holds the pure rules (digest, sanitizer, flat schema, publish validation, share listing). The two native parsers and their version pins are vendor-specific, so they live in `src/adapters/native-capabilities.ts`, where the #451 registry guard allows vendor literals. `AcpPeer` and `CodexPeer` implement a new optional `PeerAdapter.capabilityManifest()`; the daemon reads it per call, never a cached or probed copy. The per-definition `capabilities.manifest` field of D1 is not used: the port on the adapter is.
- **No class is declared natively.** `Capability.sideEffect` is optional and absent for every native listing, so the digest carries `null` for it. `effectiveClass` is the higher of the declared and the person's class, a side that names none contributes nothing, and only when neither names one is the class `destructive` (O6). A value that is not one of the four reads as `destructive`. The `exec` class is removed from the manifest type.
- **Pins.** `NATIVE_PINS` is the one place the probed versions are written: Kimi 2.3.2 (`Kimi Code CLI`), Qwen 0.26.1 (`qwen-code`), Codex 0.166.0. A listing on any other version is empty. The repository's Codex pin is 0.154.0, so a pinned Codex lists nothing until a receipt covers it; this is intended and shown in `ahub help capabilities`.
- **ACP lists belong to a session.** The `available_commands_update` of the current session is kept whatever the turn state. One that arrives before `session/new` is answered waits and counts only when it names the session that was bound; one for another session is dropped. A restart clears the list. An offline peer lists nothing.
- **Codex.** `skills/list { cwds: [project], forceReload: false }` goes through the attached app-server connection with a hub id, so the TUI never sees the answer. Enabled skills only; the short description is used when there is one. An unattached, offline or unanswered peer rejects, which the daemon shows as no list.
- **Config.** `invocation` is a machine-local block validated by the closed schema (`invocation.share` only in C1; `timeout_s` arrives with C2) and applies live. `hub_capabilities` reads the share from the running config on every call.
- **Tools.** `hub_capabilities { peer? }` is a read tool, exposed to read-only projects; it needs no task and no approval. `hub_capabilities_publish { capabilities }` is the source for a session the hub cannot read natively: a peer whose adapter implements `capabilityManifest` is refused, every field is checked, an unknown field refuses the whole call, the invoke form is forced to `prompt`, the list replaces the last one and is bound to the publishing connection (the daemon's connection generation), and it is dropped when the peer goes offline. Both calls are refused during a PII turn and for a peer holding PII, and neither is captured to memory (`CAPABILITY_TOOLS`).
- **The person's view.** `ahub capabilities` (op `capabilities_list`, Console only, no `CONDUCTOR_TASK_OPS` entry) shows every found entry with its state (`listed`, `unshared` or `digest-changed`) and the class that would apply, for every peer, shared or not. The audit label is `capabilities` with no argument echoed.
- **Not decided here.** Whether a Codex skill can be run through a `skill` turn item, and how a Kimi or Qwen `/name input` behaves under a real login, stay C0's unverified list and move to C2 and C4.

