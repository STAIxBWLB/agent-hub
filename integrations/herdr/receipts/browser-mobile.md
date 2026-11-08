# Receipt: browser client and mobile

**Verdict: unsupported. Status: NOT RUN.** Mobile availability is **not inferred** from SSH reachability, from a machine
being listed as ready, or from any other combination working.

What the installed Herdr says (a reading of its own files, not a receipt): `herdr.d.ts` declares `window().platform` as
`"linux" | "macos" | "windows"`, and the guide describes mods as native GPUI JavaScript with no DOM, webview or HTML. Neither
names a browser client or a mobile client for mods, and no leg was run on one. The absence of a mention is not a statement that
none exists: it only means this task has nothing to claim.

The ahub dashboard the mod can open is loopback-only with a one-time ticket, and its documented remote access is unsupported. A
remote space does not make that link local, and the mod never converts one for another device.

Person-run, on the devices that exist:

| # | Step | Record |
| --- | --- | --- |
| 1 | If Herdr offers a browser or mobile client, state which and its version | what it is: ___ ; or "none offered" |
| 2 | On it, find out whether mods are available at all | mods available (yes / no): state what you saw, not what a connection implies |
| 3 | If they are, install the mod in a scratch profile and run `herdr-app check` on the host that owns it | `check passed` (yes / no) |
| 4 | If the dialog opens there, click **Open dashboard** on a local project | no link was shown or opened on the other device (yes / no) |
| 5 | Remove `mods/ahub` | nothing else changed (yes / no) |
