# claude-mem: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

## What it does to collaboration

- Recall: `context/inject` at session start (native hooks for Claude and Codex, the hub's `recallFor` for the other peers) and the task brief on handoff (`search` plus `timeline`).
- Capture: native hooks record tool use; the hub captures the local worker's (`src/memory/capture.ts`).
- Shared notes: `hub_remember` and the hub's own notes on done, review, escalation and checkpoint.

## Evidence

- Field data: no research records on the development machine yet (`~/.agenthub/research` empty); records written from now on carry the `tooling` fingerprint (`ahub research addons`).
- Controlled arms: none run. Owed: `all-on`, `claude-mem-off`, `all-off` (docs/bench.md, Add-on arms), listed in docs/smoke.md.

## Decision

| Part | Decision | Basis |
| --- | --- | --- |
| Recall at session start | keep optional | no measurement; the hub already reaches every peer through `recallFor` |
| Capture of tool use | keep optional | no measurement; capture runs through a cloud observer, so PII rules keep it out of PII work regardless |
| Long-term store, tiers, graph of notes | adopted natively in #258 | the user's request for cross-project and cross-machine memory, not a measured effect; #258 AC11 measures it (memory off, claude-mem only, native graph) |

Revisit when an arm comparison has at least 5 attempts per arm and measure, or field data has 5 tasks on each side.
