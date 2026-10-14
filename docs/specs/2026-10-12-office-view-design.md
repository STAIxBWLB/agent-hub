---
title: Office view of live agent work in the dashboard
date: 2026-10-12
project: agent-hub
status: phases 1-4 implemented (Flat and Isometric office with motion and turn/checking/link fields); phase 5 pending #263
issue: 264
---

# Office view of live agent work in the dashboard

Issue #264. The dashboard shows lists; seeing "who is doing what, with whom,
right now" meant reading several of them. This spec adds an office view: a pure
model, one SVG renderer, and (in a later phase) two projections. Ideas only are
taken from agenttrail (e4ba2da) and Hermes3D (beb7629), both MIT; no code or
asset is copied.

## Design (all phases)

- A pure, self-contained `officeModel(snapshot, previous, { cols })` in
  `src/ui/office-model.ts` turns the snapshot into a scene description (desks,
  rooms, cards, counts, marks, transitions) and is injected into the page by
  `toString()` like `taskProgress`, before the CSP hashes are computed.
- The model is built by allowlist: peer states, queue counts and permission
  modes; task ids, classes, states, owners, reviewers, deps and public titles;
  approval counts by peer; budget pause readings. `env.body`, task detail,
  approval titles, paths and symbols never enter (marker test).
- One renderer draws the model as inline SVG with `createElementNS`, from the
  same `render(snapshot)` call as the lists, only when its signature changed.
  No timer, no `requestAnimationFrame`, no request. Colours come from the
  page's theme tokens through CSS classes; every state also carries a glyph
  and a text label.
- The Office view section contains a mode control offering Off (the default),
  Flat and Isometric; the choice persists in the host-scoped `agent-hub-office`
  cookie with the `agent-hub-theme` attributes and try/catch fallback (#246).
- Layout: stable desk slots (claude, codex, kimi, pi, local, then others by id;
  sticky across snapshots via the previous scene, so a peer keeps its slot when
  others come and go); rooms are the board columns in a fixed order; at most 8
  cards per room then "+N more" (filters the task list to that state); the Done
  shelf is a count; more than 12 desks shows "+N peers". `cols` comes from the
  section width: rooms left to right when wide, stacked when narrow.
- Interaction: desks and cards are focusable SVG groups with `role="button"`
  and accessible names; activation scrolls to and highlights the matching list
  row; a card also opens the shared task detail dialog (#391). A list row
  highlights its desk or card on focus and hover. The scene
  performs no action and sends no request; the closed action list is unchanged.
- Room counts equal `taskProgress(tasks).counts` for the same snapshot (pinned
  by a test, including randomized boards).

## Phasing (per the issue)

1. `officeModel` and the static Flat office: desks, states, rooms, cards,
   counts, the view control, list highlighting. No daemon change. (This
   document's implementation phase.)
2. Motion from the snapshot: card moves, message arcs, delivery marks, the busy
   latch, the settle rule. No daemon change.
3. Optional snapshot fields `turn`, `checking`, `links` and what they draw.
4. The Isometric projection of the same model.
5. Backlog wall, release docks and the planner's desk, once #263 lands.

Phase 1 decisions within the spec:

- `previous` is the previous scene model, not the raw snapshot: sticky slots
  and transitions both read from it, and `resetView` clears it so a project
  switch starts fresh.
- The primary condition of a desk is the first of offline, paused, waiting on
  approval, busy, idle; the raised-hand count, inbox tray, mode badge and break
  sign are independent marks that combine freely with it.
- Work-floor cards sit at the owner's desk (at most 3, then "+N more" as text);
  a card whose owner has no visible desk waits in the Work floor room. Tasks in
  an unknown state are counted (`counts.unknown`) but placed nowhere.
- The busy bubble names the task only when the peer has exactly one
  `in_progress` task; it is never guessed (phase 3 adds the exact `turn`
  field).
- Transitions are computed as data in phase 1 (desks added/removed, cards
  moved); they drive motion only from phase 2.

Phase 2 decisions within the spec:

- Motion is CSS only. Cards are persistent keyed SVG nodes positioned by CSSOM
  `transform`, so a changed placement animates through a `transform` transition
  (0.8 s); desks never move and are rebuilt in place when their content
  changes. The busy glyph and the raised hand pulse (`opacity` keyframes); an
  idle desk has no animation class. `prefers-reduced-motion: reduce` removes
  all scene transitions and animations.
- Arcs, delivery marks and the busy latch are transient marks with an absolute
  expiry timestamp in the model. The renderer draws them once with a keyframe
  fade whose delay is computed at render time (hold, then fade over the final
  second, `fill: forwards`), so "fade after 10 seconds" needs no timer; expired
  nodes purge lazily on the next changed render or on their own animationend.
- The model's clock for arc expiry is the snapshot's own newest envelope
  timestamp (`eventTime`), not wall time: an unchanged snapshot yields an
  identical model at any wall time, so the signature guard still writes
  nothing. Wall time enters only as `options.now` at the moment an event row is
  first consumed (alert/latch horizons) and in the settle gap.
- Event rows are deduped by `seq` against `lastSeq`, so re-rendering the same
  snapshot (for example after a task-filter change) draws nothing twice. The
  first snapshot after load or a project switch consumes rows without drawing
  them: no replay of history.
- The settle flag is carried unchanged while nothing moves, and recomputed when
  a snapshot brings changes: gap over 3 s since the last change, or more than
  6 transitions (card moves, desk adds/removals, new marks) at once, jump
  straight to final positions.
- Arc fan-out: an envelope with no `to` draws an arc to every visible desk; a
  `from` that is not a peer (hub, console) starts at a fixed anchor point.
  Delivery marks from `quiet` rows land on every named peer; `off_roster` rows
  are not drawn (the mapping table names only overflow, undeliverable, stale
  and quiet). Event `reason` strings are never copied into the model.

Phase 3 decisions within the spec:

- `status.peers[id].turn` is built in `uiSnapshot` from the daemon's `turns`
  map as `{ since, task?, attribution }`. A private turn (a peer holding a PII
  task) or an attribution flagged `pii` omits `task`; such a turn can exist
  only for the in-process local worker, since the board refuses PII tasks to
  any other owner.
- The exact busy bubble uses `turn.task` whenever present (even when the peer
  has zero or several in_progress tasks, and even if the task meanwhile left
  the board, then with a plain label). The phase-1 heuristic is the fallback
  for an older daemon that sends no `turn`.
- `tasks[].checking` comes from `Tasks.isChecking` at snapshot time. A checking
  task stays `in_progress`, so its card never moves; the mark is a glyph plus
  an accessible-name note, not a state.
- `links[]` is assembled in `uiSnapshot`: overlap pairs from the new
  `Tasks.overlapLinks()` (the board's own `overlapHits`, so `ahub route` and
  the scene cannot drift) and `Tasks.cohortLinks()` (`Cohorts.list()`), plus
  conflicts from a bounded (12) in-memory list the daemon fills where it
  already emits `conflict` events, deduped by task pair and dropped once either
  task leaves the open states. All three carry task and peer ids only; overlap
  and cohort links exclude PII tasks through `overlapHits`/`formCohort`.
- The scene validates links down to the three kinds and their id lists (an
  older or newer peer of the protocol that sends more is ignored), draws a
  dashed line per consecutive desk pair with a kind/task-ids label, and treats
  links as state: no fade, present while the link exists.
- `PROTOCOL` (16) and `EVENTS_SCHEMA` (1) are pinned by a test; the fields are
  additive and optional both ways.

Phase 4 decisions within the spec:

- Isometric is a pure coordinate projection at the renderer, not a second
  scene: `officeProject(x, y)` maps grid coordinates to (x - y) cos 30,
  (x + y) sin 30 and every node is laid out upright in local coordinates and
  positioned by its projected CSSOM transform. Desk and room tiles become
  parallelogram polygons (the linear image of their rect); cards, text labels,
  bubbles, marks and arc labels stay upright. No WebGL, no library, no new
  route, no CSP change.
- Keyboard targets follow model order independently of visual paint depth. Each
  visible card has one transparent, focusable hit target with its full accessible
  name; a separate `aria-hidden` paint layer is ordered back to front under
  Isometric. Click, Enter and Space open the same task detail. Shared visible
  cards retain their relative tab order across projections and switching back
  restores Flat's model order. #394 allows Isometric to omit cards that do not
  fit and expose the omitted count through the existing "+N more" control, so
  its visible target inventory can be smaller than Flat's.
- #394 fixed-scale amendment (2026-10-14): the SVG width attribute is its actual
  occupied projected viewBox width times 12 px/unit, with `max-width: 100%` and
  automatic height. It remains centered and shrinks only when the panel is
  narrower than this intrinsic width. Flat uses up to four room columns;
  Isometric uses two on wide screens and bounds the occupied tiles rather than
  blank grid corners, keeping the two-peer scene at the same scale at 1280 and
  1920 px. The cos-30/sin-30 projection and desk slots remain unchanged.
- A projection switch repaints every node in place (the projection is part of
  each reconcile signature) and is treated as a settle: positions jump, no
  transform transition storms. Card moves under Isometric animate through the
  same transform transition as Flat; reduced motion removes it all as before.
- Size accounting against the issue's 30 KB budget (page base 59,329 bytes at
  phase 1 branch point): phase 1 +11,040, phase 2 +7,340, phase 3 +2,141,
  phase 4 +1,704, art polish +3,559; final 89,113 bytes, +25,784 total,
  inside the original phase-4 budget. These are historical #264 figures; #394
  adds a separately reviewed visual refinement. The iso shelf's base skirt was
  dropped to stay under the original budget.
- Art polish (2026-10-12): two reference concept images (a flat view and an
  isometric view) were generated with Higgsfield (nano_banana_pro) and kept
  outside the repo (scratchpad); they served as drawing references only. Per
  this issue's "art made in code, with no image files" rule, nothing ships as
  an image: no asset files, no CSP change, no new route. What was adopted:
  outline-shape condition glyphs (pause bars, ring, filled dot, cross) and a
  raised hand drawn as palm-and-fingers shapes, a person avatar per desk
  (inside the flat tile; standing behind the iso desk), an extruded iso desk
  (top plus two front legs), a name plate parallelogram on the iso desk's
  front edge, the warm-accent (--amber) emphasis on a waiting desk, faint
  wireframe iso room boxes with small-caps labels at the base, a Done shelf
  cabinet (flat) and stacked boxes on a slab (iso) with the count kept as
  text, two-column room cards with thin dividers, and arc arrowheads at the
  target end. #394 supersedes the wireframe posts, small-caps base labels,
  decorative empty shelf slots and two-column cards:
  - Room names are sentence case, 13 px/600 in `--ink`; count pills are 12 px
    monospace with tabular figures. Desk names are 13 px; card/state/meta text
    is 12 px. Shapes use 1 px non-scaling hairlines; focus is 2 px.
  - Room cards use one 20-unit padded column, 28 px height and 6 px gap, keeping
    the eight-card model cap and public fields. Labels show id plus public
    title. Canvas measures the actual system/monospace fonts before clipping at
    a nearby word boundary; an internal SVG clipPath guarantees the card text
    boundary. The full title remains in SVG title, aria-label and task detail.
  - Room title/count groups paint last above all tiles. Isometric cards remain
    upright, fit wholly inside padded tile bounds and paint by projected depth;
    omitted cards contribute to "+N more". Empty rooms and the empty Done shelf
    show "No tasks"; populated shelf slots correspond to existing done count
    up to the current Flat/Isometric caps.
  - Existing theme tokens, public-view privacy, counts/placement classifications,
    animations, reduced motion, keyboard activation and mode cookie remain.

## Verification

- `test/office-model.test.ts`: mapping fixture, counts equality with
  `taskProgress`, slot stability, transitions, caps, glyph/label coverage, the
  marker test (no body, detail, approval title or PII text in the model);
  phase 2: arcs, delivery marks and the busy latch from event rows, no replay
  on the first snapshot, seq dedupe, arc expiry on the snapshot clock, and the
  settle rule (first snapshot, gap, transition storm, flag stability);
  phase 3: the exact bubble and its fallback, finishing-a-turn, the checking
  mark, link validation, and markers in turn-adjacent data, check output and
  conflict reasons never reaching the model.
- `test/office-view.test.ts`: injection and CSP cleanliness of the served page,
  the cookie (default Off, persistence, blocked-cookie fallback), no
  timer/request/colour literal in the scene code, reduced-motion and motion CSS
  scans, no DOM write on an unchanged snapshot (counting fake document), focus
  and activation highlighting, "+N more" filtering, `resetView` clearing;
  #394: fixed font/scene scale, 1 px hairlines, top-layer headers, actual shelf
  counts, measured Latin/CJK title clipping and hard SVG bounds, cross-room
  depth order, projection-independent shared-target tab order and Flat restore,
  0/4/12-task two-peer geometry, count-stable placement changes and light/dark
  text token contrast at least 4.5:1;
  phase 2: card moves keep their node and animate by transform, arcs/marks/
  latch draw once with fade timing, departure fade purges on animationend;
  phase 3: the exact bubble, finishing-a-turn line, check-running mark and
  warning lines render.
- `test/tasks.test.ts`: `overlapLinks`/`cohortLinks` carry ids only and exclude
  PII tasks. `test/daemon.test.ts`: `ui_snapshot` carries `turn`, `checking`
  and overlap/cohort links against a real daemon, pins `PROTOCOL` (16) and
  `EVENTS_SCHEMA` (1), and proves a PII task keeps its stub, refuses a
  non-local owner and joins no link.
- The live browser look (two agents working, both themes, console open) is
  recorded in `docs/smoke.md` as unverified for phase 1.


## Merge review corrections

Current snapshot task privacy is checked again when warning links are built,
including cohorts and conflicts created before a task became private. The Off
selector stays visible outside the hidden scene. Filtered card activation reveals
its task; Work overflow includes rework. Sticky desk coordinates set scene bounds.
The existing snapshot poll prunes transient deadlines even when the model is
unchanged; reduced-motion departures are immediate and settled paints receive no
appearance class. Explicit unattributed turns never use the legacy task guess.
Large warning caps prioritize conflicts; distinct kinds use parallel offsets.
Original test assertions are retained. Physical visual readback remains pending.
