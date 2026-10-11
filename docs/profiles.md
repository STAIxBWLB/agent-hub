# Project profiles (#259)

- `dev` remains the default. Its config/AGENTS template, flow contract, proposal-tool schema and legacy task representation retain their existing bytes/shape.
- `ahub init --profile research|writing|general` creates missing defaults and that profile's managed AGENTS block. Repeated init reads the existing shared profile. An explicit conflicting profile refuses before any file write; init never overwrites existing project policy. Change profile deliberately in config, then refresh instructions.
- Profiles are shipped data at `templates/profiles/<name>.json`: class aliases, plan keys, flow-role guidance, optional catalog ids and AGENTS text. Config role/capability/permission settings still own authority. Profile-data overrides and converters are later slices.

# Classes and plans

- Research: question=plan, survey=summarize, extract=bulk_edit, analyze=implement, synthesize=summarize, draft=implement, fact_check=test, review=review, triage=triage.
- Writing: outline=plan, draft=implement, edit=bulk_edit, translate=implement, fact_check=test, format=bulk_edit, review=review, summarize=summarize.
- General: plan=plan, do=implement, check=test, review=review, summarize=summarize, triage=triage.
- Existing base names remain accepted in every profile. Unknown aliases and another profile's aliases refuse before proposal effects. The board stores the base plus the selected profile/class on non-dev tasks; old rows stay unchanged. Routing, reviewer choice, budgets, outcomes and checks run on the base.
- Non-dev plans accept paths, sections, sources and claims. Use full section anchors such as `report.md#methods` and explicit source ids. Equal declared anchors or source ids produce overlap notices. Two document tasks naming distinct section anchors can share a file without a broad path notice; a task without section declarations still reserves the whole path. Claims are evidence ids, not overlap claims. Dev keeps its existing four plan keys.
- A task keeps the profile it was proposed under when accepted after a project profile change. Plans are bounded through the existing Tasks normalization and PII screen. Catalog defaults are guidance, not new flow roles; explicit per-peer catalog selections replace profile defaults, including an empty list.

# Literature review example

- Initialize a new folder with `ahub init --profile research`.
- Propose a survey task for three declared sources; its base is summarize. Propose extract tasks with source ids and section anchors, then synthesize after those tasks are approved.
- Propose fact_check with the claim ids and source map. A model labels each claim supported, unsupported or unclear. A person or deterministic check decides whether it passed; a model judgment alone never establishes verification.
- Configure an explicit machine-local `checks.fact_check` command if desired. Alias checks take precedence over a base `checks.test`; no check runs merely because a profile was selected.
- Example deterministic check: `bun /path/to/agent-hub/scripts/check-citations.ts report.md references.bib`. It checks bracketed Markdown `[@key; @other]` keys against BibTeX entry keys, with 256 KiB/4 MiB input caps. It performs no fetch, validates no source quality and is not a full Markdown/BibTeX parser. A missing key exits 1. A resolved bibliography is one check, not proof that claims are supported.
- Keep a person's sign-off as the final review. The live three-source/two-agent example remains unverified and was not run during solo implementation.

# General project example

- Initialize with `ahub init --profile general`.
- Propose plan for an event checklist, do for the agreed deliverable, and check for the declared acceptance criteria. Their bases are plan, implement and test.
- Name deliverable paths and section anchors before starting, then report observed outcomes and unknowns. Select `reviewer: user` through the existing routing policy when a person's decision is required.

# Current scope and remaining slices

- Peer guidance and profile-specific task schemas use existing MCP/native/local paths. Research defaults use the #295 dev/research catalog, with bases already held. Writing/general do not add catalog groups before measurement.
- Board/public projections, route explain, terminal/dashboard cards and #247 events/records carry the profile alias and base. Native model ingestion and context retention remain unverified.
- Document text projections, shadow git for non-git folders, pii.paths/data.readonly policy, custom profile overrides and deeper lifecycle integration remain open in #259. Existing file policy still applies; profile guidance does not itself enforce read-only data.

- Accept schemas expose all supported plan fields because an open task keeps its stored profile across a project profile change. Tasks still normalizes by that stored profile; no new plan field changes authority.

- Private and read-only data path policy is now a separate source slice: [data policy](data-policy.md). It applies to declared task paths and managed local/Pi tools. Converter/shadow/custom/live follow-ups remain open.
