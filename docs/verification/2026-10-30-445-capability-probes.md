# #445 C0 capability-source probes (Kimi, Qwen, Codex)

Date: 2026-10-30. Refs #445 (C0 row of the binding design, D1 "Sources, one per adapter"). Model-free probes of the native capability listings each adapter would read, run against the CLIs installed on the probe host, not the versions the card names (Kimi 2.1.x, Qwen 0.25.0, Codex pinned 0.154.0).

## Versions probed

| CLI | Version | Artifact SHA-256 |
| --- | --- | --- |
| Kimi Code (`kimi`, native macOS arm64) | 2.3.2 (served `agentInfo` `Kimi Code CLI` 2.3.2) | `d84a94c7d73405283a279348d2de78abbf31d2b1f7c92a8d739eeb40cf2a2f9f` |
| Qwen Code (`@qwen-code/qwen-code`) | 0.26.1 (served `agentInfo` `qwen-code` 0.26.1) | `cli-entry.js` `113efe4104a9fc66f507d34bfd6abbd896ceb77de47f4b468a0825a327fdc6a5` (same as the 0.26.1 ACP receipt) |
| Codex (`codex-cli`, native darwin-arm64) | 0.166.0 (initialize `userAgent` `.../0.166.0`); source tag `rust-v0.166.0` = `593389380740f7b4762771573c447ccfdc59742f` | `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1` |

## Isolation

- Every probe ran through one wrapper: `env -i` with `PATH`, `HOME`, `KIMI_CODE_HOME`, `KIMI_HOME`, `QWEN_HOME`, `QWEN_RUNTIME_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `TMPDIR`, `LANG`, `TERM` only, all homes pointing into a fresh scratch tree, cwd a scratch directory (never the repo), under `sandbox-exec` with a profile that denies all outbound IP (`(deny network-outbound (remote ip))`, checked first: a plain HTTPS fetch failed to connect).
- No auth file was copied. Where a leg needed a configured model to open a session, it used a fixture model on an unreachable loopback base with a literal non-key string (`fixture-not-a-key`), the same method as the earlier Qwen receipts. No session/prompt that starts a model turn was sent. Only builtin slash commands that the CLIs answer locally were prompted.
- Each probe was one short run (8-9 s for ACP, 3 s for Codex). The probe started the CLI in its own process group, sent SIGTERM to the group at the end, and confirmed with `pgrep -g` that the group was gone (all 7 runs: `group_gone` true). The kimi/qwen/codex process list before and after is identical, and no process referencing the scratch tree remains.
- The running agent-hub daemon and `.agenthub` state were not touched; the repo test suite was not run.
- Deviation: `kimi --version`, `qwen --version` and `codex --version` were run once on the real home before the baseline hashes were taken (version print only). Every later run used the isolated wrapper.

## Real config check (before = after)

Each file's SHA-256 was taken before the first isolated probe and after the last one; every pair matched (`diff` empty). The hashes themselves are not published, because they would fingerprint the probe host's credential and identity files.

| File | Before = after |
| --- | --- |
| `~/.kimi-code/config.toml` | unchanged |
| `~/.kimi-code/mcp.json` | unchanged |
| `~/.kimi-code/tui.toml` | unchanged |
| `~/.kimi-code/device_id` | unchanged |
| `~/.kimi-code/credentials/kimi-code-env-<id>.json` | unchanged |
| `~/.kimi-code/oauth/kimi-code-env-<id>` | unchanged |
| `~/.kimi-cu/identity.json` | unchanged |
| `~/.kimi-webbridge/identity.json` | unchanged |
| `~/.qwen/settings.json` | unchanged |
| `~/.qwen/.env` (symlink target) | unchanged |
| `~/.qwen/installation_id` | unchanged |
| `~/.qwen/oauth_creds.json` | absent |
| `~/.codex/config.toml` | unchanged |
| `~/.codex/auth.json` | unchanged |
| `~/.codex/hooks.json` | unchanged |
| `~/.codex/installation_id` | unchanged |

`~/.kimi-work` holds only a `bin/` directory (no config or auth files).


## Leg 1a: Kimi 2.3.2 ACP `available_commands_update`

Command: `kimi acp` (the hub's default `kimi_cmd`), under the isolated wrapper. Client sent the same `initialize` params as `acp.ts` (`protocolVersion` 1, `fs` read/write false, `terminal` false), then `session/new { cwd, mcpServers: [] }`.

Run A, no model configured:

- `initialize` -> `agentInfo { name: "Kimi Code CLI", version: "2.3.2" }`, `authMethods` one terminal method `login` (args `--login`), `agentCapabilities.loadSession` true, `sessionCapabilities` list/resume/close/delete/fork/additionalDirectories.
- `session/new` -> error `-32000` `"Authentication required"`. No `session/update` of any kind arrived in the 6 s that followed: without a session there is no `available_commands_update`.
- Source (installed binary, `ensureAuthed`): the gate passes when `auth.ensureReady()` resolves a configured model, or any OAuth provider reports logged in. `kimi acp` has no flag that disables it.

Run B, fixture model through Kimi's documented env model (`KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE=openai`, `KIMI_MODEL_BASE_URL` = unreachable loopback):

- `session/new` succeeded (`sessionId` `session_<uuid>`, `configOptions` model/thinking/mode, `modes` default/plan/auto/yolo).
- Right after the response, one `session/update` with `update.sessionUpdate: "available_commands_update"`.
  - Update fields: `sessionUpdate`, `availableCommands`.
  - Per command: `name`, `description`, optional `input: { hint }` (only `compact` has one). No schema, no side-effect class, no source field.
  - 14 entries in a clean home: 6 ACP builtins (`compact`, `status`, `usage`, `mcp`, `tasks`, `help`), then bundled skills (for example `check-kimi-code-docs`, `sub-skill.review`, `write-goal`). Names can contain `.`; descriptions run up to 320 chars here.
- Run C, same plus a fixture user skill at `$KIMI_CODE_HOME/skills/probe-fixture/SKILL.md`: the list gained `skill:probe-fixture`. User skills carry the `skill:` prefix; builtin-source skills and sub-skills use the bare name (matches source `buildAcpSkillSlashCommands`).
- Source: the list is re-pushed on the session's `skills.changed` event, and after `session/load`, `fork` and `resume`.

`/name` execution:

- Run B also sent `session/prompt` with text `/help`. Kimi answered locally: one `agent_message_chunk` listing the same commands, then the result `stopReason: "end_turn"`. No model turn ran (builtin path; the fixture endpoint is unreachable anyway).
- Source: a leading `/name` is routed builtin -> local text; skill name -> `agent.activateSkill({ name, args })`, a normal model turn; unknown -> a local `agent_message_chunk` "Unknown ACP command: /x" with `end_turn`, not a JSON-RPC error.

Verdict: `available_commands_update` SUPPORTED (live, fixture-configured session; refused with `-32000 Authentication required` without one). Builtin `/name` execution SUPPORTED (live). Skill `/name input` execution UNVERIFIED: it starts a model turn, which needs an authenticated account; not run.

## Leg 1b: Qwen Code 0.26.1 ACP `available_commands_update`

Command: `qwen --acp` (the hub's default `qwen_cmd`); Run B added `--auth-type openai --model fixture-model --openai-base-url <unreachable loopback> --telemetry=false` and env `OPENAI_API_KEY=fixture-not-a-key`.

Run A, no auth:

- `initialize` -> `agentInfo { name: "qwen-code", title: "Qwen Code", version: "0.26.1" }`, `authMethods` `openai` only.
- `session/new` -> error `-32000` `"Authentication required: Use Qwen Code CLI to authenticate first."` with `data.authMethods`. No `session/update` arrived in the following 6 s.

Run B, fixture auth, with a fixture user skill `probe-fixture` in the isolated home:

- `session/new` succeeded (`models`, `modes`, `_meta.generatedUi`). Then one `session/update` with `sessionUpdate: "available_commands_update"`.
  - Update fields: `sessionUpdate`, `availableCommands`, `_meta` (`availableSkills`: names; `availableSkillDetails`: name and description per skill).
  - Per command: `name`, `description`, `input` (`{ hint }`, sometimes empty, absent on some builtins), `_meta { source, sourceLabel, supportedModes, subcommands, modelInvocable, argumentHint?, altNames? }`.
  - 53 entries: 35 `source: "builtin-command"` (for example `status`, `config`, `export`), 17 `bundled-skill` (for example `review`, `simplify`, `batch`), 1 `skill-dir-command` (`probe-fixture`). `supportedModes` includes `acp` on all 53. No input schema and no side-effect class.
  - Gotcha: `modelInvocable` is not a side-effect hint. It is false for every builtin and for a few skills.

`/name` execution:

- Run B sent `/help`: JSON-RPC error `-32603` "Internal error", `data.details` "Slash command not supported in ACP integration: The command \"/help\" is not supported in this mode." (`help` is not in the advertised list.)
- Run D (same fixture, fresh process) sent `/status` (advertised, `supportedModes` includes `acp`): one `agent_message_chunk` (`_meta.source: "slash_command"`) with version/model/auth/session text, then `stopReason: "end_turn"`. No model turn.

Verdict: `available_commands_update` SUPPORTED (live, fixture auth; refused with `-32000` without it). Builtin `/name` execution SUPPORTED (live). A command outside the ACP set fails natively with `-32603` (live). Skill `/name input` execution UNVERIFIED: it is a model turn and needs an account.

## Leg 2: Codex 0.166.0 app-server

Schema: `codex app-server generate-json-schema --out <dir>` (and `--experimental`), under the isolated wrapper. The stable bundle lists 106 client request methods, the experimental one 179.

`skills/list`:

- Present in the stable schema. Params `{ cwds?: string[], forceReload?: boolean }`. Response `{ data: [{ cwd, errors[], skills[] }] }`. Each skill (`SkillMetadata`) has `name`, `description`, `path`, `scope` (`user|repo|system|admin`), `enabled`, optional `pluginId`, `interface`, `shortDescription`, `dependencies`. No input schema, no side-effect class.
- Live: `codex app-server` over stdio (the hub runs it with `--listen ws://127.0.0.1:<port>`; same protocol). Sent `initialize { clientInfo }`, then the `initialized` notification, then `skills/list { cwds: [scratch cwd], forceReload: true }`. No thread was started and no auth was needed.
  - Result: 1 entry, `errors` empty, 6 skills: the fixture `probe-fixture` (`scope: user`, path under the isolated `CODEX_HOME/skills`) and 5 `system` skills the CLI unpacks into the isolated home (for example `imagegen`, `skill-creator`, `review-agent`).
  - One unsolicited notification arrived: `remoteControl/status/changed` (`status: disabled`).
- Verdict: SUPPORTED (live).

`turn/start` input item `{ type: "skill", name, path }`:

- `TurnStartParams.input` is `UserInput[]`. `UserInput` is a `oneOf` with `text`, `image`, `localImage`, `audio`, `localAudio`, `skill` and `mention`. `skill` has properties `type`, `name`, `path`, all three required, and is in the stable schema. (`mention` has the same shape.)
- Verdict: SUPPORTED by the 0.166.0 schema. Whether a turn started with that item actually loads the skill is UNVERIFIED: it is a model turn and needs an account.

`mcpServer/tool/call`:

- Present in the stable schema. Params `{ threadId, server, tool, arguments?, _meta? }` (`threadId`, `server`, `tool` required). Response `{ content[], isError?, structuredContent?, _meta? }`. The schema says nothing about approvals.
- Source at `rust-v0.166.0` (`app-server/src/request_processors/mcp_processor.rs` `call_mcp_server_tool`, `core/src/codex_thread.rs` `call_mcp_tool`):
  - The handler loads the thread and checks only `ensure_direct_input_allowed` (refuses direct input to a multi-agent v2 subagent thread).
  - It then calls the MCP runtime's `latest_call_tool` directly. No tool-call approval request (`item/*/requestApproval`) is on that path, so the thread's approval policy does not gate the call.
  - The thread's approval policy does shape elicitations that the MCP server itself raises during the call (`tests/suite/v2/mcp_tool.rs`: `mcpServer/elicitation/request` round-trips under `unlessTrusted`; full-access threads decline form elicitation without the client capability).
- Not called live: it needs a thread and a configured MCP server.
- Verdict: the method EXISTS. "Subject to thread approvals": NO, by a source reading at the tag, not run live (UNVERIFIED live). The design excludes it either way. `command/exec` ("Execute a standalone command (argv vector) under the server's sandbox") also remains in the stable schema.

## Summary

| Source (D1) | Verdict | Basis |
| --- | --- | --- |
| Kimi 2.3.2 `available_commands_update` | SUPPORTED | live, fixture-configured session |
| Kimi builtin `/name` | SUPPORTED | live (`/help`) |
| Kimi skill `/name input` | UNVERIFIED | model turn needs an account |
| Qwen 0.26.1 `available_commands_update` | SUPPORTED | live, fixture auth |
| Qwen builtin `/name` | SUPPORTED | live (`/status`); `/help` refused `-32603` |
| Qwen skill `/name input` | UNVERIFIED | model turn needs an account |
| Codex 0.166.0 `skills/list` | SUPPORTED | live, no thread, no auth |
| Codex `turn/start` `{type:"skill",name,path}` | SUPPORTED (schema) | generated schema; live turn UNVERIFIED |
| Codex `mcpServer/tool/call` | exists; no approval gate (source) | schema + tag source; not live |

Findings that touch the frozen design:

- Neither native listing carries an input schema or a side-effect class. Kimi gives `input.hint` on one builtin, Qwen gives `input.hint` plus `_meta`. This supports O1: the class comes from the person.
- Native names include `:` (Kimi `skill:x`) and `.` (Kimi `sub-skill.review`). Both fit the D1 name regex `/^[A-Za-z0-9_.:-]{1,64}$/`. The capability id `command:skill:x` is then valid but double-prefixed.
- Builtins are mixed into the same lists as skills: Kimi `compact`; Qwen `clear`, `config`, `export`, `update`, `remember`, `forget`, `auth`. Some of these change session or host state. Kimi marks no source on its entries; Qwen has `_meta.source`. A C1 parser has to choose which entries to list.
- Kimi answers an unknown `/x` with a normal `end_turn` and an "Unknown ACP command" chunk (source), not a JSON-RPC error. Qwen answers a command outside its ACP set with `-32603`. So D3's "native rejection -> failed" holds for Qwen but needs text matching for Kimi.
- Both ACP agents refuse `session/new` without auth (`-32000`), so the listing exists only for an authenticated peer. Neither emits `available_commands_update` before a session exists.

## Not verified

- Executing a skill through `/name input` on Kimi or Qwen, and a Codex `turn/start` with a `skill` item: each starts a model turn and needs an authenticated account. Not run without one.
- Kimi and Qwen listings under a real login (a logged-in home may add user, project or plugin skills and MCP-derived commands). Only clean isolated homes plus one fixture skill were seen.
- `mcpServer/tool/call` live behavior: approval-free is a reading of the tag source, not a run.
- Kimi's unknown-command handling (source only; no unknown command was sent).
- The card's versions (Kimi 2.1.x, Qwen 0.25.0, Codex 0.154.0 pin). Only the installed versions above were probed.
- Outbound connection attempts were blocked by the sandbox profile, but not counted (the earlier Qwen receipts counted them with a Node preload guard).
- Linux and Intel macOS builds.

## Evidence fingerprints (scratch, not committed)

| Item | SHA-256 |
| --- | --- |
| `scripts/acp_probe.py` | `879ee4da9e42043ff5aa633b05aa5aef4115c2cf3c6f42dd645833d7bba196fc` |
| `scripts/codex_probe.py` | `021a8196c7d3a879a49d6703d1f369c1376b8f56150d2c6acec0043825888926` |
| `scripts/iso.sh` | `4b1bb766bcbe64d492e0d6f3f9bbf70fc2197f29cd1fc7680f240515b4ec148c` |
| `scripts/nonet.sb` | `ad9d4fdb76db3a41beb3fd5ad6557ef57e1b051663850048e51357ed46812edf` |
| `scripts/hashes.sh` | `3e100d6906a75ea23fe43e8f49bc0af1bef5ded87ec82d84231a3d419080aa37` |
| `out/kimi-plain.json` | `3a4c73d303f1ec190f6190482da50971be3652c6d8b71e765edc0b59ecd6a871` |
| `out/kimi-fixture.json` | `c29d4173c4cc53bb49ff2d50f6a584b217c828560569e2fa0d4dd5b9d588a548` |
| `out/kimi-fixture-skill.json` | `d18962889da6888eebf2c22af8e360d2b797e6be84c58fb8d2b451aa47d12140` |
| `out/qwen-plain.json` | `1c343778484440fec310ea15b197f06da7fd96308837e256eb8b2f77bb811ea9` |
| `out/qwen-fixture.json` | `3ebb27fede3f98930164a9b20d65267aa752ed4038ac77ff55e38b4ac52924a3` |
| `out/qwen-fixture-status.json` | `743e272ddbfe9002fc3c7e627d9a5e6eda31a0f2829c00ce5c9df9621af23943` |
| `out/codex-skills.json` | `70e2d6e4e4c59ff257720aa1c0f5a3e18fc4a7a761652513fa4c17d622034079` |
