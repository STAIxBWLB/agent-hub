# Reviewer no-verdict diagnostics and fallback receipt

Date: 2026-10-25. Refs #783. This receipt records fake-transport checks of the production adapter, host policy, Tasks and delivery journal. It records no new model call, native isolation proof or production runtime upgrade. The final PR head and packaging gate are recorded with the PR.

## Diagnostics

The fake reviewer checks cover an exit with no `hub_review` call, a structured native approval refusal that never reaches the host, and an actual host `hub_review` refusal. Each produces one bounded no-verdict diagnostic containing the exit code and allowlisted tool metadata. Tool argument objects and model-message events are discarded. Native metadata remains bound to its original task and generation through stdout drain even after leader-exit verdict authority is revoked.

The native parser follows the pinned [Codex 0.164.0 SDK McpToolCallItem](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/items.ts) server, tool and error-message fields. This source contract is not a new native execution receipt.

The privacy fixture extracts the production daemon diagnostic callback, `screenMemory`, `boundedSafe` and `contextPii` declarations and binds their actual policy helpers. It verifies current task/head/generation and attachment guards, private task/turn withholding, and secret/private/denied content placed beyond the output bound. Screening receives the complete refusal before controls are removed or the refusal is shortened. Safe output stays on one line; unsafe or stale details are withheld. The first full host refusal is retained separately from native display metadata, so a truncated native echo cannot hide a secret beyond 4000 characters. A different later host refusal sets sticky uncertainty rather than replacing the first refusal or accumulating a history. Both this echo case and conservative uncertainty withholding are covered by a controlled child barrier and the production diagnostic callback.

## Re-offer and delivery settlement

Three daemon scenarios use only a fake Codex transport: no tool call, native approval refusal, and a real host tool refusal. In each, the task is offered to the person, its actual delivery-journal row ends `completed`, no reviewer queue hold remains, and the same reviewer accepts a later request that records a verdict. The native-refusal scenario starts with a person-named reviewer and verifies escalation to the person rather than an agent the person did not choose.

Separate actual Tasks and delivery-journal checks verify that accepted agent publication completes the old delivery, while failed publication or failed person notification retains `needs_review` and its queue hold. A real daemon publication-failure check then triggers unrelated board and queue changes and confirms that automatic supersession retirement preserves the explicitly unconfirmed hold. A separate ordinary superseded review hold still retires, so this exclusion does not disable normal cleanup. A changed binding during publication cannot confirm the old offer. Adapter checks hold settlement while an asynchronous fallback is pending and require explicit confirmation before completion. Existing stop, watchdog and generation fences remain covered by their regression tests.

Focused commands:

```sh
env -u AGENTHUB_HOME bun test test/reviewer-print.test.ts test/reviewer-lifecycle-followup.test.ts test/reviewer-mcp.test.ts test/reviewer-pool-tasks.test.ts test/reviewer-no-verdict.test.ts test/reviewer-no-verdict-journal.test.ts test/reviewer-no-verdict-privacy.test.ts
env -u AGENTHUB_HOME bun test test/reviewer-no-verdict-daemon.test.ts --test-name-pattern "diagnostics reoffer"
env -u AGENTHUB_HOME bun test test/reviewer-no-verdict-daemon.test.ts --test-name-pattern "explicitly unconfirmed|ordinary superseded"
```

The first command passed 56 tests with zero failures. The second passed three daemon scenarios, and the third passed two retirement scenarios, all with zero failures. These are fake-transport checks, not evidence that a production model used this new tracer.

## Existing live proof and limits

The approved [Codex 0.164.0 reviewer tool-call receipt](2026-10-25-codex-0164-reviewer-tool-call.md) records one real model review and a persisted approved verdict through the production stdio MCP and Tasks boundary. That work corrected the native per-tool approval configuration for exactly the two permitted review tools. Its approved live evidence supplies the prior successful native tool-call leg for #783.

This change adds a structured tracer to the backend module, so its module hash differs from the earlier receipt. The reused proof applies to the unchanged native preparation and per-tool approval path; it does not claim that the exact newly instrumented module was model-tested. The historical task 328 fallback exception was not re-executed here, and no manual-nomination cause is inferred for that historical attempt. The manual and no-pool failure paths are demonstrated by the new deterministic tests.

Installed 0.16.0 behavior remains separate from these source and fixture checks. Production diagnostics, corrected approvals and re-offer settlement require a release and runtime upgrade.
