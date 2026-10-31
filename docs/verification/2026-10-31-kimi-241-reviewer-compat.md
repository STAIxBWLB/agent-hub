# Kimi 2.4.1 fresh-reviewer compatibility receipt

Date: 2026-10-31. Scope: issue #888, task 578. This repeats the [2.3.2 model-free procedure](2026-10-26-kimi-232-reviewer-compat.md), with the actual production preparation and native tool-call loop driven by fixed loopback responses. The broker callback is synthetic: no real account, inference or persisted `Tasks` verdict was run. No real Kimi home, global prefix, personal trust or hub instance was changed.

## Artifact and installation

| Artifact | Binding |
| --- | --- |
| Upstream annotated tag | `@moonshot-ai/kimi-code@2.4.1`, tag object `1fc1d165c83b175873a46897e1e9db73dc70c984` |
| Peeled source commit | `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` |
| Official macOS arm64 archive | `kimi-code-darwin-arm64.tar.gz`, 62,671,109 bytes |
| Archive SHA-256 | `17f848e7b9b159aed9b2ad0df917c4be3c484393d924a6540171ede7b87cc66d` |
| Standalone executable SHA-256 | `1a8539eae87ffbd9bf480b8a47beafc9668f66b048b96cfa631310dc12dab3a7` |
| Host / hub core | macOS arm64, Bun 1.4.2, own frozen `@staix/agent-mem@0.13.0` |

The archive was obtained from the official release at that tag and checked against both its GitHub asset digest and sibling checksum file before bounded extraction into a new scratch prefix. No global installer ran. An additional privately installed npm 2.4.1 distribution also passed the same two probe modes; its Node entry hash is `fd15d5c9b48892bb4f1d5fe82df9f790c8c19a44ca9a81054cc592b6fb9e2c90`. The primary receipt below is for the standalone executable, matching the previous artifact form. The npm postinstall was reviewed and invoked only in non-global mode, where it returns before global shim migration.

## Isolated production and native controls

The existing producer was adapted to require the private executable path and current source checkout, assert its own exact dependency version, and use the ordinary macOS temporary root. It created fresh HOME, native KIMI_CODE_HOME, cwd, skills and temporary directories with only synthetic managed-provider config, an invented access-only OAuth record and device identity. The production backend made its own private config/agent/MCP files and linked only these fixture credential directories. No personal credential or config was copied.

The original managed-provider endpoint was used for production config validation. A separate owned native fixture copied the generated config and redirected only its provider/OAuth endpoint and scoped synthetic credential slot to a fixed loopback server. The prepared original stayed unchanged, preserving its `current()` check. The synthetic provider emitted tool-use frames and fixed final text; it performed no inference. Application-level network preloads and a separate positive control blocked non-loopback attempts; this is not kernel network isolation.

Two complete standalone runs passed:

| Leg | Fixture-trust run before Kimi bump | Verified run without trust |
| --- | --- | --- |
| `kimiReviewerBackend.prepare`, version/current/private config/replace env | pass | pass, `fixtureTrustOnly: false` |
| Exact two MCP tools and `subagents: []`, config mode 0600, empty skills | pass | pass |
| Task-bound MCP wrong task, third tool, missing auth and revocation refusals | pass | pass |
| Actual native two-tool loop, four fixed-response requests | pass | pass |
| Injected Write absent from inventory, native tool-not-found result, marker unchanged | pass | pass |
| Explicit Write positive control, two requests, marker written | pass | pass |
| Trust-workspace environment decoy removed from launch env | pass | pass |
| Owned groups, original synthetic config/credential bytes and temporary-tree cleanup | pass | pass |

Every native two-tool request advertised exactly `mcp__agent-hub__hub_review` and `mcp__agent-hub__hub_task_show`. Both calls reached the production task-bound broker and its synthetic callback. Wrong task id, a third tool and missing authorization were refused; revocation refused reads. The callback never invoked a real task board or persisted a reviewer verdict. The positive control explicitly added Write to the agent, proving the absent Write effect in the restricted run came from the native tool allowlist.

The first run used only an invented trust record in its temporary hub home while 2.4.1 was absent from the source verified set. The second used the proposed exact verified entry and asserted the `verified` assessment without a trust record. No real machine trust was written.

## Source review

The old 2.3.2 source readback still resolves to `b8dd3a134060c6e80ba4a1659335cd63b68483f2`. The 2.4.1 tag above was independently read back. This was a scoped contract review at both commits, not a review of all changed UI assets or commits.

- `workspaceTrust/trustEnv.ts`, agent-file parsing, builtin tool assembly, native managed Kimi OAuth binding and `packages/oauth/src/oauth-manager.ts` were byte-identical in the inspected regions/files.
- [Workspace MCP config service](https://github.com/MoonshotAI/kimi-code/blob/2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7/packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts) adds reconnect-delay tunable change notifications and retains the deferred/startup/tool timeout fields. The native explicit two-tool inventory and actual broker calls above exercise the relevant result rather than inferring it from defaults.
- The 2.3.3, 2.4.0 and 2.4.1 changelog entries were read for plan-mode, MCP loading, trust, tool and subagent changes. Plan-mode entry is now user-controlled; print mode skips the default plan mode. Dynamic MCP loading fixes do not bypass the observed exact agent allowlist. The 2.4.1 read-tool output ceiling is outside an agent that has no native Read tool.

## Decision and limits

All required Kimi model-free legs passed, so exactly 2.4.1 may join `COMPAT["kimi-review"].verified`; 2.4.0 and other nearby versions remain unverified. This follows the existing 2.3.1/2.3.2 model-free Kimi procedure. The receipt records synthetic broker execution, not a real-account or persisted-Tasks verdict. No reviewer is enabled or launched on the actual hub by this change.

Real account/login/provider readiness, OAuth refresh under a real token, attached-TUI coexistence, model behavior/quality, token usage/quota and other platforms remain unverified. Kimi's native tool-authority boundary is not a kernel filesystem sandbox. Frozen-install, pinned-Bun bundle freshness, host changed gate and exact-head CI are separate PR evidence.

## Evidence fingerprints

Producers and result JSONs stay outside git under `scratchpad/temp/agent-hub-578`.

| File | SHA-256 |
| --- | --- |
| `kimi-probe.ts` | `82b1e96ae9c4fb312fc6134b3b072ce96d5708a4c8e3ec54aada0943a0990648` |
| `kimi-native-result.json` | `59e748060a855ef085602ed4ecfaddb18aedbf5c8ec4c95bd7fd721b5f1e672b` |
| `kimi-verified-result.json` | `59a467fd9c8485a46adcc2155cc59cbcd381db28479cbf258553a0a89a379c06` |
