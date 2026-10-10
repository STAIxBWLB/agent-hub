# Local worker and sandbox

Scope: the hub-native local worker, its tools, path guard, denylist and seatbelt sandbox. Read before editing `src/adapters/local-worker.ts`, `src/local/`, `src/memory/capture.ts` or `src/hub/facts.ts` (both read the denylist).

- Nothing the local worker executes may run outside `sandboxedExec`; a new tool that spawns a process goes through it, and a tool that touches a path goes through `guardPath`.
- The sandbox denies home reads by default (toolchain dirs, the project and its real git dir excepted) and all network, loopback included: claude-mem and the Codex app-server listen on loopback without auth. Tests that bind a local port therefore fail when the worker runs them, also with `local.bash_network: true` (the egress proxy keeps loopback closed, and the proxy variables send a test's plain-HTTP `fetch` to the proxy, which refuses it); that is the intended trade-off, and `"direct"` is the switch until 0.13.0 removes it.
- SBPL strings go through `sbplString` (the plain `"..."` form). In the raw `#"..."` form a backslash escapes nothing, so a `"` in a path ends the literal and the whole profile fails to parse.
- One denylist, `src/local/deny.ts`: the path guard, the seatbelt profile and the memory filter all read it. Seatbelt sees absolute paths, so `local.deny` entries are anchored under the project root (a bare `private/` once denied all of `/private/var`).
- `guardPath` walks with `lstat`: `existsSync` follows symlinks, so a dangling link looked like a new file and the write landed at its target.
- git arguments never pass through `guardPath`; `gitArgsProblem` refuses absolute paths, `..`, `--no-index` and denylisted `rev:path` forms.
- A worker turn builds its messages in a local array and joins the history only as a whole. Never push to `history` mid-turn: one tool call without its result poisons every later request.
- After a tool with side effects ran, a failed turn is reported, never redelivered.
- Hub tool calls (`hub_send`, `TASK_TOOL_NAMES`, `CONDUCTOR_TOOL_NAMES`) are never passed to `capture.observe`; `Tasks` alone decides what hub tool text reaches memory (#230).
- A tool that asks for approval passes its name to `ctx.permit`, and `write`/`edit` also the `guardPath` result, never the model's path string: `ask-when-needed` grants on that real path through `grantablePath` (`src/hub/permission-mode.ts`). `bash` and mutating `git` pass no path. After the awaited approval `write`/`edit` run `guardPath` again and refuse a target that changed (#242).
