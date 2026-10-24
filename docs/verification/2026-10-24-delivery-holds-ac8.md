# Live receipt of hub-settled held deliveries and peer retries (#434 AC8)

Live evidence for issue #434 AC8 collected from `.agenthub/state/hub.db` and daemon CLI readbacks on 2026-10-24. AC1–AC7 were merged in PRs #440, #448 and #578. This document records IDs, revisions, counts and timestamps only, with no message text.

## Result

- **Leg 1 (Hub-settled held deliveries):** Evidenced. 39 rows recorded in `resolution_history` with `actor = 'hub'` and `action = 'completed'`, all representing automated settlements of superseded notices across peers `claude` and `codex-review`.
- **Leg 2 (Peer retries and retry evidence):** Evidenced. 2 peer retry rows recorded in `resolution_history` (`actor = 'peer:claude'`, `action = 'retry'`), and 27 rows recorded in `delivery_retry_evidence` across peers `claude` (18), `jcode` (8), and `kimi` (1).
- **Daemon readbacks:** Captured `ahub status` (daemon 0.15.0 active on control port 4600) and `ahub queue` (both honest agent refusal and queue status snapshot).

## Leg 1: Hub-settled held deliveries

Query:
```sql
SELECT r.id, r.delivery_id, r.peer, r.actor, r.action, r.reason,
       r.observed_revision, r.result_revision, r.result_state,
       r.original_ids, d.created_at, d.updated_at
FROM resolution_history r
LEFT JOIN deliveries d ON r.delivery_id = d.id
WHERE r.actor = 'hub' AND r.action = 'completed'
ORDER BY r.id;
```

Total count: 39 rows.

Summary by peer:
- `claude`: 19 rows
- `codex-review`: 20 rows

Distinct reason categories:
- Superseded review moved notices: 20 rows (tasks #120, #307, #317, #343, #362, #367, #391, #405, #406, #407, #408, #409, #410, #411)
- Superseded task approved notices: 20 rows (tasks #113, #199, #202, #236, #238, #245, #267, #271, #272, #273, #302, #343, #368, #383)
- Row 82 carries both reasons, so it counts in both categories.

| ID | Delivery ID | Peer | Action | Reason | Observed Rev | Result Rev | Result State | Created At (epoch ms) | Updated At (epoch ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | `6d1dabf0-0e7a-4dc4-b276-31236001d3e7` | claude | completed | superseded: task #245 approved | 9550 | 9557 | completed | - | - |
| 42 | `311b138a-7c67-4e55-b964-430cb28d134a` | claude | completed | superseded: task #236 approved | 10450 | 10457 | completed | - | - |
| 43 | `e9e94cc6-761d-4df9-89bd-970ea01b8777` | claude | completed | superseded: task #202 approved | 10451 | 10459 | completed | - | - |
| 55 | `63f60bcf-88c5-4157-a829-ca86384ca091` | claude | completed | superseded: task #273 approved | 10917 | 10928 | completed | - | - |
| 56 | `5d1adc89-900e-40d6-a8c4-7397264e0435` | claude | completed | superseded: task #267 approved | 10918 | 10930 | completed | - | - |
| 57 | `7854b544-5e6b-4b8f-bd17-06af3dcf0139` | claude | completed | superseded: task #273 approved | 10919 | 10932 | completed | - | - |
| 58 | `ffc88bfb-be43-49de-b71f-989aa3d42b56` | claude | completed | superseded: task #272 approved | 10920 | 10934 | completed | - | - |
| 59 | `d844954d-fa8b-4e3c-9648-8eedb862126d` | claude | completed | superseded: task #272 approved | 10921 | 10936 | completed | - | - |
| 60 | `332b6cba-8bbd-4ae5-bb69-f0270377e22b` | claude | completed | superseded: task #271 approved | 12987 | 12990 | completed | 1792545979266 | 1792611635109 |
| 61 | `a46fa9df-3ce4-46bd-b371-50bddbf1c991` | claude | completed | superseded: task #302 approved | 13826 | 13836 | completed | 1792623040581 | 1792632313095 |
| 71 | `f2978d0e-e721-4762-88d6-cbf2dce6e4d2` | claude | completed | superseded: task #199 approved | 16199 | 16212 | completed | 1792633725600 | 1792707673174 |
| 72 | `a8b684cf-5ec2-412a-b1c9-9cab80a2abdd` | claude | completed | superseded: task #368 approved | 16200 | 16214 | completed | 1792636027148 | 1792707673748 |
| 73 | `ec7ba4a9-7711-4793-a48e-50178bbea407` | claude | completed | superseded: task #238 approved | 16202 | 16216 | completed | 1792673774838 | 1792707674312 |
| 75 | `00e42d5a-4025-4a74-81d8-1b4a4319d75f` | claude | completed | superseded: task #113 approved | 17300 | 17311 | completed | 1792717036914 | 1792731834168 |
| 76 | `840b6b5a-218f-4f59-ac84-a9758c128b5c` | claude | completed | superseded: task #383 approved | 17406 | 17409 | completed | 1792723380061 | 1792732958999 |
| 77 | `a5c2d3ca-5efb-410a-8bf8-0eb88f9a2b5b` | codex-review | completed | superseded: task #391 review moved | 18512 | 18516 | completed | 1792764956503 | 1792765089338 |
| 78 | `0c3132cf-561b-4171-897b-68d83935ec61` | codex-review | completed | superseded: presence; task #120 review moved | 18569 | 18573 | completed | 1792766023588 | 1792766107384 |
| 79 | `bca279a0-6ce3-448a-a63e-f14d878ea30a` | codex-review | completed | superseded: task #317 review moved | 18721 | 18725 | completed | 1792767098495 | 1792767215264 |
| 80 | `47b252ce-5100-47d0-8cb4-23a7bbd38bf3` | codex-review | completed | superseded: task #343 review moved | 18880 | 18884 | completed | 1792770281363 | 1792770339943 |
| 81 | `e5bc68fc-9f79-4d69-be5a-bc8499c75bf6` | codex-review | completed | superseded: task #405 review moved | 19280 | 19284 | completed | 1792806254483 | 1792806323145 |
| 82 | `32b2da11-8255-4424-9b88-1be25f20f011` | codex-review | completed | superseded: task #120 review moved; task #343 approved | 19343 | 19347 | completed | 1792807212479 | 1792807284646 |
| 83 | `f7ca1953-2947-4188-b26a-9359e19d7a22` | claude | completed | superseded: task #343 approved | 19356 | 19363 | completed | 1792770632001 | 1792807353138 |
| 84 | `2a255963-39d6-4444-9351-be40c03c5ae9` | claude | completed | superseded: task #343 approved | 19357 | 19365 | completed | 1792771569426 | 1792807353716 |
| 85 | `e2a05e26-f726-4a46-b633-8991bceeb11d` | claude | completed | superseded: task #343 approved | 19358 | 19367 | completed | 1792773205777 | 1792807354291 |
| 86 | `ea242ca1-c4d3-4f9e-8ff4-bf9fbb6b3ffb` | claude | completed | superseded: task #343 approved | 19359 | 19369 | completed | 1792777170138 | 1792807354876 |
| 87 | `9e559591-23d1-4191-8176-e13711d9f4e2` | codex-review | completed | superseded: task #410 review moved | 19508 | 19512 | completed | 1792810119681 | 1792810191086 |
| 88 | `b56dc79b-38a4-4f8d-be9c-21ac897a06dc` | codex-review | completed | superseded: task #410 review moved | 19558 | 19562 | completed | 1792810477810 | 1792810549280 |
| 89 | `0cc7bff2-07a6-4fed-b418-7329dce5b5c0` | codex-review | completed | superseded: task #120 review moved | 19602 | 19606 | completed | 1792811734528 | 1792811810101 |
| 90 | `2b0a8cba-f2e2-4386-baf3-96a0c0fd74cf` | codex-review | completed | superseded: task #307 review moved | 19638 | 19642 | completed | 1792812394516 | 1792812484042 |
| 91 | `4396b8f1-0244-482a-8ead-83e6530c815b` | codex-review | completed | superseded: task #409 review moved | 19768 | 19772 | completed | 1792813838541 | 1792813905267 |
| 92 | `69277fb5-35ee-4eae-83e1-024a212084d7` | codex-review | completed | superseded: task #408 review moved | 19888 | 19892 | completed | 1792817545648 | 1792817592012 |
| 93 | `f93b2128-f484-4315-95a4-4000320cfd5b` | codex-review | completed | superseded: task #409 review moved | 19922 | 19926 | completed | 1792818208498 | 1792818255247 |
| 94 | `deeb38d5-2b80-4e00-8670-77b18a0d734a` | codex-review | completed | superseded: task #407 review moved | 19981 | 19987 | completed | 1792818319041 | 1792818376775 |
| 95 | `502bc163-5402-4555-9624-779455927c8f` | codex-review | completed | superseded: task #406 review moved | 20034 | 20038 | completed | 1792818734567 | 1792818774051 |
| 96 | `bbdb8cc4-683b-4599-a55d-6a67042af2c1` | codex-review | completed | superseded: task #407 review moved | 20104 | 20108 | completed | 1792818984020 | 1792819038495 |
| 97 | `0398cef2-81bb-4a35-9db5-527354c13a1f` | codex-review | completed | superseded: task #362 review moved | 20192 | 20196 | completed | 1792821436652 | 1792821515862 |
| 98 | `acc465f1-a4a7-4c08-824d-8cad246c21e4` | codex-review | completed | superseded: task #411 review moved | 20384 | 20388 | completed | 1792825648154 | 1792825731015 |
| 99 | `19815686-118e-440a-8e74-e9168cf09c7e` | codex-review | completed | superseded: presence; task #367 review moved | 20478 | 20482 | completed | 1792829816207 | 1792829953436 |
| 100 | `c5d72139-becd-4efd-84aa-93727f26e1c8` | codex-review | completed | superseded: task #307 review moved | 20570 | 20574 | completed | 1792831304320 | 1792831369674 |

## Leg 2: Peer retries and delivery retry evidence

### Resolution history peer retries

Query:
```sql
SELECT r.id, r.delivery_id, r.peer, r.actor, r.action, r.reason,
       r.observed_revision, r.result_revision, r.result_state,
       r.original_ids, d.created_at, d.updated_at
FROM resolution_history r
LEFT JOIN deliveries d ON r.delivery_id = d.id
WHERE r.actor LIKE 'peer:%' AND r.action = 'retry';
```

Total count: 2 rows.

| ID | Delivery ID | Peer | Actor | Action | Reason | Observed Rev | Result Rev | Result State | Created At | Updated At |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 44 | `bac5f601-0a40-40ca-bc33-2b322786ef3f` | claude | peer:claude | retry | recipient requested one uncertain redelivery | 10449 | 10463 | failed | - | - |
| 74 | `e93041db-aa3f-4add-bb9a-6f0bdd4a49a0` | claude | peer:claude | retry | recipient requested one uncertain redelivery | 16201 | 16249 | failed | 1792672086395 | 1792708295642 |

### Delivery retry evidence table

Query:
```sql
SELECT project_id, peer, original_id, proof_id, warning
FROM delivery_retry_evidence
ORDER BY peer, original_id;
```

Total count: 27 rows.

Counts by peer:
- `claude`: 18 rows (10 warning, 8 non-warning)
- `jcode`: 8 rows (0 warning, 8 non-warning)
- `kimi`: 1 row (0 warning, 1 non-warning)

| Project ID | Peer | Original ID | Proof ID | Warning |
| --- | --- | --- | --- | --- |
| `p_0afc219a423f4abb476a346b` | claude | `04ba3917-0114-4817-a08e-24aa5aeb2235` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `2435c0f1-9eee-4de0-87ba-5beef5c2f3d6` | `bac5f601-0a40-40ca-bc33-2b322786ef3f` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `2d0d63eb-8225-4a00-8f58-0e133e0e8afa` | `e93041db-aa3f-4add-bb9a-6f0bdd4a49a0` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `38af66af-9de5-4747-b2f5-f743d0152f4e` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `47e7187e-4ae6-4cb5-9430-73a439a53b2e` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `4eef920f-4071-48cd-befc-d8f0786b429f` | `34989d5f-91f5-4229-aa57-a24f907b8579` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `53f3aacc-6e8c-44ea-8950-dcc6611ae81f` | `9868d37c-a074-4a5f-8dfb-ed57b7c5dece:retry:1` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `5ba85330-7531-4202-91a5-5a0fd2389b9b` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `8b1ec4f5-3148-44fc-83f6-2464c9a63e5a` | `561b7945-b513-4d51-9ab6-6f3b493ff879` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `a1961c24-5514-4616-85b1-e136aad3839d` | `bac5f601-0a40-40ca-bc33-2b322786ef3f` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `bbd7cb90-1459-4f76-88df-56225915cb56` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `ccf59013-46b6-4076-a2be-247581f95813` | `9b498481-ef64-4bd0-8c40-c27b14292b52` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `cebc507c-703a-4922-8302-3bff9c7c4de6` | `03ce737d-108f-4e39-83ce-356417f2a9d4` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `d569be23-5aa5-4a14-bd1a-3b82e0afd70a` | `2593f2cc-1ae2-4e2b-9c0b-9ce42af38434` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `d60f23f6-bc62-4f59-904c-a72d39af5d4f` | `7f729253-19d6-4c89-95e7-70aeeb270fbc:retry:1` | 0 |
| `p_0afc219a423f4abb476a346b` | claude | `da0bab7a-1a87-4bcb-af7c-b7cc105c5959` | `e29af6c9-cfae-4adf-9bdc-1c47b7682b91` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `e9bcc3b8-a8b9-4abb-a516-3562666695b6` | `932d40ee-b48f-4469-b3a8-29e76a0f544d` | 1 |
| `p_0afc219a423f4abb476a346b` | claude | `f38b1e54-3cbb-49fd-9899-823df54475eb` | `ac82560b-42c1-4065-8b3b-f3d09dc146ab` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `0929dca7-1beb-405b-8d05-54da9d1e2a52` | `a40791a5-7fbe-4f8d-831e-50884f27c549` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `74075a33-5419-48ee-8bed-130bb73b0f83` | `a40791a5-7fbe-4f8d-831e-50884f27c549` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `80b383a8-685c-4646-bc2d-fce5e8d1af35` | `63f42c34-360a-489c-8b46-d6845a59d51d` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `957748a4-6300-4bfc-a7a2-f11eae1644e0` | `f6b775a7-ced0-4ee1-99a9-e960ae30604f` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `9a0f40a2-e758-4f9a-a227-1d825b23e888` | `3474c3f7-4b99-4446-a90f-b3282052a495` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `a84a651a-57fa-41b5-a897-777ef1e46614` | `63f42c34-360a-489c-8b46-d6845a59d51d` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `a8f3f51a-01f4-472f-9c29-1b95a8ca24fc` | `9d9793b1-36f7-4d53-9f77-a05eb12468a4` | 0 |
| `p_0afc219a423f4abb476a346b` | jcode | `f6648a12-3490-47aa-8730-9a49db76e9db` | `a40791a5-7fbe-4f8d-831e-50884f27c549` | 0 |
| `p_0afc219a423f4abb476a346b` | kimi | `9b94929f-37fe-4b20-81f4-80767415708d` | `22f98e94-8172-4550-bc17-71287accf410:retry:1` | 0 |

## Daemon and queue readbacks

### ahub status readback

```text
agent-hub 0.15.0  pid 40780  control 127.0.0.1:4600
/Users/yj.lee/workspace/work/dev/agent-hub
  config retained  action_policy.always_ask; run ahub settings reload
  retained reason  action_policy.always_ask: guarded change needs a selected
      setting or a confirmed terminal reload; review and run ahub settings
      reload, or revert this key
  memory  generation f1ea606e; ready; agent-mem 0.4.0
  planner  claude (roles)

PEER          STATE    MODE       LINK       Q  !  QUOTA     MODEL  CONTEXT
agy           busy     -          pull-only  -  -  -         -      unknown
  agy flow roles  implementer, verifier
  agy catalog roles  unconfirmed
  agy pending roles  none
  pull-only  messages wait for hub_inbox; permission modes and session recovery
      are not managed
  agy last read  18m ago
  agy action policy  always-ask not enforceable: adapter integration pending;
      policy disabled
  permission  unmanaged native permission policy
claude        idle     -          attached   -  -  5h 7% in  -      83% 4s ago
                                                   27m,             claude_statusline
                                                   week 17%         
                                                   in 5d11h         
  claude flow roles  planner, reviewer, implementer
  claude catalog roles  unconfirmed
  claude pending roles  none
  claude action policy  always-ask disabled
codex         busy     -          attached   4  -  week 31%  -      50% 0s ago
                                                   in 6d08h         codex_token_usage
  codex flow roles  implementer
  codex catalog roles  none
  settling  53034269, 94dcbe81, cc717df7, 17fdcfaa
  codex action policy  always-ask not enforceable: adapter integration pending;
      policy disabled
  codex oldest queued  30m ago
codex-review  idle     -          attached   -  -  -         -      unknown
  codex-review flow roles  reviewer
  codex-review catalog roles  none
  codex-review action policy  always-ask not enforceable: adapter integration
      pending; policy disabled
jcode         busy     unmanaged  attached   6  2  -         -      unknown
  jcode flow roles  implementer, verifier
  jcode catalog roles  none
  settling  f5038b04
  jcode action policy  always-ask not enforceable: adapter integration pending;
      policy disabled
  jcode oldest queued  33m ago
kimi          idle     -          pull-only  1  -  -         -      unknown
  kimi flow roles  implementer, verifier
  kimi catalog roles  unconfirmed
  kimi pending roles  none
  pull-only  messages wait for hub_inbox; no push, steer, watchdog or automatic
      quota handoff
  kimi last read  5m ago
  kimi action policy  always-ask not enforceable: adapter integration pending;
      policy disabled
  permission  Kimi approves tools in its own TUI; no hub permission mode
  kimi oldest queued  2m ago
pi            offline  -          attached   -  -  -                unknown
  pi flow roles  implementer, verifier
  pi catalog roles  none
  pi action policy  always-ask not enforceable: adapter integration pending;
      policy disabled

settling: the adapter has not confirmed these deliveries yet (Claude: reply or
    hub_delivery_done). Task state is independent.
  agy planner WIP  1/1
  claude planner WIP  1/1
  codex planner WIP  2/2
  codex-review planner WIP  0/1
  jcode planner WIP  1/2
  kimi planner WIP  1/1
  pi planner WIP  0/1

TASKS  318 approved, 51 backlog, 46 cancelled, 5 in_progress, 1 in_review, 9
    proposed (ahub board)
(O O) ? 1 for review
```

### ahub queue readback

#### Agent session refusal readback

```text
ahub: agy cannot run ahub queue; the person runs it in ahub console or a terminal. Refused because inherited agent markers (AGENTHUB_PEER_ID) identify this shell as an agent. A ! command in an agent session runs as that agent; use a separate terminal outside the agent session
```

#### Terminal / un-marked readback snapshot

```text
ID                                            PEER          STATE      REV
12618713-d740-4e41-8ccc-c8f12f274811          claude        completed  20537  24m
453fb1fe-d1fd-4413-8886-2c4b1a8136b6          claude        completed  20541  24m
8f872632-b4bc-4c68-8e1e-b1688264de4f          claude        completed  20545  19m
b266d9ff-414a-4b47-a158-cf7583d7aee5          agy           completed  20547  18m
4a50aca0-3e1f-4293-a240-d11688d54a0d          claude        completed  20551  17m
q:jcode:0e32d14a-8291-4cfc-a8b2-7a809c9ddb84  jcode         queued     20603  15m
ee72773d-9166-41a5-856d-61abb83aaae7          kimi          completed  20554  12m
17fdcfaa-16ab-460f-b617-66e870e0b57e          codex         accepted   20557  12m
q:codex:dd29e6f7-44c6-4ae8-af73-0d8ef153fe91  codex         queued     20603  12m
be1b36aa-f52c-4fbe-ad3c-b69d5a2f9bc9          claude        completed  20562  12m
c5d72139-becd-4efd-84aa-93727f26e1c8          codex-review  completed  20574  10m
a2986e19-17d4-4c85-89a5-9563e0759100          claude        completed  20569  10m
a1ff7fa6-0ddc-465d-ac81-558eab388f93          claude        completed  20582  9m
4d1521d7-900f-4709-8705-c46383e3578b          codex-review  completed  20578  9m
b40a92c7-0873-4c54-8c5e-757ff138dcb9          claude        completed  20586  8m
9c600ed1-f4d4-419c-beb4-65a7fed6b2ea          claude        completed  20589  8m
q:codex:a28fbf8e-1673-4247-a08d-9da95e4b47c3  codex         queued     20603  5m
7458b24d-4249-43a3-a727-d8cf1bc97f01          kimi          completed  20592  5m
q:kimi:9847f827-5fe4-4872-843d-d15a6d303a8e   kimi          queued     20603  2m
089431f9-effd-4bb1-819c-c1f2359dff06          claude        completed  20598  2m
q:jcode:aafbd751-b63b-4df3-9673-25dcc869b258  jcode         queued     20603  2m
7a567c18-c8cd-4cf2-aa6b-ee1748950e0b          claude        completed  20603  1m
q:codex:ea92d307-f97a-4088-bde2-ffb7d8bc010f  codex         queued     20603  1m
```
