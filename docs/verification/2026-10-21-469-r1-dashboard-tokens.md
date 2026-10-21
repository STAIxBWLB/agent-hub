# #469 R1: dashboard design tokens, screenshots and layout check

Task #170, branch `feat/469-r1-tokens`. R1 changes the style block, the peer palette variants and the contrast test. It changes no
layout, view, key or behaviour.

## Source of the screenshots

A scratch hub created under a `mktemp`-style directory outside any git repository (its own `AGENTHUB_HOME`, never the person's
`~/.agenthub` or live hub), with five fake pull-only peers (claude, codex, kimi, pi, local), eight sample tasks (one in progress,
one backlog) and one console message. Rendered by a headless Chromium (Chrome for Testing 156) over the DevTools protocol with
`prefers-color-scheme` emulated, at 1440x1000 and 390x900. The Board view is shown: it is the default view, and the one R1's rules
touch most. The other views use the same tokens.

| | light | dark |
| --- | --- | --- |
| 1440 px | `assets/469-r1-board-1440-light.png` | `assets/469-r1-board-1440-dark.png` |
| 390 px | `assets/469-r1-board-390-light.png` | `assets/469-r1-board-390-dark.png` |

Computed `body` background in the run: light `rgb(238, 238, 241)`, dark `rgb(18, 19, 22)`; `scrollWidth` equals the viewport width at
both sizes in both themes (no sideways scroll).

## "No layout change", measured

The same sample hub was rendered from `origin/main` (c4b1c998) and from this branch, and the rectangles of the header, the nav, its
buttons, the board section, the progress strip, the agent slots, the columns and the cards were compared (148 rectangles over the
four size and theme combinations).

- Exact pixel equality does not hold, and is not claimed. R1 snaps spacing to the 4px scale, so three paddings grew from 10px to
  12px: the board column (`.board-column`, 10px to 12px: columns 600 px to 635 px tall at 1440), the agent slot
  (`.agent-slot`, 10px to 12px: 166 px to 178 px) and the 14px/18px section and row paddings moved to 12px/16px (`.section-head` 14px 18px to 12px 16px). Cards keep their height
  except one empty-state card (47 px to 68 px) and are 3 px narrower at 1440 because their column is 4 px narrower inside. Nav
  buttons are up to 4 px wider (control padding 6px/10px to 8px/12px; their 44 px minimum height hides the vertical change). The whole 390 px page is 78 px taller (2905 to
  2983) and the 1440 px page 16 px taller (1595 to 1611).
- Structure is identical in all 16 checks (4 selectors x 4 combinations): the same number of columns and rows, the same reading
  order, 5 board columns at 1440 and 1 at 390, 8 nav buttons in 1 row at 1440 and in 2 rows at 390, the same 3 card columns.
- Nothing scrolls sideways at 390 or 1440 px after the change.

## Not covered

- Only the Board view was photographed. Office, Stream, Agents, Message, Memory and Settings were not, so their light and dark
  rendering is covered by the token and contrast tests and by reading the CSS, not by a picture.
- 768 and 1024 px were not photographed (they belong to R2's AC3).
- Chrome only; no Firefox or Safari rendering was run.
