# dot admission: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

- What it does: admits heavy local work (builds, full test runs, installs) one per repository and defers under host pressure.
- Expected effects to measure: check failures and wall time per approved task, and checks deferred rather than run.
- Evidence: none collected; the fingerprint records it for every peer whose first `dot` on PATH is the dotfiles CLI. Arms owed: `all-on`, `dot-admit-off`, `all-off`.
- Decision: keep optional. The hub runs one completion check at a time already; admission across sessions stays the workspace's tool.
