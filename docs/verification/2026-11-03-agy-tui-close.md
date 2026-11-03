# Antigravity TUI close through `ahub agy` (#485)

Date: 2026-11-03. Refs #485, task #443. This is the launcher leg the [1.4.7 receipt](2026-10-26-agy-1.4.7.md) left open: the hub's own `ahub agy` launch, the launch slot while the TUI runs, and what the launcher does when the TUI is closed normally. The earlier receipts closed agy by hand under a probe. This one runs the real `ahub agy` against a real scratch daemon.

## Environment and isolation

- Hub CLI and daemon: `ahub` 0.29.0, started with `ahub --live-test --project <scratch> up --no-agents --no-console` in a disposable Git project under the per-user temporary directory (outside the person's home). The scratch `status.json` named the scratch project root as `cwd`. The CLI's own `status` was refused for the agent identity, so that file was read instead. `jcode` was put on the scratch roster for a moment while diagnosing this and removed again. Memory and inference were off in the scratch config. `agy` was on that project's roster; no other peer was started.
- Every command had `HOME`, `AGENTHUB_HOME`, `AGENTHUB_STATE_DIR`, `AGENTHUB_PROJECT_DIR`, `TMPDIR` and `XDG_CONFIG_HOME` set to scratch paths. The inherited agent markers were left in place, as the live-test procedure requires, and the launcher ran under `--live-test` delegation. The live hub of this repository was not contacted.
- agy ran the interactive TUI on a PTY with `GEMINI_API_KEY=fixture-key` and `GOOGLE_GEMINI_BASE_URL` pointing at a loopback fixture provider (the 1.4.7 receipt's design: fixed `hub_inbox` call once the model lists `call_mcp_tool`, then a fixed text answer). No account and no cloud model call. Fresh-HOME onboarding was answered with the same keys (Enter, Down, Right, Enter, Enter). The scratch settings pre-allowed `mcp(agent-hub_agent-hub/hub_inbox)`.
- **No Seatbelt was used around `ahub agy`** (the 1.4.7 receipt did use it). Isolation here rests on the scratch environment above and on the real-config hashes below.
- Bystander files the launcher must not touch were placed in the scratch project: `.agents/plugins/other/plugin.json` and `.agents/rules/r.md`.
- The person's real Gemini files were hashed before and after every run: `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/config/config.json`, `~/.gemini/config/mcp_config.json`, `~/.gemini/settings.json` (and `config/import_manifest.json`, absent on this machine). Equal before and after in every run. The real `~/.gemini/antigravity-cli` directory did change during the window (new log files, `cli.log`, `conversation_summaries.db`, `builtin/`), and the real-config hashes are the evidence that my runs did not write there. The new entries are consistent with other agy processes on the machine: their logs show workspace `/` and the real app-data directory, while every agy run of this receipt logged the scratch project and the scratch app-data directory under its own HOME.

## Facts (final run, agy 1.4.12; the same legs also passed in an earlier run, see below)

| Leg | Observation |
| --- | --- |
| Slot is held during the launch, before agy attaches | `ahub agy` was started a second time seconds after the first, with the first still starting its TUI: exit 1, `a managed native launch is already active; end it in its terminal first`. The three managed files were still present. |
| Slot is held while the TUI runs | After the first prompt was answered, a second `ahub agy`: exit 1, `native peer is already attached; end it in its terminal first`. The three managed files were still present. |
| Launcher wrote the managed plugin | While the TUI ran, `.agents/plugins/agent-hub/` held exactly `hooks.json`, `mcp_config.json`, `plugin.json`. |
| Hub tools worked through the plugin | The plugin MCP server attached lazily: provider requests listed 0, 12, then 15 tools (`call_mcp_tool` from the second agent request), `call_mcp_tool` ran `hub_inbox` once and the TUI printed the fixture answer. The hub log shows `agy` going `idle`, `busy`, `idle`. |
| Normal close | `/exit` and Enter in the TUI: `agy` exited by itself, the `ahub agy` process exited 0, and agy printed its resume line. No signal was sent. The hub log shows `state agy -> offline`. |
| Plugin cleanup | After the close `.agents/plugins/agent-hub/` was an empty directory: the three managed files were removed. |
| Bystanders unchanged | SHA-256 of `.agents/plugins/other/plugin.json` and `.agents/rules/r.md` equal before and after. |
| Slot is released | A second full launch right after the first close was admitted: three managed files written, TUI ran a prompt, `/exit` closed it with exit 0, the files were removed again, the bystanders were unchanged again. |
| Real config | The five real-config hashes were equal before and after the run. |
| Cleanup | `ahub --live-test --project <scratch> down` reported `hub stopped`. No `agy` process and no scratch hub process remained. |

An earlier complete run (the first two-cycle run, agy 1.4.7 for the first cycle and 1.4.12 for the second, after the binary was replaced, see below) gave the same results for the held slot after attach, the normal close, the cleanup, the second admitted cycle, the bystanders and the real-config hashes.

## Other observations

- **Closing while a native approval is pending.** Two earlier runs typed `/exit` while the fixture's `hub_inbox` call was waiting on agy's native approval prompt (the scratch settings did not yet pre-allow it). agy did not exit within 15 s, the probe sent SIGTERM, `ahub agy` forwarded it, the slot was released and the managed files were removed. The next launch after that kill was admitted. Neither run is the normal-close leg above; they only show that the signal path also ends in a released slot and removed files.
- The launcher printed `agy 1.4.12 is untested (verified 1.4.2, 1.4.7; compatible: the 1.4.x line); launching on the compatible line`, as designed (#589). `src/adapters/compat.ts` is unchanged by this receipt: 1.4.12 has no T0 receipt and stays unverified.

## Side effect on the machine: agy replaced its own binary

The first scratch run started agy 1.4.7 with a scratch HOME and without `AGY_CLI_DISABLE_AUTO_UPDATE`. agy spawned its background updater, which replaced the person's `~/.local/bin/agy` (a path the scratch HOME does not isolate) with 1.4.12 and kept the previous binary beside it as `agy.<n>.old`. The kept binary has SHA-256 `b7a13e53c9f49921692676ef8edc2e60ceb67064c00bc732d9a364ec3ad75b32`, the 1.4.7 hash recorded in the 1.4.7 receipt. The new binary's SHA-256 is `34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3`. The real Gemini configuration files were not touched. Setting `AGY_CLI_DISABLE_AUTO_UPDATE=1` for any further live agy run prevents this; the smoke ledger now says so. Rolling back is the person's choice.

## Not verified

- A real account, a real model turn and agy's own permission prompts (the provider was a fixture).
- `hub_send` and a board read or proposal through the TUI: only `hub_inbox` was called. AC3 of #485 names all three, so the issue stays open.
- The IDE form, Linux, and a Seatbelt-wrapped `ahub agy`.
- A launch of the verified 1.4.7 build from start to finish: the first cycle of the earlier run was 1.4.7 and the final run was 1.4.12.

## Decision

The hub launcher's own close leg holds on the 1.4.x line in a scratch project: the launch slot is held while agy starts and runs, a normal TUI close releases it so the next launch is admitted, the three managed plugin files are the only thing removed, and the person's real Gemini configuration hashes are unchanged. This does not close #485 on its own (see Not verified), so the pull request says `Refs #485`.
