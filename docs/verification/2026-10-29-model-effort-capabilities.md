# Model and effort capability receipt (#266 AC1)

Date: 2026-10-29. Scope: configuration/control capability verification only,
under task 430. Source baseline: `88e38f3d`. No runtime policy is implemented.
The native binaries were Codex 0.165.0, Claude Code 2.1.312 and Kimi 2.3.2.

## Isolation and evidence boundary

Each native invocation received a separate empty HOME and separate
CLAUDE_CONFIG_DIR, CODEX_HOME, KIMI_CODE_HOME and XDG roots, plus a scratch cwd.
The child environment contained no real account credentials or inherited
provider/gateway overrides. macOS Seatbelt denied network access. No real
account/provider config was copied, no login/update/config-write command was
used, and runtime model/effort choices were confined to the isolated process.
One native worker ran at a time under the resource policy.

This receipt retains counts, versions and fixed outcomes only. No input/output
text, credential, endpoint, native session/launch id or usage data is included.
Setter/readback success is frontend state evidence, not a served-model receipt.
Every invocation leader exited or was explicitly terminated and reaped; this is
not a native sandbox or real-account certification. Nine owned temporary fixture roots were
removed after capture. This does not change a native compatibility pin or
establish an adapter T0 receipt.

## Call inventory

| Operation | Native invocation count | Outcome |
| --- | ---: | --- |
| Version | 3 | all exit 0 |
| Root/subcommand help | 6 | all exit 0 |
| Codex installed experimental schema generation | 1 | exit 0; 460 JSON schema files |
| Codex protocol sessions | 2 | initialize/config/thread/turn controls below; both reaped |
| Claude print/control sessions | 3 | control-only exploration and final status/readback below; all reaped |
| Kimi ACP session | 1 | initialize success; session creation refused; reaped |
| Total | 16 | sequential, bounded, no completed provider turn |

These totals are controller-run accounting across the entire authorized probe
sequence, including three subcommand-help calls and two preliminary Claude
invocations. The selected final capability outcomes below do not imply that the
preliminary ACKs proved effective settings.

| Protocol process | Sent messages | Observed messages | Outcome |
| --- | ---: | ---: | --- |
| Codex launch/config/thread | 4 | 5 | config readbacks matched |
| Kimi initialize/new | 2 | 2 | initialize passed; new refused |
| Claude preliminary model control | 2 | 3 | ACKs observed; exact alias echo was not an effective-model proof |
| Claude preliminary effort exploration | 4 | 9 | ACKs observed; exact-text status matcher did not classify the readback |
| Claude final session controls | 5 | 12 | launch/session effort and selected model-family readbacks verified |
| Codex bounded turn/interrupt/resume | 7 | 21 | frontend sticky readbacks verified; turn interrupted |
| Total | 24 | 52 | counts only |

The sent total includes two initialization notifications and five local Claude
slash-command messages. The final Claude process checked effort before changing
model and parsed the status value rather than requiring an exact alias/text echo.
The three subcommand-help calls (Codex app-server, schema generator and Kimi ACP)
all exited 0. Earlier exploration is included in the inventory rather than hidden
or counted as an additional provider proof.

## Sanitized outcomes

| Native | Operation | Outcome |
| --- | --- | --- |
| Codex 0.165.0 | initialize | success |
| Codex | launch config read | requested model match; requested effort match |
| Codex | thread override readback | requested model match; requested effort match |
| Codex | model catalog | success; 9 entries |
| Codex | turn override | accepted |
| Codex | bounded interrupt | success; no completed provider result observed |
| Codex | no-override resume | requested replacement model match; replacement effort match; permission unchanged; sandbox unchanged |
| Claude Code 2.1.312 | initialize with launch model/effort flags | success |
| Claude | launch effort status | requested level match |
| Claude | session effort setter and status | success; requested level match |
| Claude | session model control | success; model field returned; requested model-family match |
| Kimi 2.3.2 | initialize | success |
| Kimi | new session | RPC error -32000; selected models/options/readbacks unknown |

The installed Codex schema describes `turn/start.model` and `effort` as defaults
for subsequent turns too. `ReasoningEffort` is a nonempty string here, not a
closed global enum; the model catalog advertises supported options per model.
Claude native help advertises launch model/effort, while its local effort status
and model control provided configuration readback. No provider answer followed
any of these checks. The Kimi refusal must not be relabeled unsupported; this
receipt neither changed its config nor supplied an account to get past it.

## Hub wiring and remaining proof

At the source baseline, the hub's Codex-created turn contains no model/effort
setter, even though native/TUI fields can pass through. Claude's declared writer
model is a launch argument for each child; production closes its input stream
and has no session-setting sender. Kimi has a launch-model argument and native
permission-mode handling, with no model/effort setter or effective-model reader.
A requested launch alias in recovery metadata is not a provider-serving model.

Actual provider application for every vendor, Kimi session-level model/graded
thinking readback, real interactive/account behavior, and matrix execution are
**UNVERIFIED**. Task/role exec, mapping, routing policy, ladders and budgets remain
later slices. A future setting path must not change permissions or sandbox and
must refuse an unsupported/unverified mapping rather than silently ignore it.

## Sources and reproduction

The [spec capability table](../specs/2026-09-19-agent-hub-design.md#vendor-model-and-effort-controls-266-ac1)
and [smoke procedure](../smoke.md#model-and-effort-capability-verification-266-ac1)
are the entry points. Native help, installed generated schema and filtered
control outcomes are the version-bound observations; raw native output is not
part of the checked-in receipt.

Corroborating primary sources, consulted 2026-10-29:

- [OpenAI app-server](https://learn.chatgpt.com/docs/app-server): turn overrides,
  subsequent-turn defaults and per-model advertised effort options.
- [Claude model configuration](https://code.claude.com/docs/en/model-config):
  launch and session model/effort controls, with later-message effort semantics.
- [Claude SDK model setter](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py):
  the model control request shape.
- [Kimi command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)
  and [ACP coverage](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp):
  launch model and documented session model/thinking controls.
- [Kimi graded ACP effort report](https://github.com/MoonshotAI/kimi-code/issues/1486):
  an open report about boolean collapse, not this receipt's proof of installed
  graded-effort support. A thinking toggle is not a verified graded setting.

Moving upstream documentation cannot certify another binary or a real provider.
