# Hub memory integration

Agent-hub consumes the exact-pinned first-party [`@staix/agent-mem`](https://github.com/STAIxBWLB/agent-mem) library (initial pin `0.1.1`). The package owns portable storage, tiers, graph, goals, sync, import and raw commands. Agent-hub owns caller authority, current project privacy policy, task lifecycle integration and presentation. Optional claude-mem remains a separate capture and session-recall source.

## Portable core and data directory

The [agent-mem repository](https://github.com/STAIxBWLB/agent-mem) is the reference for the data model, immutable entry IDs, append-only segments, derived SQLite index and rebuild equality, home selection, import cursors, dedupe and machine sync. Existing stores need no migration: schema `agent-hub.memory/v1`, canonical hashes and log/machine/lock paths remain compatible. `memoryHome()` comes from the package and selects `AMEM_HOME`, then `$AGENTHUB_HOME/memory`, then `~/.agenthub/memory`; an explicit `StoreOptions.home` keeps its parent-directory meaning. The test preload (`test/hub-home.ts`) clears inherited `AMEM_HOME` and supplies an isolated `AGENTHUB_HOME` when none is provided.

`src/memory/` contains hub integration only: briefs, recall, the claude-mem worker client and capture. `src/hub/memory-policy.ts` supplies `withoutPii`, `promotionScreen` and `mentionsPrivatePath`; `src/hub/read-tools.ts` supplies screened peer reads. Deny, hardened git, realPath and process identity come from the package's Node-safe `@staix/agent-mem/platform` entry and are re-exported through the existing local/hub/Pi modules. No core implementation is vendored in agent-hub. The `0.1.1` platform subpath is required because `0.1.0` exposes only a root entry that loads `bun:sqlite`, which Node-hosted Pi extensions cannot import. This is a packaging compatibility export; the platform algorithms are unchanged.

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
  other projects' entries only when shared), then claude-mem's, `memory.brief_items` lines in all. A peer is never
  shown the same entry twice in one hub run.
- **Session-start recall**: this project's long-term decisions, contracts and fails (and shared ones) lead the recall block; display-only filtering omits automatic approval notes, while changes-requested notes show their nonempty reasons. Lines preserve their headers and end at word boundaries with a visible marker when capped; each delivery deduplicates memory ids across prefaces and note lines. Stored notes and brief evidence are unchanged. Claude-mem's recent work follows; each gets half of `memory.inject_tokens` when both answer.
- **`ahub ask`**: entries that match the question and the graph neighbourhood of what they are about are evidence, cited
  as `[mem:<8 hex>]`. A question that carries PII skips them. `ahub ask --remember` still saves only to claude-mem, so a
  model's answer never becomes hub memory.
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

- Each task brief writes a `memory_brief` event with counts only (hub-memory items, fails among them, claude-mem
  items); research records keep `briefs` (`delivered`, `withFail`), and `ahub research` splits approved tasks into
  "a fail note in its brief", "brief without a fail note" and "no brief recorded" (first pass, rework, check failures).
- `ahub bench run --memory off|claude-mem|native|both` declares an arm's memory and refuses a hub that runs with other
  settings; compare the arms with `ahub bench compare`.
- Whether an agent retried an approach a fail note had ruled out cannot be read from ids and counts. A task whose brief
  carried a fail note and was still sent back or failed a check is a candidate, to read by hand.

## Privacy

- Nothing about a PII task enters the store: the tool refuses it and the hub's own notes skip it. Text that matches a
  PII pattern, that the PII screen does not clear, or that looks like a secret is refused or skipped with a notice.
- Hub log lines about memory carry ids and counts only.
