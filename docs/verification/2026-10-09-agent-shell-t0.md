# Agent shell identity T0, issues #193 and #194

## Evidence collected

- Installed CLI reports `codex-cli 0.146.0` (`codex --version`, 2026-10-09). `codex app-server --help` supports configuration overrides and WebSocket listeners; its example names `shell_environment_policy.inherit=all`.
- The [version-pinned native environment implementation](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/shell_environment.rs) applies inheritance, default exclusions, custom exclusions, explicit values, and `include_only` in that order. It then injects `CODEX_THREAD_ID`. `AGENTHUB_PEER_ID` is an ordinary inherited variable and can be removed by filtering. The native thread marker is injected after filtering, which supplies a fallback without widening the user's environment policy.
- The [version-pinned core wrapper](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/exec_env.rs) explicitly documents thread-marker injection even with `include_only`.
- The [current configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) describes inheritance and filtering, and now describes a `filters` map alongside legacy `exclude` and `include_only`. Current documentation is not evidence that every new option exists in installed 0.146.0.
- The hub's Codex adapter passes a child environment even without optional launch values. It now sets its own marker and removes stale vendor markers inherited from the caller. Recovery authority remains scrubbed by `childEnv`.

## Native Codex observations (2026-10-09)

- Real installed `codex exec --json --model gpt-5.5 --sandbox workspace-write`
  completed a single fixed Python shell probe in an isolated git fixture.
  With explicit `inherit=all`, the hub marker, native thread marker and harmless
  canary were present; a Claude marker was absent. The disposable loopback
  responder was reachable by the harness, while the native shell request failed
  with `URLError`, errno 1. No sandbox or network exception was requested.
- A second real run used `inherit=none`, an explicit PATH and
  `include_only=["PATH"]`. The hub marker, native marker and canary still appeared
  in the observed shell. This does not establish that filtering removed them;
  the difference from the pinned environment construction is unresolved in this
  installed host environment. The fallback is supported by source and marker
  presence, without widening the caller's configured policy.
- A real native MCP call under `workspace-write` completed `agent-hub.hub_status`
  against the candidate bundle and an isolated conductor daemon. Native JSONL
  recorded the MCP call completing, and the daemon independently recorded a
  codex `conduct/status` event. Only this exact hub tool was approved through the
  existing per-tool `approval_mode=approve` configuration; its daemon role check
  still applied. This proves MCP access separately from the blocked shell path.
- The first run with the user's configured `gpt-6.1-sol` failed before tools:
  that slug was rejected by the installed ChatGPT-account endpoint. The probe's
  explicit model selection did not change the user's configuration.

## Native Claude observations (2026-10-09)

- The final observer proof used source `20ad5e6`. Its read-only feed-off
  continuation verified one completed native turn, 263,413 cached-inclusive
  tokens, a matching opaque daemon Stop receipt, native idle and no pending
  deliveries. The fresh feed-own run verified two actual owner completions and
  independent file reviews, nine native finals matched by nine daemon Stops,
  27 unique usage records and 1,888,242 tokens. Eight completed turns contained
  supervision, totalling 1,292,922 tokens. The receipt matched the final native
  message, session, launcher and instance; earlier incomplete captures below
  were not retroactively marked complete.

- In the original captures, Claude Code 2.1.295, Opus 5.5, ran the candidate MCP tools in real PTYs
  after its five-hour quota reset. Both feed-off and feed-own fixtures started
  local and headless Pi, proposed two tasks, reassigned Beta to Pi, held and
  released both peers, and independently read the exact ALPHA/BETA files before
  approving their tasks. The console independently audited four allow-once
  answers in each fixture, covering the two writes and bounded file checks.
- The real feed-off TUI displayed inbound review requests; the feed-own TUI
  displayed actual supervision and review pushes. MCP success and channel
  delivery were observed separately. A transient startup warning about the
  server name did not prevent the later observed channel deliveries.
- In the feed-own native TUI, the operator submitted the fixed Python probe
  through `!`. Its actual command output was `AGENTHUB_PEER_ID=true`,
  `CLAUDECODE=true`, `CLAUDE_CODE_SESSION_ID=true`, `CODEX_THREAD_ID=false`.
  This is shell output captured before Claude's interpretation of it.
- A subsequent feed-off run pinned to `da2ebbc` executed the same fixed probe
  through the model's actual native Bash tool and separately through `!`.
  Both actual command outputs showed the same three Claude/hub markers present
  and `CODEX_THREAD_ID` absent. This closes the separate model-shell observation;
  neither command printed environment values.
- The original harness accepted hub idle too early and stopped both last
  review turns before a native final answer. Native transcripts independently
  show two completed turns in feed-off and five in feed-own, with the last
  assistant message still `tool_use` in each case. The board approvals are real;
  complete final-turn verification and production supervision accounting were
  incomplete for those captures. The harness now requires the current daemon instance, its session,
  the fixture-specific transcript, a final `end_turn` and `turn_duration` after
  the last actual review. Missing measurements remain unknown.
- The `da2ebbc` run verified the final native message UUID, message id,
  `end_turn`, subsequent `turn_duration`, daemon instance, session and launcher.
  Its complete transcript contains five completed turns and 21 unique usage
  records, totalling 1,451,782 tokens including cached input. The daemon certified
  only one native Stop, however. Its log refused the other completions as an
  unavailable completed transcript message or completion predating the current
  turn; the final refusal occurred before cleanup. A normal review receipt
  remained queued. Actual task/file/final-answer evidence is valid, while full
  runtime accounting and delivery settlement remain incomplete.
- The `6034dd9` read-only continuation preserved both approved tasks and exact
  files. It completed one native turn with four unique usage records and 261,483
  cached-inclusive tokens, but the matching daemon Stop remained absent. After
  a bounded retry, the Stop handler logged unavailable completion at
  01:39:04.087 UTC; the native stop summary/duration appeared at 01:39:04.095 UTC.
  With no overlapping operator prompt, this strongly supports a transcript
  visibility barrier while the native hook waits. The strict harness timed out
  incomplete and stopped its owned processes. The final message's thinking/text
  rows carried identical usage counters in these observed transcripts; this
  observation does not replace the final text/duration requirement.

## Plain Claude and Kimi observations (2026-10-09)

- Plain Claude 2.1.295, launched with the candidate MCP configuration but no
  development-channel flag, completed one native `hub_status` call with an
  independent daemon Claude status audit. Its only native tool calls were
  ToolSearch and that status call. A unique operator push was bridge-accepted,
  but no native pushed user row or response appeared in the observed
  20.075-second window. This bounded negative observation is not a universal
  claim about channel support. Actual channel-enabled review/supervision pushes
  were observed separately in the conductor cases. The plain probe and cleanup
  took 56.724 seconds and made no model file, shell, task or settings changes.
- Real Kimi Code CLI 2.1.1 answered ACP `initialize` and created native session
  `session_17eeb9dc-38d3-4685-b1aa-3db6a89b465c`. Its single prompt failed with
  protocol error `-32000`, HTTP 403, for the managed account's weekly usage
  limit before any requested tool event. No task-list/status result or ordinary
  peer's conductor refusal was obtained. The owning CLI's safe provider list
  showed only `managed:kimi-code`, type `kimi`, four models, OAuth, default
  `kimi-code/k3`. No distinct configured provider was found. The reset time
  remains unknown; no purchase, credential/configuration change or model retry
  was attempted. Owned native processes and the fixture daemon were stopped.

## Remaining bounded live probe

- Kimi ACP MCP: after native provider access is available, request the read-only task list and one conductor status refusal in an isolated ordinary-peer session. Verify actual native tool events/results and the daemon reply. The existing quota failure proves neither new-tool access nor refusal behavior; it requires an explicit deferral decision if the release proceeds without that live proof.

## Verification limits

- Codex shell and MCP probes used the root agent's serial resource slot. Claude `!`, model shell, enabled-channel pushes and the bounded plain-session comparison were observed in subsequent serial native cases. Kimi new-tool access remains unverified because its real account rejected the prompt before tools.
- New unit and fake-adapter tests are prepared but have not been run by this worker. The root agent owns the final immutable-head checks.
