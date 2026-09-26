# Contributing

- One gate: `scripts/check.sh` (typecheck, bundle and manifest freshness, npm tarball contents, tests). It has to pass locally and in CI (Ubuntu and macOS). A failing test is fixed in the code, not by editing the test.
- Branch and pull request, conventional commits in English. `main` is protected.
- Spec first: behaviour is described in `docs/specs/2026-09-19-agent-hub-design.md`. When a change departs from it, amend the spec in the same pull request.
- Read `AGENTS.md` (conventions, architecture, the mistakes already made once) and `REVIEW.md` (what reviewers look for).
- After touching `src/adapters/claude-channel.ts` or anything it imports, run `bun run build` and commit the bundle.
- Never put real hosts, addresses, keys or personal paths into code, docs, tests, commit messages, issues or pull requests. Use placeholders such as `gateway.internal`.
- Security reports: privately, see `docs/security.md`.

## npm releases

The package is `@staix/agent-hub` in the `staix` npm organization. Bun >=1.3.0
is required to run it; Node and npm are also needed for the development gate.
The commands remain `ahub` and `agent-hub`.

Before the first registry release, an organization member with publish permission
must create a granular access token with the required package/scope write access
and bypass-2FA permission for unattended publishing, and save it as the repository
secret `NPM_TOKEN`. Organization management permission alone does not grant package
publishing access ([npm token documentation](https://docs.npmjs.com/creating-and-viewing-access-tokens/)). For a new package, ensure the token permits its creation under
`@staix`; after the first publish, narrow it to the package. Never commit the token.

Release only from GitHub Actions: bump `package.json`, run `bun run build`, update
`CHANGELOG.md`, pass `scripts/check.sh`, merge the release change, then push
`v<version>`. The release workflow checks the tag against `package.json`, runs the
gate, publishes with `npm publish --provenance --access public`, then creates the
GitHub Release. A mismatched tag or a failing gate prevents publication. Do not
publish from a laptop or move an existing release tag.

After publishing, verify `npm view @staix/agent-hub@<version> dist.attestations`,
install that version with `bun add -g @staix/agent-hub@<version>` in a clean
environment, and check `ahub --version`, `ahub init`, and `ahub setup`. Real Claude
plugin installation and registry provenance remain release checks, not claims
made by local unit tests.
