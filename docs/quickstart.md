# Quickstart

agent-hub lets the coding agents on one machine work as peers in one project directory: Claude Code, Codex, Kimi Code, and `local`, a worker the hub runs itself on a model you host. You talk to all of them from the hub console.

## Install

Needs [Bun](https://bun.sh) 1.3 or newer and macOS (Linux works without the `local` worker's `bash` and `git` tools, which need the macOS sandbox).

```bash
bun add -g github:STAIxBWLB/agent-hub     # installs `ahub` (also as `agent-hub`)
ahub setup                                # installs the Claude Code channel plugin from this package, then runs doctor
```

From a clone instead: `git clone`, `bun install`, `bun link`.

`ahub doctor` tells you what is installed, running and configured. Rows you do not need can stay red: the hub works with any subset of the peers.

## First session

In your project directory, one terminal each:

```bash
ahub init          # .agenthub/config.json, .agenthub/routing.toml, marker blocks in CLAUDE.md and AGENTS.md
ahub up            # the daemon for this directory (loopback only)
ahub tail          # keep open: the conversation, state changes, permission requests
ahub kimi          # Kimi, headless
ahub codex         # Codex TUI, attached through the hub
ahub claude        # Claude Code with the hub channel
```

Then talk:

```bash
ahub say "Each of you: reply with your name."      # broadcast
ahub say @kimi "run the tests and report"          # one peer
```

## The local worker

`local` needs an OpenAI-compatible gateway. Put yours in `.agenthub/config.json`:

```json
{ "omniroute": { "urls": ["http://your-gateway:20128/v1"], "api_key_file": "/path/to/key" } }
```

or set `OMNIROUTE_API_KEY`. Name the model in `.agenthub/routing.toml` (`[local] fixed_model`). Then `ahub local`. It works only inside the project, asks before it writes or runs anything (`ahub permit <id> allow`), and everything it executes is sandboxed.

## The five commands of a working day

| Command | What for |
| --- | --- |
| `ahub say [@peer] <text>` | talk; start with `[STATUS]` to let it batch, `[FYI]` for the record only |
| `ahub task propose [<class>] <title>` | put work on the board; the hub picks an owner and a reviewer |
| `ahub board` | who has what; `ahub task show <id>` for one task |
| `ahub status` | peers, queues, pauses; `ahub budget` for quota windows |
| `ahub kill` | stop the daemon and everything it started |

More: `ahub help`. How it is built and why: [`docs/specs/2026-09-19-agent-hub-design.md`](specs/2026-09-19-agent-hub-design.md). What it protects and what it does not: [`docs/security.md`](security.md).
