# Reviewer isolation evidence (#519)

Status: source integration and model-free production-backend admission are verified. Exact-head CI is a separate required PR gate. This report separates offline native evidence, fake-CLI regressions and unverified account/model behavior. No live review prompt, account login or credential copy was performed for this investigation.

## Admission ruling

- Planner ruling, 2026-10-19: #229 ships #519 R3-R6 for Claude and Codex only; ship only reviewer profiles with demonstrated isolation. Kimi and agy remain unavailable and outside the default pool until they have a passing isolation receipt. #229 adds unavailable-reason metadata for them and no launch code. All of their launch/isolation/receipt work belongs to [#533](https://github.com/STAIxBWLB/agent-hub/issues/533), hub task #234; the future agy launcher belongs in `src/adapters/agy/`. Failure, missing evidence and quota exhaustion never count as a verdict.
- The default logical kind order is Claude, Codex, fixed before modulo; undeclared or unavailable slots are skipped without renumbering. An explicit pool may name the registered unavailable Kimi/agy placeholders; local/Pi are refused. An explicit pool with no declarations blocks, while an omitted pool without declarations preserves legacy routing. An unavailable result must be skipped, never treated as approval.
- Existing #223 Claude behavior is retained. This work adds no new live Claude acceptance proof.
- Codex/Kimi fresh reviewer declarations require `review_mode: "fresh"`. Existing headless instances with roles `["reviewer"]` but no opt-in retain native transport/worktree/permission behavior and stay outside the fresh pool. Claude keeps #223 automatic selection; agy remains metadata-only unavailable. A failed fresh start never downgrades to a continuing native session.

## Codex native evidence

- Exact executable used for offline probes: `/opt/homebrew/bin/codex`, reporting `codex-cli 0.146.0`. Its npm package resolves to a native binary. A separate fnm executable on PATH reports 0.163.0; that version has no receipt in this slice and must be unavailable.
- Primary source pin: `openai/codex`, tag `rust-v0.146.0`, commit `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`.
- `exec --ephemeral --ignore-user-config --ignore-rules` is accepted by the installed help. These switches respectively remove session persistence, the user config layer and user/project execpolicy rules. They do not remove every config layer. [Pinned exec implementation](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/exec/src/lib.rs)
- Native `mcp list --json` in temporary homes showed that a CLI `mcp_servers={agent-hub={...}}` table merges with user/project servers. Self-contained disabled stdio/HTTP stubs retained valid configuration both with and without the original user layer. Only the fixed hub remained enabled. Native `mcp get agent-hub --json` exposes the exact `enabled_tools` allowlist. The schema specifies that disabled servers are not initialized and only listed enabled tools are registered. [Pinned MCP schema](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/config/src/mcp_types.rs)
- `--disable plugins --disable hooks` and a CLI override marking the physical project root untrusted were included in the inventory probes. Plugin loading has an explicit disabled return path; `--ignore-user-config` alone is insufficient. [Pinned plugin manager](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core-plugins/src/manager.rs), [config loader](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/config/src/loader/mod.rs)

The named profile used filesystem `/ = read`, private entries `= deny` and `network.enabled = false`. Native `sandbox -P <profile>` fixtures produced:

```text
nested/secret.env READ_DENIED
alias.env READ_DENIED
nested/SECRET.ENV READ_DENIED
public.txt READ_ALLOWED
WRITE_DENIED
```

Both exact and glob deny entries passed; the symlink and case alias existed. No write file appeared. A plain read-only profile without a deny entry could read the private fixture. `debug models --bundled` accepted the CLI profile configuration offline. [Pinned permission schema](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/config/src/permissions_toml.rs)

The source receipt producer repeats bounded model-free inventory and sandbox checks before a review, including nested glob and symlink private-read denial. It binds the native executable/prefix hashes, profile and config metadata, then checks `current()` again immediately before model spawn. A bare deny name is compiled at the project root and at nested segment depth; `~/` is resolved against the home directory. Raw MCP output, transport environments and config contents are not receipt evidence. Unsupported version, changed/unknown inventory, own-server collision, failed sandbox proof, abort or changed metadata makes the backend unavailable.

Codex "read-only tools" means sandboxed shell with filesystem read-only/private-deny policy and network disabled. It does not mean Claude's Read/Grep/Glob tool whitelist. No native LLM review, network-denial probe, post-start glob mutation or concurrent filesystem/config swap was tested. The profile declares the network boundary; it is not a measured network result. Same-user concurrent changes after the final check remain a ceiling, not a claimed atomic filesystem snapshot.

## Kimi evidence and gap

- Installed version: 2.2.0. Primary source pin: `MoonshotAI/kimi-code`, tag `@moonshot-ai/kimi-code@2.2.0`, commit `472192c34c1efad89a369870eff0da0b708ce9bb`.
- An explicit `--agent-file` profile can allow only Read/Grep/Glob and the two hub MCP tools, with `subagents: []`. The runtime executor registers a tool-policy guard; the allowlist is more than prompt text. [Pinned policy guard](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/agent-core-v2/src/agent/toolPolicy/toolPolicyService.ts)
- `KIMI_CODE_HOME` separates config, sessions and credentials. ACP session MCP servers are additive: trusted project/user/plugin servers can still load. No strict-MCP or no-persistence CLI profile was demonstrated. Reusing ordinary authentication through an isolated home was not tested or authorized by this investigation. Kimi remains unavailable. [Pinned MCP loader](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts), [bootstrap paths](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/agent-core-v2/src/app/bootstrap/bootstrapService.ts)

## agy evidence and gap

- Installed version: 1.4.2. Help exposes `-p`, `--output-format stream-json`, `--mode plan`, `--sandbox` and `--agent`; no isolation receipt was produced.
- Official documentation describes plan mode as a `/plan` prompt prefix. Headless mode auto-allows workspace reads and writes; the terminal sandbox mounts project folders read-write. These are insufficient for a read-only reviewer. [Execution modes](https://www.agy.dev/docs/cli/modes/), [headless permissions](https://www.agy.dev/docs/cli/headless/), [terminal sandbox](https://www.agy.dev/docs/sandbox/)
- Custom-agent documentation lists tool limits and MCP settings, but this investigation did not establish a CLI-only, host-owned profile path with strict config/MCP isolation. agy remains unavailable. No profile, account or model execution was attempted. [Custom agents](https://www.agy.dev/docs/subagents?tab=cli)

## Remaining verification

- Final integration tests and exact-head CI must validate pure rotation, delta continuity, start-failure/no-verdict walking, blocked exhaustion, fresh child authority and additive family/reason metadata. Any child ending without a saved verdict retries the remaining eligible walk; no quota classification is inferred from vendor text.
- Native account/model smoke remains manual, as listed in [smoke.md](../smoke.md#reviewer-pool-native-legs-519-2026-10-19). Fake CLI tests prove the host contract and refusal paths, not vendor model behavior.

## Production admission readback

On 2026-10-19 the actual `codexReviewerBackend.prepare` ran against `/opt/homebrew/bin/codex` 0.146.0 in a new temporary repository directory, with empty temporary HOME and CODEX_HOME and a fixed inert hub transport. It returned `readOnly: true`, `strictMcp: true`, `ephemeral: true` and `current: true` after the native MCP, exact/glob/symlink denial, public read and write-denial probes. The temporary home and fixtures were removed. This did not execute `codex exec`, initialize an account, copy credentials or issue a model request. Network blocking remains a configured restriction, not a separately observed network probe.

The first correctly initialized native run exposed an admission bug: the pinned bundled model catalog exceeds the 128 KiB inventory-output cap. Configuration validation now drains that one command without retaining its output, with a separate 4 MiB ceiling; MCP/version/sandbox metadata retain the 128 KiB ceiling. A red-first regression covers a larger valid catalog and refuses a catalog above the ceiling. The production-backend admission then passed.

The shared review child also bounds a stream frame to 256 KiB and total stdout to 4 MiB. Overflow revokes verdict authority before process-group teardown and only then reports head/revision-bound `no_verdict` failures for the current and unprocessed requests. A person's stop suppresses automatic fallback. Fake-CLI regressions cover both limits, batch failure, watchdog cleanup and stop-generation revocation.

Agy declaration metadata is separate from the native runtime catalog. Existing supported/optional peer projections, exact legacy catalog tests, registry-guard expectations and the empty baseline are unchanged. An unavailable-only declaration set cannot fall through to legacy automatic approval; its static #533 reason remains in routing explanations, including explicit nominations.

## Core deny policy

Codex imports the exact-pinned portable core's `DENY_NAMES` and `DENY_SEGMENTS` and translates the supported literal-prefix/suffix regex forms into conservative native deny globs. Unknown syntax refuses admission. The profile includes each subtree explicitly, and the daemon also supplies its concrete state directory. Runtime fixtures now require both `.env` and `.agenthub/state/private.txt` to be unreadable. The production backend passed again with these global core rules on 2026-10-19, with `portable-core-name-and-state-deny` in its evidence. Explicit private paths protect lexical and existing real paths and include descendants; plain relative substring entries are conservatively broadened.

This global policy does not enumerate the filesystem on the verified macOS path: the pinned native implementation translates unreadable globs into anchored Seatbelt regular expressions, including `**/`, at read time. A glob containing `**` does not automatically protect descendants, which is why the explicit `/**` rules are required. [Pinned Seatbelt compiler](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/sandboxing/src/seatbelt.rs#L441-L581), [policy-level glob semantics](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/protocol/src/permissions.rs#L306). Other native platforms must pass their runtime proof; no native Linux account/model success is claimed.

## Focused verification

Pinned Bun 1.4.2 on the remote Linux runner passed TypeScript, plugin-bundle freshness and 365 tests in 20 affected files (2,883 assertions). The actual macOS Codex 0.146.0 preparation passed again with core deny, explicit paths and nested substring rules. All 421 existing seed anchors remain unique; this static check is not a seeded-runtime result. These focused results predate the compatibility repair and do not establish a successful final-head full gate. Existing catalog/guard tests, the registry baseline and seed manifest are byte-unchanged.


## Compatibility repair checkpoint

The full CI run at historical head `4aa64c12` exposed nine failures in unchanged I2 compatibility tests: the original headless Codex/Kimi reviewer-role declaration had been reinterpreted as a fresh variant. That head's 421 seeded guards passed; seed success did not waive the compatibility failures. The repair adds explicit `review_mode: "fresh"` opt-in for Codex/Kimi, preserves existing Claude selection and keeps legacy native reviewer-role instances outside the fresh pool. The native production privacy-profile proof is unchanged by this declaration repair. The repaired head's final full CI gate is pending.

After the explicit-fresh declaration correction, pinned Bun 1.4.2 passed TypeScript, bundle freshness and 381 tests in 24 affected files (3,052 assertions), including every previously failing I2/reload/worktree/revert test. The isolation producer and common child lifecycle are byte-identical to the native-probed implementation. All 421 existing source anchors remain unique. Final full CI for the corrected head remains a separate PR gate.
