# Live model override T1 evidence, #1317

Task #808 implements person-owned desired model state and supported next-turn
selection. This is source and fake-transport work. No model, real account,
native profile, deployed daemon, release or machine trust was changed.

## Contract and scope

- Overrides live in the project hub.db and survive daemon restart. Runtime reset
  clears them; retained state is bound by recovery feature/integrity admission.
- CLI model set/clear/list is person-only, including agent-shell/live-test refusal.
  Dashboard writes use verified settings-session identity, preview and confirmation;
  expiry alone is not treated as a session identity.
- The desired revision and an active turn's captured model are separate. Captures
  happen before asynchronous preparation; acknowledgements bind their actual
  adapter owner and turn, not a future turn id or a model string alone.
- Conductor ruling on 2026-11-08 admits both CodexPeer app-server turn/start
  paths. An explicit native client model wins, turn/steer is unchanged, and a
  turn/start model becomes the native thread default. Clear removes the hub
  override but does not invent an earlier native default.
- T1 does not add ACP setters or native TUI authority. The supported factories
  are host-marked; public capability text alone cannot claim a live setter.
- Tier 3 instance/model/command/provider rules, native reviewer tool/isolation
  fences and local budget/campus/observer safeguards remain in force.

## Checks

The worktree began at b97ee5af976e92b97d2eb55b8a1147908a83fac7. Local dependency
preparation used pinned Bun 1.4.2 with a frozen lockfile (99 packages), with no
pin or lock change. A bounded DGX structural query found ripwire unavailable in
the image, so planning used the inspected source call sites instead. That query
was not a compilation or test gate. Committed-head checks are recorded below
when their results are available; no test pass is claimed yet.

## Remaining evidence

Focused fakes, canonical DGX and exact-head hosted CI remain unverified until
recorded. No native/provider/model-backed run is claimed by those checks.
