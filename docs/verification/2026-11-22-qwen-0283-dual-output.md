# Qwen 0.28.3 dual-output qualification

Date: 2026-11-22. macOS arm64, Bun 1.4.4, Node 24.18.1. Refs #888, hub task 1025. The required normal-Bus Q2 and account-free Q3/Q5/Q6/Q7 passed for 0.28.3 and the independently installed 0.27.1 control. This follows the [0.27.1 receipt](2026-11-10-qwen-0271-dual-output.md); the headless ACP entry is independently evidenced in the [ACP receipt](2026-11-22-qwen-0283-acp.md).

## Artifacts and fixture

Both exact packages were installed in isolated prefixes with the protected and sandboxed install described in the ACP receipt. The lockfile integrities matched npm metadata. The 0.27.1 prefix retained the prior receipt's 1,725-entry digest `393109b8721024ab122b5b431c9f67da1040de66a02896816953ed050cdc0756`; the candidate prefix had 1,806 entries and digest `d23cc403053d7b40ca51402a8beebde85af1dfb9607136ab448f489f688f6f26`.

Private copies of the existing controllers added the candidate version, its exact prefix binding and candidate settings module; assertions, bounds, Seatbelt and protected-fence logic remained in place. The committed `runQwenDualBusQ2` supplied normal Bus and driver behavior. The native PTY used an isolated home and a fixed loopback fixture provider, not a real account or model. Q3/Q5/Q6/Q7 used a hash-bound reviewed manifest and settings module. All nine closed configuration checks passed for every case on both versions.

## Results

| Observation | 0.27.1 control | 0.28.3 candidate |
| --- | --- | --- |
| Q2: submit count while first response held / second queued | 1 / true | 1 / true |
| Q2: second envelope delivered by Bus | true | true |
| Q2: final users / final Stops / message Stops / orphan Stops | 2 / 2 / 2 / 0 | 2 / 2 / 2 / 0 |
| Q2: first Stop < second user < second Stop | 9 < 10 < 17 | 9 < 10 < 17 |
| Q2: provider requests / message counts / user counts | 2 / 2,4 / 1,2 | 2 / 2,4 / 1,2 |
| Q2: final evidence closed, owned stop and unchanged fences | pass | pass |
| Q7 exact version, network positive control and kernel controls | pass | pass |
| Q3 allow, deny, TUI Enter, read-only and fixture MCP | pass | pass |
| Q5 unread FIFO and Q6 resume without replay | pass | pass |
| Required suite and safety acceptance | pass | pass |
| Fixture model inference calls / real account | 0 / false | 0 / false |

Both runs confirmed owned native group stops and joined drains; protected state, prefix and producer fingerprints stayed unchanged. Lifetime containment outside those observed groups is unproven. Q4 remains report-only, and direct busy-submit characterization is not a substitute for Q2 and was not repeated.

The control and candidate Q2 result SHA-256 values are `0a43f9610f4027250460dccc945db2674fc10122ae08172bcb7bf5ba880d8e83` and `5cbdc9e02c177d4f1a6be2507b119c8a56d47ead30a777d89745766fe2950380`; their Q3/Q5/Q6/Q7 result hashes are `9d6004c5a1869834b468a05e354247a8a1e316b537d1340517b2656592ab4ce6` and `da92e130d92bd168c14472dfdd5b3a5278f57f87a0b9e963909da3473e398220`.

Real accounts and model inference, production TUI use, Linux, lifetime containment and Q4 external stop remain unverified. No machine trust or global installation was changed.
