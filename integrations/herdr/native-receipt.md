# Herdr entry: native receipt (person-run leg)

**Status: NOT RUN.** This is the native open and disable receipt that #1199 H1 asks for. It cannot be produced by
code or by an agent: it needs the person's Herdr window, and driving that window would act on the person's live
workspace. Nothing in this repository claims it passed.

Use an **isolated profile**: set `HERDR_APP_HOME` to an empty scratch folder for a second Herdr window, or skip the
`keys.json` step and use the command palette in your own window. Never run the leg against terminals you care
about. Record ids, counts and yes or no, never a path, link or terminal content.

Each of the three claims is recorded **separately**. A passing `ahub console` does not prove the others.

## Claim 1: it opens the right thing (action count and observed result)

| # | Step | Record |
| --- | --- | --- |
| 1 | Copy `integrations/herdr/mod` to `<home>/mods/ahub`. Run `herdr-app check` on it | printed `check passed` (yes / no); Herdr version ___ |
| 2 | Open the dialog (`mod.open` with name `ahub`, by key or palette) | actions to open it: ___ ; it shows the right machine and folder (yes / no) |
| 3 | Select the project that contains the folder | actions: ___ (counted as selection) |
| 4 | Click **Open console** | actions after selection: ___ (target at most 2) ; a new tab appeared (yes / no); it runs `ahub --project <id> console` for the selected project (yes / no); it started on the space's machine (yes / no) |
| 5 | Select a project the folder is not inside, then **Open console** | opened the project you selected, not the folder's (yes / no) |
| 6 | **Open dashboard** on a local project | the existing local dashboard opened in the browser (yes / no); the dialog showed no link (yes / no) |
| 7 | **Copy command**, paste into a plain terminal | the pasted line starts `ahub --project '` (yes / no) and `ahub console` opens that project (yes / no) |
| 8 | Stop the hub (`ahub down` in that project), then **Open console** | refused with the `ahub up` instruction (yes / no); nothing started (yes / no) |
| 9 | Make the project folder name contain a space, a quote and a `$` | console opened that folder (yes / no); no extra file or command ran (yes / no) |

## Claim 1b (H2): the card and existing-terminal focus

| # | Step | Record |
| --- | --- | --- |
| 18 | Select a project with a running hub, click **Status** | the card shows task counts and peer states (yes / no); it is readable at the dialog size (yes / no); actions: ___ |
| 19 | Wait over a minute without clicking | the card still shows its numbers and then says the reading is old, and nothing refreshed it (yes / no) |
| 20 | Stop the hub (`ahub down`), click **Status** | the card names that no hub is running and the `ahub up` step (yes / no); nothing started (yes / no) |
| 21 | Open a console in a Herdr tab yourself (`ahub console`), switch to another tab, click **Focus console** | focus moved to that console's pane (yes / no); actions: ___ ; it was recognized (yes / no) |
| 22 | Do the same with a console started through a wrapper or alias | recognized (yes / no). A no is expected and acceptable: it should say no console was found and start nothing (yes / no) |
| 23 | Start two consoles for the same project, click **Focus console** | refused as ambiguous and neither was focused (yes / no) |
| 24 | Close the console, click **Focus console** | told no console was found (yes / no); a new terminal was NOT created (yes / no) |
| 25 | Click **Peek console** with one console running | Herdr showed its peek over the tab (yes / no) |
| 26 | Note the working or blocked word the dialog showed for the console | it matched what Herdr shows for that terminal (yes / no); no task, review or approval changed in ahub (yes / no) |

## Claim 2: remote (only if you have a machine; otherwise write "no remote machine")

| # | Step | Record |
| --- | --- | --- |
| 10 | In a space on a remote machine, open the dialog | the dialog names that machine (yes / no); the project list is that machine's (yes / no) |
| 11 | **Open console** | the tab is in the remote space (yes / no); nothing ran on this Mac for it (yes / no) |
| 12 | **Open dashboard** | refused, no link shown (yes / no) |
| 13 | Disconnect the machine, then **Open console** | refused, nothing opened (yes / no) |

## Claim 3: standalone and disable (separate from Claims 1 and 2)

| # | Step | Record |
| --- | --- | --- |
| 14 | With the folder `mods/ahub` absent, use Herdr and `ahub console` the normal way | both work exactly as before (yes / no) |
| 15 | With the dialog open, delete `mods/ahub` | what the open dialog did: ___ (record it: this was not observed before) |
| 16 | After deletion, count terminals, tabs and ahub agents | unchanged from before the dialog (yes / no); your layout, keys and settings untouched except the one `keys.json` line you added (yes / no) |
| 17 | Remove that `keys.json` line | nothing else needed removing (yes / no) |

Overall: PASS / FAIL / PARTIAL. Say which claims were run and which were not. A claim left blank is **not run**.
