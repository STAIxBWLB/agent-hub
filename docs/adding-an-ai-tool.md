# Adding an AI Tool (Adapter Guide)

This guide documents how to add an AI coding agent or tool to **agent-hub** as an adapter. agent-hub treats every agent as a peer in a shared project directory, coordinating through messages, task board assignments, shared memory, and lifecycle gates.

Under **Adapter API 1** (issue #451), every tool is integrated as an `AdapterDefinition`. The core daemon, task board, and CLI interact only through this typed contract, without hard-coded vendor name comparisons.

---

## 1. Architecture & Principles

1. **One Definition per Kind**: Each tool is identified by a unique `kind` (e.g., `codex`, `kimi`, `agy`, `claude`, `jcode`, `pi`, `local`, `qwen`). Its capabilities, transport, launch argv, permission mappings, and recovery contracts are encapsulated in an `AdapterDefinition`.
2. **Core Independence**: Core daemon logic (`src/hub/daemon.ts`), task management (`src/hub/tasks.ts`), and routing (`src/hub/routing.ts`) inspect definition fields (such as `transport`, `identity`, `attach`, `budget`), never raw vendor names.
3. **Strict Conformance**: Every builtin adapter must run the conformance test kit (`test/conformance/`). Unsupported legs must provide explicit, documented reasons rather than silent test skips. (A4 exports the same callable contracts for external package CI.)
4. **Trust & Security Boundaries**:
   - **On-prem vs. Cloud**: `trust.onPrem` controls whether private/PII tasks may be routed to the agent. A cloud agent (`trust.onPrem: false`) never receives PII task text or memory entries.
   - **Path Protection**: Any workspace configuration directory owned by the agent (e.g., `.agents/`, `.codex/`) must be listed in `AGENT_CONFIG_SEGMENTS` (`src/hub/permission-mode.ts`) so agents cannot self-modify their own hooks or plugins.
   - **Process Isolation**: Spawns must run in their own process groups and are stopped as a whole group by the hub.

---

## 2. Choosing a Transport

agent-hub supports five transport architectures (`transport` in `AdapterDefinition`):

| Transport | Description | Best Suited For | Examples |
| :--- | :--- | :--- | :--- |
| **`acp`** | Agent Client Protocol over stdio JSON-RPC | Agents implementing the standard ACP specification | Kimi, Qwen, Jcode |
| **`codex-appserver`** | Bidirectional JSON-RPC with proxy intercept and thread tracking | Tools with structured thread resume and proxy-injectable RPC | Codex |
| **`claude-channel`** | MCP plugin running inside the host agent with WebSocket control link | Agents with native plugin systems that push notifications | Claude Code |
| **`ws-pull`** | Workspace MCP plugin connecting to daemon WebSocket; pull-only message inbox | Agents with local plugin discovery and interactive TUIs | Google Antigravity (`agy`) |
| **`hub-native`** | Direct in-process or local sandbox execution | Custom on-prem models, sandboxed local worker, or Pi RPC bridge | `local`, `pi` |

### Generic ACP vs. Dedicated Adapter

* **Generic ACP (Config-only)**: A3 supports project-local standard ACP (stdio JSON-RPC) definitions without extending the builtin registry. Native support still requires a verified foreground contract and isolated T0 receipt.
* **Dedicated Adapter**: Current builtin mechanism where each tool exports an `AdapterDefinition` under `src/adapters/` with its transport, hooks, and launch plans.

---

## 3. AdapterDefinition Fields Reference

An adapter exports an object conforming to `AdapterDefinition` in `src/adapters/registry-types.ts`. Read that type as the source of truth: most blocks are declared inline there, so there are no separate `Adapter*Definition` types to import, and some members are required. Its top-level fields are:

- Required: `api` (always `1`), `kind`, `displayName`, `family`, `transport`, `roles`, `trust` (`onPrem`, `hubSandboxed`), `start`, `identity` (`mcp`), `permission`, `session`, `turnEnd`, `cli`, `display`.
- Optional: `optional`, `defaultOnRoster`, `enabledSwitchStartOnly`, `instances`, `attach`, `reporting`, `routing`, `budget`, `configuration`, `capabilities`, `hooks`, `reviewerVariant`, `reviewer`.
- Registry load runs `assertDefinitionCoherence` (`src/adapters/registry.ts`) on every definition and reviewer variant, so an incoherent combination fails at load, not at run time.

### Key Sub-Objects

#### `start`
Defines how the agent process is started and commanded:
* `forms`: `["tui"]`, `["headless"]`, or `["tui", "headless"]`.
* `defaultForm`: The default startup mode.
* `launch(ctx)`: Generates the `LaunchPlan` (command, argv, environment variables, launch metadata).
* `create(ctx)`: Factory constructing the `PeerAdapter` instance for driven daemon peers.
* `conductorStartable`: Boolean indicating if `ahub up` or conductor can spawn this peer automatically.
* `ownedFlags`: CLI flags owned by this tool's launcher.

#### `identity`
Defines how the hub MCP server identity reaches the tool:
* `"acp-session"`: Sent in `session/new` `mcpServers` parameter.
* `"project-file"`: Written into workspace plugin or config files (e.g. `.agents/plugins/agent-hub/mcp_config.json`).
* `"channel-plugin"`: Provided by an installed MCP bundle.
* `"env"`: Passed via environment variables.

#### `permission`
Maps hub permission modes (`ask`, `ask-when-needed`, `never-ask`) to native flags or ACP mode IDs:
* `grants`: the text that says what each hub mode does for this kind (`ahub permission` and the settings preview show it). It is a description, not the native flag: the native mode id or policy is applied by the adapter (an ACP mode id, Codex's `approvalPolicy`).
* `genericAcp`: for a configured ACP kind, the validated `modes` (hub mode to ACP mode id) and `readOnly` id that the runtime and the instance ceiling both read.
* `unmanaged`, `unmanagedNote`, `unmanagedStatusNote`: why the hub cannot manage native permissions, when it cannot.
* `unmanagedForms`: start forms where permissions remain unmanaged (e.g. `["tui"]`).
* `trackUnattended`: the daemon records whether a start was `--unattended` and refuses a second start with a different setting while one is in progress (Codex).

#### `session`
Controls session restoration, thread continuity, and crash recovery:
* `idField`: `"sessionId"` or `"threadId"`.
* `currentId(peer)`: Extracts the active session or thread ID from a running adapter.
* `resumeArgv(binding, fresh)`: Builds CLI arguments to resume a persisted session.
* `transcriptPath(binding)`: Resolves local transcript file path for audit/usage tracking.

#### `projection`
Where the kind sits in the host's derived lists: `roleRank`, `startRank`, `helpRank` and `plannerEligible`. `KNOWN_PEERS`, `OPTIONAL_PEERS`, `START_MODE_PEERS`, `ROLE_ORDER`, `HELP_ORDER` and `PLANNER_PEERS` are derived from `ADAPTERS` and these ranks (`deriveAdapterLists`). The only hand-kept lists are the cross-release copies in `src/hub/peer-catalog.ts` (`KNOWN_PEERS`, `OPTIONAL_PEERS`) and `src/hub/start-mode.ts` (`START_MODE_PEERS`, for a dual-form kind): a new native kind is added there too, and `test/registry-guard.test.ts` fails until those copies equal the derived lists. A configured or external definition cannot set `projection`.

#### `cli`
The `ahub <kind>` surface: `command`, `startWords(form)`, and for a fixed builtin `entry` (the launcher and whether it needs lifecycle admission), `preview`, `usage` (help lines) and `launchConfigKeys`. `builtinCliEntries(definitions)` projects the entries; no configuration or module can register one.

#### `instances` and `attach`
`instances.mode` is `headless` (needs a headless `start.create` factory) or `external` (a channel instance started from the person's terminal). A kind with no `instances` policy (Jcode) takes no extra instance, and `validateInstances` refuses a declaration of one. `attach` holds the pull-only forms, external-hello admission and the refusal texts for a TUI that attaches without a driven peer.

#### Peer capability members
The runtime peer (`PeerAdapter`, `src/hub/peers.ts`) exposes optional members that the daemon reads instead of checking its class (#625 phase 6): `sessionGeneration` (native session identity: absent keeps the owner-token fallback, present but undefined is unknown and refuses bounded checks), `checkpointUsesSessionGeneration` (opt out of generation-fenced checkpoints, as Pi does), `permissionModeState` (the effective native approval state, or `unknown` / `unmanaged`) and `setPermissionMode(mode)` (resolves only after the native side acknowledges). Native safety proofs (Codex proxy and restoration, Claude launch generation) stay in the daemon.

#### `budget`
Defines quota and context window consumption readers:
* `account`: Account identifier for quota grouping.
* `reader`: `QuotaReader` extracting usage windows from native status outputs.
* `context`: `ContextReader` measuring token occupancy against window limits.

---

## 4. Config-Only Generic ACP Adapters (#451 A3)

Declare `adapters.<kind>` only in a Git-confirmed untracked `.agenthub/config.local.json`. The declaration is wholly machine-local authority and cannot override builtin kinds or select executable modules. Its `transport` is `acp`; it names a command, optional argv, display name and default roles, with optional native identity, permission-mode mappings and read-only mode. Adapter defaults cannot appoint the conductor. A project captures its catalog at startup, so declaration changes require restart.

Configured kinds are headless and off roster by default. Before a start can succeed, the native initialize name/version must match the configured pin and the spawned process group must be positively owned. Resume also requires an exact session/load echo. Missing native permission mappings mean unmanaged policy; missing usage/context sources remain exempt/unknown. Titles do not auto-approve tools, and read-only mode requires both native acknowledgement and host mutation fences.

Grok declarations require explicit `--no-leader`, since native defaults can inherit ambient `[cli] use_leader`. Grok 1.0.62 remains unsupported: its isolated probe lacked initialize identity and refused session creation. The [T0 receipt](verification/2026-10-21-grok-config-acp-t0.md) records the remaining evidence. The full A3 schema and proof boundary are in the [spec amendment](specs/2026-09-19-agent-hub-design.md#amendment-config-only-acp-adapters-a3-451-486).

---

## 5. External Adapter Modules (#451 A4)

A person can authorize a bundled adapter in an untracked
`.agenthub/config.local.json`:

```json
{
  "adapter_modules": [
    { "path": ".agenthub/adapters/my-tool.mjs", "sha256": "<64 hex digits from the exact bundle>" }
  ]
}
```

The daemon imports the module at startup. Settings, reload, previews and ordinary
CLI reads never import it. A changed declaration requires restart; it cannot be
written through a hub tool or Settings. The CLI sees only the running daemon's
bounded kind and display name. Tracked/shared/cloned configuration cannot enable
code. A wrong hash, API mismatch, builtin collision, symlink component, path
outside the project, nonregular/world-writable file, oversized file or unsupported
module construct refuses loading without exposing source text in the error.

Publish a single self-contained ESM JavaScript bundle. Bundle third-party
implementation into that file; do not add runtime dependencies to the hub.
Runtime imports may use Node/Bun builtins except `bun:ffi` and `bun:test`, plus
`@staix/agent-hub/adapter`, bound to the running daemon's own SDK rather than
project packages. `/conformance` is available to module CI, not runtime modules.
Relative or other package imports, dynamic imports, require (including
`import.meta.require`), eval and Function-based loading
are refused. The scanner also refuses any `require`, `eval` or `Function` word token, including non-loading uses such as `o.require` or `instanceof Function`. String literal contents are not word tokens. The scan is conservative, not a sandbox. Authorized module code runs
with daemon privileges; inspect the full bundle before recording its hash. Each import must settle within two seconds or that module is refused while startup continues. This deadline stops waiting; it does not cancel module code or undo its side effects.
Dependencies must be ESM-only. The loader verifies the captured original bytes,
rewrites only scanned SDK imports to host-owned file URLs, and imports that result
rather than reopening a mutable source path after the hash check. A refused
module appears in bounded status diagnostics while other adapters keep working.
Its roster row stays inert; CLI config reads also retain inert unknown rows when
trusted module declarations exist but daemon metadata is unavailable.

The module exports `definition` with `api: ADAPTER_API`. Import the version,
`AcpPeer`, `BasePeer` and definition/context types from
`@staix/agent-hub/adapter`. The initial executable subset uses a headless ACP
factory, its own kind/family, `optional: true`, `defaultOnRoster: false` and
`trust: { onPrem: false, hubSandboxed: false }`. Preserve the host's factory
options and instance id when constructing the transport. Supply a launch plan,
start/identity/session/CLI/display metadata and only supported native mode
mappings; no mapping means unmanaged. By default the host disables native
hub-tool title auto-approval for external kinds. A cooperating module must preserve
that factory option; approved module code runs with daemon privileges, so this is
a host default rather than isolation from a module that overrides its options. The loader refuses fixed-builtin capabilities and unsupported
fields rather than silently ignoring them. See `validateExternalDefinition` for
the exact accepted subset.

External kind instances are explicitly unsupported in A4. Follow-up board task
#287 owns execution roots, CLI identity and recovery for them. Broadening the
module transport beyond the existing headless ACP host port also needs a reviewed
host contract (#625 phase 6); selecting a different native engine is not a generic extension.

For example, bundle an ESM definition with its dependencies and record its digest:

```bash
bun build ./adapter.ts --target bun --format esm --external @staix/agent-hub/adapter --outfile .agenthub/adapters/my-tool.mjs
shasum -a 256 .agenthub/adapters/my-tool.mjs
```

Enable its roster row only after loading it and exercising the applicable
conformance contracts. Source and target recovery runtimes must advertise
`external_adapter_modules`; old runtimes cannot preserve the verified catalog.

---

## 6. The Conformance Kit

The exported Bun kit (`@staix/agent-hub/conformance`) supplies callable transport
registrations, `createFromDefinition`, `registerConformance`, explicit unsupported
leg validation and immutable `fakePaths`. Importing it starts no fake transport;
call a registration in your own Bun test file. The hub's `test/conformance/`
wrappers run the same implementation against every applicable builtin.

An external adapter test imports its definition and calls
`registerConformance` with its real factory and a fake transport fixture. ACP
adapters also call `registerAcpConformance({ definition, ... })`; unsupported native
approval, mode or quota legs require concrete reasons, never silent skips. Other
exports cover Codex, owned ACP, Pi, local and external-channel fixture contracts.
Those exports do not grant an external runtime access to a builtin-only engine.
The shipped fake assets live under `src/adapters/conformance/fakes`, so package CI needs
no development-tree files. Native account/TUI probes remain separate from these
synthetic protocol contracts.

The kit validates that an adapter satisfies hub invariants:

```bash
# Run the complete conformance suite
bun test test/conformance

# Run conformance for a specific kind
bun test test/conformance/acp.test.ts
bun test test/conformance/agy.test.ts
```

### Invariants Verified by the Kit:
1. **Enrollment & Coherence (`enrollment.test.ts`)**: Every definition in `ADAPTERS` and reviewer variant must be enrolled. A kind without kit coverage needs a reason in `UNSUPPORTED` (`test/conformance/enrollment.ts`), and an ACP kind that skips one of the shared `ACP_LEGS` needs a reason per leg in `UNSUPPORTED_LEGS`.
2. **Delivery Occupancy**: Sending messages updates driven peer state to `busy` synchronously, delivering digests reliably. A channel peer whose native hooks own occupancy (Claude) stays idle on insertion by design.
3. **Recovery Metadata Hygiene**: No prompt text or credentials leaked into `recoveryMetadata`.
4. **Watchdog Cancellation & Generation Fencing**: Expiry of the turn watchdog cancels prompts cleanly and generation fences prevent stale late answers from publishing.
5. **Teardown & Cleanup**: When an adapter is stopped (`peer.stop()`), all owned child processes in the process group stop with it (the peer reaches offline).

---

## 7. Review & Verification Checklist

When adding or updating an adapter, verify each item before opening a PR:

- [ ] **T0 Receipt Recorded**: Document native CLI version, observed hook payloads, and protocol outputs in `docs/verification/YYYY-MM-DD-<kind>-t0.md`.
- [ ] **Registered in ADAPTERS**: the definition is declared under `src/adapters/definitions/` (or its own directory) with explicit `displayName`, `family`, `transport`, `trust` and `projection`, and listed in `ADAPTERS` (`src/adapters/registry.ts`). The peer lists are derived from it. The hand-kept cross-release copies in `src/hub/peer-catalog.ts` and `src/hub/start-mode.ts` and the pinned tests listed in `docs/agent-notes/adapters.md` change with it, and the PR names them as expected test changes.
- [ ] **Config Path Protection**: Agent configuration directories added to `AGENT_CONFIG_SEGMENTS` in `src/hub/permission-mode.ts`.
- [ ] **PII Safety Verified**: Cloud models have `trust.onPrem: false`; verify PII markers refuse routing to this peer.
- [ ] **Process Group Teardown**: Daemon-spawned processes use process groups and exit cleanly on stop.
- [ ] **Conformance Kit Passes**: `bun test test/conformance` passes with zero regressions and no silent skips.
- [ ] **Documentation Freshness**: Run `node scripts/check-docs.mjs` and update verified stamps in `docs/verified.json`.
