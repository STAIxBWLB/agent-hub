# Role catalog (#295)

- Flow roles remain conductor, planner, implementer, verifier and reviewer. Only the existing `roles` block controls their authority and routing. Catalog roles are bounded guidance selected through `catalog_roles`; they add no tool, capability, permission mode, sandbox reach or routing preference.
- Reviewer completion (#784, this repository): the reviewer that approves a PR at its head merges it once exact-head CI is green, no review thread is unresolved and no change request is pending, then removes the branch and worktree, or names the open gate. A release PR waits for the person's release consent. This is this repository's convention (its `AGENTS.md`, outside the managed block), not a shipped default: the AGENTS block template, the catalog roles and the flow role contracts are unchanged, so another project keeps merge with the person unless its own AGENTS.md delegates it.
- Default catalog assignments are absent. Existing flow contracts are byte-identical to main d83cb8dd when no catalog role is selected.

# Who may hold a flow role (hub task 899, #1408 R1, R2)

- Eligibility is data on each adapter definition, next to `plannerEligible`: `conductorEligible` is true only for a kind with an interactive form that receives hub pushes and holds a writable tools connection (today claude, codex, jcode and pi), and `reviewerEligible` is true for every kind that can receive `hub_review` (all but agy). A kind not yet proven is listed false. `roleEligibility(peer, role, startMode)` in `src/adapters/role-eligibility.ts` answers yes or no with a reason and a fix, and the loader, `ahub doctor` and the docs all read it.
- The loader ignores a `conductor` entry on a peer whose kind is not `conductorEligible`, or whose effective start mode is headless (`peers.<peer>.start_mode`, `config.local.json` winning over the shared file), with a notice that names the reason and the fix. Nobody else gains the role: the project then has no conductor and the person conducts from `ahub console`. A conductor that is ignored never holds the role after a reload or a recovery either.
- Setting the conductor's `start_mode` to `headless` is refused: "<peer> holds the conductor role, which needs an interactive session; move the role first". Move the role in `roles` first, then change the mode.
- `ahub doctor` has a `roles` row: who holds conductor, planner and reviewer as the hub settled them, with a warning when a conductor is ignored, when no rostered planner is eligible, or when no reviewer can run and reviews fall to the person.
- `ahub init --conductor <peer>|none`, `--planner <a,b,...>` and `--reviewer <a,b,...>|person` (hub task 900, #1408 T2) choose the three roles at init, each on its own, judged by the same `roleEligibility` the loader and doctor use. Only the named role moves: each peer whose roles change is written to the shared `roles` as an explicit list (the one that loses a role too), implementer and verifier stay, and a refused choice names the reason, the fix and the eligible peers before any write. No flag changes nothing. See [operations](operations.md).

# Choosing who conducts, plans and reviews

Hub task 901 (#1408 R4). Three roles are chosen separately, at `ahub init` (`--conductor`, `--planner`, `--reviewer`, see [operations](operations.md)) or in the `roles` block of `.agenthub/config.json`. A project with no conductor is valid: you conduct from `ahub console`. `ahub doctor` shows who holds each role as the hub settled them. The shipped default is `claude` as planner and reviewer, written by `templates/config.json`; `ahub init --planner <peer>` changes it and nothing else does.

## Who may hold what

The table is generated from `roleEligibility` (`src/adapters/role-eligibility.ts`), the one function init, the loader and doctor read, and `test/roles-doc.test.ts` fails when it differs from the registry. A conductor is judged in each start form: it needs an interactive session that receives hub pushes and holds a writable tools connection, so a headless form never conducts.

<!-- eligibility-table:begin -->
| Kind | Start forms | Conductor | Planner | Reviewer |
| --- | --- | --- | --- | --- |
| claude | tui | tui | yes | yes |
| codex | tui, headless | tui | yes | yes |
| kimi | tui, headless | no | yes | yes |
| pi | tui, headless | tui | no | yes |
| local | headless | no | no | yes |
| qwen | headless | no | yes | yes |
| jcode | tui, headless | tui | yes | yes |
| agy | tui | no | no | no |
<!-- eligibility-table:end -->

- **Conductor**: claude, codex, jcode and pi, in their interactive (`tui`) form only. kimi's tui is pull-only (no pushes), qwen's tui has no case that drives it as a conductor yet, local is headless only and agy is pull-only; a kind stays `no` until a case proves it. claude has no headless form at all.
- **Planner**: a kind with `plannerEligible`. **pi stays implementer-only**: its tool bridge carries the planner tools (`hub_backlog_*`, `hub_plan_review`), so tool admission is not the gap; the gap is a receipt that a Pi model plans a backlog, which no fixture can give. `plannerEligible` is not flipped without a live receipt (T5).
- **Reviewer**: any kind that can receive `hub_review` (all but agy), or the person (`--reviewer person`).

## Evidence grades

- **fixture-proven**: the hub's side of the contract is exercised on the existing fakes (a real daemon, the fake native transports, no model and no account). It proves roles, refusals and delivery, never a model's behavior.
- **live-proven**: a person ran it on real local models and recorded it under `docs/verification/`. None of the combinations below is live-proven yet.

`test/conformance/conductor.test.ts` is the conformance for the conductor column. For each kind the table lists it starts a real daemon whose project config names the kind the conductor, connects as that kind and checks, in the interactive form, that the conductor feed (the hub's supervision envelopes) reaches it and that `hub_status`, `hub_task_assign` and the hold tools (`hub_peer_hold`, `hub_peer_release`) are accepted. In the headless form the loader ignores the role (with the fix), every one of those calls is refused and no feed is sent. A kind the table marks `no` is checked to be refused the same way.

## Combinations without a commercial service

Every role is filled by open-source tooling on local or self-hosted models; none needs a commercial agent. Each row below is settled through the real loader and the doctor row by `test/roles-doc.test.ts`, so the roles are the roles the hub keeps.

| Combination | Conductor | Planner | Reviewer | Implementer and verifier | Evidence |
| --- | --- | --- | --- | --- | --- |
| open, agent-led | jcode (tui, on an OpenAI-compatible self-hosted gateway) | jcode | qwen, local | pi, local | fixture-proven: roles, conductor conformance and doctor row. The live leg on local models is manual and needs the person's approval (T5). |
| open, qwen-led | none: qwen has no conductor case yet, so the loader ignores it | qwen | jcode, local | pi, local | fixture-proven for planner and reviewer; **no agent conducts**, so you conduct from `ahub console` until a qwen conductor case exists. |
| person-led | none (you, `ahub console`) | none (you, `ahub backlog` and `ahub task`) | the person | pi, local | fixture-proven: the hub settles no conductor, planner or reviewer, and the doctor row warns that reviews go to the person and that no planner is rostered, which is this combination's intent. |

To write the first row with init: `ahub init --conductor jcode --planner jcode --reviewer qwen,local`, after turning the peers on in the roster (`ahub roster add <peer>`).

# Definitions and layers

- Shipped definitions live at `templates/roles/<group>/<id>.md`: six dev and five research roles, plus four writing and two ops roles that the domain packs use ([profiles](profiles.md)).
- Project definitions at `.agenthub/roles/<id>.md` replace the same shipped id. Machine-level definitions are deferred. Files are bounded regular files, at most 8 KiB, with no symlink/hardlink targets; project directories cannot be symlinks. Scanning is flat and capped at 64 files.
- A flat header declares id, name, group, summary, base, classes and source. Id equals the file stem. Base is one or more existing flow roles excluding conductor; classes name today's seven base task classes. At least one declared base must already be held by a peer receiving that session guidance.
- Exactly six nonempty sections, in order: Scope, Not in scope, Deliverables, Hub use, Review duties, Evidence. Rendered body is at most 2000 characters. No extra heading/personality section, code block, command-shaped line, emoji, control or non-ASCII punctuation. This syntactic lint is not an instruction-safety classifier; project text is labelled untrusted guidance and cannot change daemon authority checks.
- Every role has its full UTF-8 content SHA-256 and a shipped/project layer label. Invalid project files are skipped with a bounded id/reason diagnostic, never their contents. A valid shipped role remains available if an invalid override is skipped. Unknown or incompatible assignments are refused with a diagnostic and receive no catalog text.

# Selection and delivery

Example shared or machine-local config:

```json
{ "catalog_roles": { "codex": ["backend-engineer"], "kimi": ["analyst"] } }
```

- Blocks merge per peer as `roles` does; a local empty list clears that peer's shared list. At most two distinct ids per peer. Definitions and selections are read at daemon/MCP start in this initial slice. File edits require a new start to refresh the selected guidance.
- Claude channel/inbox MCP instructions append catalog guidance after flow lines. Native tools-mode MCP instructions keep flow lines only, avoiding a second copy for Codex/Kimi headless. Codex, Kimi headless, Qwen, Jcode, Pi and local receive guidance in their existing role preamble/system prompt paths.
- ACP/Codex deliver the bounded preamble on the first delivery of an adapter start; Pi receives its existing launch/system prompt; local keeps its existing per-call system prompt behavior. A resumed native conversation starts a new adapter publication scope; context-compaction persistence is unverified. No inference is made about whether a vendor actually consumes MCP instructions (notably Kimi TUI).
- `role` events record prepared ids, layers, hashes and actor `config`, never body text. Prepared means the contract was constructed, not acknowledged by a model or successfully executed. Research-record session attribution/acknowledgement remains a follow-up.
- Role bodies next to hub headers pass through `sanitize()`. Catalog section is bounded to two 2000-character bodies plus its metadata header. A role cannot make a native peer read-only: the peer's existing permissions still apply.

# Commands and current scope

- `ahub role list [--group <group>]` lists metadata, layers and hashes. `ahub role show <id>` displays the selected definition. Both use terminal sanitization. `ahub doctor` reports invalid definitions or assignments.
- Person catalog assignment/clear, settings controls and pending session marks are supported. Board cards show stored task guidance IDs without exposing role body text. Task proposal roles and review-duty notices are supported as described below. No CLI or hub tool writes a role definition.
- The delivered slices cover the library, bounded config/session publication, read-only diagnostics and task role guidance. Native model ingestion, compaction retention and one live role/task cycle are unverified; no study was run in the solo implementation. The parent #295 remains open for full session records, remaining surfaces and measurement criteria.

# Attribution

- Eight dev/research candidates were inspected at agency-agents f99f6aa910a442b0197b768ce0ea7751e35e2060, using their mission/rule sections as reference. Guidance is rewritten for the hub's scope and evidence contracts; persona, code samples, shell commands and autonomy claims are excluded.
- Each adapted role names its upstream path/commit. Research lead, analyst and fact checker are original definitions. `templates/roles/NOTICE.md` contains the upstream MIT notice; the plugin's copy is generated and freshness-checked because marketplace installation copies only the plugin directory.

# Task roles (#295)

- `hub_task_propose` accepts an optional `role` catalog id. Tasks refuses unknown ids or class mismatches before storing a row, with the allowed ids for the task base class. Research/writing aliases use their existing base class. Role ids never change routing, flow roles or permission policy.
- The board persists the id across restart and ownership changes. Assignment notices include bounded sanitized guidance; review requests include the role's Review duties. If this daemon prepared that native session's matching contract, the owner notice names the id without repeating its body. Externally started plugin sessions have no such receipt and retain the task guidance.
- PII stubs, task events and research records expose only the role id/identity, never the private task text or role body. A removed definition leaves an id-only unavailable notice.
- Attributed turn preparations are included in opt-in research records as described below. Board-card IDs are implemented; native role-ingestion/measurement remains unverified. No role tool accepts definition text or edits a role file.

- Complete task role guidance, header included, is capped at 2000 characters. An oversized definition is refused before proposal storage; a saved task whose definition later exceeds the cap keeps an id-only notice. Definitions are never truncated.

- Task research records retain the original proposal role identity when that event is available. Reloaded definition hashes on later task events do not replace it. A missing proposal or original hash remains unknown for live aggregation and backfill.

# Person assignment controls

- `ahub role assign <peer> <id>` adds one id to that peer's configured selection, up to two. `ahub role clear <peer> [<id>]` clears one id or all. `ahub settings set catalog_roles.<peer> inherit` restores shared/profile selection. Explicit empty lists disable catalog guidance.
- The Roles settings group uses the same registry, machine-local write and undo path. Known ids must match a flow base the peer holds; no role definition or flow authority is editable there. Shared config is never changed. Guidance changes apply at the next peer start.
- Status, console peer detail and dashboard distinguish configured guidance from a prepared active session, with pending marks. An external MCP/TUI session without a preparation receipt remains unconfirmed; configuration is not model-consumption proof. Definition file changes still require a daemon/MCP restart.
- `ahub task role <id> <role|none>` changes guidance through Tasks for open tasks only. It keeps ownership, class and permissions and notifies current holders with bounded guidance. Approved roles remain historical. Existing task role identity in research records is not overwritten by later changes.

# Session role research records

- Each attributed completed turn records the role ids, layers and hashes prepared in its native preamble at turn start. Opt-in research JSONL records retain these as `sessionRoles` entries with the peer and turn id; live and backfill use the same events. Role bodies are excluded, including for PII tasks.
- An explicit empty list means a native contract was prepared with no catalog role. `null` means no preparation receipt, as for an external plugin/TUI session. Older events without the field leave it absent; neither absence nor `null` means zero roles.
- A pending setting change does not rewrite a running turn. A subsequent native start prepares the new selection. These records establish preparation, not model consumption or role effectiveness. The existing CSV summary columns are unchanged; JSONL includes the full metadata.


Board cards show the stored task guidance id, including on private task stubs,
without role text or extra authority. Dashboard snapshots retain separate peer
role metadata so current flow/catalog and pending session guidance use the same
source as status. Current source/native/visual verification remains pending.


Baseline reconciliation, 2026-10-13: ROLE_TEXT and roleContract source blocks
are byte-identical at original1cbbc57 and laterd83cb8dd; the latter changes only
default role construction to the peer catalog. The five original rendered
contracts match both fixtures. A new independent original-baseline assertion
retains the existingd83 assertion unchanged. Assignment-notice byte comparison
is separately verified by the five-peer fixture; role strings alone still do
not establish native consumption. Native/visual consumption and role-effect
measurement remain unverified.


The original assignment fixture uses a review task with explicit owner and
review.local_allowed=true so all five historical peers are valid recipients.
It preserves the 1cbbc57 message text/facts/acceptance instruction without catalog
or task guidance, using the same routing choice for both implementations.
This fixture passes in the actual53/0 integration group. Full final gates and
native consumption remain pending.
