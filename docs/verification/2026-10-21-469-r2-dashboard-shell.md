# #469 R2: dashboard app shell, screenshots and width check

Task #171, branch `feat/469-r2-shell` (on top of `feat/469-r1-tokens`). R2 adds the shell (top bar, sidebar or tabs), the icon sprite
and the view keys. It keeps the view names, their order, the `agent-hub-view` cookie, the pinned ids and every action.

## Source

A scratch hub outside any git repository, with its own `HOME` and `AGENTHUB_HOME` (never the person's home or live hub): five fake
pull-only peers, sixteen to twenty-four sample tasks, one console message. Headless Chromium (Chrome for Testing 156) over the
DevTools protocol with `prefers-color-scheme` emulated. Every one of the seven views was visited at 1440, 1024, 768 and 390 px in
light and dark (56 combinations), and one representative set is kept here.

| View and size | image |
| --- | --- |
| Board 1440, light | `assets/469-r2-board-1440-light.png` |
| Board 1440, dark | `assets/469-r2-board-1440-dark.png` |
| Board 1024, light | `assets/469-r2-board-1024-light.png` |
| Board 768, light (tabs) | `assets/469-r2-board-768-light.png` |
| Board 390, light | `assets/469-r2-board-390-light.png` |
| Board 390, dark | `assets/469-r2-board-390-dark.png` |
| Agents 1440, dark | `assets/469-r2-agents-1440-dark.png` |
| Agents 768, dark | `assets/469-r2-agents-768-dark.png` |

## AC3: nothing scrolls the page sideways

Measured in the page, not assumed: for each of the 56 combinations the document's `scrollWidth` was compared with the viewport width
and every element past the right edge (outside the nav) was listed.

- 1440 px: `scrollWidth` 1440 in all 14 view and theme combinations. 1024 px: 1024. 768 px: 768. 390 px: 390.
- No element extended past the viewport in any of the 56 combinations.
- The nav is a column of width 199 px at 1440 and 1024, and a row at 768 and 390 whose own `scrollWidth` (769) exceeds its
  `clientWidth` (768 or 390): the tabs scroll inside the nav, as designed, and the page does not.
- The top bar is 61 px tall from 1024 px up and 129 px at 768 and 390 (it wraps below 1024 px; the screenshots show it).

## AC4: keys

Tested through the page's own handler in the navigation test harness (`test/dashboard-views.test.ts`): `1`-`7` switch the seven
views in order and write the cookie, `?` opens the key list, the buttons open and close it, and view keys are ignored inside an
input, a textarea, a select, an editable node, with Ctrl, Alt or Cmd held, and while the key list or the task detail is open.
`Esc` is the native dialog's own close and is not handled by the page. Six deliberate breakages of the key handler each fail a test (a seventh, accepting multi-character keys such as `01`, first survived and led to a stronger test), and eight breakages of the sprite, labels and shell CSS each fail a test too. Not covered: a
real browser key press (no browser-driven test of the keys was run), and `Esc` itself, which rests on the dialog element.

## Icons

Nine Tabler Icons (outline) in one inline sprite, path data copied unchanged from tabler-icons; the MIT notice is in
`THIRD_PARTY_NOTICES.md`. A test checks the count (at most 20), one stroke width, path-only symbols, no external reference, no
unused or undefined symbol, `aria-hidden` on every icon, and a text label or `aria-label` next to each.

## Not covered

- Screenshots show Board and Agents only, at the sizes above; Office, Stream, Message, Memory and Settings were measured for width
  but not photographed.
- Chrome only. The sidebar's sticky height uses `100vh`, which on a mobile browser with a collapsing toolbar was not tried.
- The "tabs scroll sideways" behaviour at 390 px is shown by the cut-off fourth tab in the screenshot, not by a scroll gesture.
