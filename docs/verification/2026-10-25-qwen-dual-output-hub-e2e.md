# Qwen dual-output hub end-to-end, 2026-10-25 (#449)

- Scope: what the hub's own Qwen TUI path did against the real `qwen` 0.26.1 binary. It complements the T0 receipt (`2026-10-25-qwen-dual-output-t0.md`), which checked Qwen's protocol alone.
- Setup: the real `startDaemon`, the real `ahub qwen --mode tui` CLI (`src/cli/main.js`) run under a pty, and the real `qwen` 0.26.1 it exec'd. Qwen's model was a scripted OpenAI-compatible server on loopback (no real model, no account, no network). Every run used a scratch `HOME` and a scratch git project; the person's `~/.qwen` was not read. The probes are throwaway scripts and are not committed.
- Not covered: a real model, a real account, and the dashboard or console UI itself (approvals were answered through the control `permit` message the console sends).

| Check | Observed |
| --- | --- |
| CLI refusals | `--mode tui` without a terminal refuses ("needs a terminal"); `--mode bogus` prints the usage; `--print-command` previews the dual-output argv with no `--acp` and creates no file. |
| Launch | The CLI got the launch from the daemon and ran Qwen in the pty. Qwen's `session_start` attached the peer (idle). |
| Owner binding | Real Qwen is a `script` wrapper, a node launcher and a `cli.js` child, and all three name `--input-file`. The first version required exactly one match and never bound an owner (found by this run); it now binds the root of the tree. `holdsTerminal()` is true. |
| Delivery and answer | A published message became a `submit`; Qwen answered; the final assistant text was shared; the peer went busy then idle. |
| Approval allow | A shell command produced a `can_use_tool` request; the console got it with the command text; `permit allow` made Qwen run it (the file was created) and the turn answered. |
| Approval deny | `permit deny`: no file was created, no answer was shared, the peer went idle. The first version settled the delivery `needs_review`, which held the peer's queue (status showed `needsReview 1`, held) and wedged later messages; a deny now completes. After the fix the queue was empty and not held. |
| State dir | A shell command appending to the hub's `input.jsonl` was refused without asking the console, and nothing was written into the file. The next message was answered normally. |
| Launch environment | The CLI's exec first failed with "Executable not found in $PATH": the daemon's launch carries only the peer marker. The person's environment is now the base and the marker goes over it. |
| Adoption | The adapter was stopped while Qwen kept running (the hub's stop does not signal it). A new adapter on the same state dir adopted it from the saved offset (4262 both times), launched nothing, and processed no event twice; the next delivery worked. |
| Stall | With a model that never answered, the peer stayed busy, reported "stalled ... press Esc in the Qwen terminal", did not signal Qwen (still alive), and cleared the notice when the late answer arrived and was shared. |
| Stop | `ahub stop qwen` refused: "Qwen belongs to its own terminal". |

## A claim I checked and withdrew

- During the run, a second daemon on the same project answered "qwen is off roster" after the first one's `settings_set roster.qwen true`. I first read that as a roster bug on `origin/main` and reproduced it there. It is not one: those probes passed `config:` to `startDaemon`, an embedded config that overrides the project's local roster file. Without that option the roster persisted across a daemon restart (checked with the same two-daemon sequence). Nothing about the roster path needs changing, and nothing here depends on it. The adoption leg above drives the adapter on the same state dir because that is the unit that carries the adoption logic, not because the roster failed.
