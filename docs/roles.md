# Role catalog (#295)

- Flow roles remain conductor, planner, implementer, verifier and reviewer. Only the existing `roles` block controls their authority and routing. Catalog roles are bounded guidance selected through `catalog_roles`; they add no tool, capability, permission mode, sandbox reach or routing preference.
- Default catalog assignments are absent. Existing flow contracts are byte-identical to main d83cb8dd when no catalog role is selected.

# Definitions and layers

- Shipped definitions live at `templates/roles/dev|research/<id>.md`. The first catalog has six dev and five research roles. Other shipped groups wait for the #251 measurement.
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
- Person catalog assignment/clear, settings controls and pending session marks are supported. Board cards remain a later #263 slice. Task proposal roles and review-duty notices are supported as described below. No CLI or hub tool writes a role definition.
- The delivered slices cover the library, bounded config/session publication, read-only diagnostics and task role guidance. Native model ingestion, compaction retention and one live role/task cycle are unverified; no study was run in the solo implementation. The parent #295 remains open for full session records, remaining surfaces and measurement criteria.

# Attribution

- Eight dev/research candidates were inspected at agency-agents f99f6aa910a442b0197b768ce0ea7751e35e2060, using their mission/rule sections as reference. Guidance is rewritten for the hub's scope and evidence contracts; persona, code samples, shell commands and autonomy claims are excluded.
- Each adapted role names its upstream path/commit. Research lead, analyst and fact checker are original definitions. `templates/roles/NOTICE.md` contains the upstream MIT notice; the plugin's copy is generated and freshness-checked because marketplace installation copies only the plugin directory.

# Task roles (#295)

- `hub_task_propose` accepts an optional `role` catalog id. Tasks refuses unknown ids or class mismatches before storing a row, with the allowed ids for the task base class. Research/writing aliases use their existing base class. Role ids never change routing, flow roles or permission policy.
- The board persists the id across restart and ownership changes. Assignment notices include bounded sanitized guidance; review requests include the role's Review duties. If this daemon prepared that native session's matching contract, the owner notice names the id without repeating its body. Externally started plugin sessions have no such receipt and retain the task guidance.
- PII stubs, task events and research records expose only the role id/identity, never the private task text or role body. A removed definition leaves an id-only unavailable notice.
- Session roles in research records, board cards and native role-ingestion/measurement remain pending. No role tool accepts definition text or edits a role file.

- Complete task role guidance, header included, is capped at 2000 characters. An oversized definition is refused before proposal storage; a saved task whose definition later exceeds the cap keeps an id-only notice. Definitions are never truncated.

- Task research records retain the original proposal role identity when that event is available. Reloaded definition hashes on later task events do not replace it. A missing proposal or original hash remains unknown for live aggregation and backfill.

# Person assignment controls

- `ahub role assign <peer> <id>` adds one id to that peer's configured selection, up to two. `ahub role clear <peer> [<id>]` clears one id or all. `ahub settings set catalog_roles.<peer> inherit` restores shared/profile selection. Explicit empty lists disable catalog guidance.
- The Roles settings group uses the same registry, machine-local write and undo path. Known ids must match a flow base the peer holds; no role definition or flow authority is editable there. Shared config is never changed. Guidance changes apply at the next peer start.
- Status, console peer detail and dashboard distinguish configured guidance from a prepared active session, with pending marks. An external MCP/TUI session without a preparation receipt remains unconfirmed; configuration is not model-consumption proof. Definition file changes still require a daemon/MCP restart.
- `ahub task role <id> <role|none>` changes guidance through Tasks for open tasks only. It keeps ownership, class and permissions and notifies current holders with bounded guidance. Approved roles remain historical. Existing task role identity in research records is not overwritten by later changes.
