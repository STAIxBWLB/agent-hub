---
name: ahub-status
description: Inspect agent-hub versions, running sessions, health and peers without changing state.
---

# Hub status

Work read-only in the selected project. Run `ahub version`, `ahub status --json`, `ahub doctor --json`, `ahub roster --json`, and `claude plugin list --json`. Compare the CLI version, daemon `version` in `ahub status --json`, installed user plugin version and each connected Claude client's reported version. Identify peers and their states; report unavailable or absent version evidence as unknown.

List all `ahub` executables on PATH and resolve their paths, then inspect their package versions without executing an untrusted alternate. Inspect the process table for each open Claude session and its agent-hub `server.js` child and parent. For a session attached to this hub, read `peerVersions.<peer>.ahubTools` in `ahub status --json` for the connected tools client's version. Match the peer and session; if multiple versions prevent a match, report unknown. For any other session, compare the server process start time with the installation time of the directory its path currently resolves to. If the process started earlier, it runs an older build; identify that build only when the previous installation can be established, otherwise report its version unknown. A current symlink's manifest cannot establish a surviving process's loaded version. Report mismatches, unknowns and doctor findings separately.

For a stale session, give the person a step to restart that Claude session with the hub launcher: inspect `ahub help claude`, retained work and any recovery state first, then produce the actual launcher or resume command for that session. The person runs it because restarting their session is an operator action. Success is a reattached session whose reported tools version matches the intended installation; if that cannot be observed, say unknown.

For a repair, do not run it here. Give the person one line saying what it does and why they must run it, then a separate code block with the complete command starting with `cd` to the quoted absolute project directory, all flags and actual IDs, then one line describing success. Resolve every value from current evidence; never output placeholders. If a value is unknown, find it or state what is missing instead of giving a command. Use the repair printed by doctor, and verify its applicability before presenting it.
