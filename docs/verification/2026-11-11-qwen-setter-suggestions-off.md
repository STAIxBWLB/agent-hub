# Qwen ACP setter with follow-up suggestions disabled

Date: 2026-11-11. Task #861, Refs #1317 and #888.

**Both exact versions pass ordinary A/B/clear/A in this isolated fixture.**
Production live-setter admission remains unavailable; basic ACP and qwen-dual
verified-version lists are unchanged. This is candidate evidence for a separate
conductor admission decision, limited to normal settings with suggestions off.

## Measured completion requests

Ordinals are reserved at completion-POST arrival, before reading the body.
Classification uses the complete latest USER, never total request/message counts
or a marker in earlier history. It requires all-text content, streaming/plain
response shape without a title schema, and exactly one current-run marker. A
source-pinned suggestion digest can identify a suggestion; unsupported or
ambiguous requests fail the leg. Model-list GETs are not turn classification
evidence.

| Version | Ordinal | Latest USER marker | Class | Provider model | Full USER bytes |
| --- | --- | --- | --- | --- | --- |
| 0.26.9 | 1 | A | ordinary | `task861-a` | 12148 |
| 0.26.9 | 2 | B | ordinary | `task861-b` | 185 |
| 0.26.9 | 3 | CLEAR | ordinary | `task861-a` | 189 |
| 0.27.0 | 1 | A | ordinary | `task861-a` | 12148 |
| 0.27.0 | 2 | B | ordinary | `task861-b` | 185 |
| 0.27.0 | 3 | CLEAR | ordinary | `task861-a` | 189 |

All six requests are text-block streaming requests with no response-format or
title schema. Each version completes all three delivery IDs. While A is held,
changing desired selection to B sends no setter and busy delivery refuses.
The next-turn B setter and baseline-A clear are acknowledged before their
respective completion-request arrivals. No suggestion or unknown completion
request is observed in either successful closed session.

## Source, artifact and settings binding

The production `AcpPeer`, `ModelOverrides` and `ModelOverrideLatches` come from
`cb5976ebc83252865569460d641bb59315124edc` (published 0.36.0), tree
`4ba31b1439f5016654e0cbadd84f4f8854c0c1d1`.
The controller checks 27 committed source/metadata files and two physically owned
agent-mem 0.23.1 dependency files, including its package manifest; no ancestor
dependency is used for native execution. Fourteen binding observations per leg
match. The private model policy is explicitly unqualified and changes no
production capability or machine trust.

- Node 24.18.1 runs from an owned runtime outside the actual HOME; SHA-256
  `f480e325ee0ca9cb9eef00b5ca6057a2a104807a1b073f1bc373a55c67facff5`.
- Controller Bun 1.4.2 SHA-256
  `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`.
- Exact 0.26.9 is reacquired from its official SRI-pinned tarball through a normal
  private npm 11.20.0 install. Exact 0.27.0 reuses the immutable private #849
  artifact. Package, CLI and ACP hashes match their prior bindings; private
  lockfiles and prefix snapshots bind the installed dependencies.
- Reviewed lifecycle metadata names optional audio-capture `node install.js`
  (a nonfatal node-gyp-build launcher) and clipboard `prepare: husky`; the latter
  is not marked as an install script in the locks. No audio or clipboard journey
  is qualified.

| Exact package | npm gitHead | SRI |
| --- | --- | --- |
| 0.26.9 | `600aff0592bcfc21668ca4aba95a5b20c6491b86` | `sha512-2orVsP3Dr01gk38STbYTWcFZeXftc0QXDHhglK7YPsIwgmumvnJeTAu1N00esRUwuLcevZ8k4godLwypDKb1LA==` |
| 0.27.0 | `03b0c2435be1890a21b117860eaf389076787275` | `sha512-efZt0LUm/raGUjR/SNN6pp8cpuNHnmE0hQvcvXzWHtVX9oVtDDgukq2IZNwYDErFYqHRj1xq2NQ5Jjt2SHUr/Q==` |

The native command uses `--acp --advisor off --auth-type openai
--telemetry=false`, with **no `--bare`**. Before CLI startup, a denied-network
child loads the exact normal settings module and checks nine booleans: UI
follow-up suggestions false, hooks disabled, MCP empty, synthetic OpenAI auth,
fixture model A, owned user/system/default settings paths and auto-update off.
All nine are true on both versions. Each private settings file remains
byte-identical after B and after owned stop. No real credentials or accounts
are copied or used; only the owned loopback provider supplies fixed SSE text.

Static AST metadata joins ACP `generatePromptSuggestion` to its local
`generateViaBaseLlm` USER-text reference. The exact 1,548-byte shipped suggestion
constant has SHA-256
`53e6d97a6587792612a74b051b81e7b5a2236496e8da25aafe6c7cf75086d8e2`
on both versions. Source modules are `chunk-AXAZGX4Y.js` for 0.26.9 and
`chunk-AHZ4AG7B.js` for 0.27.0. This narrow symbol binding does not certify a
complete vendor import graph. Prompt bodies are not published.

## Isolation, closure and retained evidence

Fresh 0700 roots isolate HOME, cwd, TMPDIR, XDG, Qwen/runtime and hub trust/DB.
The reviewed Seatbelt profile denies actual-home/system Qwen configuration and
global writes, permits only the exact loopback provider port, and passes the
positive provider / negative decoy, actual-config-read, runtime-copy-write and
native watcher controls. The approved exact-path fingerprint exclusions are
unchanged; global/managed install, launcher and selector are separate scopes.

| Version | Protected entries before/after | Private prefix entries before/after | Observed owned identities | Remaining observed processes |
| --- | --- | --- | --- | --- |
| 0.26.9 | 7025 / 7025 | 1721 / 1721 | 18 | 0 |
| 0.27.0 | 7025 / 7025 | 1723 / 1723 | 18 | 0 |

| Version | Protected digest (both snapshots) | Private-prefix digest (both snapshots) |
| --- | --- | --- |
| 0.26.9 | `a88c24aad7147a0a60127bb07c7170a560c3e010064d004bdd072d5f74a87a1f` | `1de05d088a3572bc3de449343b73df56530d7bb586b5937e436fcc09e25c8bcb` |
| 0.27.0 | `a88c24aad7147a0a60127bb07c7170a560c3e010064d004bdd072d5f74a87a1f` | `ba1c58e46b3a9bd7073befe0ea92b1c24db0b3a72519cf1c9b237d567cf80c58` |

Each corresponding digest also matches before/after. Actual configuration,
global/managed packages, launcher and selector are unchanged within each leg.
Provider shutdown joins every admitted handler, body and stream before freezing
the final ledger; all pending counts are zero. Owned native stop and outer
process observation pass, with no cleanup fault. Detached lifetime containment
is not claimed.

Private producers and closed evidence are located through
`scratchpad/temp/task861/qualified-results.json`, with per-leg roots and full
manifest, source, settings, ledger and supervisor bindings. These producers are
private/uncommitted; the hashes identify the reviewed source, not a committed
reproducible proof module.

| Version | Closed result SHA-256 |
| --- | --- |
| 0.26.9 | `2edb1498fb392ac748d4ec67541adcc635ea65955b053c8dd4a8534ad9ccafd1` |
| 0.27.0 | `58729f79913ed6a71fd718fd60344c48e0f734226cae0e0efa3c66f625912ac3` |

Final harness source SHA-256:

| Producer | SHA-256 |
| --- | --- |
| `REVIEW.md` | `a14f335214395720de1cb33be111671df4c8e376748409d4ade90730049dc236` |
| `acquire-control.ts` | `72a43ee351fb57c9d6252fd002dc589ce992012464f416ed3c97a7f2b31edb24` |
| `classifier.ts` | `5369f98d46faa303c950863ff8039e26f76b6ed8ae013e04dd7950d34d14d8c5` |
| `controls.test.ts` | `cc030983bcad3f6c4de42bdddc03fa4c3abcd55fd35f8cbd620c64a4d2d5f605` |
| `provider-ledger-controls.test.ts` | `ec8e678770b8a22b9478ba953ecff2946607266e5799273aaa1ea1100e8ab2f8` |
| `provider-ledger.ts` | `7fd93abe014e0eb0777de360ccb3439aafd92de47abbe82e21557fa1d8110bb3` |
| `provider-lifetime.ts` | `72539a505364840e7ee9d915431729e74d0bd183f1164de28e9d8d775e65835d` |
| `run-setter.ts` | `68de89df97fb37ba80d876541359d66dfe8a9e8dee4d078e0818e750569cf6b1` |
| `setter-probe.ts` | `8d2ff2a7c96575bbe325322a33e7026db9c5090698e9f8bac8da7e1536ac10e8` |
| `snapshot.py` | `9b2fb040a69ddc4ec4c0773dfd96e3ce2793b32c3a02b52932bd393bff5295f2` |
| `source-binding.ts` | `91593661b2b0a011a6abfaf395d7fd01aeb3fbc9eb9bfc71861ea22d2fc765c6` |

## Earlier attempts and historical correction

The first suggestions-off 0.26.9 attempt had all nine settings checks true but
one complete 12,148-byte latest USER was rejected as unknown by the private
classifier before marker search: it incorrectly reused its 4,096-byte diagnostic
retention limit as a full-input limit. The session timed out, owned cleanup and
fences passed, and that request remains unknown. It establishes no clear
outcome. Its closed root is retained through
`scratchpad/temp/task861/first-qualify-0.26.9.json`.

The corrected fixture classifies complete input up to 64 KiB while retaining
only a 4,096-byte private diagnostic prefix. `latestUserTruncated` refers to
that diagnostic retention, not incomplete parsed input. Original assertions
remain; added complete-context, repeated/mixed-marker and over-bound cases
bring fake controls to **9 passed, 0 failed, 63 assertions**. New source hashes
and fresh resource admission precede each successful sequential native run.

The [0.26.9](2026-11-08-qwen-0269-model-setter-1317.md) and
[0.27.0](2026-11-09-qwen-0270-model-setter-1317.md) historical A/B/B results retain
counts/response shape but no latest-USER content, marker or digest. Their third
request purpose is **unknown**. The new result invalidates count-only ordinary
classification; it does not prove the old request was a suggestion or that
disabling suggestions alone caused a behavioral change across the old/new
controller and adapter sources.

## Admission proposal and limits

Propose separate conductor review of an exact 0.26.9/0.27.0 setter admission
using this suggestions-off evidence. This PR enables neither version. Default-on
suggestions, real accounts/models, arbitrary provider-identity mapping, TUI,
Linux and installed-hub operation remain unverified. Existing basic ACP and
qwen-dual admissions stay unchanged. Committed-head automated/hosted checks are
reported with the PR submission, separately from these native fixture results.
