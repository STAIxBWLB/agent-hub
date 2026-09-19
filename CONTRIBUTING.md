# Contributing

- One gate: `scripts/check.sh` (typecheck, bundle and manifest freshness, tests). It has to pass locally and in CI (Ubuntu and macOS). A failing test is fixed in the code, not by editing the test.
- Branch and pull request, conventional commits in English. `main` is protected.
- Spec first: behaviour is described in `docs/specs/2026-09-19-agent-hub-design.md`. When a change departs from it, amend the spec in the same pull request.
- Read `CLAUDE.md` (conventions, architecture, the mistakes already made once) and `REVIEW.md` (what reviewers look for).
- After touching `src/adapters/claude-channel.ts` or anything it imports, run `bun run build` and commit the bundle.
- Never put real hosts, addresses, keys or personal paths into code, docs, tests, commit messages, issues or pull requests. Use placeholders such as `gateway.internal`.
- Security reports: privately, see `docs/security.md`.
