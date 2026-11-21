# Codex 0.171.0 fresh-reviewer model-free receipt

Date: 2026-11-22. Platform: macOS arm64, Bun 1.4.4. Scope: issue #888, hub task 1024. This repeats the production preparation used in the [0.169.0 receipt](2026-11-14-codex-0169-reviewer-isolation.md) against the installed and npm-latest 0.171.0, with 0.169.0 as the verified control.

**Result: the runnable model-free preparation legs passed. 0.171.0 remains unverified.** The one separately requested model-backed review did not persist a verdict; the source comparison below is partial. This receipt is not admission evidence for the version.

## Artifact and isolated preparation

Exact npm installs were made in separate private prefixes with private HOME, cache, and empty user and global npm configuration. Their lockfile integrity values matched the registry's exact-version `dist.integrity`:

- 0.171.0: `sha512-1IOFzL2Xg86tLdw6kDo3GoKbkQENgQi7TI6rlEvN132R7ngSw7SNOIQoTcnKzSZZ8kf9N9GynCweSoaFbqk2Eg==`. Native macOS arm64 binary SHA-256: `fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42`.
- 0.169.0 control: `sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==`. Native binary SHA-256: `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002`, matching the earlier receipt.

A private throwaway producer invoked the committed `runReviewerProofs`, production `codexReviewerBackend.prepare`, and its bounded runner. Each version used separate HOME, CODEX_HOME, TMPDIR, hub home and fixture roots. The environment contained only those roots, PATH to private node and Bun links and system binaries, locale, timezone and terminal settings. No model was called by these preparation legs. The 0.171.0 committed-tree version refusal passed before a temporary, exact-version trust entry was made in the isolated hub home. The control was already verified.

- 0.171.0: 17 runnable legs passed, including version refusal, empty-home and ambient preparation, and the 14 preparation attestation markers.
- 0.169.0 control: 16 runnable legs passed; the negative version leg was not applicable.
- The model-backed call, source-impact, tag-binding and control manifest entries were not established by the producer. Source identity and the partial comparison below are separate observations.

These results cover the production preparation and its native canaries, including public read, private path and alias denials, host credential-root denials and denied write. They do not prove a model turn, verdict delivery, network mode or every possible isolation path.

## Source identity and partial comparison

The annotated `rust-v0.171.0` tag object was `295eca93394bb83a6ec8e0841033f3997f97fcbd`, peeled to `ccf9be8cc458bd6b8336fe84d68d8893f2691a5e`. The 0.169.0 control peeled to `d32063f96c2dff1dc96af839b3952abb6acfeda4`. The upstream comparison contains 389 commits and 2,282 changed paths.

Of the seven files in the prior receipt, `codex-rs/sandboxing/src/seatbelt.rs` is byte-identical. The other six changed: hook registry, exec CLI, MCP types, MCP management, session, and plugin manager. The changed hook, CLI, MCP types and MCP management diffs and feature changes were inspected; the larger session and plugin manager diffs were only partially inspected. In particular the CLI adds a remote-exec option, and MCP runtime configuration now accepts a contribution context. The reviewed feature diff also enables `incremental_tools_legacy` by default. The new version still contains the `plugins_enabled` guards, the `apps_enabled()` check and the legacy notify assignment. These observations are not a complete source impact review, and the remaining changed paths were not reviewed line by line.

## App-server schema comparison

Schema generation ran in the isolated homes for both versions, stable and experimental, without a model call. The comparison below checks file names and top-level definitions and their direct properties, required fields and enums; it is not a complete semantic compatibility check.

- Stable: 329 to 331 schema files, 35 shared files changed, none removed. In the v2 bundle, 700 to 714 definitions, none removed; five direct properties were removed: `AgentMessageDisplay.action`, `blockType`, `checkTrustedContacts`, `cyberTrustedAccess`, and `Project.position`. No new direct required field or removed direct enum value was found.
- Experimental: 479 to 483 schema files, 49 shared files changed. `CurrentTimeReadParams.json` and `CurrentTimeReadResponse.json`, and their corresponding top-level definitions, were removed. The v2 bundle has the same five direct property removals as stable. Other changes were not classified.

The schema differences do not by themselves establish whether the hub's attached app-server adapter is affected; that adapter is a separate compatibility entry and was not exercised here.

## Model-backed attempt and cleanup

Before the native attempt, the temporary daemon fixture was checked with a fake reviewer. It produced one approved verdict at the fixture head, and the harness checked the review envelope's marker and head before opening an exclusive one-attempt fence. The native fixture then used one isolated HOME and a temporary auth-file symlink to the configured account. No credential contents were copied or recorded.

The single 0.171.0 attempt reached the fence and the host recorded a `hub_review` call with native exit 0, but after 180 seconds the task remained `in_review` with zero persisted reviewer verdicts. No tool refusal was recorded in the bounded diagnostic. The cause is unknown; no second model attempt was made. This does not prove verdict delivery, and no model-backed receipt is claimed.

The temporary auth symlink was removed. The account auth file's metadata fingerprint matched before and after the attempt, and a process-table scan for the fixture and target prefix found zero remaining processes. The fixture and raw model output are not committed.

## Admission boundary

The `codex-review` verified list and receipt pointer remain unchanged. A future qualification needs a complete source impact review, investigation of the missing verdict, and a successful separately authorized model-backed hub tool call at the exact fixture head. The attached Codex entry, trust policy and runtime isolation proofs are unchanged.
