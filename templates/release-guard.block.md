## Release authorization

- Before `git push` of a `v*` tag, `gh release create`, or `npm publish`, run `ahub sdlc release-guard -- <program> <literal arguments...>` with the exact intended command arguments. Do not execute the release operation if preflight refuses or its result is unknown.
- Ask the person to run `ahub sdlc authorize-release <version>` when a matching authorization is absent. Never create authorization through an agent shell or delegated person identity.
- Re-run preflight after any candidate commit, version, target, or documentation change. Preflight runs no release command.
- The installed Git pre-push hook checks actual pushed version-tag updates. Do not bypass it with `--no-verify`, `core.hooksPath`, environment changes, or another Git invocation. This is a cooperative release guard, not an operating-system security boundary.
