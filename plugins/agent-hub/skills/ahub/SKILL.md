---
name: ahub
description: Carry out the person's supported hub instruction, or prepare their person step when it cannot be admitted.
disable-model-invocation: true
---

# Person control

The person's prompt is exact when its arguments begin with `run`: the rest is the exact `ahub` command without the `ahub` word. Otherwise it is an intent prompt: choose only supported commands that carry out what the person actually asked. Do not infer additional work. Inspect `ahub help <command>` and current public state as needed to identify prior state and an undo command. Do not guess a prior value or identifier.

For an exact prompt, run `ahub instructed run` once in this Claude session without additional arguments. Never replace or reinterpret that command. For an intent prompt, pass the selected `ahub` command and its arguments after `ahub instructed run`; the daemon confirms the person's receipt and admits only its closed intent list. A person verdict requires the item's literal id in the person's prompt. Spending settings, permission, trust, machine-local paths, irreversible deletion, release, merge, identity and private work stay closed. If the mode, receipt, command or runtime cannot admit an operation, prepare the person's command as a person step instead; never impersonate the person.

The admitted intent forms are `task assign`, `backlog pull` and `return`, `stop`, `model set` and `clear`, `results`, `capabilities`, `learn list`, `learn accept` and `reject`, a user-reviewer `review`, and `task claim` without a manifest. A claim verdict requires both the task id and claim slot literally in the person's prompt. Ask the daemon rather than guessing whether an operation is admitted; retain its refusal as the person's next step.

End the turn with each instructed operation and its undo. For a person verdict, say "no undo"; do not invent one. If any other undo cannot be established, say so without inventing one. For each person step, give one line explaining what the command does and why the person runs it; then its complete command in its own code block, starting with `cd` to the quoted absolute project directory and including every flag and actual id; then one line describing success. Number multiple steps in execution order. Never print placeholders, partial commands or guessed identifiers. Preserve any exact command supplied by a hub refusal.
