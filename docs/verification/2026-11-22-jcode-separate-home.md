# jcode with a separate JCODE_HOME (2026-11-22)

Probe for #1627 (hub task 1073). jcode 1.0.3, run with an isolated `HOME` and a fresh `JCODE_HOME` under a scratch directory. The real `~/.jcode` was never read or written.

| Question | Result |
| --- | --- |
| Does a fresh `JCODE_HOME` work with only an `mcp.json` of the form `{"servers": {...}}`? | Yes: jcode read the server list from it. |
| Is the login shared with another home? | No. `jcode login` and `jcode auth` exist and a second home needs its own login. |
| What does init therefore write? | `mcp.json` (mode 0600) and `skills/`, no `auth.json`. It prints `JCODE_HOME='<home>' jcode login` as the person's step. |

| Does a turn need more than the login? | For a person who configured a provider, yes: the default provider and model sit in the person's own `config.toml` (`[provider]`, `[providers.*]`), which init does not copy (it also holds keybindings and hooks). The person step names it: set them in the new home's `config.toml`, or use `--provider-profile`. Observed by section names only on this machine's own config. |
| When does init switch `jcode_home`? | Not on creation: a new home has no login and switching would break a working jcode. A rerun of `ahub init` writes `jcode_home` once `<home>/auth.json` exists and the project still points at the person's own home. |

Run it yourself: `JCODE_HOME=<home> jcode auth` (any scratch home).
