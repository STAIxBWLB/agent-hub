# Model-free receipt harness core (#1248 T1)

Task #763. This report describes the harness and its fake-only verification. No
agent CLI was installed or run on the Mac, and no account or real model was used.
The T0 manifest and existing runtime admission policy are unchanged.

## Command and artifacts

`bun scripts/compat-receipt.ts <id> <exact-version> --out <new-owned-directory>`
validates the id/version and refuses unsafe or occupied outputs before install.
Each run creates fresh HOME, XDG, cache, prefix, project and native tool homes.
The caller's account/model variables and agent/Orca markers are not inherited.
The worker is started in that environment before native proof API imports.

Public exact npm artifacts are byte-verified against SRI before npm receives the
local tarball; npm user/global config and cache stay private. Tagged release
assets are checked against SHA-256 metadata and a checksum before extraction.
The two-pass extractor rejects traversal, links, nonregular entries, duplicates,
excess entries and expanded bytes before writing. This is not an assertion of
kernel confinement of arbitrary package lifecycle code. No ignore-scripts flag
is used to make installation or a proof succeed.

`summary.json` records identity, actual OS/architecture, artifact integrity,
installation and each manifest leg's closed status/cause/next step, time bounds,
cleanup and eligibility. `receipt.md` is its human view. Neither contains raw
native output, caller secrets or temporary prefix paths. A cleanup failure keeps
the private workspace and reports its location only on stderr. No version,
line window, real-home trust or PR is changed by the harness.

## Proof reuse and conductor ruling

Conductor ruling 2026-11-07 confines T1 to committed producer code. Historical
scratch Kimi/Qwen/Jcode producers are not copied or promoted here. Their missing
native legs report exactly "producer not committed; see follow-up task". Pi's
historical committed top-level producer is not an import-safe candidate API, so
its remaining proof reports that extraction gap. Source/lifecycle semantic review,
unsupported native platforms, account/model and TUI work are explicit not-run.
None can become a pass merely because installation or configuration succeeded.

- Codex imports `codexReviewerBackend.prepare` in the isolated worker, using only
  temporary exact-version fixture trust. Empty/ambient preparations and their
  structured isolation assertions must pass before its internally executed
  metadata/native-canary checks can pass. The returned model exec is never run.
  A candidate already admitted by policy cannot reproduce its old pre-admission
  negative check without changing policy, so that leg is not applicable.
- Kimi imports its existing prepare and task-bound MCP broker. Only actual private
  config/inventory/environment and host broker-refusal assertions are mapped.
  Native Write/tool-loop/network/child-cleanup legs remain not-run. Production
  managed-provider validation is not relaxed or pointed at a loopback service.
- Claude imports the existing Python producers through runpy. Optional
  --expected-version and --runtime-path inputs parameterize the candidate and
  isolated interpreters while preserving historical defaults/assertions. A group
  must exit 0 with exact cases, version, binary stability and native/host cleanup
  before its mapped assertions pass. PID groups are never signalled after their
  reaped leader may have been reused. Original historical producer fingerprints
  are history, not hashes of these newly parameterized files.

## Bounds and evidence ceiling

Install/proof execution has monotonic scheduling deadlines; default budgets are
15 minutes total, 3 minutes install and 2 minutes per proof worker/group. A fixed
10-second teardown allowance is included in reported wall-time bounds. The
production owned-process/descendant teardown is reused with a credential-free
process-table observer. Unconfirmed teardown is failure, never a passing receipt.
An inconsistent optimistic pass/timeout result is rejected.

The test suite uses fake package metadata/bytes, fake installers and fake proof
executables. It covers pass plus both outputs, failed proof and no PR, pre-dispatch
model refusal despite an optimistic response, leg and total timeouts with owned
descendants, private environment/no caller mutation, unsupported platform,
invalid exact inputs, symlink outputs, digest-before-effects, bounded safe archive
extraction, committed producer mapping and isolated-worker missing-producer refusal.
These are harness/host fixture results, not new native CLI compatibility receipts.

## Verification

Final committed-head dgx02 checks and hosted exact-head CI are recorded in the PR
and task submission. No local full suite, native agent installation, account,
real API key or model run is claimed. Producer promotions and workflow/publisher
integration remain outside this PR; the person still owns the token decision.
