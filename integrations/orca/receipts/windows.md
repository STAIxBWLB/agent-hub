# Receipt: Windows desktop

**Verdict: unsupported. Status: NOT RUN.** Nothing here claims a Windows result.

On win32 the companion refuses every workspace with `unsupported_platform` and runs nothing (fixture-checked in
`test/orca-companion-platforms.test.ts`, with `platform` injected). The reason is concrete: the console and family
console entries send a POSIX-quoted command line (`'ahub' 'console'`), and the executable rule expects a file named
`ahub`; neither is right for `cmd.exe` or PowerShell, and Windows paths and quoting were not exercised.

To qualify Windows, a person on a Windows machine must run this leg, and the code must first gain a Windows
quoting boundary and executable rule that this leg then proves. Do not loosen the identity checks to make it pass.

| # | Step | Record |
| --- | --- | --- |
| 1 | Install Orca and ahub on Windows, load the plugin in an isolated profile | Orca version; ahub version; the plugin loaded (yes / no) |
| 2 | Open the panel with a workspace whose folder has a space and a `&` in its name | each row is refused with the Windows sentence (yes / no); nothing ran (yes / no) |
| 3 | (After a Windows-specific change) select it and open each entry | actions counted: ___; the right project opened (yes / no); no shell expansion of the folder name (yes / no) |
| 4 | Disable the plugin | agents, worktrees and terminals unchanged (yes / no) |
