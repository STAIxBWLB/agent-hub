---
name: ahub-use
description: Use the agent-hub board, handoffs, evidence, memory and review workflow.
---

# Use the hub

Read the project AGENTS.md and your assigned roles. Inspect the board before accepting assigned work or proposing a claim; include the paths and concrete plan. Follow the task's spec and worktree rules. File completion with the exact full head and verification evidence; inspect and address review threads first. Review only when assigned and within the recorded scope.

Use `hub_task_handoff` for work belonging to another hub project, with a spec issue for behavior changes. Use `hub_ask` for an evidence-backed answer and verify cited ids; do not treat model answers as evidence. Use `hub_remember` for durable decisions or failures when permitted, and respect private-turn restrictions. Consult the tool descriptions and `docs/operations.md` for current authority and forms.

If a person must run a step, give one line explaining what it does and why the person runs it, a separate code block beginning with `cd` to the quoted absolute project directory and containing the complete command with actual ids and flags, and one line stating the success result. Number multiple steps. Find missing values first; never print placeholders or shortened commands. Pass a refusal's command exactly as printed.
