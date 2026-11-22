# #1483 R5: the dashboard Roadmap view

Task hub task 964, branch `feat/964-roadmap-r5`. R5 adds the Roadmap view to the dashboard: a tab at key 8 with Now, Next and Later
lanes, one card per milestone, a detail dialog and an unplaced tray.

## Source

A scratch hub outside any git repository (`git rev-parse --show-toplevel` at its root prints "fatal: not a git repository (or any of the
parent directories)") with its own `HOME` and `AGENTHUB_HOME` under `/tmp`, never the person's home and never the live hub. Three
milestones (1 "Ship the roadmap view", active in Now with tasks 1 and 2 linked; 2 "Console roadmap panel", proposed in Next; 3
"Roadmap drift on the board", proposed in Later) and two backlog tasks.

Headless Google Chrome 157 over the DevTools protocol (`Target.createTarget` and `attachToTarget`, `Emulation.setDeviceMetricsOverride`,
`Network.setCookie` for `agent-hub-theme` and `agent-hub-view`, `Page.captureScreenshot` with `captureBeyondViewport`). The dashboard
ticket is single-use and expires in about a minute, so one fresh ticket was minted per browser session. Console errors and warnings were
collected through `Log.entryAdded` and `Runtime.exceptionThrown` for every shot.

| What | image |
| --- | --- |
| Roadmap 1440, light | `assets/1483-r5-view-1440-light.png` |
| Roadmap 1440, dark | `assets/1483-r5-view-1440-dark.png` |
| Roadmap 820, light | `assets/1483-r5-view-820-light.png` |
| Roadmap 820, dark | `assets/1483-r5-view-820-dark.png` |
| Roadmap 390, light | `assets/1483-r5-view-390-light.png` |
| Roadmap 390, dark | `assets/1483-r5-view-390-dark.png` |
| Detail dialog 1440, light | `assets/1483-r5-detail-1440-light.png` |
| Detail dialog 390, light | `assets/1483-r5-detail-390-light.png` |

## AC1 to AC3: the view, its lanes and its cards

Measured in the page for every shot, not read off the source:

- the Roadmap tab is the current tab (`aria-current="page"` on `data-view-target="roadmap"`) and the section is shown, at all three widths
  in both themes;
- three lanes, each headed `Now (1)`, `Next (1)` and `Later (1)`, hold three milestone cards in total;
- the first card reads "Ship the roadmap view", the milestone the hub puts first in Now;
- the tray reads "Everything is placed." with `0 unplaced`, so the empty answer repainted instead of staying at "Reading unplaced
  items...";
- the theme took effect per shot (body background `rgb(238, 238, 241)` in light, `rgb(18, 19, 22)` in dark);
- the page does not scroll sideways: `scrollWidth`, `body.scrollWidth` and `innerWidth` are equal at 1440, 820 and 390.

## AC4: the detail dialog

Opened by clicking the first card, at 1440 and at 390: `dialog.open` is true and its title reads "Milestone #1". The dialog carries the
Manage section (horizon, state and the ordered move buttons) and the Linked section, which lists tasks 1 and 2 for that milestone.

## AC5: no console noise

`problems` is empty for all eight rows: no `Log.entryAdded` at error or warning level and no `Runtime.exceptionThrown`.

## Not covered

- Drag and drop between lanes was not exercised in a browser. The page half (carrying the rendered revision with the drop) is pinned by
  `test/ui-roadmap.test.ts`; the daemon half, including the refusal of a stale revision, by `test/ui-roadmap-daemon.test.ts`.
- The Move up and Move down buttons were not clicked through in the browser; their payload and the hub's renumbering are pinned by the
  same two tests.
- "Check drift" was not run from the page: the shots show "Drift not checked yet". The drift note, its per-milestone count and the
  console's five-minute cache are covered by `test/ui-roadmap.test.ts` and `test/console-roadmap.test.ts`.
- The Milestone board filter and the console Roadmap panel (tab 9) were not part of this browser run: the filter is pinned by
  `test/ui-roadmap.test.ts`, the panel by `test/console-roadmap.test.ts` and `test/ui-roadmap-daemon.test.ts`.
- Only the scratch data above was rendered: three milestones, two linked tasks, nothing private, so a withheld count and a private card
  never appear in these images.
- Chrome only.
