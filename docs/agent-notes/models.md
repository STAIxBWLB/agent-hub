# Model relay, inference and gateway

Scope: the model relay and its journal, the hub's own inference and its slots, OmniRoute and Switchyard. Read before editing `src/models/`, `src/hub/inference.ts`, `src/omniroute/` or `src/switchyard/`.

- The model relay journals per-request identity (`RelayRequestRecord`): a request's served model comes only from its own gateway header, its own generation SSE event (#137 heartbeat classification), or the locally validated MLX configuration. A backend's mutable last-served label is never a request's evidence, HTTP 200 plus the requested alias identifies nothing, and a request cancelled before identification stays explicitly unidentified (`identified: false`, `outcome: "cancelled"`). Journal records carry no prompts, tools, keys or Access headers.
- Inference is optional and fail-open: it returns its input or `undefined` on any failure and backs off, so a delivery never waits on a dead model twice. Its output is only ever capped text or a value checked against a closed list.
- Secrets stay inside `OmniRoute`: never put the key or Access values in a log line, an error message, a return value or the generated Switchyard file (the key goes by env var name).
- Switchyard's docs drift from the released binary. Any change to `switchyardToml` is checked with the real `switchyard-server --dry-run`, not only the stand-in in `test/fakes/`.
- Shared inference slots must recover after a hub process dies, without evicting a live owner. Cancellation has to reach slot acquisition from the relay caller, not just exist in the helper signature.
- MLX owner and generation identity read `ps lstart` with LC_ALL=C/TZ=UTC pinned (#177): unpinned, a record written under one environment reads as a foreign process under another, and the fail-closed paths would refuse the hub's own server.
