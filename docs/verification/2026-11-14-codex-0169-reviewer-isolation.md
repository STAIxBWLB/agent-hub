# Codex 0.169.0 fresh-reviewer isolation receipt

Date: 2026-11-14. Platform: macOS arm64, Bun 1.4.4. Scope: issue #888, hub task 931. This repeats the [0.167.2 model-free procedure](2026-11-13-codex-01672-reviewer-isolation.md) for 0.169.0, with 0.166.0 (verified) and 0.167.2 as controls. The separately authorized [single model-backed review](2026-11-14-codex-0169-reviewer-tool-call.md) is recorded beside it.

Result: every model-free leg returned the expected outcome. 0.169.0 passed the committed reviewer proofs, the source and tag legs, and the app-server schema comparison. The global `codex` binary was not touched: all three versions were installed with `npm install --prefix` into private prefixes.

## Source identity and re-read regions

`git ls-remote https://github.com/openai/codex.git` returned, for 0.169.0 (`rust-v0.169.0`), annotated tag object `a41fe5b443652cbdbee57717fbb9fd78d8d8b32a` and peeled commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`. The same readback returned the 0.167.2 tag object `08a3b12b3298577534a28b62ed976acf8de66eda` (peeled `ce21072c90d32c40af7a55b60b2fb35c84a43a6a`) and the 0.166.0 tag object `593389380740f7b4762771573c447ccfdc59742f` (peeled `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`), matching their receipts.

The seven files read for 0.167.2 were fetched at both peeled commits and compared by SHA-256. One is byte-identical and six changed, so each changed one was diffed and its re-read region reviewed:

| File (under `codex-rs/`) | 0.167.2 SHA-256 | 0.169.0 SHA-256 |
| --- | --- | --- |
| `hooks/src/registry.rs` | `06e349e62e53eee6c3a7418667868d57119cbf52be99271137b7f8c14dea4d85` | same |
| `exec/src/cli.rs` | `66643e8b3d5964b70cb8f231fb309312376272fb3ea87bcb6849f44cf112f8f6` | `7fbc3d9d481513488dcceea2a6c8fdcd045a2b2de6aaa1d30379354cd66b04d6` |
| `config/src/mcp_types.rs` | `af5fb824c092cd74e3a42297979a4d250c332008f5409e14890253728747e71a` | `3bc2f134d6b9992022f38727d21ce7aeb9bc157788b2d1d1912f88c7d65afe0d` |
| `core/src/mcp.rs` | `2ae5ed00a6e26a46f62be65136047850aaa11a8e2ff849d7323eeea5bbc0f4c9` | `55640da23629bc9684386e7f76d4365a7dec7dc499c0582e4db1ae4f24956d2f` |
| `sandboxing/src/seatbelt.rs` | `ebd230e96ce456d95466406137995dc055cc8116ec32879b3ff4e8ddff5c65a3` | `9482cfbb53d624f1421b6e05b231ee567b18ed0973c0547b54196dac351ffcf4` |
| `core/src/session/mod.rs` | `c04716274b5ecfc91730908bf25159bc6498a368d10352a0fc311aae7182df62` | `6eecc35de03cb80b3ceb1b5e0e43ff0f8e926d75376bec00219fcb967be1afc8` |
| `core-plugins/src/manager.rs` | `9719bccd786891686ff2c6e2194aff4c6adc0065e75c41509ec4fe4dc1430ab9` | `a7c95dbdbda54e8d3d195be4f5d77cef71619c268cb3b974d9cec40f1e9814b9` |

- Exec switches: `--ephemeral`, `--ignore-user-config` and `--ignore-rules` are unchanged. A new global `--trust` switch saves project trust and persists even with `--ephemeral`, and does not override an explicitly untrusted project. The hub never passes `--trust` and pins the project `untrusted`, and the production proof reads `project-untrusted` back.
- MCP schema: a disabled server is still not initialized. The new `can_defer_stdio_startup` serves the `mcp_lazy_stdio_startup` feature, which is under development and default off.
- Apps and MCP registration (`core/src/mcp.rs`): plugin-manager and runtime-auth plumbing only. In the session, the Apps server is added as a required MCP server only when `turn_context.apps_enabled()` holds, and the hub disables Apps, which the `features list` readback proves.
- Registry: identical, so a non-empty legacy notify argv still becomes an after-agent hook independently of the hooks flag. `legacy_notify_argv: config.notify.clone()` is unchanged in the session and only moved (line 5822 to 6167), so the explicit `-c notify=[]` is still required and still passed.
- Plugin manager: every `plugins_enabled` early return that produced the default load outcome is still present (lines 894, 918, 1105, 1745, 1773 and 2057 in 0.169.0).
- Seatbelt: the compiler now resolves the policy once (`resolve_for_enforcement`) instead of calling the policy getters one by one, and removed dead legacy helpers. It adds a `ProcessWithInheritedTerminal` profile that denies `TIOCSTI`. The anchored read/write denies, static-prefix variants, ancestor unlink denies and the unreadable-glob compiler read the same inputs. The native sandbox canaries below are the behavioral check.
- Web search: the session now resolves a model search binding. Hosted search is gated by the `hosted_search_policy` feature (under development, default off) and by `apps_enabled()`. The hub still requests web search disabled. Its effective turn mode is not read back, as for earlier versions.

Outside those seven files the compare lists 471 commits, and a blobless clone of both tags lists 2570 changed paths (the GitHub compare API caps at 300 files). Of those, 52 `core`, 27 `exec-server`, 22 `core-plugins`, 14 `rmcp-client`, 14 `login`, 13 `network-proxy`, 12 `state`, 12 `config`, 8 `linux-sandbox`, 8 `cli`, 7 `sandboxing`, 7 `exec`, 4 `app-server` and 3 `features` non-test files sit under isolation-relevant crates. I read the whole `features`, `exec`, `cli/mcp_cmd` and seven-file diffs listed above and did not read the rest line by line. The `features` diff adds under-development flags (`hosted_search_policy`, `agent_message_board_mcp`, `mcp_lazy_stdio_startup`, `command_sessions_world_state`) and moves several to stable and default on (`untrusted_as_tool_output`, `code_mode_host_grpc`, `code_mode_host_output_truncation`, `unified_image_budget`, `retain_client_tool_outputs`, `guardian_include_additional_context`); none gates MCP registration, Apps, plugins, hooks, legacy notify, ephemeral sessions, project trust or Seatbelt. This is scoped source evidence for the two peeled commits, not a claim about the unread files.

## Native production preparation

A throwaway producer outside the source checkout, in a private scratch directory, called the committed `runReviewerProofs` (`scripts/compat-receipts/proofs/reviewers.ts`), which runs the actual `codexReviewerBackend.prepare`. Each leg used its own fresh root holding project, HOME, CODEX_HOME and TMPDIR. The child ran with a clean environment: only PATH (a private directory holding `node` and `bun` links, then `/usr/bin:/bin`), LANG, LC_ALL, TZ, TERM and the private homes. The committed worker's own environment allowlist and bounded runner were used.

Three Codex versions were installed with `npm install --prefix` into separate private prefixes, with scratch cache and empty user and global npm configs. Each lockfile's integrity for `@openai/codex` equals the registry's exact-version `dist.integrity`: 0.169.0 `sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==`, 0.167.2 `sha512-6OFkr2ndzTdFb32OEiUlM9BgpeY8+wnMe8vRhuvt+22TnxVR39KnJ22Ghay98IY9OmEltoNgFN4GALUkxFQCOw==` and 0.166.0 `sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==`.

| Leg | Outcome | Elapsed |
| --- | --- | --- |
| Committed tree, 0.169.0 | Refused at version admission before trust (`version-negative` pass), then 17 of 17 runnable legs pass, including empty-home and ambient prepares and all 14 attested markers | 675 ms |
| Control 0.167.2 | 17 of 17 runnable legs pass | 669 ms |
| Control 0.166.0 (verified) | 16 of 16 runnable legs pass; `version-negative` is not applicable | 560 ms |

In all three runs the four manifest legs that no model-free producer can prove stayed not-run: `model-backed-hub-call` (`model-required`), `control` (not a per-version leg), `source-impact` (`source-review-required`, answered by the section above) and `tag-binding` (answered by the tag objects above).

| Version | Native binary SHA-256 | Production binary identity |
| --- | --- | --- |
| 0.169.0 | `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002` | `sha256:5cb2fa931709a799a155da3685c5dcd5be751a26dffdf6d947f4b9d4c5e9d88d` |
| 0.167.2 (control) | `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0` | `sha256:28596b8867646e50ef492bc036a751fd63113c8d4360803f435fec69d2fbdbc2` |
| 0.166.0 (control) | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` | `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |

Both controls' native digests and production identities equal the values in their receipts, so the procedure reproduces. A returned launch means production's own native canaries ran and passed: public read, denied exact private read, denied nested private glob and symlink alias, denied portable-core `.env` and `.agenthub/state`, denied synthetic gh, kube and docker credential roots and alias, and denied creation of a new file.

## App-server schema comparison

`codex app-server generate-json-schema --out <dir>` (and `--experimental`) ran with the native binaries under a clean environment, for 0.169.0 and 0.167.2:

| Bundle | Files | Client request methods | Server requests, notifications | Removed types, removed properties, newly required fields, removed enum values |
| --- | --- | --- | --- | --- |
| Stable | 322 to 329 | 106 to 109 (adds `account/securitySetup/read`, `modelProvider/config/write`, `modelProvider/list`) | 10 and 86, unchanged | none (678 to 700 definitions) |
| Experimental | 470 to 479 | 180 to 184 (adds the three above and `thread/prepareApprovedPlan`) | 11 and 86, unchanged | none (840 to 864 definitions) |

Thirty-nine stable and fifty-four experimental files differ in content. The comparison found no removed type, no removed property, no newly required field and no removed enum value in any shared definition; it did not classify other edits (descriptions, new optional fields, widened enums). The methods the hub's `codex-appserver.ts` uses (`thread/start`, `thread/resume`, `thread/revert`, `turn/start`, `turn/steer`, `turn/interrupt`, `skills/list`, `account/rateLimits/read` and the notifications it handles) are all still present. This is a schema comparison, not a run of the attached app-server adapter against 0.169.0: attached Codex compatibility is a different COMPAT entry and is not changed here.

## Compatibility and evidence boundaries

The verified reviewer versions become 0.146.0, 0.163.0, 0.164.0, 0.166.0 and 0.169.0 only together with the [model-backed receipt](2026-11-14-codex-0169-reviewer-tool-call.md). 0.167.0 and 0.167.2 stay unverified: their model-backed runs were not performed or did not complete.

Source claims apply to the two peeled commits only. Each upgrade repeats the procedure; the throwaway producer is not a supported command, and its raw records carry temporary paths, so they stay outside git. Exact-head hosted CI is separate evidence recorded on the PR.
