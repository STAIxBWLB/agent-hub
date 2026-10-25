# Kimi 2.3.1 fresh-reviewer compatibility receipt

## Scope and identity

This #792 (K1) receipt repeats the model-free 2.3.0 procedure (`2026-10-22-kimi-qwen-compat.md`) on the installed Kimi 2.3.1. No real account, provider inference, personal configuration, native login, credential refresh or personal machine trust was used or changed. Per the person's 2026-10-25 decision the result is a version verification only: no `kimi-review` instance is declared, and Kimi stays a pull-only TUI peer. The reviewer remains off until a project declares one.

| Artifact | Binding |
| --- | --- |
| Kimi native macOS arm64 executable | version `2.3.1`; SHA-256 `f06ba6a3bb7ed2fc1f82590f7c22570736d9ee7344059fa92404ca75dc2d5b45` |
| Kimi source | tag `@moonshot-ai/kimi-code@2.3.1`, commit [`684bae9ea6a437f3bae98bba1dcb797a917d500b`](https://github.com/MoonshotAI/kimi-code/tree/684bae9ea6a437f3bae98bba1dcb797a917d500b) |

## What changed since 2.3.0

Four commits (`b5e28fd6..684bae9e`): workspace trust decoupled from runtime initialization (c569bab5), session-lock holder names and a lock takeover path (0e3980e7), a web dist sync and the release. The two that touch reviewer isolation:

- `workspaceMcpConfigService.ts` reloads file MCP servers after a trust change and adds `KIMI_CODE_TRUST_WORKSPACE` (`trustEnv.ts`). Project MCP is still loaded only for a trusted workspace. The reviewer child runs with a replaced environment and a clean temporary cwd, so neither the variable nor a project MCP file reaches it. The probe sets the variable in the host environment as a decoy and asserts it is absent from the launch environment.
- Session locks gained a takeover path and `KIMI_CODE_SESSION_LOCK=0`. A fresh reviewer never resumes or shares a session, so this does not change its contract.

## Results

The 2.3.0 producer was copied with only the version, source commit, output paths and the decoy changed. It ran against an isolated HOME and a synthetic native `KIMI_CODE_HOME` (managed `kimi` provider, invented access-only OAuth record, device identity). The native print leg redirected only the managed provider endpoint and its scoped synthetic OAuth slot to a loopback fixed-response server, which performs no inference.

| Leg | Fixture trust run | Verified run (no trust) |
| --- | --- | --- |
| `kimiReviewerBackend.prepare` (private config, exact two-tool agent, empty skills, replace env, `current()`) | pass | pass (`fixtureTrustOnly: false`) |
| Task-bound MCP: exactly `hub_review` and `hub_task_show`; other task id, third tool and missing auth refused; revocation refuses reads | pass | pass |
| Native exact-two-tools: 4 requests, every inventory exactly the two hub names, both calls reached the host, injected `Write` refused, marker `unchanged` | pass | pass |
| Native positive control: `Write` added to the agent; inventory includes it, marker written | pass | pass |
| Trust-env decoy absent from the launch environment | pass | pass |
| Cleanup of owned groups and temporary trees | pass | pass |

Before and after the verified run, the SHA-256 of the real `~/.kimi-code` `config.toml`, `mcp.json`, `device_id` and a digest over every file in `credentials/` and `oauth/` were identical.

The producer ran with Bun 1.4.3 (the installed one); the 2.3.0 producer used pinned Bun 1.4.2. The hub code it exercises is plain TypeScript with no bundle step.

## Not verified

A real-account review, attached-TUI coexistence during a review, OAuth refresh under a real token, review quality, token usage and quota behaviour remain unverified, as for 2.3.0. No future version or compatible line is inferred.

## Evidence

Kept outside the repository in `scratchpad/temp/agent-hub-792`:

| Item | SHA-256 |
| --- | --- |
| `kimi-probe.ts` | `0a7ed09fa3f27afd7177d262b668cc8a5700f4b4292141210806baba9fd540e1` |
| `kimi-native-result.json` (fixture trust) | `42368dab8aa210934ed66dae6e93113d078245461f9da10ee97286b582ff063d` |
| `kimi-verified-result.json` (no trust) | `b962a7ed389cf915051c1e7c73c54bb5dccb0dd96c522806371f6d7eb28e047d` |
