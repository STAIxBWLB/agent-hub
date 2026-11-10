# Companions

The three optional companions live in their own repositories, each with its own version series, release channel and light CI. ahub does not depend on them, and nothing in `src/`, `scripts/`, `plugins/` or `package.json` names them (`test/companion-contract.test.ts` holds that).

| Host | Repository | What it is |
| --- | --- | --- |
| Orca | [STAIxBWLB/ahub-orca](https://github.com/STAIxBWLB/ahub-orca) | an Orca plugin (`orca-plugin.json` at its root, installed from a `vX.Y.Z` tag) |
| Herdr | [STAIxBWLB/ahub-herdr](https://github.com/STAIxBWLB/ahub-herdr) | a mod folder (`mod/`) the person copies to `mods/ahub` |
| Claude Code | [STAIxBWLB/ahub-claude](https://github.com/STAIxBWLB/ahub-claude) | a plugin (`.claude-plugin/`, `hooks/`, `types/`) with its own marketplace file |

This folder holds only this page. The companion code, tests and receipts moved with the repositories (#1387). The Orca CLI verification records under `docs/verification/` (2026-11-02 and 2026-11-06) did not move: they are ahub's own terminal-recovery evidence, cited by `src/cli/terminal-recovery.ts`.

## The contract

A companion may assume only what [`docs/contracts/companion-cli-v1.json`](../docs/contracts/companion-cli-v1.json) lists: the command argv forms, the `status` and `projects` JSON paths with their types and presence rules, the no-hub exit code and stderr prefix, and the `shellQuote` vectors. Each repository keeps a byte copy at `contract/companion-cli-v1.json`, with the ahub version and source commit in `contract/SOURCE.md`, and a test that every field its reader touches is listed.

## The change rule

- Adding a field needs neither a new version nor a handoff.
- Removing or renaming a listed path, changing a listed closed set, an argv form, the exit code or the stderr prefix needs `companion-cli-v2.json` beside v1 and a `hub_task_handoff` to each companion repository.
- `test/companion-contract.test.ts` runs the real commands against a scratch hub and fails when ahub drifts from the file. A change to the file is a change to what three repositories read: update the copies there in the same wave.

`src/hub/orca-env.ts` and `test/orca-env-guard.test.ts` stay in ahub: they are ahub's own child-process environment hygiene, not part of the Orca companion.
