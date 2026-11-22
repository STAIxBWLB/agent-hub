---
name: ahub-manage
description: Diagnose and maintain agent-hub setup, upgrades, peers, queues and stalled work within existing authority.
---

# Hub management

Read `ahub setup` and `ahub doctor` findings, `ahub status --full`, `ahub roster` and the relevant board or queue before choosing a step. Consult `docs/operations.md` for the exact command, permissions, previews and recovery rules. Any agent may inspect public status and queue metadata; only the configured conductor or person may use conductor operations; person-only operations stay with the person. Never infer authority from this skill.

For upgrade and restart, inspect the dry run and blockers first. For a stalled task, inspect its owner, dependencies and history; do not reassign or close it without the required authority. For a queue item, inspect its full id and revision before a resolution; do not guess a disposition. For a stale session, distinguish an old plugin process from the installed plugin and inspect recovery before restarting anything.

When a person must run a step, output one line explaining the command and why they must run it, a separate code block with the complete command beginning with `cd` to the quoted absolute project directory and all flags and actual ids, and one line describing success. Number multiple steps in order. Read unknown values first; never print placeholders or shortened commands. Respect any refusal's exact command.
