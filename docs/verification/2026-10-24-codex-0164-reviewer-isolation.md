# Codex 0.164.0 fresh-reviewer isolation receipt

Date: 2026-10-24. Platform: macOS arm64. Scope: model-free production `codexReviewerBackend.prepare`; no `codex exec`, model request, account login, credential copy or live review was performed, and the person's real home and `~/.codex` were never passed to the Codex CLI. This extends the [0.163.0 receipt](2026-10-22-codex-reviewer-isolation.md) (and through it the [0.146.0 receipt](2026-10-19-reviewer-isolation.md)), retaining their limitations. Issue: #757.

Result: every leg passed. `0.164.0` is added to `COMPAT["codex-review"].verified`.

## Source identity

The upstream annotated tag `openai/codex` `rust-v0.164.0` resolves to tag object `fe3b29455488c2e189e43ad5526a107900c5e1b7`, peeled commit `6aaac694803004a63c6f393d153c96d22521a6b9` (`git ls-remote` readback of `refs/tags/rust-v0.164.0` and `refs/tags/rust-v0.164.0^{}`, 2026-10-24). For comparison the 0.163.0 readback in the same call was tag object `129b8ec7ee6f4511557a4856279f529025c25af4`, peeled commit `83086188ae0614bd882818ff1aa23f3194962012`, matching the earlier receipt.

Each file below was fetched at the peeled commit (HTTP 200) and the quoted region was read, not only located. Lines moved since 0.163.0 (the Apps gate and the notify wiring in particular), so the claims were rechecked against the code and not against the old line numbers.

- [Exec switches](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/exec/src/cli.rs#L40): `--ephemeral` (no session files persisted), `--ignore-user-config` (`$CODEX_HOME/config.toml` is not loaded; auth still uses `CODEX_HOME`) and `--ignore-rules` (user and project execpolicy `.rules` are not loaded) are still global exec switches. They do not remove every config layer, so the host still fences config files itself.
- [Apps gate](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/mcp.rs#L458): the implicit Apps connection is registered only when `apps_enabled` holds and the session is not `SessionIsolation::Isolated`; otherwise the compatibility registration is removed. A session with MCP servers disabled sets `apps_enabled = false` ([L279](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/mcp.rs#L279)). The configured MCP inventory alone cannot show the runtime compatibility server, so effective feature readback of Apps stays a required leg.
- [Plugin manager](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core-plugins/src/manager.rs#L823): `plugins_for_config` returns `PluginLoadOutcome::default()` (no plugins) when `plugins_enabled` is false. [MCP schema](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/mcp_types.rs#L240): `enabled` defaults true and a false server is not initialized; [`enabled_tools`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/mcp_types.rs#L288) is an allow-list ("only these tools will be registered") and `disabled_tools` is applied after it.
- Legacy `notify` is independent of the hooks feature. [Session construction](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/mod.rs#L5581) copies `config.notify` into `legacy_notify_argv` while `feature_enabled` is set separately from `Feature::CodexHooks`; the [hook registry](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/hooks/src/registry.rs#L133) builds an after-agent hook from a non-empty `legacy_notify_argv` without consulting that flag, and the session comment ([L2343](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/mod.rs#L2343)) says legacy notify settings stay session-static. The host therefore keeps pinning `notify=[]` in both metadata proofs and the returned exec argv. This is a source and argv guarantee, not a model-driven hook execution test.
- [Seatbelt compiler](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/sandboxing/src/seatbelt.rs#L624): `build_seatbelt_unreadable_glob_policy` still turns each unreadable glob into anchored read and write denies, canonicalizes the static prefix (`canonicalize_glob_static_prefix_for_sandbox`), keeps the `/**/` literal-basename form and denies renames of every ancestor directory that could hold a match.

## Native production preparation

The installed fnm launcher for 0.164.0 was selected explicitly (`command: [<codex.js>]`), without changing `codex_bin`. The production resolver maps it to the native `@openai/codex-darwin-arm64` executable and hashes its bytes. Binary identity: `sha256:5b9983835177b544bba49d54b6679faf2f833a8b278068a158698f5c4eef1395`.

How it was run. A throwaway producer (not committed) made a fresh temporary root with separate HOME, CODEX_HOME and project directories inside it, and started the production call in a child with a cleared environment: only PATH, TMPDIR, LANG, the two temporary homes and a marker for the temporary root. The child refused to run if HOME was the person's real home, if `os.homedir()` differed from HOME, if HOME, CODEX_HOME or the project was not inside the temporary root, or if any other variable was inherited. The hub transport was the inert `/usr/bin/false` with no token. The actual `codexReviewerBackend.prepare` was invoked with a fresh session id, an abort signal, a fixed prompt and private paths (`**/*.env`, `.private`, `nested/secret`, `~/private-proof`). It returned a launch description; that launch was never executed, and the temporary root was removed afterwards (no run directory was left).

Runs:

- Before the compat change, 0.164.0 with empty temporary homes: refused at the version leg only (`causeClass: version`, "Version not verified: ... 0.164.0 (verified 0.146.0, 0.163.0)"), in 0.13 s. This is the person's reported refusal, reproduced model-free.
- With `0.164.0` added, 0.164.0 with empty temporary homes: passed every production admission leg (0.25 s).
- With `0.164.0` added, 0.164.0 with synthetic ambient configuration in the temporary CODEX_HOME (a legacy `notify` command, Apps, plugins and hooks switched on, one stdio and one HTTP MCP server): passed again (0.26 s). Ambient servers were disabled stubs and only `agent-hub` stayed enabled with exactly the two review tools.
- Retained 0.146.0 executable with the same policy and empty temporary homes: passed (0.40 s), binary identity `sha256:4a6398187165c5bd75ad92c9a6fba6df6d401a59b62f7e1ecf9218a8196852a6`, unchanged from the earlier receipts.

Every successful launch returned `backend: codex`, `readOnly: true`, `strictMcp: true`, `ephemeral: true`, `current(): true`, `notify=[]` in its argv and no model run. The recorded evidence list was identical for all three passing runs: `model-free-mcp-inventory-disabled-ambient`, `hub-tools-exact-allowlist`, `plugins-and-hooks-disabled`, `legacy-notify-disabled`, `apps-disabled-effective-feature-readback`, `web-search-disabled`, `project-untrusted`, `native-public-read-private-deny-write-deny`, `native-glob-and-symlink-private-deny`, `portable-core-name-and-state-deny`, `standard-host-credential-roots-denied`, `binary-config-stable`, `binary-hash-once-metadata-fence`, `session-ephemeral`.

| Native canary | Required observed result | 0.164.0 |
| --- | --- | --- |
| Public file | Read allowed | passed |
| Exact private path | Read denied | passed |
| Nested `**/*.env` private path | Read denied | passed |
| Symlink alias into private glob | Read denied | passed |
| Portable-core `.env` and `.agenthub/state` | Read denied | passed |
| Synthetic host gh, kube and docker credential roots | Read denied | passed |
| Symlink alias into synthetic credential root | Read denied | passed |
| New file creation | Write denied; file absent | passed |

The producer inside `prepare` requires unique effective Apps, plugins and hooks rows with value false, exact MCP transport and tool readback, a bounded bundled-model catalog check, stable binary and config metadata, public read success and all of the canaries above; a failure of any one refuses with a closed cause class (#722). None failed.

## Compatibility change

`COMPAT["codex-review"].verified` becomes `["0.146.0", "0.163.0", "0.164.0"]` (`src/adapters/compat.ts`). Another version is still refused unless the person runs `ahub agents trust codex-review <version>`, and every runtime isolation proof still runs after trust. The fixtures that used 0.164.0 as their example of an unverified version now use 0.165.0, and `test/compat.test.ts` covers the new entry and its neighbours (0.164.1, 0.165.0, a prerelease and a prefixed string stay refused).

## Evidence boundaries

Unchanged from the 0.163.0 receipt. The network setting remains configured disabled, without a separate network probe. Web search is requested disabled; the effective model-turn mode is not read back. Returned exec argv is checked, but no run proves exec selecting the named default permission profile. No account or model review, TUI interaction or native Linux result is claimed. The runs exercise the installed macOS binary; same-user filesystem or config mutation after the final metadata check remains outside atomic snapshot guarantees. The supported credential-root list is bounded, not a classifier for every private host file. The source claims are read at the 0.164.0 tag only; a later 0.164.x is a different version and is not covered. Hosted CI and the changed-source gate are separate code-verification evidence recorded on the PR.

Each Codex upgrade still repeats these steps by hand; making the producer a committed one-command script is the follow-up named in #757, not part of this receipt.
