# Receipt: remote workspace

**Verdict: unsupported. Status: NOT RUN.** Nothing here claims a remote result. This file is the person-run leg
for a remote (SSH or paired) Orca workspace. Until it is filled in and the matrix is changed by a reviewed
commit, a remote workspace is refused: nothing runs on this Mac and no loopback link is opened locally.

What is already true without a receipt (checked against fixtures, in `test/orca-companion-platforms.test.ts`):
a workspace whose host id is not listed as this Mac is refused with `remote`, before `ahub` runs, and the person
is shown `'ahub' 'console'` to run on that host.

Needs the person's machines and accounts, so it is person-run. Record ids and counts only, never a host name,
path, link or terminal content.

| # | Step | Record |
| --- | --- | --- |
| 1 | Pair a second Orca host or open an SSH workspace in an **isolated** profile | how the workspace appears in the plugin's list: its host id is non-null (yes / no), and it is not selectable (yes / no) |
| 2 | Select it if it is selectable and click **Open dashboard** | `ahub` did not run on this Mac (yes / no); the panel shows the `ahub console` command (yes / no) |
| 3 | Run that command on the remote host | the existing remote console opened (yes / no); actions counted: ___ |
| 4 | Declare the remote host id as this Mac in the settings on purpose (a deliberate wrong setting) | the companion now ran `ahub` on this Mac against a folder that is a *different* project: record whether the folder existed here (it must not bind: `unreal_root`) |
| 5 | Disable the plugin | agents, worktrees and terminals unchanged (yes / no) |

A supported remote path would need its own acceptance leg and a proven endpoint (the issue forbids a new
proxy, tunnel or auth system); until then the existing remote console and the copyable command are the path.
