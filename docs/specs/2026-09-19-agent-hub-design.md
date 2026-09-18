# agent-hub design spec

Date: 2026-09-19. Status: approved design, implementation not started.
Owner: Young Joon Lee. Repo: STAIxBWLB/agent-hub (private).

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
  (`a private memo`). Decision: do not fork; reuse its
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
- Local serving (verified): OmniRoute 3.8.50 on the campus DGX node `http://gateway.internal:20128`
  (WARP), `/v1/models` answers 401 without a key, Anthropic and Responses surfaces exist.
  vLLM serves `deepseek-ai/DeepSeek-V4-Flash-0731`; GLM-5.3-Flash on the DGX and
  Qwen3.8-27B are planned (`internal deployment plan`).
  OpenCode 1.18.31 already has a `dgx-dsv4f` provider for this gateway.
- Routing policy engine: NVIDIA-NeMo/Switchyard v0.2.0 (Apache-2.0). Route types
  `llm_classifier`, `stage_router`, `escalation_router`; `auto` needs a source build
  until v0.3.0. Standalone `switchyard-server` proxies `/v1/chat/completions`,
  `/v1/messages`, `/v1/responses` and forwards to any `base_url` upstream. Stability:
  libsy Beta, server Demo ("not for production"), pre-1.0.
- Workspace decisions inherited (`internal gateway plan`):
  no OmniRoute daemon on the Mac; subscription OAuths (Claude Max, ChatGPT, Kimi plan)
  are never pooled through a gateway; local models are for bulk and low-stakes work;
  PII never leaves the campus network (`internal routing criteria`).

## Decisions

1. Greenfield hub, not a fork. Bun + TypeScript, one repo, MIT.
2. Peers are equal. One `PeerAdapter` interface; three adapter kinds (channel,
   app-server, ACP) and one hub-native worker. Four default peers: `claude`, `codex`,
   `kimi`, `local`.
3. Kimi runs headless under ACP; the user talks to it through the hub console
   (`hub say @kimi ...`, `hub tail`). No Kimi TUI in the loop.
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
   relayed to the hub console.
9. Single machine, one hub daemon per project directory. Cross-machine broker is out.

## Design

### Components

```
Claude Code TUI ── MCP stdio ── plugins/agent-hub (channel server) ──┐
Codex TUI ──── --remote ws://127.0.0.1:<proxy> ── app-server proxy ──┤ hub daemon (Bun)
kimi acp (child, stdio) ── ACP client adapter ────────────────────────┤ bus · board · budget
local worker (in-process agent loop) ─────────────────────────────────┤ router L1
hub CLI / console ── control WS 127.0.0.1:<ctl> ──────────────────────┘
                                   │ model calls
                     switchyard-server sidecar (127.0.0.1, session-scoped)  L2
                                   │ base_url
                     OmniRoute the DGX :20128 (WARP) / https://gateway.example.edu      L3
```

- `hub daemon`: owns the message bus, peer registry and state machines, task board,
  budget coordinator, router L1, and the Codex proxy, ACP child and local worker. Survives
  Claude Code restarts. State in `.agenthub/state/` (pid, status.json, sqlite, logs).
- `plugins/agent-hub`: Claude Code plugin. Its MCP server is the channel; it reconnects to
  the daemon over the control WS with backoff. Exposes tools `hub_send`, `hub_inbox`
  (fallback drain), `hub_task_*`, `hub_review`, `hub_checkpoint`, `hub_ack_resume`.
- Codex adapter: spawns `codex app-server --listen ws://127.0.0.1:<port>`, runs a
  transparent proxy the TUI attaches to (`--enable tui_app_server --remote`), intercepts
  `item/agentMessage` completions, injects via `turn/start` when idle and `turn/steer`
  for `important` messages while busy, registers hub tools through `dynamicTools` on
  `thread/start` and answers `item/tool/call`. Per-turn inactivity watchdog.
- Kimi adapter (ACP client): spawns `kimi acp`, `initialize`, `session/new` (or
  `session/load` for resume), injects via `session/prompt`, collects
  `agent_message_chunk` into one outbound message per turn, tracks busy from the
  in-flight prompt, queues on `turn.agent_busy`. Relays `session/request_permission`
  to the console. Reusable for `opencode acp`.
- Local worker: agent loop over an OpenAI-compatible client (AI SDK
  `@ai-sdk/openai-compatible`, inferred) with tools `read`, `write`, `edit`, `bash`,
  `git`, `hub_send`, `hub_task_*`. cwd-scoped, denylist for secrets paths. Model comes
  from router L1 as a Switchyard route id or a fixed OmniRoute model id.
- Console: `hub tail` (live stream), `hub say [@peer] <text>`, `hub board`,
  `hub route explain <task>`, `hub budget`, `hub status`, `hub logs`, `hub kill`.
- Launchers: `hub up`, `hub claude [--safe|--unattended] [--via dgx]`,
  `hub codex [--new] [--profile dgx]`, `hub kimi [--model <alias>]`, `hub local`.
  Launchers inject only the flags the hub owns and refuse user-supplied duplicates.

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

- Never delivered back to `from`; `hop` capped at 3.
- `important`: deliver now (steer for Codex). `status`: batch per recipient (default 3
  items or 15 s) into one digest. `fyi`: board only. Markers `[IMPORTANT]`, `[STATUS]`,
  `[FYI]` in agent text set priority; default `status`.
- Every inbound cross-peer body is wrapped as untrusted (Claude: `<channel>` tag with
  `meta.source=<peer>`; Codex and Kimi: a fixed prefix line plus a standing instruction
  injected once per session).

### Peer state and delivery

| State | Enter | Delivery rule |
| --- | --- | --- |
| idle | turn completed / prompt returned | inject now |
| busy | turn started / prompt in flight | Claude: push (Claude Code queues); Codex: steer if important else queue; Kimi/local: queue |
| paused | budget gate or user `hub pause` | queue, reassign open tasks |
| offline | adapter disconnected | queue (bounded 200), drop `fyi` |

Inactivity watchdog per busy turn (default 300 s) forces `idle`. Queues are drained in
order on `idle`. Delivery is at-least-once with idempotency by `id`.

### Task board and roles

- sqlite table `tasks`: `id, title, class, owner, reviewer, state, refs, signals, history`.
- `class`: `plan | implement | bulk_edit | test | review | summarize | triage`.
- `state`: `proposed -> accepted -> in_progress -> done -> in_review -> approved | changes_requested`.
- Roles in `.agenthub/config.json`; default `claude: [planner, reviewer]`,
  `codex: [implementer]`, `kimi: [implementer, verifier]`, `local: [implementer, verifier]`.
- Flow: proposer creates a card (`hub_task_propose`), owner accepts, `done` triggers a
  `review` envelope to the reviewer with refs, reviewer verdict returns to owner.
  `changes_requested` reopens as `in_progress`; two consecutive rejections trigger
  task-level escalation (see routing).
- Role contract is injected natively: Claude plugin `instructions` plus an `AGENT_HUB`
  marker block in `CLAUDE.md`; Codex `developerInstructions` on `thread/start` plus
  `AGENTS.md`; Kimi and local: first prompt of the session plus `AGENTS.md`. `hub init`
  writes the marker blocks idempotently.

### Routing (three layers)

L1, hub policy, `.agenthub/routing.toml`, hot-reloaded:

```toml
[signals]
pii_patterns = ["\\b\\d{6}-\\d{7}\\b", "@example\\.ac\\.kr"]   # PII => local_only
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

L2, Switchyard sidecar, `switchyard.toml` generated by the hub from `routing.toml`
(targets from OmniRoute model ids; `sy/coding` = `stage_router` efficient_first with
GLM-5.3-Flash efficient and DeepSeek-V4-Flash capable until subscription-free capable
targets exist; `sy/review` = `escalation_router`; `sy/fast` = single target). Started
with `switchyard-server --config` on a loopback port for the hub session, stopped on
`hub kill`. If the binary is absent or fails health, L1 falls back to
`fixed_model` per class and calls OmniRoute directly.

L3, OmniRoute: one scoped token per peer (`omniroute tokens create`), so the dashboard
separates usage. On-campus over WARP; off-campus via `https://gateway.example.edu` with the two
Cloudflare Access headers, read from `<secrets>/`.

`hub route explain <task>` prints the signals, the chosen peer, the route id and the
reason. Verification failure (tests fail, review `changes_requested` twice) escalates
the task to the next peer in `escalate_to`; Switchyard handles per-call escalation
inside a peer.

### Budget relay

- Sources: Codex `account/rateLimits/read` and `account/rateLimits/updated` (verified in
  schema); Claude OAuth usage probe as agent-quota-guard does (inferred); Kimi
  `usage_update` tokens only, no quota API (verified absent). Local has no quota.
- Gate at configurable utilisation (default 0.9 of the 5 h or weekly window): mark
  `paused`, send `hub_checkpoint` request, the peer writes `.agenthub/checkpoint.md`,
  open tasks are reassigned by L1 (local first when the class allows), the peer resumes
  when the window resets (`hub_ack_resume` for Claude, `turn/start` for Codex,
  `session/prompt` for Kimi). Idempotent per pending record.

### Safety

- Untrusted framing on all cross-peer text; standing instruction once per session.
- `hub claude` and `hub codex` keep normal permission prompts. `--unattended` opts into
  `--dangerously-skip-permissions` and `--yolo` and prints a warning.
- Kimi and local tools: cwd-scoped, secrets denylist (`.maru/secrets`, `.env*`, keys).
- Loopback binds only; ports per project from a registry (base 4600, stride 10).
- No subscription OAuth through any gateway.

### Configuration and state

- `.agenthub/config.json` (roles, ports, filter tiers, watchdog), `.agenthub/routing.toml`.
- `.agenthub/state/` gitignored: `hub.pid`, `status.json`, `hub.db` (tasks, messages,
  budget), `hub.log`, `switchyard.toml`, `checkpoint.md`.
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
src/cli/            up, claude, codex, kimi, local, say, tail, board, route, budget, status, logs, kill, init
plugins/agent-hub/  .claude-plugin/plugin.json, .mcp.json, server bundle, hooks (SessionStart health, Stop announce)
.claude-plugin/marketplace.json
templates/          CLAUDE.md and AGENTS.md marker blocks, routing.toml default, config.json default
scripts/            check.sh, build.mjs, smoke-*.ts
docs/specs/         this file
CLAUDE.md, REVIEW.md
```

## Acceptance criteria

1. `hub up && hub claude && hub codex --new && hub kimi` in one project: a message from
   any peer reaches the other three within 2 s when idle, with untrusted framing.
2. A message sent while Codex is mid-turn arrives as `turn/steer` if `important`, else
   after `turn/completed`; while Kimi is mid-prompt it is queued and drained on
   `end_turn`, never lost.
3. `[STATUS]` messages from one peer are batched into one digest per recipient.
4. A task proposed by Claude, accepted by Codex, marked done, is auto-routed to the
   reviewer; `changes_requested` twice escalates per `routing.toml`.
5. `hub local` completes a `bulk_edit` task; OmniRoute log shows the request with the
   per-peer token and `x-omniroute-provider: vllm`; `hub route explain` shows the
   chosen route.
6. With Switchyard absent, the local worker still works via `fixed_model`.
7. A PII-flagged task never leaves the `local` peer (test with a fake pattern).
8. Mocked Codex quota at 0.95 pauses Codex, checkpoints, reassigns its open
   `implement` task to `local`, and resumes Codex after the mocked reset.
9. `scripts/check.sh` exits 0; live smoke checklist recorded in `docs/smoke.md`.
10. Default launches keep permission prompts; `--unattended` prints the warning.

## Tasks

M1 messaging core and three adapters
- [ ] Repo scaffold: Bun, TS strict, `scripts/check.sh`, `CLAUDE.md`, `REVIEW.md`, labels
- [ ] Bus, envelope, peer registry, state machines, control WS, state dir, port registry
- [ ] Claude channel plugin: capability, push, `hub_send`, `hub_inbox`, reconnect
- [ ] Codex adapter: spawn, proxy, agentMessage intercept, `turn/start`, watchdog
- [ ] ACP adapter: spawn `kimi acp`, session lifecycle, prompt, chunk aggregation
- [ ] CLI `up/claude/codex/kimi/say/tail/status/logs/kill`, `hub init` marker blocks
- [ ] Fakes plus unit and integration tests; live trio chat smoke

M2 coordination
- [ ] Priority tiers and status batching, marker parsing
- [ ] Codex `turn/steer` for important while busy; Kimi busy queue and drain
- [ ] Paused and offline queues, idempotent delivery, drop rules

M3 local worker and routing L2/L3
- [ ] Local worker agent loop with cwd-scoped tools and secrets denylist
- [ ] OmniRoute client with per-peer tokens and Cloudflare Access headers
- [ ] Switchyard sidecar: config generation, lifecycle, health, fallback to fixed model
- [ ] `hub local`, smoke through OmniRoute with provider header check

M4 task board, roles, routing L1
- [ ] sqlite board, `hub_task_*` and `hub_review` tools on all adapters
- [ ] Role contract injection per native surface
- [ ] `routing.toml` loader, signals (PII, context length, quota), `hub route explain`
- [ ] Review handoff and task-level escalation

M5 budget relay
- [ ] Quota sources (Codex native, Claude probe, Kimi tokens), gate, pause, checkpoint
- [ ] Reassignment to local, resume paths per peer, idempotency

M6 internal inference, packaging
- [ ] Status digests and triage through `sy/fast`
- [ ] Bundles for plugin and CLI, marketplace manifest, brew or npm distribution
- [ ] docs: quickstart, smoke checklist, security notes

## Out of scope

- Cross-machine broker or rooms, web UI, Windows.
- OmniRoute daemon on the Mac; pooling subscription OAuth through any gateway.
- Gemini CLI and OpenCode adapters beyond the ACP fallback note.
- Switchyard `auto` route until v0.3.0 ships.
- Running Claude Code itself on a local model (depends on the Anthropic-to-chat
  translation check in the OmniRoute plan v1, Phase 0).

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude channels are research preview; flag or protocol may change | Adapter isolated in one file; plugin version pinned to a Claude Code range; `hub_inbox` fallback |
| `switchyard-server` is Demo grade, pre-1.0 | Session-scoped sidecar, pinned version, L1 `fixed_model` fallback |
| Anthropic-to-chat translation drops `tool_use` | Claude never runs on local models in this design |
| Local worker executes untrusted room text | Untrusted framing, cwd scope, denylist, no `--unattended` by default |
| Steering a Codex turn changes its plan mid-flight | Only `important` steers; default tier is `status` |
| Kimi ACP has no quota API | Token-based soft limit only; documented |
