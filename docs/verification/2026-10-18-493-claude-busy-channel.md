# Busy Claude channel notification receipt (#493)

## Result

Positive native interactive receipt: Claude Code 2.1.302, Sonnet 5.5 (the native
`sonnet` alias), consumed a channel notification during the original busy turn.
The model called the observation tool with the exact random token before its
first `end_turn`. This supports important-only channel steering in the tested
interactive mode. It does not prove an arbitrary notification was read merely
because its stdout write succeeded, nor does it prove delivery in print mode.

## Native experiment

- A new scratch project outside the repository used one explicitly selected
  development MCP channel, `busy-probe`. The harness preserved the executing
  agent marker, removed live hub binding variables, loaded no project/user
  settings or hooks, and exposed only three fixed fixture tools. It connected
  neither to the person's hub nor to another peer.
- The original instruction called `probe_hold`, then `probe_after_hold`, then
  finished with `DONE`. It also asked the model to report any actually observed
  channel token, without inventing one. The token was generated only after
  `probe_hold` started; neither the prompt nor the hold result contained it.
- While that tool was pending, the MCP server wrote
  `notifications/claude/channel` with `priority: important` and the random token.
  The fixed hold result contained only `ready: true`.
- The interactive run used a real PTY. The operator confirmed that this was a
  locally written development channel. No trust or tool-approval prompt was
  answered automatically, and no second model prompt was sent. After the
  original response completed, the operator exited with Ctrl-D.

| Evidence | UTC on 2026-10-18 |
| --- | --- |
| Native tool barrier entered | 07:25:36.997 |
| Notification written while tool pending | 07:25:37.298 |
| Fixed hold result released | 07:25:38.801 |
| Correct token received by observation tool | 07:25:41.948 |
| First original assistant `end_turn`, `DONE` | 07:25:43.016 |

The native transcript's zero-based record positions were 29 for the hold call,
49 for the matching observation call, and 52 for the first original `end_turn`.
The observation was after the tool barrier released but before that original
turn ended. The TUI also displayed the channel notification during its busy
indicator. Native exit was 0; process-table verification found no remaining
probe-owned native, helper or MCP server processes. The 90-second deadline did
not fire.

The automatic resource controller initially deferred on ordinary Teams/Jump
Desktop processes with no repository attribution. Manual inspection identified
their application origins and confirmed normal memory/thermal state, CPU idle
above 50%, no competing repository job and one probe worker. No existing app
was stopped. Native account/session metadata writes were not suppressed or
audited; this receipt does not claim the native client made no home-directory
writes.

## Preserved evidence

Private run artifacts are retained under workspace-relative
`scratchpad/temp/ahub-493-probe/interactive-zaTWkS/`; the invocation receipt points
to the native client's own transcript. Raw account/profile paths and the random
token are not copied into this document.

| Artifact | SHA-256 |
| --- | --- |
| `receipt.json` | `5108a491e3469baf9de67860d7d3fff37b5eb89b980fa9f1835ff28510f524b7` |
| `server-events.jsonl` | `43b079866ec2c8ac0437d51d2fd50549fec035b1a76feaa8c20142a58cdb1258` |
| `native-tui.log` | `2fc9182a355038c0b26d662054ee7abee9fda78569ea6b07893afeb44fd6da51` |
| `pty-events.jsonl` | `5ab8c672ea56512a6bdce111fe6960fc85ceb47ff88d7a1b17d528b1fdb10229` |
| Native transcript | `0acfd6f66ec20f0cb5ad4fe020d044e326c240289019785c15f3af64ca188ede` |

Token SHA-256:
`ea4326fdc248ddc69ba250005a472f5393c2250b1876fbe039cbef0561125d08`.

An earlier isolated print/stream-json run (`run-YwEcfC`) initialized the same
channel and wrote a notification while the hold tool was pending, then finished
without an observation call. That result remains inconclusive for interactive
delivery. It was not treated as a negative, and steering was added only after
the positive interactive receipt above.

## Implementation boundary

- A channel-capable attached `WsPeer` exposes steer only while it owns a push
  socket; detach and pull-only attachment remove that capability. The bus admits
  important work only, retains its existing pause/recovery/uncertainty holds and
  removes the queued item before transport hand-off.
- A steered notification uses the ordinary delivery id, connection generation,
  accepted receipt and explicit completion/correlated-reply contract. A transport
  failure stays uncertain. An idle transition must not deliver it again.
- Queued ordinary work can be read through `hub_inbox` during a busy turn using
  the existing atomic pull completion path. This does not settle a previously
  accepted push. Fake-transport regressions cover these contracts separately
  from this native observation.
