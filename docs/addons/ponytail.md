# ponytail: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

## What it does to collaboration

- A Claude Code (and optionally Codex) plugin that steers the agent toward the smallest change that works: reuse before writing, stdlib before dependencies, root cause in the shared function, `ponytail:` comments on deliberate shortcuts.
- Expected effects to measure: diff size and files changed per task, rework (changes requested), review rounds, and whether a "smallest diff" misses sibling callers (later `regressed` labels).

## Evidence

- Field data: none yet; the fingerprint now records it for Claude and Codex.
- Controlled arms: none run. Owed: `all-on`, `ponytail-off`, `all-off`.

## Decision

| Part | Decision | Basis |
| --- | --- | --- |
| Diff-size rule | keep optional | no measurement |
| Root-cause-in-the-shared-function rule | keep optional | no measurement; candidate for a reviewer-role rubric item if the arms show fewer `regressed` labels |
| `ponytail:` comments on shortcuts | already native | the repository's own convention (AGENTS.md), independent of the plugin |

No native adoption without data (backlog plan R10). A follow-up issue is opened only for a part an arm shows helps.
