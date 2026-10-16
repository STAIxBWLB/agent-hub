# agent-mem P2: hub memory read tools contract

Copied verbatim from issue #412 (plan v3, 2026-10-16) so sandboxed peers can read it. The issue is the source; if they differ, the issue wins.

## Collaboration, between agents (from #412)

- **Between agents.**
  - Stage A: hub read tools `hub_memory_search`, `hub_memory_show`, `hub_memory_graph`, so sandboxed peers read through the daemon. Their contract:
    - The project is scoped server-side from the caller (`memoryProjectKey`), never passed as a parameter.
    - The query and every returned title, node, edge, error and count are screened.
    - Refused in a PII turn, behind their own capability.
    - Registered in the MCP, Pi and local catalogs; their arguments and results are excluded from capture.
    - A schema frozen before P2, with every limit finite and counted in UTF-8 bytes. Proposed numbers (policy, adjustable; the requirement is a finite tested contract):
      - Inputs: query ≤ 200 bytes; show ≤ 8 ids, each 6 to 64 bytes; graph ≤ 8 start nodes, each ≤ 200 bytes, hops 1 or 2. Over-limit input is refused before any work or log line.
      - Output budget for the whole result, metadata and errors included: search default 8 / max 20 lines, ≤ 4 KB; show ≤ 8 KB; graph default 60 / max 120 nodes and max 240 edges, ≤ 6 KB, fails first.
      - Truncation is deterministic. A graph never returns an edge without both endpoints. A cut text excerpt is marked incomplete; id, provenance and kind headers are never cut.
      - `truncated:N` counts only results the caller may see, after screening. Hidden or unscreened rows are never counted or named.
      - Ids resolve as today: exact id or a unique prefix among project-visible ids, original ids redirected. An ambiguous, unknown or withheld id gets one refusal that does not reveal candidates.
      - Tests: UTF-8 input and output, oversized input, dense graph, shared and private rows, ambiguous prefix, every eligible result over budget.
  - Writes stay `hub_remember` with the existing gates.

## P2 row (from #412 Phases)

| Phase | Where | Content | Gate |
|---|---|---|---|
| P2 Read tools | agent-hub | `hub_memory_search`/`show`/`graph` per the collaboration contract and its frozen schema. | The schema tests listed there. C3 and capture-exclusion tests for these tools. A live receipt of pi reading through them. No file-read grant. |

Phase rules from #412: each gate names `scripts/check.sh` ending `check: OK`, `bun run build` when hub tools or the plugin change, and reading `docs/agent-notes/` before editing `daemon.ts`, `bus.ts`, `hub-tools.ts` or `main.ts`. Tests that set `AGENTHUB_HOME` restore it.
