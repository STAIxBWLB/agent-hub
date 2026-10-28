# Routing promotion receipt: f0bb8ad0

Surface: task-routing. Corpus 1d3acc7cbf60, split `test` (24 cases). Generated 2026-10-28.
Verdict: **pass**.

- Current default (`HEAD`): sha256 `f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29`
- Candidate (`templates/routing.toml`): sha256 `f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29`
- Keys that differ: none (the same policy)
- Served model ids: not applicable: task routing calls no model. Model-routing keys (hub_routes, local.route, fixed_model) are not exercised by this corpus; their corpus and served model ids are #637 part 2.

| Metric | Current default | Candidate |
| --- | --- | --- |
| owner top-1 accuracy (primary) | 100.0% (24/24) | 100.0% (24/24) |
| reviewer accuracy (22 cases) | 100.0% | 100.0% |
| whole-case pass rate | 100.0% | 100.0% |

Regressions: none. PII or refusal regressions: none. Improvements: none.

```json receipt
{
  "kind": "routing-receipt",
  "version": 1,
  "surface": "task-routing",
  "corpus_hash": "1d3acc7cbf60eb3d6703c857643404cf2ba025165a5e95fa8c6baa98c7b0cc4f",
  "split": "test",
  "base": {
    "ref": "HEAD",
    "sha256": "f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29",
    "config": {
      "classes": {
        "bulk_edit": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "dgx"
        },
        "implement": {
          "escalate_to": [
            "codex",
            "kimi",
            "claude"
          ],
          "peers": [
            "pi",
            "local",
            "codex",
            "kimi"
          ],
          "pi_backend": "dgx",
          "route": "hub/stage"
        },
        "plan": {
          "local_allowed": false,
          "peers": [
            "claude",
            "codex"
          ]
        },
        "review": {
          "local_allowed": false,
          "peers": [
            "claude",
            "codex"
          ]
        },
        "summarize": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "mlx"
        },
        "test": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi",
            "codex"
          ],
          "pi_backend": "dgx"
        },
        "triage": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "mlx"
        }
      },
      "constraints": {
        "budget_paused": "skip_peer",
        "long_context": "skip_local",
        "pii": "local_only"
      },
      "hub_routes": {
        "hub/advisor": {
          "capable": "coding",
          "efficient": "fast",
          "gate_min_tool_results": 1,
          "max_reviews": 1,
          "trigger": "no_tool_call",
          "type": "advisor"
        },
        "hub/escalation": {
          "capable": "coding",
          "confirmations": 2,
          "efficient": "fast",
          "type": "escalation"
        },
        "hub/plan": {
          "capable": "coding",
          "efficient": "fast",
          "type": "plan_execute"
        },
        "hub/stage": {
          "capable": "coding",
          "confidence_threshold": 0.5,
          "efficient": "fast",
          "hold_turns": 2,
          "type": "stage"
        }
      },
      "local": {
        "fixed_model": "coding",
        "route": "hub/stage"
      },
      "max_switch_prefill_tokens": 32000,
      "pi": {
        "dgx_max_context_tokens": 262144,
        "mlx_max_context_tokens": 16000
      },
      "signals": {
        "long_context_tokens": 120000,
        "pii_patterns": [
          "\\b\\d{6}-\\d{7}\\b"
        ],
        "pii_screen": "off"
      },
      "stay_switch": "shadow"
    }
  },
  "candidate": {
    "sha256": "f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29",
    "config": {
      "classes": {
        "bulk_edit": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "dgx"
        },
        "implement": {
          "escalate_to": [
            "codex",
            "kimi",
            "claude"
          ],
          "peers": [
            "pi",
            "local",
            "codex",
            "kimi"
          ],
          "pi_backend": "dgx",
          "route": "hub/stage"
        },
        "plan": {
          "local_allowed": false,
          "peers": [
            "claude",
            "codex"
          ]
        },
        "review": {
          "local_allowed": false,
          "peers": [
            "claude",
            "codex"
          ]
        },
        "summarize": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "mlx"
        },
        "test": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi",
            "codex"
          ],
          "pi_backend": "dgx"
        },
        "triage": {
          "escalate_to": [
            "codex",
            "kimi"
          ],
          "fixed_model": "fast",
          "peers": [
            "pi",
            "local",
            "kimi"
          ],
          "pi_backend": "mlx"
        }
      },
      "constraints": {
        "budget_paused": "skip_peer",
        "long_context": "skip_local",
        "pii": "local_only"
      },
      "hub_routes": {
        "hub/advisor": {
          "capable": "coding",
          "efficient": "fast",
          "gate_min_tool_results": 1,
          "max_reviews": 1,
          "trigger": "no_tool_call",
          "type": "advisor"
        },
        "hub/escalation": {
          "capable": "coding",
          "confirmations": 2,
          "efficient": "fast",
          "type": "escalation"
        },
        "hub/plan": {
          "capable": "coding",
          "efficient": "fast",
          "type": "plan_execute"
        },
        "hub/stage": {
          "capable": "coding",
          "confidence_threshold": 0.5,
          "efficient": "fast",
          "hold_turns": 2,
          "type": "stage"
        }
      },
      "local": {
        "fixed_model": "coding",
        "route": "hub/stage"
      },
      "max_switch_prefill_tokens": 32000,
      "pi": {
        "dgx_max_context_tokens": 262144,
        "mlx_max_context_tokens": 16000
      },
      "signals": {
        "long_context_tokens": 120000,
        "pii_patterns": [
          "\\b\\d{6}-\\d{7}\\b"
        ],
        "pii_screen": "off"
      },
      "stay_switch": "shadow"
    }
  },
  "changed_keys": [],
  "served_models": "not applicable: task routing calls no model. Model-routing keys (hub_routes, local.route, fixed_model) are not exercised by this corpus; their corpus and served model ids are #637 part 2.",
  "evidence": {
    "split": "test",
    "n": 24,
    "primary": {
      "metric": "owner top-1 accuracy",
      "base": 1,
      "candidate": 1,
      "baseCorrect": 24,
      "candidateCorrect": 24
    },
    "secondary": {
      "reviewer": {
        "n": 22,
        "base": 1,
        "candidate": 1
      },
      "fullCase": {
        "base": 1,
        "candidate": 1
      }
    },
    "regressions": [],
    "guardRegressions": [],
    "improvements": [],
    "verdict": "pass",
    "reasons": [],
    "cases": [
      {
        "id": "pref-implement-pi-busy",
        "expect": {
          "owner": "local",
          "reviewer": "claude"
        },
        "base": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": []
        },
        "candidate": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": []
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pref-implement-pi-offline",
        "expect": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "base": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pref-implement-tier-absent-idle-before-busy",
        "expect": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:not-attached",
            "owner:local:not-attached"
          ]
        },
        "base": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:not-attached",
            "owner:pi:not-attached"
          ]
        },
        "candidate": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:not-attached",
            "owner:pi:not-attached"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pref-test-all-idle",
        "expect": {
          "owner": "pi",
          "reviewer": "claude"
        },
        "base": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": []
        },
        "candidate": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": []
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pref-triage-pi-paused",
        "expect": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:paused"
          ]
        },
        "base": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:paused"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:paused"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "judge-plan-claude-offline",
        "expect": {
          "owner": "codex",
          "reviewer": null
        },
        "base": {
          "owner": "codex",
          "reviewer": null,
          "refusals": [
            "owner:claude:offline",
            "reviewer:claude:offline"
          ]
        },
        "candidate": {
          "owner": "codex",
          "reviewer": null,
          "refusals": [
            "owner:claude:offline",
            "reviewer:claude:offline"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "judge-review-claude-busy",
        "expect": {
          "owner": "codex",
          "reviewer": null
        },
        "base": {
          "owner": "codex",
          "reviewer": null,
          "refusals": []
        },
        "candidate": {
          "owner": "codex",
          "reviewer": null,
          "refusals": []
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "judge-review-no-reviewer-attached",
        "guard": "refusal",
        "expect": {
          "owner": null,
          "refusals": [
            "owner:claude:not-attached",
            "owner:codex:not-attached"
          ]
        },
        "base": {
          "owner": null,
          "reviewer": null,
          "refusals": [
            "owner:claude:not-attached",
            "owner:codex:not-attached"
          ]
        },
        "candidate": {
          "owner": null,
          "reviewer": null,
          "refusals": [
            "owner:claude:not-attached",
            "owner:codex:not-attached"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-implement-local-offline",
        "guard": "pii",
        "expect": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:local:offline",
            "owner:pi:pii",
            "owner:codex:pii",
            "owner:kimi:pii"
          ]
        },
        "base": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:local:offline",
            "owner:pi:pii"
          ]
        },
        "candidate": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:local:offline",
            "owner:pi:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-implement-local-busy",
        "guard": "pii",
        "expect": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:pi:pii"
          ]
        },
        "base": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:pi:pii"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:pi:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-bulk-edit-local-paused",
        "guard": "pii",
        "expect": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:local:paused",
            "owner:pi:pii",
            "owner:kimi:pii"
          ]
        },
        "base": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:kimi:pii",
            "owner:local:paused",
            "owner:pi:pii"
          ]
        },
        "candidate": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:kimi:pii",
            "owner:local:paused",
            "owner:pi:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-review-class",
        "guard": "pii",
        "expect": {
          "owner": null,
          "refusals": [
            "owner:claude:pii",
            "owner:codex:pii"
          ]
        },
        "base": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:claude:pii",
            "owner:codex:pii"
          ]
        },
        "candidate": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:claude:pii",
            "owner:codex:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-test-pi-busy",
        "guard": "pii",
        "expect": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:pi:pii",
            "owner:kimi:pii",
            "owner:codex:pii"
          ]
        },
        "base": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:pi:pii"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "user",
          "refusals": [
            "owner:codex:pii",
            "owner:kimi:pii",
            "owner:pi:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "pii-triage-local-absent",
        "guard": "pii",
        "expect": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:local:not-attached",
            "owner:pi:pii",
            "owner:kimi:pii"
          ]
        },
        "base": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:kimi:pii",
            "owner:local:not-attached",
            "owner:pi:pii"
          ]
        },
        "candidate": {
          "owner": null,
          "reviewer": "user",
          "refusals": [
            "owner:kimi:pii",
            "owner:local:not-attached",
            "owner:pi:pii"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "long-summarize-skips-pi-and-local",
        "guard": "refusal",
        "expect": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:policy",
            "owner:local:policy"
          ]
        },
        "base": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy",
            "owner:pi:policy"
          ]
        },
        "candidate": {
          "owner": "kimi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy",
            "owner:pi:policy"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "long-bulk-edit-pi",
        "expect": {
          "owner": "pi",
          "reviewer": "claude"
        },
        "base": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy"
          ]
        },
        "candidate": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "gate-exclude-both-tier",
        "guard": "refusal",
        "expect": {
          "owner": "codex",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:excluded",
            "owner:local:excluded"
          ]
        },
        "base": {
          "owner": "codex",
          "reviewer": "claude",
          "refusals": [
            "owner:local:excluded",
            "owner:pi:excluded"
          ]
        },
        "candidate": {
          "owner": "codex",
          "reviewer": "claude",
          "refusals": [
            "owner:local:excluded",
            "owner:pi:excluded"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "gate-reserved-offline",
        "guard": "refusal",
        "expect": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "base": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:offline"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "gate-backlog-not-routed",
        "expect": {
          "owner": null,
          "reviewer": null
        },
        "base": {
          "owner": null,
          "reviewer": null,
          "refusals": []
        },
        "candidate": {
          "owner": null,
          "reviewer": null,
          "refusals": []
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "gate-approved-not-routed",
        "expect": {
          "owner": null,
          "reviewer": null
        },
        "base": {
          "owner": null,
          "reviewer": null,
          "refusals": []
        },
        "candidate": {
          "owner": null,
          "reviewer": null,
          "refusals": []
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "review-claude-offline",
        "expect": {
          "owner": "pi",
          "reviewer": "codex"
        },
        "base": {
          "owner": "pi",
          "reviewer": "codex",
          "refusals": [
            "reviewer:claude:offline"
          ]
        },
        "candidate": {
          "owner": "pi",
          "reviewer": "codex",
          "refusals": [
            "reviewer:claude:offline"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "review-codex-owner",
        "expect": {
          "owner": "codex",
          "reviewer": "claude"
        },
        "base": {
          "owner": "codex",
          "reviewer": "claude",
          "refusals": [
            "owner:kimi:not-attached",
            "owner:local:not-attached",
            "owner:pi:not-attached"
          ]
        },
        "candidate": {
          "owner": "codex",
          "reviewer": "claude",
          "refusals": [
            "owner:kimi:not-attached",
            "owner:local:not-attached",
            "owner:pi:not-attached"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "review-summarize-pi-excluded",
        "expect": {
          "owner": "local",
          "reviewer": "claude"
        },
        "base": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:excluded"
          ]
        },
        "candidate": {
          "owner": "local",
          "reviewer": "claude",
          "refusals": [
            "owner:pi:excluded"
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "signal-urgent-long-context",
        "expect": {
          "owner": "pi",
          "reviewer": "claude"
        },
        "base": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy"
          ]
        },
        "candidate": {
          "owner": "pi",
          "reviewer": "claude",
          "refusals": [
            "owner:local:policy"
          ]
        },
        "basePass": true,
        "candidatePass": true
      }
    ]
  },
  "generated": "2026-10-28"
}
```

## Cases

Each cell is `owner / reviewer`. A mark is whether the case passes (owner, reviewer where stated, and the stated refusals).

| Case | Guard | Expected | Current default | Candidate |
| --- | --- | --- | --- | --- |
| pref-implement-pi-busy |  | local / claude | local / claude ok | local / claude ok |
| pref-implement-pi-offline |  | local / claude | local / claude ok | local / claude ok |
| pref-implement-tier-absent-idle-before-busy |  | kimi / claude | kimi / claude ok | kimi / claude ok |
| pref-test-all-idle |  | pi / claude | pi / claude ok | pi / claude ok |
| pref-triage-pi-paused |  | local / claude | local / claude ok | local / claude ok |
| judge-plan-claude-offline |  | codex / none | codex ok | codex ok |
| judge-review-claude-busy |  | codex / none | codex ok | codex ok |
| judge-review-no-reviewer-attached | refusal | none | none ok | none ok |
| pii-implement-local-offline | pii | none / user | none / user ok | none / user ok |
| pii-implement-local-busy | pii | local / user | local / user ok | local / user ok |
| pii-bulk-edit-local-paused | pii | none / user | none / user ok | none / user ok |
| pii-review-class | pii | none | none / user ok | none / user ok |
| pii-test-pi-busy | pii | local / user | local / user ok | local / user ok |
| pii-triage-local-absent | pii | none / user | none / user ok | none / user ok |
| long-summarize-skips-pi-and-local | refusal | kimi / claude | kimi / claude ok | kimi / claude ok |
| long-bulk-edit-pi |  | pi / claude | pi / claude ok | pi / claude ok |
| gate-exclude-both-tier | refusal | codex / claude | codex / claude ok | codex / claude ok |
| gate-reserved-offline | refusal | local / claude | local / claude ok | local / claude ok |
| gate-backlog-not-routed |  | none / none | none ok | none ok |
| gate-approved-not-routed |  | none / none | none ok | none ok |
| review-claude-offline |  | pi / codex | pi / codex ok | pi / codex ok |
| review-codex-owner |  | codex / claude | codex / claude ok | codex / claude ok |
| review-summarize-pi-excluded |  | local / claude | local / claude ok | local / claude ok |
| signal-urgent-long-context |  | pi / claude | pi / claude ok | pi / claude ok |
