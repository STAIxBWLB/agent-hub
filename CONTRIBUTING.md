# Contributing

- One gate: `scripts/check.sh` (typecheck, bundle and manifest freshness, npm tarball contents, tests). It has to pass locally and in CI (Ubuntu and macOS). A failing test is fixed in the code, not by editing the test.
- Branch and pull request, conventional commits in English. `main` is protected.
- Spec first: behaviour is described in `docs/specs/2026-09-19-agent-hub-design.md`. When a change departs from it, amend the spec in the same pull request.
- Read `AGENTS.md` (conventions, architecture, the mistakes already made once, and the area notes it points to in `docs/agent-notes/`) and `REVIEW.md` (what reviewers look for).
- After touching `src/adapters/claude-channel.ts` or anything it imports, run `bun run build` and commit the bundle.
- Never put real hosts, addresses, keys or personal paths into code, docs, tests, commit messages, issues or pull requests. Use placeholders such as `gateway.internal`.
- Security reports: privately, see `docs/security.md`.

## npm releases

The package is `@staix/agent-hub` in the `staix` npm organization. Bun >=<!-- facts:bun-floor -->1.4.4<!-- /facts:bun-floor -->
is required to run it; Node and npm are also needed for the development gate.
The commands remain `ahub` and `agent-hub`.

Publishing uses npm trusted publishing (OIDC); there is no npm token and no
repository secret. A package owner registers the trusted publisher once on
npmjs.com (package settings, trusted publisher: GitHub Actions, organization
`STAIxBWLB`, repository `agent-hub`, workflow `release.yml`, no environment,
allowed actions: `npm publish`; a stage-only publisher refuses the workflow's
`npm publish`). Once the first trusted publish has succeeded, set the package to
require two-factor authentication and disallow tokens, and revoke any older
automation token. Only the workflow's publish job has `id-token: write`; npm
11.5.1 or later publishes provenance by itself
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers)). Before
renaming the repository or the workflow file, change the trusted publisher: edit
it when the package has a single one, or add one for the new name and then
delete the old one when several are allowed.

Release only from GitHub Actions: bump `package.json`, run `bun run build`, update
`CHANGELOG.md` (`bun scripts/release-prepare.ts` does all of this, including the
generated install tag and pins in the docs; `bun scripts/readme-facts.ts --write` is
the fallback for a hand edit), restamp the stale
documents in `docs/verified.json` after rereading them (`AGENTS.md`, Releasing), pass `scripts/check.sh`, merge the release change, then push
`v<version>`. The release workflow checks the tag against `package.json`, runs the
gate, publishes with `npm publish --access public` through trusted publishing,
then creates the GitHub Release; when the `SITE_DISPATCH_TOKEN` secret is set, a last job
sends `product-release` to `STAIxBWLB/agent-hub-site` so the site re-syncs (a failed
dispatch never fails the release). A mismatched tag or a failing gate prevents
publication. Do not publish from a laptop or move an existing release tag.

A pull request that edits a documented page shows a "stale documentation stamp" warning from CI
(the `decision` job). That is expected and needs no action: do not restamp `docs/verified.json` in a
feature PR. The release PR restamps the documents it has reread and clears the warning (`AGENTS.md`,
"Verified stamps").

After publishing, verify `npm view @staix/agent-hub@<version> dist.attestations`,
install that version with `bun add -g @staix/agent-hub@<version>` in a clean
environment, and check `ahub --version`, `ahub init`, and `ahub setup`. Real Claude
plugin installation and registry provenance remain release checks, not claims
made by local unit tests.
