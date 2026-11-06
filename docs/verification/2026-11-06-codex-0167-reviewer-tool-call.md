# Codex 0.167.0 single reviewer tool-call attempt, not qualified

Date: 2026-11-06. Scope: issue #888, task #751. This records exactly one newly authorized native reviewer attempt after the [0.167.0 model-free receipt](2026-11-06-codex-0167-reviewer-isolation.md), following the corrected [0.166.0 procedure](2026-11-02-codex-0166-reviewer-tool-call.md).

**Result: qualification failed at the harness readiness/readback leg.** Native startup isolation and the accepted-plan marker precondition passed. The one-attempt fence was consumed once. The harness then reported `fixture readiness deadline` before it emitted `verdict-readback`. No complete persisted verdict/head/marker result was recorded, so the model/tool outcome remains unknown. This is not proof that the model failed to call a tool or that no verdict existed. No retry was made, and 0.167.0 stays outside `COMPAT["codex-review"].verified`.

## Bound procedure and model-free preflight

The source worktree branched from merged PR #1234 at `25878b3e66c80718f8512e0cfe5c05e4772853ec`. The retained task #625 controller and driver were copied only into a new private task directory. Adaptations changed the source path, task labels/environment prefix and exact native version from 0.166.0 to 0.167.0; the original consumed fence was not touched. The new task used its own persistent exclusive `wx` fence.

The worktree had its own frozen dependency installation, exact `@staix/agent-mem@0.21.0`, and pinned Bun 1.4.2. The Mac native exception was admitted through `dot admit`, with normal memory, thermal state 0, about 87% CPU idle and no competing local admission owner. The global Bun executable was not changed.

`--prepare` bound the installed exact 0.167.0 package and parsed the private driver without reading credential values. The setup-only rehearsal passed with zero native preparations and zero model requests, no auth symlink and no consumed fence. It created production daemon state only in fresh temporary homes, confirmed source/auth metadata stability and removed its temporary state. The current-source dgx02 model-free regression run passed 91 tests, 0 failed, 617 assertions across `review-scope`, `codex-review-isolation` and `compat` at that source head. This includes accepted-plan envelope coverage; it is not a native model result.

The controller held the repository lock before creating fresh HOME, CODEX_HOME and TMPDIR. Actual mode created one auth symlink to the configured account, used eighteen bounded original credential roots in private paths and granted version admission only in the temporary hub home. It did not change machine trust or the real configuration. No account path, credential value, private marker value or model prose is included here.

## One attempt and observed boundaries

The native fixture uses production `startDaemon`, `ReviewerPrintPeer`, `codexReviewerBackend`, the stdio plugin and `Tasks`. A synthetic builder proposed and accepted an arithmetic task with the marker in one accepted `plan.risks` item. The wrapper verified the actual rendered review envelope contained that marker before opening the one-attempt fence and before calling the original `ReviewerPrintPeer.review`. It neither called `hub_review` on the model's behalf nor substituted a verdict.

| Evidence | Observed |
| --- | --- |
| Source head | `25878b3e66c80718f8512e0cfe5c05e4772853ec` |
| Platform / Bun / memory core | macOS arm64 / 1.4.2 / 0.21.0 |
| Native startup reviewer | actual `ReviewerPrintPeer`, Codex 0.167.0 |
| Startup binary identity | `sha256:213f7a2c8109c5f5158151b829bfc561bc76bbcdcce0b641c1e9a01b8b541e37` |
| Startup isolation profile | `sha256:b0a4c1f0de7363e689a41056ec2ce21e5f0cead04399e1f8590c4cc1bc635af1` |
| Backend source SHA-256 | `8e6ce4e64c6787a81e48a97172d25bbf1876ae5bc24a54934e7a107075a72214` |
| Stdio plugin SHA-256 | `4c2b052a198b78a2162d410e8908e6501769632fcaa522ed88ee15a3a967dc88` |
| Startup `readOnly`, `strictMcp`, `ephemeral` | all true |
| Startup model-free evidence markers | all 14 present |
| Actual envelope marker / summary withholding | present / review-only summary withheld |
| Original review entries / fence consumptions | 1 / 1 |
| Fixture start, UTC | `2026-11-06T09:05:41.828Z` |
| Original review entered, UTC | `2026-11-06T09:05:42.679Z` |
| Failed readiness check, UTC | `2026-11-06T09:06:10.455Z` |
| Recorded cause | harness `fixture readiness deadline` |
| Persisted state, reviewer and verdict count readback | unknown, no `verdict-readback` event |
| Verdict head binding and marker match | unknown, not recorded |
| Actual model tool-call result / turn isolation readback | unknown, not recorded |

The failure event retained a stale phase label `reviewer-start`; that label is not used to attribute a native startup failure, because startup had already succeeded and `model-review-requested` was recorded. The private harness has bounded task/delivery readiness and reviewer-idle waits after that request. The preserved generic deadline does not identify a model/tool failure. Its fixed 110-second fixture and 120-second controller limits were not increased.

The startup receipt retained the exact two-tool MCP allowlist, Apps/plugins/hooks disablement, legacy notify disablement, public/private/glob/symlink/credential and write-denial canaries, binary/config fences and ephemeral-session evidence. These are startup model-free observations. No post-turn isolation receipt was emitted, and effective model-turn network or web-search behavior is not inferred.

## Cleanup and decision

Production daemon stop and owned-group teardown were awaited; the controller confirmed its driver group was gone and released only its inode/owner-bound repository lock. Before cleanup, the synthetic source was unchanged and the original account auth metadata matched. The auth symlink, fake homes, source project, task state and temporary directory were removed. A later bounded argv scan found zero remaining processes naming this fixture root; this is not universal orphan detection. The harness log was empty.

Before/after auth metadata SHA-256 was `1987ef4ee1e354dbac5566fde47c85a482d1a3530d3df6fbe93dc8d7fd57a909` in both observations. This fingerprints filesystem metadata without reading credential contents. The consumed task #751 fence remains intact; no additional native model review was launched.

The required complete model-backed receipt was not obtained. The verified set remains 0.146.0, 0.163.0, 0.164.0 and 0.166.0. The person-controlled exact-version trust path and every runtime isolation proof remain unchanged. No production adapter, task behavior, test assertion, bundle, global install, account setting or documentation stamp is changed by this failed receipt. Final changed-source and exact-head hosted CI evidence are separate and recorded in the PR.

## Private evidence fingerprints

Private producers and safe metadata remain outside git under `scratchpad/temp/ahub-751`. The original account values, marker and model prose are not retained in the repository.

| File | SHA-256 |
| --- | --- |
| `controller.ts` | `b278dc169bd85e73903158ba35a3a665c08c862d387581e90c8ecbaceecf069a` |
| `run.ts` | `637d3eac56dd9a5e113e3996d8aabbf2c54b01777664d6e0c81d606e4a5af665` |
| `setup-events.jsonl` | `e6489b086bea498e62073c98f5c6ff99b75defbef0ca5cc31d0e89bf34a8779a` |
| `native-events.jsonl` | `89dbf07daff59346e0fa861de49244f62411fc660c532bd32565f4b5db87eea2` |
| `post-cleanup.json` | `0470f71f36adcb57f1d323a77b798c9e0e0b25cf70e5b93ac0af52a170eaae2e` |

The native event stream contains 10 safe metadata events (2703 bytes). This failed attempt does not qualify a version, establish a missing verdict, demonstrate model quality or authorize another run.
