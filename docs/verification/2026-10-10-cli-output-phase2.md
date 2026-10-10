# Command output fixture (#284 phases 2 and 3)

Synthetic deterministic data at now=1800000000000. Before uses the previous command formatting (turn locale in UTC for determinism); after uses the current pure renderer. This is automated evidence, not a human terminal inspection.

## projects, 80 columns

Before:

```text
p_123456789012345678901234  running      /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로
  peers 2, control 12345, tasks {"approved":6,"in_progress":1}
```

After:

```text
PROJECT                     STATE    PEERS  TASKS                   ROOT
p_123456789012345678901234  running  2      6 approved, 1           /project/
                                            in_progress             경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로
```

## status --all, 80 columns

Before:

```text
p_123456789012345678901234  running      /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로
  peers 2, control 12345, tasks {"approved":6,"in_progress":1}
```

After:

```text
PROJECT                     STATE    PEERS  TASKS                   ROOT
p_123456789012345678901234  running  2      6 approved, 1           /project/
                                            in_progress             경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로경로
                                                                    경로경로
```

## queue list, 80 columns

Before:

```text
abcdef12-1111-2222-3333-444444444444  codex  needs_review  revision 3  important
```

After:

```text
ID                                    PEER   STATE         REV  AGE
abcdef12-1111-2222-3333-444444444444  codex  needs_review  3    1m
  priority  important
```

## turns, 80 columns

Before:

```text
turn-12345678901234567890  1/15/2027, 7:59:00 AM  8 files: src/한글경로/file-0.ts, src/한글경로/file-1.ts, src/한글경로/file-2.ts, src/한글경로/file-3.ts, src/한글경로/file-4.ts, ...
```

After:

```text
TURN                       PEER   STARTED  STATE      FILES
turn-12345678901234567890  codex  1m ago   completed  8 files: src/한글경로/
                                                      file-0.ts, src/한글경로/
                                                      file-1.ts, src/한글경로/
                                                      file-2.ts, src/한글경로/
                                                      file-3.ts, src/한글경로/
                                                      file-4.ts, src/한글경로/
                                                      file-5.ts, src/한글경로/
                                                      file-6.ts, src/한글경로/
                                                      file-7.ts
```

## doctor --orphans, 80 columns

Before:

```text
orphaned hub registrations (the project root is gone):
  p_123456789012345678901234  /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로  live pid 12345
kill live orphans with `ahub doctor --orphans --kill`, then forget each row with `ahub projects remove <id>`
```

After:

```text
orphaned hub registrations (the project root is gone):
PROJECT                     STATE  PIDS   ROOT
p_123456789012345678901234  live   12345  /project/
                                          경로경로경로경로경로경로경로경로경로경
                                          로경로경로경로경로경로경로경로경로경로
                                          경로경로경로경로경로경로경로경로경로경
                                          로경로경로경로경로경로경로경로경로경로
                                          경로경로경로경로경로경로경로경로경로경
                                          로경로경로

kill live orphans with ahub doctor --orphans --kill
  forget  ahub projects remove p_123456789012345678901234
```

## queue show, 80 columns

Before:

```text
{
  "id": "abcdef12-1111-2222-3333-444444444444",
  "peer": "codex",
  "state": "needs_review",
  "revision": 3,
  "important": true,
  "createdAt": 1799999940000,
  "updatedAt": 1799999970000,
  "envelopeIds": [
    "8d03b496-1111-2222-3333-444444444444"
  ],
  "messages": [
    {
      "id": "8d03b496-1111-2222-3333-444444444444",
      "from": "claude",
      "priority": "important",
      "kind": "chat",
      "body": "[private: inspect the associated task with ahub task show]"
    }
  ]
}
```

After:

```text
Delivery
FIELD                VALUE
id                   abcdef12-1111-2222-3333-444444444444
peer                 codex
state                needs_review
revision             3
important            true
createdAt            1m ago
updatedAt            30s ago
envelopeIds 1        8d03b496-1111-2222-3333-444444444444
messages 1 id        8d03b496-1111-2222-3333-444444444444
messages 1 from      claude
messages 1 priority  important
messages 1 kind      chat
messages 1 body      [private: inspect the associated task with ahub task show]

  resolve  ahub queue resolve abcdef12-1111-2222-3333-444444444444 --action
      completed|retry|discard --reason <text>
```

## models status, 80 columns

Before:

```text
{
  "state": "ready",
  "model": "qwen/long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-",
  "expiresAt": "2027-01-15T08:10:00.000Z",
  "active": 0,
  "contextWindow": 32768
}
```

After:

```text
Models
FIELD          VALUE
state          ready
model          qwen/long-model-name-long-model-name-long-model-name-long-model-n
               ame-long-model-name-long-model-name-long-model-name-long-model-na
               me-long-model-name-long-model-name-
expiresAt      in 10m
active         0
contextWindow  32768
```

## budget execution status, 80 columns

Before:

```text
[
  {
    "id": "budget-12345678901234567890",
    "kind": "task",
    "taskId": 3,
    "peers": [
      "local",
      "pi"
    ],
    "createdAt": 1799999940000,
    "updatedAt": 1799999970000,
    "units": {
      "tokens": {
        "used": 100,
        "limit": 200,
        "remaining": 100
      }
    }
  }
]
```

After:

```text
Execution budget
FIELD                     VALUE
1 id                      budget-12345678901234567890
1 kind                    task
1 taskId                  3
1 peers 1                 local
1 peers 2                 pi
1 createdAt               1m ago
1 updatedAt               30s ago
1 units tokens used       100
1 units tokens limit      200
1 units tokens remaining  100
```

## report, 80 columns

Before:

```text
period: 2027-01-15T07:59:00.000Z .. 2027-01-15T08:00:00.000Z
peer codex: 1 turn, 0.5 busy minutes, 120 tokens
usage codex: no usage records; input unknown (0 known), output unknown (0 known), cache read unknown (0 known), cache write unknown (0 known), reported total unknown (0 known); coverage unknown
usage team totals: reported token total unknown (0 known records); incomplete or unknown peer coverage (codex); estimated price unknown; measured spend unknown
messages: 0 (dropped: none; overflow 0; undeliverable 0); 0 per task that had any
overlap warnings: 0, task pairs: 0; edit conflicts: 0
task events: accepted 1
quota readings: 0 (0 hard limits)
```

After:

```text
period: 1m ago .. 0s ago

Counters
METRIC             COUNT
messages           0
overflow           0
undeliverable      0
messages per task  0
overlap warnings   0
task pairs         0
edit conflicts     0
quota readings     0
hard limits        0

Peers
PEER   TURNS  BUSY  TOKENS
codex  1      0.5m  120
  peer codex: 1 turn, 0.5 busy minutes, 120 tokens

Usage
  usage codex: no usage records; input unknown (0 known), output unknown (0
      known), cache read unknown (0 known), cache write unknown (0 known),
      reported total unknown (0 known); coverage unknown
  usage team totals: reported token total unknown (0 known records); incomplete
      or unknown peer coverage (codex); estimated price unknown; measured spend
      unknown

Messages
  messages: 0 (dropped: none; overflow 0; undeliverable 0); 0 per task that had
      any

Coordination
  overlap warnings: 0, task pairs: 0; edit conflicts: 0

Tasks
  task events: accepted 1

Quota
  quota readings: 0 (0 hard limits)
```

## report --by task, 80 columns

Before:

```text
period: 2027-01-15T07:59:00.000Z .. 2027-01-15T08:00:00.000Z
task #3: class implement, outcome in_progress, turns 1, wall unknown
  peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)
class implement: turns 1
  peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)
unattributed: tokens 0/120 (0.0%), usage records 0/0 (unknown), turns 0
before attribution: tokens 0, usage records 0, turns 0
```

After:

```text
period: 1m ago .. 0s ago

Tasks
TASK  CLASS      OUTCOME      TURNS  WALL
#3    implement  in_progress  1      unknown
  task #3: class implement, outcome in_progress, turns 1, wall unknown
    peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens
        unknown (0/0 known), cacheReadTokens unknown (0/0 known),
        cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)

Classes
  class implement: turns 1
    peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens
        unknown (0/0 known), cacheReadTokens unknown (0/0 known),
        cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)

Unattributed
  unattributed: tokens 0/120 (0.0%), usage records 0/0 (unknown), turns 0

Before attribution
  before attribution: tokens 0, usage records 0, turns 0
```

## projects, 120 columns

Before:

```text
p_123456789012345678901234  running      /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로
  peers 2, control 12345, tasks {"approved":6,"in_progress":1}
```

After:

```text
PROJECT                     STATE    PEERS  TASKS                      ROOT
p_123456789012345678901234  running  2      6 approved, 1 in_progress  /project/
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로
```

## status --all, 120 columns

Before:

```text
p_123456789012345678901234  running      /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로
  peers 2, control 12345, tasks {"approved":6,"in_progress":1}
```

After:

```text
PROJECT                     STATE    PEERS  TASKS                      ROOT
p_123456789012345678901234  running  2      6 approved, 1 in_progress  /project/
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로경로경로경로경로경로경로경로경로경로경로
                                                                       경로경로
```

## queue list, 120 columns

Before:

```text
abcdef12-1111-2222-3333-444444444444  codex  needs_review  revision 3  important
```

After:

```text
ID                                    PEER   STATE         REV  AGE
abcdef12-1111-2222-3333-444444444444  codex  needs_review  3    1m
  priority  important
```

## turns, 120 columns

Before:

```text
turn-12345678901234567890  1/15/2027, 7:59:00 AM  8 files: src/한글경로/file-0.ts, src/한글경로/file-1.ts, src/한글경로/file-2.ts, src/한글경로/file-3.ts, src/한글경로/file-4.ts, ...
```

After:

```text
TURN                       PEER   STARTED  STATE      FILES
turn-12345678901234567890  codex  1m ago   completed  8 files: src/한글경로/file-0.ts, src/한글경로/file-1.ts, src/
                                                      한글경로/file-2.ts, src/한글경로/file-3.ts, src/한글경로/
                                                      file-4.ts, src/한글경로/file-5.ts, src/한글경로/file-6.ts, src/
                                                      한글경로/file-7.ts
```

## doctor --orphans, 120 columns

Before:

```text
orphaned hub registrations (the project root is gone):
  p_123456789012345678901234  /project/경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로  live pid 12345
kill live orphans with `ahub doctor --orphans --kill`, then forget each row with `ahub projects remove <id>`
```

After:

```text
orphaned hub registrations (the project root is gone):
PROJECT                     STATE  PIDS   ROOT
p_123456789012345678901234  live   12345  /project/
                                          경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경
                                          로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로경로
                                          경로경로경로경로경로경로경로경로경로경로경로

kill live orphans with ahub doctor --orphans --kill
  forget  ahub projects remove p_123456789012345678901234
```

## queue show, 120 columns

Before:

```text
{
  "id": "abcdef12-1111-2222-3333-444444444444",
  "peer": "codex",
  "state": "needs_review",
  "revision": 3,
  "important": true,
  "createdAt": 1799999940000,
  "updatedAt": 1799999970000,
  "envelopeIds": [
    "8d03b496-1111-2222-3333-444444444444"
  ],
  "messages": [
    {
      "id": "8d03b496-1111-2222-3333-444444444444",
      "from": "claude",
      "priority": "important",
      "kind": "chat",
      "body": "[private: inspect the associated task with ahub task show]"
    }
  ]
}
```

After:

```text
Delivery
FIELD                VALUE
id                   abcdef12-1111-2222-3333-444444444444
peer                 codex
state                needs_review
revision             3
important            true
createdAt            1m ago
updatedAt            30s ago
envelopeIds 1        8d03b496-1111-2222-3333-444444444444
messages 1 id        8d03b496-1111-2222-3333-444444444444
messages 1 from      claude
messages 1 priority  important
messages 1 kind      chat
messages 1 body      [private: inspect the associated task with ahub task show]

  resolve  ahub queue resolve abcdef12-1111-2222-3333-444444444444 --action completed|retry|discard --reason <text>
```

## models status, 120 columns

Before:

```text
{
  "state": "ready",
  "model": "qwen/long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-",
  "expiresAt": "2027-01-15T08:10:00.000Z",
  "active": 0,
  "contextWindow": 32768
}
```

After:

```text
Models
FIELD          VALUE
state          ready
model          qwen/long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long-model-name-long
               -model-name-long-model-name-long-model-name-long-model-name-
expiresAt      in 10m
active         0
contextWindow  32768
```

## budget execution status, 120 columns

Before:

```text
[
  {
    "id": "budget-12345678901234567890",
    "kind": "task",
    "taskId": 3,
    "peers": [
      "local",
      "pi"
    ],
    "createdAt": 1799999940000,
    "updatedAt": 1799999970000,
    "units": {
      "tokens": {
        "used": 100,
        "limit": 200,
        "remaining": 100
      }
    }
  }
]
```

After:

```text
Execution budget
FIELD                     VALUE
1 id                      budget-12345678901234567890
1 kind                    task
1 taskId                  3
1 peers 1                 local
1 peers 2                 pi
1 createdAt               1m ago
1 updatedAt               30s ago
1 units tokens used       100
1 units tokens limit      200
1 units tokens remaining  100
```

## report, 120 columns

Before:

```text
period: 2027-01-15T07:59:00.000Z .. 2027-01-15T08:00:00.000Z
peer codex: 1 turn, 0.5 busy minutes, 120 tokens
usage codex: no usage records; input unknown (0 known), output unknown (0 known), cache read unknown (0 known), cache write unknown (0 known), reported total unknown (0 known); coverage unknown
usage team totals: reported token total unknown (0 known records); incomplete or unknown peer coverage (codex); estimated price unknown; measured spend unknown
messages: 0 (dropped: none; overflow 0; undeliverable 0); 0 per task that had any
overlap warnings: 0, task pairs: 0; edit conflicts: 0
task events: accepted 1
quota readings: 0 (0 hard limits)
```

After:

```text
period: 1m ago .. 0s ago

Counters
METRIC             COUNT
messages           0
overflow           0
undeliverable      0
messages per task  0
overlap warnings   0
task pairs         0
edit conflicts     0
quota readings     0
hard limits        0

Peers
PEER   TURNS  BUSY  TOKENS
codex  1      0.5m  120
  peer codex: 1 turn, 0.5 busy minutes, 120 tokens

Usage
  usage codex: no usage records; input unknown (0 known), output unknown (0 known), cache read unknown (0 known), cache
      write unknown (0 known), reported total unknown (0 known); coverage unknown
  usage team totals: reported token total unknown (0 known records); incomplete or unknown peer coverage (codex);
      estimated price unknown; measured spend unknown

Messages
  messages: 0 (dropped: none; overflow 0; undeliverable 0); 0 per task that had any

Coordination
  overlap warnings: 0, task pairs: 0; edit conflicts: 0

Tasks
  task events: accepted 1

Quota
  quota readings: 0 (0 hard limits)
```

## report --by task, 120 columns

Before:

```text
period: 2027-01-15T07:59:00.000Z .. 2027-01-15T08:00:00.000Z
task #3: class implement, outcome in_progress, turns 1, wall unknown
  peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)
class implement: turns 1
  peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)
unattributed: tokens 0/120 (0.0%), usage records 0/0 (unknown), turns 0
before attribution: tokens 0, usage records 0, turns 0
```

After:

```text
period: 1m ago .. 0s ago

Tasks
TASK  CLASS      OUTCOME      TURNS  WALL
#3    implement  in_progress  1      unknown
  task #3: class implement, outcome in_progress, turns 1, wall unknown
    peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown
        (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)

Classes
  class implement: turns 1
    peer codex: tokens 120; inputTokens unknown (0/0 known), outputTokens unknown (0/0 known), cacheReadTokens unknown
        (0/0 known), cacheWriteTokens unknown (0/0 known), totalTokens unknown (0/0 known)

Unattributed
  unattributed: tokens 0/120 (0.0%), usage records 0/0 (unknown), turns 0

Before attribution
  before attribution: tokens 0, usage records 0, turns 0
```
