# agent-hub

Bun + TypeScript daemon that lets Claude Code, Codex, Kimi Code (and later a local-LLM worker) exchange messages as peers in one project directory. It is a message bus with native adapters, not a fork of agent-bridge and not a memory store. Spec and milestone status: `docs/specs/2026-09-19-agent-hub-design.md` (mirrored in issue #1).

## Commands

- Install: `bun install`
- Test: `bun test` (one file: `bun test test/bus.test.ts`)
- Typecheck: `bun x tsc --noEmit`
- Rebuild the plugin bundle after touching `src/adapters/claude-channel.ts` or anything it imports, and after changing `version` in `package.json`: `bun run build` (it also stamps the plugin manifest)
- Run from source: `bun src/cli/main.js <command>` (`ahub` once linked with `bun link`)

## Verifying your work

Run this before reporting any task complete, and paste the output. A failing test is fixed in the code, never by editing the test.

- `scripts/check.sh` (healthy output ends with `check: OK`; it runs typecheck, the bundle freshness check, npm tarball contents and all tests)
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
- PII decisions ask `onCampus()` (a gateway answered and is not behind Access, and no sidecar was generated against the off-campus URL). Never `!offCampus()`: unknown is not on campus.
- What a model wrote is saved as a model's answer (`peer: hub`, its own title prefix) and excluded from later evidence; a non-answer is never saved.
- Every control message with a `rid` gets a reply, the unknown ones too, or a newer CLI hangs on an older hub.
- `src/hub/ask.ts` (`ahub ask`: evidence from board, memory and log, then an evidence-only answer that must cite ids).
- `src/hub/inference.ts` (the hub's own model calls: digest condensation, task triage), `src/version.ts` (the one version, from `package.json`), `src/cli/setup.ts`.
- `src/hub/budget.ts` (quota readings, pause records in `hub.db`, resume), `src/cli/statusline-tee.ts` (Claude's quota source).
- `src/hub/board.ts` (sqlite), `src/hub/routing.ts` (`routing.toml`, `assign()`), `src/hub/tasks.ts` (the flow), `src/hub/hub-tools.ts` (tool and role definitions, read by the MCP server and the local worker alike), `src/memory/brief.ts`.
- `src/adapters/local-worker.ts` + `src/local/` (tools, path guard, seatbelt runner): the hub-native peer. `src/omniroute/`: the only place that reads the gateway key and Access headers. `src/switchyard/`: config generator and session-scoped sidecar. `src/hub/routing.ts`: `routing.toml`.
- `src/memory/`: claude-mem worker client, session-start recall, and capture for the local worker. Fail-open everywhere; the hub never owns a memory database.
- `src/cli/`: `main.ts` (commands), `launch.ts` (hub-owned flags), `init.ts` (marker blocks).
- `plugins/agent-hub/`: plugin manifest, `.mcp.json` and the committed bundle. `templates/`: what `ahub init` writes.
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
- Every task change goes through `Tasks` (`src/hub/tasks.ts`); adapters, tools and the CLI never touch the board. Assignment stays a pure function so `ahub route explain` cannot drift from what assignment does.
- PII: redaction happens where the envelope (`private: true`) and the public view are built, never at call sites. Anything new that shows task text (a log line, a notice, a tool result, a memory call) uses `publicTitle` / `publicView`, and nothing about a PII task is sent to claude-mem: its observer is a cloud model.
- Inference is optional and fail-open: it returns its input or `undefined` on any failure and backs off, so a delivery never waits on a dead model twice. Its output is only ever capped text or a value checked against a closed list.
- What a peer is handed (`out`) and what it stands for (`originals`) differ once a delivery is condensed: the bus keeps both, registers `out` so `reply_to` resolves, puts the originals back on any failure (a thrown `deliver` or a later `onFailed`), and counts no attempt when the peer merely got busy while the delivery was prepared. A delivery with an `important` envelope is never condensed.
- `ahub setup` reads Claude Code's state from `--json` listings and takes one step at a time, re-reading after each; never match paths or names by substring.
- A condensed digest is sent by `digest`, not `hub`: `replyParent()` skips `hub` items, and a reply to a digest must keep the highest hop of what it replaced. On a failed delivery the bus puts back the originals, never the digest.
- Releasing: bump `version` in `package.json`, `bun run build`, update `CHANGELOG.md`, merge, then tag `v<version>`; the release workflow refuses a tag that does not match.
- Budget: checkpoint first, pause second (a paused peer receives nothing). A handoff that fails is left unmarked so the next tick or hub run retries it; never record it as done.
- A handoff needs somebody to hand over to: `canHandOff` is false right after a restart, when no peer is attached yet, and the handoff waits for a later tick instead of stripping tasks of their owner.
- A reading has its own timestamp. Numbers that arrive through a file (`claude-usage.json`) carry the file's `at`; a window whose `resetsAt` has passed says nothing any more.
- On resume the notice is published before the peer is released, so it leads the first delivery.
- The coordinator only lifts its own pauses: `manualPaused` in the daemon keeps a `ahub pause` in place, and `ahub resume` refuses while a budget record is open.
- The status line tee must never fail or slow the render: no throw, original command run with the same stdin, 5 s cap.
- The hub itself sends envelopes (`from: hub`, kinds `task` and `review`). Code that special-cases hub envelopes keys on `kind`, not on the sender: only `kind: presence` is the recall preface.
- Tool callers are models: MCP `inputSchema` is not enforced on the way in. Normalize at the boundary (`cleanRefs`) before anything reaches the board, and never throw after a board write.
- During a PII turn the worker's own words may carry the PII: `hub_remember` and `hub_task_propose` are refused for that turn, and its answers are filed on the board because the bus shows only a stub.
- `assign()` never defaults to the task's current owner, or a decline can only come back to the decliner.
- The state machine allows `in_progress -> approved` only for classes without a reviewer; `review()` checks `in_review` itself.
- One denylist, `src/local/deny.ts`: the path guard, the seatbelt profile and the memory filter all read it. Seatbelt sees absolute paths, so `local.deny` entries are anchored under the project root (a bare `private/` once denied all of `/private/var`).
- `guardPath` walks with `lstat`: `existsSync` follows symlinks, so a dangling link looked like a new file and the write landed at its target.
- git arguments never pass through `guardPath`; `gitArgsProblem` refuses absolute paths, `..`, `--no-index` and denylisted `rev:path` forms.
- A worker turn builds its messages in a local array and joins the history only as a whole. Never push to `history` mid-turn: one tool call without its result poisons every later request.
- After a tool with side effects ran, a failed turn is reported, never redelivered.
- Approval titles are agent-written text shown to a person: the daemon escapes control characters, and write/edit/bash show what will be written or run.
- Secrets stay inside `OmniRoute`: never put the key or Access values in a log line, an error message, a return value or the generated Switchyard file (the key goes by env var name).
- Switchyard's docs drift from the released binary. Any change to `switchyardToml` is checked with the real `switchyard-server --dry-run`, not only the stand-in in `test/fakes/`.
- A child process gets a scrubbed environment, so test knobs for fakes travel in a wrapper script, not in `process.env`.
- Work that must survive `ahub kill` (claude-mem `session-end`) is awaited in `stop()`; fire-and-forget dies with the process.
- A peer must set `busy` synchronously inside `deliver()`, otherwise the bus drains the next envelope into a running turn (Kimi answers `turn.agent_busy`).
- A watchdog-cancelled turn still reports later. Anything a turn does on completion must check it is still the current turn (`turn` generation in `acp.ts`, `activeTurns` in `codex-appserver.ts`).
- State files that clients read (`status.json`, `control-token`) are written after the port is bound, and `status.json` via temp file + rename.
- Every body that is rendered next to a hub-written header goes through `sanitize()`; otherwise an agent can forge a `[agent-hub message from "user"` line inside its own message.
- Both loopback servers refuse requests that carry an `Origin` header and the control WS requires the token: any web page can open a WebSocket to 127.0.0.1.
- The channel's reconnect loop stops on closes a retry cannot fix (`TERMINAL_CLOSES` in `claude-channel.ts`); a new daemon close code that means "do not come back" belongs there, or two clients fight over it forever.
- `plugins/agent-hub/server.js` is generated but committed (the marketplace copies only the plugin dir). Do not edit it by hand.
- Adding a native peer requires testing the command emitted by the actual recovery driver, not only its inspection or launch helpers. Never let a generic non-Codex branch treat a new peer as Claude.
- Cross-version recovery must use the authenticated source protocol for prepare/commit/abort and the target protocol after startup. Prove the transition against a real prior release before claiming compatibility.
- Shared inference slots must recover after a hub process dies, without evicting a live owner. Cancellation has to reach slot acquisition from the relay caller, not just exist in the helper signature.
- Native owner teardown must handle a lost shutdown acknowledgement using verified process identity. Pending launches must be revocable, and active tools/streaming output must count as watchdog activity.
- A reply is addressed, never broadcast. An adapter that answers a delivery passes `to: replyAudience(envs)`; anything else with an `inReplyTo` inherits that envelope's sender. Leaving `to` empty fans the message out to every peer, which is what made one directed question cost every agent a turn.
- `digest` is not a peer: addressing a reply at the envelopes the peer was handed sends it nowhere once a delivery was condensed. The bus resolves `digest` back through `lastDelivery.originals`; anything else that reads a reply's `to` has to do the same.
- A hub-native peer (Pi, the local worker) does not get to call its own message `important`: `capPriority` caps it unless the delivery it answers held an `important` envelope addressed to it. Check the delivery, not `replyParent`, which ties on hop and takes the later item. Do not bypass it by setting `priority` in the adapter.
