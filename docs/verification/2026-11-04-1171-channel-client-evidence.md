# Channel client evidence for #1171

## Scope

This investigation checked the installed first-party Claude Code 2.1.318 artifact and read process metadata on macOS on 2026-11-04. It did not start a model session, modify a running client, capture a live MCP handshake, or establish that a particular notification reached a model.

The artifact was the existing native installation at `~/.local/share/claude/versions/2.1.318`. Its embedded build metadata names Git revision `ca1fa9dea62c1027756786c841c548788644560d` and build time `2026-11-03T18:52:53Z`.

## Client initialization and channel registration

The inspected stdio MCP client construction passes capabilities through `_Xt`, `pOn` or `uOn`, and `W`. That path builds roots/list-change and elicitation capabilities, with conditional MCP application extensions. The inspected path contains no channel-specific client capability or flag-dependent channel opt-in field.

Channel registration is a separate path. It checks the server's channel declaration, protocol compatibility, provider and organization policy, and the session's selected channel entries. A generic MCP client capability therefore cannot establish that this session opted into this channel. This is a bounded observation about these paths in 2.1.318, not a claim about every client version.

The [official channel reference](https://code.claude.com/docs/en/channels-reference) describes the channel capability as a server declaration. It also documents the development flag as interactive-only; print mode ignores that flag. No usable client initialization signal was found in the inspected artifact and reference.

## Direct-parent fallback

The existing `claudeNativeLaunch` implementation prepends the development-channel flag and a selected exact target before native passthrough arguments. The target is normally `plugin:agent-hub@agent-hub`; its existing matching MCP configuration path can select `server:agent-hub`.

A passive process observation corroborated this layout for the running native TUIs: process 10310 and several other observed TUIs had the exact known flag/target prefix. The observed background daemon, process 17739, did not. Two other Claude process rows exposed only the process name, which cannot establish support. The observation emitted only identifiers and classification results, without retaining command bodies, paths or prompts.

The proposed fallback was communicated to the reviewer before implementation: require the existing launcher marker together with bounded evidence from the direct parent's actual invocation. An inherited marker alone is insufficient. Unknown process metadata must remain tools-only. Searching an arbitrary command substring would be unsafe because a prompt or an option value can contain the same flag text.

The flag evidence has a deliberate ceiling: it establishes the inspected launch form, not organization policy, user confirmation, protocol registration or model consumption. Unrecognized launch forms must remain pull-only. The separate #1172 settlement work is needed for notifications that are accepted by the transport but never confirmed by the session.

## Verification boundaries

Synthetic fixtures must distinguish an inherited marker without parent evidence from the supported launcher form, and keep the former's messages readable through `hub_inbox`. Negative cases include print/background forms, repeated or misplaced flags, unknown targets and unavailable process metadata. Status must expose a closed evidence value, never command text.

Source tests, the committed-head remote gate, hosted CI and native message-consumption receipts are separate evidence. This investigation supplies no native delivery receipt.
