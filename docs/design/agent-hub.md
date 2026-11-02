---
id: agent-hub
type: goal
title: Agent Hub Product Goal
status: draft
depends-on: []
references: [agent-hub-architecture]
implements: []
covers: [product-goal]
tags: [agent-hub, dogfood]
paths:
  - README.md
  - package.json
---

# Agent Hub Product Goal

agent-hub coordinates native coding agents and hub-owned workers as peers in a project. It gives the person one visible record of work, messages, review and intervention while preserving each tool's native interaction and account boundary. The product reduces coordination loss without treating an agent's assertion as authority or proof.

This draft distills the Context, Decisions and Risks in the [historical design ledger](../specs/2026-09-19-agent-hub-design.md). The [[agent-hub-architecture]] spec describes the current system boundaries. Agent-facing procedures remain in [AGENTS.md and its area notes](../../AGENTS.md#area-notes); the ledger retains superseded decisions and their history.

## Scope

The core loop is to propose and assign work, exchange addressed messages while peers may be busy or offline, preserve delivery uncertainty, gather implementation and review evidence, and return decisions to the person. CLI, console, dashboard and native tools expose the same project authority. Multiple projects can run their own hubs; opt-in messages between hubs do not create a shared board or approval domain ([#19](https://github.com/STAIxBWLB/agent-hub/issues/19), [#446](https://github.com/STAIxBWLB/agent-hub/issues/446)).

The hub also owns a local worker and optional model calls for its own inference. It does not replace every native agent with that loop, pool subscription credentials, or make native behavior identical across vendors. Native adapters preserve those differences behind explicit contracts ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

## Product decisions

| Current rule | Reason and deciding issue |
| --- | --- |
| The issue is the change spec, the board is task authority, and GitHub is authority for PRs, checks and tags. | Separate records prevent a chat claim or stale local view from becoming lifecycle proof ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481)). |
| Peers use native adapters with host-owned admission and lifecycle boundaries. | New tools can participate without moving privileged policy into vendor-specific transports ([#451](https://github.com/STAIxBWLB/agent-hub/issues/451), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625)). |
| Messages have durable delivery evidence, and uncertain attempts are distinct from task completion. | A restart, failed notification or retry must not silently repeat work or approve a task ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37), [#1079](https://github.com/STAIxBWLB/agent-hub/issues/1079)). |
| Hub-owned traffic uses in-process model routes and OmniRoute; native subscription traffic keeps its native authentication. | This separates peer policy, per-call model selection and provider credentials without a second routing sidecar ([#553](https://github.com/STAIxBWLB/agent-hub/issues/553)). |
| Host policy screens private task and turn text before shared projection, memory or model use, with positive campus admission where PII-sensitive inference requires it. | A missing network fact or a model-selected destination is not privacy authorization ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198), [#230](https://github.com/STAIxBWLB/agent-hub/issues/230)). |
| Portable memory comes from exact-pinned first-party amem; the hub keeps caller and privacy policy. Legacy claude-mem is import-only. | One storage core avoids competing memory implementations and dependence on an external worker for runtime recall and capture ([#752](https://github.com/STAIxBWLB/agent-hub/issues/752)). |
| Code review, automated checks, hosted CI and native/live verification remain distinct evidence. | A code-only reviewer or a passing fixture cannot certify a real account, sandbox or provider interaction ([#852](https://github.com/STAIxBWLB/agent-hub/issues/852)). |
| Ordinary peer, configured conductor and person authority are different; release consent originates in the person's explicit decision. | Model output and relayed peer messages cannot grant privileged operational or release authority ([#812](https://github.com/STAIxBWLB/agent-hub/issues/812), [#1063](https://github.com/STAIxBWLB/agent-hub/issues/1063)). |

## Risks and limits

- Native protocols, flags and permission surfaces change independently. Adapter isolation and version-scoped evidence reduce the impact; they do not establish universal enforcement or support for an unverified version ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#888](https://github.com/STAIxBWLB/agent-hub/issues/888)).
- A transport can fail after effects occur. Durable uncertainty, recipient inspection and bounded request-key replay reduce duplicate effects without claiming durable exactly-once execution across restarts ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37), [#1078](https://github.com/STAIxBWLB/agent-hub/issues/1078)).
- Untrusted peer or room text can request actions or carry private data. Framing, host authority, path/permission boundaries and privacy screening constrain that input; room membership itself confers no local privileges ([#446](https://github.com/STAIxBWLB/agent-hub/issues/446)).
- Memory and model infrastructure can be unavailable or stale. Optional recall and inference are separate from the authoritative message/task records, so their output or failure does not become task evidence ([#752](https://github.com/STAIxBWLB/agent-hub/issues/752), [#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

## Success and evidence

Product evidence separates source/fixture coverage from installed-hub and native use. The [dogfood scorecard](../dogfood.md) records which features actually run here and the metric that demonstrates them; unverified use stays unverified ([#687](https://github.com/STAIxBWLB/agent-hub/issues/687)).

The design-spec pilot is bounded to this goal, the architecture and the bus, task-board and adapters modules. Its four-week report targets at least 70% of PRs touching pilot paths also updating the owning spec, zero schema errors on main and zero stale documents after release review/restamping. Notice noise and contradictions are recorded before recommending broader coverage or require mode. These are pilot targets, not results established by this draft ([#1064](https://github.com/STAIxBWLB/agent-hub/issues/1064)).
