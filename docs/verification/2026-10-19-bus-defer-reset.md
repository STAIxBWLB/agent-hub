# Recovery deferral reset

- Scope: hub task #192, follow-up to #479.
- Regression: a deferring recovery hold is released, then a bare `fenceRecovery` is taken. A subsequent hub notice must enter the recipient queue rather than `deferredHub`.
- Test-only commit `872df66f`: the new regression failed because the later notice stayed deferred.
- Fix commit `2d24a919`: clear `deferHub` after `flushDeferredHub()` succeeds and before releasing `recoveryHeld`. A failed flush retains both the hold and deferral mode.
- Focused checks: the new regression passed (1 test); the existing `fenceRecovery` cases passed (3 tests); `git diff --check` passed.
- Bundle: rebuilt using Bun 1.4.2 with worktree-local frozen dependencies; the generated artifacts are unchanged.
- Initial remote `scripts/check.sh` attempt stopped at `docs: ERROR HEAD does not resolve`: the remote mirror excludes git metadata. This is setup failure, not a full-gate pass. Exact-head CI and a git-backed remote gate remain separate evidence.
