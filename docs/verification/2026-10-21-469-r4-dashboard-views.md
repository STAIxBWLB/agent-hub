# #469 R4 and R5: the other dashboard views, glyphs to icons, Office colour checks

Task #173, branch `feat/469-r4-views` (on top of `feat/469-r3-board`). R4 restyles Agents, Stream, Memory, Settings and Message and
replaces the symbol glyphs. R5 puts the Office scene's colour use under the contrast test. Behaviour, view names and order, the view
cookie, element ids and every action are unchanged.

## Source

A scratch hub outside any git repository with its own `HOME` and `AGENTHUB_HOME` (never the person's home or live hub): five fake
pull-only peers, seven sample tasks plus a backlog task, four short-term memory notes (decision, fail, contract, finding) and three
console messages. Headless Chromium over the DevTools protocol with `prefers-color-scheme` emulated, at 1440x1000 and 390x900.

| What | image |
| --- | --- |
| Agents 1440 light / dark | `assets/469-r4-agents-1440-light.png`, `assets/469-r4-agents-1440-dark.png` |
| Agents 390 dark | `assets/469-r4-agents-390-dark.png` |
| Stream 1440 light, 390 light | `assets/469-r4-stream-1440-light.png`, `assets/469-r4-stream-390-light.png` |
| Memory 1440 light / dark, 390 dark | `assets/469-r4-memory-1440-light.png`, `assets/469-r4-memory-1440-dark.png`, `assets/469-r4-memory-390-dark.png` |
| Settings 1440 light / dark | `assets/469-r4-settings-1440-light.png`, `assets/469-r4-settings-1440-dark.png` |
| Message 1440 light | `assets/469-r4-message-1440-light.png` |
| Office (Flat) 1440 light / dark | `assets/469-r4-office-1440-light.png`, `assets/469-r4-office-1440-dark.png` |

The rig also shot the other combinations (all six views at 1440 and 390, light and dark); only the ones above are attached.

## R4

- **Agents.** Every peer row (five of five) has one summary line (queued count, "Working on #n" or "No active task") and exactly one
  closed `<details class="peer-fold">` holding the former meta lines. Row height was 144 to 145 px with the fold closed. The status
  notice stays outside the fold. Approvals stay first.
- **Stream.** The filter chips and Follow latest are in the section head, above the scrolling list. Each event is a head line (time,
  sender, kind) above a monospace body; in the page the left edge of every event was the same x (249 at 1440, 29 at 390). That is
  aligned rows, not four separate columns: the spec's "time column, kind, sender, body" is met as one head line plus the body.
- **Memory.** Rows show title, a kind badge and a meta line with the id, peer and date and time (not a relative age); the selected row has an accent edge. The graph
  and the detail pane use tokens only. With four notes: four rows, one pressed, the detail pane filled.
- **Settings.** Six groups as sections. The reload row now has padding, and a "restart pending" badge and a count by "Pending
  restart" exist in the markup. The text lines, Preview, Save and Undo are as before.
- **Message.** Same form, capped at 640 px, with the shared field and label styles.
- **No page scrolls sideways** in any of the six views at 1440 or 390 in either theme (`scrollWidth` equals the viewport).

## AC7: glyphs

- A test fails if any of `○ ● × ‖ ⚑ ★ → ⟳` is back as a quoted string in the page, and one fails if an Office shape name is renamed.
  Both were run red (see below).
- The star, the stream arrow and the Office "checking" mark are Tabler `star`, `arrow-right` and `refresh` (the path data was compared
  with the upstream files, unchanged). The sprite has twelve symbols of the twenty allowed, and `THIRD_PARTY_NOTICES.md` names all of them.
- The Office conditions are drawn as shapes (ring, disc, cross, bars, raised hand), each next to its words. The condition names
  (`idle`, `busy`, `offline`, `paused`, `waiting`) are unchanged.
- Every icon use sits beside a text label or has an `aria-label`; a test counts the `icon()` and `officeIcon()` call sites.

## R5: Office colours and contrast

The Office rules already named colours only through `var(--token)`, so nothing was remapped. What changed is the checks:

- The colour-literal test no longer skips the Office block.
- A new test reads the tokens each Office rule uses, fails on a token it does not classify, and checks text tokens at 4.5:1 and mark
  tokens at 3:1 against the three Office surfaces (`--panel-soft`, `--panel`, `--control`), in both themes. The earlier R1 test
  already covered text, `--dot`, `--on-accent`, disabled controls and the peer palette.
- **Decision to review:** the hairline tokens `--line` and `--control-border` carry no information (room, desk and shelf edges,
  dividers) and measure 1.2 to 1.7:1 on those surfaces, so they are classified as separators and not held to 3:1. If a reviewer wants a
  3:1 edge, that is a colour change to the tokens, not a test change.

## Checks that were run red

Each was applied to the working tree, the tests run, and the file restored:

- an Office rule using an unknown token: the new Office token test failed;
- a `⟳` put back into the page script: the AC7 glyph test failed;
- the Office `ring` shape renamed in `office-model.ts`: the AC7 shape test failed.

## Not covered

- The Office was shot in Flat mode with five idle peers. The busy, offline, paused and waiting shapes, the checking icon and the
  approval hand were checked by the model tests and the DOM tests, not seen in a browser. Isometric was not shot.
- The "restart pending" badge on a setting row and the Pending restart count need a pending key, and the sample hub had none, so they
  were not rendered. They are covered by the DOM tests only.
- Memory's long-term and tasks tiers, and the graph with more than one hop, were not shot.
- Chrome only. Of the attached images, the Message and the dark Office were not looked at one by one.
