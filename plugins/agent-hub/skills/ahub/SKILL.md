---
name: ahub
description: Execute one exact hub command explicitly typed by the person, or prepare their person step when no receipt is available.
disable-model-invocation: true
---

# Person control

The person invokes `/agent-hub:ahub run` followed by the exact `ahub` command without the `ahub` word. Do not reinterpret or alter that command. Inspect `ahub help <command>` and current public state as needed to identify the previous state and an undo command. Do not guess a prior value or identifier.

Run `ahub instructed run` once in this Claude session. The daemon confirms the person's receipt and executes only its command. Never supply a replacement command, arguments, or payload. If the receipt or runtime is unavailable, prepare the original command as a person step instead; never impersonate the person.

End the turn with each instructed operation and its undo. If an undo cannot be established, say so without inventing one. For each person step, give one line explaining what the command does and why the person runs it; then its complete command in its own code block, starting with `cd` to the quoted absolute project directory and including every flag and actual id; then one line describing success. Number multiple steps in execution order. Never print placeholders, partial commands or guessed identifiers. Preserve any exact command supplied by a hub refusal.
