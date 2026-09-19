# agent-hub

Bun + TypeScript daemon that lets Claude Code, Codex, Kimi Code (and later a local-LLM worker) exchange messages as peers in one project directory. It is a message bus with native adapters, not a fork of agent-bridge and not a memory store. Spec and milestone status: `docs/specs/2026-09-19-agent-hub-design.md` (mirrored in issue #1).

## Commands

- Install: `bun install`
- Test: `bun test` (one file: `bun test test/bus.test.ts`)
- Typecheck: `bun x tsc --noEmit`
- Rebuild the plugin bundle after touching `src/adapters/claude-channel.ts` or anything it imports: `bun run build`
- Run from source: `bun src/cli/main.ts <command>` (`hub` once linked with `bun link`)

## Verifying your work

Run this before reporting any task complete, and paste the output. A failing test is fixed in the code, never by editing the test.

- `scripts/check.sh` (healthy output ends with `check: OK`; it runs typecheck, the bundle freshness check and all tests)
- Live legs that need real accounts are manual: `docs/smoke.md`, plus `bun scripts/smoke-acp.ts` and `bun scripts/smoke-codex.ts`.

## Conventions

- Zero runtime dependencies. WebSocket, HTTP, sqlite, spawn and the test runner are Bun built-ins; the MCP SDK is a devDependency bundled into `plugins/agent-hub/server.js`.
- TS strict with `noUncheckedIndexedAccess`; relative imports carry the `.ts` extension.
- Conventional commits in English, referencing the issue. Branch + PR, never commit to main.
- Spec first: when the implementation has to differ from the spec, amend the spec in the same PR.
- Deliberate shortcuts carry a `ponytail:` comment naming the ceiling and the upgrade path.

## Architecture

- `src/hub/`: envelope, markers and digest rendering, bus (fan-out, hop cap, dedupe, one queue per peer delivered as a digest when ready, steer, cap, pause, preface), `BasePeer` state machine with the inactivity watchdog, daemon (control WS, state dir), control client, port registry.
- `src/adapters/`: one file per native surface. `claude-channel.ts` runs inside Claude Code as the plugin's MCP server and talks to the daemon over the control WS; `codex-appserver.ts` and `acp.ts` run inside the daemon.
- `src/adapters/local-worker.ts` + `src/local/` (tools, path guard, seatbelt runner): the hub-native peer. `src/omniroute/`: the only place that reads the gateway key and Access headers. `src/switchyard/`: config generator and session-scoped sidecar. `src/hub/routing.ts`: `routing.toml`.
- `src/memory/`: claude-mem worker client, session-start recall, and capture for the local worker. Fail-open everywhere; the hub never owns a memory database.
- `src/cli/`: `main.ts` (commands), `launch.ts` (hub-owned flags), `init.ts` (marker blocks).
- `plugins/agent-hub/`: plugin manifest, `.mcp.json` and the committed bundle. `templates/`: what `hub init` writes.
- `test/fakes/`: fake ACP agent, fake Codex app-server, fake claude-mem worker. No mocking library.

## Things the agent gets wrong

- Codex: the adapter never sends its own `initialize`. It is a proxy; hub requests use negative ids and their responses must not reach the TUI.
- Codex 0.154.0 `agentMessage` items carry `text` and `phase` (not `content[]`); only the last non-`commentary` message of a turn is shared.
- Tests that are not about batching build the bus with `batchMs: 0`; with the default 15 s window a lone status envelope looks like a lost message.
- A failed digest is retried one envelope at a time, so a poison envelope cannot take its neighbours down with it.
- An `important` envelope being steered is not in the queue while the steer is in flight; queue it first and an idle transition delivers it twice.
- The plugin bundle is installed apart from the daemon. Any change to a control WS message shape bumps `PROTOCOL` in `control-client.ts`.
- `replyParent()` decides what a reply answers (highest hop, never the `hub` preface). Use it for deliveries and steers alike, or the hop cap can be reset.
- Nothing the local worker executes may run outside `sandboxedExec`; a new tool that spawns a process goes through it, and a tool that touches a path goes through `guardPath`.
- The sandbox denies home reads by default (toolchain dirs, the project and its real git dir excepted) and all network, loopback included: claude-mem and the Codex app-server listen on loopback without auth. Tests that bind a local port therefore fail when the worker runs them; that is the intended trade-off, `local.bash_network` is the switch.
- One denylist, `src/local/deny.ts`: the path guard, the seatbelt profile and the memory filter all read it. Seatbelt sees absolute paths, so `local.deny` entries are anchored under the project root (a bare `private/` once denied all of `/private/var`).
- `guardPath` walks with `lstat`: `existsSync` follows symlinks, so a dangling link looked like a new file and the write landed at its target.
- git arguments never pass through `guardPath`; `gitArgsProblem` refuses absolute paths, `..`, `--no-index` and denylisted `rev:path` forms.
- A worker turn builds its messages in a local array and joins the history only as a whole. Never push to `history` mid-turn: one tool call without its result poisons every later request.
- After a tool with side effects ran, a failed turn is reported, never redelivered.
- Approval titles are agent-written text shown to a person: the daemon escapes control characters, and write/edit/bash show what will be written or run.
- Secrets stay inside `OmniRoute`: never put the key or Access values in a log line, an error message, a return value or the generated Switchyard file (the key goes by env var name).
- Switchyard's docs drift from the released binary. Any change to `switchyardToml` is checked with the real `switchyard-server --dry-run`, not only the stand-in in `test/fakes/`.
- A child process gets a scrubbed environment, so test knobs for fakes travel in a wrapper script, not in `process.env`.
- Work that must survive `hub kill` (claude-mem `session-end`) is awaited in `stop()`; fire-and-forget dies with the process.
- A peer must set `busy` synchronously inside `deliver()`, otherwise the bus drains the next envelope into a running turn (Kimi answers `turn.agent_busy`).
- A watchdog-cancelled turn still reports later. Anything a turn does on completion must check it is still the current turn (`turn` generation in `acp.ts`, `activeTurns` in `codex-appserver.ts`).
- State files that clients read (`status.json`, `control-token`) are written after the port is bound, and `status.json` via temp file + rename.
- Every body that is rendered next to a hub-written header goes through `sanitize()`; otherwise an agent can forge a `[agent-hub message from "user"` line inside its own message.
- Both loopback servers refuse requests that carry an `Origin` header and the control WS requires the token: any web page can open a WebSocket to 127.0.0.1.
- `plugins/agent-hub/server.js` is generated but committed (the marketplace copies only the plugin dir). Do not edit it by hand.
