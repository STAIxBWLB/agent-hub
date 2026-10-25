# Live codex-review verdict receipt (0.17.0)

Date: 2026-10-25, macOS arm64. Refs #783 AC3. Result: the production hub's `codex-review` instance reviewed one real pull request and recorded an approved verdict through `hub_review`. This is the first verdict recorded by `codex-review` on a running hub since the no-verdict failure of #783; the [model-backed fixture receipt](2026-10-25-codex-0164-reviewer-tool-call.md) covered the same path in a temporary fixture only.

## Setup

| Item | Value |
|---|---|
| Hub | 0.17.0 release runtime, the project's own daemon (not a fixture) |
| Native reviewer | `codex-cli 0.164.0` (`ahub agents`: verified) |
| Declaration | `codex-review`, kind `codex`, roles `["reviewer"]`, `start_mode: "headless"`, `review_mode: "fresh"` (untracked `config.local.json`) |
| Enabled with | `ahub --live-test roster add codex-review`, then `ahub --live-test codex --as codex-review` (user-authorized live test) |
| Status after start | `codex-review idle attached`, no `reviewer isolation unavailable` line |

## The review

| Item | Value |
|---|---|
| Hub task / PR | #476 / #809 (docs only, `docs/operations.md`, +9 lines) |
| Owner / reviewer | `claude` / `codex-review` (assigned by routing) |
| Reviewed head | `ce16b44be52161a950b66f9220e3cb565ae4781f` |
| Review request sent | 09:12:17 UTC |
| Reviewer busy | 09:12:17 UTC |
| Verdict recorded | 09:13:03 UTC, `approved` (46 s after the request) |
| Reviewer idle | 09:13:08 UTC |
| Board state after | `approved`, reviewer `codex-review` |

The verdict note cited the two code locations the doc change describes (`validateInstances`, `resolveInstanceExecutionCwd`), reported a read-only `check-docs` run and `git diff --check`, and listed one unmet item: it could not run `scripts/check.sh --changed` because the read-only sandbox refuses the gate's lock, install and build writes. The hub logged `premature review: exact-head full CI is not green` at the request; the review ran anyway, and the merge waited for CI separately.

## Limits

- One review of one small docs-only change. A code review with findings and a `changes_requested` verdict were not exercised.
- Token use for this single review is unknown: `ahub usage` reports a cumulative counted total for `codex-review`, not per review.
- The reviewer cannot run the repository gate; its approvals rely on CI and the owner's reported gate for that.
- macOS only; native Linux behavior is not covered.
