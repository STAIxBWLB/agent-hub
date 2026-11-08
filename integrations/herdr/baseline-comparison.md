# Herdr entry: baseline comparison (H3)

H3 of [#1199](https://github.com/STAIxBWLB/agent-hub/issues/1199). It compares the entry's journeys with the three
[H0 baseline journeys](host-contract-v1.md). **Every figure here is a procedure count. Nothing was observed in a native Herdr
window**: the observed column is `not run` for every row until a person fills in the
[native receipt](native-receipt.md) and the remote [receipt](receipts/remote.md). One click or one submitted command is one
action, and waiting is not an action. Selection is counted separately, as the issue asks.

## The same journeys, counted both ways

The start boundary is the exact space already selected in Herdr. The end is the existing screen visibly open.

| Journey | H0 baseline (no mod) | With the entry | After project selection (AC2 target: at most 2) | Observed |
| --- | ---: | ---: | ---: | --- |
| Local console | 2: new tab, submit `ahub console` | 3: open the dialog, select the project, click **Open console** | 1 | not run |
| Local dashboard | 2: new tab, submit `ahub ui` (browser consent separate) | 3: open the dialog, select the project, click **Open dashboard** | 1 | not run |
| Remote console | 2 in that machine's space | 3: open the dialog, select the project, click **Open console** (or **Copy command** and paste: 4) | 1 | not run, no machine configured |
| Existing local console | not countable: look through tabs, then click | 3: open the dialog, select the project, click **Focus console** | 1 | not run |

## What this does and does not show

- **AC2 is met as a count**: after the project is selected, opening the console is one click, within the target of two. That is a
  procedure count, not a measurement.
- **No action-count gain is claimed, and in the common case there is none.** When the focused pane is already in the right project,
  the baseline is 2 actions in total and the entry is 3, so it costs one more. The entry does not shorten that path.
- **What it adds instead is correctness and safety**, which this task did not measure and a native receipt would have to show:
  the machine and the real project root are shown and bound before anything opens, a wrong, moved, duplicate or offline
  project refuses instead of opening the wrong thing, a remote project gets the right machine or a copyable command and never
  a converted link, and an existing console can be found without searching tabs (not countable in the baseline).
- Whether those are worth the extra action is the person's judgment. This document does not make that call.
- The two journeys that depend on a machine or on Herdr's focus behavior (remote, existing console) stay unmeasured until their
  person-run receipts exist. A combination without a receipt stays `unsupported` in the [support matrix](support-matrix.json).

## How to turn these into measurements

Run native-receipt.md Claim 1 and 1b for the local rows and receipts/remote.md for the remote row, writing the actions you
actually took and what you saw. Replace `not run` only with what a person recorded. Do not copy a procedure count into the
observed column.
