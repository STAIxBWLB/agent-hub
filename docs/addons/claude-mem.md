# claude-mem: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

## What it does to collaboration

- Through the hub: nothing at runtime. Session-start recall, task briefs, the local worker's capture and `hub_remember` all use the in-process amem store (`@staix/agent-mem`); the hub makes no claude-mem worker request and ignores `memory.worker_url` (`ahub doctor`: "in-process, no claude-mem worker").
- Native plugin: claude-mem installed as a Claude Code or Codex plugin runs its own hooks inside those sessions; the hub neither reads nor writes them. The add-on fingerprint records it when it is enabled there, so `ahub research addons` and `ahub bench run --addon claude-mem=on|off` can compare on against off.
- Import: `ahub memory import claude-mem` is a person's one-way, read-only copy of past hub observations into hub memory (`docs/memory.md`). The bench memory arms `claude-mem` and `both` are historical labels for `memory.enabled`, not a live claude-mem path.

## Evidence

- Field data: no research records on the development machine yet (`~/.agenthub/research` empty); records written from now on carry the `tooling` fingerprint (`ahub research addons`).
- Controlled arms: none run. Owed: `all-on`, `claude-mem-off`, `all-off` (docs/bench.md, Add-on arms), listed in docs/smoke.md.

## Decision

| Part | Decision | Basis |
| --- | --- | --- |
| Recall at session start | keep optional | no measurement; the hub already reaches every peer through `recallFor` |
| Capture of tool use | keep optional | no measurement; this is claude-mem's own native capture, not the hub's (the hub's capture is local and deterministic), and PII rules keep the hub's PII work out of every observer |
| Long-term store, tiers, graph of notes | adopted natively in #258 | the user's request for cross-project and cross-machine memory, not a measured effect; #258 AC11 measures it (memory off, claude-mem only, native graph) |

Revisit when an arm comparison has at least 5 attempts per arm and measure, or field data has 5 tasks on each side.
