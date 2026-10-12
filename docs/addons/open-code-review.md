# open-code-review: decision note (#248)

Status 2026-10-12: keep optional. No measured effect yet.

- What it does: the OCR delegation gate selects files and rules for a review that the host agent then performs; in this workspace it gates merges.
- Expected effects to measure: review rounds and reviewer unmet items per approved task, `regressed` and `reverted` labels after approval.
- Evidence: none collected; the fingerprint records it for Claude (plugin) only. Arms owed: `all-on`, `open-code-review-off`, `all-off`.
- Decision: keep optional. The hub's reviewer role and review checklists (#35) are the native counterpart; no part is adopted without data.
