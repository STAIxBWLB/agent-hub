# ripwire: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

## What it does to collaboration

- A call-graph CLI agents query before editing: orientation, callers and uses, impact (blast radius with test reachability) and the tests to run for a change.
- Where it could matter between agents: plans that name the right symbols (the hub's overlap detection compares plan paths and symbols), fewer conflicts between owners, and reviewers finding sibling callers.

## Evidence

- Field data: none yet; the fingerprint records it for every peer that has it on PATH.
- Controlled arms: none run. Owed: `all-on`, `ripwire-off`, `all-off`.

## Decision

| Part | Decision | Basis |
| --- | --- | --- |
| Impact queries before a plan | keep optional | no measurement; candidate native use is symbol-level impact for overlap detection, if `ripwire-off` shows more collisions |
| Caller lookups during review | keep optional | no measurement |

No native adoption without data (backlog plan R10). A follow-up issue is opened only for a part an arm shows helps.
