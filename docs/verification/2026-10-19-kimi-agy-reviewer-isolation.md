# Kimi and agy reviewer isolation (#533)

## Status

R0 is in progress. Neither variant is enabled. Metadata, preliminary kernel checks and account-free MCP round trips below are native evidence; they do not establish authenticated review, the final production profile, TUI coexistence or quota behavior. No account login, real credential copy, remote model request or real project configuration write has run.

## Initial native metadata receipt

On 2026-10-19 both installed arm64 binaries ran `--version` and `--help` under `/usr/bin/sandbox-exec`, using a new HOME, tool home, cwd and TMPDIR. The profile was built from `src/local/sandbox.ts` in read-only-data mode, with real-home read/write denied, exact native executable reads allowed and writes restricted to owned temporary paths. Network was denied. Children used independent tracked process groups, a 5-second deadline and a 64 KiB combined output cap; cleanup was confirmed.

| Tool | Reported version | Installed binary SHA-256 |
| --- | --- | --- |
| kimi | 2.2.0 | `dab42ead275f8a49e9ce30a6263f614fce5926455bed103d0d16940655619bf5` |
| agy | 1.4.2 | `74935642426b5bb1fcf07a5555f847c478f4517dd002c72b9c98159cb773b932` |

Before CLI execution, a fixed shell read a synthetic project canary successfully, then attempted a new project file, an existing-file overwrite and a hardlink into the writable temporary directory. All three mutations were denied, the new file stayed absent and the canary stayed unchanged. This preliminary check does not replace a final production-profile probe or cover arbitrary preexisting aliases.

Real Kimi config/MCP/plugin registry, the real project's Kimi MCP file and documented agy/Gemini config locations were hashed by the host before/after the probe. Configuration contents were never printed or staged. The canonical aggregate digest of logical IDs, presence and SHA-256 values was `1bf6927f9f77ea0f82556314e1d44156074771b88e0dd2ae596fd3999cbc645c` both times. Temporary roots were removed; no child remained.

## Account-free native MCP receipt

At 07:24-07:26 UTC on 2026-10-19, each installed binary completed a fresh session against a host-owned loopback fake model and a fixture stdio MCP server. The server returned synthetic data and never connected to the live hub. All credentials were fixed fixture strings. Each tool used its own new HOME, tool home, cwd and TMPDIR; the real home remained kernel-denied. Only the fake model port was allowed outbound. Real configuration hashes remained unchanged, and each temporary home/session tree and owned process group was removed after exit.

Kimi used `KIMI_CODE_HOME`, the `KIMI_MODEL_*` static OpenAI-provider overrides, an explicit agent Markdown file and an empty `--skills-dir`. Its agent tools list contained exactly `mcp__agent-hub__hub_review` and `mcp__agent-hub__hub_task_show`. The native model request exposed exactly those two function schemas on all three requests. Two synthetic model tool calls reached the fixture MCP server, in order: `hub_task_show`, then `hub_review`; both results returned to the next model request. The final native output was `R0_OK`, followed by a session resume hint. The hint demonstrates persistence inside the temporary home; it does not authorize a resume. Kimi's watcher startup needed an additional `mach-lookup` grant for `com.apple.FSEvents`; without it startup failed before any model request.

Agy used private `~/.gemini/antigravity-cli/settings.json` with `modelProvider: gemini`, a dummy `GEMINI_API_KEY` and a loopback `GOOGLE_GEMINI_BASE_URL`. Its sole MCP entry was in private `~/.gemini/config/mcp_config.json`. Without explicit MCP permissions, the native child discovered the fixture server but auto-denied the first MCP call, despite exiting with code zero. With exactly `mcp(agent-hub/hub_review)` and `mcp(agent-hub/hub_task_show)` in `permissions.allow`, both calls reached the fixture server and completed. No dangerous permission-skipping flag was used. Agy sends MCP arguments as JSON strings; a production boundary must normalize bounded JSON and still validate arguments. Its model schemas include native write/command tools, so the kernel profile remains the write boundary. Agy needs both loopback bind and inbound permission for its internal ephemeral listener; outbound permission alone fails at startup. This startup requirement does not prove the listener's production security or authorize general loopback access.

A separate account-free native-tool probe deliberately exposed the write tool: Kimi `Write` and agy `write_to_file` each attempted a fresh project file and an existing-file overwrite. Valid native calls reached the filesystem and returned permission-denied errors; neither file mutation occurred. An earlier Kimi attempt used the wrong `file_path` field and was rejected by schema validation; that attempt is not counted as a kernel refusal. The corrected probe used `path`. Agy had an explicit synthetic-project `write_file` allow rule, so its permission prompt was not the boundary. Both children exited zero after the fake model acknowledged the refusals, which also shows why exit zero alone cannot establish task success.

Agy listener ownership was observed while the fake model response was held: the native agy process owned two `127.0.0.1` TCP listening sockets and no separate process in its owned group. No authentication conclusion is drawn from this observation.

These receipts establish private-home startup, successful MCP round trips and preliminary native-tool mutation refusal. They do not yet establish exclusion when every ambient source contains a decoy, authenticated account compatibility or the final broker/profile.

## Kimi ambient-source positive control

A synthetic ambient HOME/tool home and synthetic trusted project were populated with user, root-project, cwd-project and installed-plugin MCP decoys. The plugin had a skill description nonce and a `UserPromptSubmit` hook writing an owned marker. In the ambient native positive control, all four decoy servers received `initialize` and `tools/list`, the model request contained the plugin skill description, and the hook marker appeared. This establishes that the fixtures were active rather than malformed or hidden only by a tool whitelist.

The isolated native leg switched both HOME and KIMI_CODE_HOME, used a clean cwd, explicit empty skills directory and explicit agent file, and denied reads of the synthetic project's two MCP config files. The same configured ambient sources remained present. No decoy connection, skill description or hook marker appeared. Both legs returned through the local fake model, preserved real configuration hashes, and removed their temporary home/session tree after verified group teardown. This proves these source exclusions for the preliminary R0 profile; final production broker/profile receipts remain required.

## Agy ambient-source positive control

A synthetic ambient HOME and project held distinct user/project MCP entries, hooks and skills. A local synthetic plugin contained its own MCP entry, hook and skill and was installed with native `agy plugin install` inside the same synthetic HOME and sandbox. The install completed with one MCP server, one hook and one skill processed. The ambient native run initialized and listed tools from all three MCP sources, and all three hook markers appeared. The isolated native leg switched to a fresh HOME and clean cwd, did not reuse imported plugin/config/cache state, disabled slash commands, and denied reads of the synthetic project's `.agents` tree. No decoy connection or hook marker appeared. A follow-up captured `systemInstruction`: the ambient model requests contained all three skill-description nonces, while the isolated leg contained none. Installation output alone was not counted as proof of model disclosure.

## Auth and listener evidence boundary

Host inspection of only the configured Kimi OAuth slot confirmed file storage and the expected token field names. No token value was printed, staged or supplied to a native child. The snapshot was not valid beyond a ten-minute review deadline. It was not refreshed or copied. Pinned source supports a non-refresh static access-token provider, but managed protocol/header compatibility and real service acceptance remain unverified. Missing/expired snapshots must be unavailable, rather than triggering login or independently refreshing a copy while the person's TUI may refresh the same account.

Agy's private-home Gemini API-key mode is proven only with a fixture key/local provider. The person's existing settings use the native account mode. Historical Keychain service reports for 1.0.0 and desktop language-server CSRF flags do not prove 1.4.2 CLI auth or listener protection. No Keychain access was granted or attempted. Neither broad `*.googleapis.com` egress nor a copied native OAuth token is justified by the receipts.

## Primary-source constraints

Kimi print mode forwards `--agent-file` and explicit `--skills-dir`; ACP bootstrap does not forward those options. MCP startup merges config sources, and even untrusted-project diagnostics can try to read project MCP files. An isolated clean native cwd and kernel denial of ambient files must therefore be proved. OAuth refresh storage/locking must preserve the person's TUI; copying a refresh token into a separate home is not accepted as coexistence evidence. [Pinned Kimi source](https://github.com/MoonshotAI/kimi-code/tree/472192c34c1efad89a369870eff0da0b708ce9bb).

Agy's headless workspace writes are automatically allowed and its plan mode is a prompt prefix. Its own sandbox is not the reviewer read-only guarantee. Account-free inventory can use the documented Gemini provider setting, dummy key and local base URL, but installed-version behavior must be observed. [Headless](https://antigravity.google/docs/cli/headless), [authentication/provider configuration](https://antigravity.google/docs/install), [GitHub's pinned private-home harness](https://github.com/github/gh-aw/blob/8c885156117f098a280fb75c0f47f750a566ff3e/actions/setup/js/agy_harness.cjs).

A whole-process sandbox cannot give an ordinary MCP child access to the full hub `control-token`: token holders can select other control roles. A fixed, revocable, task-bound two-tool broker outside the sandbox is required unless an existing equally narrow transport is established.

## Remaining R0 evidence

- Final broker inventory/self-check, including refused unknown MCP tools and malformed arguments.
- Final-profile ambient-source exclusion and immutable host-owned broker/config files (R0 ambient-source controls passed for both installed tools).
- Final production-profile target read and mutation refusals, preexisting alias checks, private/credential denial and model-only network.
- Exact auth source and safe refresh behavior, without whole-home access.
- Session/home cleanup after success, failure and timeout; real config hashes unchanged.
- Kimi TUI identity/project MCP byte parity and shared-account quota fanout.

No runtime availability claim is made until these receipts pass.

## Gate state

This is an R0 evidence report, not a feature-completion or availability receipt. No launcher, registry, daemon, spec contract or default pool was changed. Full tests, typecheck, mutation seeds and exact-head CI have not run for an implementation. One agy skill-disclosure probe was refused before execution by resource admission (exit 75, another heavyweight process). After a fresh process read confirmed that process had exited, one admitted follow-up completed and established the three skill-description positive/negative controls. The deferral itself is not counted as a test result. Auth-scope and native-listener questions were sent to the planner before production work.
