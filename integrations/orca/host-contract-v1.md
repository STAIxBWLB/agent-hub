# Orca companion host contract v1

O0 of [#1198](https://github.com/STAIxBWLB/agent-hub/issues/1198), task #789.
Recorded 2026-11-08. This is a contract and fixture baseline, not an installed
companion or a native usability qualification. O1 implements entry points, O2
the public projection, and O3 qualifies additional platforms. No ahub runtime
change, plugin installation, terminal switch or personal profile write occurred.

## Evidence and version boundary

The installed CLI reports Orca **1.4.252**. Its own `orca plugin types <scratch>
--json` generated declarations into an otherwise empty scratch directory. This
command does not contact the app. The declarations establish supported authoring
shapes, not successful calls against a running plugin host.

The three primary references below are pinned at upstream commit
`9b98b38506069c1ace94bda8998043b627295b6d`, not a claim that this code is installed:

- [Host API](https://github.com/stablyai/orca/blob/9b98b38506069c1ace94bda8998043b627295b6d/docs/reference/plugin-host-api.md)
- [Authoring](https://github.com/stablyai/orca/blob/9b98b38506069c1ace94bda8998043b627295b6d/docs/reference/plugin-authoring.md)
- [Manifest](https://github.com/stablyai/orca/blob/9b98b38506069c1ace94bda8998043b627295b6d/docs/reference/plugin-manifest.md)

Generated declaration SHA-256:

- `orca/index.d.ts`: `286370934eeef4fe3460640b538dc0fa1f90692791161d4d3f86f44cf40690c1`
- `orca-worker/index.d.ts`: `c70f5ec6012570fd37a4e0be631e67cde9a7b447d65994010614a95a3d0c24bf`
- `orca-host/index.d.ts`: `c6b21b4dc243e3e2ff76d8f1b1a0427416392f96991e0cc22bc64f35621ea7a2`

The frame-facing `orca/index.d.ts` omits `workspace.list`, `workspace.open`,
`terminal.create`, `terminal.read` and `commands.run`, but the separate
`orca-host/index.d.ts` declares them for the worker surface. Worker authors import
`OrcaWorkerApi` as a type from `orca/worker`; `activate(orca)` receives the runtime
API, whose host types come from `orca/host`. These are not runtime imports.
Reading only the frame namespace gives an incomplete inventory.
The installed worker declarations agree with the pinned Host API reference.
The companion must still probe `host.has` on the actual surface: declarations
are not proof of a successful native call. Unknown methods retain a manual
command fallback. The machine-readable matrix is [host-contract-v1.json](host-contract-v1.json).

## Capability matrix

| Slice | Contract and authority | O0 verdict |
| --- | --- | --- |
| Worker execution | `trusted-worker` runs an approved `main` ES module in a separate Node process. Node child-process APIs are available; there is no documented `host.exec` method or host-enforced CLI timeout/output cap. The companion must own fixed executable/argv, host selection, cancellation and bounded output itself. A panel never executes a CLI. | Authoring contract present; actual plugin execution untested |
| Frame to worker | A panel asks its own worker through `plugin.request`; the documented request defaults to 30 s and permits at most 120 s, with cancellation. These are request bounds, not proof that a spawned descendant was stopped. | Declared in installed typings; native round trip untested |
| Focused context | `workspace.readContext` returns branch, display name and terminal ids, or null. It returns no workspace id, execution host or root. | Available in declarations; insufficient for automatic project selection |
| Workspace inventory | `workspace.list` is worker-only, requires `workspace:read`, and returns id/kind/name/path/branch/nullable hostId plus `truncated`. Its path is not asserted canonical by the API. | Declared in installed worker typings; native call untested |
| Workspace navigation | `workspace.open` takes an exact workspace id, requires `workspace:write` and is worker-only. Opening a workspace is not terminal focus. | Declared in installed worker typings; native call untested |
| Open console | An explicit Open console action may create a terminal using the existing ahub terminal-opening path and its quoting/identity checks. It must not masquerade as Focus existing console. | Existing ahub implementation; plugin end-to-end proof belongs to O1 |
| Open dashboard | Prefer installed `ahub ui`. A frame cannot fetch/embed it. `shell.openExternal` is a desktop frame call requiring a current user gesture; a worker cannot invoke it. An unknown web host can require consent. | Frame API declared; actual open/consent behavior untested |
| Existing terminal focus | Plugin terminal ids are shared among context/agent/send/read methods. CLI `terminal switch` takes a runtime-issued handle scoped to its execution server. The references do not equate those identifiers. No host terminal-focus method is documented. | Unsupported until an exact same-host mapping and freshness proof exist; workspace/manual navigation only |
| Remote, Windows, browser/mobile | A Node worker runs where its Orca host runs, which need not be the selected workspace's machine. Remote loopback is not local browser loopback. Browser clients lack desktop external navigation. | Unqualified individually; never execute a remote path locally |

## Terminal focus recheck (O4, 2026-11-09)

**Orca 1.4.254: unsupported; plugin terminal id to CLI handle remains unproven.**
This recheck changes no runtime code. The O0 version and hashes above remain the
original baseline; the O4 evidence is recorded separately in the JSON matrix.

Read-only evidence from the installed distribution:

- `orca --version` returned `1.4.254`. `orca plugin types <empty-scratch> --json`
  succeeded offline; its `orca`, `orca/worker` and `orca/host` declaration hashes
  are identical to the O0 hashes above.
- The shipped `plugins/types/orca-host.d.ts` declares `workspace.readContext`
  terminal `{ id, title? }`, `agents.list` terminalId, and `terminal.create`,
  `terminal.sendText` and `terminal.read` using terminalId. It declares no terminal
  focus/switch method or equivalence between terminalId and a CLI handle. The
  generated and shipped declarations were both inspected; their separate hashes
  are retained in `terminalFocusRecheck.shippedTypes` in the JSON matrix.
- `orca terminal switch --help` accepts a runtime-issued handle. Its help states
  handles belong to the issuing server; this is not a plugin-id mapping.
- `orca terminal list --limit 10000 --json` succeeded: 42 rows, `totalCount: 42`,
  `truncated: false`, hostScope `hostIds: [local]`, no omitted hosts. Its envelope
  includes `_meta.runtimeId`; its result includes `topologyRevisions`. Rows expose
  `handle`, `ptyId`, `incarnationId`, `worktreeId` and `executionHostId`, but no
  plugin terminalId field or statement equating a plugin id with any of them.
  These fields could support freshness checks only after an identity mapping is
  established. Names, titles, branch labels and apparent string similarity do
  not establish that mapping. No terminal text or live identifiers are retained
  in this contract.

No plugin was loaded, no live terminal was switched, driven or replaced, and no
plugin-host result was observed. Shipped declarations and CLI inventory alone
cannot establish a current same-host binding. A future proof must bind the exact
plugin id, CLI handle, workspace and execution host, recheck the runtime and
terminal incarnation before each focus, and refuse missing, stale, ambiguous or
cross-host bindings. Until then the existing command (`ahub console`, or `acon ui`
for the family console) and workspace/manual navigation remain the fallback.
The native focus leg remains **person-run, NOT RUN** in
[native-receipt.md](native-receipt.md); there is no focus action to qualify today.

## Exact selector and execution contract

The person selects an explicit inventory row. Its binding contains the exact
workspace id, execution host and real project root established on that host.
Names and branches are display only. A nullable hostId cannot be silently treated
as local: the provider must establish what it means for that host/version.

Before each effect, re-read a complete inventory and match all bound identity
fields. Missing, duplicated, truncated, contradictory or changed identity refuses
with a refresh/select-again command. Canonicalize the root on the selected host;
never resolve a remote path on the Mac or join a project root from display names.
An unavailable inventory cannot be reconstructed from focused context.

The current CLI has a separate `orca worktree list --json` contract with host
coverage and truncation. It is not the plugin `workspace.list` response and does
not enumerate all folder workspaces. Any fallback must parse that CLI's actual
versioned shape, retain coverage, bind the exact host, and reuse existing
`src/hub/terminal-open.ts` / `src/cli/terminal-recovery.ts` checks. O0 does not
introduce another resolver, terminal backend or recovery state machine.

CLI calls use an installed executable and separate argv elements. Paths containing
spaces, quotes, shell metacharacters and Unicode remain opaque arguments. A host
that requires a shell command uses the existing `shellQuote` boundary; a raw
project string must never become code. No background setup/start, approval, task,
retry, stop, upgrade, agent launch or new polling is part of the companion.
Approved host-call capabilities do not confine a trusted Node worker's filesystem
or child processes. Fixture refusals model the companion contract, not a security
sandbox for malicious plugin code.

`ahub ui --no-open` returns plain text, not JSON. A future external-open path must
accept exactly one expected local loopback URL and handle its one-time ticket
transiently, without logs or stored output. O0 does not implement that parser.
Remote UI opening stays unsupported without a separately qualified endpoint;
show the remote-console command instead. Persist only owned UI preferences and
non-authoritative selection hints, never CLI output, tickets, credentials or task
text. Status uses existing public fields and preserves unknown/offline/stale states.

## Baseline journeys and counting boundary

These are reproducible **manual baseline procedures**, not observed native UI
measurements. Counts below are procedure counts; observed counts and native
results remain unknown. Start with an already initialized/running hub and installed
CLI. Selection is counted separately. One click/key chord or one submitted command
is one action; text entry within that command is included, waiting is not an action.
The start boundary is the selected exact workspace in Orca, with no console tab
assumed. The end is the existing screen visibly open. These procedures perform no
task, approval, agent lifecycle or configuration mutation.

| Journey | Selection (separate) | After-selection baseline | Procedure count | Observed result |
| --- | --- | --- | ---: | --- |
| Local console | 1 explicit workspace selection after machine/root inspection | Open a terminal there; submit `ahub console` | 2 | Not run in isolated native profile |
| Local dashboard | 1 explicit local workspace selection after machine/root inspection | Open a terminal there; submit `ahub ui`; handle any actual browser-consent prompt separately | 2 plus consent if present | Not run in isolated native profile |
| Remote console | 1 explicit remote workspace selection after machine/root inspection | Open a terminal on that host; submit `ahub console` there | 2 | Remote host not qualified; no local execution fallback |

O1's target is at most two explicit actions after selection to the local existing
screen. It must record actual UI actions, outcome and standalone/disable results
separately from successful CLI exit. The local and remote baselines above are not
evidence that this target has been met; remote and browser consent can add steps.

## Install, disable and ownership

O0 ships no `orca-plugin.json`, command registration, worker, panel or automatic
setup hook. Nothing here enables a companion. A future optional artifact uses
manifest v2, an explicit engine floor and `pluginApi: 1` when it calls the API;
capabilities match the minimum methods actually used. No hooks, action replacement
or `agent:launch` authority are needed for this contract.

The person's explicit `orca plugin install <source>` first returns the authority
review for code. Approval uses the fingerprint the host just returned, bound to
its exact files/version/access; documentation supplies no saved approval. A local
folder belongs to the target Orca host, not necessarily this Mac. A development
load is also explicit and requires approval. O1 native tests must use an isolated
profile, not this person's installed plugins/settings.

The person can run `orca plugin disable <key>` without approval. Installed removal
uses `orca plugin uninstall <key>`; development folders use `orca plugin dev unload`.
Those commands concern the companion's owned artifact only. Its deactivation must
not stop agents, remove worktrees, edit hub state, restore unrelated settings or
change the existing ahub/Orca functionality. Native disable/standalone proof is
still required in O1; a fake's immutable state is not that proof.

## Fixture contract and acceptance ceiling

`test/helpers/orca-companion-host.ts` offers only explicitly configured methods
and synthetic roster state. `test/fakes/orca-companion-cli.ts` is a separate
scripted CLI port, not a fabricated host API. `test/orca-companion-contract.test.ts`
checks their negative and identity cases without invoking Orca, ahub, a real HOME
or a network service. O1/O2 reuse these fixtures while testing their own worker
and panel. A fake cannot establish installed host capabilities, terminal handle
equivalence, native UI improvement, remote reachability or security confinement.
