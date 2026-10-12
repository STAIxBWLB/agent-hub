---
title: Office view of live agent work in the dashboard
date: 2026-10-12
project: agent-hub
status: phase 1 implemented (static Flat office); phases 2-5 pending
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
- A View control in the section head offers Off (the default), Flat, and in
  phase 4 Isometric; the choice persists in the host-scoped `agent-hub-office`
  cookie with the `agent-hub-theme` attributes and try/catch fallback (#246).
- Layout: stable desk slots (claude, codex, kimi, pi, local, then others by id;
  sticky across snapshots via the previous scene, so a peer keeps its slot when
  others come and go); rooms are the board columns in a fixed order; at most 8
  cards per room then "+N more" (filters the task list to that state); the Done
  shelf is a count; more than 12 desks shows "+N peers". `cols` comes from the
  section width: rooms left to right when wide, stacked when narrow.
- Interaction: desks and cards are focusable SVG groups with `role="button"`
  and accessible names; activation scrolls to and highlights the matching list
  row, and a list row highlights its desk or card on focus and hover. The scene
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

## Verification

- `test/office-model.test.ts`: mapping fixture, counts equality with
  `taskProgress`, slot stability, transitions, caps, glyph/label coverage, the
  marker test (no body, detail, approval title or PII text in the model).
- `test/office-view.test.ts`: injection and CSP cleanliness of the served page,
  the cookie (default Off, persistence, blocked-cookie fallback), no
  timer/request/colour literal in the scene code, no DOM write on an unchanged
  snapshot (counting fake document), focus and activation highlighting,
  "+N more" filtering, `resetView` clearing.
- The live browser look (two agents working, both themes, console open) is
  recorded in `docs/smoke.md` as unverified for phase 1.
