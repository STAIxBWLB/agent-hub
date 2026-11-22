---
name: ahub-manage
description: Diagnose and maintain agent-hub setup, upgrades, peers, queues and stalled work within existing authority.
---

# Hub management

Use `ahub help` for exact current forms and hub tool descriptions for tool authority. Identify the selected project and inspect state before a write. Labels below do not grant authority; honor refusals and required confirmations.

## Setup and doctor

1. Any agent: read `ahub doctor --json` and the latest setup output. Inspect each finding and its complete suggested command. For `jcode MCP servers`, inspect the named configuration sources and their server names; never remove a server without the person's decision.
2. Any agent: read `ahub agents --json` for a version-refused CLI. Person: if they decide to trust the actual installed version, run `ahub agents trust <id> <version>`; obtain both values from the reading and explain that runtime proofs still apply.
3. Person: run `ahub setup` when the findings require plugin or hook installation, then any agent reruns `ahub doctor --json` to verify. Setup writes configuration; do not run it merely to read findings.

## Upgrade and restart

1. Any agent: inspect `ahub upgrade --dry-run` or `ahub restart --dry-run` and resolve blockers; check `ahub status --full` and recovery status before acting.
2. Person: run the appropriate interactive `ahub upgrade` or `ahub restart`. A configured conductor may use `ahub upgrade --to <version> --yes` or `ahub restart --yes` only with the required same-project continuation proof; otherwise the person runs it. Check status and recovery afterward.

## Roster and pauses

1. Any agent: inspect `ahub roster --json` and `ahub status --full` for participation, pause and retained work.
2. Conductor or person: for a delivery pause, use `ahub resume <peer>` after identifying the actual peer. Use `ahub roster add <peer>` or `ahub roster remove <peer>` only after inspecting retained work and the preview; removal with `--now` can stop busy work. Budget pauses have separate `ahub budget resume <peer>` authority and semantics; check help first.

## Queue repair

1. Any agent: read `ahub queue list --all --json` for full delivery IDs and state.
2. Conductor or person: inspect the exact item with `ahub queue show <delivery-id> --json`, including its revision. Decide the disposition from evidence, then use `ahub queue resolve <delivery-id> --action completed|retry|discard --reason <text> --revision <N>` with actual values. Never guess or retry blindly.

## Stalled tasks and sessions

1. Any agent: inspect `ahub task show <id>` and `ahub route explain <id>` for dependencies, reservation, eligibility and decline history. For no eligible peer report the named reason; do not assume availability.
2. Person: if a declined peer should be assigned again, run `ahub task assign <id> <peer>` using the actual task and peer; verify with `ahub task show <id>`. Respect the board's revision and authority refusals.
3. Any agent: use `ahub-status` to distinguish the installed plugin from the server each session actually runs. Person: restart a stale Claude session through the hub launcher after checking its retained work and recovery instructions; verify its version on reconnect.

When a person must run a step, output one line explaining what the command does and why the person runs it, a separate code block with the complete command beginning with `cd` to the quoted absolute project directory and all flags and actual IDs, and one line describing success. Number multiple steps in order. Read unknown values first; never print placeholders or shortened commands. Respect any refusal's exact command.
