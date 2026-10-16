# Agent-mem P0 baseline

Issue #412, Evidence E1-E12 and P0. This snapshot records what the sources reproduce, including disagreements with the plan. The [failure registry](2026-10-16-amem-failure-registry.md) is the companion P0 annex; its retained source assertions do not certify live legs.

# Capture contract

- Capture date: 2026-10-16. Source HEAD: `5af9eb9bff85f4705a351441ea7d3ff1553cf121` (before these P0 files are committed). The source references below were checked at this HEAD.
- SQLite observation and work-state cutoff: `created_at_epoch < 2026-10-16T00:00:00.000Z`, in epoch milliseconds. Each collector invocation uses one read transaction on a `{ readonly: true }` connection.
- Native log cutoff: `at <= 2026-10-15T21:53:00.000Z`, over `log/*.jsonl` and `local/*.jsonl`. Counts are raw dated log rows, not current visibility or an index projection. A promoted copy counts as another row. `by_tier` uses the row's declared tier; ops without a tier are `other`. `segments` counts physical placement.
- Event and recall cutoff: `at <= 2026-10-15T22:35:35.000Z`. Only `events*.jsonl` and the current `hub.log` are read; missing rotated log archives are not inferred.
- Auto-memory/Codex file counts and research-directory presence have no trustworthy historical cutoff and are current directory counts. Symlink directories are not followed. Claude `project_dirs` counts every immediate directory, while `projects_with_memory` counts directories with at least one eligible note. Codex counts regular files recursively, including non-Markdown files.
- Fail distinctness is SHA-256 of exact UTF-8 `text`, not title or entry id. Hashes and note text are never printed. Different tier copies with identical text count once.
- No native index, machine identity file, or vault file is opened. No model, sync, write API or subprocess is called by the collector. Errors are numeric and do not expose source paths or messages. `readable: 0` is unavailable, never zero data; `null` marks evidence outside this script's scope.
- All paths have CLI overrides: `--claude-mem-db`, `--memory-dir`, `--project-dir`, `--claude-projects`, `--codex-memories`, `--research-dir`, `--cases`. Defaults use the home directory and the script's checkout. For this capture, `--project-dir` targeted the main agent-hub checkout, since this worktree has no runtime state. Pass `--project-dir` pointing to the runtime checkout when collecting from a worktree. In the runtime checkout, the default command reads its own state.
- Bare `bun scripts/amem/baseline.ts` in this worktree exits 0; E4 and E5.briefs report unreadable because this worktree has no `.agenthub/state`. The explicit-project capture below reads those sources successfully. No source was unreadable from codex sandbox with that override.

# Evidence table

| Id | Number and unit | Cutoff | Script key or source query | Status |
| --- | --- | --- | --- | --- |
| E1 | 200,717 observations; 4,882,886,254 discovery tokens; 14 days: min 849, max 11,749, median 5,411, total 82,067 | SQLite cutoff above; daily interval [2026-10-02, 2026-10-16) UTC | `E1`; `count(*)`, `sum(discovery_tokens)`, and 14 daily half-open epoch ranges over observations | drifting: historical rows can later be inserted, merged or deleted; daily counts reproduced |
| E1 | Prior receipt: 11 GB store, 7.1 GB vectors | Earlier measurement, no size cutoff retained | #412 E1; no recursive disk scan performed here | drifting; not remeasured |
| E2 | 0 rows with relevance_count > 0; 0 with occurrence_count > 1 | SQLite cutoff | `E2`; conditional sums over observations | drifting; zero is a missing use signal, not evidence of no use |
| E3 | 128 rows: 41 log, 87 local; 102 notes, 26 settle ops; 52 decision, 44 finding, 3 contract, 3 fail; decisions 26 approved / 24 changes requested / 2 other; long decisions 38, auto outcomes 36 | Native cutoff | `E3`; anchored first-line text regexes and declared tier | rebuildable from dated logs; all frozen native receipts reproduced |
| E4 | One witnessed channel delivery duplicated the presence block; 15 displayed lines reportedly all auto outcomes cut mid-sentence | Original witnessed delivery, no retained machine-readable delivery receipt | #412 E4, no source in script for the duplicated block or its cause | witnessed-only; not independently reproduced |
| E4 | 17 recall log lines, 49,135 chars total, mean 2,890.294117647059 chars | Event/recall cutoff | `E4`; timestamped `recall <peer>: N chars` lines | rebuildable from retained current log; 7-start receipt not counted by this script |
| E5 | 3 fail note rows, 2 distinct text hashes; 10 briefs, 53 native items, 24 external capture items, 4 fails, 4 briefs with fails > 0 | Native cutoff for notes; event cutoff for briefs | `E5.notes`, `E5.briefs`; memory_brief event sums | rebuildable; brief receipt differs, see below |
| E6 | 144 project keys; 132 without slash; exact agent-hub key 10,673 rows, scoped agent-hub key 28,369 rows | SQLite cutoff | `E6`; count distinct project, instr(project,'/'), exact-key conditional sums | drifting; key counts reproduce, exact-key row counts differ |
| E7 | Prior Pi denial receipts #69 and #73 | Earlier sandbox runs | #412 E7; `E7.sandbox_receipt` is null | witnessed-only; no new Pi sandbox or graph/rebuild refusal run |
| E8 | 165 Claude note files (excluding MEMORY.md), 217 immediate project directories, 8 with notes; 124 recursive Codex files; 3,916 work-state entries; 102 native notes | File counts at capture; SQLite cutoff for work-state; native cutoff for notes | `E8`, `E3.by_op.note` | drifting for files/SQLite; rebuildable native notes |
| E8 | 813 vault notes, previously obtained through Obsidian MCP | Earlier #412 snapshot | #412 E8; `E8.vault` is null; vault remains MCP-only | witnessed-only for this capture; not rebuildable by this script |
| E9 | Fresh-store single runs at N=2,000 / 20,000 / 200,000; full stdout below | New run per N, 2026-10-16 | `bun scripts/amem/scale-bench.ts N` | rebuildable workload; timings vary, no latency-distribution claim |
| E10 | Unknown ops ignored; unknown note kinds/scopes skipped; unknown optional fields hashed but omitted on projection/promotion | Source HEAD above | `src/memory/store.ts:466` note validation, `:468` explicit projection, `:479` recognized-op branch to `:484`, `:338` promotion field list; `entryId` at `:73` | static; line references rechecked |
| E11 | 0 research directories at configured default location | Capture time | `E11.research_directory_exists`; no study records inferred from directory absence | drifting; #412 reports the AC11/add-on arms as unrun, not independently audited here |
| E12 | 60 cases, 8 modes; 28 regression-covered, 9 open-ceiling, 8 fixed-source, 6 historical-fixed, 5 guard/design, 3 historical-partial, 1 open-measurement | Frozen cases file hash below | `E12`; fixed public mode/status taxonomy; full mode counts below | rebuildable inventory, not proof that all cases are fixed |

# Differences from #412 and frozen receipts

No value was tuned to match a receipt. These are all mismatches or non-comparable aggregates observed in this capture; unmatched historical claims remain qualified above.

| Measurement | #412 or receipt | This capture | Interpretation |
| --- | --- | --- | --- |
| Observations | 200,467 | 200,717 | SQLite cutoff is frozen, source rows remain mutable; cause of 250-row difference not established |
| Discovery tokens | 4.87 B (rounded) | 4,882,886,254 (4.882886254 B) | Does not round to 4.87 B; no exact old sum retained here |
| Recall chars mean | about 2,990 | 2,890.294117647059 | 17 line count matches; prior average not reproduced |
| Briefs / native / external / fails / with fails | 11 / 61 / 24 / 5 / 5 | 10 / 53 / 24 / 4 / 4 | Event at `2026-10-15T22:35:35.750Z` contributes exactly 1 / 8 / 0 / 1 / 1, but is 750 ms after the mandated cutoff; kept excluded |
| Exact agent-hub project observations | 10,661 | 10,673 | Same exact-key query with frozen cutoff; mutable source difference |
| Scoped agent-hub project observations | 28,148 | 28,369 | Same exact-key query with frozen cutoff; mutable source difference |
| Claude auto-memory files | 172 | 165 | Current immediate memory/*.md files excluding MEMORY.md |
| Claude project count | 37 projects | 217 immediate directories; 8 with eligible notes | Old inclusion rule not retained, so neither count is claimed comparable |
| Codex memory files | 7 | 124 recursive regular files | Old inclusion rule not retained; current definition includes nested and non-Markdown files |
| Work-state entries | 3,888 | 3,916 | Frozen created_at cutoff, mutable source |
| 20K open / search / 2-hop ms | 347 / 74 / 50 | 875 / 244 / 149 | Different environment and single samples; no regression conclusion |
| 200K open / search / 2-hop ms | 3,906 / 835 / 506 | 12,877 / 2,609 / 1,495 | Different environment and single samples; no regression conclusion |
| 200K index MB | 405 (rounded) | 404.9 | Rounds to the same whole-MB value |

The daily 849 / 11,749 / 5,411 / 82,067 receipt, native 128 and 52 = 26 + 24 + 2 receipt, long 38 / 36 receipt, fail 3 / 2 receipt, E2 zeros, E6 144 / 132, E8 102 native notes, and E12 60 / 8 reproduce.

# Frozen collector stdout

The following is the exact single stdout line, with its final LF included in the hash. Numeric errors and null placeholders are part of its schema; no note content, titles, identifiers or private project labels are exported.

```json
{"E1":{"observations":200717,"discovery_tokens":4882886254,"daily_utc":{"2026-10-02":849,"2026-10-03":6488,"2026-10-04":3406,"2026-10-05":8510,"2026-10-06":2385,"2026-10-07":4564,"2026-10-08":4837,"2026-10-09":9446,"2026-10-10":10661,"2026-10-11":11749,"2026-10-12":6707,"2026-10-13":5985,"2026-10-14":4220,"2026-10-15":2260},"days":14,"min":849,"max":11749,"median":5411,"total":82067},"E2":{"relevance_positive":0,"occurrence_repeated":0},"E3":{"rows":128,"malformed":0,"segments":{"log":41,"local":87},"by_op":{"note":102,"goal":0,"forget":0,"supersede":0,"demote":0,"settle":26,"goal_state":0,"goal_link":0,"lease":0,"lease_force":0,"suggest":0,"confirm":0,"reject":0,"unknown":0},"by_kind":{"decision":52,"finding":44,"contract":3,"fail":3},"by_tier":{"short":61,"long":41,"other":26},"decisions":{"approved":26,"changes_requested":24,"other":2},"long_decisions":38,"long_auto_outcomes":36},"E4":{"readable":1,"recalls":17,"chars_total":49135,"mean_chars":2890.294117647059},"E5":{"notes":{"fail_rows":3,"distinct_fail_text_hashes":2},"briefs":{"readable":1,"briefs":10,"native_items":53,"claude_mem_items":24,"fails":4,"with_fails":4,"malformed":0}},"E6":{"project_keys":144,"keys_without_slash":132,"agent_hub":10673,"work_dev_agent_hub":28369},"E7":{"sandbox_receipt":null},"E8":{"claude":{"readable":1,"files":165,"project_dirs":217,"projects_with_memory":8},"codex":{"readable":1,"files":124},"claude_mem":{"work_state_entries":3916},"vault":null},"E9":{"benchmark":null},"E10":{"static_code_review":null},"E11":{"readable":1,"research_directory_exists":0},"E12":{"readable":1,"cases":60,"modes":8,"by_mode":{"Truth/lifecycle":11,"Duplicate/identity":4,"Retrieval/capture":13,"Project isolation":4,"Privacy":9,"Index integrity/freshness":7,"Sync/concurrency":4,"Scale/cost/measurement":8,"other":0},"by_status":{"regression-covered":28,"open-ceiling":9,"fixed-source":8,"historical-fixed":6,"guard/design":5,"historical-partial":3,"open-measurement":1,"other":0}}}
```

# Scale runs

Each N ran once in a fresh Bun process and a new temporary home/index, sequentially in the remote development container without a parallel benchmark worker pool. The original workload is unchanged, including its open → search → graph → rebuild order. "Cold" means no pre-existing derived database for the open measurement; OS page caches were not flushed. Search/graph run after opening and are not separately cold. There are no repeated samples or p95 values. `logMB` and `indexMB` use decimal MB. Only synthetic temporary data was written.

Environment: Linux remote development container, Bun 1.4.2. The configured container allowance is 16 CPUs / 32 GB; the script is single-process with no worker pool. No benchmark worker concurrency was added. These runs cannot be compared as a speed regression against the original host's one-shot receipts.

```json
{"N":2000,"logMB":2.6,"indexMB":4.1,"openMs":91,"searchMs":23,"hits":50,"graph2Ms":15,"graphNodes":22,"rebuildMs":67}
{"N":20000,"logMB":26.3,"indexMB":40.4,"openMs":875,"searchMs":244,"hits":50,"graph2Ms":149,"graphNodes":97,"rebuildMs":981}
{"N":200000,"logMB":263.6,"indexMB":404.9,"openMs":12877,"searchMs":2609,"hits":50,"graph2Ms":1495,"graphNodes":200,"rebuildMs":16027}
```

# Digests

| Artifact | SHA-256 |
| --- | --- |
| Collector stdout (including LF) | `7f962e2ee1ee2fb59a8177d7bac095a9cfed4a7ae083a273996e1dd27033e25d` |
| `scripts/amem/baseline.ts` | `c71f1d192a17977417feb5cc02449a6dc0217beb5afe8b79d54fe17e8892ef98` |
| `docs/plans/amem-cases.json` | `1f20f6885f0e9437e88bda427499f43eb97f8e0691f615cfba28b97b11aa92a4` |
| `scripts/amem/scale-bench.ts` | `6d8a151e649097898394c59d6939abe1408c15785d8eaa875ea74e82588d8f55` |
| Three benchmark stdout lines (including LFs) | `d3f0432d1e78abf8701b21d7f3fbf95732b257aca36e83b3daa6a33f0299e045` |

To verify the stdout digest, extract the JSON block exactly with its final LF and hash its bytes. Rerunning the collector can drift even with the same cutoff, so a later differing stdout hash is not automatically script drift.

# Verification

- Count-only fixture: 24 assertions plus missing-store and invalid-argument checks passed. It covered inclusive native/event boundaries, strict SQLite cutoff, duplicate fail text across tiers, MEMORY.md exclusion, recursive file counting, no sensitive fixture strings in output, and byte/file-set equality of fixture inputs before and after collection. The ad hoc fixture lived outside the repo and is not a retained regression.
- Explicit-project collector and bare-default collector both exited 0. The bare-default worktree-state limitation is documented above.
- `bun x tsc --noEmit`: passed in the remote container after frozen-lockfile install.
- Registry validator passed for all 60 rows; a separate ad hoc negative fixture confirmed rejection of duplicate/missing case ids, an unlisted gap, a missing ponytail marker, a missing literal test declaration, and invalid owner/phase fields.
- Initial `scripts/check.sh` invocation: 2,791 pass / 4 fail, exit 1. The invocation PATH omitted `/usr/sbin`, making `lsof` unavailable to benchmark cwd/restoration checks. No source or assertions were changed. Corrected-PATH focused verification passed: 63 pass / 0 fail across the three affected benchmark files. A valid full-gate result remains pending because resource admission deferred before execution. Admission deferrals occurred before execution while other work was detected; they were not counted as test runs.
- Live accounts, two physical Macs, browser inspection, model suggestions and research arms were not run. The annex keeps all ten live legs unrun.
