# Claude instruction hook probe

Hub task 1067, issue #1622 AC3. **Result: the typed, Skill, subagent and compaction cases passed on both versions.** The channel case was not driven: the clients reported that channels were unavailable. The hub-owned channel escapes a leading slash in each notification body by construction. Another plugin channel needs its own `--channels` opt-in, which hub-launched sessions do not pass; that remains a separate boundary.

The rerunnable harness is `scripts/probes/claude-instruction-hook.py`. It runs each supplied Claude binary under a new isolated HOME and Claude config, an empty project, a private tmux server and a synthetic loopback API. It uses no account or real model. The native API-key prompt was answered for the synthetic key. A private fake MCP server emitted the channel notification. The harness exits nonzero if any case fails or cannot be driven.

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
