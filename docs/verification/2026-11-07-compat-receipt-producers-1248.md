# Committed Kimi and Qwen receipt producers (#1248 T1b)

Task #765 promotes the first-party historical producers behind the Kimi 2.5.1
and Qwen 0.26.8 receipts into callable modules. Candidate executable/package paths
and versions are parameters; no personal installation or account is an input.
The harness worker imports these modules instead of embedding their proof bodies.
No COMPAT, trust, workflow, verified version or documentation stamp changes.

## Provenance

Every retained producer matched its receipt fingerprint before promotion.

| Receipt | Historical producer | SHA-256 | Committed owner |
| --- | --- | --- | --- |
| [Kimi 2.5.1](2026-11-06-kimi-251-reviewer-compat.md) | `agent-hub-748/kimi-probe.ts` | `2ff8e2841f2cbd58d07add57e5deb9041ee33a692489083a176e6b5d5f406edf` | `scripts/compat-receipts/proofs/kimi.ts` |
| Kimi 2.5.1 | `agent-hub-748/loopback-only.cjs` | `f4e4714ac846c9e1861306f19c1c656350d1d4180818bd834aa34d1ae0ced8df` | `proofs/kimi-loopback-only.cjs`, original bytes |
| Kimi 2.5.1 | `agent-hub-748/run-kimi.py` | `1822f6d597d4b4cd7128d451addf81cb7bcd67492f339ea363ba99b288f80f5e` | Native process ownership is now the shared bounded command port |
| [Qwen 0.26.8](2026-11-06-qwen-0268-acp.md) | `agent-hub-749/probes/qwen-acp-probe.py` | `897ff1b615f93da8cf5d0a93a5ce150eadfc55e87dce1d44625ad833c236691f` | `proofs/qwen-acp.py` |
| Qwen 0.26.8 | `agent-hub-749/probes/qwen-permission.mjs` | `d777feb9070f254238f5ecf57f510e6af88e817b559919f65160bfd7db02a154` | `proofs/qwen-permission.mjs` |
| Qwen 0.26.8 | `agent-hub-749/probes/deny-network.cjs` | `361148af658dd4b65ed35308622ec99bb882ec5a25fab54581776546f139e892` | `proofs/qwen-network.cjs`, original bytes |

Historical paths are relative to workspace `scratchpad/temp/`. These hashes bind
the original procedures, not the newly parameterized module bytes. The promoted
Python/MJS helpers are import-safe and invoked by the single Qwen module.

## Receipt-to-leg mapping

Kimi's "Isolated production and native controls" is split at the existing
preparation boundary. `reviewers.ts` still owns preparation, exact inventory,
environment decoy, task-bound broker and source-fixture cleanup. An optional native
callback runs before broker revocation; negative broker controls compare their
callback count against the preceding positive native calls.

- `native-tool-loop`: fixed loopback SSE drives the actual two-tool loop, requires
  the exact advertised two-tool inventory and the expected broker callbacks.
- `write-absent`: injected Write is absent and produces native tool-not-found;
  the marker stays unchanged.
- `write-positive-control`: the private agent explicitly gains Write; fixed replies
  produce the marker and the positive request sequence.
- `network-guard-control`: the original preload's non-loopback positive control
  must deny the synthetic attempt. This is application-level, not kernel isolation.
- `cleanup`: original synthetic config/credential bytes, current launch, native
  group stop and per-case temporary removal remain assertions. Synthetic provider
  fields reproduce the original fixture; no real OAuth exchange occurs.

Qwen's "Native ACP, no prompts" and "Actual published permission handler" remain
canonical Python/MJS procedures behind `qwen.ts`.

- `artifact-private-install-integrity`: private package/name/version/CLI binding
  and original CLI/chunk/metadata byte fences supplement the controller's SRI.
- `native-acp-auth-session-modes`: initialize, session and the four mapped mode
  transitions. Receipt-observed protocol, title, auth, default mode and fixture
  model are now explicit assertions; extra unmapped modes are permitted.
- `actual-published-permission-handler`: exports-only copy beside the original
  published chunk, native approval handler and exact options, allow-once,
  cancellation and unoffered-option refusal; original chunk bytes stay unchanged.
- `preload-network-cleanup`: original preload plus positive control, no permission
  fixture network attempt, and bounded native-group cleanup observations.
- `native-macos-repetition`: passes only on actual macOS arm64 after the native
  controls pass. `additional-linux` never substitutes for that requirement.
- `reviewed-optional-lifecycle-replay` remains human source-review work, not a
  successful install inferred as a lifecycle review.

Cleanup never signals a group after its leader was reaped. Producer group
assertions retain their original meaning. Harness lifetime cleanup remains a
separate reported property under disposable-runner containment; it is not an
admission gate. Detected survivors and unconfirmed owned stop still fail.

The [Jcode 0.99.1](2026-10-26-jcode-0.99.1.md) producer was not retained:
`/tmp/ahub-jc0991` is gone. Its legs remain `producer-not-committed`; reconstruction
and proof against the 0.99.1 control are a separate task, not a promotion here.

## Verification and limits

Tests use typed fake command/protocol ports and private fixture homes, without a
mocking library. No native agent CLI is installed or run on the person's Mac, and
no real account, API key or model is supplied. Fixed loopback messages and tokens
are synthetic controls, not model behavior or provider readiness.

Exact committed-head dgx02 checks, hosted CI and review-thread state are recorded
in the PR/task. A successful fake protocol suite proves wiring and refusal
behavior, not a new native compatibility receipt or verified version.
