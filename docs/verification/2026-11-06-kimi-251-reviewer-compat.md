# Kimi 2.5.1 fresh-reviewer compatibility receipt

Date: 2026-11-06. Scope: issue #888, task #748. This repeats the [2.4.1 model-free procedure](2026-10-31-kimi-241-reviewer-compat.md). Both isolated macOS native passes succeeded, including the proposed verified entry without machine trust. Only 2.5.1 qualifies; nearby versions remain unverified. No real account, inference or persisted Tasks verdict is part of the procedure.

## Artifact and installation

| Artifact | Binding |
| --- | --- |
| Upstream annotated tag | `@moonshot-ai/kimi-code@2.5.1`, tag object `232e42606210d4f1674f104abfa133043408b925` |
| Peeled source commit | `1b02030d8c2c6b00131b23ebb67a231614877827` |
| Official macOS arm64 archive | `kimi-code-darwin-arm64.tar.gz`, 54,789,239 bytes |
| Archive SHA-256 | `fb0dc25033f2545c5cf820d01898fdc6e2a13a5d83529091fedee1dfef078632` |
| Standalone executable SHA-256 | `d71bd6fed919cdcb12623fa1a096b9adc4f51ac26f55b5801bbe1aee5809e714` |
| Standalone executable size | 182,590,912 bytes |
| Source hub checkpoint | `f7cbefdaa924ee506117a994e2d14f1f92aeae55`, exact `@staix/agent-mem@0.21.0` |

The archive came from the [official tagged release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.5.1). Its SHA-256 matched both the GitHub asset digest and sibling checksum before bounded extraction in a dgx02 container. Extraction refused absolute paths, parent traversal, links, nonregular files and oversized expanded contents. Only the verified official standalone artifact was transferred to the isolated Mac prefix; no upstream source or node_modules tree is copied to the Mac. No global installer is used.

## Isolated production and native controls

The retained 2.4.1 producer is adapted only for the private executable/source paths, exact 2.5.1 version, source commit and evidence destination. It requires the current exact memory-core dependency, creates its own HOME, KIMI_CODE_HOME, temporary cwd, empty skills and synthetic managed-provider OAuth slot, and drives the production reviewer preparation and task-bound two-tool MCP broker.

The source worktree used its own frozen install under a fake installation HOME,
with pinned Bun 1.4.2 and exact memory core 0.21.0. No node_modules tree was copied.
Before the isolated native work, the Mac showed 82.8% CPU idle, normal memory
pressure (1), 0.56 MB swap used, and no local agent-hub heavy job; candidate gate
processes were confirmed as SSH clients for remote jobs. The host has 18 logical
CPUs. No thermal/performance warning was recorded, which is not a positive
thermal measurement. No local check.sh, build or full test gate was run.

| Leg | Fixture-trust run | Verified run, no trust |
| --- | --- | --- |
| Production preparation, exact version/current/config, replace environment | pass | pass, `fixtureTrustOnly: false` |
| Exactly two MCP tools, empty subagents and skills, config mode 0600 | pass | pass |
| Wrong task, third tool, missing authorization and revoked broker refusals | pass | pass |
| Actual native two-tool loop, fixed loopback responses | pass, four requests | pass, four requests |
| Injected Write absent from inventory and native tool-not-found result | pass, marker unchanged | pass, marker unchanged |
| Explicit Write positive control | pass, two requests, marker written | pass, two requests, marker written |
| Trust-workspace environment decoy removed from launch environment | pass | pass |
| Original synthetic config/credential bytes, owned-group and temporary cleanup | pass | pass |

Every restricted native request advertised exactly
`mcp__agent-hub__hub_review` and `mcp__agent-hub__hub_task_show`. Both calls reached
the production task-bound broker's synthetic callback; no real task board or
persisted verdict was invoked. The positive control explicitly added Write to
the private agent, establishing that its absence in the restricted run was an
execution-time allowlist result. A separate preload positive control blocked a
non-loopback HTTPS attempt before connection. The native fixture redirected
only its copied provider/OAuth endpoint and synthetic credential slot to the
owned loopback server. These application-level guards do not establish kernel
network isolation.

The initial run used an invented trust record only in its temporary hub home
while 2.5.1 was absent from COMPAT. The second asserted a verified assessment for
the proposed exact entry with an empty trust list and no trust record. Both
prepared launches remained current after the native controls. Real account,
login/provider readiness, real OAuth refresh, attached-TUI coexistence, model
behavior/quality and quota remain unverified.

## Source review

A scoped review compared 2.4.1 source `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` with 2.5.1 source `1b02030d8c2c6b00131b23ebb67a231614877827`. The complete diff has 1,471 changed files; this receipt does not claim to review the full release.

- `workspaceTrust/trustEnv.ts`, agent-file parsing, builtin tool assembly, tool registry and registry service, and `packages/oauth/src/oauth-manager.ts` are byte-identical at the two source commits.
- [Workspace MCP configuration](https://github.com/MoonshotAI/kimi-code/blob/1b02030d8c2c6b00131b23ebb67a231614877827/packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts) adds configuration-bound MCP OAuth cancellation/invalidation and retains credentials during trust changes. These paths concern the fixture's loopback task-bound HTTP MCP identity; no real OAuth exchange is in scope.
- [Workspace trust service](https://github.com/MoonshotAI/kimi-code/blob/1b02030d8c2c6b00131b23ebb67a231614877827/packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts) now waits for config and recognizes the explicit `workspace.require_trust` option. The new option defaults to requiring trust. The producer never supplies that opt-out and keeps its trust-environment decoy assertion.
- `toolContribution.ts` renames the environment-capability type/property, and the managed Kimi credential adapter changes an import path. The agent-file tool allowlist and native registry assembly inspected above are unchanged.
- The 2.5.0 and 2.5.1 changelog entries were read for isolation impact: remote execution environments, dynamic tool refresh after MCP changes, MCP OAuth cleanup and the workspace-trust opt-out are in the relevant scope. Model-free native exact-two-tool inventories across all fixed-response requests are still required; source inspection alone does not qualify the version.

## Evidence and decision

Evidence producers and raw result files are outside git under `scratchpad/temp/agent-hub-748`. The real Kimi install, account state and native home are not inputs to the isolated controls. No machine trust is changed. All required model-free legs passed, so exactly 2.5.1 is added to `COMPAT["kimi-review"].verified`; the receipt pointer and Kimi-only operations list advance to this procedure. No reviewer is enabled or launched on the real hub.

| Evidence file | SHA-256 |
| --- | --- |
| `kimi-probe.ts` | `2ff8e2841f2cbd58d07add57e5deb9041ee33a692489083a176e6b5d5f406edf` |
| `kimi-native-result.json` | `082720d3c4d47409a122b3ce8031d0c7b520ab04e07011cb541ef7b855faa188` |
| `kimi-verified-result.json` | `fb1631f4ef47b565bf97bec267aa31ddbea25cfe2a6492eacdd7b144a545e6c0` |
| `run-kimi.py` | `1822f6d597d4b4cd7128d451addf81cb7bcd67492f339ea363ba99b288f80f5e` |
| `loopback-only.cjs` | `f4e4714ac846c9e1861306f19c1c656350d1d4180818bd834aa34d1ae0ced8df` |
| `source-review.log` | `671748eaa956f97351763e70ae2e0d5b3873d2ad6349b352cc676f43e15eb56d` |
| `source-trust-assembly.log` | `66346c8f19ad72b86bf44026d46bd2373af805136af434e5a9ec8faffd9f7282` |

The source comparison and native controls qualify the observed standalone
macOS arm64 artifact only. Other platforms, future versions and model-backed
behavior are not inferred. Committed-head dgx02 `scripts/check.sh --changed`,
bundle freshness and hosted exact-head CI are separate evidence; their final
states are recorded in the PR.
