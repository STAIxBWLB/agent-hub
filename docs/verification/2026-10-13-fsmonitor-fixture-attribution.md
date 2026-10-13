# Fsmonitor fixture attribution (#369)

## Evidence

- Failed macOS run: [38340462476](https://github.com/STAIxBWLB/agent-hub/actions/runs/38340462476). The original full-gate failure and diagnostic replay 20 are retained separately from the 19 passing replays.
- Artifact: `docs-git-diagnostics-0addbb4290934a59299c3e66144445567a4462f9`, `git-20.jsonl` and `test-20.log`. Versions: Git 2.55.0, Bun 1.4.2, Node 22.23.2.
- The marker writer is a descendant of fixture `commit -qm "Record reviewed documentation"`, through detached auto maintenance, repack, and pack-objects with `--indexed-objects`. Root trace SID: `20261013T031954.147942Z-H0482c2ec-P000098b4`.
- The fixture configured the trap at 03:19:54.169372 UTC. Pack-objects started at 03:19:54.178275 and spawned the trap at 03:19:54.179892. The checker first Git invocation started at 03:19:54.215564 with `core.fsmonitor=false`. The only trap invocation belongs to fixture maintenance, before checker startup.

## Correction

- The owner approved the exact fixture exception: add `-c maintenance.auto=false -c gc.auto=0` to fixture Git invocations. This prevents fixture-owned detached jobs from crossing the checker observation window.
- All original assertions, the planted trap, production checker behavior, and user Git configuration remain unchanged. No unrelated process was stopped.
- A new deterministic regression traces fixture commits with aggressive repository-local gc settings and requires no maintenance child. Explicit pack controls prove `core.fsmonitor=false` keeps the marker absent and the enabled trap writes it.

## Verification

- Actual local document-check suite: 14 pass, 0 fail, 72 assertions, including the new regression and both controls.
- Exact final-head Linux/macOS/full seeded gates and current-head review remain required before issue closure. Earlier passing runs are not a correction receipt. No native deployment is claimed by this report.
