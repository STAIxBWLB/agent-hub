# Codex 0.167.0 fresh-reviewer isolation receipt

Date: 2026-11-06. Platform: macOS arm64, Bun 1.4.3. Scope: issue #888, task 747. This repeats the [0.166.0 model-free production preparation](2026-10-31-codex-0166-reviewer-isolation.md) with 0.166.0 as the control. Source base: `f7cbefda` (0.32.0 on main). No `codex exec`, model request, login, credential copy or live reviewer run was performed. The returned launch was inspected, never started. The person's real HOME, `~/.codex`, the Orca codex account home and the global Codex install were never supplied to a Codex process or modified.

Result: all four model-free legs returned the expected outcome, so 0.167.0 is added to the verified reviewer set. The single model-backed tool-call run (the [2026-11-02 receipt](2026-11-02-codex-0166-reviewer-tool-call.md) for 0.166.0) needs the person's separate authorization and was not run. It is unverified for 0.167.0, as is everything a model turn would show (tool selection, verdict delivery, the synthetic marker readback, real account authentication).

## Source identity and re-read regions

`git ls-remote https://github.com/openai/codex.git` returned, for 0.167.0, annotated tag object `cb41599ccbe371272892f156286a236aa097bada` and peeled commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`. The same readback returned the 0.166.0 tag object `593389380740f7b4762771573c447ccfdc59742f` and peeled commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, matching its receipt.

Each of the seven files read for 0.166.0 was fetched at both peeled commits and compared by SHA-256 and by diff. Five are byte-identical between the tags: `exec/src/cli.rs`, `config/src/mcp_types.rs`, `core/src/mcp.rs`, `hooks/src/registry.rs` and `sandboxing/src/seatbelt.rs`. Two changed, `core/src/session/mod.rs` and `core-plugins/src/manager.rs`, and were read at their new anchors.

- [Exec switches, lines 40-50](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/exec/src/cli.rs#L40): identical. `--ephemeral`, `--ignore-user-config` and `--ignore-rules` remain independent global switches, and auth still uses `CODEX_HOME`.
- [Apps projection, lines 279-285](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/mcp.rs#L279) and [registration, lines 464-485](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/mcp.rs#L464): identical. Disabling MCP servers clears the Apps gate, and implicit Apps registration still needs Apps enabled and a non-isolated session. Configured inventory alone still cannot prove the runtime server absent, so effective feature readback stays required.
- [MCP schema, lines 243-245](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/config/src/mcp_types.rs#L243) and [291-297](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/config/src/mcp_types.rs#L291): identical. A disabled server is not initialized; `enabled_tools` restricts, `disabled_tools` filters afterwards.
- [Registry, lines 179-197](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/hooks/src/registry.rs#L179): identical. A non-empty legacy notify argv still becomes an after-agent hook independently of the hooks feature flag.
- [Session hook configuration, now line 5822](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/session/mod.rs#L5822) (was 5736) and the [session-static comment, now lines 2407-2410](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/session/mod.rs#L2407) (was 2389-2392): `session/mod.rs` changed (5756 to 5842 lines). The diff was read in full for the regions that matter here. `legacy_notify_argv: config.notify.clone()` is unchanged, and the comment still says legacy notify settings remain session-static. The other hunks are an `inject` visibility change, a `PendingApproval` import, a `NetworkApprovalTurn` enum, token-estimate and sampling bookkeeping, queued network approval holding, and an exec policy manager now built `from_snapshot` with its source requirements. None touches notify, hooks, Apps gating or isolated-session metadata. The host therefore still pins `notify=[]` for the metadata proofs and the returned exec argv.
- [Plugin manager, now lines 836-841](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core-plugins/src/manager.rs#L836) (was 831-834): `manager.rs` changed (3793 to 3800 lines). The plugin-disabled early return of the default load outcome is unchanged. The one hunk, near line 665, clears per-plugin Apps policy before building the plugin load input, which does not change the disabled-plugins path.
- [Seatbelt glob compiler, lines 624-705](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/sandboxing/src/seatbelt.rs#L624): identical, so the anchored read/write denies, static-prefix variants and ancestor unlink denies are the same code.

## Native production preparation

A throwaway producer outside the source checkout, in a private scratch directory, invoked the actual `codexReviewerBackend.prepare` from a clean worktree of main plus this change, with the frozen install's exact `@staix/agent-mem@0.21.0`. Each leg used its own fresh root holding project, HOME, CODEX_HOME and TMPDIR. The child ran under `env -i` with only PATH, LANG, HOME, CODEX_HOME, TMPDIR and two fixture markers. Before importing the backend, it rejected any extra variable, a `os.homedir()` that differed from HOME, and any home, CODEX_HOME or temp directory outside the root. The MCP transport was inert `/usr/bin/false` with no control token, and the private paths were `**/*.env`, `.private`, `nested/secret` and `~/private-proof`.

Both Codex versions were installed with `npm install --prefix` into separate private prefixes, with scratch HOME and cache and empty user and global npm configs. The command was each prefix's `codex.js` launcher, resolved by production to its native arm64 binary. Temporary roots and canaries were removed after each leg, and the returned exec launch was never executed.

| Leg | Outcome | Elapsed |
| --- | --- | --- |
| Before compat edit, 0.167.0, empty homes | Refused only at version admission, `causeClass: version`; previous verified set 0.146.0, 0.163.0, 0.164.0, 0.166.0 | 160.67 ms |
| After exact 0.167.0 addition, empty homes | All production preparation legs pass | 261.26 ms |
| After addition, synthetic ambient config | All production preparation legs pass | 261.83 ms |
| Control 0.166.0, empty homes (run before the edit) | All production preparation legs pass | 302.52 ms |
| Control 0.166.0, synthetic ambient config (run after the edit) | All production preparation legs pass | 252.46 ms |

The ambient file enabled Apps, plugins and hooks, set a legacy notify command and declared one stdio and one HTTP MCP server. Metadata preparation disabled the ambient servers, kept only the hub server with exactly `hub_review` and `hub_task_show`, and proved effective Apps, plugins and hooks disablement. Per-tool approval stays configured only for those two hub tools; actual MCP tool execution is outside this receipt.

| Version | Native binary SHA-256 | Production binary identity |
| --- | --- | --- |
| 0.167.0 | `030316ecfbb41f4e7946e584b0063ef333b7a36cd312ba349f2f6869e39b62cc` | `sha256:213f7a2c8109c5f5158151b829bfc561bc76bbcdcce0b641c1e9a01b8b541e37` |
| 0.166.0 (control) | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` | `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |

The control's native digest and production identity equal the values in the 0.166.0 receipt, so the procedure reproduces. Every successful launch returned `backend: codex`, `readOnly: true`, `strictMcp: true`, `ephemeral: true`, `current(): true`, an exec argv beginning `exec` and an explicit `-c notify=[]`. The evidence list was identical across all four successful launches and equal to the 0.166.0 list: `model-free-mcp-inventory-disabled-ambient`, `hub-tools-exact-allowlist`, `plugins-and-hooks-disabled`, `legacy-notify-disabled`, `apps-disabled-effective-feature-readback`, `web-search-disabled`, `project-untrusted`, `native-public-read-private-deny-write-deny`, `native-glob-and-symlink-private-deny`, `portable-core-name-and-state-deny`, `standard-host-credential-roots-denied`, `binary-config-stable`, `binary-hash-once-metadata-fence`, `session-ephemeral`.

Production's own native canaries passed for 0.167.0: public read, denied exact private read, denied nested private glob and symlink alias, denied portable-core `.env` and `.agenthub/state`, denied synthetic gh, kube and docker credential roots and credential alias, and denied creation of a new file with the file remaining absent. Production's metadata commands kept their 2-second command and 12-second overall limits and owned-group cleanup; none failed.

## Compatibility and evidence boundaries

The verified reviewer versions are now 0.146.0, 0.163.0, 0.164.0, 0.166.0 and 0.167.0. 0.165.0 stays unverified. The exact-version test refuses 0.167.1, 0.168.0, a prerelease and a prefixed string. The attached Codex adapter's capability pins (`NATIVE_PINS.codex`, still 0.166.0) are a separate contract and unchanged. No isolation implementation, sandbox ceiling or trust bypass changes. `docs/verified.json` is not restamped.

Unverified for 0.167.0: the single model-backed tool-call run (marker, head, verdict and cleanup readback), which needs the person's separate authorization; exec selecting the named default profile; model tool selection; real account authentication; and effective web-search mode. The network setting is configured disabled without a separate probe. No native Linux result is claimed. Same-user mutation after the final metadata check is outside atomic snapshot guarantees, and the bounded credential-root list is not a classifier for every private host file.

Source claims apply to the two peeled commits only. Each upgrade repeats the procedure; the throwaway producer is not a supported command and its raw records carry temporary paths, so they stay outside git. The changed-source gate on dgx02 and exact-head hosted CI are separate evidence recorded on the PR.
