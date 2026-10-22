# Optional code-facts native receipt, 2026-10-22

- Hub source commit: `21ed30ed72f6b5436126461945a9f409eb056b38`.
- Native tool: installed ripwire 0.6.7. The module verifies its version and output schema/keys; this is not a binary attestation.
- Host: macOS, Bun 1.4.2. Model-free tiny temporary Git fixture with two TypeScript functions; no model, provider login or live agent turn.
- The production `CodeFacts` methods were invoked for changed symbols, one enclosing definition, existence and one-hop neighbours. All four returned parsed known values. Both actual XML verbs and the actual callers/callees JSON path were exercised.
- The fixture's main HEAD stayed unchanged; after every read the disposable worktree was removed and only the original fixture checkout remained. The fixture itself was removed afterwards. No analysis of the agent-hub main checkout was performed.
- Change kinds remain unknown: ripwire 0.6.7 omits deleted definitions and does not expose both-tree change identity. `countsFloor` is retained for graph observations. This receipt does not establish a complete semantic diff or graph.
- Separate Linux fakes cover missing/version/schema/truncated/overflow failures, deadline teardown, an exited CLI leaving a descendant, reader close, untracked owner contamination, repository filters, metadata screening and review admission fences. The strict file/coverage gate is unchanged.

## Parsed fixture values

```json
{
  "changed": {
    "state": "known",
    "value": [
      {
        "name": "retained",
        "kind": "fn",
        "path": "a.ts",
        "line": 1,
        "ambiguous": false,
        "change": "unknown"
      },
      {
        "name": "added",
        "kind": "fn",
        "path": "a.ts",
        "line": 3,
        "ambiguous": false,
        "change": "unknown"
      }
    ]
  },
  "at": {
    "state": "known",
    "value": [
      {
        "name": "added",
        "kind": "fn",
        "path": "a.ts",
        "line": 3,
        "ambiguous": false,
        "change": "unknown",
        "endLine": 3
      }
    ]
  },
  "exists": {
    "state": "known",
    "value": {
      "exists": true,
      "ambiguous": false
    }
  },
  "neighbours": {
    "state": "known",
    "value": {
      "countsFloor": true,
      "callers": [
        {
          "name": "added",
          "kind": "fn",
          "path": "a.ts",
          "line": 3,
          "ambiguous": false,
          "change": "unknown"
        }
      ],
      "callees": [],
      "hiddenAmbiguous": 0
    }
  },
  "mainUnchanged": true,
  "worktrees": 1
}
```
