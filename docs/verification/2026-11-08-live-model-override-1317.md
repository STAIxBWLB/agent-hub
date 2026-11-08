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


## Initial committed checks

- `c0640100a3ff4bf2ab583351ba6a2f26eb2290e0`: frozen DGX install then TSC
  stopped at one possibly undefined model-boundary access. Inventory and tests
  did not run. The guard now requires existence before comparing the owner.
- `7ae86fcc726a70505107b11e445e8373321b8001`: the separate DGX inventory check
  identified seven new keys. This is a failed inventory run, not a green gate.
  No key was added to the baseline.

The new thread-model cache cap, stored override count, pending preview count and
confirmation TTL are operational limits on the hub's own retained state. Pending
native RPC records, CLI response rows and incoming confirmation-token length
are safety floors at input/proof-reader boundaries. The existing #844 token
representation is reused unchanged in a pure leaf module; native adapters do
not import the registry through instances, avoiding an initialization cycle.


At `69974c37b53cc74bb6656b63648f6b8b07818754`, DGX typecheck,
inventory and all 559 exact seed anchors passed. Runtime tests had 383 pass,
3 existing platform skips and 1 failure across twenty files (3,821 assertions;
124 s). The new Codex test requested steering after the RPC response but before
its actual native `turn/started` observation. Its fake now supplies that barrier
and asserts the steer uses the observed native turn id. No ownership guard,
assertion or timeout was relaxed. The three existing #845 skips do not provide
Linux-native sandbox evidence.

Additional boundary checks before submission cover a saved override whose audit
append fails (explicit saved-but-failed reply and readback/repair guidance), an
older hub that advertises no model support (refusal before any model request),
and model listings with retained removed peers. The model view has a display-only 512-row ceiling, with bounded collection
of builtin, configured, external, active local and retained ids. Legacy native
peer admission has no universal 64-peer cap, so a complete inventory is not
assumed to fit. Overflow explicitly refuses list, marks model data unavailable in
status/snapshot without breaking other fields, and leaves single-peer set/clear
usable. No peer admission is narrowed and no truncated list is called complete. This does not raise the
storage cap or change any existing timeout.


The display path caches a scalar launch model only when a trusted supported
factory registers its owner. Periodic model views do not call unsupported
owners' recovery hooks or scan task history. The unavailable flag has fixed
CLI/UI cause and repair guidance, and disables stale model controls.

At `29f3be831399c0125ad9ea5bd4f117894505a760`, the new real fake-WebSocket
ACK-order test reproduced a product defect: an older explicit-client ACK arrived
after a newer hub model acceptance and incorrectly emitted `client-older` as the
native choice. The named assertion failed normally (one case, seven assertions,
4 s), without setup/compiler/timeout failure. This red checkpoint intentionally
contained the new test and unchanged Codex source; other pending refinements were
not claimed tested. Its eventual fix and green evidence are recorded separately.


At `4e10add8e7f6ad446aaf42278ea46ceb86fc77df`, typecheck, inventory and
all 559 anchors passed. The Codex ACK-order regression was green (139 ms),
including unknown-default cases, with its original failing assertion preserved.
The selected seven files had 125 pass and one new fixture failure (1,700
assertions; 61 s): a counter included legacy status recovery-hook calls rather
than isolating the new model view. The correction checks the model-list path
immediately and executes the actual cached fallback projection separately.
The legacy status behavior is not rewritten or counted as a model regression.

A second named red test at `d92ea42aa1d0de528dba014b771895b672e2ad44`
used the real authenticated fake Pi bridge and an owned process signature. It
held the public setter return after a successful native ACK, withdrew roster
ownership, then observed an incorrect `applied` callback before the existing
epoch guard (expected zero, observed one; five assertions, 4 s). The source moves
that callback after the existing post-ACK guard. Cancellation/shutdown precede
the fixture's delivery join; the owned process is confirmed exited. This is
synthetic host/protocol evidence, not a native account or model qualification.

The new Codex steer test also uses the fake's existing file gate to hold turn
completion until its native-id/model assertions finish, replacing a 100 ms
completion race without changing any product timeout or shared fake behavior.
Final unavailable banners describe bounded-read failure generically, because
store-read failure and catalog overflow must not be confused.
