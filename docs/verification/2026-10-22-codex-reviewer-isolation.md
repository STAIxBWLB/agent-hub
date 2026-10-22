# Codex 0.163.0 fresh-reviewer isolation receipt

Date: 2026-10-22. Platform: macOS arm64. Scope: model-free production `codexReviewerBackend.prepare`; no `codex exec`, model request, account login, credential copy or live review was performed. This extends the [0.146.0 receipt](2026-10-19-reviewer-isolation.md), retaining its limitations.

## Source identity

The upstream annotated tag `openai/codex` `rust-v0.163.0` resolves to tag object `129b8ec7ee6f4511557a4856279f529025c25af4`, peeled commit `83086188ae0614bd882818ff1aa23f3194962012` (`git ls-remote` readback).

- [Exec switches](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/exec/src/cli.rs#L40) retain ephemeral sessions, ignored user config and ignored execpolicy rules. These do not remove every config layer.
- [Apps gate](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/mcp.rs#L403) excludes the runtime compatibility MCP server when Apps is disabled; configured MCP inventory alone cannot establish that.
- [Plugin manager](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L821) returns no plugins when disabled. [MCP schema](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/config/src/mcp_types.rs#L234) retains disabled-server exclusion and the enabled-tools allowlist.
- Legacy `notify` is independent of the hooks feature: [session construction](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/mod.rs#L5461), [hook registry](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/hooks/src/registry.rs#L124). The host now additionally pins `notify=[]` in both metadata proofs and returned exec argv. This is a source/argv guarantee, not a model-driven hook execution test.
- [Seatbelt compiler](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/sandboxing/src/seatbelt.rs#L624) retains anchored unreadable-glob translation, including `**/`, canonical-prefix and ancestor protections.

## Native production preparation

The installed fnm launcher was selected explicitly, rather than changing `codex_bin` or downgrading the main peer. The producer resolves it to the native `@openai/codex-darwin-arm64` executable and hashes its bytes. Its receipt's binary identity is `sha256:721bb3cd0657262380cfc3458992e1d7ec2c0a9a6e4b7365924c2ffc71722d4e` (the receipt hashes the native binary digest in the bound-command file list).

The probe created separate temporary HOME, CODEX_HOME and project directories. It removed inherited variables except PATH, TMPDIR and LANG, then set only those temporary homes. The hub transport was inert `/usr/bin/false` with no token. The actual production prepare function was invoked with a fresh session id, abort signal, fixed prompt and private paths. It returned a launch description; that launch was never executed. Both launch-owned and outer temporary directories were removed in `finally`.

Runs:

- Empty temporary homes, 0.163.0: passed every production admission leg.
- Separate temporary home with only synthetic stdio and HTTP MCP declarations: passed; ambient servers were disabled stubs, and only `agent-hub` remained enabled with exactly `hub_review` and `hub_task_show`.
- Final policy including `notify=[]`, 0.163.0 with synthetic ambient servers: passed again.
- Retained 0.146.0 executable with final policy and empty temporary homes: passed. Its receipt binary identity is `sha256:4a6398187165c5bd75ad92c9a6fba6df6d401a59b62f7e1ecf9218a8196852a6`.

The producer required unique effective Apps/plugins/hooks rows with value false, exact MCP transport/tool readback, bounded bundled-model catalog validation, stable binary/config metadata, public read success and all native sandbox canaries below. Every successful launch returned `readOnly: true`, `strictMcp: true`, `ephemeral: true` and `current(): true`.

| Native canary | Required observed result |
| --- | --- |
| Public file | Read allowed |
| Exact private path | Read denied |
| Nested `**/*.env` private path | Read denied |
| Symlink alias into private glob | Read denied |
| Portable-core `.env` and `.agenthub/state` | Read denied |
| Synthetic host gh, kube and docker credential roots | Read denied |
| Symlink alias into synthetic credential root | Read denied |
| New file creation | Write denied; file absent |

Admission retains the exact bounded allowlist 0.146.0 and 0.163.0, reports the observed version in the receipt, and refuses other versions with a bounded observed/required-version diagnostic. Malformed output is reported as unknown without echoing native text. The daemon preserves only this closed version-metadata diagnostic; ordinary isolation failures remain generic.

## Evidence boundaries

The network setting remains configured disabled, without a separate network probe. Web search is requested disabled; effective model-turn mode is not read back. Returned exec argv is checked, but no run proves exec selecting the named default permission profile. No account/model review, TUI interaction or native Linux result is claimed. These runtime tests exercise the installed macOS binary; same-user filesystem/config mutation after the final metadata check remains outside atomic snapshot guarantees. The supported credential-root list is bounded, not a classifier for every private host file. Hosted CI and the changed-source gate are separate code-verification evidence recorded on the PR.
