# #469 R6: keyed rendering, quiet motion, and loading, empty, disconnected and toast states

Task #174, branch `feat/469-r6-motion` (on top of `feat/469-r4-views`). The poll interval, every action, authority rule and pinned
element id are unchanged.

## Source

A scratch hub outside any git repository with its own `HOME` and `AGENTHUB_HOME` (never the person's home or live hub): five fake
pull-only peers and eight sample tasks, plus a second hub with no peers and no tasks for the empty views. Headless Chromium over the
DevTools protocol with `prefers-color-scheme` emulated, at 1440x1000 and 390x900. `/snapshot` was held, failed and released through
the DevTools Fetch domain to produce the skeleton and the disconnected state.

| What | image |
| --- | --- |
| Skeleton, board 1440 light / 390 dark | `assets/469-r6-skeleton-1440-light.png`, `assets/469-r6-skeleton-390-dark.png` |
| Toast stack 1440 light / dark, 390 light | `assets/469-r6-toasts-1440-light.png`, `assets/469-r6-toasts-1440-dark.png`, `assets/469-r6-toasts-390-light.png` |
| Disconnected 1440 light / dark, 390 dark | `assets/469-r6-disconnected-1440-light.png`, `assets/469-r6-disconnected-1440-dark.png`, `assets/469-r6-disconnected-390-dark.png` |
| Empty board 1440 light / dark | `assets/469-r6-board-empty-1440-light.png`, `assets/469-r6-board-empty-1440-dark.png` |
| Empty peers 390 light / dark | `assets/469-r6-agents-empty-390-light.png`, `assets/469-r6-agents-empty-390-dark.png` |
| Board after load 1440 light, 390 dark | `assets/469-r6-board-1440-light.png`, `assets/469-r6-board-390-dark.png` |

## AC8: keyed rendering

How it works: a keyed pass (`keyedStart`) hands out one node per key. A card, peer row or memory row whose JSON signature is the same
as last time is the same node; a changed one is rebuilt (its listeners close over its data, so it is replaced, not patched) and, if
it held focus, `update()` hands the focus to the replacement. Keys that are gone are dropped. The card signature includes the
board context, the capabilities its buttons depend on and the release name, so a change to any of those rebuilds the card.

- **vm tests** (`test/dashboard-motion.test.ts`), on the real board code and the real `update()`: after a poll that changes one
  task the other three cards are the same objects, the changed one is new, and a focused card keeps focus; a focused card that
  itself changes passes its focus to its replacement; an unchanged poll leaves `children` as the same array; a gone card is removed
  and the rest are untouched; a card that changes capability is rebuilt.
- **Chrome**, four theme and size combinations: focus the first card, add a task, wait three polls: `document.activeElement` is
  still that card, it is still connected, and the three cards after it are the same nodes (`3/3`), with the card count up by one.

## AC9: motion, states

- **Motion test over the CSS:** every `transition` is `none` or on `transform` or `opacity` only, 120 to 200 ms (the Office's own
  .8 s transform move is pinned elsewhere and allowed up to .8 s); every `@keyframes` moves only `transform` and `opacity`; every
  animation names one of the known keyframes at 120 to 200 ms (the Office ones keep their pinned timings); the only `infinite`
  animation in the page is the Office pulse; and one `@media(prefers-reduced-motion:reduce)` rule turns `transition` and
  `animation` off for `*`, `*::before` and `*::after`.
- **Chrome with reduced motion emulated:** computed styles at 1440. With no preference: view animation `view-in` 0.16 s, button
  transition 0.12 s, card transition 0.15 s, toast `toast-in`. With `reduce`: all four are `none` or `0s`.
- **Skeleton:** five column blocks on the board and three bars in the peer list, `aria-hidden`, with the text "Loading the board..."
  next to them. With `/snapshot` held they were on screen; after release `.skeleton` was gone from the page (0 left). They do not
  animate.
- **Empty views:** the board, peers, stream, approvals, memory (three cases) say what fills them and the command. Every command they
  name is in `ahub help` (a test). The empty hub showed the board and peers texts in Chrome.
- **Disconnected:** with `/snapshot` failing, `main` gets `data-stale`, its content measured `opacity 0.6`, the status read
  "Disconnected / retrying: Failed to fetch", and the line read "Last snapshot at 10:43:11 PM. Polling continues every second."
  After the fetch came back both were cleared. Seen at 1440 and 390, light and dark.
- **Toasts:** three notices (one success, two errors) gave a stack of three with a Dismiss button each, the box inside the viewport
  and no sideways scroll (`scrollWidth` equals the viewport). Five seconds later the success had faded and both errors were still
  there; pressing Dismiss on each left none. Test: four at most, the same text replaces its toast, an empty text clears the stack,
  the fade starts at 4 s and the removal 160 ms later, an error never expires, reduced motion keeps a success.

## Pinned contracts changed (named, nothing loosened)

- `test/ui.test.ts`: it read `#notice` as one element (`textContent`, `error`). With a stack those two reads come from the newest
  toast, defined once in the harness. Every assertion below is unchanged.
- `test/dashboard-views.test.ts`: it pinned five `setTimeout(` calls in the page. The five are still there; `notice()` adds two
  (the fade and the removal), and the test now pins both counts, so a timer anywhere else still fails it.
- The card's own transition was `transform .15s, box-shadow .15s`. It is `transform .15s` now, because the spec limits motion to
  `transform` and `opacity`; the hover shadow still appears, without easing.
- `update()` gained focus carry-over and `resetView` clears the keyed caches; neither changes the signature fast path.

## Checks that were run red

Each applied to the page, the new tests run, the file restored: a cache that never hits; no focus hand-off; a success toast that
never fades; an error toast that fades; a `width` transition; a weakened reduced-motion rule; an `infinite` card animation; a
disconnected line never cleared; an animated skeleton; a capability left out of the card signature. Each failed the test written
for it.

## Not covered

- Peer rows and memory rows use the same keyed pass, but only the board's cards were driven through a poll in a browser and in the
  vm tests; the peer and memory paths are covered by the shared pass test and by the existing tests, which still pass.
- A card that is replaced and was hovered loses its hover until the pointer moves. That is the browser's behaviour for a new node.
- The card's enter animation and the toast's fade were checked by computed style and by the test over the CSS, not watched.
- Dragging a card across a poll was not exercised.
- Chrome only. The dark skeleton, the 390 empty board and the Stream's empty text were not looked at one by one.
