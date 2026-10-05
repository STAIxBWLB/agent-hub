# Budget, pause and handoff

Scope: quota readings, pause, handoff and resume, and the status line tee. Read before editing `src/hub/budget.ts`, `src/cli/statusline-tee.ts` or `src/hub/bus.ts` (pause persistence).

- Budget: checkpoint first, pause second (a paused peer receives nothing). A handoff that fails is left unmarked so the next tick or hub run retries it; never record it as done.
- A handoff needs somebody to hand over to: `canHandOff` is false right after a restart, when no peer is attached yet, and the handoff waits for a later tick instead of stripping tasks of their owner.
- A reading has its own timestamp. Numbers that arrive through a file (`claude-usage.json`) carry the file's `at`; a window whose `resetsAt` has passed says nothing any more.
- On resume the notice is published before the peer is released, so it leads the first delivery.
- The coordinator only lifts its own pauses: `manualPaused` in the daemon keeps a `ahub pause` in place, and `ahub resume` refuses while a budget record is open.
- The status line tee must never fail or slow the render: no throw, original command run with the same stdin, 5 s cap.
