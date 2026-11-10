# Qwen 0.27.1 dual-output qualification

Date: 2026-11-10 (KST). Task 869, Refs #888. **Required normal-Bus Q2 and Q3/Q5/Q6/Q7 PASS on matched 0.27.0 and
candidate 0.27.1.** This receipt supports exact 0.27.1 admission for the separate
qwen-dual contract. It repeats the procedure of the
[0.27.0 receipt](2026-11-10-qwen-0270-dual-output.md) unchanged in its assertions;
read that receipt for the method, the failed controls it preserves and the
ceilings that still apply. macOS arm64 PTY, local fixture provider, isolated
homes, private package installs, no account and no real model inference.

## Upstream changes

The [v0.27.1 release notes](https://github.com/QwenLM/qwen-code/releases/tag/v0.27.1)
(published 2026-11-09) list no change to `--input-file`/`--json-file`, the
event or input line types, `session_start`, `can_use_tool` control requests or
TUI submit/cancel. The nearest entries are #16426 (prompts a Mod submits now run
in the OpenTUI terminal) and #16491 (the startup context names the active shell);
neither is exercised by the hub's input file. Shipped 0.27.1 keeps the gates the
fixture relies on: `loadSettings`/`createMinimalSettings` and the settings-path
getters in `chunks/settings-H2IQ347W.js`, `QWEN_CODE_SYSTEM_DEFAULTS_PATH`,
`QWEN_CODE_MODELS_DEV_REFRESH`, `QWEN_DISABLE_AUTO_TITLE` and
`ui.enableFollowupSuggestions` in both TUI implementations.

## Artifacts and harness

- Candidate: private `npm install @qwen-code/qwen-code@0.27.1` in a fresh
  sandboxed prefix, official integrity
  `sha512-6LmUwR8VsgsWBgyZv0ltVJjVhob/0bGiwGFmfHd+QbheaIQQ/SLF6sXD+s9EfbCXBd91SUTr0iYLPS3iEJvNnw==`,
  bin `cli-entry.js`; whole prefix 1725 entries, digest
  `393109b8721024ab122b5b431c9f67da1040de66a02896816953ed050cdc0756`. Settings
  export SHA-256 `e9948e1354becc3b7191434eeef772411002c41a49c5949a29da25f336399568`.
  The installer's kernel controls and protected before/after fence passed.
- Control: the same private 0.27.0 package the 0.27.0 receipt qualified
  (prefix 1723, digest
  `ba1c58e46b3a9bd7073befe0ea92b1c24db0b3a72519cf1c9b237d567cf80c58`, unchanged).
- Repository HEAD for every run: `ad3f1b377ff4d243646bac89a221ab20f1a5759b`
  (clean worktree, Bun 1.4.2, Node 24.18.1). It includes the #1371 deny fence,
  which the 0.27.0 runs predate; both versions here ran against it.
- Harness: task 850's producers copied to `scratchpad/temp/task869` with only
  these changes (`harness.diff`, SHA-256
  `5b8d0ea8e3de3dcb227deb4529b770080cb4fe95e4f5919b90b1fb8606410d7e`): the
  version allow-lists become 0.27.0/0.27.1, the 0.27.1 qualified prefix above is
  added, private roots are named `ahub-869-*`, and the installer targets 0.27.1
  with its official integrity. Assertions, bounds and the fixture settings are
  unchanged.
- Protected fence: the approved task 849 snapshot pins the person's
  self-updated managed Qwen version. Qwen had updated itself from 0.27.0 to
  0.27.1, so the first install attempt refused with
  `global-selector-coverage-refused` before running anything. The fence copy now
  pins managed 0.27.1 (the same seven coverage checks, all true); its SHA-256 is
  `8422a04803a2765e9903384dc67ea3897f647ca8a38ca3af575b0a6afd483ad0`.

## Results

| Observation | Control 0.27.0 | Candidate 0.27.1 |
| --- | --- | --- |
| Q2 UTC interval, 2026-11-10 | 09:18:04-09:18:09 | 09:18:18-09:18:24 |
| Q2 submit count while first response held / second envelope queued | 1 / true | 1 / true |
| Q2 second envelope delivered by Bus | true | true |
| Q2 final user / final Stop / message_stop / orphan Stop | 2 / 2 / 2 / 0 | 2 / 2 / 2 / 0 |
| Q2 first Stop < second user < second Stop | 9 < 10 < 17 | 9 < 10 < 17 |
| Q2 ordinary provider requests / message counts / user counts | 2 / 2,4 / 1,2 | 2 / 2,4 / 1,2 |
| Q2 final evidence closed, owned stop, cleanup failures | true / true / none | true / true / none |
| Suite UTC interval, 2026-11-10 | 09:19:13-09:19:49 | 09:19:53-09:20:29 |
| Q7 exact version, network guard positive control, kernel controls | PASS | PASS |
| Q3 allow / deny / TUI Enter / read-only / fixture MCP | 5 PASS | 5 PASS |
| Q3 final duplicate response count | 1 | 1 |
| Q5 unread FIFO, provider request, visible answer, native alive | PASS | PASS |
| Q6 same session, no replay, prior assistant context / old input bytes | PASS / 133 | PASS / 133 |
| Nine closed configuration checks, every case | pass | pass |
| Owned native generations, all groups gone and drains joined | 8 / true | 8 / true |
| Protected fence (count, digest), before = after | 7023, `5c1513f8...` | 7023, `5c1513f8...` |
| Whole-prefix and producer fences | unchanged | unchanged |
| requiredPassed / safetyAccepted / model calls / real account | true / true / 0 / false | true / true / 0 / false |

The protected digest is
`5c1513f8741747272f46e7f462853f984eef96ac6549afaacecbe05a0b7c6e62` in every run.
Q4 stays report-only (not run), and the direct busy-submit characterization was
not repeated; neither is a required leg.

## Retained evidence

Workspace-relative pointers under `scratchpad/temp/task869`:

| Pointer | Closed result | SHA-256 |
| --- | --- | --- |
| `install-root.txt` | private 0.27.1 install, `install-result.json` and `artifact.json` | - |
| `q2-0270-root.json` | control `q2-result.json` | `6540d79b38e768be09788ed1cb8945fc5328bd68d639641b43a2ec3dedb1ac15` |
| `q2-0271-root.json` | candidate `q2-result.json` | `f596a7fd7d0296e728db64eb8d97776a29a2882d9587368846656fbdfe580ec7` |
| `required-0270-root.json` | control `control/q3-q7-result.json` | `06b7e7faea0a409729b4186120318a518c2889f8ccbfaedb1cb7ea9b30e66395` |
| `required-0271-root.json` | candidate `control/q3-q7-result.json` | `bee0a754d5b47ca1615814b8cf75861f329123fdb10abd90ee9ac22619eaff52` |

One suite attempt on 0.27.0 refused at `private-controller-directory` before
any native start, because the wrapper had not created the controller home and
temp directories with mode 0700; it ran nothing and is not a measurement.

## Not verified

The same as the 0.27.0 receipt: real accounts and models, live dual-output TUI
use in this repository, Linux, lifetime containment, and Q4 external stop. The
headless `qwen` ACP entry is a separate contract and still refuses 0.27.1.
