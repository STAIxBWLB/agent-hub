# Bounded Python receipt-helper startup (#1248 T1)

Date: 2026-11-07. Task #775, Refs #1248. Hosted [measurement run 42361191648](https://github.com/STAIxBWLB/agent-hub/actions/runs/42361191648). Exact measurement source: `e9e10b8f1130d02dd5c9907ddc2507671a3e2d25`.

All 12 planned artifacts are present: three fresh hosted-VM jobs per OS/helper mode. Source SHA, committed helper SHA-256, flags, replicate identity, runner OS/architecture, metadata scalars and all helper/refusal outcomes validate. This follow-up selects an 8000 ms helper allowance from this complete series and the larger prior completed CI observation below.

| OS / architecture | Actual mode | Cold ms, replicates 1 / 2 / 3 | Cold max ms | Warm samples | Warm max ms |
| --- | --- | --- | ---: | ---: | ---: |
| macOS arm64 | output-check (-I) | 1067.451583 / 1435.647209 / 1578.762166 | 1578.762166 | 15 | 131.304500 |
| macOS arm64 | extract (no -I) | 1187.909083 / 1129.775667 / 2032.190459 | 2032.190459 | 15 | 101.507000 |
| Ubuntu x64 | output-check (-I) | 26.032033 / 20.150258 / 24.773280 | 26.032033 | 15 | 27.823435 |
| Ubuntu x64 | extract (no -I) | 33.736413 / 23.114327 / 34.226551 | 34.226551 | 15 | 32.182228 |

Counts: 12 cold, 60 warm, 12 refusal controls and 12 later interpreter metadata invocations, 96 total observations. Censored: 0. Errors: 0. Refusal controls: 12/12 expected exit 2. No failed or censored observation was dropped.

## Binding and procedure

- Output check uses the exact committed `write-output.py` with production `-I` and an inherited owned directory capability at FD3. The occupied-output refusal is unchanged.
- Extraction uses the exact committed `extract-archive.py`, without `-I` as production does. Node zlib creates the tiny public regular-file ustar before the first Python execution; the traversal archive is a separate refusal control.
- No Bun/npm installation, setup-python, native agent, account, model, or interpreter metadata probe precedes the first helper. Warm samples and refusal controls precede the interpreter metadata invocation.
- The controlled launcher records its first Python invocation; no claim is made that the OS/image caches were absolutely cold. Each child has a 15000 ms measurement ceiling and 4096-byte output cap. A timeout would remain right-censored; none occurred.

| Helper | SHA-256 at measured commit |
| --- | --- |
| output-check | `a6e056a59506922d4e15765495cec6e15cc33568ad6fdf90f5cc30c7b344217b` |
| extract | `7daf837943d279f2e72ca7e03cc8e6ea3c0bc9ab1eda6db738f20d57045c7eb3` |

| OS | Interpreter | Runner image |
| --- | --- | --- |
| darwin | CPython 3.9.6 | macos15 20261104.0514.1 |
| linux | CPython 3.12.3 | ubuntu24 20261101.360.1 |

## Eight-second sizing tradeoff

The complete series has maximum cold time 2032.190459 ms (macOS extractor replicate 3). The separately recorded completed CI extractor sample remains larger: 3835.40 ms in [run 42355168440](https://github.com/STAIxBWLB/agent-hub/actions/runs/42355168440), macOS shard 1/4; it is not one of these 12 samples and is not discarded. Twice that known completed sample is 7670.80 ms. The selected 8000 ms helper allowance is 2.0858 times that prior sample, leaving 4164.60 ms beyond it.

The direct output-check maximum is 1578.762166 ms; using the larger extractor tail to size output-helper startup is a conservative shared-interpreter allowance, not a claim that the writer itself took 3835.40 ms. Both helper modes were measured explicitly.

Keeping two individually bounded output operations means `RECEIPT_OUTPUT_MS = 16000` ms. Existing controller aggregation includes that value automatically, increasing its advertised worst-case output allowance by 12000 ms from the former 4000 ms. The production 180000 ms installation allowance remains unchanged. Only the archive test fixture reuses one helper allowance for both totalMs/installMs.

Eight seconds reduces false timeout risk at the cost of allowing a genuine helper hang to block up to eight seconds per operation, rather than two. The finite timeout, kill/reap behavior, FD/no-follow, collision, ownership, integrity and explicit timeout assertions must remain intact. No unbounded warm-up is proposed. Three cold samples per cell do not estimate a statistical p99 or guarantee all future runner tails.

All 12 records were reviewed before the bound changed. The temporary measurement workflow was restored in `c4a40cee`, before normally merging origin/main at `3e27f16c`. The permanent measurement module remains callable; the scheduled compatibility workflow is unchanged by this follow-up. No package, real home, account, model, machine trust or agent CLI was installed or used. This receipt is not a native compatibility qualification.

## Regression checks and evidence limits

The output test retains every FD, ancestry, collision, no-follow and content assertion and changes only the exact total-budget contract from 4000 to 16000. A temporary helper uses `exec /bin/sleep 3` to exceed the former two-second allowance and finish. A second uses `exec /bin/sleep 60`; the actual eight-second spawnSync timeout must report `timeout`, reap that same owned helper process and publish no output. Both tests retain an explicit 20-second outer hang guard. No forked background helper is created. The generic npm fixture remains at 3000 ms installation budget; explicit timeout and archive-integrity controls are unchanged.

Committed-head DGX checks and hosted CI are separate from the measurement run and are reported at their tested SHA in the task/PR. They are not inferred from these hosted timing observations. No verified stamp is refreshed.

Per-observation elapsed/censor/outcome/exit fields are retained in the hosted per-job `measurement/result.json` artifacts and the workspace-local `task775-measurement-e9-complete/validated-complete.json` projection. No raw helper stdout/stderr, private paths or environment values are included in this report or the validated projection.
