# Hub memory

The hub's own memory (#258): notes the agents and the hub save while they work, kept in two tiers and linked into a
graph by what they are about. It sits beside claude-mem, which stays the capture and session-recall source where it is
installed. Every machine keeps its own copy in `~/.agenthub/memory/` (directory 0700, files 0600).

## Turning it on and off

On with any project config (`.agenthub/config.json`); `"memory": { "native": false }` turns it off for a project.
`memory.short_ttl_days` (default 14, a whole number from 1 to 3650; anything else fails the config) sets how long
short-term entries live after their task is approved, and `memory.sync_interval_min` (default 10, 0 off, at most 1440) how often a running
hub syncs once a remote is set. Writing and
reading are fail-open: a store that cannot be written costs one notice, and never a tool call or a turn.

## Tiers

- **Short-term**: notes saved against a task that is still open, and notes saved with no task. They stay on this
  machine (`local/<machine>.jsonl`) and leave the index `short_ttl_days` after their task is approved (a note with no
  task, or saved with `horizon: "short"` on purpose: after it was written, and it is never promoted; a demoted entry:
  after the demotion; a note on a task that is never approved: 180 days after it was written, the same for every
  reader). The deadline is written into the entry (`expires`)
  or the op (`settle`, `demote`) when it is set, so every process reading the store prunes the same rows whatever its
  own setting. Their log lines stay on disk.
- **Long-term**: decisions, contracts and fails that outlive their task. When a task is approved, its decision, contract
  and fail notes are copied to long-term automatically (findings are not), and the short-term originals are hidden.
  Each is screened again first under the project's current PII patterns and `pii.paths`; one that fails stays
  short-term on this machine and expires. An
  agent can save straight to long-term with `hub_remember(..., horizon: "long")`; a note against an already approved
  task that is a decision, contract or fail is long-term at once. Long-term entries go to `log/<machine>.jsonl`, the
  segment machine sync will carry.
- **Scope**: `project` (default) entries are read only in the project that wrote them; `shared`
  (`hub_remember(..., scope: "shared")`) entries are read from every project on the machine.

A project is named by its `origin` remote, normalized to host and path (`github.com/owner/repo`, lowercased on GitHub, whose
names ignore case; a URL keeps a port that is not its scheme's default), the same on every machine; a repository without one is named by its git chain plus a hash of its directory, so two unrelated
repositories with the same name never share entries (that name is this machine's only).

## What gets written

- `hub_remember` from any peer or `ahub remember`, after the existing checks: a note about a PII task, or one matching a
  PII pattern, is refused; the PII screen (#198) must clear it; a note that looks like it holds a secret (a private key,
  a cloud or GitHub token, `password: ...`) is refused.
- The hub's own notes on a task: the done summary (finding), the review verdict and an escalation (decision), with the
  same PII and secret rules. Nothing about a PII task is written.
- Notes still go to claude-mem when it is enabled, as before; the other peers get the note line on their next delivery.

## Entries (`agent-hub.memory/v1`)

One JSON line each. The id is the first 32 hex characters of the SHA-256 of the entry's canonical JSON (sorted keys,
without `id`), so the same content always has the same id and a line whose id does not match is skipped. Nothing is
ever rewritten: a change is a new entry.

| `op` | Fields |
| --- | --- |
| `note` | `project`, `scope`, `tier`, `kind` (`decision`, `finding`, `contract`, `fail`), `peer`, `title?`, `text` (at most 4000 characters), `task?` (`<project>#<id>@<created ms>`), `about` (nodes), `supersedes?`, `promotedFrom?`, `source` (`hub`, `person`, `claude-mem`), `expires?` (a short-term note with no task, on a task already settled, or saved short-term on purpose: its own deadline, whatever the task does); a promoted copy is dated as its source and keeps its fields, whoever promotes it |
| `forget` | `target`: the entry is gone from the index, and so is its promoted copy or original |
| `supersede` | `target`, `by`: the newer entry; superseded entries are dropped from briefs and recall while the newer one is live (forgetting it shows the old one again) |
| `demote` | `target`, `by`: a long-term entry becomes short-term and leaves the index at `by` |
| `settle` | `target`: a task key, `by`: when its short-term entries leave the index (written when the task is approved; a settlement a crash cut short is finished at the next read, and a held decision, contract or fail whose replacement is forgotten or expires moves to long-term then too) |

Every entry also has `schema`, `id`, `at` (ISO time) and `machine` (a random id per `~/.agenthub`, in
`memory/machine.json`, with a label a person can edit).

## The graph

Nodes are entries (`mem:<id>`), files (`path:src/a.ts`, relative to the project root), symbols (`symbol:parse@src/a.ts`,
with the path when the task's plan names exactly one), issues (`issue:owner/repo#12`, the repo from the project's
`origin` remote on GitHub, else the project name), board tasks (`task:<project>#3@<proposal ms>` for the task a note was saved against, so a task id reused after
`ahub reset --all` is another node; `task #N` in a text names `task:<project>#N`), peers, machines and projects.
Edges are deterministic and fixed when the entry is written, so a rebuild never depends on the file system:

- `about`: from the task's refs and plan paths, plan symbols, paths named in the text that exist in the project at
  write time (denylisted paths are left out), `#N` and `task #N`, and the task the note was saved against. A `fail`
  draws them as `rules_out`.
- `by` (peer, machine) and `in` (project), from the entry's fields; `supersedes` between entries.

- `part_of` (board task to long-term task) and `depends_on` (between long-term tasks), from the links below.

- Model-suggested edges, off by default (`"memory": { "suggest_edges": true }`): after a note is saved, the hub's model
  (the same route as digest condensation) names `contradicts` or `same_topic` between it and up to six near entries.
  Its answer is read line by line against that closed list and stored as a suggestion by `hub-model` (`suggest`,
  `confirm`, `reject` entries). Suggestions are drawn dashed on the dashboard and are never evidence: briefs, recall and
  `ahub ask` ignore them until a person confirms one (`ahub memory confirm <id>`); a rejected one disappears.

## Long-term tasks

A long-term task (a goal) spans sessions, board tasks, projects and machines: an epic issue, a migration. It has a
state (`open`, `active`, `blocked`, `done`, `dropped`), milestones, the long-term tasks it depends on, its linked board
tasks (project, task id and proposal time, so a reset's reused ids never join it) and a lease. All of it lives in the
synced log as entries:

| `op` | Fields |
| --- | --- |
| `goal` | `project`, `scope`, `title`, `milestones`, `dependsOn`, `actor` |
| `goal_state` | `target`, `by`: the state |
| `goal_link` | `target`, `by`: the board task key |
| `lease`, `lease_force` | `target`, `by`: until when (ISO) |

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

## Machine sync

The memory directory is a git repository that tracks only `log/*.jsonl` (and its `.gitignore`); the index, the local
short-term segment and `machine.json` never leave the machine. Each machine commits only its own segment and starts
its own history, so merging another machine's history never conflicts.

```bash
ahub memory sync --remote git@github.com:you/agent-hub-memory.git   # once per machine, a person's
ahub memory sync                                                    # pull, then push, now
ahub memory machine --label "office mac"                            # a name shown beside the id
```

- A sync commits this machine's segment, fetches, merges the remote's history, pushes (once more after a merge when
  another machine pushed in between) and indexes what arrived. One sync runs per machine at a time.
- A running hub syncs 5 seconds after it starts and every `memory.sync_interval_min` minutes (default 10; 0 turns it
  off) once a remote is set. A failure is one `hub.log` line and never blocks a turn; a store without a remote does
  nothing and creates nothing.
- The remote must be private: long-term entries hold note text. A GitHub remote is checked with `gh repo view` and a
  public one is refused; any other host, or a `gh` that cannot answer, is unknown and the sync goes on with a warning.
- Use an SSH remote, or HTTPS with a credential helper in your global git config: the hub keeps your credential helper
  for this repository only, and never prompts.
- A forgotten entry stays in the remote's git history; removing it from there is a person's history rewrite.

## Index

`index.db` (SQLite) is derived from the logs: entries, ops and edges are inserted with `INSERT OR IGNORE`, and every
state (superseded, forgotten, promoted, demoted, expired) is computed from those rows, so reading the segments in any
order gives the same index, and the index each hub keeps up to date as it writes equals a rebuild from the logs. Each
reader keeps the byte offset it reached per segment and reads only what was appended since; a line still being written
waits for the next read. A segment that got shorter, disappeared or was rewritten in place (the indexed part no longer
hashes to what was indexed) makes the reader rebuild the index from every segment. Malformed lines and lines whose id does
not match their content are skipped with one log line.
`ahub memory rebuild` drops the rows and reads every segment again; deleting `index.db` does the same on the next start.

## Reading it

- **Task briefs**: when a task is handed to an owner, its brief lists hub memory first (entries one or two hops from
  the task's paths, symbols, issue and task: a linked fail first, then nearer, then newer; superseded entries dropped;
  other projects' entries only when shared), then claude-mem's, `memory.brief_items` lines in all. A peer is never
  shown the same entry twice in one hub run.
- **Session-start recall**: this project's long-term decisions, contracts and fails (and shared ones), newest first,
  lead the recall block; claude-mem's recent work follows. Each gets half of `memory.inject_tokens` when both answer.
- **`ahub ask`**: entries that match the question and the graph neighbourhood of what they are about are evidence, cited
  as `[mem:<8 hex>]`. A question that carries PII skips them. `ahub ask --remember` still saves only to claude-mem, so a
  model's answer never becomes hub memory.
- **`ahub memory`** (no hub needed; reading is anyone's):

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

A forgotten long-term entry stays in the log file and in the sync remote's git history; removing it from there is a
person's rewrite of that history. Forgetting a claude-mem import forgets every known non-forgotten member of its tuple group (source, project, source timestamp and text), including hidden duplicates, so they cannot reappear when their replacement is forgotten.

## Importing from claude-mem

`ahub memory import claude-mem [--db <path>] [--limit N] [--restart]` (a person's) copies the hub's own notes from claude-mem
(observations whose metadata names a `peer`: `hub_remember` and the hub's task notes) into long-term hub memory as
`source: claude-mem`, for this project only. The SQL filters by the repository's basename before applying the limit;
a superproject's notes stay out, while two unrelated repositories with one basename still share claude-mem's namespace.
Model answers from `ahub ask --remember`, PII-pattern text, text about a path made private by the project's `pii.paths`
and secret-looking text are skipped. The source database is opened read-only and never changed.

- Import graph nodes are derived from text only: no checkout existence check and no machine-local `local.deny`.
  Built-in denylisted names, relative-path normalization, absolute/parent exclusion, sorting and the 64-node cap still apply.
  The source's timestamp and the existing content hash stay unchanged. Matching observations on different checkouts now
  produce the same id; old ids, references and content validation remain valid. The local tuple fallback keeps re-import
  idempotent even for legacy ids (its known ceiling is that the tuple excludes title).
- A machine-local `memory/import-state.json` records the last fully handled row, including all skips. The cursor key
  combines the source DB's real path, claude-mem project name and hub project key. The file uses mode 0600 and atomic
  replacement; it never syncs. Unreadable or malformed state replays from zero, write failure logs a warning and preserves
  the import result, and a source whose maximum candidate id for this project is below the cursor resets it (unrelated projects cannot mask a recreated source). Completed progress is saved even if a later
  row throws. `--restart` starts from zero; use it after changing a PII policy to revisit rows skipped under the old policy.
- The default limit is 10000. JSON reports `read` (project-matched, peer-tagged SQL rows this run), `added`,
  `skipped.model`, `skipped.pii`, `skipped.secret`, `cursor` (last handled id), and `more` (`read === limit`). Malformed
  metadata, non-string peers and empty text count only in `read`; already imported rows add nothing. `more` asks for
  another run, which can return zero rows when the last batch exactly filled the limit. There is no project-skip counter.
- Repository identity still depends on the local real path without an origin remote, and non-GitHub remotes spelled
  differently can yield different project keys. These affect all hub memory and remain outside this import fix.

### Legacy duplicate imports

`ahub memory dedupe [--apply] [--json]` is console-only, including the listing, because it shows unscreened note text.
It groups this project's non-forgotten claude-mem entries by `(source, project, at, text)`. Listing reports only actionable
groups, their members, heads and chosen target; `--apply` appends ordinary supersede operations in this machine's log.
Historical log bytes are never rewritten. Forget operates on the whole known tuple group.

- Heads have no current replacement. Existing replacement relations, including a person's distinct outside notes, stay
  intact. If every head can reach a valid synced outside terminal (shared when any head is shared), the newest qualifying
  terminal by `(at, id)` replaces all heads, even a single head. Otherwise multiple heads converge onto the smallest id
  among the heads; zero heads or one head without a qualifying outside terminal require no writes. A refused supersede
  is reported as an error. Re-running after convergence writes nothing.
- When `A -> B` already exists inside a group, dedupe connects another head `C -> B`, without trying the cyclic `B -> A`.
  When `B -> X` and `C -> Y` name outside user replacements, `X` and `Y` both remain visible; a remaining head moves to
  the newer qualifying terminal. A later outside replacement can make a previously settled group actionable again.
- Old or mixed extractor versions can still introduce duplicate ids. Run dedupe after syncing them. Two machines acting
  on divergent prior relations can choose different targets; sync folds relations deterministically using the existing
  latest-relation and cycle guards. If several group members remain visible, one more dedupe run converges them. New
  same-version imports with stable project keys converge automatically in either sync order.

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
