# COMPAT receipt audit for CI automation (#1248 T0)

Date: 2026-11-07. Task #761. Receipt pointers were read from `src/adapters/compat.ts` at `3440e7b10dc6b4537d56541774436aa4f7d49a92`. The data source is [manifest.json](../../scripts/compat-receipts/manifest.json). This audit runs no agent CLI, installer, model, TUI or workflow and changes no verified version.

`autoAdmit` means policy eligibility after every required leg and artifact binding passes. It is not an implemented driver or a current pass. Missing work is not-run. One Mac arm64 job can repeat an eligible id's complete procedure, including its portable checks; the Linux category does not require an extra matrix job. Native macOS arm64 qualification is retained; a portable Linux fixture or source comparison does not qualify a Linux-only rerun. Qwen explicitly rejected Linux-only evidence. Optional, explicitly unverified model/TUI follow-ups do not become new admission requirements.

Source comparison can produce hashes and diffs on Linux. Changed security/contract regions still require scoped human review: diff availability alone is never a passing review leg. T1 must report such work as not-run until reviewed.

## Per-id scheduling and eligibility

| COMPAT id | Model-free repeat | Remaining required scope | Installation | autoAdmit |
| --- | --- | --- | --- | --- |
| `pi` | Linux host permission/version fixtures; Mac RPC extension, SDK and tool receipts | Mac arm64 native | npm exact | `true` |
| `claude-implementer` | Mac Write/Bash/rewrite transport and wrapper controls, synthetic provider | Mac arm64 native | npm exact; native-installer receipt boundary | `true` |
| `codex-review` | Linux source comparison; Mac production metadata and native sandbox controls | Person-authorized model-backed tool call | npm exact | `false` |
| `kimi-review` | Linux source comparison; Mac private config/broker/native allowlist controls | Mac arm64 native | GitHub asset + SHA-256 | `true` |
| `jcode` | Linux source comparison; Mac serve/ACP/MCP and fixed-stream steering | Mac arm64 native | GitHub asset + SHA256SUMS | `true` |
| `agy` | Mac CLI, synthetic MCP/hooks and Seatbelt controls | Interactive TUI/launcher nonce; no public install source | Unavailable | `false` |
| `qwen` | Mac ACP/permission and install replay; recorded Linux run is additional | Mac arm64 repetition required | npm exact | `true` |
| `qwen-dual` | Version/file-source checks are partial only | Real gateway model and PTY; OS not recorded | npm exact; historical artifact gap | `false` |

The macOS requirement follows each receipt's native artifact/host boundary; the manifest does not claim those native procedures have passed on Linux. `qwen-dual`'s OS remains unspecified because its current receipt does not name one. `codex-review` stays false even with successful model-free preparation; its separately authorized 0.167.0 model-backed attempt has an unknown outcome. `agy` stays false independently of model-free sublegs because there is no public install source.

## Installation evidence and boundaries

Install methods describe exact future candidate acquisition, with no global installer. npm candidates must bind to their exact-version `dist.integrity`; release candidates must verify the versioned checksum and GitHub asset digest before bounded extraction. Reference hashes in the manifest are observed metadata or receipt bindings, not a new execution result.

- Claude 2.1.319 was observed through the native installer while npm lagged. The exact npm version is now publicly available and its SRI was read without downloading or executing it. That does not equate its tarball with the receipt's native binary SHA.
- Jcode's receipt identifies an installed release build. The v0.99.1 release API now supplies `jcode-macos-aarch64.tar.gz`, an asset SHA-256 and `SHA256SUMS`; that future acquisition recipe is not retrospective archive-execution proof.
- Kimi's reference receipt already binds its official macOS arm64 archive to the GitHub digest and sibling checksum.
- Codex's native binary hashes and qwen-dual's changing fnm global install are not npm SRI evidence. Public exact-version npm metadata was read separately.
- No npm/GitHub method is invented for agy. Its unavailable install method makes an automated run not-run.

## pi

Current receipt: [2026-11-03-pi-150-compat.md](2026-11-03-pi-150-compat.md). `autoAdmit: true`. The admitted procedure is model-free; real inference and interactive coexistence are explicitly unverified follow-ups.

### Recorded receipt legs

- **native-identity**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Native identity".
- **cli-rpc-session**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Real CLI extension load and RPC session identity".
- **sdk-registration**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Installed SDK extension registration".
- **tool-replay**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Managed tool callback and receipt replay".
- **failed-tool**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Failed tool result".
- **zero-provider-requests**: `macos-runner`, required, runner OS `macos`. [## Results](2026-11-03-pi-150-compat.md): "Zero requests reached the loopback provider".
- **host-permission-modes**: `linux-ci`, required, runner OS `linux, macos`. [## Results](2026-11-03-pi-150-compat.md): "Host permission modes".
- **version-admission**: `linux-ci`, required, runner OS `linux, macos`. [## Results](2026-11-03-pi-150-compat.md): "Version admission".
- **isolated-home-cleanup**: `macos-runner`, required, runner OS `macos`. [## Identity and isolation](2026-11-03-pi-150-compat.md): "9551 entries, identical.".

### Explicitly unverified follow-ups

- **real-inference-tools-quota**: `account-or-model`, not required by the current admission receipt. [## Not verified](2026-11-03-pi-150-compat.md): "Account-backed inference, a model-generated tool request".
- **interactive-coexistence**: `tui-desktop`, not required by the current admission receipt. [## Not verified](2026-11-03-pi-150-compat.md): "interactive TUI coexistence.".
- **native-linux-intel**: `linux-ci`, not required by the current admission receipt. [## Not verified](2026-11-03-pi-150-compat.md): "Linux and Intel macOS.".

## claude-implementer

Current receipt: [2026-11-06-claude-implementer-2.1.319.md](2026-11-06-claude-implementer-2.1.319.md). `autoAdmit: true`. Permission transport and wrapper controls use a synthetic provider, with no real account or model required.

### Recorded receipt legs

- **write-allow**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-deny**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-missing-tool**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-hook-deny**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-hook-allow**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-mcp-error**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-disconnect**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-pending**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **write-deadline**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline)".
- **bash-allow**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-deny**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-missing-tool**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-hook-deny**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-hook-allow**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-mcp-error**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-disconnect**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-pending**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-deadline**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash transport, production server and tool names, `tool_use_id` required".
- **bash-rewrite-allow**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash `updatedInput` command replacement (allow, deny)".
- **bash-rewrite-deny**: `macos-runner`, required, runner OS `macos`. [## Runs](2026-11-06-claude-implementer-2.1.319.md): "Bash `updatedInput` command replacement (allow, deny)".
- **wrapper-cwd**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Persistent-shell control reports `sub` twice".
- **wrapper-root**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Fresh rewritten input executes the fixed root".
- **wrapper-executable**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Target identity equals the absolute host-selected executable".
- **wrapper-poison-env**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Injected native GIT_DIR and RIPGREP_CONFIG_PATH are absent".
- **wrapper-host-env**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Target HOME/PATH/TERM and peer identity equal the host fixture values".
- **wrapper-tmp**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Owned TMPDIR replaces native state".
- **wrapper-replay**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Same ticket's second execution returns the fixed refusal".
- **wrapper-effect-once**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Effect counter remains exactly 1 after replay".
- **wrapper-quoted-paths**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Spaces and apostrophes in root/executable paths".
- **wrapper-cleanup**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Native exit 0, host stopped, no remaining live native group members".
- **wrapper-binary-fence**: `macos-runner`, required, runner OS `macos`. [## Native observations](2026-10-26-headless-claude-shell-context.md): "Binary unchanged across the case".
- **upstream-impact-review**: `linux-ci`, required, runner OS `linux, macos`. [## Upstream changes since 2.1.318](2026-11-06-claude-implementer-2.1.319.md): "This receipt therefore rests on observed behavior only".

### Explicitly unverified follow-ups

- **real-provider-model**: `account-or-model`, not required by the current admission receipt. [## Evidence boundaries](2026-11-06-claude-implementer-2.1.319.md): "no real provider authentication, model tool selection".
- **person-approval**: `tui-desktop`, not required by the current admission receipt. [## Evidence boundaries](2026-11-06-claude-implementer-2.1.319.md): "person approval interaction".
- **native-task-resume-binding**: `account-or-model`, not required by the current admission receipt. [## Evidence boundaries](2026-11-06-claude-implementer-2.1.319.md): "task-session resume or production-daemon task binding is proved".
- **host-seatbelt-policy**: `macos-runner`, not required by the current admission receipt. [## Host fixtures and ceilings](2026-10-26-headless-claude-shell-context.md): "The executable task-code profile is host policy verified separately by Darwin fixtures.".
- **native-internal-timeout**: `macos-runner`, not required by the current admission receipt. [## Observations](2026-10-23-headless-claude-permissions.md): "native internal timeout not established".

## codex-review

Current receipt: [2026-11-06-codex-0167-reviewer-isolation.md](2026-11-06-codex-0167-reviewer-isolation.md). `autoAdmit: false`. Admission requires a successful separately authorized model-backed hub tool call, even when every model-free preparation leg passes.

### Recorded receipt legs

- **source-impact**: `linux-ci`, required, runner OS `linux, macos`. [## Source identity and re-read regions](2026-11-06-codex-0167-reviewer-isolation.md): "Each of the seven files read for 0.166.0".
  - Changed source: not-run until the changed security/contract regions have been reviewed; never infer a pass from diff availability.
- **tag-binding**: `linux-ci`, required, runner OS `linux, macos`. [## Source identity and re-read regions](2026-11-06-codex-0167-reviewer-isolation.md): "annotated tag object".
- **version-negative**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "Refused only at version admission".
- **empty-home-prepare**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "empty homes | All production preparation legs pass".
- **ambient-prepare**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "synthetic ambient config | All production preparation legs pass".
- **control**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "Control 0.166.0, empty homes".
- **model-free-mcp-inventory-disabled-ambient**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "model-free-mcp-inventory-disabled-ambient".
- **hub-tools-exact-allowlist**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "hub-tools-exact-allowlist".
- **plugins-and-hooks-disabled**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "plugins-and-hooks-disabled".
- **legacy-notify-disabled**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "legacy-notify-disabled".
- **apps-disabled-effective-feature-readback**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "apps-disabled-effective-feature-readback".
- **web-search-disabled**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "web-search-disabled".
- **project-untrusted**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "project-untrusted".
- **native-public-read-private-deny-write-deny**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "native-public-read-private-deny-write-deny".
- **native-glob-and-symlink-private-deny**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "native-glob-and-symlink-private-deny".
- **portable-core-name-and-state-deny**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "portable-core-name-and-state-deny".
- **standard-host-credential-roots-denied**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "standard-host-credential-roots-denied".
- **binary-config-stable**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "binary-config-stable".
- **binary-hash-once-metadata-fence**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "binary-hash-once-metadata-fence".
- **session-ephemeral**: `macos-runner`, required, runner OS `macos`. [## Native production preparation](2026-11-06-codex-0167-reviewer-isolation.md): "session-ephemeral".
- **model-backed-hub-call**: `account-or-model`, required, runner OS `macos`. [## Reviewers](../agent-notes/adapters.md): "before marking a reviewer backend/version verified, record a successful model-backed hub tool call".

### Explicitly unverified follow-ups

- **effective-network-web**: `account-or-model`, not required by the current admission receipt. [## Compatibility and evidence boundaries](2026-11-06-codex-0167-reviewer-isolation.md): "The network setting is configured disabled without a separate probe.".
- **default-profile-selection**: `account-or-model`, not required by the current admission receipt. [## Compatibility and evidence boundaries](2026-11-06-codex-0167-reviewer-isolation.md): "exec selecting the named default profile".
- **native-linux**: `linux-ci`, not required by the current admission receipt. [## Compatibility and evidence boundaries](2026-11-06-codex-0167-reviewer-isolation.md): "No native Linux result is claimed.".

## kimi-review

Current receipt: [2026-11-06-kimi-251-reviewer-compat.md](2026-11-06-kimi-251-reviewer-compat.md). `autoAdmit: true`. The required native allowlist/broker controls use fixed loopback replies and synthetic credentials, without real inference.

### Recorded receipt legs

- **prepare**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Production preparation, exact version/current/config, replace environment".
- **inventory**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Exactly two MCP tools, empty subagents and skills, config mode 0600".
- **broker-refusals**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Wrong task, third tool, missing authorization and revoked broker refusals".
- **native-tool-loop**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Actual native two-tool loop, fixed loopback responses".
- **write-absent**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Injected Write absent from inventory and native tool-not-found result".
- **write-positive-control**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Explicit Write positive control".
- **environment-decoy**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Trust-workspace environment decoy removed from launch environment".
- **cleanup**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "Original synthetic config/credential bytes, owned-group and temporary cleanup".
- **network-guard-control**: `macos-runner`, required, runner OS `macos`. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "A separate preload positive control blocked a".
- **source-review**: `linux-ci`, required, runner OS `linux, macos`. [## Source review](2026-11-06-kimi-251-reviewer-compat.md): "Model-free native exact-two-tool inventories across all fixed-response requests are still required".
  - Changed source: not-run until the changed security/contract regions have been reviewed; never infer a pass from diff availability.

### Explicitly unverified follow-ups

- **real-oauth-provider**: `account-or-model`, not required by the current admission receipt. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "login/provider readiness, real OAuth refresh".
- **model-quota**: `account-or-model`, not required by the current admission receipt. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "model
behavior/quality and quota remain unverified.".
- **tui-coexistence**: `tui-desktop`, not required by the current admission receipt. [## Isolated production and native controls](2026-11-06-kimi-251-reviewer-compat.md): "attached-TUI coexistence".
- **other-platforms**: `linux-ci`, not required by the current admission receipt. [## Evidence and decision](2026-11-06-kimi-251-reviewer-compat.md): "Other platforms, future versions and model-backed
behavior are not inferred.".

## jcode

Current receipt: [2026-10-26-jcode-0.99.1.md](2026-10-26-jcode-0.99.1.md). `autoAdmit: true`. ACP, serve, MCP and running-turn steering use an isolated fixed-stream loopback provider; the real TUI/model follow-ups are not current admission legs.

### Recorded receipt legs

- **isolation**: `macos-runner`, required, runner OS `macos`. [## Isolation](2026-10-26-jcode-0.99.1.md): "Every process ran under an isolated `HOME` and `JCODE_HOME`".
- **serve-cleanup**: `macos-runner`, required, runner OS `macos`. [## Contract legs (idle server, no model)](2026-10-26-jcode-0.99.1.md): "The process group is gone after SIGTERM.".
- **acp-initialize-new-load-mode-ceilings**: `macos-runner`, required, runner OS `macos`. [## Contract legs (idle server, no model)](2026-10-26-jcode-0.99.1.md): "`session/load` returns `configOptions` and `models` only, with no `sessionId`.".
- **mcp-owned-environment**: `macos-runner`, required, runner OS `macos`. [## Contract legs (idle server, no model)](2026-10-26-jcode-0.99.1.md): "its environment held exactly `AGENTHUB_PEER_ID` and `AGENTHUB_LAUNCH_ID`".
- **telemetry**: `macos-runner`, required, runner OS `macos`. [## Contract legs (idle server, no model)](2026-10-26-jcode-0.99.1.md): "no telemetry file appeared in the isolated home.".
- **active-turn-soft-interrupt**: `macos-runner`, required, runner OS `macos`. [## Steering leg (the 0.99.0 check, now on a running turn)](2026-10-26-jcode-0.99.1.md): "No real provider, key or model was involved.".
- **source-comparison**: `linux-ci`, required, runner OS `linux, macos`. [## Source comparison v0.99.0..v0.99.1](2026-10-26-jcode-0.99.1.md): "232 commits, 300 files, read only through the GitHub compare API (nothing built).".
  - Changed source: not-run until the changed security/contract regions have been reviewed; never infer a pass from diff availability.

### Explicitly unverified follow-ups

- **real-provider-model-tool-call**: `account-or-model`, not required by the current admission receipt. [## Not verified](2026-10-26-jcode-0.99.1.md): "A real account, provider or model, and a model turn that calls a hub tool".
- **tui-repeat**: `tui-desktop`, not required by the current admission receipt. [## Not verified](2026-10-26-jcode-0.99.1.md): "The TUI form (`jcode --resume`)".
- **linux-intel-second-instance**: `linux-ci`, not required by the current admission receipt. [## Not verified](2026-10-26-jcode-0.99.1.md): "A second instance running beside the base peer, and Linux or Intel macOS builds.".

## agy

Current receipt: [2026-11-03-agy-1.4.12-launcher-nonce.md](2026-11-03-agy-1.4.12-launcher-nonce.md). `autoAdmit: false`. No public installation source is available to the watcher; the current procedure also requires interactive TUI/launcher controls.

### Recorded receipt legs

- **isolation-seatbelt-cleanup**: `macos-runner`, required, runner OS `macos`. [## Environment and isolation](2026-11-03-agy-1.4.12-launcher-nonce.md): "No account and no cloud model call.".
- **cli-contract**: `macos-runner`, required, runner OS `macos`. [# Antigravity 1.4.12 actual-hub nonce leg through the `ahub agy` launcher (#888)](2026-11-03-agy-1.4.12-launcher-nonce.md): "passed the CLI surface, the synthetic plugin MCP and hook contract and the normal TUI close".
- **synthetic-plugin-mcp-hooks**: `macos-runner`, required, runner OS `macos`. [## Synthetic plugin MCP and hook contract: passed](2026-11-03-agy-1.4.12.md): "## Synthetic plugin MCP and hook contract: passed".
- **normal-tui-close**: `tui-desktop`, required, runner OS `macos`. [## Result](2026-11-03-agy-1.4.12-launcher-nonce.md): "0, after `/exit` and Enter; agy closed by itself and printed its resume line".
- **launcher-actual-hub-nonce**: `tui-desktop`, required, runner OS `macos`. [## Result](2026-11-03-agy-1.4.12-launcher-nonce.md): "the nonce from the scratch bus preface appeared in a provider request after the tool call".

### Explicitly unverified follow-ups

- **real-account-model-permission**: `account-or-model`, not required by the current admission receipt. [## Not verified](2026-11-03-agy-1.4.12-launcher-nonce.md): "A real account, a real model's tool choices and agy's own permission prompts".
- **ide-linux-other-tui-tools**: `tui-desktop`, not required by the current admission receipt. [## Not verified](2026-11-03-agy-1.4.12-launcher-nonce.md): "`hub_send` and board calls through the TUI, the IDE form and Linux.".

## qwen

Current receipt: [2026-11-06-qwen-0268-acp.md](2026-11-06-qwen-0268-acp.md). `autoAdmit: true`. The admitted ACP/permission procedure uses no prompts or real model; macOS arm64 repetition remains required.

### Recorded receipt legs

- **artifact-private-install-integrity**: `macos-runner`, required, runner OS `macos`. [## Artifact and isolation](2026-11-06-qwen-0268-acp.md): "npm installed into a new private prefix with scratch HOME, cache and tmp, empty user/global npm configs".
- **reviewed-optional-lifecycle-replay**: `macos-runner`, required, runner OS `macos`. [## Artifact and isolation](2026-11-06-qwen-0268-acp.md): "Fresh ACP and permission probes after the replay passed again.".
- **native-acp-auth-session-modes**: `macos-runner`, required, runner OS `macos`. [## Native ACP, no prompts](2026-11-06-qwen-0268-acp.md): "ACP prompts sent: 0.".
- **actual-published-permission-handler**: `macos-runner`, required, runner OS `macos`. [## Actual published permission handler](2026-11-06-qwen-0268-acp.md): "without a model-generated tool turn.".
- **preload-network-cleanup**: `macos-runner`, required, runner OS `macos`. [## Artifact and isolation](2026-11-06-qwen-0268-acp.md): "This is preload evidence, not kernel network isolation.".
- **native-macos-repetition**: `macos-runner`, required, runner OS `macos`. [## Actual macOS arm64 repetition](2026-11-06-qwen-0268-acp.md): "The Linux-only receipt did not prove admission on this Mac.".

### Explicitly unverified follow-ups

- **additional-linux**: `linux-ci`, not required by the current admission receipt. [# Qwen Code 0.26.8 ACP receipt](2026-11-06-qwen-0268-acp.md): "The earlier Linux x86_64 run is additional evidence.".
- **real-model-microphone-tui-intel**: `account-or-model`, not required by the current admission receipt. [## Not verified](2026-11-06-qwen-0268-acp.md): "Microphone functionality, Intel macOS, a real login/provider, model-generated permission turns, model behavior, token/quota behavior and TUI qualification.".

## qwen-dual

Current receipt: [2026-10-25-qwen-dual-output-t0.md](2026-10-25-qwen-dual-output-t0.md). `autoAdmit: false`. The current receipt uses a real gateway model and an interactive PTY; model-free automation cannot admit a version.

### Recorded receipt legs

- **real-model**: `account-or-model`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "`flashnext/qwen3.8-flash-next` through the campus gateway".
- **pty-harness**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "the TUI ran on a pseudo-terminal (120x40).".
- **Q2-submit-stream-queue**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "queued, not interleaved".
- **Q3-permissions-native-enter-deny-ceiling**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "A tool that needs approval emits `control_request` `can_use_tool`".
- **Q4-known-watchdog-ceiling**: `tui-desktop`, recorded ceiling, runner OS `unspecified`. [# Qwen dual-output TUI amendment, 2026-10-25 (#286 Part 3)](../specs/2026-09-19-agent-hub-design.md): "Q2, Q3, Q5 and Q6 pass; Q4's limit is stated".
  - Recorded accepted watchdog limitation, not a passing cancellation capability; preserve it in future receipts.
- **Q5-unread-fifo**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "With `--json-file` a FIFO that nobody opened for reading".
- **Q6-resume-no-replay**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "did not replay any earlier `submit`, and appended to the event file.".
- **Q7-version-identity**: `tui-desktop`, required, runner OS `unspecified`. [# Qwen dual-output TUI verification, 2026-10-25](2026-10-25-qwen-dual-output-t0.md): "`qwen --version` under the isolated environment: 0.26.1.".

### Explicitly unverified follow-ups

- None separately identified.

## How an automation-opened PR gets checks

Token choice remains with the person. This audit enables neither route. Current [GitHub trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) describes approval-required runs for GITHUB_TOKEN-created opened/synchronize/reopened PR events; dispatch events remain an exception. This qualifies the issue's older no-trigger shorthand and does not establish unattended PR CI. This is documentation readback, not a live token experiment.

| Route | Benefit | Trade-off and integration work |
| --- | --- | --- |
| GITHUB_TOKEN plus explicit `check.yml` dispatch on `compat/<id>-<version>` | Avoids introducing a person-supplied App private key; dispatch can start the full check independently of PR-event approval | Publish job needs dispatch permission; capture and validate the run's exact head SHA. `check.yml` already accepts workflow_dispatch with normal inputs. Dispatch shares its existing check-main queue. It does not itself run the separate closing-refs or routing-receipt workflows; T2 must cover those gates or retain required approval. |
| Person-provided GitHub App installation token for branch/PR writes | Normal PR events can start all existing checks automatically | The person must provide a narrowly scoped installation and App credentials, with rotation/revocation ownership. Credentials belong only in the publish job, never the third-party package/harness job. Normal review and merge gates remain. |

The [workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) accepts a branch/tag ref and requires Actions write permission for fine-grained tokens. Run evidence must bind to the PR's actual head, rather than merely a branch name. [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow) documents creating an installation token from the App credentials.

Repository readback: `.github/workflows/check.yml` has workflow_dispatch, reads the dispatched SHA when there is no pull_request head, and uses check-main concurrency for ordinary dispatches. `.github/workflows/closing-refs.yml` and `.github/workflows/routing-receipt.yml` currently have only pull_request triggers. No workflow file changed here.

## Scope and handoff

T0 delivers data, provenance and a coverage test only. T1 still implements bounded isolated installation/probes and fail/not-run reporting; T2 still integrates the watcher, no-secret/read-only harness, artifact-only publisher and the person's chosen check-trigger mechanism. No token has been selected or provisioned, and no admission PR is auto-merged.
