# Kimi Code 2.7.2 fresh-reviewer compatibility receipt

Date 2026-11-25. Refs #888, hub task 1120. This repeats the [2.5.1 model-free reviewer procedure](2026-11-06-kimi-251-reviewer-compat.md) on macOS arm64 with Bun 1.4.4. Both isolated runs passed all nine runnable proof markers, including a second run against the proposed verified entry with an empty trust list and no trust file. This qualifies exact 2.7.2 for `kimi-review`.

## Artifact and isolation

| Artifact | Binding |
| --- | --- |
| Annotated tag object | `1781dbd74bc7fabf23ac4721a570397f278817f1` |
| Peeled source commit | `56145f849caa305d42acd09b67fb65d11146f887` |
| Official macOS arm64 archive | `kimi-code-darwin-arm64.tar.gz`, 61,167,615 bytes |
| Archive SHA-256 | `46cb6bf4afe3a6d7931e0a47418035fde53a43b286329c8dabb5f71bfc9e71b4` |
| Executable SHA-256, before and after | `f97206f936eda7d446fcb4fb67d8029da0efe7f8b5f2bee404ed6577eaac604c` |
| Hub source base | `87239bd0357f3b8929ffc6b61fab89c0fb95f0d3`, agent-mem 0.39.0 |

The GitHub asset metadata and sibling checksum matched the archive, and bounded extraction unpacked it into a private prefix. Each run used the exact native executable, separate scratch `HOME`, `AGENTHUB_HOME`, `KIMI_CODE_HOME`, `AMEM_HOME`, `XDG_CONFIG_HOME` and `TMPDIR`, with a fixed PATH and no inherited credentials. The final runs used private OS temporary roots with clean ancestors for the production cwd guard. A preliminary run under the workspace was refused at preparation, before native controls. The two final runs used synthetic credentials and fixed loopback responses.

## Production and native proof results

| Leg | Scratch trust | Proposed pin without trust |
| --- | --- | --- |
| Production preparation, exact version, fresh configuration and environment replacement | Pass | Pass |
| Two-tool MCP inventory, empty skills and subagents, and private files | Pass | Pass |
| Broker refuses wrong task, extra tool, missing authorization and revoked calls | Pass | Pass |
| Native two-tool loop | Pass | Pass |
| Write absent from the restricted loop | Pass | Pass |
| Write positive control | Pass | Pass |
| Non-loopback preload guard positive control | Pass | Pass |
| Workspace trust environment decoy removed | Pass | Pass |
| Source fixture bytes preserved, owned child stopped and temporary launch files removed | Pass | Pass |

The first run used the committed `runKimiProofs` worker with temporary exact-version trust in the scratch hub home. The second used the same proof after replacing only the scratch trust step with an assertion that the proposed version pin passed with no trust file. The result JSON matched byte for byte, with SHA-256 `9c52b84232e356a6ea3a34154f528b6f42be6db0617c4907f61e697e877fe84b`.

The restricted native loop advertised only `hub_review` and `hub_task_show` through the production task-bound broker. The positive write control used a disposable fixture. The loopback guard is application-level evidence. Real account readiness, model behavior, native kernel isolation, OAuth refresh and an interactive TUI remain outside this evidence.

## Scoped source comparison

Compared the 2.5.1 and 2.7.2 tagged sources for workspace trust, workspace MCP configuration, tool registry and assembly, and OAuth management. The trust environment, builtin assembly and tool contribution files are byte-identical. Workspace trust rebinds when directory configuration changes. Workspace MCP configuration watches the selected project configuration. Tool registration now rejects duplicate names and exposes registration events. The OAuth manager changed its refresh/locking code. The proof confirms exact inventory, native broker behavior and synthetic credentials for the scoped fixture. It does not exercise real refresh or the wider release changes.
