---
name: ahub
description: Prepare the hub command explicitly requested by the person for them to run.
disable-model-invocation: true
---

# Person control

Interpret the person's own request against `ahub help` and the current project state. This skill grants no authority and creates no instruction receipt. Do not execute the requested operation or impersonate the person. If the request is ambiguous or an id or flag is unknown, inspect the relevant public state and ask for the remaining decision before producing a command.

For each person step, give one line explaining what the command does and why the person must run it; then its complete command in its own code block, starting with `cd` to the quoted absolute project directory and including every flag and actual id; then one line describing success. Number multiple steps in execution order. Never print placeholders, partial commands or guessed identifiers. Preserve any exact command supplied by a hub refusal.
