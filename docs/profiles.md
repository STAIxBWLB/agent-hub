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
- Bounded rich-document facts/review/undo projections and declared pii.paths/data.readonly policy are supported. Opt-in shadow git supports non-git folders; custom profile overrides/globs and deeper lifecycle integration remain open in #259. Native ingestion and research measurement remain unverified.

- Accept schemas expose all supported plan fields because an open task keeps its stored profile across a project profile change. Tasks still normalizes by that stored profile; no new plan field changes authority.

- Private and read-only data path policy is now a separate source slice: [data policy](data-policy.md). It applies to declared task paths and managed local/Pi tools. Custom/glob and native/live follow-ups remain open.

- Optional machine-local [text projections](text-projection.md) supply bounded rich-document facts diffs. Converter output is presentation evidence and cannot prove raw-file attribution.

# Non-git folders

- Use `ahub init --profile research --shadow` to create `.agenthub/shadow.git` without a `.git` entry. `--dry-run --json` previews the same action without writes. Existing Git projects are refused for shadow opt-in; ordinary init does not select it.
- `.agenthub/ignore` contains owner-managed patterns for large/raw data (`data/raw/` initially). Hub snapshots and facts honor it, while runtime/local config and shadow metadata remain excluded. Models gain no permission to write hub metadata.
- Research/writing/general projects without Git or shadow run the hub with facts/snapshots/undo off and one notice. Legacy dev named-file facts remain supported; Git directory facts, snapshots and undo require a repository.
- Shadow HEAD/index are not changed by hub snapshots or raw undo. Later-edit and concurrent/unknown-turn guards still apply. Linked/shared/malformed shadow metadata is refused. Each shadow Git call revalidates descendants without following links (at most 20000 entries and 32 levels), including cached repository handles. Native model/account research runs remain unverified.

# Project profile overrides

- `profile_overrides` in shared/local config selects project data over the chosen shipped profile. `classes`, `role_text` and `catalog_roles` maps merge by key across layers; `plan_keys`, `agents` and `example_checks` replace as units. A local `profile` selects the active base for both init and native contracts.
- Classes may add or remap profile aliases to existing base classes. Existing base names keep their meanings; class maps are bounded to 32 override entries. Task storage and route explanations preserve the alias, including a dev custom alias, while routing/budgets/checks use its base. Other tasks under custom dev data retain the selected profile semantics too, so document sections do not become whole-path overlaps. Unmodified dev rows retain their old shape.
- `plan_keys` selects distinct existing plan fields, not new board fields. Task proposals and their schemas use the selection. Accept schemas retain legacy fields for already existing tasks/profile changes.
- `role_text` is bounded guidance for existing flow roles (2000 characters each); it grants no authority. `catalog_roles` supplies bounded compatible guidance ids; the existing explicit catalog selections take precedence. Actual flow maps remain in `roles` and retain their existing validation.
- `agents` replaces only the managed AGENTS block (16000 characters maximum); surrounding instructions remain. Init previews contain paths/actions only. `example_checks` is at most 16 display strings of 2000 characters, shown as advisory examples by init and never selected as executable checks. Existing `checks` trust remains authoritative.
- No override mutates shipped profile data or another project. Unknown fields, base remapping and invalid/oversized data are refused. Headers are quoted. Daemon/MCP restart is required for config changes; no native model consumption or research measurement is claimed.
