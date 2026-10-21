# Adding an AI Tool (Adapter Guide)

This guide documents how to add an AI coding agent or tool to **agent-hub** as an adapter. agent-hub treats every agent as a peer in a shared project directory, coordinating through messages, task board assignments, shared memory, and lifecycle gates.

Under **Adapter API 1** (issue #451), every tool is integrated as an `AdapterDefinition`. The core daemon, task board, and CLI interact only through this typed contract, without hard-coded vendor name comparisons.

---

## 1. Architecture & Principles

1. **One Definition per Kind**: Each tool is identified by a unique `kind` (e.g., `codex`, `kimi`, `agy`, `claude`, `jcode`, `pi`, `local`, `qwen`). Its capabilities, transport, launch argv, permission mappings, and recovery contracts are encapsulated in an `AdapterDefinition`.
2. **Core Independence**: Core daemon logic (`src/hub/daemon.ts`), task management (`src/hub/tasks.ts`), and routing (`src/hub/routing.ts`) inspect definition fields (such as `transport`, `identity`, `attach`, `budget`), never raw vendor names.
3. **Strict Conformance**: Every builtin and external adapter must run the conformance test kit (`test/conformance/`). Unsupported legs must provide explicit, documented reasons rather than silent test skips.
4. **Trust & Security Boundaries**:
   - **On-prem vs. Cloud**: `trust.onPrem` controls whether private/PII tasks may be routed to the agent. A cloud agent (`trust.onPrem: false`) never receives PII task text or memory entries.
   - **Path Protection**: Any workspace configuration directory owned by the agent (e.g., `.agents/`, `.codex/`) must be listed in `AGENT_CONFIG_SEGMENTS` (`src/hub/permission-mode.ts`) so agents cannot self-modify their own hooks or plugins.
   - **Process Isolation**: Spawns must run in their own process groups and obey the hub's stop timeout (`stopGraceMs`).

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

* **Generic ACP (Config-only)**: If your tool speaks standard ACP (stdio JSON-RPC), you do not need to write TypeScript code in agent-hub. You can define an ACP adapter purely through configuration in `.agenthub/config.local.json` (see Section 4).
* **Dedicated Adapter**: Required when your tool has unique hook protocols (e.g. Antigravity protojson hooks), custom proxy requirements (e.g. Codex thread adoption), or native extension bridges (e.g. Pi).

---

## 3. AdapterDefinition Fields Reference

An adapter exports an object conforming to `AdapterDefinition` (`src/adapters/registry-types.ts`):

```typescript
export interface AdapterDefinition {
  api: 1;
  kind: string;                     // e.g. "agy", "kimi", "codex"
  displayName: string;              // Human-readable title
  family: string;                   // Family grouping (e.g. "kimi", "agy")
  transport: "acp" | "codex-appserver" | "claude-channel" | "ws-pull" | "hub-native";
  roles: readonly string[];          // Default roles: "implementer", "verifier", etc.
  optional?: boolean;               // true if optional peer (OPTIONAL_PEERS)
  defaultOnRoster?: boolean;        // Default roster membership
  trust: {
    onPrem: boolean;                // true = on-premises/local, safe for PII
    hubSandboxed: boolean;          // true = executed under hub seatbelt sandbox
  };
  start: AdapterStartDefinition;
  identity: {
    mcp: "acp-session" | "project-file" | "env" | "channel-plugin";
  };
  instances?: {
    mode: "external" | "headless";
    roles?: readonly string[];
  };
  attach?: AdapterAttachDefinition;
  permission: AdapterPermissionDefinition;
  session: AdapterSessionDefinition;
  turnEnd: "adapter" | "native-hook";
  budget?: AdapterBudgetDefinition;
  cli: AdapterCliDefinition;
  display: {
    palette: { fg: string; bg: string; tone?: string; ansi?: string };
  };
  hooks?: Partial<NativeHooks>;
  reviewerVariant?: AdapterDefinition;
}
```

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

## 4. Config-Only Generic ACP Adapters

For agents implementing the ACP stdio protocol, support can be added with **zero TypeScript code** via `.agenthub/config.local.json`:

```json
{
  "adapters": {
    "mytool": {
      "command": ["mytool-cli", "--acp"],
      "displayName": "MyTool Agent",
      "roles": ["implementer", "verifier"],
      "trust": {
        "onPrem": false,
        "hubSandboxed": false
      },
      "acp": {
        "modes": {
          "ask": "standard",
          "ask-when-needed": "accept-edits",
          "never-ask": "bypass"
        }
      }
    }
  }
}
```

When registered:
1. The daemon spawns the process with stdin/stdout wired to the generic ACP engine (`src/adapters/acp.ts`).
2. Hub MCP tools are injected via `session/new` `mcpServers`.
3. Tool calls pass through the hub's permission gate.

---

## 5. External Modules & Trust Rules

External adapter definitions can be loaded from outside the core repository under strict trust rules:

1. **Machine-Local Only**: External definitions are loaded from local files designated in local project configuration (`.agenthub/config.local.json`). They are never loaded from tracked git repository files or network URLs.
2. **Content-Hash Pinning**: The local configuration must specify the SHA-256 hash of the external adapter bundle. If the file content does not match the hash, loading is refused.
3. **Person Authority Gate**: Enabling an external adapter requires explicit human execution via the CLI or human console.
4. **Conformance Enforcement**: External modules must pass the conformance kit before being admitted to the live hub roster.

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
1. **Enrollment (`enrollment.test.ts`)**: Every definition in `ADAPTERS` must be enrolled. Unsupported features (e.g. headless execution for TUI-only peers) must have an explicit reason in `UNSUPPORTED_LEGS`.
2. **Delivery & Occupancy**: Sending messages updates peer state to `busy` synchronously, delivering digests reliably.
3. **Watchdog Cancellation**: Expiry of the turn watchdog cancels prompts cleanly without leaking orphan background processes.
4. **Teardown & Cleanup**: When an adapter is stopped (`peer.stop()`), all owned child processes in the process group terminate within `stopGraceMs`.
5. **Session Recovery**: Session resume metadata and transcripts match the declared `session` contracts.

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
