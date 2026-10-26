# Kimi 2.3.2 fresh-reviewer compatibility receipt

## Scope and identity

This #843 (AC5, task #508) receipt repeats the model-free 2.3.1 procedure (`2026-10-25-kimi-231-reviewer-compat.md`) on the installed Kimi 2.3.2. No real account, provider inference, personal configuration, native login, credential refresh or personal machine trust was used or changed. As for 2.3.1 the result is a version verification only: no `kimi-review` instance is declared, and Kimi stays a pull-only TUI peer. The reviewer remains off until a project declares one.

| Artifact | Binding |
| --- | --- |
| Kimi native macOS arm64 executable | version `2.3.2`; SHA-256 `d84a94c7d73405283a279348d2de78abbf31d2b1f7c92a8d739eeb40cf2a2f9f` |
| Kimi source | tag `@moonshot-ai/kimi-code@2.3.2`, commit [`b8dd3a134060c6e80ba4a1659335cd63b68483f2`](https://github.com/MoonshotAI/kimi-code/tree/b8dd3a134060c6e80ba4a1659335cd63b68483f2) |

## What changed since 2.3.1

Five commits (`684bae9e..b8dd3a13`, 22 files, 2.3.1 to 2.3.2): a test change that isolates cloud config in the TUI message-flow tests (e79422aa), "leave swarm mode to the user" (c9a48369), "launch subagents only on explicit request" (fd2e2c7e), a changeset wording fix (00e7007a) and the release (b8dd3a13). Read for reviewer-isolation impact:

- **Tools, MCP, config, trust and session code:** none of the 22 changed files touches tool registration, the MCP client or its config, `trustEnv.ts`, `workspaceMcpConfigService.ts`, session locks, the agent-file loader, the provider or OAuth code, or `--skills-dir`. The files are prompt text (`agent.md`, `system.md`, `enter-plan-mode.md`, `exit-reminder.md`, `agent-swarm.md`), the swarm service, the swarm tool, one profile description string, a transcript fold, docs and tests.
- **Swarm and subagents:** `AgentSwarmService.enter('tool')` now throws `Only the user can turn on swarm mode.`, `AgentSwarmTool` returns a fixed error result while swarm mode is off, and the system prompt tells the model not to launch subagents unless asked. This narrows what a model can start and does not widen any tool. The reviewer agent file already declares `subagents: []` and exactly two tools; the receipt's `prepare` leg asserts both on 2.3.2.
- **Profiles:** `profiles.ts` changes only the `whenToUse` string of the `explore` profile. The reviewer does not use that profile.

The probe sets `KIMI_CODE_TRUST_WORKSPACE` in the host environment as a decoy and asserts it is absent from the launch environment, as for 2.3.1.

## Results

The 2.3.1 producer was copied with only the version, source commit, output paths and the decoy comment changed (`diff` of the two producers shows exactly those lines). It ran against an isolated HOME and a synthetic native `KIMI_CODE_HOME` (managed `kimi` provider, invented access-only OAuth record, device identity). The native print leg redirected only the managed provider endpoint and its scoped synthetic OAuth slot to a loopback fixed-response server, which performs no inference (`modelInferenceCalls: 0`).

| Leg | Fixture trust run | Verified run (no trust) |
| --- | --- | --- |
| `kimiReviewerBackend.prepare` (private config, exact two-tool agent, empty skills, replace env, `current()`, version `2.3.2`) | pass | pass (`fixtureTrustOnly: false`, with `assessVersion("kimi-review", "2.3.2", [])` asserted `verified`) |
| Task-bound MCP: exactly `hub_review` and `hub_task_show`; other task id, third tool and missing auth refused; revocation refuses reads | pass | pass |
| Native exact-two-tools: 4 requests, every inventory exactly the two hub names, both calls reached the host, injected `Write` refused, marker `unchanged` | pass | pass |
| Native positive control: `Write` added to the agent; inventory includes it, marker written (2 requests) | pass | pass |
| Trust-env decoy absent from the launch environment | pass | pass |
| Cleanup of owned groups and temporary trees | pass | pass |

The verified run was made with `2.3.2` already in the local `verified` list and no trust record. Before and after both runs, the SHA-256 of the real `~/.kimi-code` `config.toml`, `mcp.json` and `device_id` and a digest over every file in `credentials/` and `oauth/` were identical.

One environment note, not a Kimi finding: the producer first refused with `private cwd ancestor contains ambient configuration` because this machine's agent shell exported `TMPDIR` under `~/.jcode/scratch`, whose ancestor `~` holds a real `.kimi-code`. That is the reviewer backend's own isolation check working. Both recorded runs used the macOS default temporary root (`/var/folders/.../T/`), which has no ambient marker among its ancestors.

The producer ran with Bun 1.4.3 (the installed one). The hub code it exercises is plain TypeScript with no bundle step.

## Not verified

A real-account review, attached-TUI coexistence during a review, OAuth refresh under a real token, review quality, token usage and quota behaviour remain unverified, as for 2.3.1. No future version or compatible line is inferred.

## Evidence

Kept outside the repository in `scratchpad/temp/agent-hub-508`:

| Item | SHA-256 |
| --- | --- |
| `kimi-probe.ts` | `fa09ab4bfeb42becc0c87d1a959e7756082267906ba4aec4f50772ebda57d242` |
| `kimi-native-result.json` (fixture trust) | `098bb78f287de48c2772c89f3d0f7db3e93031d97614ecbe1b61bca17be5ba9e` |
| `kimi-verified-result.json` (no trust) | `4338c63103523585703c2b8b958a8ff92a0199fde668e169355abe8a5e06ce35` |
