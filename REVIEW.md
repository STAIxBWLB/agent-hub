# Review instructions

Read by `/codex:review`, `/code-review`, and human reviewers alike.

## Passes

Run these passes and tag every finding with its pass:

- Bugs: logic errors, broken edge cases, regressions. Pay attention to lost or duplicated messages, state machines stuck in `busy`, and child processes that outlive the daemon.
- Security: cross-peer text reaching an agent without untrusted framing, loopback servers reachable without the token or from a browser origin, secrets or tokens in logs, flags that disable permission prompts without `--unattended`.
- Compliance: the change matches `docs/specs/2026-09-19-agent-hub-design.md` and the plan pinned on the issue; deviations are written into the spec in the same PR.

## What Important means here

Reserve Important for findings that lose messages, break a peer's turn, leak data, weaken a safety default, or breach the spec. Style and naming are nits.

## Cap the nits

Report at most 5 nits per review; summarize the rest as a count.

## Do not report

- Generated paths: `plugins/agent-hub/server.js`, `bun.lock`
- Anything CI already enforces: type errors, bundle staleness (`scripts/check.sh`)
- Milestone scope: features the spec assigns to a later milestone than the PR under review

## Feedback into CLAUDE.md

When the same finding appears twice, the correction goes into `CLAUDE.md` in the same PR.
