# Refusal continuations

Run `bun scripts/refusal-inventory.ts` to count the source sites checked by
`scripts/check.sh`. Use `--check` to enforce the baseline and `--json`
to see the source locations and static fragments.

The collector parses `new PreEffectToolRefusal`,
`new HandoffRefusal` and the CLI's `fail(message, ..., next)` with the
TypeScript AST. It checks literal command and tool names against CLI dispatch
and tool declarations. It also checks the flags attached to a command against
its documented flags. Variables and template substitutions are opaque.

Give each new static refusal a valid continuation. If no command can apply,
put an adjacent comment above the refusal with one of these forms:

- `// refusal:by-design operator-knowledge: <reason>`
- `// refusal:by-design world-action: <reason>`
- `// refusal:by-design human-authority: <reason>`

Existing static messages without a continuation are tracked by file and static
text. Remove the old key when the message is fixed or removed. The ceiling for
fully dynamic messages also goes down when the count falls. An invalid command,
flag or tool fails even on a baselined site.

This check cannot tell whether a real command helps in the caller's situation.
The friction journey benchmark runs those continuations and checks the outcome.
