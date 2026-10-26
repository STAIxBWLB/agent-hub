# Claude Code 2.1.310 headless implementer permission-transport receipt

Date: 2026-10-26. Scope: #843 AC5, task #507. This repeats the model-free procedure of [the 2.1.309 receipt](2026-10-23-headless-claude-permissions.md) on the installed Claude Code 2.1.310, with 2.1.309 run through the same producer as a control.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.309 (control) | `5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c` |
| Claude Code 2.1.310 | `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd` |

The 2.1.309 hash is the one the 2026-10-23 receipt records, so the control is the same binary that receipt certified.

## Upstream changes since 2.1.309

Read from the upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): 2.1.310 lists 26 items, and most are VSCode, cloud-session, Claude Tag and Code Review admin fixes that this hub's `claude -p` child never runs. The ones that touch permissions, MCP or hooks:

- **Monitor tool now available when telemetry or nonessential traffic is disabled** (matters). In this run the native init tool inventory grew from 28 tools on 2.1.309 to 29 on 2.1.310, the one difference being `Monitor`. The producer sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; the hub's own child does not set it, and a repeat of the Monitor probe below without that variable on 2.1.310 reached `Monitor` and the host prompt the same way, so availability here does not depend on it. It is a deferred tool: it is not in the request's tool list and has to be loaded through `ToolSearch` first, which a model can do. A probe that did this on 2.1.310 reached the host permission prompt for `Monitor` with the same `tool_name`, `input` and `tool_use_id` shape as `Bash`, and a deny reply stopped it (no process started, tool result an error, one permission denial). 2.1.309 answered the same attempt with "No such tool available: Monitor". So a new native tool now reaches `hub_permission_request`, which then sees `tool_name: "Monitor"`. See "Monitor" below.
- **Windows PreToolUse and PermissionRequest hooks no longer let a call through when Git Bash is missing** (does not matter on macOS and Linux; the receipt's hook-failure legs are the equivalent check here and pass).
- **MCP tool call that times out in a non-interactive session while the server's elicitation is unanswered now tells the model no answer came** (touches MCP error text only). The transport legs below, MCP error, disconnect and pending, are unchanged in outcome.
- **File read permission prompts show where a symbolic link leads** (a prompt rendering change; the hub's prompt tool receives the same arguments).
- **Auto mode prompt text**: the hub never uses auto mode (`--permission-mode default`).
- **Compaction, memory, tmux and Linux sandbox warnings, gateway retry of the `effort` beta and mid-conversation system messages**: no permission, MCP or hook contract.

Nothing in 2.1.310 changes `--permission-prompts host`, `--permission-prompt-tool`, `--setting-sources`, `--strict-mcp-config` or hook semantics, and none of the 26 items says so. This reading is of the changelog text, not of the binary's source, which is not public.

## Method

The producer [claude-permission-transport-native.py](claude-permission-transport-native.py) ran both installed native binaries with an isolated HOME and `CLAUDE_CONFIG_DIR`, a disposable work directory, a fixture stdio MCP server, an empty settings-source selection and fixture settings. A loopback HTTP server supplied a synthetic model-protocol response requesting one `Write` and, after the tool result, a completion. The launch used the hub's own flags: `-p --output-format stream-json --verbose --strict-mcp-config --mcp-config … --setting-sources '' --settings … --permission-mode default --permission-prompts host --permission-prompt-tool mcp__fixture__approve`. No `--bare`, `acceptEdits`, `dontAsk` or `bypassPermissions` was used. The API key in the child's environment was the literal string `synthetic-probe-not-a-credential`, pointing at the loopback server. No account, provider, login or model inference was involved, and each native child ran in its own process group, which was stopped and confirmed empty after every case. Each binary's SHA-256 was identical before and after.

The 2.1.309 driver the earlier receipt hashed (`173c108f…`) was a temporary local diagnostic that was not kept, and no copy was found. This producer is therefore new, written against that receipt's case table and reusing the loopback provider and process-group handling of the [#845 wrapper producer](claude-shell-wrapper-native.py). Because it is new, it was first run on 2.1.309, where it had to reproduce the 2026-10-23 table before its 2.1.310 result meant anything. It did, on all nine cases. An early run of it failed `allow` and `hook-allow` on both binaries identically because the producer asserted `is_error` was `false`; native stream-json omits the key on success. The assertion was corrected to check `is_error is True` only for failures, and the producer was rerun in full.

## Results

All nine cases passed on both binaries (18 of 18), with identical outcomes:

| Fixture case | 2.1.309 (control) | 2.1.310 |
| --- | --- | --- |
| Prompt tool allows the Write | 1 MCP permission call; file written | same |
| Prompt tool denies | no write; 1 permission denial | same |
| Prompt tool missing from MCP inventory | no write; 0 MCP calls; native exit 1 | same |
| PreToolUse command exits 1, prompt tool denies | hook decides nothing; 1 MCP call; no write | same |
| PreToolUse command exits 1, prompt tool allows | hook decides nothing; 1 MCP call; file written | same |
| MCP permission request returns a JSON-RPC error | no write; tool-result error | same |
| MCP server disconnects during permission request | no write; tool-result error | same |
| MCP permission reply remains pending | no write before the external 25 s owned-group stop; native internal timeout not established | same |
| Simulated approval deadline returns deny after 100 ms | 1 MCP call; no write; native exit 0; 1 permission denial | same |

Each call's permission arguments were exactly `tool_name: "Write"`, the original `input` object and `tool_use_id`. Native exit codes, MCP call counts and write/no-write outcomes matched the 2026-10-23 table on 2.1.309, and the 2.1.310 column matched the 2.1.309 column row for row.

### Monitor

The 2.1.310 inventory difference is the only behavioural difference this run found, and it is a new tool name, not a changed contract. A separate one-off probe (not part of the producer, retained with the evidence) loaded `Monitor` through `ToolSearch` and called it with a write command, then with `echo`, on 2.1.310. The write command reached the host permission prompt once and a deny reply prevented it. The read-only `echo` made no permission call on either `Monitor` or `Bash`, which matches native auto-allow of read-only commands rather than a bypass. This probe covers only that one deny and one read-only path. It does not prove that every `Monitor` form (long-running sources, persistent watches) asks, that approval of one `Monitor` call authorises no later one, or how the hub's `hub_permission_request` renders and decides a `tool_name` other than `Bash`. The host-side rendering is generic (`permissionPayload` accepts any tool name), so nothing in the hub depends on the name being `Bash`, but this receipt does not claim a hub-side `Monitor` fixture. That is a follow-up if `Monitor` is to be allowed in a task child, and the hub's `--allowedTools` list names only the hub's own MCP tools.

## Ceilings

The result certifies the permission transport on this binary and version, as the 2.1.309 receipt did for 2.1.309. It does not certify real provider authentication, a real model's tool selection, a person's approval interaction, every native tool type (`Monitor` is covered only as stated above), native internal permission timeout, or filesystem sandbox isolation. The pending case was bounded externally. The host shell wrapper procedure of #845 is a separate receipt, [2026-10-26-headless-claude-shell-context.md](2026-10-26-headless-claude-shell-context.md), which ran on 2.1.309 and 2.1.310 and states that a version upgrade repeats both; this receipt is the transport half. The exact-head package gate, daemon integration and CI are recorded in the PR, and this document claims none of them. Native version admission and the per-start binary fence remain runtime checks; this dated receipt is evidence for the supported contract, not a per-start receipt gate.

The MCP wire still does not authenticate that a schema-valid permission call came from native dispatch, as the 2.1.309 receipt says; a person's fresh allow-once for the original arguments remains required for either path.

## Evidence

Kept outside the repository in `scratchpad/temp/agent-hub-507-run4` (the final full run of the committed producer), with the earlier runs beside it: `agent-hub-507-run1` (the failed first producer), `run2` and `run3` (identical results from the producer before a review fix gave each binary its own indexed output directory, so two binaries with the same file name no longer collide):

| Item | SHA-256 |
| --- | --- |
| `claude-permission-transport-native.py` (the committed producer) | `b3f39acce1eb3713a5f01191702f1f217d704039d3a86452c6dfd311cb274efe` |
| `receipt.json` of the final run (18 cases, `certified: true`, `account: false`, `inference: false`) | `edefd6d7e18dd28a22ad63489c51db0e9636586dadedc686738b0ff89b5113e9` |
| Monitor one-off probe | `1ebd2ff6b4b8a587b212cde221d035d0a0d37e24d6acdef37dce55d7a71111d8` |

The run retains each case's native stdout and stderr, the MCP permission records, and the request tool schemas. The host used Python 3 and the installed binaries; no Bun is involved in this producer.
