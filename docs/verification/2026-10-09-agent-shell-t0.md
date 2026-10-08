# Agent shell identity T0, issues #193 and #194

## Evidence collected

- Installed CLI reports `codex-cli 0.146.0` (`codex --version`, 2026-10-09). `codex app-server --help` supports configuration overrides and WebSocket listeners; its example names `shell_environment_policy.inherit=all`.
- The [version-pinned native environment implementation](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/shell_environment.rs) applies inheritance, default exclusions, custom exclusions, explicit values, and `include_only` in that order. It then injects `CODEX_THREAD_ID`. `AGENTHUB_PEER_ID` is an ordinary inherited variable and can be removed by filtering. The native thread marker is injected after filtering, which supplies a fallback without widening the user's environment policy.
- The [version-pinned core wrapper](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/exec_env.rs) explicitly documents thread-marker injection even with `include_only`.
- The [current configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) describes inheritance and filtering, and now describes a `filters` map alongside legacy `exclude` and `include_only`. Current documentation is not evidence that every new option exists in installed 0.146.0.
- The hub's Codex adapter passes a child environment even without optional launch values. It now sets its own marker and removes stale vendor markers inherited from the caller. Recovery authority remains scrubbed by `childEnv`.

## Bounded live probes to complete

- Codex shell, default inheritance: launch one isolated app-server with `AGENTHUB_PEER_ID=codex` and a harmless canary. Ask for one fixed shell command that reports marker presence and the canary only. Do not print full environment or thread/session values.
- Codex shell, restrictive filtering: repeat serially with `inherit=none` or `include_only=["PATH"]`; confirm the ordinary hub marker is absent while `CODEX_THREAD_ID` remains present. Compare the native shell output with `detectCliIdentity`'s identity result.
- Codex sandbox loopback: bind a disposable unauthenticated loopback HTTP responder and request that exact address using a shell under the installed default sandbox. Record actual permission/sandbox configuration and success or rejection separately; authenticated hub state must not be exposed.
- Codex MCP: configure one disposable stdio MCP server exposing a canary status tool. Ask for that exact tool once under the same sandbox. Record tool result and transport events, rather than treating configured MCP as proof of access.
- Claude shell and `!` commands: in one isolated native session, run the same fixed marker-presence command through the shell tool and through `!`. Record `CLAUDECODE`, session-marker and hub-marker presence separately. A direct `!` check needs a native interactive session; do not substitute model-written text for the command output.
- Plain Claude plugin: compare tool availability and an actual channel push in a plain plugin session with a session launched by `ahub claude`. A successful MCP tool does not prove channel-push delivery.
- Kimi ACP MCP: connect an isolated ACP session to the same tool contract and request one status tool. Verify the native tool event and daemon reply, including refusal for an ordinary non-conductor peer.

## Verification limits

- Live native inference was deferred to the root agent's serial resource slot. The source evidence above does not establish sandbox loopback access, native shell execution, `!` environment behavior, channel push delivery, or Kimi MCP access.
- New unit and fake-adapter tests are prepared but have not been run by this worker. The root agent owns the final immutable-head checks.
