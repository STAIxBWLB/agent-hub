# Codex 0.166.0 fresh-reviewer isolation receipt

Date: 2026-10-31. Platform: macOS arm64, Bun 1.4.2. Scope: issue #888, task 576. This repeats the [0.164.0 model-free production preparation](2026-10-24-codex-0164-reviewer-isolation.md), retaining the 0.146.0 control and the earlier evidence boundaries. Source base: `a6497d495759e8a1176eb95dc19e31eaff5dbb70` (0.23.0). No `codex exec`, model request, login, credential copy or live reviewer run was performed. The returned launch was inspected, never started. The person's real HOME and `~/.codex` were never supplied to a Codex process.

Result: all four model-free legs returned the expected outcome. The subsequent [one-run model-backed receipt](2026-10-31-codex-0166-reviewer-tool-call.md) persisted an approved native verdict but failed its required synthetic-marker readback. The proposed 0.166.0 verified bump was therefore reverted. Both 0.165.0 and 0.166.0 remain unverified; this positive model-free inventory alone does not qualify a version.

## Source identity and re-read regions

`git ls-remote https://github.com/openai/codex.git 'refs/tags/rust-v0.166.0' 'refs/tags/rust-v0.166.0^{}'` returned annotated tag object `593389380740f7b4762771573c447ccfdc59742f` and peeled commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The same readback retained the earlier 0.164.0 tag object `fe3b29455488c2e189e43ad5526a107900c5e1b7` and peeled commit `6aaac694803004a63c6f393d153c96d22521a6b9`, matching its receipt.

Each of the seven files below was fetched successfully at the 0.166.0 peeled commit in the remote source-analysis workspace. The implementation regions were read, including moved anchors, rather than inferring behavior from matching names or old line numbers.

- [Exec switches, lines 40-50](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/exec/src/cli.rs#L40): ephemeral sessions, ignoring the user config file and ignoring user/project execpolicy rules remain independent global exec switches. Auth still uses CODEX_HOME; ignoring user config does not remove every configuration layer.
- [Apps projection, lines 279-285](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/mcp.rs#L279) and [registration, lines 464-485](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/mcp.rs#L464): disabling MCP servers clears the Apps gate; implicit Apps registration still requires Apps enabled and a session without isolated-session metadata, and is removed otherwise. Configured MCP inventory alone cannot prove this runtime server absent, so effective feature readback remains required.
- [Plugin manager, lines 831-834](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core-plugins/src/manager.rs#L831): disabling plugins returns the default empty load result before plugin discovery.
- [MCP schema, lines 243-245](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/config/src/mcp_types.rs#L243) and [291-297](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/config/src/mcp_types.rs#L291): a disabled server is not initialized; enabled tools restrict exposure, and disabled tools filter that result afterwards.
- [Session hook configuration, lines 5735-5743](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/session/mod.rs#L5735) and [registry, lines 179-197](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/hooks/src/registry.rs#L179): legacy notify arguments are copied independently of the hooks feature. A non-empty legacy command becomes an after-agent hook independently of the engine feature flag. The [session-static comment, lines 2389-2392](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/session/mod.rs#L2389) remains. The host therefore still pins `notify=[]` for metadata proofs and the returned exec argv; no model-driven notify execution is claimed.
- [Seatbelt glob compiler, lines 624-705](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/sandboxing/src/seatbelt.rs#L624): unreadable globs produce anchored read/write denies, canonicalized static-prefix variants and directory-unlink denies for ancestors. The root-recursive literal-basename form still protects descendants without needing ancestor guards.

## Native production preparation

A throwaway producer outside the source checkout invoked the actual `codexReviewerBackend.prepare`. A frozen install in this worktree supplied the exact `@staix/agent-mem@0.13.0`; the producer checked that local package version before importing the backend. Each leg used fresh project, HOME, CODEX_HOME and TMPDIR directories under its own temporary root. A child received only PATH, LANG, HOME, CODEX_HOME, TMPDIR and a fixture-root marker. Before importing the production backend, it rejected extra environment variables, a mismatched `os.homedir()`, or any home/project/temp directory outside that root. No real configuration or credentials were copied. The MCP transport was inert `/usr/bin/false`, without a control token, and private paths were `**/*.env`, `.private`, `nested/secret` and `~/private-proof`.

The command was the explicitly selected installed npm `codex.js` launcher, resolved by production to its native arm64 binary. The control used the retained Homebrew npm launcher. Both native binaries remained outside the project and the producer checked the returned receipt, stable `current()` binding and empty notify override. Production `prepare` ran its own metadata and native sandbox canaries. Temporary homes and canaries were removed after each leg; the returned exec launch was never executed.

| Leg | Outcome | Elapsed |
| --- | --- | --- |
| Before compat edit, 0.166.0, empty homes | Refused only at version admission, `causeClass: version`; previous verified set 0.146.0, 0.163.0, 0.164.0 | 122.32 ms |
| After exact 0.166.0 addition, empty homes | All production preparation legs pass | 344.82 ms |
| After addition, synthetic ambient config | All production preparation legs pass | 352.80 ms |
| Retained 0.146.0 control, empty homes | All production preparation legs pass | 477.53 ms |

The ambient file enabled Apps, plugins and hooks, supplied a legacy notify command and declared one stdio and one HTTP MCP server. Metadata preparation disabled the ambient servers, retained only the hub server with exactly `hub_review` and `hub_task_show`, and proved effective Apps/plugins/hooks disablement. Per-tool approval remains configured only for those two hub tools; actual MCP tool execution is outside this receipt.

| Version | Native binary SHA-256 | Production binary identity |
| --- | --- | --- |
| 0.166.0 | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` | `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |
| 0.146.0 | `ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02` | `sha256:4a6398187165c5bd75ad92c9a6fba6df6d401a59b62f7e1ecf9218a8196852a6` |

The production identity hashes the native file digest again, so it differs from the direct binary digest. The 0.146.0 production identity matches the earlier receipts.

All successful launches returned `backend: codex`, `readOnly: true`, `strictMcp: true`, `ephemeral: true`, `current(): true` and `notify=[]`. Their evidence lists were identical: `model-free-mcp-inventory-disabled-ambient`, `hub-tools-exact-allowlist`, `plugins-and-hooks-disabled`, `legacy-notify-disabled`, `apps-disabled-effective-feature-readback`, `web-search-disabled`, `project-untrusted`, `native-public-read-private-deny-write-deny`, `native-glob-and-symlink-private-deny`, `portable-core-name-and-state-deny`, `standard-host-credential-roots-denied`, `binary-config-stable`, `binary-hash-once-metadata-fence`, `session-ephemeral`.

Native canaries passed for a public read, denied exact private read, denied nested private glob and symlink alias, denied portable-core `.env` and `.agenthub/state`, denied synthetic gh/kube/docker credential roots and credential alias, and denied creation of a new file with the file remaining absent. Production's metadata commands retain their existing 2-second command and 12-second overall limits and owned-group cleanup; none failed.

## Compatibility and evidence boundaries

The verified reviewer versions remain 0.146.0, 0.163.0 and 0.164.0 after the incomplete model-backed receipt. The existing 0.165.0 unverified/trust fixtures stay unverified. The exact-version test now refuses 0.166.0 as well as 0.166.1, 0.167.0, a prerelease and a prefixed string. Capability pins for the attached Codex adapter are a separate contract and unchanged. No isolation implementation, sandbox ceiling or trust bypass changes.

The network setting is configured disabled without a separate network probe. Web search is requested disabled without model-turn readback. No run proves exec selecting the named default profile, model tool selection, real account authentication or verdict delivery. The [0.164.0 model-backed tool-call receipt](2026-10-25-codex-0164-reviewer-tool-call.md) is evidence for that version only. A separately authorized [0.166.0 model review](2026-10-31-codex-0166-reviewer-tool-call.md) did reach persisted native verdict delivery, but its required synthetic marker was missing, so the full receipt remains failed. No model retry was made. No native Linux result is claimed. Same-user mutation after the final metadata check is outside atomic snapshot guarantees, and the bounded credential-root list is not a classifier for every private host file.

Source claims apply to this peeled 0.166.0 commit only. Each upgrade repeats the procedure; the throwaway producer is not a new supported command. Raw local probe records carry temporary paths and stay outside git. The pinned-Bun bundle rebuild, changed-source gate and exact-head hosted CI are separate evidence recorded on the PR.
