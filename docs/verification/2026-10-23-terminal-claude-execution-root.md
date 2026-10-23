# Terminal Claude execution-root receipt

Date: 2026-10-23. Native version: Claude Code 2.1.309. Scope: #525 R5b, slice 525-5.

## Native cwd evidence

An isolated HOME and CLAUDE_CONFIG_DIR, empty of authentication, loaded one fixture stdio MCP server. The native session ran from a separate fixture cwd with:

```sh
claude --bare --print --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --mcp-config <fixture.json> --no-session-persistence --tools ''
```

The driver sent exactly one `control_request` with `request.subtype: initialize` and no user messages. The native control response was success. The fixture observed MCP initialize and tools/list. The MCP process's canonical cwd matched the native session cwd. Stderr was empty. The owned native session group was terminated and reaped afterwards; no fixture MCP process remained. No model request, login, real credential HOME or person's live session was used.

A separate `claude mcp list` health check from two different fixture directories also started the server in each caller's canonical cwd. The actual session initialization, rather than that health check alone, is the basis for hello cwd.

## Host admission and limits

The launcher and daemon independently use the existing managed-worktree resolver. A matching launch id, private record executionCwd, native hello cwd and validated noncanonical worktree are all required. The proof is tied to the attached socket and claim generation. Missing or mismatched root stays unisolated; explicit routing refuses a write owner. A launch replacement or detach invalidates proof. Facts use the verified root, and recovery revalidates it against the declaration.

The native observation covers this installed version's initialize-only session. It does not certify a real implementation turn, native --worktree behavior, a user hook that changes cwd, other native versions or kernel write isolation. The daemon rejects differing reported cwd regardless of those reasons. A real account/model turn remains the manual smoke leg.

Runtime proof revalidates the worktree before owner reads/effects, sharing evidence only within synchronous code in one event-loop turn. This uses the existing resolver's aggregate 5-second Git budget per peer (up to four Git subprocesses). No terminal Claude implementer is declared in this repository, so this receipt makes no live multi-instance CPU claim. The existing resolver's ponytail applies: an asynchronous validation/admission boundary or correctly invalidated semantic inventory cache is the upgrade if that cost becomes material.

## Verification

Candidate checks are recorded in the PR and task handoff at the exact head. Focused tests cover positive ownership/facts, absent and mismatched evidence, replacement/detach, private-record and size fences, native launch cwd versus canonical hub root, and terminal recovery root/identity drift.

Native candidate validation with pinned Bun 1.4.2: `scripts/check.sh --changed` passed 3,618 tests across 285 files, 194,424 assertions, 0 failures (753.24 seconds). The gate ended `check: no current-invocation agent-hub daemon leaks` and `check: OK (changed)`. Bundle freshness and npm package contents passed. The new mismatch test fails on a named assertion when the cwd comparison is removed, then passes with the source restored. CI on both OSes remains a separate exact-head review gate; no CI pass is claimed here.

## R1 follow-up

The review found that verifier-only declarations bypassed the implementer-only facts guard. Every declared worktree now requires current owner-root proof before facts permission or tree observations; absent/revoked proof returns no grant and no canonical-tree fallback. The regression establishes a real hook generation, changes permission through the console, then checks revoked and missing roots under both ask-when-needed and never-ask. It fails against the former facts guard.

The channel resolves its cwd best-effort on each connection. A deleted native cwd omits root evidence while preserving hub messaging; an actual removed-directory reconnect regression fails against the former unguarded lookup and passes with the fix. This never upgrades missing evidence into owner isolation.

The readonly-glob seed now targets the verified-root expression and still removes only readonly policy enforcement. Shard 14/64 passed all seven sequential green-to-named-assertion detections, including that seed.

The original macOS CI failure at 9dc3cf03 was `hdiutil create` returning 1 before the HFS+ sandbox body ran, rather than an accepted forbidden write. This PR changes no sandbox/deny implementation or HFS+ test. The unchanged named HFS+ test passed three consecutive native runs (307 assertions each) on the R1 candidate. This does not establish the new head's GitHub macOS result; both-OS exact-head CI remains required.

R1 local gate with pinned Bun 1.4.2: `scripts/check.sh --changed` passed 3,634 tests across 286 selected files, 194,501 assertions, 0 failures (762.35 seconds), no current-invocation daemon leaks, `check: OK (changed)`. The watchdog used the hosted macOS 1,260-second setting; per-test timeout stayed 20 seconds. This was the changed gate, not a 506-file full-suite claim. New-head CI remains unobserved until the reviewer reads its results.
