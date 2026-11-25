# Codex 0.172.0 fresh-reviewer model-free receipt

Date 2026-11-25. Refs #888, hub task 1119. The production preparation legs from the [0.171.0 receipt](2026-11-22-codex-0171-reviewer-isolation.md) ran on macOS arm64 with Bun 1.4.4 at hub source commit `87239bd0357f3b8929ffc6b61fab89c0fb95f0d3`.

The candidate passed all 17 runnable preparation legs. The verified 0.169.0 control passed all 16 applicable legs. **0.172.0 remains unverified for `codex-review` pending a separately authorized model-backed hub tool-call receipt.**

## Artifact and preparation

Exact macOS arm64 npm platform archives were downloaded and checked against the registry's per-artifact SHA-512 integrity values. The archives were extracted into private prefixes. The 0.169.0 native binary hash matches the previous receipt. Both binaries reported their exact versions and retained their hashes after preparation and schema generation.

| Version | Platform archive SHA-512 | Native binary SHA-256 |
| --- | --- | --- |
| 0.169.0 control | `sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==` | `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002` |
| 0.172.0 candidate | `sha512-B239wE7pGeOmjylfqLymDIwuL4QgQR7pQZc5phHpZ3t8UVkno9AS3dNPEprm7AzZHw3kf2I6Uf+uOFfjGegELQ==` | `f30a99714dc984876864239ef60563949b1e21421a7c9180422f51fd39186bc6` |

A scratch producer called the committed `runReviewerProofs`, `codexReviewerBackend.prepare` and bounded command runner. It ran the two versions serially with empty inherited environments, separate `HOME`, `AGENTHUB_HOME`, `CODEX_HOME`, `AMEM_HOME`, `XDG_CONFIG_HOME` and `TMPDIR`, and an explicit PATH. The candidate was refused by the unmodified version gate before the producer recorded temporary exact-version trust in the scratch hub home. The producer removed its trust entries.

Both binaries passed empty-home and ambient preparation and all 14 preparation attestation markers. Those markers cover effective MCP inventory, disabled Apps, plugins, hooks and legacy notify, ephemeral and untrusted project settings, and the production native read/write canaries. The fixture exercised these controls without model requests or account credentials.

## Upstream source comparison

The 0.169.0 annotated tag `a41fe5b443652cbdbee57717fbb9fd78d8d8b32a` peels to `d32063f96c2dff1dc96af839b3952abb6acfeda4`. The 0.172.0 annotated tag `fc3036dba44468096953f0e832f3fecd3adc0228` peels to `3d86e43b075adeba2193ec5c22ac92f55afd82e6`. All seven files from the earlier receipt changed between those commits.

| File under `codex-rs/` | 0.172.0 SHA-256 |
| --- | --- |
| `hooks/src/registry.rs` | `1875149dc3fbe79ecf667009f3fcde7b655961b0451840aec85dcb7879e58a8e` |
| `exec/src/cli.rs` | `dc36955d295470e542e9677dddf8b757f8d3bbcd6530a601dbb908aeec2d1668` |
| `config/src/mcp_types.rs` | `f9f4c78f71356114ff8286a88404d6426d0ba9ae5c71785da9d66437870839b6` |
| `core/src/mcp.rs` | `375eb941051e14976641b10e6fadd050f229f320ad7bd6e8753264033a0deed9` |
| `sandboxing/src/seatbelt.rs` | `f9f3ea86088ff3787ad7fdd5a746e79243851fb17fd38ef386388e849d171625` |
| `core/src/session/mod.rs` | `015d1a96f2d6003e67f7f79c57c32853dab8ac5c9e64605c39cf9e2283c86189` |
| `core-plugins/src/manager.rs` | `3f72e7bf1891dfb9f81aa3997447e76d756f35993b51ba3ca1bb0bedfd45c7dd` |

The hook registry now returns a model-request hook outcome and accepts a completion callback. Exec adds remote connection flags that the hub's isolated preparation does not pass. MCP runtime configuration now accepts a contribution context, and server identity carries environment scope. The reviewed session and plugin paths retain the Apps guard, legacy notify assignment and plugin disable guards. Seatbelt preparation moves behind a sandbox backend and consumes a resolved permission profile. This comparison reviewed the small hook, CLI and MCP diffs and relevant regions of the larger Seatbelt, session and plugin diffs. The wider impact of the source changes remains open, including behavior during a model turn.

## App-server schemas

Both binaries generated their stable and experimental JSON schemas in their isolated homes. The comparison covers files and top-level v2 definitions with direct properties, required fields and enums.

| View | Files | Shared files changed | v2 definitions |
| --- | --- | --- | --- |
| Stable | 329 to 331 | 38 | 700 to 716 |
| Experimental | 479 to 483 | 55 | 864 to 885 |

The stable set removed no files. The experimental set removed the standalone `CurrentTimeReadParams.json` and `CurrentTimeReadResponse.json` files. Neither v2 bundle lost a top-level definition. Both removed the same five direct properties from the control schema. These were `AgentMessageDisplay.action`, `blockType`, `checkTrustedContacts`, `cyberTrustedAccess` and `Project.position`. No new direct required field or removed direct enum value was observed.

The attached app-server adapter and verdict delivery remain outside the preparation evidence. The verified list and admission receipt pointer stay at their existing versions.
