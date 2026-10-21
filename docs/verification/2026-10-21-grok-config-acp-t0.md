# Grok config-only ACP T0, 2026-10-21

This receipt separates the generic ACP implementation from native Grok readiness. It does not establish #486 AC1-AC6 or #451 AC3 as complete.

## Observed native build and isolation

- Local native binary reports `grok 1.0.62 (1474f9cbdd91)`.
- Version, agent help and stdio help exited 0 under a temporary HOME, Grok home, XDG config/cache/data directories and project directory outside a Git repository.
- The protocol probe used `grok agent --no-leader stdio`, with inherited agent markers removed and a probe-specific peer identity. The probe harness copied no personal config or credential files and wrote only to its isolated directories; no production hub was used. The exact native-file check below is bounded, and broader native credential state remains unverified.
- The saved agent help states that the leader default is `[cli] use_leader` in `config.toml`, rather than a guaranteed foreground default; `--no-leader` forces a new agent. A plain `grok agent stdio` argv therefore does not itself establish foreground ownership in an ambient home. `--leader-socket` is also an attach selector. The config compiler therefore requires explicit standalone `--no-leader` for recognized Grok declarations before any process starts, and still refuses `--leader` and `--leader-socket`; isolated HOME alone is not substituted for the opt-out.
- Before/after SHA-256 values of the exact real Grok `config.toml` and `version.json` matched. The additionally checked `config.json`, `settings.json` and `mcp.json` were absent before and after. This bounded check is not a claim about every native configuration path.

## Protocol result

- Initialize replied and advertised `loadSession: true`, image/audio prompt support false, embedded context true, HTTP/SSE MCP support and session list/resume/close capabilities.
- Initialize did not provide `agentInfo`. The config-only adapter requires the observed native name/version pin to match initialize before creating a session or prompting. The native build therefore has no usable runtime identity pin under this contract.
- The separate raw protocol probe attempted `session/new` in the isolated project with an empty MCP server list. It received an RPC error. Its raw error payload was neither logged nor published; the cause remains unclassified.
- No model prompt or native MCP tool ran. Session/load echo, session/set_mode, usage/occupancy and a real hub-tool result are unverified. Advertising load or MCP support is not proof of those operations.
- Because no prompt ran, no process-tree and socket/IPC observation while a prompt was active exists. The required no-detached-leader evidence is unverified.

## Owned group and teardown

- The runtime ownership helper positively verified the direct child, its original process group and shared process signature at start and immediately before teardown.
- The first probe's teardown returned `unconfirmed`. A fresh process-table read after the probe exited showed no Grok process. This is not recorded as a confirmed stop receipt.
- A post-SIGKILL defunct-row observation edge was fixed and covered by deterministic regression tests: after the last signal, wait for the original group to disappear within the bound, tolerating command/parent changes of a dying row while preserving PID/start/group identity. Pre-signal ownership checks remain strict, and no process outside the spawned group is signalled.
- A second isolated probe with the same native build again lacked initialize identity and had session/new refused. With the corrected observation fence, start and pre-stop group checks passed, group disappearance was confirmed, and a separate fresh process-table read found no Grok process. The exact real-config hashes again matched. This confirms teardown for this refused attempt, not foreground behavior during a model prompt.

## Readiness decision

Grok remains unsupported by this receipt. The generic config-only ACP path is covered independently with the repository's fake ACP transport, including identity mismatch, load-echo refusal, owned-group checks, permission ACKs, read-only ceilings, task delivery and project isolation. Native Grok admission still needs a build with matching initialize identity plus successful isolated session creation, actual hub-tool execution, load-echo evidence and foreground tree/IPC proof during a prompt. No permission, quota, sandbox, planner or reviewer claim is inferred from these observations.
