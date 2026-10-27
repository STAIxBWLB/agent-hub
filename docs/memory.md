# Hub memory integration

Agent-hub consumes the exact-pinned first-party [`@staix/agent-mem`](https://github.com/STAIxBWLB/agent-mem) library (current pin `0.10.0`, initial pin `0.1.1`). The package owns portable storage, tiers, graph, goals, sync, import and raw commands. Agent-hub owns caller authority, current project privacy policy, task lifecycle integration and presentation. Claude-mem is an optional, explicit import source only; runtime recall and capture make no worker HTTP requests.

## Portable core and data directory

The [agent-mem repository](https://github.com/STAIxBWLB/agent-mem) is the reference for the data model, immutable entry IDs, append-only segments, derived SQLite index and rebuild equality, home selection, import cursors, dedupe and machine sync. Shared v1 remains the default and needs no migration: schema `agent-hub.memory/v1`, canonical hashes and log/machine/lock paths remain compatible. `memoryHome()` comes from the package and selects `AMEM_HOME`, then `$AGENTHUB_HOME/memory`, then `~/.agenthub/memory`; an explicit `StoreOptions.home` keeps its parent-directory meaning. The test preload (`test/hub-home.ts`) clears inherited `AMEM_HOME` and supplies an isolated `AGENTHUB_HOME` when none is provided.

`src/memory/` contains hub integration only: briefs, recall, the in-process amem client and deterministic capture. `src/hub/memory-policy.ts` supplies `withoutPii`, `promotionScreen` and `mentionsPrivatePath`; `src/hub/read-tools.ts` supplies screened peer reads. Deny, hardened git, realPath and process identity come from the package's Node-safe `@staix/agent-mem/platform` entry and are re-exported through the existing local/hub/Pi modules. No core implementation is vendored in agent-hub. The `0.1.1` platform subpath is required because `0.1.0` exposes only a root entry that loads `bun:sqlite`, which Node-hosted Pi extensions cannot import. This is a packaging compatibility export; the platform algorithms are unchanged.

## Selected memory profile

The memory root `M` is independent of the project state directory. The package's `M/profile.json` selects shared v1 or an explicit generation `G`; an absent selector means shared v1. The hub opens the selected profile with its current privacy screen and configured TTL. A generation uses `M/generations/G`, reads legacy prefixes through the package's readonly bridge, and writes its own rows and sync history there. The bridge does not migrate legacy bytes or use the legacy index. Exact-entry prune remains the package's person-only operation; it adds no shared-v1 operation and gives hub tools no prune authority.

A curated split (agent-mem#15 T2, `amem migrate --shards`) writes `M/shards.json`. Once it is active, the hub opens memory through the package's `openShardStore` for the project's key: `memoryProjectKey` of the hub's project, resolved through the person-reviewed alias log of the memory home, the same key the `amem` CLI binds. The daemon and `ahub memory`/`ahub goal` read and write under that key, split or not. A running hub resolves the key once at start; when `amem alias add` later maps that key elsewhere, its binding latches unavailable at the next memory entry, and a restart binds the new key. That store is this project's shard, with the user shard as its overlay. Other projects' private notes are not in it. A project first seen after the split gets its own shard on first open. The binding compares the shard identity (key, sealed generation, selector revision) at every entry. A split marker that is not active (captured, malformed, or a dangling or unreadable `shards.json`) refuses with `amem migrate --shards --resume` as the remedy and is never read as an empty or legacy store. A marker that appears under an open unsplit binding latches that binding unavailable. Without a marker, the hub opens memory exactly as before. `ahub memory profile-check` is split-aware: on a split home it compares each running hub with the shard profile of that hub's own project (alias-resolved key, sealed generation, selector revision) without opening a store, and an inactive split reports the `amem migrate --shards --resume` remedy and exits 1 (#536).

All hub consumers share that binding: Tasks notes and lifecycle operations, leases, suggestions, briefs, recall, peer read tools, dashboard, ask and automatic sync. Standalone `amem` and `ahub memory`/`ahub goal` must resolve the same root and profile to see one another's writes. An invalid selector or missing/corrupt generation disables native memory without taking down the bus or task board; it never silently opens shared v1. The daemon reports its package/profile binding and availability separately from ordinary hub health.

Person-facing status and memory output show the profile and nonzero malformed-row count. Allowed agent-shell reads retain current row screening and receive only a short profile label; full generation IDs, the memory home and home-wide skipped totals are available through authenticated person status and person CLI receipts, never the shell-readable status.json file or agent CLI output. Domain JSON shapes are unchanged; the additive `memoryProfile` receipt belongs to status, profile-check and the person-only decay object. Profile-check reports the registry scope it inspected; inventory separate custom registries too before treating zero live claims as quiescence.

A running daemon keeps its original binding. Explicit checks at hub operation entry and before sidecar writes fence later operations when the selector changes or becomes unavailable; they do not switch stores in place. These checks are not atomic with an in-flight core operation: changing selection during such an operation is outside the supported cutover contract. Before migration or a selector change, quiesce every consumer of this memory home and close its handles; reopen through the supported session-preserving lifecycle afterward. A public core pre-write hook is the upgrade path for atomic in-flight cutover. Current policy screening, PII-turn refusal, capture exclusion and fail-open task delivery remain in force.

Candidate/counter data stays at `M/candidates.db`, independently of the selected note profile, using the package's explicit sidecar home convention. It is not copied into `G`, migrated or synced. The hub fences sidecar producers with the note-profile binding. Since agent-mem 0.7.0, `amem review` lists and accepts candidates on a selected generation too, writing accepted notes into that generation; dashboard acceptance is still not added.

Source and synthetic fixture checks do not authorize migration of the person's memory home. Before real migration, every hub sharing the memory home must run 0.12.30 or later. Real rollout still needs separately approved installation, matching live package/root/profile/selector bindings, synthetic cross-write and prune readbacks, and a supported quiesce/close/reopen sequence before separately confirmed real migration. Every running hub using this home needs an authenticated receipt: a matching ready binding, or a generation-capable unbound receipt (`disabled` when native memory is off, `unavailable` when opening failed) proving it holds no memory handle. An unbound daemon and zero running hubs are quiesced for memory; a stale bound handle, unreadable registry or unknown runtime is not ready. Real account/device sync, native capture and live memory receipts remain distinct acceptance legs. See [agent-mem migration and prune](https://github.com/STAIxBWLB/agent-mem#generation-migration-and-exact-entry-prune) for the person CLI and recovery limits.

For a standalone CLI refusal, inspect the selector and generation state and run `ahub memory profile-check`. If deliberately abandoning the selected generation, use the person-only `amem migrate --deactivate` recovery path; a CLI error does not itself require restarting a hub.

## Turning it on and off

On with any project config (`.agenthub/config.json`); `"memory": { "native": false }` turns it off for a project.
`memory.short_ttl_days` (default 14, a whole number from 1 to 3650; anything else fails the config) sets how long
short-term entries live after their task is approved, and `memory.sync_interval_min` (default 10, 0 off, at most 1440) how often a running
hub syncs once a remote is set. Writing and
reading are fail-open: a store that cannot be written costs one notice, and never a tool call or a turn.

## Task lifecycle and host policy

Notes on open tasks stay short-term. Approval settles the task and can promote decision, contract and fail notes; findings stay short-term. The hub injects its current project screen through `StoreOptions.screen`: another project's notes are left to that project's processes, and secret-looking text, current PII patterns and private paths keep a note local rather than promoting it. A task's current paths are screened as well as its stored nodes. Task-specific deadlines retain the existing configured TTL and package lifecycle semantics.

## What gets written

- `hub_remember` from any peer or `ahub remember`, after the existing checks: a note about a PII task, or one matching a
  PII pattern, is refused; the PII screen (#198) must clear it; a note that looks like it holds a secret (a private key,
  a cloud or GitHub token, `password: ...`) is refused.
- The hub's own notes on a task: the done summary (finding), the review verdict and an escalation (decision), with the
  same PII and secret rules. Nothing about a PII task is written.
- Notes still go to claude-mem when it is enabled, as before; the other peers get the note line on their next delivery.

## Graph integration and suggestions

The hub supplies task refs, plan paths/symbols and note context when extracting deterministic nodes. Briefs and ask use the package graph; the portable node and edge model is documented in agent-mem.

Model-suggested edges are off by default (`"memory": { "suggest_edges": true }`). After a note is saved, the hub's model (the digest-condensation route) may name `contradicts` or `same_topic` between it and up to six near entries. Answers are checked against that closed list and stored as `hub-model` suggestions. They are dashed on the dashboard and excluded from briefs, recall and `ahub ask` until a person confirms one (`ahub memory confirm <id>`); a rejected suggestion disappears.

## Long-term task integration

Goal storage and leases are supplied by agent-mem. The hub integrates them with board tasks:

- **Titles** and milestones are kept to one line (whatever another machine wrote), and recall lines are sanitized, so
  they cannot carry a forged message header into an agent's context.
- **Links**: a peer joins its own board task to one of this project's long-term tasks with
  `hub_task_propose(..., goal: "<id>")`; a person links any board task of the project to any long-term task with
  `ahub goal link <id> <task>` (through the running hub, so the board task is checked). Nothing about a PII task is linked.
- **Lease**: while a linked board task is in progress on this machine's hub, the hub holds the long-term task's lease
  (default 4 hours, renewed past half its time). It looks at every in-progress task at start, every 10 minutes, when
  a task changes on the board and when a person links one, so a task worked on for hours keeps its lease. It never takes a lease another machine holds: the console says who
  holds it, and a person takes it over with `ahub goal take <id> --force`, which voids every earlier claim. A lease that
  expired is free for anyone.
- **Conflicts**: sync is eventually consistent, so a lease is advisory. Two machines that claim inside one sync window
  both stand: the earlier claim holds and the other shows as a conflict everywhere (status, dashboard, `ahub goal`)
  until a person settles it with `--force`. There is no consensus; a broker would make it a real lock if concurrent
  work across machines ever needs one.
- **Where it shows**: at hub start (a console line per open long-term task of the project), in `ahub status`, in
  `ahub goal list`, on the dashboard's Long-term tasks tab, and leading the session-start recall. Briefs bring along
  the entries of the long-term task's other board tasks.

```bash
ahub goal new "native memory" --milestone "phase 1" --milestone "phase 2"   # a person's
ahub goal link 1a2b3c4d 12
ahub goal                                  # open long-term tasks, their state and lease
ahub goal show 1a2b3c4d
ahub goal take 1a2b3c4d [--force]
ahub goal state 1a2b3c4d blocked
ahub goal done 1a2b3c4d
```

## Automatic sync integration

A person configures the private remote with `ahub memory sync --remote <private-git-url>` and can sync immediately with `ahub memory sync`. Machine labels use `ahub memory machine --label <name>`.

A running hub syncs 5 seconds after start and every `memory.sync_interval_min` minutes (default 10; 0 disables it) once a remote is set. Failure produces one log line and never blocks a turn; without a remote it does nothing and creates nothing. The package retains one sync per machine, public-GitHub-remote refusal and unknown-visibility warnings. Credential-helper use is restricted to the memory repository the hub creates, never a project's git repository, and never prompts. Transport, segment merge, lock and retained-history semantics belong to agent-mem.

## Reading it

- **Task briefs**: when a task is handed to an owner, its brief lists hub memory first (entries one or two hops from
  the task's paths, symbols, issue and task: a linked fail first, then nearer, then newer; superseded entries dropped;
  other projects' entries only when shared), then related amem curated notes, `memory.brief_items` lines in all. A peer is never
  shown the same entry twice in one hub run.
- **Session-start recall**: this project's long-term decisions, contracts and fails (and shared ones) lead the recall block; display-only filtering omits automatic approval notes, while changes-requested notes show their nonempty reasons. Lines preserve their headers and end at word boundaries with a visible marker when capped; each delivery deduplicates memory ids across prefaces and note lines. Stored notes and brief evidence are unchanged. Recent short-term amem curated notes follow; each gets half of `memory.inject_tokens` when both answer.
- **`ahub ask`**: entries that match the question and the graph neighbourhood of what they are about are evidence, cited
  as `[mem:<8 hex>]` for existing native projections or `[mem:<32 hex>]` for full entry references. A question that carries PII skips them. `ahub ask --remember` writes a pending candidate, never curated evidence; a person must review it.
- **`ahub memory`** needs no running hub. The hub CLI identity gate allows screened list/search/show reads in agent shells; graph and unscreened views are a person's. Managed peers use the bounded `hub_memory_search`, `hub_memory_show` and `hub_memory_graph` tools through the daemon, with project scope, `memory_read`, PII-turn refusal and capture exclusion:

```bash
ahub memory                              # this project's entries, newest first, with tier counts
ahub memory list --tier long --kind fail --peer codex --since 2026-10-01 --json
ahub memory search parser quoting        # every word must match the title, text or nodes
ahub memory show 1a2b3c4d                # one entry with provenance and edges (this project's or a shared one)
ahub memory graph 1a2b3c4d --hops 2      # its neighbourhood as edges, a person's (labels are unscreened); also a node: path:src/csv.ts
```

- **The dashboard** has a Memory section: short- and long-term tabs, search, filters by kind, peer, machine and time,
  the list of entries, and for a selected entry or node its neighbourhood (one or two hops, at most 200 nodes) as an
  inline SVG drawn in the page with the same edges as a text list, and its detail with provenance. It is read-only and
  stays inside the page's content security policy: no requests other than the dashboard's own snapshot.

## Changing it

`list`, `search` and `show` may run in agent shells, so they leave out notes that match the project's current PII
patterns or are about a path its `pii.paths` makes private (a shared note was accepted under another project's patterns) and say how many; the dashboard shows a person
everything. A person's, from a terminal (agent shells are refused):

```bash
ahub memory promote 1a2b3c4d             # a short-term entry gets a long-term copy
ahub memory demote 1a2b3c4d              # a long-term entry becomes short-term and expires
ahub memory forget 1a2b3c4d              # gone from the index here, and on other machines once synced
ahub memory supersede <old> <new>        # the old one is dropped from briefs and recall
ahub memory rebuild
ahub memory dedupe                     # inspect legacy claude-mem duplicate groups
ahub memory dedupe --apply             # append supersede relations, never rewrite log bytes
```

For storage-level forget, supersede, expiry and dedupe semantics, see [agent-mem](https://github.com/STAIxBWLB/agent-mem). A forgotten shared entry remains in log and remote git history; removing that history is a person's operation. The hub keeps current project privacy checks around every raw command callback. The standalone `amem --policy-free` choice is not available through `ahub memory` and never grants a peer extra authority.

## Importing from claude-mem

`ahub memory import claude-mem [--db <path>] [--limit N] [--restart]` is a person's command. It imports peer-tagged hub observations for the current project through the package's read-only SQLite importer. The hub supplies the current routing PII patterns and `pii.paths` screen; model answers and secret-looking text remain excluded. The source database is never changed.

The package owns deterministic import identity, text-only graph extraction, cursor bookkeeping, tuple fallback and result counts. `--restart` revisits rows skipped under an earlier policy. Claude-mem's basename namespace can still collide between unrelated repositories; a superproject's observations stay out. A repository without an origin still uses machine-local project identity. These ceilings are unchanged by the library switch.

`ahub memory dedupe [--apply] [--json]` remains console-only, including listing, because it shows unscreened note text. The package's reconciliation appends ordinary supersede operations; historical log bytes are never rewritten.

## Measuring it

Whether hub memory helps is measured, not assumed (#258 AC11, with #248):

- Each task brief writes a `memory_brief` event with counts only (hub-memory items, fails among them, supplemental
  items in the legacy `claudeMem` count field; new events identify `source: "amem"`); research records keep `briefs` (`delivered`, `withFail`), and `ahub research` splits approved tasks into
  "a fail note in its brief", "brief without a fail note" and "no brief recorded" (first pass, rework, check failures).
- `ahub bench run --memory off|claude-mem|native|both` declares an arm's memory and refuses a hub that runs with other
  settings; compare the arms with `ahub bench compare`.
- Whether an agent retried an approach a fail note had ruled out cannot be read from ids and counts. A task whose brief
  carried a fail note and was still sent back or failed a check is a candidate, to read by hand.

## Privacy

- Nothing about a PII task enters the store: the tool refuses it and the hub's own notes skip it. Text that matches a
  PII pattern, that the PII screen does not clear, or that looks like a secret is refused or skipped with a notice.
- Hub log lines about memory carry ids and counts only.


## Stage A plan guard and fail notes (#412 P7-1)

A plan's explicit paths/symbols and refs paths are matched against live, screened fail `about` nodes (the source of v1 `rules_out` graph edges). Matching fails lead the owner's brief and the review delivery's checklist; accepting a plan or claiming work returns the same current advice. Existing related-memory fails-first ordering is retained. Unrelated fails do not gain plan priority. The guard informs, never blocks or changes the task, and PII tasks never invoke it.

`hub_remember` accepts optional string fields `approach`, `symptom`, `cause`, `evidence`, and `retry_when` only with `kind: "fail"`. Provided fields appear in that order with labels `Approach`, `Symptom`, `Cause`, `Evidence`, and `Retry when`, after optional plain text. A structured-only fail is valid; plain text remains valid. The completed text is validated before policy, storage or display: at most 4000 UTF-8 bytes, with actual/limit byte counts on refusal and no truncation. Every composed field passes the existing secret/PII/private-path checks.

## Decay review

`ahub memory decay [--days N] [--json]` is person-only, including in delegated live-test sessions. Default age is 90 days. It lists this project's long-term, live, non-superseded notes strictly older than the cutoff, excluding links to open/active/blocked goals through the note's task or `about` nodes. Reads use current privacy screening and defer automatic promotions; authoritative JSONL bytes do not change. Index maintenance remains derived-only. A person acts separately through existing `demote` or `forget`. These are review rows, with no candidate-sidecar write.

## Read-time staleness hint

Recall lines, native brief items, `hub_memory_show` lines and human `ahub memory show` output mark `(stale?)` when an allowed `path:` or symbol-file path is missing. CLI `--json` keeps the v1 row unchanged. The marker is never stored or used as evidence of correctness.

Each rendered batch has a shared cache and a hard bound of 32 metadata probes. On a tree not modified during the call, no hint probe reaches a `pii.paths`/`local.deny` path: declared private paths and the common deny policy are checked lexically first, including folded spellings and globs. Absolute/escaping paths, symlinks observed by a probe, denied paths, unreadable metadata and exhausted budgets are unknown and produce no marker. A concurrent ancestor swap by a process running as you can expose one existence bit; it is outside the [security threat model](security.md), and the deterministic ceiling witness is retained in the tests. Descriptor-anchored traversal is needed before supporting that scenario. Symbol nodes are checked only through their allowed file; this hint does not parse source symbols or read file contents. Current privacy screening still precedes rendering and peer-output byte caps. No new memory operation or candidate writer is introduced.

## Review candidates and local usage counters

Agents propose a correction with `hub_memory_correct {id, text, reason}`. The target is an exact id or unique visible prefix, screened under this project's current policy. The tool requires `memory_correct`, refuses private turns, and records a candidate with the full target id and revision. It does not edit a note or notify the other peers with the proposed text. Arguments and results are excluded from capture.

A `changes_requested` review with unmet items can create one fail candidate. Tasks screens the public task title, unmet items and review evidence before the sidecar write; private tasks, private turns, withheld text and failed or unknown screens produce no candidate. Cause and retry conditions are explicitly unknown unless a person supplies them when reviewing.

Candidates and rendered/delivered/cited counters live only in agent-mem's machine-local `M/candidates.db` (package retention: 500 candidates/project for 30 days, 10,000 counters/project for 90 days). They are never imported or synced and are not evidence for recall, briefs, ask or graph. A person reviews them with `amem review` and accepts or rejects through that CLI's TTY and policy checks, on shared v1 and, since agent-mem 0.7.0, on a selected generation. Dashboard acceptance is a later step. Accepted results are ordinary v1 notes under the package's acceptance contract; the hub tool has no acceptance authority.

Rendered observations use the final journal payload, including memory lines in prefaces and briefs, with the real delivery id. Delivered observations require the journal's first positive transport acknowledgement (or the pull path's completed read receipt). Failed or uncertain handoffs do not establish delivery; journal-less transports leave it unknown. Citation observations resolve `mem:<id8+>` in a peer message or task completion summary against screened project-visible entries. Citations use explicit `message:<envelope-id>` or `summary:<task>:<history-index>` observation keys when the source delivery is not proven; their rendered/delivered values remain unknown. They do not establish a per-delivery causal ratio. Duplicate observations are idempotent per entry/context/observation, not cumulative usage claims. Unavailable task, turn or session identity and unobserved metrics remain unknown, never zero. No observation is written for a private envelope, PII task or PII turn. These are delivery and citation proxies, not proof that an agent understood or used a note correctly.

## In-process recall and capture (agent-mem#13 P4)

The exact 0.6.0 pin is the first published package with P3. It was checked directly against the cache-busting npm registry read: gitHead `2a182f2f23b7744a746b6854f9fb920df627a99f`, published 2026-10-23. The hub uses the canonical, alias-resolved project key and the selected profile; caller-written legacy project-chain labels never select a different store. `memory.worker_url` is retained only as ignored legacy configuration, not a network destination. `ahub doctor` reports the library rather than probing a worker.

Changes from the worker integration are deliberate:

- Task briefs and ask use curated amem entries with authentic `mem:` identifiers. Raw capture is not evidence. The existing native graph-neighbourhood/fails-first path is retained.
- Recent recall supplements long-term notes with short-term curated notes. It does not recreate claude-mem's model-produced observation summaries. Those historical rows require the explicit person-run import.
- Local capture deterministically appends SessionStart, tool events, Stop excerpts and SessionEnd. Host session/turn/step/invocation identity distinguishes actual executions even when a provider reuses its tool-call id; a replay of the same observation dedupes. There is no model summarizer, worker, watcher or network call. Published CaptureStore owns bounded excerpts, cap/retention, contention spool and replay. The bound handle is reused; effective R6 config is checked before each append and a change reopens it before writing. Refusal and daemon shutdown close it.
- The host excludes private turns, PII tasks, private paths, memory/tool bookkeeping and secrets before capture. It screens complete input/output before truncation. Whole-row privacy screening also precedes read selection and rendering.
- Native task notes are written once. Auxiliary checkpoint and model-answer writes are candidates, not another curated copy; their submitted metadata is retained in the candidate text and their note kind is preserved. The complete candidate must fit the package's 4000-character limit, or the save is unavailable. Model answers are excluded from every curated read projection even if an old import contains one.
- Supplemental reads use bounded exact-project pages with explicit coverage; see "P4 supplemental read and capture bounds" below. Published SearchIndex supplies ranking after screening, with a term-wise labelled fallback when FTS5 is absent.

The integration test uses actual temporary stores with fetch denied and verifies recall, brief and ask without a worker, local-only capture, replay dedupe, privacy before excerpts, project binding and candidate/evidence separation. Older fixture transport tests use a host-only injected FakeMemoryClient; no URL or fixture registry is accepted from production configuration.

Historical benchmark memory-arm labels are retained for old records. Their `claude-mem`/`both` names are not evidence of a live worker on this runtime; new comparisons require a new declared condition and an amem-aware benchmark plan. No benchmark collection was run for this integration.


Write screening examines both the JSON representation and literal structured keys/values before storage escaping. Authoritative tool input/output JSON is decoded once, from the complete original output before excerpt bounding; arbitrary nested JSON-as-text or other encodings are not interpreted. Host locators such as cwd are not capture content and are not persisted: treating the project root as content would falsely classify every event as mentioning every private subtree. Persisted capture fields and complete tool data remain screened, and complete custom deny paths are checked before token fallback. The test-only old-HTTP projection retains its old 4000-character response cap; production capture delegates its bound to CaptureStore after policy.


## P4 supplemental read and capture bounds

Session-start supplemental recall is one screened short-term curated block from every author, including the receiving peer. No adapter platform whitelist or "agent-hub" pseudo-source remains. The supplemental view uses the published `readPage` keyset API: at most 16 pages of 256 exact-project candidate bodies, plus one lookahead. It never calls the materializing `list()` path. Newest project candidates are considered first; filtering private or non-short rows may leave fewer displayed rows. A remaining page produces `memory view truncated: newest 4096 project candidates considered` in recall, search and task briefs, including when all considered rows are withheld. The control status `memoryRead` reports the last read's `truncated`, `scanned` live candidate bodies and `limit`; it is not a total corpus count.

This supplemental path deliberately excludes other projects' shared rows, which could previously crowd out the project's own short-term notes. Native shared long-term recall, graph evidence and peer read tools retain their existing scope. The package still folds relation metadata during a body page; tier/scope-aware core pages and incremental metadata snapshots are the upgrade path for that remaining cost. No total-cost bound on the core refresh is claimed.

Capture reuses one store handle per bound project/profile home and closes it on a binding error and daemon shutdown. Effective published R6 config is checked before each append; changed cap or retention reopens the handle before that append, so person settings retain next-invocation behavior. Every effect still rechecks the current binding and screens complete input/output first. Persisted path metadata contains only project-relative read/write/edit paths; bash commands, git argv and outside-root paths are omitted from that column. Legacy library callers without a host invocation id still deduplicate a native id within a summary interval; live LocalPeer supplies a separate session/turn/step/invocation id. Other hosts must supply that port before claiming cross-turn identity.

## Canonical symbol anchors (#684 phase 3)

The hub normalizes function signatures with its shared symbol normalizer and uses the existing amem `symbol:<qualified>@<path>` node format. Code-backed completion anchors require explicit file identity; an unknown or name-only resolution never invents a file. Existing non-completion notes retain normalized plan-intent associations, which are not evidence that a symbol exists or changed. Completion notes replace those guesses with verified actual symbols, or none when observations are unknown.

At an admitted completion, only the current head's screened host observations are candidates. The optional code-facts `exists` check must positively confirm an unambiguous existing symbol before its node enters the new completion note. Private tasks make no symbol queries and write no memory. Unknown observations write no symbol anchors and the completion note labels their coverage unknown. At most 16 candidates are considered; new checks stop after a shared two-second scheduling budget. An already-started call retains the code-facts boundary's own bounded execution and cleanup, so this is not a strict two-second wall-clock guarantee. Missing evidence never refuses completion.

Earlier notes stay immutable. The completion note and earlier notes share the task's reset-safe node. `related(project, [symbol], limit)` reaches the earlier notes at memory hop two; literal graph edges are symbol -> completion note -> task -> earlier note. The pinned package's `graph(..., 2)` stops at the task node. No overlay, code structure, copied note, supersede operation or new storage schema is introduced.

ponytail: the symbol -> task bridge expires with the existing short-term completion finding; afterward a long-term note is found by symbol only through its own `about`. The upgrade path is phase 4 (#367), deriving edges from recorded changed symbols at read time without storing them.

Qualified-name misses from the current ripwire CLI remain unknown: version 0.6.7 can report `Parser.run` absent while observing `run` in `Parser`. Plain-name negative evidence retains its existing meaning. The shared code-facts boundary can lift this ceiling once a CLI/schema attests qualified lookup.

`ahub doctor --stale-anchors [--json]` is an optional read-only inspection of symbol anchors against the current head. It reports bounded coverage and unknown evidence explicitly. A positive absence establishes stale status; unavailable, private or ambiguous evidence does not. It never deletes, edits, promotes or repairs a note. The default doctor checks are unchanged.

Inspection considers at most 256 exact-project notes and starts at most 16 code-facts checks, with explicit unknown/truncated coverage. A task-linked anchor also requires a current, public, reset-safe task record in this repository; historical public text cannot override a now-private, foreign or missing task record. A missing/uninitialized selected profile or project shard remains unknown and is not created. Existing core reads may maintain derived indexes and reader leases, but the report changes no authoritative note or candidate record.

## Symbol preparation and historical query compatibility (#684 follow-ups)

A filled symbol-preparation key (execution root, head and merge base) is reused between the prepare-only and completion passes. Within one pass, identical name lookups share known or unknown results even when several candidate file paths use that name. Completion still rechecks current privacy, repository and head provenance; cached advice never grants authority.

Plan-guard and related-memory queries include both an explicit raw symbol input and its normalized form, so an older `symbol:foo(a: string)@x.ts` association remains reachable alongside `symbol:foo@x.ts`. This is query compatibility only; existing notes and their IDs are never rewritten.

The stale report leaves unsupported `#`, `->` and `:` lookup spellings unknown. A plain name not found by the index is labelled "absent from indexed definitions", not proof that an imported package API or type was removed. The JSON state/reason fields retain their existing meaning, with an additive label only on final validated absence rows.

Code-facts queries can register transient detached Git worktrees. Interrupted cleanup, including Ctrl-C, can leave a prunable registration. Inspection does not auto-prune: inspect `git worktree list --porcelain` and clean only a confirmed abandoned entry. A repeated owned cleanup failure returns neutral unknown coverage; borrowed handles remain caller-owned. Note and candidate bytes are unchanged by inspection.

## Read-time code neighbours (#684 phase 4)

Select a symbol in the dashboard Memory view and enable Code neighbours to inspect one hop of callers and callees. Dashed `calls` edges are computed through the optional code-facts boundary at the displayed full commit SHA; they are never stored in amem. Attached notes are highlighted, fails first. Turning the toggle off returns the stored graph. An ambiguous seed or name-only relation is withheld; unavailable or partial evidence is explicitly unknown.

`hub_memory_graph` also prepares this overlay for symbol starts. Stored and derived nodes share its existing maximum 120 nodes, 240 edges and 6144-byte serialized response budget (default 60 nodes). Omitted nodes/edges contribute to truncation. Authored note associations remain ordinary `about` or `rules_out` edges; only code calls carry the derived SHA stamp.

A preparation starts at most four canonical, path-qualified seeds and no new query after two seconds. It retains at most 32 distinct neighbours, 64 call edges and 16 screened attached notes. In-flight work retains the existing code-facts timeout and cleanup bounds. The file:name selector must attest exactly one definition; ambiguous/name-only seeds are unknown even when their relation lists are empty. Queries run outside the synchronous dashboard snapshot Git budget, and current HEAD, profile, policy and caller/task privacy are rechecked across awaits. PII tasks and turns do not query code facts.

Task briefs merge direct and neighbour-attached fail/decision notes first, deduplicate IDs and retain the existing combined `brief_items` cap and line excerpts. The cap is snapshotted once before selection; a reload applies to the next brief. The console task detail's related-note line counts this bounded brief selection, not all notes in the store; unknown code coverage remains unknown. This does not persist a code index, extend completion-note TTLs, or change amem's graph API.

Code-neighbour reads are optional work: review and completion queries take priority, interrupt an in-flight optional CLI and wait for its owned cleanup before starting. Optional unknown results are retained for five seconds; known topology is cached for thirty seconds, with a shared five-second minimum between derive starts. Current attached notes are refreshed and screened at publication, so this cache does not retain a stale note selection. Direct path/title/symbol advice is independent of code eligibility or availability and keeps its existing fail-open behaviour.

Only an open, visible Memory view requests dashboard code work. Console task detail uses a cache-only overlay lookup and returns unknown on a cold cache, without starting a code query. A derive makes one hardened Git HEAD probe; cached publication checks bounded Git-owned HEAD/ref files instead of spawning Git on every poll. Unsupported ref layouts or packed-ref inventories above 1 MiB remain unknown. Dashboard note filters apply to neighbour notes as well, and selecting a non-symbol resets the toggle. Stored symbol nodes retain their authored identity when derived edges are added.
