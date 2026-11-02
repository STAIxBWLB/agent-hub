# Review instructions

Read by `/codex:review`, `/code-review`, and human reviewers alike.

## Passes

Run these passes and tag every finding with its pass:

- Bugs: logic errors, broken edge cases, regressions. Pay attention to lost or duplicated messages, state machines stuck in `busy`, and child processes that outlive the daemon. Error messages: a new or changed error, refusal or failure message a person or agent sees names the cause (what failed and why) and the next step (the command, setting or target that fixes it). When secrets, ids or paths must stay out, it names the cause class and how to check it. A message missing either is a finding; Important when it is the only signal of a blocked action (a CLI exit, a refused tool call), otherwise a nit.
- Security: cross-peer text reaching an agent without untrusted framing, loopback servers reachable without the token or from a browser origin, secrets or tokens in logs, permission prompts bypassed without explicit operator opt-in (`--unattended`, `permission_modes` defaults or console-only `ahub permission`). Check agent-shell, hub-tool and conductor refusal paths, `never-ask` confirmation, native-policy restoration when returning to `ask`, and unchanged sandboxes.
- Compliance: the change matches `docs/specs/2026-09-19-agent-hub-design.md` and the plan pinned on the issue; deviations are written into the spec in the same PR.

## What Important means here

Reserve Important for findings that lose messages, break a peer's turn, leak data, weaken a safety default, or breach the spec. Style and naming are nits.

## Cap the nits

Report at most the configured `sdlc.max_nits` nits per review (default 5); summarize the rest as a count. Use semantic finding ids shared across tasks, rather than positional labels such as B1 or nit-1, and structured pass, severity and disposition in `hub_review`. Keep a finding's id when reclassifying its pass; disposition updates settle that same identity within the task. Only the person may mark a finding accepted, with a rationale.

## Do not report

- Generated paths: `plugins/agent-hub/server.js`, `bun.lock`
- Anything CI already enforces: type errors, bundle staleness (`scripts/check.sh`)
- Milestone scope: features the spec assigns to a later milestone than the PR under review

## Feedback into AGENTS.md

When the same finding appears twice, the correction goes into `AGENTS.md` in the same PR, or into the area's note in `docs/agent-notes/` when it holds in one area only.
