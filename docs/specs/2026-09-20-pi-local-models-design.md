# Pi with DGX and MLX

Issue: #25. Pi is a managed project peer for implementation, edits, tests, summaries and triage. Claude/Codex retain planning and final review. Existing local-worker PII ownership does not change.

## Runtime boundary

- One managed Pi session owns each project, in headless RPC or native TUI mode.
- Mode changes preserve the session ID/file and stop the previous owner before starting a replacement.
- Only `agent_settled` completes a turn. Important chat can steer; task/review and private envelopes queue.
- Native tools, extension discovery, skills and prompt templates are disabled. The explicit hub extension delegates file, shell and task tools back to the daemon.
- The daemon retains existing path guards, sandbox and terminal approvals. A session/tool-call ledger records pending effects before execution and cached results afterward. Uncertain effects are never automatically replayed.
- Native process identities and bridge credentials are separate from model credentials. Pi receives only the relay token, not gateway credentials.

## Inference

- `dgx/coding` and `dgx/fast` resolve through the project's existing OmniRoute configuration.
- `mlx/fast` resolves to the machine-shared loopback MLX server.
- Apple Silicon setup pins Python 3.12, `mlx-lm==0.31.3`, and `Qwen/Qwen3-8B-MLX-4bit` revision `383413e909f3bc5303ce195ebbdf0339c5a1a2a3`.
- The MLX input estimate is capped at 16,000 tokens; decode and prompt concurrency are one. DGX's default input estimate cap is 262,144 tokens.
- The relay authenticates every call, rejects browser origins and unknown model aliases, and preserves streamed bytes. It records the requested route and model reported by the backend. Per request it also journals sanitized identity and lifecycle evidence (#139): resolved alias, upstream-configured model, observed provider and served model with their source (gateway header, generation SSE event, or local MLX configuration), outcome (completed, cancelled, failed), duration, and a confirmed-mismatch flag. A request cancelled before any identification stays explicitly unidentified; a backend's mutable last-served label is never a request's own evidence, and a primary/auxiliary role stays unknown without native evidence. Records carry no prompts, tools, keys or Access headers.
- Load and cooldowns (#199, amended 2026-10-09). A request bound for MLX keeps exactly its two candidates, MLX then its DGX fallback; load and cooldowns only reorder them, so a dead gateway never costs a turn MLX would have served. The fallback goes first, while its own last dispatch did not fail, when MLX is cooling down, when an enforced tool loop is pinned to it, or when a movable `hub/auto` request finds the MLX slot still busy after `[pi] efficient_wait_ms` (default 500 ms, below the 120 s slot wait; read when the hub first starts Pi). Under #197 `enforce` a load move happens only at a user turn. Each relay alias cools down after three consecutive transport or startup failures outside a cooldown, for 30 s doubling up to 5 min; a busy MLX slot and timeouts cut short by the execution budget never count, and any HTTP answer, a success or an error status, proves the transport works and clears the streak and the cooldown. A cooling DGX alias with no alternative is still tried. An alias that fails before it has a status row (gateway or key unavailable) gets one, so its cooldown shows. Both reorders are invisible to PII, which never reaches the relay (Pi refuses PII work). A load move journals no MLX attempt unless MLX then serves as the fallback. Route events record `source: "load"` or `"cooldown"` and `stateless` for a request without a session key; `events.jsonl` records `cooldown` start and end, and `ahub status` shows the cooldown on the backend line. Before the relay first starts MLX, startup decides as before. The live wait-time measurement on a mixed workload (#199 AC5) is open.
- MLX may fall back to DGX before response streaming begins. Failed non-PII tasks can escalate to configured cloud peers with an explicit warning to reconcile partial effects.
- Runtime ownership includes process start identity. Project shutdown releases its relay, while explicit `ahub models stop` controls the shared MLX process.

## Recovery and rollout

Protocol 9 carries Pi session/launch metadata. Supported controlled upgrades read protocol-8 source contracts and restore protocol-9 targets. Legacy protocols 5-7 still require a matching CLI and attended bootstrap. No active session is forcibly interrupted to satisfy a deployment deadline.

Public templates keep Pi disabled until the optional executable and model runtime are configured. Existing custom routing files remain authoritative and require explicit Pi class preferences when adopting this feature.

## Verification

The release gate is `scripts/check.sh`. Live acceptance additionally requires Pi tool roundtrips through DGX and MLX, native/RPC session handover, and canonical runtime status readback. Unit tests alone do not prove operational cutover.

## Empty session handover (#27)

Pi may report a session file before writing it. Before stopping an idle source,
the hub queries its live session state. Only a verified empty source with no
observed activity or persisted history may resume by exact session ID alone.
Persisted conversations retain their exact file; missing nonempty history blocks
handover. A failed target launch retains the verified resume identity for retry.
