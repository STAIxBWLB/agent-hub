# Model-routing promotion receipt: b152ddb9

Surface: model-routing. Corpus 3366190f8e7e, split `test` (21 deterministic cases). Generated 2026-10-29.
Verdict: **pass**.
Deterministic cases: **pass**. Live judge cases: live-not-run.

- Current default (`origin/main`): model-routing keys sha256 `b152ddb9bb8da9e943fae62f00f7ab82f65cfe161d90228a1b1b49169fa6e52a`, template sha256 `f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29`
- Candidate (`templates/routing.toml`): model-routing keys sha256 `b152ddb9bb8da9e943fae62f00f7ab82f65cfe161d90228a1b1b49169fa6e52a`, template sha256 `f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29`
- Keys that differ: none (the same model-routing keys)
- Live half required: no (no model-routing key changed: this is the baseline of the shipped default against itself)
- Served model ids: live-not-run

| Metric | Current default | Candidate |
| --- | --- | --- |
| deterministic case pass rate (primary) | 100.0% (21/21) | 100.0% (21/21) |
| route cases (18) | 100.0% | 100.0% |
| selection cases (3) | 100.0% | 100.0% |

Regressions: none. PII or hard-override regressions: none. Improvements: none.

```json receipt
{
  "kind": "model-routing-receipt",
  "version": 1,
  "surface": "model-routing",
  "corpus_hash": "3366190f8e7e4a6f613f6bcaac3cbbd3565d45c80d09c92529f9e52b35c17f8b",
  "split": "test",
  "base": {
    "ref": "origin/main",
    "sha256": "b152ddb9bb8da9e943fae62f00f7ab82f65cfe161d90228a1b1b49169fa6e52a",
    "template_sha256": "f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29",
    "config": {
      "classes": {
        "bulk_edit": {
          "fixed_model": "fast",
          "pi_backend": "dgx"
        },
        "implement": {
          "pi_backend": "dgx",
          "route": "hub/stage"
        },
        "plan": {},
        "review": {},
        "summarize": {
          "fixed_model": "fast",
          "pi_backend": "mlx"
        },
        "test": {
          "fixed_model": "fast",
          "pi_backend": "dgx"
        },
        "triage": {
          "fixed_model": "fast",
          "pi_backend": "mlx"
        }
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
      "stay_switch": "shadow"
    }
  },
  "candidate": {
    "sha256": "b152ddb9bb8da9e943fae62f00f7ab82f65cfe161d90228a1b1b49169fa6e52a",
    "template_sha256": "f0bb8ad0b4b544df2a5287103578235fa92aec80fa8cb8773ddec87c91e71b29",
    "config": {
      "classes": {
        "bulk_edit": {
          "fixed_model": "fast",
          "pi_backend": "dgx"
        },
        "implement": {
          "pi_backend": "dgx",
          "route": "hub/stage"
        },
        "plan": {},
        "review": {},
        "summarize": {
          "fixed_model": "fast",
          "pi_backend": "mlx"
        },
        "test": {
          "fixed_model": "fast",
          "pi_backend": "dgx"
        },
        "triage": {
          "fixed_model": "fast",
          "pi_backend": "mlx"
        }
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
      "stay_switch": "shadow"
    }
  },
  "changed_keys": [],
  "live_required": false,
  "served_models": "live-not-run",
  "overall": {
    "verdict": "pass",
    "reasons": []
  },
  "evidence": {
    "split": "test",
    "n": 21,
    "primary": {
      "metric": "deterministic case pass rate",
      "base": 1,
      "candidate": 1,
      "baseCorrect": 21,
      "candidateCorrect": 21
    },
    "secondary": {
      "kinds": {
        "route": {
          "n": 18,
          "base": 1,
          "candidate": 1
        },
        "selection": {
          "n": 3,
          "base": 1,
          "candidate": 1
        }
      }
    },
    "regressions": [],
    "guardRegressions": [],
    "improvements": [],
    "verdict": "pass",
    "reasons": [],
    "cases": [
      {
        "id": "select-implement-uses-stage-route",
        "kind": "selection",
        "base": {
          "route": "hub/stage",
          "model": "coding"
        },
        "candidate": {
          "route": "hub/stage",
          "model": "coding"
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "select-bulk-edit-fixed-alias",
        "kind": "selection",
        "base": {
          "route": null,
          "model": "fast"
        },
        "candidate": {
          "route": null,
          "model": "fast"
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "select-unlisted-class-takes-local-default",
        "kind": "selection",
        "base": {
          "route": "hub/stage",
          "model": "coding"
        },
        "candidate": {
          "route": "hub/stage",
          "model": "coding"
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-fresh-task-efficient",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-import-error-then-repeat-capable",
        "kind": "route",
        "guard": "hard_override",
        "base": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-critical-oom-capable",
        "kind": "route",
        "guard": "hard_override",
        "base": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-spinning-below-threshold-stays-efficient",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-many-different-failures-capable-by-dimensions",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "dimensions",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "dimensions",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-hold-after-override",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            },
            {
              "tier": "capable",
              "model": "coding",
              "source": "hold",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "override",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            },
            {
              "tier": "capable",
              "model": "coding",
              "source": "hold",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-records-shadow-plan",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": true
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "stage-pii-trace-has-no-prefill",
        "kind": "route",
        "guard": "pii",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": "shadow",
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "plan-read-only-plans-on-capable",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": true,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "capable",
              "model": "coding",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": true,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "plan-first-edit-hands-to-efficient",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "advisor-held-answer-reviewed",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "redo",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "redo",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "advisor-approve-lets-it-stop",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "approve",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "approve",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "advisor-answer-before-any-tool-not-reviewed",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "advisor-max-reviews-one",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "redo",
              "planned": false,
              "prefillRecorded": false
            },
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "redo",
              "planned": false,
              "prefillRecorded": false
            },
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "advisor-pii-without-campus-no-judge",
        "kind": "route",
        "guard": "pii",
        "base": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "none",
              "model": null,
              "source": null,
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "escalation-first-turn-efficient-and-judged",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "escalation-two-fresh-confirmations-latch",
        "kind": "route",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            },
            {
              "tier": "capable",
              "model": "coding",
              "source": "classifier",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            },
            {
              "tier": "capable",
              "model": "coding",
              "source": "classifier",
              "staySwitch": null,
              "judgeCalls": 1,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      },
      {
        "id": "escalation-pii-without-campus-no-judge",
        "kind": "route",
        "guard": "pii",
        "base": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "candidate": {
          "turns": [
            {
              "tier": "efficient",
              "model": "fast",
              "source": "default",
              "staySwitch": null,
              "judgeCalls": 0,
              "outcome": "none",
              "planned": false,
              "prefillRecorded": false
            }
          ]
        },
        "basePass": true,
        "candidatePass": true
      }
    ]
  },
  "generated": "2026-10-29"
}
```

## Deterministic cases

Each cell is the tier, why (`override`, `hold`, `dimensions`), judge calls (`jN`) and advisor outcome per turn; a selection case shows route / alias. A mark is whether the case passes.

| Case | Guard | Current default | Candidate |
| --- | --- | --- | --- |
| select-implement-uses-stage-route |  | hub/stage / coding ok | hub/stage / coding ok |
| select-bulk-edit-fixed-alias |  | direct / fast ok | direct / fast ok |
| select-unlisted-class-takes-local-default |  | hub/stage / coding ok | hub/stage / coding ok |
| stage-fresh-task-efficient |  | efficient/default ok | efficient/default ok |
| stage-import-error-then-repeat-capable | hard_override | capable/override ok | capable/override ok |
| stage-critical-oom-capable | hard_override | capable/override ok | capable/override ok |
| stage-spinning-below-threshold-stays-efficient |  | efficient/default ok | efficient/default ok |
| stage-many-different-failures-capable-by-dimensions |  | capable/dimensions ok | capable/dimensions ok |
| stage-hold-after-override |  | capable/override > capable/hold ok | capable/override > capable/hold ok |
| stage-records-shadow-plan |  | efficient/default ok | efficient/default ok |
| stage-pii-trace-has-no-prefill | pii | efficient/default ok | efficient/default ok |
| plan-read-only-plans-on-capable |  | capable/default ok | capable/default ok |
| plan-first-edit-hands-to-efficient |  | efficient/default ok | efficient/default ok |
| advisor-held-answer-reviewed |  | none j1 redo ok | none j1 redo ok |
| advisor-approve-lets-it-stop |  | none j1 approve ok | none j1 approve ok |
| advisor-answer-before-any-tool-not-reviewed |  | none ok | none ok |
| advisor-max-reviews-one |  | none j1 redo > none ok | none j1 redo > none ok |
| advisor-pii-without-campus-no-judge | pii | none ok | none ok |
| escalation-first-turn-efficient-and-judged |  | efficient/default j1 ok | efficient/default j1 ok |
| escalation-two-fresh-confirmations-latch |  | efficient/default j1 > capable/classifier j1 ok | efficient/default j1 > capable/classifier j1 ok |
| escalation-pii-without-campus-no-judge | pii | efficient/default ok | efficient/default ok |
