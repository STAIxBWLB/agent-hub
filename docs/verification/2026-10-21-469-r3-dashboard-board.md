# #469 R3: dashboard board, side sheets and the Plan sheet

Task #172, branch `feat/469-r3-board` (on top of `feat/469-r2-shell`). R3 changes the cards, the task detail and where the five board
forms live. It keeps drag and drop, the Pull and Assign buttons, the Ready and Waiting subheads, "Show N older" and every action.

## Source

A scratch hub outside any git repository with its own `HOME` and `AGENTHUB_HOME` (never the person's home or live hub): five fake
pull-only peers, eight sample tasks (one in progress, backlog tasks, no owner on some). Headless Chromium (Chrome for Testing 156)
over the DevTools protocol with `prefers-color-scheme` emulated, at 1440x1000 and 390x900.

| What | image |
| --- | --- |
| Board 1440, light | `assets/469-r3-board-1440-light.png` |
| Board 1440, dark | `assets/469-r3-board-1440-dark.png` |
| Board 390, light | `assets/469-r3-board-390-light.png` |
| Detail sheet 1440, light | `assets/469-r3-detail-1440-light.png` |
| Detail sheet 1440, dark | `assets/469-r3-detail-1440-dark.png` |
| Detail sheet 390, dark | `assets/469-r3-detail-390-dark.png` |
| Plan sheet 1440, light | `assets/469-r3-plan-1440-light.png` |
| Plan sheet 390, light | `assets/469-r3-plan-390-light.png` |

## AC5: cards and the detail sheet

Measured in the page for eight cards at each of the four size and theme combinations:

- every card has two children (the head with the avatar and the title, and one line with the badge and the release chip), exactly one
  badge, exactly one owner avatar, and a title no taller than two lines (`title height / line height` was 2 at most);
- the page does not scroll sideways (`scrollWidth` equals the viewport at 1440 and 390);
- the detail sheet is open and pinned to the right edge at 1440 (x 920, width 520, the full 1000 px height) and fills the screen at 390
  (x 0, width 390, the full 900 px height); the Plan sheet likewise (x 880, width 560 at 1440).

The detail groups its lines into Status, People, Dates and Links. Each original line (class, stage, waiting, rework, check, SDLC,
overdue, owner, reviewer, guidance, description, planned and actual dates, release, GitHub link, pinned) appears exactly once, in its
group; a group with nothing to show is left out. Group headings are `h4`, not `h3`, because the board tests find the five columns by `h3`.

## AC6: the Plan sheet

The five forms (`planning`, `split-backlog`, `release-new`, `release-plan`, `propose`) moved out of five `<details>` blocks (plan, split, releases, delivery evidence, propose) into one native
`<dialog id="plan-dialog">` opened by a Plan button in the board toolbar. Their controls were compared with `origin/main`: identical
ids and order in all five (11, 4, 3, 6 and 5 controls), and every submit handler still attaches by id. The Releases panel, the delivery
evidence panel and the split panel keep their ids. A test now pins the full control list of each form.

## Not covered

- Drag and drop, hover and the pressed (dragging) shadow were not exercised in a browser: the drop handlers are unchanged and covered by
  the existing board tests, and the hover and drag styles are CSS only, read, not seen.
- Only the sample data above was rendered: no release chip, no GitHub link, no SDLC lifecycle and no rework round appear in the
  screenshots; those lines are covered by the DOM tests only.
- The sheet slide-in animation was not observed, and `Esc` rests on the native dialog.
- Chrome only.
