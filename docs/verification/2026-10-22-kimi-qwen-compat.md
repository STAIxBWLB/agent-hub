# Kimi 2.3.0 and Qwen Code 0.26.0 compatibility receipt

## Scope and identity

This #373/#691 follow-up covers model-free native contracts. No real account, provider inference, personal configuration, native login, credential refresh or personal machine trust was used or changed. PATH's Kimi was already 2.3.0; PATH's Qwen remains 0.25.0. Qwen 0.26.0 was installed into a private temporary prefix with npm install scripts disabled. This receipt does not upgrade either tool.

| Artifact | Binding |
| --- | --- |
| Kimi native macOS arm64 executable | version `2.3.0`; SHA-256 `33eb2b6201ec4864daba89f57e4913126b483fdbe22d70411691ef7dbfca190d` |
| Kimi source | tag `@moonshot-ai/kimi-code@2.3.0`, commit [`b5e28fd6beac752a2cdcc0ff2f5fdf40e6494fbb`](https://github.com/MoonshotAI/kimi-code/tree/b5e28fd6beac752a2cdcc0ff2f5fdf40e6494fbb) |
| Qwen package | `@qwen-code/qwen-code@0.26.0`; npm gitHead [`ac97ce7a70d9b2ea5d62b357e3d9b0851423afc9`](https://github.com/QwenLM/qwen-code/tree/ac97ce7a70d9b2ea5d62b357e3d9b0851423afc9) |
| Qwen npm integrity | `sha512-JFO+gXpc3AVB+sR+ybQUb20DFfBMgB3p+F+rbru6xWeooYTixqOhCa3tOj0gCrDfkRxZFIziIH+zL05JgA2xVw==` |
| Qwen `cli-entry.js` | SHA-256 `3c53a220bdf124e8ef9fd28cd3465c761a2a466deb6dc6a97272d0a6d1121f59` |
| Qwen `chunks/acpAgent-5XER3TGL.js` | SHA-256 `a50d4de8c3c2abc90d3b5c2a9e00e0084f5a8cf21f0a66a3cc3125d6bd63f6a0` |

## Kimi private production preparation

The actual `kimiReviewerBackend.prepare` ran against an isolated HOME and a synthetic native KIMI_CODE_HOME containing only a managed `kimi` provider, invented access-only OAuth data, credentials/oauth directories and device identity. No personal file was linked. The producer created its own clean cwd, private home, empty skills directory and replace-mode environment. Its mode-0600 config contains the managed provider only, without the synthetic token value. Its agent YAML has exactly `mcp__agent-hub__hub_review` and `mcp__agent-hub__hub_task_show`, with `subagents: []`. Directory/device links point only to the synthetic source. `current()` passed and source config/token bytes survived cleanup.

Before deciding the verified list, a synthetic trust record inside this disposable fixture lifted only the version gate; every production preparation check remained active. After the evidence passed and the verified entry was added, preparation was repeated without that fixture trust. Runtime checks remain required before every production child. This is native tool policy, not a filesystem/network sandbox.

The real `createReviewerMcpSession` exposed exactly the two tools. A different task ID, a third tool and missing per-session authority were refused. Revocation refused subsequent reads. Native allowed calls reached the host only as `hub_task_show {id:7}` and `hub_review {id:7}`. No full daemon control token or actual project board was involved.

## Kimi native allowlist positive and negative controls

A separate native print fixture used the generated agent and task-bound MCP config. Only its managed provider endpoint and synthetic OAuth slot were redirected to a loopback fixed-response Anthropic-protocol server. These fixed responses perform no inference. The production prepared files were not modified; its `current()` remained true. No static API-key provider or OAuth-lock override was selected.

The pinned native source derives an endpoint-specific OAuth key from `sha256(JSON.stringify({oauthHost,baseUrl})).slice(0,16)`, with prefix `oauth/kimi-code-env-`. Only invented access-only records were created in that slot. See [managed auth scoping](https://github.com/MoonshotAI/kimi-code/blob/b5e28fd6beac752a2cdcc0ff2f5fdf40e6494fbb/packages/oauth/src/managed-kimi-code.ts#L324) and [storage-name resolution](https://github.com/MoonshotAI/kimi-code/blob/b5e28fd6beac752a2cdcc0ff2f5fdf40e6494fbb/packages/oauth/src/toolkit.ts#L465).

| Native case | Observed result |
| --- | --- |
| Exact two-tool agent | exit 0; four fixed-response requests, every inventory exactly the two hub names; both allowed MCP operations reached the host |
| Inject unlisted `Write` | native result `Tool "Write" not found`; owned marker remained `unchanged` |
| Same arguments with `Write` explicitly added to the agent | exit 0; two fixed-response requests, inventory includes `Write`; marker became `synthetic-write-control` |

Both use production print flags (`-p`, stream-json, explicit agent file and empty skills). Children had new owned process groups, a 30 s deadline and a 1 MiB combined output cap; cleanup completed before temporary trees were removed. Synthetic source configuration/token bytes stayed unchanged. Session hints inside temporary homes were not resumed.

Three earlier harness outcomes are retained as non-passes: combining `-p` with `--auto` was rejected before any request; redirecting the endpoint without its scoped synthetic token produced no configured credential and zero requests; a collector required `tool_result.is_error`, but native Kimi emits the explicit tool-not-found text without that flag. The corrected collector checks that actual refusal together with exact inventory, unchanged marker and the successful Write positive control. None was an authenticated attempt or a concealed native-version failure.

## Qwen native ACP and permission contract

The actual private-prefix CLI ran with isolated HOME/QWEN_HOME/QWEN_RUNTIME_DIR/XDG_CONFIG_HOME/TMPDIR, clean cwd and an allowlisted environment. It used a dummy OpenAI key, fixture model and unreachable loopback base, with `--acp --bare --advisor off --auth-type openai --telemetry=false`. No `session/prompt` or authentication RPC was sent. Native Node transport guards were loaded before imports; six background network attempts were blocked. No provider inference or account request occurred.

Observed native readback:

- initialize protocolVersion 1, served `agentInfo.name = qwen-code`, `version = 0.26.0`;
- session/new with no MCP servers succeeded;
- advertised modes: `plan`, `default`, `auto-edit`, `auto`, `yolo`;
- native ACKs for `default -> auto-edit -> yolo -> default`;
- bounded 30 s RPC deadlines and 1 MiB combined output; SIGTERM exit and whole owned process group gone.

The hub continues to map only ask/default, ask-when-needed/auto-edit and never-ask/yolo. Auto and plan are not added to its permission map. The served ACP identity was checked independently of the npm/CLI version label.

The published ACP chunk does not export its permission builder. A scratch copy rewrote import URLs to the installed package and added exports for the native `SubAgentTracker`, `toPermissionOptions` and `resolvePermissionOutcome`; native function bodies were unchanged. Its real `createApprovalHandler` ran with synthetic client/tool/event ports, without a prompt or tool execution. The request carried `sessionId`, `toolCallId`, pending status/title/content/locations/kind/rawInput and `_meta.toolName`; options carried `optionId`, `name`, and `kind`. Offered `proceed_once`/allow_once selection reached the native respond callback, cancellation resolved to cancel, and an unoffered option ID was rejected. The group was removed and no network attempt occurred in this callback fixture.

This is published-code callback evidence, not a model-generated ACP permission turn. Existing host mapping tests retain configured-server/call-ID binding, raw-argument display and offered-option selection; an unrecognized title still requires ordinary approval. The callback does not grant any broader MCP identity.

## Reproduction and remaining live legs

The external `scratchpad/temp/agent-hub-373` evidence archive contains the bounded Kimi producer/result and Qwen initialize/mode/permission producers, synthetic transcripts, result JSON and SHA-256 manifest. The Kimi/hub producer uses pinned Bun 1.4.2; Qwen uses Node with Python controllers. Each repository runs one admitted native/test job at a time. The Qwen prefix is recreated from the exact npm package with `--ignore-scripts`; the native executable's served identity must still pass. No historical 2.2.0 live receipt is relabelled as a 2.3.0 pass.

Real Kimi login/refresh and attached-TUI coexistence, a model-produced review verdict/quality, actual provider readiness, Qwen model-selected permission turns and production rollout remain unverified live legs. Kimi token usage is not measured by this receipt. The exact versions may enter compat verified; no future version, compatible line, sandbox relaxation or skipped runtime proof is inferred.


## Host validation

Focused portable fixtures: 49 pass, 0 fail, 277 assertions across `compat`, `qwen-peer`, `kimi-review` and `reviewer-mcp`; typecheck passed. The Qwen host parser also consumed the captured native callback fields and selected only an offered once option, with cancellation and unknown-option refusal. Kimi's final production preparation plus native controls passed with `fixtureTrustOnly: false`. The generated plugin bundle is rebuilt with pinned Bun after the frozen install; runtime isolation proofs are unchanged.

External producer/result fingerprints:

| Archive item | SHA-256 |
| --- | --- |
| `kimi-probe.ts` | `fc3a210f18736586fafd3294dd8f8212bf6e341b62deb6bff4828bcfce835bd4` |
| `kimi-native-result.json` | `3c7008f251dcf0ac266dedcf1934c15dc53f1e1dc89a21aeb234e5742238b9c1` |
| `kimi-verified-result.json` | `9d283932e1f01ca14694e577e30f0b9039a93c088267e16c8d3aff6367fff609` |
| `qwen-probe.py` | `bc6834b0e3015f482262b22ea97c89cb5036e1b1ed97a59f19e7feff25bcbd6d` |
| `qwen-native-result.json` | `9322ec7c575542d035cc6bbaf596d39b576a926b24de012b5e6492bf08d3c19d` |
| `qwen-permission-result.json` | `8fd15c8e5c5e793992187e19b1f4bfdb60ce020fba13f55360b743c2528e34ae` |
| `qwen-native-permission-exports.mjs` | `75ba574de1f52bfc45f4e49bacd4bf4b904946c401d43a35bd539f3ea54a27ff` |
