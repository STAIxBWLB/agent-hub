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

## Remaining bounded live probes

- Claude shell and `!` commands: in one isolated native session, run the same fixed marker-presence command through the shell tool and through `!`. Record `CLAUDECODE`, session-marker and hub-marker presence separately. A direct `!` check needs a native interactive session; do not substitute model-written text for the command output.
- Plain Claude plugin: compare tool availability and an actual channel push in a plain plugin session with a session launched by `ahub claude`. A successful MCP tool does not prove channel-push delivery.
- Kimi ACP MCP: connect an isolated ACP session to the same tool contract and request one status tool. Verify the native tool event and daemon reply, including refusal for an ordinary non-conductor peer.

## Verification limits

- Codex shell and MCP probes used the root agent's serial resource slot. Claude `!` environment behavior, channel push delivery and Kimi MCP access still require separate live observations.
- New unit and fake-adapter tests are prepared but have not been run by this worker. The root agent owns the final immutable-head checks.
