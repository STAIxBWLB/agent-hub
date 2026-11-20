# Influences

agent-hub shares no code with these projects. Each informed a feature; the design and implementation are agent-hub's own.

- [agent-bridge](https://github.com/raysonmeng/agent-bridge): a bridge between Claude Code and Codex. Its forwarding of agent messages, marker tiers, busy guard and turn watchdog informed the bus.
- claude-mem: a memory service for coding agents. It was the hub's memory backend until 2026-10-17, when the first-party `@staix/agent-mem` replaced it; `ahub memory` can still import from it ([memory](memory.md)).
- [GSD](https://github.com/gsd-build/get-shit-done): a phased workflow for coding agents. Its acceptance-criteria checklist remains in the review's Compliance pass ([analysis](gsd-collaboration-analysis.md)).
