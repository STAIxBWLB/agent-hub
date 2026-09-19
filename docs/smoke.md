# Live smoke checklist

`scripts/check.sh` covers everything against fakes. The legs below need real accounts and an interactive terminal, so they are run by hand and recorded here.

## Install

```bash
bun install && bun link                      # puts `hub` on PATH
claude plugin marketplace add "$(pwd)"       # this repo is the marketplace
claude plugin install agent-hub@agent-hub
hub doctor                                   # every row "ok"; memory rows may be "--" (the hub works without them)
```

Claude channels are a research preview: `hub claude` passes `--dangerously-load-development-channels plugin:agent-hub@agent-hub`.

## M1: trio chat

In the project directory, one terminal each:

1. `hub init && hub up`, then `hub tail` (keep it open).
2. `hub kimi`. `hub status` shows `kimi idle`.
3. `hub codex`. The TUI opens; after its first thread starts, `hub status` shows `codex idle`.
4. `hub claude`. `hub status` shows `claude idle`.
5. `hub say "Each of you: reply with your name and nothing else."` Expect three replies in `hub tail`, each within its turn time, and each agent seeing the others' replies framed as untrusted (`<channel source="agent-hub">` in Claude, `[agent-hub message from ...]` in Codex and Kimi).
6. While Codex is mid-turn on a long prompt typed in its TUI, run `hub say @codex "status?"`. `hub status` shows `queued 1` for codex; the message is injected after the turn completes.
7. `hub say @kimi one`, `hub say @kimi two` back to back: both answered in order, none lost.
8. Ask Kimi for something that needs a tool (`hub say @kimi "create /tmp/agenthub-smoke.txt"`): `hub tail` prints the permission request; `hub permit <id> <option>` answers it; no answer within 120 s cancels it.
9. `hub kill`: no `kimi acp` or `codex app-server` process survives (`pgrep -fl "kimi acp|codex app-server"`).

## Record

| Date | Leg | Result |
| --- | --- | --- |
| 2026-09-19 | Kimi: `hub up`, `hub kimi`, `hub say @kimi`, `hub tail`, `hub status`, `hub kill` (kimi 0.43.1) | pass: reply "pong" in about 10 s, no orphan process |
| 2026-09-19 | Kimi adapter alone: `bun scripts/smoke-acp.ts` | pass: session ready in 0.6 s, reply at hop 1 |
| 2026-09-19 | Codex adapter: `bun scripts/smoke-codex.ts` (codex-cli 0.154.0) | partial: real thread adopted, `turn/start` accepted, `turn/started` and `turn/completed` tracked, peer returned to idle. The turn itself failed with `usageLimitExceeded` on the account, so the reply leg is not verified live |
| | Codex TUI through `hub codex` | not run |
| | Claude through `hub claude` (steps 4 to 6) | not run: needs an interactive Claude Code session |
