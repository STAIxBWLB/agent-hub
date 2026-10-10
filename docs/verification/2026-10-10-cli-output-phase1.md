# One-shot output fixture (#284 phase 1)

Deterministic synthetic fixture at fixed `now=1800000000000`. Before uses the previous command formatting; after uses the pure renderers. This is automated output evidence, not a human terminal inspection.

## status, 80 columns

Before:

```text
hub pid 25893, control 127.0.0.1:12345, /project/agent-hub
  claude   idle     queued 0  context 80% (fresh, claude_statusline, measured 2027-01-15T07:59:46.000Z)
  codex    busy     queued 2  awaiting settlement 8d03b496-1111-2222-3333-444444444444, 3325f7a0-1111-2222-3333-444444444444 (adapter completion; Claude: reply or hub_delivery_done; task state is independent)  held by needs_review abcdef12-1111-2222-3333-444444444444; ahub queue resolve abcdef12-1111-2222-3333-444444444444 --action completed|retry|discard --reason <text>  (manual)  context 34% (fresh, codex_token_usage, measured 2027-01-15T07:59:00.000Z)
  kimi     idle     queued 0  permission: ask-when-needed  context 25% (fresh, acp_usage_update, measured 2027-01-15T07:58:00.000Z)
  pi       idle     queued 0  tools-only: messages wait for hub_inbox; for pushes restart Claude with ahub claude  context unknown (unknown)
  tasks: 6 approved, 1 in_progress (ahub board)
```

After:

```text
agent-hub 0.12.22  pid 25893  control 127.0.0.1:12345
/project/agent-hub

PEER    STATE  MODE             LINK        Q  PAUSE  QUOTA          CONTEXT
claude  idle   -                attached    -  -      5h 23% in 10m  80% 14s ago
                                                                     claude_stat
                                                                     usline
codex   busy   -                attached    2  user   -              34% 1m ago
                                                                     codex_token
                                                                     _usage
  settling  8d03b496, 3325f7a0
  held  by needs_review abcdef12; ahub queue resolve
      abcdef12-1111-2222-3333-444444444444 --action completed|retry|discard
      --reason <text>
  paused  manual
kimi    idle   ask-when-needed  attached    -  -      -              25% 2m ago
                                                                     acp_usage_u
                                                                     pdate
pi      idle   -                tools-only  -  -      -              unknown
  tools-only  messages wait for hub_inbox; for pushes restart Claude with ahub
      claude

settling: the adapter has not confirmed these deliveries yet (Claude: reply or
    hub_delivery_done). Task state is independent.

TASKS  6 approved, 1 in_progress (ahub board)
```

## board, 80 columns

Before:

```text
#1    approved           implement  codex    review:claude   제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증
#2    in_progress        implement  kimi     review:claude   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  (after #1)
#3    proposed           implement  local    review:claude   [pii]  (after #2)  (ahub task show 3)
```

After:

```text
ID  STATE        OWNER  REVIEWER  CLASS      AGE  TITLE                   STAGE
#1  approved     codex  claude    implement  1m   제주한라대학교 AI       [####]
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증 제주한라대학교 AI
                                                  도구를 활용한 구현과
                                                  검증
#2  in_progress  kimi   claude    implement  2m   AAAAAAAAAAAAAAAAAAAAAA  [##--]
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAA  after
                                                  #1
#3  proposed     local  claude    implement  30s  [pii]  after #2  (ahub  [#---]
    waiting                                       task show 3)

3 tasks: 1 approved, 1 in_progress, 1 proposed
```

## budget, 80 columns

Before:

```text
claude  PAUSED: quota threshold, resumes in 10m00s
  week     49%  resets in 129h00m  [claude_statusline, 14s ago]
codex
  week      8%  [codex_rate_limits, 60s ago, STALE]
```

After:

```text
PEER    WINDOW  USED  RESETS    SOURCE             MEASURED  STATE
claude  week    49%   in 5d09h  claude_statusline  14s ago   fresh
codex   week    8%    -         codex_rate_limits  1m ago    stale
  paused claude  quota threshold; resumes in 10m
```

## doctor, 80 columns

Before:

```text
  ok  bun                    1.4.2
  --  local fixed_model      vllm/large-model is not served by the gateway
  --  pi mlx                 error: Unable to connect. Is the computer able to access the URL?
  ?  capture: codex         unknown, dot ai memory status is unavailable
```

After:

```text
Tools
LEVEL  CHECK  FINDING
ok     bun    1.4.2

Models
LEVEL  CHECK              FINDING
fail   local fixed_model  vllm/large-model is not served by the gateway
warn   pi mlx             error: Unable to connect. Is the computer able to
                          access the URL?

Memory
LEVEL    CHECK           FINDING
unknown  capture: codex  unknown, dot ai memory status is unavailable

1 failure, 1 warning, 1 ok, 1 unknown
```

## status, 120 columns

Before:

```text
hub pid 25893, control 127.0.0.1:12345, /project/agent-hub
  claude   idle     queued 0  context 80% (fresh, claude_statusline, measured 2027-01-15T07:59:46.000Z)
  codex    busy     queued 2  awaiting settlement 8d03b496-1111-2222-3333-444444444444, 3325f7a0-1111-2222-3333-444444444444 (adapter completion; Claude: reply or hub_delivery_done; task state is independent)  held by needs_review abcdef12-1111-2222-3333-444444444444; ahub queue resolve abcdef12-1111-2222-3333-444444444444 --action completed|retry|discard --reason <text>  (manual)  context 34% (fresh, codex_token_usage, measured 2027-01-15T07:59:00.000Z)
  kimi     idle     queued 0  permission: ask-when-needed  context 25% (fresh, acp_usage_update, measured 2027-01-15T07:58:00.000Z)
  pi       idle     queued 0  tools-only: messages wait for hub_inbox; for pushes restart Claude with ahub claude  context unknown (unknown)
  tasks: 6 approved, 1 in_progress (ahub board)
```

After:

```text
agent-hub 0.12.22  pid 25893  control 127.0.0.1:12345
/project/agent-hub

PEER    STATE  MODE             LINK        Q  PAUSE  QUOTA          CONTEXT
claude  idle   -                attached    -  -      5h 23% in 10m  80% 14s ago claude_statusline
codex   busy   -                attached    2  user   -              34% 1m ago codex_token_usage
  settling  8d03b496, 3325f7a0
  held  by needs_review abcdef12; ahub queue resolve abcdef12-1111-2222-3333-444444444444 --action
      completed|retry|discard --reason <text>
  paused  manual
kimi    idle   ask-when-needed  attached    -  -      -              25% 2m ago acp_usage_update
pi      idle   -                tools-only  -  -      -              unknown
  tools-only  messages wait for hub_inbox; for pushes restart Claude with ahub claude

settling: the adapter has not confirmed these deliveries yet (Claude: reply or hub_delivery_done). Task state is
    independent.

TASKS  6 approved, 1 in_progress (ahub board)
```

## board, 120 columns

Before:

```text
#1    approved           implement  codex    review:claude   제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증
#2    in_progress        implement  kimi     review:claude   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  (after #1)
#3    proposed           implement  local    review:claude   [pii]  (after #2)  (ahub task show 3)
```

After:

```text
ID  STATE        OWNER  REVIEWER  CLASS      AGE  TITLE                                                           STAGE
#1  approved     codex  claude    implement  1m   제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI   [####]
                                                  도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한
                                                  구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증
                                                  제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI
                                                  도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한
                                                  구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증
                                                  제주한라대학교 AI 도구를 활용한 구현과 검증 제주한라대학교 AI
                                                  도구를 활용한 구현과 검증 제주한라대학교 AI 도구를 활용한
                                                  구현과 검증 제주한라대학교 AI 도구를 활용한 구현과 검증
#2  in_progress  kimi   claude    implement  2m   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  [##--]
                                                  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
                                                  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  after #1
#3  proposed     local  claude    implement  30s  [pii]  after #2  (ahub task show 3)                             [#---]
    waiting

3 tasks: 1 approved, 1 in_progress, 1 proposed
```

## budget, 120 columns

Before:

```text
claude  PAUSED: quota threshold, resumes in 10m00s
  week     49%  resets in 129h00m  [claude_statusline, 14s ago]
codex
  week      8%  [codex_rate_limits, 60s ago, STALE]
```

After:

```text
PEER    WINDOW  USED  RESETS    SOURCE             MEASURED  STATE
claude  week    49%   in 5d09h  claude_statusline  14s ago   fresh
codex   week    8%    -         codex_rate_limits  1m ago    stale
  paused claude  quota threshold; resumes in 10m
```

## doctor, 120 columns

Before:

```text
  ok  bun                    1.4.2
  --  local fixed_model      vllm/large-model is not served by the gateway
  --  pi mlx                 error: Unable to connect. Is the computer able to access the URL?
  ?  capture: codex         unknown, dot ai memory status is unavailable
```

After:

```text
Tools
LEVEL  CHECK  FINDING
ok     bun    1.4.2

Models
LEVEL  CHECK              FINDING
fail   local fixed_model  vllm/large-model is not served by the gateway
warn   pi mlx             error: Unable to connect. Is the computer able to access the URL?

Memory
LEVEL    CHECK           FINDING
unknown  capture: codex  unknown, dot ai memory status is unavailable

1 failure, 1 warning, 1 ok, 1 unknown
```
