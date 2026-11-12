# Codex 0.167.2 fresh-reviewer isolation receipt

Date: 2026-11-13. Platform: macOS arm64, Bun 1.4.4. This repeats the [0.167.0 model-free production preparation](2026-11-06-codex-0167-reviewer-isolation.md) for 0.167.2, the version installed on the machine where `ahub agents` reported `codex-review 0.167.2 refused`. Controls: 0.166.0 (verified, run on the committed tree) and 0.167.0 (model-free only, run beside 0.167.2 under the same provisional entry). Source base: `08d4b893` on main, with the exact-pinned `@staix/agent-mem@0.24.0` from a frozen install. No `codex exec`, `codex app-server`, model request, login, credential copy or live reviewer run was performed. The returned launch was inspected, never started. The person's real HOME, `~/.codex` and the global Codex install were never supplied to a Codex process or modified, and no running hub or hub home was touched.

Result: all model-free legs returned the expected outcome. 0.167.2 passed the model-free procedure. It is not added to `verified`: `docs/agent-notes/adapters.md` requires a successful, separately authorized model-backed hub tool call before a reviewer version is marked verified, and that run was not performed. It is unverified for 0.167.2, as is everything a model turn would show (tool selection, verdict delivery, the synthetic marker readback, real account authentication). Until then the person can run `ahub agents trust codex-review 0.167.2`, and every runtime proof still runs.

## Source identity and re-read regions

`git ls-remote https://github.com/openai/codex.git` returned, for 0.167.2 (`rust-v0.167.2`), annotated tag object `08a3b12b3298577534a28b62ed976acf8de66eda` and peeled commit `ce21072c90d32c40af7a55b60b2fb35c84a43a6a`. The same readback returned the 0.167.0 tag object `cb41599ccbe371272892f156286a236aa097bada` and peeled commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`, matching its receipt.

Each of the seven files read for 0.167.0 was fetched at both peeled commits and compared by SHA-256. All seven are byte-identical between the tags, so every region the 0.167.0 receipt read is the same code at the same line numbers:

| File (under `codex-rs/`) | SHA-256 at both tags |
| --- | --- |
| `exec/src/cli.rs` | `66643e8b3d5964b70cb8f231fb309312376272fb3ea87bcb6849f44cf112f8f6` |
| `config/src/mcp_types.rs` | `af5fb824c092cd74e3a42297979a4d250c332008f5409e14890253728747e71a` |
| `core/src/mcp.rs` | `2ae5ed00a6e26a46f62be65136047850aaa11a8e2ff849d7323eeea5bbc0f4c9` |
| `hooks/src/registry.rs` | `06e349e62e53eee6c3a7418667868d57119cbf52be99271137b7f8c14dea4d85` |
| `sandboxing/src/seatbelt.rs` | `ebd230e96ce456d95466406137995dc055cc8116ec32879b3ff4e8ddff5c65a3` |
| `core/src/session/mod.rs` | `c04716274b5ecfc91730908bf25159bc6498a368d10352a0fc311aae7182df62` |
| `core-plugins/src/manager.rs` | `9719bccd786891686ff2c6e2194aff4c6adc0065e75c41509ec4fe4dc1430ab9` |

- [Exec switches, lines 40-50](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/exec/src/cli.rs#L40): `--ephemeral`, `--ignore-user-config` and `--ignore-rules` remain independent global switches.
- [Apps projection, lines 279-285](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/core/src/mcp.rs#L279) and [registration, lines 464-485](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/core/src/mcp.rs#L464): unchanged, so effective feature readback stays required.
- [MCP schema, lines 243-245](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/config/src/mcp_types.rs#L243) and [291-297](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/config/src/mcp_types.rs#L291): a disabled server is not initialized; `enabled_tools` restricts, `disabled_tools` filters afterwards.
- [Registry, lines 179-197](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/hooks/src/registry.rs#L179): a non-empty legacy notify argv still becomes an after-agent hook independently of the hooks feature flag.
- [Session hook configuration, line 5822](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/core/src/session/mod.rs#L5822) and the [session-static comment, lines 2407-2410](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/core/src/session/mod.rs#L2407): `legacy_notify_argv: config.notify.clone()` and the session-static legacy notify comment are unchanged, so the host still pins `notify=[]`.
- [Plugin manager, lines 836-841](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/core-plugins/src/manager.rs#L836): the plugin-disabled early return of the default load outcome is unchanged.
- [Seatbelt glob compiler, lines 624-705](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/sandboxing/src/seatbelt.rs#L624): the anchored read/write denies, static-prefix variants and ancestor unlink denies are the same code.

Outside those seven files, the GitHub compare of `rust-v0.167.0...rust-v0.167.2` lists five commits and thirteen files, all read. Apart from the workspace version in `Cargo.toml`, tests and snapshots, the change is the incremental tool-declaration layout: two new features, `incremental_tools_legacy` (Amazon Bedrock, default off) and `incremental_tools_legacy_gcp` (GCP, default on), a `StepContext::incremental_tools_feature()` that selects the layout per provider, and, in incremental mode, top-level hosted web-search specs kept in the request while the other tool declarations move to world state (`core/src/session/{step_context,turn,world_state}.rs`, `core/src/compact_remote_v2_attempt.rs`, `core/config.schema.json`, `features/src/lib.rs`). Tool declarations are still taken from `model_visible_specs()`, so the set of tools offered is unchanged; only where they are declared changes. None of it touches MCP server registration, the Apps, plugins or hooks gates, legacy notify, `--ephemeral`, project trust or Seatbelt. The production preparation below still proved effective Apps, plugins and hooks disablement through its `features list` readback on 0.167.2.

## Native production preparation

A throwaway producer outside the source checkout, in a private scratch directory, invoked the actual `codexReviewerBackend.prepare` from a worktree of main at the source base. Each leg used its own fresh root holding project, HOME, CODEX_HOME and TMPDIR. The child ran under `env -i` with only PATH, LANG, HOME, CODEX_HOME, TMPDIR and two fixture markers; PATH held a private directory with only a `node` link plus the system directories, so no global Codex was reachable. Before importing the backend, it rejected any extra variable, a `os.homedir()` that differed from HOME, and any home, CODEX_HOME or temp directory outside the root. The MCP transport was inert `/usr/bin/false` with no control token, and the private paths were `**/*.env`, `.private`, `nested/secret` and `~/private-proof`.

Three Codex versions were installed with `npm install --prefix` into separate private prefixes, with scratch HOME and cache and empty user and global npm configs. Each lockfile's integrity equals the registry's exact-version `dist.integrity`: 0.167.2 `sha512-6OFkr2ndzTdFb32OEiUlM9BgpeY8+wnMe8vRhuvt+22TnxVR39KnJ22Ghay98IY9OmEltoNgFN4GALUkxFQCOw==`, 0.167.0 `sha512-1FSQgbTIKAdTub5Ln6z36NT4eXDmBRkinfigzycbgn9yLZdJ3UdkQZqr0N7jnl8/D1xxT/Pz3Fl2l7S2dmRaFA==` (the manifest's reference value). The command was each prefix's `codex.js` launcher, resolved by production to its native arm64 binary. Temporary roots were removed after each leg, and the returned exec launch was never executed.

| Leg | Outcome | Elapsed |
| --- | --- | --- |
| Committed tree, 0.167.2, empty homes | Refused only at version admission, `causeClass: version`; verified set 0.146.0, 0.163.0, 0.164.0, 0.166.0 | 1801.18 ms |
| Control 0.166.0 on the committed tree, empty homes | All production preparation legs pass | 1753.76 ms |
| Control 0.166.0 on the committed tree, synthetic ambient config | All production preparation legs pass | 298.60 ms |
| With 0.167.2 provisionally in the local verified array (a stand-in for the person's machine trust), empty homes | All production preparation legs pass | 291.75 ms |
| Same provisional entry, synthetic ambient config | All production preparation legs pass | 284.51 ms |
| Control 0.167.0 under the same provisional entry, empty homes | All production preparation legs pass | 1796.99 ms |
| Control 0.167.0 under the same provisional entry, synthetic ambient config | All production preparation legs pass | 285.34 ms |

The first preparation against each freshly installed binary took about 1.8 s and the later ones about 0.3 s, consistent with a first-launch cost of the new native binary; all stayed inside the production limits. The provisional array held 0.167.0 and 0.167.2 for the four provisional legs and was reverted before any edit below; the committed tree refuses both.

The ambient file enabled Apps, plugins and hooks, set a legacy notify command and declared one stdio and one HTTP MCP server. Metadata preparation disabled the ambient servers, kept only the hub server with exactly `hub_review` and `hub_task_show`, and proved effective Apps, plugins and hooks disablement. Per-tool approval stays configured only for those two hub tools; actual MCP tool execution is outside this receipt.

| Version | Native binary SHA-256 | Production binary identity |
| --- | --- | --- |
| 0.167.2 | `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0` | `sha256:28596b8867646e50ef492bc036a751fd63113c8d4360803f435fec69d2fbdbc2` |
| 0.167.0 (control) | `030316ecfbb41f4e7946e584b0063ef333b7a36cd312ba349f2f6869e39b62cc` | `sha256:213f7a2c8109c5f5158151b829bfc561bc76bbcdcce0b641c1e9a01b8b541e37` |
| 0.166.0 (control) | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` | `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |

Both controls' native digests and production identities equal the values in their receipts, so the procedure reproduces. Every successful launch returned `backend: codex`, `readOnly: true`, `strictMcp: true`, `ephemeral: true`, `current(): true`, an exec argv beginning `exec` and an explicit `-c notify=[]`. The evidence list was identical across all six successful launches and equal to the 0.167.0 list: `model-free-mcp-inventory-disabled-ambient`, `hub-tools-exact-allowlist`, `plugins-and-hooks-disabled`, `legacy-notify-disabled`, `apps-disabled-effective-feature-readback`, `web-search-disabled`, `project-untrusted`, `native-public-read-private-deny-write-deny`, `native-glob-and-symlink-private-deny`, `portable-core-name-and-state-deny`, `standard-host-credential-roots-denied`, `binary-config-stable`, `binary-hash-once-metadata-fence`, `session-ephemeral`.

Production's own native canaries passed for 0.167.2 (a returned launch means they ran and passed): public read, denied exact private read, denied nested private glob and symlink alias, denied portable-core `.env` and `.agenthub/state`, denied synthetic gh, kube and docker credential roots and credential alias, and denied creation of a new file with the file remaining absent. Production's metadata commands kept their 2-second command and 12-second overall limits and owned-group cleanup; none failed.

## Compatibility and evidence boundaries

The verified reviewer versions stay 0.146.0, 0.163.0, 0.164.0 and 0.166.0. 0.167.2 is not added, and neither is 0.167.0: the area note requires the model-backed hub tool call first. The passing 0.167.2 legs ran with 0.167.2 in a local, uncommitted copy of the verified array, which is the same admission outcome the person's `ahub agents trust codex-review 0.167.2` produces, since trust lifts only the version pin and every proof still runs. The committed tree refuses 0.167.2 at version admission, as the first leg showed. The compat `receipt` pointer and the receipt manifest keep naming the 0.167.0 receipt; the `codex-review` comment in `src/adapters/compat.ts` lists this one as model-free only. The attached Codex adapter's capability pins (`NATIVE_PINS.codex`) are a separate contract and unchanged. No isolation implementation, sandbox ceiling or trust bypass changes. `docs/verified.json` is not restamped.

Unverified for 0.167.2: the single model-backed tool-call run (marker, head, verdict and cleanup readback), which needs the person's separate authorization; exec selecting the named default profile; model tool selection; real account authentication; effective web-search mode; and the effect of the new incremental tool-declaration layout on a real model turn. The network setting is configured disabled without a separate probe. No native Linux result is claimed. Same-user mutation after the final metadata check is outside atomic snapshot guarantees, and the bounded credential-root list is not a classifier for every private host file.

Source claims apply to the two peeled commits only. Each upgrade repeats the procedure; the throwaway producer is not a supported command and its raw records carry temporary paths, so they stay outside git. Exact-head hosted CI is separate evidence recorded on the PR.
