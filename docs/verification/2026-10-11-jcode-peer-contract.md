# Jcode peer contract (#332)

Installed CLI: jcode 0.94.0, release build b6c63ff04ca6786d4d328a086d7f3ac06d6fb578, read through version --json. This identifies [1jehuang/jcode](https://github.com/1jehuang/jcode/tree/b6c63ff04ca6786d4d328a086d7f3ac06d6fb578), not the unrelated cnjack/jcode project.

## Verified source surfaces

- src/cli/acp.rs: native identity jcode/package version, protocol 1, new/load/prompt/cancel/close. Session-scoped mcpServers arrays are tolerated but ignored. No session/set_mode or request_permission mapping is provided.
- crates/jcode-base/src/mcp/protocol.rs and manager.rs: per-session project directory selects .jcode/mcp.json, then .mcp.json, then .claude/mcp.json. Later names override. Both servers and mcpServers are accepted; shared:false makes the connection session-owned.
- src/cli/dispatch.rs and crates/jcode-app-core/src/server/socket.rs: serve runs in the foreground, a private --socket selects the runtime, JCODE_READY_FD signals listening, temporary-server/owner-pid support cleanup. Automatic updates and self-dev can be disabled. No global stop command is required.
- Native MCP first-use import can write Codex definitions into Jcode's global store. The hub refuses startup until that native store exists; it never initializes or copies it. Credentials stay in the operator's native store.
- ACP load returns no restored id while attach_existing_session can replace its internal id from History. Therefore 0.94.0 cannot prove restored identity through this interface. Automatic crash/controlled recovery is withheld. A manually requested load must echo an exact id or refuses without a model prompt or restored claim. Fakes can exercise that positive echo contract; they do not establish native 0.94.0 restoration.

## Alternative assessment

| Surface | Jcode | Qwen | Pi |
| --- | --- | --- | --- |
| Integration | Owned daemon/socket plus ACP and project MCP | Owned ACP, session MCP | Native events and hub-moderated tools |
| Permission boundary | Unmanaged native policy, no hub sandbox | Version-specific native modes, no hub sandbox | Hub path guard/sandbox for managed tools |
| Provider choice | Operator's native provider profile | Operator's native provider | Existing hub relay policy |
| Recovery | Refuse unproven native identity restoration | Saved ACP conversation | Existing file/id restoration |
| Quota | Unknown unless observed/pinned | Unknown unless observed/pinned | Existing on-prem policy and measurements |

No local comparison of RAM, latency, quality, resources or operator overhead ran. Upstream performance claims are not this workspace's measurement. Jcode is optional and does not replace class defaults or establish reliable verification from a role label.

## Unverified native legs

Provider/model serving, project MCP discovery and a real hub-tool call, native permissions, native stop/child teardown and recovery all remain unverified. Source inspection, fakes, a CLI version and a listening socket are separate evidence, not native model/tool readiness.
