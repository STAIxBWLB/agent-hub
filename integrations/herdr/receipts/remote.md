# Receipt: remote space

**Verdict: unsupported. Status: NOT RUN.** Nothing here claims a remote result. No remote machine is configured on the
machine this was built on (`hc machine ls` lists none), so no `exec` with `on:` and no tab in a remote space was ever
observed. This file is the person-run leg for one selected remote console workflow. Until it is filled in and the matrix
is changed by a reviewed commit, remote stays unsupported.

What the mod does for a remote space, as designed and checked against fixtures only
(`test/herdr-companion-platforms.test.ts`): it reads that machine's registered projects with `exec(on: machine)`, proves the
selected folder resolves to the selected id there, and opens a new tab in that machine's space with `tab.new`, which takes no
machine because the space is the machine. **Open dashboard** refuses (`remote`), **Focus** and **Peek** refuse (`remote_focus`),
and **Copy command** names the machine to run it on. No link is ever converted.

Needs the person's machines and accounts, so it is person-run. Use an isolated Herdr profile and a machine you can afford to
touch. Record ids, counts and yes or no, never a host name, path, link or terminal content. Each claim is separate.

| # | Step | Record |
| --- | --- | --- |
| 1 | Add a machine in Herdr (Settings, Machines) and open a space on it | the space shows that machine's name (yes / no); `machines()` listed it as ready before you continued (yes / no) |
| 2 | On that machine, `ahub up` in a project; open the dialog from the remote space | the dialog names that machine (yes / no); the list is that machine's projects, not this Mac's (yes / no) |
| 3 | Select the project, click **Open console** | actions after selection: ___ (target at most 2); a new tab appeared in the remote space (yes / no); it runs the remote `ahub console` for the selected project (yes / no); nothing ran on this Mac for it (yes / no) |
| 4 | **Copy command**, paste it into a terminal on the remote machine | the pasted line starts `ahub --project '` (yes / no) and opens that project's console there (yes / no) |
| 5 | **Open dashboard** | refused with no link shown (yes / no) |
| 6 | **Focus console** and **Peek console** | refused as remote (yes / no); nothing focused or opened (yes / no) |
| 7 | **Status** | the card is that machine's project (yes / no); the project id matches (yes / no) |
| 8 | Disconnect the machine, then click **Open console** | refused, nothing opened (yes / no) |
| 9 | Remove `mods/ahub` | terminals, tabs and the remote hub unchanged (yes / no) |

Record `exec(on:)` behavior you had to guess at in H0: how a timeout or oversized output reaches the mod, and what `on: ""` means.
