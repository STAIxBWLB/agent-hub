# Pi 1.5.0 session-title API probe

Task #689, Refs #1055 (T1). Model-free native API receipt, macOS arm64, Node 24.18.1.

The installed `@earendil-works/pi-coding-agent@1.5.0` exposes a working native session-name setter and reader:

- Extension API: `setSessionName(name: string): void` and `getSessionName(): string | undefined`.
- Session: `AgentSession.setSessionName(name: string)` and the `sessionName` getter.
- Session manager: `appendSessionInfo(name: string)` and `getSessionName(): string | undefined`.

The [producer](pi-150-title-api.mjs) loads the real package's `DefaultResourceLoader`, `createAgentSession` and extension runner. It registers an account-free probe tool, invokes that callback directly after `bindExtensions`, and asserts the native API changes an initially unnamed session to `Fixture session title`. Both the extension reader and `SessionManager` return that name. After disposal, `SessionManager.open(sessionFile).getSessionName()` returns the same name. No prompt is submitted to an agent or provider.

The native setter appends a `session_info` entry. A handler registered through the real `ExtensionAPI.on("session_info_changed", handler)` receives the new name, also asserted by the producer. Pi delays creating a new session file until a user or assistant message exists. This probe appends a synthetic user fixture to the session manager before calling the setter; the fixture is never sent to a model. It proves native persistence for an existing conversation, not persistence of an empty session.

## Isolation and result

- Fresh HOME under `getconf DARWIN_USER_TEMP_DIR`, separate `PI_CODING_AGENT_DIR`, XDG config/data/cache and TMPDIR. The child environment contains only these paths, PATH and the explicit package path.
- Exact 1.5.0 package from the existing scratch npm prefix used by the [compatibility receipt](2026-11-03-pi-150-compat.md). The person's default launcher still selects 1.4.0; it was not invoked or changed.
- Frozen worktree dependencies installed before the probe: `@staix/agent-mem@0.20.1`, matching the exact manifest pin. Native package version independently asserted as 1.5.0.
- `sandbox-exec` uses `src/local/sandbox.ts`'s network-disabled profile, adds a real-home read/write deny, then grants only read access to the scratch native package and Node installation. Writable files are confined to the disposable HOME. No credentials or live hub connection.
- SHA-256 manifests of the 15 real `~/.pi` configuration/launcher entries were identical before and after. The manifest excludes sessions, logs, cache and install trees; it is not a claim to hash every installed package or historical session. Private per-file digests remain in the scratch evidence directory.
- Exit 0, empty stderr, setter/reader/reopen assertions PASS. An initial hand-written sandbox profile terminated Node before the producer ran; the final run used the repository profile and passed.

Reproduction: run `node docs/verification/pi-150-title-api.mjs` with `PI_TITLE_PACKAGE` pointing to the exact 1.5.0 package and fresh HOME/tool-home paths, inside the network-disabled sandbox described above. Do not run with the person's real HOME.

This permits the native-slot implementation for Pi. It does not prove a model-generated `hub_set_title` call, delivery through a live hub, or a live Pi restart. AC7 remains a separate live receipt in #1143.
