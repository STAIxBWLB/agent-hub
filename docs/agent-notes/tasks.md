# Task board and hub tools

Scope: the task flow, assignment, the state machine and the hub's MCP tools. Read before editing `src/hub/tasks.ts`, `src/hub/board.ts`, `src/hub/routing.ts`, `src/hub/task-sweep.ts`, `src/hub/conductor.ts`, `src/hub/supervision.ts` or `src/hub/hub-tools.ts`.

- Tool callers are models: MCP `inputSchema` is not enforced on the way in. Normalize at the boundary (`cleanRefs`) before anything reaches the board, and never throw after a board write.
- `assign()` never defaults to the task's current owner, or a decline can only come back to the decliner.
- The state machine allows `in_progress -> approved` only for classes without a reviewer; `review()` checks `in_review` itself.
- Conductor authority requires the explicit unique role before capability checks. Assignments preserve the acting peer. A peer releases only its own conductor hold; operator release and manual, quota and recovery holds remain separate paths.
- Supervision reasons use structured enums, never history notes, check output or approval titles. Round signatures survive restart; later summaries count only newly joined tasks.
