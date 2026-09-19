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
- The relay authenticates every call, rejects browser origins and unknown model aliases, and preserves streamed bytes. It records the requested route and model reported by the backend.
- MLX may fall back to DGX before response streaming begins. Failed non-PII tasks can escalate to configured cloud peers with an explicit warning to reconcile partial effects.
- Runtime ownership includes process start identity. Project shutdown releases its relay, while explicit `ahub models stop` controls the shared MLX process.

## Recovery and rollout

Protocol 9 carries Pi session/launch metadata. Supported controlled upgrades read protocol-8 source contracts and restore protocol-9 targets. Legacy protocols 5-7 still require a matching CLI and attended bootstrap. No active session is forcibly interrupted to satisfy a deployment deadline.

Public templates keep Pi disabled until the optional executable and model runtime are configured. Existing custom routing files remain authoritative and require explicit Pi class preferences when adopting this feature.

## Verification

The release gate is `scripts/check.sh`. Live acceptance additionally requires Pi tool roundtrips through DGX and MLX, native/RPC session handover, and canonical runtime status readback. Unit tests alone do not prove operational cutover.
