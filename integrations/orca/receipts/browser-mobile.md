# Receipt: browser client and mobile

**Verdict: unsupported. Status: NOT RUN.** Mobile availability is **not inferred** from SSH reachability,
from a successful remote connection, or from Orca offering mobile pairing.

What the references say (not a receipt): Orca's plugin host API makes `shell.openExternal` a desktop-app-only call,
and the authoring reference says that in a browser client `orca.shell` and `orca.files` are undefined and
`orca.host.has` answers false. Orca's CLI lists `orca serve --mobile-pairing`, which is about pairing the server and
says nothing about whether plugin panels run on mobile.

What the companion does without a receipt (fixture-checked): when the panel's client has no external navigation, an
`ahub ui` link is never held or shown; it says to run `ahub ui` on the machine that runs the project. A loopback
link is not a usable destination in another device's browser in any case.

Person-run, on the devices that exist:

| # | Step | Record |
| --- | --- | --- |
| 1 | Open Orca in a browser client (`orca serve` and a browser) with the plugin enabled | the plugin panel is available (yes / no) |
| 2 | If it is, select a workspace and click **Open dashboard** | no link was shown or opened (yes / no); the sentence told you to run `ahub ui` (yes / no) |
| 3 | Open Orca on a phone or tablet client, if you use one | the plugin panel is available (yes / no): state what you saw, not what pairing implies |
| 4 | Disable the plugin | nothing else changed (yes / no) |
