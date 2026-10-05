# Task board and hub tools

Scope: the task flow, assignment, the state machine and the hub's MCP tools. Read before editing `src/hub/tasks.ts`, `src/hub/board.ts`, `src/hub/routing.ts`, `src/hub/hub-tools.ts` or the hub tool handler in `src/hub/daemon.ts`.

- Tool callers are models: MCP `inputSchema` is not enforced on the way in. Normalize at the boundary (`cleanRefs`) before anything reaches the board, and never throw after a board write.
- `assign()` never defaults to the task's current owner, or a decline can only come back to the decliner.
- The state machine allows `in_progress -> approved` only for classes without a reviewer; `review()` checks `in_review` itself.
