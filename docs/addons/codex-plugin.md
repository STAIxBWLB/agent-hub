# Codex plugin for Claude Code: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

- What it does: lets a Claude session hand diagnosis, a second implementation or an adversarial review to Codex outside the hub's bus.
- Expected effects to measure: tokens and wall time per approved task, first-pass rate, and work that bypasses the task board.
- Evidence: none collected; the fingerprint records it for Claude only. Arms owed: `all-on`, `codex-plugin-off`, `all-off`.
- Decision: keep optional. The hub's own Codex peer and task board already carry delegation natively; nothing is adopted without data.
