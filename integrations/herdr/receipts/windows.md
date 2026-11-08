# Receipt: Windows

**Verdict: unsupported. Status: NOT RUN.** Nothing here claims a Windows result.

On a window whose `window().platform` is `windows`, every action of the entry refuses with `unsupported_platform` and nothing
runs, for a local space and for a remote one alike (the first read refuses, so no project can be selected) (fixture-checked in `test/herdr-companion-platforms.test.ts`, with the platform injected). The reason is concrete: the mod's
folder handling and the copyable command use POSIX paths and POSIX single-quoting, and the project-containment rule only accepts
paths that start with `/`. None of that is right for `cmd.exe` or PowerShell, and Windows paths and quoting were not exercised.

To qualify Windows, a person on a Windows machine must run this leg, and the code must first gain a Windows path and quoting
boundary that this leg then proves. Do not loosen the identity checks to make it pass.

| # | Step | Record |
| --- | --- | --- |
| 1 | Install Herdr and ahub on Windows, copy the mod to a scratch profile, run `herdr-app check` | `check passed` (yes / no); Herdr version ___ |
| 2 | Open the dialog | the actions refuse with the Windows sentence (yes / no); nothing ran (yes / no) |
| 3 | (After a Windows-specific change) a folder with a space and `&` in its name | the right project opened (yes / no); no shell expansion of the folder name (yes / no); actions: ___ |
| 4 | Remove `mods/ahub` | terminals, tabs and agents unchanged (yes / no) |
