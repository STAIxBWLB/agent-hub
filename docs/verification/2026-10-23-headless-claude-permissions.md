# Headless Claude permission transport receipt

Date: 2026-10-23. Scope: #525 R5a, slice 525-4. Native binary: Claude Code 2.1.309, 275,923,296 bytes, SHA-256 `5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c`.

## Method

The installed native binary ran with an isolated HOME and CLAUDE_CONFIG_DIR, a disposable work directory, one fixture stdio MCP server, an empty settings-source selection and managed fixture settings. No personal authentication files or live sessions were used. A deterministic loopback HTTP server supplied a synthetic model-protocol response requesting one Write, then a completion response after a tool result. This exercised the real native permission dispatch without a provider, model inference, login or real credential. Synthetic provider usage in this fixture is not measured account usage.

The launch used this form, with fixture paths and a fixture permission tool:

```sh
claude -p --output-format stream-json --verbose --strict-mcp-config \
  --mcp-config <fixture-mcp.json> --setting-sources '' \
  --settings <fixture-settings.json> --permission-mode default \
  --permission-prompts host --permission-prompt-tool mcp__fixture__approve \
  --model claude-sonnet-4-5 <fixture-prompt>
```

No `--bare`, `acceptEdits`, `dontAsk` or `bypassPermissions` was used. Native and fixture children belonged to an owned process group, which was stopped and reaped after every case. The temporary probe driver's SHA-256 was `173c108ff5e0289434c7794e985a48b612c23df81e10d0fc2abe48a297de9ae5`. The recorded receipt and driver hashes agreed when this document was prepared. The driver is a local diagnostic, not a shipped runtime dependency or a startup receipt gate.

## Observations

| Fixture case | Native result |
| --- | --- |
| Prompt tool allows the Write | One MCP permission call; target file written |
| Prompt tool denies | No write; one permission denial |
| Prompt tool missing from MCP inventory | No write; native exit 1 |
| PreToolUse command exits 1, prompt tool denies | Hook decides nothing; one MCP permission call; no write |
| PreToolUse command exits 1, prompt tool allows | Hook decides nothing; one MCP permission call; file written |
| MCP permission request returns a JSON-RPC error | No write; native tool-result error |
| MCP server disconnects during permission request | No write; native tool-result error |
| MCP permission reply remains pending | No write observed before the external 25-second owned-group stop; native internal timeout not established |
| Simulated approval deadline returns deny after 100 ms | One MCP permission call; no write; native exit 0; observed elapsed 844 ms |

The last row simulates the hub's deny response. It does not measure the real hub approval scheduler or a person's console interaction. Separate adapter fixtures cover allow, deny, externally bounded timeout, tool error and disconnect; those fixtures do not constitute native-client evidence by themselves.

The native prompt request contained `tool_name: "Write"`, the original `input` object and `tool_use_id`. The fixture allow response was an MCP text content item containing JSON with `behavior: "allow"` and `updatedInput`; the deny response used `behavior: "deny"` and `message: "no person answered"`. Fixture paths and text are omitted here.

## Host behavior and ceilings

The production permission tool is `mcp__agent-hub__hub_permission_request`. Its current-child launch and generation fence, privacy screening, person-only approval and timeout denial remain host responsibilities. A failed facts hook supplies no decision: a subsequent valid person allow is permitted. A failed permission prompt, timeout, disconnect or mismatched child authority never supplies an automatic allow.

The native probe certifies the permission transport on this binary and version. It does not certify real provider authentication, a real model's tool selection, a person's approval interaction, every native tool type, native internal permission timeout, or filesystem sandbox isolation. The pending fixture was bounded externally. No model turn using a real account was run. Native version admission and binary fencing remain runtime checks; this dated receipt is evidence for the supported contract, not a per-start runtime receipt check.

The exact-head package gate, daemon integration and both-OS CI are recorded separately in the PR handoff. This document claims no gate or CI result for the current candidate.
