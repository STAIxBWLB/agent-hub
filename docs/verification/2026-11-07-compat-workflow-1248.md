# Automated compatibility receipt workflow (#1248 T2)

Task #764 extends the existing drift watcher with structured candidate data,
isolated per-ID proof jobs and a data-only publisher. This report describes the
implementation and its fixture evidence; it is not a native CLI receipt.

## Trust and credential boundaries

- The watcher reads the trusted COMPAT policy and manifest. Public version strings
  must be exact safe versions before they enter JSON matrix data. Unknown sources
  remain drift without a runnable version. Confirmed verified IDs are separate
  structured data, used to clear their old managed issue blocks.
- The matrix uses the manifest OS, at most eight IDs and two concurrent jobs.
  Unspecified OS is not guessed. Each hosted runner has `contents: read`, no
  supplied secrets, `persist-credentials: false`, a 20-minute bound and explicit
  `--disposable-runner`. Native processes receive the harness's private homes and
  allowlisted environment. Receipt artifacts remain data, not publisher code.
- Trusted read-only preparation validates native summaries against the manifest,
  strips untrusted prose, and retains only canonical statuses, identities, digests
  and scalar observations. Bad or duplicate input makes the batch drift-only.
  For an eligible candidate it patches one row, builds repository code with pinned
  Bun/frozen dependencies, binds fixed output files to the source SHA, then
  restores source, plugin assets and role notice. This job has no GitHub writes.
- The privileged publisher downloads only that preparer's immutable artifact ID.
  It validates every descriptor/hash/source binding before effects and re-plans
  against current bot-owned PRs. It runs Node builtins and first-party pure
  functions plus `gh` REST, never candidate code or a package install/build.
  `GITHUB_TOKEN` must be explicitly present; personal `gh` login is not a fallback.

The [GitHub runner reference](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
names `macos-latest` as arm64 and hosted jobs as fresh VMs. The harness still checks
actual OS/architecture. The [artifact action](https://github.com/actions/download-artifact)
supports downloading by immutable ID, avoiding candidate-selected bundle names.

## Publication and dry run

All required legs must pass and trusted manifest policy must allow model-free
admission. Model/TUI, source-review, unsupported-platform and missing-producer
legs stay not-run; `eligible` supplied by an artifact is not trusted. Harness
lifetime cleanup remains reported unproven and disposable-runner containment,
without overriding the producer's native-group assertions or acting as an
admission gate. A detected survivor or unconfirmed owned stop still fails.

One branch `compat/<id>-<version>` holds only the exact verified-array/receipt
edit, generated receipt and prepared plugin assets. Every other row and each
line window stays byte-identical. Existing bot PR metadata and owned file hashes
protect against ordinary manual drift; unknown/manual branch collisions refuse.
Updates use append-only Git history and `force: false`, not a claimed expected-old
SHA compare-and-swap. Editable PR markers are not cryptographic provenance against
a person who can coherently forge repository state. No verification PR is merged.

The person selected `GITHUB_TOKEN` plus explicit `check.yml` workflow dispatch.
GitHub's [workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#creating-a-workflow-dispatch-event)
requires Actions write permission, so that permission is confined to publish.
There are no GitHub App credentials. The replacement PR and check dispatch must
succeed before an older same-ID PR is closed. Separate PR-only checks remain
normal review gates rather than being claimed as dispatched by `check.yml`.

An exact-title tracker is selected through the existing fail-closed identity
helper. Closed-cause per-ID blocks preserve other drift/unknown evidence and
remove confirmed verified IDs. `dry: true` still runs the isolated proof and
read-only artifact preparation, then prints plans with zero GitHub mutations.
Live publication is restricted to the trusted current main source; feature-branch
dispatch is usable for dry validation only.

## Verification

Pure tests cover admission policy, incomplete/malformed input, superseding
versions and dry plans. File-helper tests cover exact-row byte preservation and
refusal of unsafe grammar. Preparation uses fake build ports; publisher tests use
fake REST data to cover branch ownership, changed source/assets, two-parent main
integration, new-day receipts, preserved human prose, dispatch-before-supersede,
stale verified issue blocks and zero-write dry/validation modes. Workflow tests
check permissions, no secrets/credential persistence, job bounds and artifact IDs.
No mocking library or real token is required by these fixtures.

Exact committed-head dgx02 results, hosted CI, workflow dry-run results and review
threads are recorded in the PR/task. Unrun live/native/platform behavior stays
unverified; no real token value, account path or model prose is committed.
