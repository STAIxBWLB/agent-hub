# SDLC metrics diagnosis

On 2026-11-20, the project board contained 11 `mergeReadback` records with state `merged`, none with a cost record. Tasks 1002 and 1028 were examples. The readback therefore does run and records merge state.

`readPrCostHistory` requests the first 100 repository-wide `check.yml` runs and marks the result complete only when `total_count` equals the returned count. The GitHub API reported 4,854 total and 100 returned. `captureExternalMerge` discards the cost when the result is incomplete, so metrics read the merged records but have no cost values. A bounded fixture with one repository-wide run misses this production case. The board history predating the readback rollout also has no merge cost; it cannot by itself establish the missing GitHub counts.

Refs #1579 and #1555; hub task 1032.
