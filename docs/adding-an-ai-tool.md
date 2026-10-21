# Adding an AI Tool (Adapter Guide)

This guide documents how to add an AI coding agent or tool to **agent-hub** as an adapter. agent-hub treats every agent as a peer in a shared project directory, coordinating through messages, task board assignments, shared memory, and lifecycle gates.

Under **Adapter API 1** (issue #451), every tool is integrated as an `AdapterDefinition`. The core daemon, task board, and CLI interact only through this typed contract, without hard-coded vendor name comparisons.

---

## 1. Architecture & Principles

1. **One Definition per Kind**: Each tool is identified by a unique `kind` (e.g., `codex`, `kimi`, `agy`, `claude`, `jcode`, `pi`, `local`, `qwen`). Its capabilities, transport, launch argv, permission mappings, and recovery contracts are encapsulated in an `AdapterDefinition`.
2. **Core Independence**: Core daemon logic (`src/hub/daemon.ts`), task management (`src/hub/tasks.ts`), and routing (`src/hub/routing.ts`) inspect definition fields (such as `transport`, `identity`, `attach`, `budget`), never raw vendor names.
3. **Strict Conformance**: Every builtin adapter must run the conformance test kit (`test/conformance/`). Unsupported legs must provide explicit, documented reasons rather than silent test skips. (External adapter enrollment lands with A4.)
4. **Trust & Security Boundaries**:
   - **On-prem vs. Cloud**: `trust.onPrem` controls whether private/PII tasks may be routed to the agent. A cloud agent (`trust.onPrem: false`) never receives PII task text or memory entries.
   - **Path Protection**: Any workspace configuration directory owned by the agent (e.g., `.agents/`, `.codex/`) must be listed in `AGENT_CONFIG_SEGMENTS` (`src/hub/permission-mode.ts`) so agents cannot self-modify their own hooks or plugins.
   - **Process Isolation**: Spawns must run in their own process groups and are stopped as a whole group by the hub.

---

## 2. Choosing a Transport

agent-hub supports five transport architectures (`transport` in `AdapterDefinition`):

| Transport | Description | Best Suited For | Examples |
| :--- | :--- | :--- | :--- |
| **`acp`** | Agent Client Protocol over stdio JSON-RPC | Agents implementing the standard ACP specification | Kimi, Qwen |
| **`codex-appserver`** | Bidirectional JSON-RPC with proxy intercept and thread tracking | Tools with structured thread resume and proxy-injectable RPC | Codex |
| **`claude-channel`** | MCP plugin running inside the host agent with WebSocket control link | Agents with native plugin systems that push notifications | Claude Code |
| **`ws-pull`** | Workspace MCP plugin connecting to daemon WebSocket; pull-only message inbox | Agents with local plugin discovery and interactive TUIs | Google Antigravity (`agy`) |
| **`hub-native`** | Direct in-process or local sandbox execution | Custom on-prem models, sandboxed local worker, or Pi RPC bridge | `local`, `pi` |

### Generic ACP vs. Dedicated Adapter

* **Generic ACP (Config-only, Planned)**: Planned support (#451 A3, board task #217) will allow tools speaking standard ACP (stdio JSON-RPC) to be configured without core TypeScript changes.
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
* `grants`: Record mapping `PermissionMode` to native argument/mode string.
* `unmanaged`: String explanation if native permissions are unmanaged by the hub.
* `unmanagedForms`: Start forms where permissions remain unmanaged (e.g. `["tui"]`).

#### `session`
Controls session restoration, thread continuity, and crash recovery:
* `idField`: `"sessionId"` or `"threadId"`.
* `currentId(peer)`: Extracts the active session or thread ID from a running adapter.
* `resumeArgv(binding, fresh)`: Builds CLI arguments to resume a persisted session.
* `transcriptPath(binding)`: Resolves local transcript file path for audit/usage tracking.

#### `budget`
Defines quota and context window consumption readers:
* `account`: Account identifier for quota grouping.
* `reader`: `QuotaReader` extracting usage windows from native status outputs.
* `context`: `ContextReader` measuring token occupancy against window limits.

---

## 4. Planned: Config-Only Generic ACP Adapters (#451 A3)

Support for defining ACP-based tools purely via local project configuration (`.agenthub/config.local.json`) is in progress as board task #217 (GitHub issue #486 for its Grok receipt). The configuration schema, command invocation, and permission mode mappings will land with that milestone.

---

## 5. Planned: External Adapter Modules (#451 A4)

Support for loading adapter definitions from external modules outside the core repository is planned as board task #135. As decided in issue #451 (P3), external modules will be governed by strict trust rules:

* **Machine-Local Only**: Loaded exclusively from local files specified in local configuration; never from repository tracking or network URLs.
* **Content-Hash Pinning**: Explicit SHA-256 hash pinning to prevent unauthorized tampering.
* **Person Authority**: Enabling external modules requires explicit human authorization.
* **Conformance Requirement**: External modules must pass the conformance kit before admission.

---

## 6. The Conformance Kit

The conformance kit (`test/conformance/`) validates that an adapter satisfies hub invariants:

```bash
# Run the complete conformance suite
bun test test/conformance

# Run conformance for a specific kind
bun test test/conformance/acp.test.ts
bun test test/conformance/agy.test.ts
```

### Invariants Verified by the Kit:
1. **Enrollment & Coherence (`enrollment.test.ts`)**: Every definition in `ADAPTERS` and reviewer variant must be enrolled. A kind without kit coverage needs a reason in `UNSUPPORTED` (`test/conformance/enrollment.ts`), and an ACP kind that skips one of the shared `ACP_LEGS` needs a reason per leg in `UNSUPPORTED_LEGS`.
2. **Delivery Occupancy**: Sending messages updates driven peer state to `busy` synchronously, delivering digests reliably.
3. **Recovery Metadata Hygiene**: No prompt text or credentials leaked into `recoveryMetadata`.
4. **Watchdog Cancellation & Generation Fencing**: Expiry of the turn watchdog cancels prompts cleanly and generation fences prevent stale late answers from publishing.
5. **Teardown & Cleanup**: When an adapter is stopped (`peer.stop()`), all owned child processes in the process group stop with it (the peer reaches offline).

---

## 7. Review & Verification Checklist

When adding or updating an adapter, verify each item before opening a PR:

- [ ] **T0 Receipt Recorded**: Document native CLI version, observed hook payloads, and protocol outputs in `docs/verification/YYYY-MM-DD-<kind>-t0.md`.
- [ ] **Registered in ADAPTERS**: Added to `src/adapters/registry.ts` with explicit `displayName`, `family`, `transport`, and `trust`.
- [ ] **Config Path Protection**: Agent configuration directories added to `AGENT_CONFIG_SEGMENTS` in `src/hub/permission-mode.ts`.
- [ ] **PII Safety Verified**: Cloud models have `trust.onPrem: false`; verify PII markers refuse routing to this peer.
- [ ] **Process Group Teardown**: Daemon-spawned processes use process groups and exit cleanly on stop.
- [ ] **Conformance Kit Passes**: `bun test test/conformance` passes with zero regressions and no silent skips.
- [ ] **Documentation Freshness**: Run `node scripts/check-docs.mjs` and update verified stamps in `docs/verified.json`.
