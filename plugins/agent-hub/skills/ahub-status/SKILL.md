---
name: ahub-status
description: Inspect agent-hub versions, running sessions, health and peers without changing state.
---

# Hub status

Work read-only in the selected project. Run `ahub version`, `ahub status --json`, `ahub doctor --json`, `ahub roster --json`, and `claude plugin list --json`. Compare the CLI version, authenticated daemon status version, installed user plugin version and each connected Claude client's reported version. Identify peers and their states; report unavailable or absent version evidence as unknown.

List all `ahub` executables on PATH and resolve their paths, then inspect their package versions without executing an untrusted alternate. Inspect the process table for each open Claude session and its actual agent-hub `server.js` child, its parent and the loaded path. Read the plugin manifest at that path for its version. A session started before an upgrade can keep its old server; do not infer its version from the current plugin inventory or symlink. If a process or version cannot be tied to a session, say unknown. Report mismatches and doctor findings separately.

For a repair, do not run it here. Give the person one line saying what it does and why they must run it, then a separate code block with the complete command starting with `cd` to the quoted absolute project directory, all flags and actual IDs, then one line describing success. Resolve every value from current evidence; never output placeholders. If a value is unknown, find it or state what is missing instead of giving a command. Use the repair printed by doctor, and verify its applicability before presenting it.
