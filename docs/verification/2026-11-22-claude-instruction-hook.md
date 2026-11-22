# Claude instruction hook probe

Hub task 1067, issue #1622 AC3. **Result: the typed, Skill, subagent and compaction cases passed on both versions.** The channel case was not driven: the clients reported that channels were unavailable. The hub-owned channel escapes a leading slash in each notification body by construction. Another plugin channel needs its own `--channels` opt-in, which hub-launched sessions do not pass; that remains a separate boundary.

The rerunnable harness is `scripts/probes/claude-instruction-hook.py`. It runs each supplied Claude binary under a new isolated HOME and Claude config, an empty project, a private tmux server and a synthetic loopback API. It uses no account or real model. The native API-key prompt was answered for the synthetic key. A private fake MCP server emitted the channel notification. The harness exits nonzero if a required driven case fails or cannot be driven; the unavailable channel leg is covered by the construction guard below.

| Claude Code | Typed TUI | Skill tool | Subagent | `/compact` | Channel |
|---|---|---|---|---|---|
| 2.1.328 | Pass | Pass | Pass | Pass | Not driven; hub content guarded |
| 2.1.329 | Pass | Pass | Pass | Pass | Not driven; hub content guarded |

- The typed TUI case delivered `/agent-hub:ahub show status` and a session ID to `UserPromptSubmit` on each version. At hook entry and after a two-second wait inside the hook, the transcript contained zero records for both fresh sessions. Claude has no binding in `NativeHookLaunches`, which currently requires an adapter facts hook. The existing synchronous hook therefore cannot prove the newest genuine user transcript record at entry. The receipt store is deferred to a separate design; an agent deliberately rewriting its own transcript remains outside this proof.
- The synthetic model's Skill request was refused by `disable-model-invocation`; no new prefixed hook input appeared. A synthetic model launched a subagent with a prefixed prompt, and the child was observed without a prefixed hook input.
- The TUI ran `/compact`; a further API request and compaction screen were observed, with no second prefixed hook input at the check. This does not prove behavior after unobserved later replay.
- The fake MCP channel wrote a prefixed notification, but both native clients reported `Channels are not currently available` and ignored `server:probe`. The synthetic model request did not contain the notification. The test cannot say what the hook would receive after an actual channel delivery; the hub-owned channel guard is tested separately.

Run from this repository with explicit absolute binary paths:

```sh
python3 scripts/probes/claude-instruction-hook.py /absolute/path/to/claude-2.1.328 /absolute/path/to/claude-2.1.329
```

The paths above are probe arguments, not person-run repair instructions. When an isolated account-backed run is available, rerun the channel leg. The construction guard covers the hub channel until then. The prior print-mode observations from hub task 1064 are superseded by the TUI cases above.

## Deferred confirmation observations

On both versions, the hook's `prompt_id` matched the corresponding command record's `promptId`. The command record had `origin.kind: human`, `isSidechain: false` and no `promptSource`; the skill expansion was a separate meta record. A plain pasted text lookalike on 2.1.329 retained the same command-shaped content but had `promptSource: typed`. At `/compact`, each version wrote a summary record without a human origin. These observations support fail-closed checks, not authentication against a same-user process that edits the transcript.

Claude recorded `/agent-hub:ahub   show   status` as command name `/agent-hub:ahub` and args `show   status`: the separator whitespace was not retained while internal whitespace was. The comparison therefore hashes the command and trimmed args, keeps internal bytes, and refuses args containing `<`, `>` or `&` until their encoding is separately proven.

In an earlier exploratory version-binding probe, the isolated hook's `CLAUDE_PID` identified the native ancestor. A symlink-launched 2.1.329 process retained a mapped executable pointing at its versioned binary; resolving the launch symlink after replacing it could no longer establish that match, so version admission returned unknown. The implementation no longer uses that probe: confirmation checks the matched transcript record's version.

An isolated native 2.1.329 TUI was then run against a scratch daemon and the setup-generated hooks, with a synthetic loopback API. A typed command produced one pending row with the expected canonical hash; the native Stop hook closed it. No real account or project was used. This is a pending/Stop integration check, not evidence that an instructed operation was admitted.

For hub task 1072 review, a second isolated 2.1.329 TUI used the setup-installed prompt hook and a scratch daemon with a synthetic loopback API. The hook-created pending row had `created=1795335021968` ms; its matching human command record had timestamp `2026-11-22T08:10:21.981Z`, 13 ms later. A test-managed live launcher proof and session facts were installed for that session, and the daemon's captured `instructionReceiptStore` confirmed the actual record with the expected arguments. The scratch setup omitted its Stop hook to keep the receipt pending until the confirmation check. This proves the record and confirmation path for this isolated run; the launcher proof was a fixture, not a real `ahub claude` launch.
