# UI and console operational settings audit

Issue #489 H7, task #448; static inventory/source audit at `eaeeb7b246b7b1e6349c43e5d719b3e7e862c536`. Proposed settings remain pending Claude ruling. No implementation, test execution or closure of #489 is claimed.

## Provenance and exact reconciliation

- Generator: `scripts/inventory-hardcoded-values.ts`, `areaFor()`. Frozen H0: `docs/verification/2026-10-24-hardcoded-values.md`; stable keys: `scripts/inventory-hardcoded-values.classifications.json`.
- UI/console is the fallback after model, adapter, recovery, delivery and task rules. Its broad label includes unrelated CLI/host/memory/budget/scripts/benchmarks and does not expand H7 accepted paths.
- Complete fallback:1007 unique keys,498 operational/193 safety floor/283 contract/33 test seam. Markdown contains1105 occurrences and1007 unique location rows; every stable key matches file/kind/name/value evidence.
- Exact accepted-path intersection is81 keys:27 operational/12 safety floor/41 contract/1 seam; outside accepted paths926. Earlier82/925 planning counts included the accepted-path src/ui/task-progress.ts waiting initializer, but generator assigns that file to tasks/routing by its task-* basename. It is not part of this1007-key fallback ledger. No identity is fabricated, dropped or reassigned.
- Five proposed settings map to6 H0 keys (two command-history paths share one setting);75 other accepted-path keys and926 outside-path keys stay excluded.

## Proposed scope, pending ruling

| Key | Legacy default | Bounds | Apply point |
| --- | --- | --- | --- |
| console.poll_ms |4000ms |integer2000..60000 |Next console startup; fixed2000ms floor |
| console.notice_ms |10000ms |integer10000..60000 |Next console startup; raise-only visibility |
| console.history_limit |100 entries |integer1..100 |Next console startup; both submission paths |
| console.pending_stream_limit |1000 events |integer1..1000 |Next console startup; local panel-mode output only |
| console.attention_limit |1000 refs |integer1..1000 |Next console startup; local direct-message attention only |

Use existing fixed H1 metadata/schema/settings/default pins and a3s-bounded console-role settings_get once at startup. Consume only accepted rows[].value, never fileValue/pending/raw config. Old/refusing/malformed/unavailable hubs fall back to legacy values. Capture locally at next console start, leaving running consoles unchanged; add no config file, environment knob, protocol/status projection, conductor authority or cross-process seam. Preserve ConsoleOptions.pollMs precedence.

## Startup, ownership and budget constraints

- Close/signal handlers AND normal push/permission handlers must be installed before awaiting startup settings. No prompt may disappear during the3s wait. Begin intervals after capture.
- Pushes can populate local presentation buffers before capture at their default limits. If policy lowers a limit, perform a cold-start-only bounded trim of pendingStream with the exact added droppedStream count, and keep the newest attention refs. Existing one-shift append logic cannot repair a buffer already far above its new cap. Never discard approvals, control messages or daemon work.
- Refresh uses polling/refreshPending serialization with3s status/budget/task/settings requests and a possible additional5s Usage round. Preserve serialization on a2s poll; no duplicate in-flight request loop. The1s redraw/approval-prune cadence stays fixed.
- appendEvent cap1000 is an existing test/host seam and stays fixed. Usage limits query1000 belongs to its existing Usage-only read path, not event retention. Local preferences never trim bus queues, journals, task state or approval records.
- Host dashboard ticket60s/session60min/settings-authority15min/cap64 remain fixed. Its35s and derived backlog-split HTTP waits remain coupled to manager/control/planning budgets.
- Manager startDashboard serves one static authenticated page across projects; daemon also has a project-local constructor. DashboardOptions has no accepted project numeric preference input. Browser/office parameters therefore await a scope decision, preserving project/instance/view generation, reduced motion, current-view-only fetches and self-contained toString models.

## Accepted paths:81 detailed identities

Coordinates below are frozen H0 locations, not current-source line claims. Matching tuple locations may appear together where stable context/occurrence disambiguates them; H0 classifications remain unchanged.

| Stable H0 key | Frozen location(s) | H0 class | Proposed disposition | Specific reason |
| --- | --- | --- | --- | --- |
| `src/cli/console-state.ts:NOTICE_MS:constant:NOTICE_MS=10000#0` | src/cli/console-state.ts:883:7 | operational | Proposed console.notice_ms | Capture10000ms default, integer10000..60000; raise-only person-visible notice lifetime. Rendering expiry never changes approval or command authority. |
| `src/cli/console-state.ts:appendEvent:inline:cap=1000#0` | src/cli/console-state.ts:457:73 | test seam | Excluded existing test seam | cap=1000 is already an explicit appendEvent argument and H0 test seam. Keep default, following/held selection and event retention unchanged; no sixth setting. |
| `src/cli/console-state.ts:cap:inline:Math.max=24#0` | src/cli/console-state.ts:949:24, src/cli/console-state.ts:972:24 | contract | Excluded existing layout/syntax | 24-column floor belongs to table width allocation, not timing or retained work. |
| `src/cli/console-state.ts:cap:inline:Math.max=24#1` | src/cli/console-state.ts:949:24, src/cli/console-state.ts:972:24 | contract | Excluded existing layout/syntax | 24-column floor belongs to table width allocation, not timing or retained work. |
| `src/cli/console-state.ts:capacity:inline:Math.max=1#0` | src/cli/console-state.ts:1168:31 | contract | Excluded existing layout/syntax | 1-row minimum and3-row capacity clamp reserve viewport/approval option space; keep layout math and selection unchanged. |
| `src/cli/console-state.ts:capacity:inline:Math.min=3#0` | src/cli/console-state.ts:1168:96 | contract | Excluded existing layout/syntax | 1-row minimum and3-row capacity clamp reserve viewport/approval option space; keep layout math and selection unchanged. |
| `src/cli/console-state.ts:decoratePetFooter:inline:text.slice=5#0` | src/cli/console-state.ts:1060:142 | contract | Excluded existing layout/syntax | slice5 splits a fixed footer/character prefix for color styling; no message retention semantics. |
| `src/cli/console-state.ts:noticeLines:inline:Math.max=0#0` | src/cli/console-state.ts:1132:156 | contract | Excluded existing layout/syntax | 0 nonnegative floor and6 reserved body rows constrain notice layout; do not couple viewport geometry to notice lifetime. |
| `src/cli/console-state.ts:noticeLines:inline:Math.max=6#0` | src/cli/console-state.ts:1132:172 | contract | Excluded existing layout/syntax | 0 nonnegative floor and6 reserved body rows constrain notice layout; do not couple viewport geometry to notice lifetime. |
| `src/cli/console-state.ts:reduceConsole:inline:[...s.history, input].slice=-100#0` | src/cli/console-state.ts:622:51, src/cli/console-state.ts:640:49 | operational | Proposed console.history_limit | Both submission paths use one100-entry default, integer1..100. Trim only local command history, preserve historyIndex, and add no persistence or replay. |
| `src/cli/console-state.ts:reduceConsole:inline:[...s.history, input].slice=-100#1` | src/cli/console-state.ts:622:51, src/cli/console-state.ts:640:49 | operational | Proposed console.history_limit | Both submission paths use one100-entry default, integer1..100. Trim only local command history, preserve historyIndex, and add no persistence or replay. |
| `src/cli/console-state.ts:reduceConsole:inline:args.length < (lock.prefix[1] === plan ? 6 : 5)=5#0` | src/cli/console-state.ts:637:92 | contract | Excluded existing layout/syntax | 5/6 token minima validate exact task/plan command syntax under revision-bound action locks; remain fixed. |
| `src/cli/console-state.ts:reduceConsole:inline:args.length < (lock.prefix[1] === plan ? 6 : 5)=6#0` | src/cli/console-state.ts:637:88 | contract | Excluded existing layout/syntax | 5/6 token minima validate exact task/plan command syntax under revision-bound action locks; remain fixed. |
| `src/cli/console-state.ts:renderConsoleLines:inline:rowsOf?.[0] ?? [span(peer ${s.peerFilter ?? all} kind ${s.kindFilter ?? all}, info)]=0#0` | src/cli/console-state.ts:1201:50 | contract | Excluded existing layout/syntax | Index0 selects a rendered row/fallback, or slice2 bounds settings explanatory lines. Preserve viewport layout without changing host schema or pending/rejected notices. |
| `src/cli/console-state.ts:renderConsoleLines:inline:wrap(info, columns).slice=2#0` | src/cli/console-state.ts:1175:50 | safety floor | Excluded existing layout/syntax | Index0 selects a rendered row/fallback, or slice2 bounds settings explanatory lines. Preserve viewport layout without changing host schema or pending/rejected notices. |
| `src/cli/console.ts:<anonymous>:inline:[...(state.attentionMessages ?? []), { id: msg.e.env.id, peer: msg.e.env.from, important: msg.e.env.priority === important, since: msg.e.env.ts }].slice=-1000#0` | src/cli/console.ts:377:290 | operational | Proposed console.attention_limit | Capture1000 default, integer1..1000; trim transient directly addressed message refs only. Preserve ids, exact attention navigation and person-input acknowledgement; never change live approvals/deliveries. |
| `src/cli/console.ts:draw:inline:lines.at=-1#0` | src/cli/console.ts:159:85 | contract | Excluded existing validation/layout | Final-line index-1 positions the cursor; indexing is not event retention. |
| `src/cli/console.ts:effect:inline:response.key.length > 160=160#0` | src/cli/console.ts:288:147 | contract | Excluded existing validation/layout | 160-character settings response-key bound protects preview/confirm binding; no input/authority tuning. |
| `src/cli/console.ts:limit:inline:limit=1000#0` | src/cli/console.ts:202:111 | operational | Excluded existing validation/layout | 1000 is the existing usage limits query bound, not console event retention. Preserve Usage-panel-only reads and omitted/unknown reporting. |
| `src/cli/console.ts:lines:inline:(Array.isArray(response.lines) ? response.lines : []).map(String).slice=40#0` | src/cli/console.ts:299:151 | safety floor | Excluded existing validation/layout | 40 diagnostic lines bound displayed hook output; preserve terminal sanitization and viewport protection. |
| `src/cli/console.ts:output:inline:(diagnostic + terminalText(text)).slice=-2000#0` | src/cli/console.ts:350:109 | safety floor | Excluded existing validation/layout | Last2000 sanitized terminal characters bound command diagnostic memory; do not expand untrusted text through presentation preferences. |
| `src/cli/console.ts:runConsole:inline:Math.max=2000#0` | src/cli/console.ts:442:60 | operational | Excluded fixed cadence/floor | 2000ms is the fixed minimum polling floor; no configurable lower floor. |
| `src/cli/console.ts:runConsole:inline:options.pollMs ?? 4000=4000#0` | src/cli/console.ts:442:84 | operational | Proposed console.poll_ms | Capture4000ms default once at next console start; integer2000..60000, preserving explicit options.pollMs precedence, fixed2000ms floor and serialized refresh. |
| `src/cli/console.ts:runConsole:inline:setInterval=1000#0` | src/cli/console.ts:441:177 | operational | Excluded fixed cadence/floor | 1000ms redraw/pruneApprovals clock drives expiry/countdown display and stays fixed independently of status refresh. |
| `src/cli/console.ts:stream:inline:pendingStream.length > 1000=1000#0` | src/cli/console.ts:125:66 | operational | Proposed console.pending_stream_limit | Capture1000 default, integer1..1000; retain FIFO of panel-mode output only, exact droppedStream count and omitted-event notice. Never trim daemon queues or approval records. |
| `src/cli/console.ts:text:inline:(edit.text + terminalText(text.replace(/\x1b\[20[01]~/g, )).replace(/[\r\n]/g, )).slice=1000#0` | src/cli/console.ts:420:204 | safety floor | Excluded existing validation/layout | 1000 characters bounds pasted settings value/reason before preview and confirmation; preserve paste-does-not-confirm behavior. |
| `src/hub/ui.ts:LIMIT:constant:LIMIT=64#0` | src/hub/ui.ts:31:7 | operational | Excluded authentication/action/input bound | 64 bounds authentication tickets/sessions; preserve ticket eviction/session refusal semantics and manager-wide ownership. |
| `src/hub/ui.ts:SESSION_MS:constant:SESSION_MS=60 * 60000#0` | src/hub/ui.ts:25:7 | operational | Excluded authentication/action/input bound | 60min bounds browser session/cookie lifetime; SameSite/HttpOnly/Origin/session validation stays fixed. |
| `src/hub/ui.ts:SETTINGS_MS:constant:SETTINGS_MS=15 * 60000#0` | src/hub/ui.ts:27:14 | operational | Excluded authentication/action/input bound | 15min is the person-issued settings authority window; never make a privilege lifetime loosenable through an operational row. |
| `src/hub/ui.ts:TICKET_MS:constant:TICKET_MS=60000#0` | src/hub/ui.ts:24:7 | operational | Excluded authentication/action/input bound | 60s bounds consume-once bootstrap tickets; no project preference may extend authentication lifetime. |
| `src/hub/ui.ts:fetch:inline:server.timeout=35#0` | src/hub/ui.ts:142:99 | operational | Excluded authentication/action/input bound | 35s and the backlog-split formula are coordinated HTTP waits derived from control/planning/database budgets. Leave coupled; no independent action timeout. |
| `src/hub/ui.ts:fetch:inline:server.timeout=Math.ceil((BACKLOG_SPLIT_SCREEN_TIMEOUT_MS + HUB_DB_BUSY_TIMEOUT_MS + 5_000) / 1000) + 5#0` | src/hub/ui.ts:143:72 | operational | Excluded authentication/action/input bound | 35s and the backlog-split formula are coordinated HTTP waits derived from control/planning/database budgets. Leave coupled; no independent action timeout. |
| `src/hub/ui.ts:maxRequestBodySize:inline:maxRequestBodySize=32 * 1024#0` | src/hub/ui.ts:70:25 | safety floor | Excluded authentication/action/input bound | 32KiB limits untrusted JSON request bodies before dashboard actions; keep Origin/session/content-type checks and safety cap. |
| `src/ui/index.html:<anonymous>:inline:arms.length < 2=2#0` | src/ui/index.html:2224:25 | contract | Excluded polyline validity | 2 minimum points/endpoints make a valid drawn line; geometry validity is not a tunable capacity. |
| `src/ui/index.html:<anonymous>:inline:d.promotedFrom.slice=8#0` | src/ui/index.html:2369:89 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/index.html:<anonymous>:inline:d.supersededBy.slice=8#0` | src/ui/index.html:2368:89 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/index.html:<anonymous>:inline:entry.text.split(\n)[0].slice=140#0` | src/ui/index.html:2330:107 | safety floor | Excluded browser input/view safety | bounded issue/ready list or scene-label text stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:<anonymous>:inline:g.id.slice=8#0` | src/ui/index.html:2311:50 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/index.html:<anonymous>:inline:liveIssues.length > 32=32#0` | src/ui/index.html:2409:79 | contract | Excluded issue display contract | 32 is the existing visible issue-list bound; preserve browser omission/selection behavior. |
| `src/ui/index.html:<anonymous>:inline:model.rooms.map=2.55#0` | src/ui/index.html:2038:191 | contract | Excluded scene projection geometry | 2.55 is a room mapping/projection factor; not an operational timeout or retained-work count. |
| `src/ui/index.html:<anonymous>:inline:node.label.slice=28#0` | src/ui/index.html:2353:104 | safety floor | Excluded browser input/view safety | bounded issue/ready list or scene-label text stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:<anonymous>:inline:ready.slice=10#0` | src/ui/index.html:1429:40 | safety floor | Excluded browser input/view safety | bounded issue/ready list or scene-label text stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:<anonymous>:inline:setTimeout=300#0` | src/ui/index.html:2378:176 | operational | Excluded manager/project presentation ownership | 300ms memory-search debounce remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:OFFICE_SCALE:constant:OFFICE_SCALE=12#0` | src/ui/index.html:1760:7 | contract | Excluded scene unit contract | 12px/grid-unit connects SVG geometry and text measurement; a partial scale knob would break shared geometry. |
| `src/ui/index.html:TOAST_FADE_MS:inline:TOAST_FADE_MS=160#0` | src/ui/index.html:600:57 | operational | Excluded manager/project presentation ownership | 160ms toast fade remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:TOAST_MAX:inline:TOAST_MAX=4#0` | src/ui/index.html:600:21 | contract | Excluded toast layout contract | 4 stacked toasts preserve notification replacement/oldest removal layout, not a new multi-project preference. |
| `src/ui/index.html:TOAST_MS:inline:TOAST_MS=4000#0` | src/ui/index.html:600:35 | operational | Excluded manager/project presentation ownership | 4000ms non-error toast display remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:USAGE_LIMIT_ROWS:constant:USAGE_LIMIT_ROWS=20#0` | src/ui/index.html:1482:7 | safety floor | Excluded browser input/view safety | 20 newest usage limit rows with explicit omitted-count note stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:deliverablesSection:inline:file.sha256.slice=12#0` | src/ui/index.html:1264:205 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/index.html:draggedCard:inline:raw.length > 1024=1024#0` | src/ui/index.html:1200:30 | safety floor | Excluded browser input/view safety | 1024-character drag input validation stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:drawOffice:inline:points.length < 2=2#0` | src/ui/index.html:2126:25 | contract | Excluded polyline validity | 2 minimum points/endpoints make a valid drawn line; geometry validity is not a tunable capacity. |
| `src/ui/index.html:dur:inline:ms < 120000=120000#0` | src/ui/index.html:2207:68 | contract | Excluded formatting threshold | 120000ms changes duration formatting around two minutes; not a request or authority timeout. |
| `src/ui/index.html:duration:inline:Math.min=1000#0` | src/ui/index.html:1902:29 | operational | Excluded manager/project presentation ownership | 1000ms maximum office mark fade remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:hops:inline:hops=1#0` | src/ui/index.html:2245:95 | operational | Excluded manager/project presentation ownership | 1-hop initial memory graph selection remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:max:inline:Math.max=1#0` | src/ui/index.html:2229:41 | contract | Excluded chart scale arithmetic | Minimum1 prevents a zero graph/chart scale; no operational capacity is represented. |
| `src/ui/index.html:max:inline:max=1#0` | src/ui/index.html:2229:28 | contract | Excluded chart scale arithmetic | Minimum1 prevents a zero graph/chart scale; no operational capacity is represented. |
| `src/ui/index.html:memoryInput:inline:toISOString=3600000#0` | src/ui/index.html:2255:123 | contract | Excluded time-unit conversion | 3600000 converts selected hours to milliseconds for existing memory-since filtering; not a separate lookback policy. |
| `src/ui/index.html:notice:inline:String(text).slice=60#0` | src/ui/index.html:604:106 | safety floor | Excluded browser input/view safety | 60-character toast dedupe key stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:officeCardLabel:inline:space >= clipped.length - 8=8#0` | src/ui/index.html:1861:33 | contract | Excluded label geometry | Fixed minimum widths and near-word-boundary offsets preserve readable clipping and clipPath layout; no independently tuned clipping algorithm. |
| `src/ui/index.html:officeClip:inline:Math.max=4#0` | src/ui/index.html:1832:39 | contract | Excluded label geometry | Fixed minimum widths and near-word-boundary offsets preserve readable clipping and clipPath layout; no independently tuned clipping algorithm. |
| `src/ui/index.html:officeClip:inline:space >= 3=3#0` | src/ui/index.html:1835:53 | contract | Excluded label geometry | Fixed minimum widths and near-word-boundary offsets preserve readable clipping and clipPath layout; no independently tuned clipping algorithm. |
| `src/ui/index.html:officeClip:inline:space >= cut - 8=8#0` | src/ui/index.html:1835:39 | contract | Excluded label geometry | Fixed minimum widths and near-word-boundary offsets preserve readable clipping and clipPath layout; no independently tuned clipping algorithm. |
| `src/ui/index.html:poll:inline:setTimeout=1000#0` | src/ui/index.html:1742:110, src/ui/index.html:1751:42 | operational | Excluded manager/project presentation ownership | 1000ms snapshot poll/retry remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:poll:inline:setTimeout=1000#1` | src/ui/index.html:1742:110, src/ui/index.html:1751:42 | operational | Excluded manager/project presentation ownership | 1000ms snapshot poll/retry remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:refreshProjects:inline:setTimeout=3000#0` | src/ui/index.html:747:61 | operational | Excluded manager/project presentation ownership | 3000ms project refresh remains fixed. One static authenticated page spans selected projects/instances, with no accepted numeric preference source. Preserve view-generation, reduced motion and existing graph authority; do not add raw-config reads, hidden projection or protocol fields. |
| `src/ui/index.html:render:inline:stream.children.length > 200=200#0` | src/ui/index.html:1731:72 | safety floor | Excluded browser input/view safety | 200 rendered stream nodes stays at its original cap; no console setting expands untrusted input or silently changes browser truncation/privacy handling. |
| `src/ui/index.html:renderUsage:inline:total.since.slice=10#0` | src/ui/index.html:1509:158 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/index.html:settingRow:inline:row.min ?? 0=0#0` | src/ui/index.html:834:136 | contract | Excluded schema display fallback | row.min??0 initializes browser numeric control only; fixed host schema validation remains authoritative. |
| `src/ui/index.html:size:inline:size=2.4#0` | src/ui/index.html:1823:76 | contract | Excluded scene geometry | 2.4 grid units fixes isometric decorative block width/projection math. |
| `src/ui/index.html:who:inline:m.slice=8#0` | src/ui/index.html:2301:88 | contract | Excluded identifier display prefix | Fixed short id/hash prefix is a visual convention; full ids remain the request/evidence identities, never inferred from display prefixes. |
| `src/ui/office-model.ts:<anonymous>:inline:card=3.4#0` | src/ui/office-model.ts:346:85 | contract | Excluded scene geometry | 3.4 grid-unit card offset aligns fixed room headers/cards; no timing or capacity semantics. |
| `src/ui/office-model.ts:ALERT_CAP:inline:ALERT_CAP=12#0` | src/ui/office-model.ts:193:115 | contract | Excluded scene layout contract | ALERT_CAP=12 bounds visible desks/arcs/alerts in the fixed scene; overflow remains display-only, with no peer/message admission change. |
| `src/ui/office-model.ts:ARC_CAP:inline:ARC_CAP=12#0` | src/ui/office-model.ts:193:99 | contract | Excluded scene layout contract | ARC_CAP=12 bounds visible desks/arcs/alerts in the fixed scene; overflow remains display-only, with no peer/message admission change. |
| `src/ui/office-model.ts:ARC_MS:inline:ARC_MS=10_000#0` | src/ui/office-model.ts:193:18 | operational | Excluded manager/project presentation ownership | 10s arc/alert expiry is a presentation parameter, but the self-contained toString model serves one manager-owned multi-project page. No accepted numeric project policy port exists; defer scope design, not a new injection/projection. |
| `src/ui/office-model.ts:DESK_CAP:inline:DESK_CAP=12#0` | src/ui/office-model.ts:189:20 | contract | Excluded scene layout contract | DESK_CAP=12 bounds visible desks/arcs/alerts in the fixed scene; overflow remains display-only, with no peer/message admission change. |
| `src/ui/office-model.ts:LATCH_MS:inline:LATCH_MS=3_000#0` | src/ui/office-model.ts:193:37 | operational | Excluded manager/project presentation ownership | 3s transient busy latch is a presentation parameter, but the self-contained toString model serves one manager-owned multi-project page. No accepted numeric project policy port exists; defer scope design, not a new injection/projection. |
| `src/ui/office-model.ts:SETTLE_GAP_MS:inline:SETTLE_GAP_MS=3_000#0` | src/ui/office-model.ts:193:60 | operational | Excluded manager/project presentation ownership | 3s motion settle gap is a presentation parameter, but the self-contained toString model serves one manager-owned multi-project page. No accepted numeric project policy port exists; defer scope design, not a new injection/projection. |
| `src/ui/office-model.ts:SETTLE_MAX_MOVES:inline:SETTLE_MAX_MOVES=6#0` | src/ui/office-model.ts:193:86 | operational | Excluded manager/project presentation ownership | 6 moves before motion settles is a presentation parameter, but the self-contained toString model serves one manager-owned multi-project page. No accepted numeric project policy port exists; defer scope design, not a new injection/projection. |
| `src/ui/office-model.ts:officeModel:inline:linkTasks.length + linkPeers.length < 2=2#0` | src/ui/office-model.ts:430:47 | contract | Excluded scene relation layout | At least2 task/peer endpoints are needed to draw a relation. No underlying board relation is removed or reclassified. |
| `src/ui/office-model.ts:officeModel:inline:links.length > 24=24#0` | src/ui/office-model.ts:434:22 | contract | Excluded scene relation layout | 24 visible links bound scene clutter while preserving existing conflict/cohort ranking. No underlying board relation is removed or reclassified. |
| `src/ui/office-model.ts:waiting:inline:waiting=0#0` | src/ui/office-model.ts:207:56 | contract | Excluded count initialization | waiting=0 initializes the office task-count accumulator; not a tunable threshold or inferred observation. |

## Outside accepted paths:926 keys

Every group below is excluded solely by actual owner/path, without semantic reclassification. All original H0 labels are retained. These files remain with their existing subsystem or separately assigned task; no prior conversion/completion is asserted.

### scripts/agent-compat-step.sh

Path exclusion: `scripts/agent-compat-step.sh` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/agent-compat-step.sh:shell:inline:head=1#0` | scripts/agent-compat-step.sh:13:15 | contract |

### scripts/agent-compat-watch.ts

Path exclusion: `scripts/agent-compat-watch.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/agent-compat-watch.ts:<module>:inline:new Date().toISOString().slice=10#0` | scripts/agent-compat-watch.ts:18:52 | contract |
| `scripts/agent-compat-watch.ts:signal:inline:AbortSignal.timeout=15_000#0` | scripts/agent-compat-watch.ts:10:112 | operational |

### scripts/amem/baseline.ts

Path exclusion: `scripts/amem/baseline.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/amem/baseline.ts:<anonymous>:inline:new Date(DAY_START + i * DAY_MS).toISOString().slice=10#0` | scripts/amem/baseline.ts:52:114 | contract |
| `scripts/amem/baseline.ts:DAY_MS:constant:DAY_MS=86400000#0` | scripts/amem/baseline.ts:13:7 | contract |
| `scripts/amem/baseline.ts:days:inline:days=14#0` | scripts/amem/baseline.ts:53:13 | contract |
| `scripts/amem/baseline.ts:max:inline:max=13#0` | scripts/amem/baseline.ts:53:45 | contract |
| `scripts/amem/baseline.ts:min:inline:min=0#0` | scripts/amem/baseline.ts:53:29 | contract |

### scripts/amem/scale-bench.ts

Path exclusion: `scripts/amem/scale-bench.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/amem/scale-bench.ts:limit:inline:limit=50#0` | scripts/amem/scale-bench.ts:22:97 | operational |

### scripts/benchmarks/evaluate.py

Path exclusion: `scripts/benchmarks/evaluate.py` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/evaluate.py:create_sandbox:inline:timeout=180#0` | scripts/benchmarks/evaluate.py:123:81 | operational |
| `scripts/benchmarks/evaluate.py:main:inline:len=2#0` | scripts/benchmarks/evaluate.py:49:117 | contract |
| `scripts/benchmarks/evaluate.py:main:inline:len=7#0` | scripts/benchmarks/evaluate.py:28:25 | contract |

### scripts/benchmarks/ledger.py

Path exclusion: `scripts/benchmarks/ledger.py` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/ledger.py:final_text:inline:slice=200#0` | scripts/benchmarks/ledger.py:580:140 | safety floor |

### scripts/benchmarks/native.ts

Path exclusion: `scripts/benchmarks/native.ts` is outside H7 accepted files; 29 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/native.ts:<anonymous>:inline:String(e).slice=200#0` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:<anonymous>:inline:String(e).slice=200#1` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:<anonymous>:inline:i.toString().padStart=2#0` | scripts/benchmarks/native.ts:801:53 | contract |
| `scripts/benchmarks/native.ts:<anonymous>:inline:out.trim().slice=200#0` | scripts/benchmarks/native.ts:677:195 | safety floor |
| `scripts/benchmarks/native.ts:arm:inline:Bun.sleep=300#0` | scripts/benchmarks/native.ts:613:29 | operational |
| `scripts/benchmarks/native.ts:arm:inline:Date.now() - settled > 5000=5000#0` | scripts/benchmarks/native.ts:594:44 | operational |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#0` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#1` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#2` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:batch_max:inline:batch_max=1#0` | scripts/benchmarks/native.ts:408:220 | operational |
| `scripts/benchmarks/native.ts:batch_ms:inline:batch_ms=0#0` | scripts/benchmarks/native.ts:408:206 | operational |
| `scripts/benchmarks/native.ts:boundMs:inline:Math.min=30000#0` | scripts/benchmarks/native.ts:659:54 | operational |
| `scripts/benchmarks/native.ts:boundMs:inline:Math.min=300000#0` | scripts/benchmarks/native.ts:659:61 | operational |
| `scripts/benchmarks/native.ts:bytes:inline:regularBytes=16 * 1024 * 1024#0` | scripts/benchmarks/native.ts:281:50, scripts/benchmarks/native.ts:781:54 | safety floor |
| `scripts/benchmarks/native.ts:bytes:inline:regularBytes=16 * 1024 * 1024#1` | scripts/benchmarks/native.ts:281:50, scripts/benchmarks/native.ts:781:54 | safety floor |
| `scripts/benchmarks/native.ts:cmd:inline:detail.slice=350#0` | scripts/benchmarks/native.ts:58:67 | safety floor |
| `scripts/benchmarks/native.ts:cmd:inline:timeoutMs=180_000#0` | scripts/benchmarks/native.ts:55:92 | test seam |
| `scripts/benchmarks/native.ts:error:inline:String(error).replace(/(token\|secret\|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, $1$2[redacted]).slice=300#0` | scripts/benchmarks/native.ts:758:947 | safety floor |
| `scripts/benchmarks/native.ts:poll_min:inline:poll_min=1#0` | scripts/benchmarks/native.ts:408:336 | operational |
| `scripts/benchmarks/native.ts:refreshInterval:inline:refreshInterval=1#0` | scripts/benchmarks/native.ts:396:119 | operational |
| `scripts/benchmarks/native.ts:release_after_min:inline:release_after_min=0#0` | scripts/benchmarks/native.ts:408:251 | operational |
| `scripts/benchmarks/native.ts:removeTemp:inline:String(e).slice=200#0` | scripts/benchmarks/native.ts:671:92, scripts/benchmarks/native.ts:677:261, scripts/benchmarks/native.ts:680:190, scripts/benchmarks/native.ts:718:155, scripts/benchmarks/native.ts:726:78, scripts/benchmarks/native.ts:741:216 | safety floor |
| `scripts/benchmarks/native.ts:stopped:inline:Date.now() - waitCaptureAt >= 5000=5000#0` | scripts/benchmarks/native.ts:662:75 | operational |
| `scripts/benchmarks/native.ts:timer:inline:setTimeout=30000#0` | scripts/benchmarks/native.ts:536:140 | operational |
| `scripts/benchmarks/native.ts:timer:inline:setTimeout=60000#0` | scripts/benchmarks/native.ts:526:249 | operational |
| `scripts/benchmarks/native.ts:wait:inline:Bun.sleep=250#0` | scripts/benchmarks/native.ts:126:108, scripts/benchmarks/native.ts:150:21 | operational |
| `scripts/benchmarks/native.ts:wait:inline:ms=90000#0` | scripts/benchmarks/native.ts:144:68 | test seam |
| `scripts/benchmarks/native.ts:waitClaudeTui:inline:Bun.sleep=250#0` | scripts/benchmarks/native.ts:126:108, scripts/benchmarks/native.ts:150:21 | operational |
| `scripts/benchmarks/native.ts:watchdog_ms:inline:watchdog_ms=360000#0` | scripts/benchmarks/native.ts:408:188 | operational |

### scripts/benchmarks/peer-bus-mcp.py

Path exclusion: `scripts/benchmarks/peer-bus-mcp.py` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/peer-bus-mcp.py:<module>:inline:slice=4000#0` | scripts/benchmarks/peer-bus-mcp.py:20:133 | safety floor |
| `scripts/benchmarks/peer-bus-mcp.py:<module>:inline:timeout=5#0` | scripts/benchmarks/peer-bus-mcp.py:21:49 | operational |

### scripts/benchmarks/probe-qwen-usage.ts

Path exclusion: `scripts/benchmarks/probe-qwen-usage.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/probe-qwen-usage.ts:deadline:inline:deadline=65_000#0` | scripts/benchmarks/probe-qwen-usage.ts:55:33 | operational |
| `scripts/benchmarks/probe-qwen-usage.ts:main:inline:Bun.sleep=50#0` | scripts/benchmarks/probe-qwen-usage.ts:56:92 | operational |
| `scripts/benchmarks/probe-qwen-usage.ts:onUsageDiagnostic:inline:observations.length < 32=32#0` | scripts/benchmarks/probe-qwen-usage.ts:43:63 | operational |
| `scripts/benchmarks/probe-qwen-usage.ts:timeoutMs:inline:timeoutMs=15_000#0` | scripts/benchmarks/probe-qwen-usage.ts:50:132 | operational |
| `scripts/benchmarks/probe-qwen-usage.ts:watchdogMs:inline:watchdogMs=60_000#0` | scripts/benchmarks/probe-qwen-usage.ts:41:61 | operational |

### scripts/benchmarks/runner.py

Path exclusion: `scripts/benchmarks/runner.py` is outside H7 accepted files; 6 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/runner.py:actor_ok:inline:slice=5#0` | scripts/benchmarks/runner.py:491:147 | safety floor |
| `scripts/benchmarks/runner.py:actor_usage:inline:len=2#0` | scripts/benchmarks/runner.py:179:58, scripts/benchmarks/runner.py:590:131 | contract |
| `scripts/benchmarks/runner.py:teardown_failure:inline:slice=300#0` | scripts/benchmarks/runner.py:143:109, scripts/benchmarks/runner.py:150:161 | safety floor |
| `scripts/benchmarks/runner.py:teardown_failure:inline:slice=300#1` | scripts/benchmarks/runner.py:143:109, scripts/benchmarks/runner.py:150:161 | safety floor |
| `scripts/benchmarks/runner.py:v3_observability:inline:len=3#0` | scripts/benchmarks/runner.py:360:30 | contract |
| `scripts/benchmarks/runner.py:validate_manifest:inline:len=2#0` | scripts/benchmarks/runner.py:179:58, scripts/benchmarks/runner.py:590:131 | contract |

### scripts/benchmarks/study_audit.py

Path exclusion: `scripts/benchmarks/study_audit.py` is outside H7 accepted files; 8 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/study_audit.py:_coverage_read:inline:limit=4 * 1024 * 1024#0` | scripts/benchmarks/study_audit.py:679:32 | test seam |
| `scripts/benchmarks/study_audit.py:native_fixture_binding:inline:len=1#0` | scripts/benchmarks/study_audit.py:167:24 | contract |
| `scripts/benchmarks/study_audit.py:pins:inline:len=2#0` | scripts/benchmarks/study_audit.py:129:27, scripts/benchmarks/study_audit.py:244:52 | contract |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=2#0` | scripts/benchmarks/study_audit.py:129:27, scripts/benchmarks/study_audit.py:244:52 | contract |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=3#0` | scripts/benchmarks/study_audit.py:144:38 | contract |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=64#0` | scripts/benchmarks/study_audit.py:156:39 | safety floor |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:timeout=30#0` | scripts/benchmarks/study_audit.py:120:72, scripts/benchmarks/study_audit.py:137:95 | operational |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:timeout=30#1` | scripts/benchmarks/study_audit.py:120:72, scripts/benchmarks/study_audit.py:137:95 | operational |

### scripts/benchmarks/study_supervisor.py

Path exclusion: `scripts/benchmarks/study_supervisor.py` is outside H7 accepted files; 10 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/study_supervisor.py:CANCEL_SETTLE_S:constant:CANCEL_SETTLE_S=900.0#0` | scripts/benchmarks/study_supervisor.py:48:1 | operational |
| `scripts/benchmarks/study_supervisor.py:FALLBACK_SETTLE_S:constant:FALLBACK_SETTLE_S=10.0#0` | scripts/benchmarks/study_supervisor.py:49:1 | operational |
| `scripts/benchmarks/study_supervisor.py:PROGRESS_INTERVAL_S:constant:PROGRESS_INTERVAL_S=15.0#0` | scripts/benchmarks/study_supervisor.py:46:1 | operational |
| `scripts/benchmarks/study_supervisor.py:RECOVERY_TIMEOUT_S:constant:RECOVERY_TIMEOUT_S=300.0#0` | scripts/benchmarks/study_supervisor.py:50:1 | operational |
| `scripts/benchmarks/study_supervisor.py:STALE_AFTER_S:constant:STALE_AFTER_S=120.0#0` | scripts/benchmarks/study_supervisor.py:47:1 | operational |
| `scripts/benchmarks/study_supervisor.py:main:inline:slice=1#0` | scripts/benchmarks/study_supervisor.py:612:14 | contract |
| `scripts/benchmarks/study_supervisor.py:ps_fields:inline:timeout=5#0` | scripts/benchmarks/study_supervisor.py:90:84, scripts/benchmarks/study_supervisor.py:127:40 | operational |
| `scripts/benchmarks/study_supervisor.py:read_command:inline:timeout=60#0` | scripts/benchmarks/study_supervisor.py:344:106 | operational |
| `scripts/benchmarks/study_supervisor.py:spawn:inline:timeout=5#0` | scripts/benchmarks/study_supervisor.py:90:84, scripts/benchmarks/study_supervisor.py:127:40 | operational |
| `scripts/benchmarks/study_supervisor.py:wait_bounded:inline:timeout=0.2#0` | scripts/benchmarks/study_supervisor.py:163:47 | operational |

### scripts/benchmarks/teardown.ts

Path exclusion: `scripts/benchmarks/teardown.ts` is outside H7 accepted files; 12 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/benchmarks/teardown.ts:bytes:inline:regularBytes=256 * 1024#0` | scripts/benchmarks/teardown.ts:513:38 | safety floor |
| `scripts/benchmarks/teardown.ts:claudeUsageSnapshot:inline:Math.min=25#0` | scripts/benchmarks/teardown.ts:565:34 | operational |
| `scripts/benchmarks/teardown.ts:claudeUsageSnapshot:inline:boundMs=1500#0` | scripts/benchmarks/teardown.ts:556:102 | test seam |
| `scripts/benchmarks/teardown.ts:fallbackMs:inline:fallbackMs=4_000#0` | scripts/benchmarks/teardown.ts:220:161 | test seam |
| `scripts/benchmarks/teardown.ts:resetsMs:inline:resets < 1e12=1e12#0` | scripts/benchmarks/teardown.ts:534:100 | contract |
| `scripts/benchmarks/teardown.ts:resetsMs:inline:resetsMs=1000#0` | scripts/benchmarks/teardown.ts:534:116 | contract |
| `scripts/benchmarks/teardown.ts:settleMs:inline:settleMs=10_000#0` | scripts/benchmarks/teardown.ts:220:141 | test seam |
| `scripts/benchmarks/teardown.ts:teardown:inline:settleFor=bounds.fallbackMs / 2#0` | scripts/benchmarks/teardown.ts:277:29, scripts/benchmarks/teardown.ts:301:29 | operational |
| `scripts/benchmarks/teardown.ts:teardown:inline:settleFor=bounds.fallbackMs / 2#1` | scripts/benchmarks/teardown.ts:277:29, scripts/benchmarks/teardown.ts:301:29 | operational |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=10_000#0` | scripts/benchmarks/teardown.ts:94:189 | operational |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=20_000#0` | scripts/benchmarks/teardown.ts:79:171 | operational |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=5_000#0` | scripts/benchmarks/teardown.ts:53:192 | operational |

### scripts/check-citations.ts

Path exclusion: `scripts/check-citations.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/check-citations.ts:<module>:inline:statSync(bibliography).size > 4 * 1024 * 1024=4 * 1024 * 1024#0` | scripts/check-citations.ts:5:75 | safety floor |
| `scripts/check-citations.ts:<module>:inline:statSync(document).size > 256 * 1024=256 * 1024#0` | scripts/check-citations.ts:5:31 | safety floor |

### scripts/check-docs.mjs

Path exclusion: `scripts/check-docs.mjs` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/check-docs.mjs:dirtiness:inline:entries.length > 4096=4096#0` | scripts/check-docs.mjs:46:24 | safety floor |
| `scripts/check-docs.mjs:dirtiness:inline:info.size > 4 * 1024 * 1024=4 * 1024 * 1024#0` | scripts/check-docs.mjs:62:89 | safety floor |
| `scripts/check-docs.mjs:timeout:inline:timeout=2000#0` | scripts/check-docs.mjs:20:209 | operational |

### scripts/check-memory-consumer-parity.ts

Path exclusion: `scripts/check-memory-consumer-parity.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/check-memory-consumer-parity.ts:timeout:inline:timeout=15_000#0` | scripts/check-memory-consumer-parity.ts:60:90 | operational |

### scripts/check-roles.ts

Path exclusion: `scripts/check-roles.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/check-roles.ts:<module>:inline:file.slice=-3#0` | scripts/check-roles.ts:7:87 | contract |

### scripts/check.sh

Path exclusion: `scripts/check.sh` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/check.sh:shell:inline:AHUB_CHECK_HANG_S=960#0` | scripts/check.sh:97:57 | test seam |
| `scripts/check.sh:shell:inline:AHUB_CHECK_LOCK_WAIT_S=1800#0` | scripts/check.sh:20:36 | test seam |
| `scripts/check.sh:shell:inline:bun test --timeout=20000#0` | scripts/check.sh:95:70 | operational |
| `scripts/check.sh:shell:inline:sleep=5#0` | scripts/check.sh:28:11 | operational |

### scripts/ci-gates.mjs

Path exclusion: `scripts/ci-gates.mjs` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/ci-gates.mjs:page:inline:value[key].length > 100=100#0` | scripts/ci-gates.mjs:54:69 | contract |

### scripts/ci-reuse.mjs

Path exclusion: `scripts/ci-reuse.mjs` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/ci-reuse.mjs:deadline:inline:deadline=60_000#0` | scripts/ci-reuse.mjs:11:31 | operational |

### scripts/hang-watch.sh

Path exclusion: `scripts/hang-watch.sh` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/hang-watch.sh:shell:inline:head=120#0` | scripts/hang-watch.sh:24:73 | safety floor |
| `scripts/hang-watch.sh:shell:inline:sample=3#0` | scripts/hang-watch.sh:23:21 | operational |
| `scripts/hang-watch.sh:shell:inline:sleep=1#0` | scripts/hang-watch.sh:30:64, scripts/hang-watch.sh:34:9 | operational |
| `scripts/hang-watch.sh:shell:inline:sleep=1#1` | scripts/hang-watch.sh:30:64, scripts/hang-watch.sh:34:9 | operational |
| `scripts/hang-watch.sh:shell:inline:termination attempts=10#0` | scripts/hang-watch.sh:30:32 | operational |

### scripts/overlaps.ts

Path exclusion: `scripts/overlaps.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/overlaps.ts:d:inline:iso.slice=10#0` | scripts/overlaps.ts:36:38 | contract |
| `scripts/overlaps.ts:weekOf:inline:d.toISOString().slice=10#0` | scripts/overlaps.ts:38:35 | contract |

### scripts/pii-screen-eval.ts

Path exclusion: `scripts/pii-screen-eval.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/pii-screen-eval.ts:RECALL_BOUND:constant:RECALL_BOUND=0.9#0` | scripts/pii-screen-eval.ts:14:14 | operational |
| `scripts/pii-screen-eval.ts:max:inline:ms.at=-1#0` | scripts/pii-screen-eval.ts:49:56 | contract |
| `scripts/pii-screen-eval.ts:report:inline:new Date().toISOString().slice=10#0` | scripts/pii-screen-eval.ts:82:81 | contract |

### scripts/seeded-check.ts

Path exclusion: `scripts/seeded-check.ts` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/seeded-check.ts:boundedOutput:inline:output.length > 2_000_000=2_000_000#0` | scripts/seeded-check.ts:72:27 | safety floor |
| `scripts/seeded-check.ts:boundedOutput:inline:output.slice=2_000_000#0` | scripts/seeded-check.ts:72:89 | safety floor |
| `scripts/seeded-check.ts:shardSeeds:inline:count > 64=64#0` | scripts/seeded-check.ts:102:42 | safety floor |
| `scripts/seeded-check.ts:timer:inline:setTimeout=70_000#0` | scripts/seeded-check.ts:65:77 | operational |

### scripts/smoke-acp.ts

Path exclusion: `scripts/smoke-acp.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-acp.ts:<module>:inline:setTimeout=120_000#0` | scripts/smoke-acp.ts:19:63 | operational |

### scripts/smoke-codex-hub.ts

Path exclusion: `scripts/smoke-codex-hub.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-codex-hub.ts:<anonymous>:inline:JSON.stringify(m.params).slice=140#0` | scripts/smoke-codex-hub.ts:17:123 | safety floor |
| `scripts/smoke-codex-hub.ts:<anonymous>:inline:m.line.slice=160#0` | scripts/smoke-codex-hub.ts:7:119 | safety floor |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=100#0` | scripts/smoke-codex-hub.ts:41:56 | operational |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=2500#0` | scripts/smoke-codex-hub.ts:42:17 | operational |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=300#0` | scripts/smoke-codex-hub.ts:38:56 | operational |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=6000#0` | scripts/smoke-codex-hub.ts:26:17 | operational |
| `scripts/smoke-codex-hub.ts:<module>:inline:answer.body.trim().split(\n).slice(-2).join( \| ).slice=-120#0` | scripts/smoke-codex-hub.ts:48:117 | safety floor |
| `scripts/smoke-codex-hub.ts:<module>:inline:answer.body.trim().split(\n).slice=-2#0` | scripts/smoke-codex-hub.ts:48:95 | operational |
| `scripts/smoke-codex-hub.ts:<module>:inline:events.find((e) => e.t === envelope && e.env.from === codex).env.body.slice=160#0` | scripts/smoke-codex-hub.ts:35:114 | safety floor |
| `scripts/smoke-codex-hub.ts:until:inline:Bun.sleep=250#0` | scripts/smoke-codex-hub.ts:22:196 | operational |
| `scripts/smoke-codex-hub.ts:until:inline:ms=180_000#0` | scripts/smoke-codex-hub.ts:22:62 | test seam |

### scripts/smoke-codex.ts

Path exclusion: `scripts/smoke-codex.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-codex.ts:<anonymous>:inline:JSON.stringify(m.params).slice=300#0` | scripts/smoke-codex.ts:27:113 | safety floor |
| `scripts/smoke-codex.ts:<module>:inline:setTimeout=120_000#0` | scripts/smoke-codex.ts:33:60 | operational |

### scripts/smoke-conductor.ts

Path exclusion: `scripts/smoke-conductor.ts` is outside H7 accepted files; 15 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-conductor.ts:<anonymous>:inline:Bun.sleep=250#0` | scripts/smoke-conductor.ts:320:25 | operational |
| `scripts/smoke-conductor.ts:<module>:inline:terminalText((error as Error).message).slice=1000#0` | scripts/smoke-conductor.ts:366:144 | safety floor |
| `scripts/smoke-conductor.ts:<module>:inline:timeoutSeconds < 60=60#0` | scripts/smoke-conductor.ts:32:58 | operational |
| `scripts/smoke-conductor.ts:<module>:inline:timeoutSeconds > 1800=1800#0` | scripts/smoke-conductor.ts:32:81 | operational |
| `scripts/smoke-conductor.ts:approval_wait_s:inline:approval_wait_s=5#0` | scripts/smoke-conductor.ts:245:41 | operational |
| `scripts/smoke-conductor.ts:claudeNative:inline:statSync(transcript).size > 32 * 1024 * 1024=32 * 1024 * 1024#0` | scripts/smoke-conductor.ts:159:131 | safety floor |
| `scripts/smoke-conductor.ts:command:inline:terminalText(err \|\| out).slice=1000#0` | scripts/smoke-conductor.ts:127:63 | safety floor |
| `scripts/smoke-conductor.ts:exited:inline:Bun.sleep=3000#0` | scripts/smoke-conductor.ts:119:81 | operational |
| `scripts/smoke-conductor.ts:idle_min:inline:idle_min=60#0` | scripts/smoke-conductor.ts:246:140 | operational |
| `scripts/smoke-conductor.ts:inputTimer:inline:setInterval=250#0` | scripts/smoke-conductor.ts:116:6 | operational |
| `scripts/smoke-conductor.ts:review_min:inline:review_min=60#0` | scripts/smoke-conductor.ts:246:156 | operational |
| `scripts/smoke-conductor.ts:timeoutSeconds:inline:option(--timeout-s) ?? 1800=1800#0` | scripts/smoke-conductor.ts:31:56 | operational |
| `scripts/smoke-conductor.ts:timeout_s:inline:timeout_s=300#0` | scripts/smoke-conductor.ts:247:73 | operational |
| `scripts/smoke-conductor.ts:unaccepted_min:inline:unaccepted_min=60#0` | scripts/smoke-conductor.ts:246:126 | operational |
| `scripts/smoke-conductor.ts:until:inline:Bun.sleep=1000#0` | scripts/smoke-conductor.ts:135:187 | operational |

### scripts/smoke-ollama.ts

Path exclusion: `scripts/smoke-ollama.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-ollama.ts:max_tokens:inline:max_tokens=128#0` | scripts/smoke-ollama.ts:19:90 | operational |
| `scripts/smoke-ollama.ts:signal:inline:AbortSignal.timeout=120_000#0` | scripts/smoke-ollama.ts:20:33 | operational |

### scripts/smoke-pi-route.ts

Path exclusion: `scripts/smoke-pi-route.ts` is outside H7 accepted files; 7 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-pi-route.ts:<module>:inline:Bun.sleep=100#0` | scripts/smoke-pi-route.ts:29:96 | operational |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=262144#0` | scripts/smoke-pi-route.ts:23:336 | operational |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=8192#0` | scripts/smoke-pi-route.ts:23:292, scripts/smoke-pi-route.ts:23:329 | operational |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=8192#1` | scripts/smoke-pi-route.ts:23:292, scripts/smoke-pi-route.ts:23:329 | operational |
| `scripts/smoke-pi-route.ts:deadline:inline:deadline=120_000#0` | scripts/smoke-pi-route.ts:28:33 | operational |
| `scripts/smoke-pi-route.ts:maxTokens:inline:maxTokens=128#0` | scripts/smoke-pi-route.ts:23:355 | operational |
| `scripts/smoke-pi-route.ts:watchdogMs:inline:watchdogMs=120_000#0` | scripts/smoke-pi-route.ts:23:486 | operational |

### scripts/smoke-recovery-09-10.ts

Path exclusion: `scripts/smoke-recovery-09-10.ts` is outside H7 accepted files; 6 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `scripts/smoke-recovery-09-10.ts:deadline:inline:deadline=15_000#0` | scripts/smoke-recovery-09-10.ts:57:37 | operational |
| `scripts/smoke-recovery-09-10.ts:deadline:inline:deadline=180_000#0` | scripts/smoke-recovery-09-10.ts:147:33 | operational |
| `scripts/smoke-recovery-09-10.ts:main:inline:Bun.sleep=250#0` | scripts/smoke-recovery-09-10.ts:155:21 | operational |
| `scripts/smoke-recovery-09-10.ts:stopOwnedDaemon:inline:Bun.sleep=100#0` | scripts/smoke-recovery-09-10.ts:42:29, scripts/smoke-recovery-09-10.ts:63:25 | operational |
| `scripts/smoke-recovery-09-10.ts:timeoutMs:constant:timeoutMs=45000#0` | scripts/smoke-recovery-09-10.ts:22:7 | operational |
| `scripts/smoke-recovery-09-10.ts:waitForControl:inline:Bun.sleep=100#0` | scripts/smoke-recovery-09-10.ts:42:29, scripts/smoke-recovery-09-10.ts:63:25 | operational |

### src/cli/agents.ts

Path exclusion: `src/cli/agents.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/agents.ts:timeout:inline:timeout=10_000#0` | src/cli/agents.ts:15:94 | operational |

### src/cli/agy-mcp.ts

Path exclusion: `src/cli/agy-mcp.ts` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/agy-mcp.ts:MAX_CONFIG_BYTES:constant:MAX_CONFIG_BYTES=256 * 1024#0` | src/cli/agy-mcp.ts:29:7 | safety floor |
| `src/cli/agy-mcp.ts:timeout:inline:timeout=3000#0` | src/cli/agy-mcp.ts:232:96 | operational |
| `src/cli/agy-mcp.ts:timeout:inline:timeout=5#0` | src/cli/agy-mcp.ts:117:93 | operational |
| `src/cli/agy-mcp.ts:validateOptions:inline:value.length > 4096=4096#0` | src/cli/agy-mcp.ts:60:75 | safety floor |

### src/cli/bench.ts

Path exclusion: `src/cli/bench.ts` is outside H7 accepted files; 18 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/bench.ts:deadline:inline:deadline=started + task.timeout_s * 1000#0` | src/cli/bench.ts:282:20 | contract |
| `src/cli/bench.ts:killMs:inline:killMs=500#0` | src/cli/bench.ts:62:54 | operational |
| `src/cli/bench.ts:metricsOf:inline:opts.pollMs ?? 2000=2000#0` | src/cli/bench.ts:162:35, src/cli/bench.ts:165:33, src/cli/bench.ts:293:35 | test seam |
| `src/cli/bench.ts:metricsOf:inline:opts.pollMs ?? 2000=2000#1` | src/cli/bench.ts:162:35, src/cli/bench.ts:165:33, src/cli/bench.ts:293:35 | test seam |
| `src/cli/bench.ts:reset:inline:paths.length > 5=5#0` | src/cli/bench.ts:130:168 | safety floor |
| `src/cli/bench.ts:reset:inline:paths.slice=5#0` | src/cli/bench.ts:130:137 | safety floor |
| `src/cli/bench.ts:run:inline:new Date(io.now()).toISOString().slice=10#0` | src/cli/bench.ts:190:60 | contract |
| `src/cli/bench.ts:run:inline:randomUUID().slice=8#0` | src/cli/bench.ts:190:107 | contract |
| `src/cli/bench.ts:runAttempt:inline:opts.pollMs ?? 2000=2000#0` | src/cli/bench.ts:162:35, src/cli/bench.ts:165:33, src/cli/bench.ts:293:35 | test seam |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#0` | src/cli/bench.ts:244:114, src/cli/bench.ts:246:103, src/cli/bench.ts:246:169 | contract |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#1` | src/cli/bench.ts:244:114, src/cli/bench.ts:246:103, src/cli/bench.ts:246:169 | contract |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#2` | src/cli/bench.ts:244:114, src/cli/bench.ts:246:103, src/cli/bench.ts:246:169 | contract |
| `src/cli/bench.ts:runBench:inline:now.out.slice=12#0` | src/cli/bench.ts:246:130 | contract |
| `src/cli/bench.ts:setup:inline:opts.setupTimeoutMs ?? 300_000=300_000#0` | src/cli/bench.ts:265:76 | operational |
| `src/cli/bench.ts:sh:inline:Math.max=1#0` | src/cli/bench.ts:59:68 | operational |
| `src/cli/bench.ts:sh:inline:Math.min=200#0` | src/cli/bench.ts:59:54 | operational |
| `src/cli/bench.ts:until:inline:opts.settleMs ?? 600_000=600_000#0` | src/cli/bench.ts:147:46 | operational |
| `src/cli/bench.ts:verify:inline:opts.verifyTimeoutMs ?? 600_000=600_000#0` | src/cli/bench.ts:295:77 | test seam |

### src/cli/completion.ts

Path exclusion: `src/cli/completion.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/completion.ts:value:inline:parts.length >= 3=3#0` | src/cli/completion.ts:46:25 | contract |

### src/cli/console-config.ts

Path exclusion: `src/cli/console-config.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/console-config.ts:text:inline:(current.text + key.replace(/[\x00-\x1f\x7f]/g, )).slice=4000#0` | src/cli/console-config.ts:103:102 | safety floor |

### src/cli/console-review.ts

Path exclusion: `src/cli/console-review.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/console-review.ts:MAX_TITLE:constant:MAX_TITLE=40#0` | src/cli/console-review.ts:8:7 | safety floor |
| `src/cli/console-review.ts:choiceTitle:inline:text.slice=3#0` | src/cli/console-review.ts:15:80 | contract |

### src/cli/console-symbols.ts

Path exclusion: `src/cli/console-symbols.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/console-symbols.ts:MAX_LINES:constant:MAX_LINES=40#0` | src/cli/console-symbols.ts:11:7 | safety floor |
| `src/cli/console-symbols.ts:head:inline:task.codeSymbols.head.slice=8#0` | src/cli/console-symbols.ts:33:161 | contract |

### src/cli/console-usage.ts

Path exclusion: `src/cli/console-usage.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/console-usage.ts:resets:inline:lastResets=3#0` | src/cli/console-usage.ts:67:50 | safety floor |

### src/cli/facts-hook.ts

Path exclusion: `src/cli/facts-hook.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/facts-hook.ts:factsHook:inline:timeoutMs=2000#0` | src/cli/facts-hook.ts:62:92 | test seam |

### src/cli/help.ts

Path exclusion: `src/cli/help.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/help.ts:DESCRIPTION:constant:DESCRIPTION=34#0` | src/cli/help.ts:174:7 | contract |

### src/cli/identity-audit.ts

Path exclusion: `src/cli/identity-audit.ts` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/identity-audit.ts:MAX_BYTES:constant:MAX_BYTES=64 * 1024#0` | src/cli/identity-audit.ts:9:7 | safety floor |
| `src/cli/identity-audit.ts:MAX_FILES:constant:MAX_FILES=256#0` | src/cli/identity-audit.ts:8:7 | safety floor |
| `src/cli/identity-audit.ts:MAX_ROW_BYTES:constant:MAX_ROW_BYTES=512#0` | src/cli/identity-audit.ts:10:7 | safety floor |
| `src/cli/identity-audit.ts:valid:inline:row.command.length <= 64=64#0` | src/cli/identity-audit.ts:16:63 | safety floor |

### src/cli/init.ts

Path exclusion: `src/cli/init.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/init.ts:timeout:inline:timeout=3000#0` | src/cli/init.ts:69:153, src/cli/init.ts:72:158, src/cli/init.ts:166:146, src/cli/init.ts:169:105, src/cli/init.ts:173:148 | operational |
| `src/cli/init.ts:timeout:inline:timeout=3000#1` | src/cli/init.ts:69:153, src/cli/init.ts:72:158, src/cli/init.ts:166:146, src/cli/init.ts:169:105, src/cli/init.ts:173:148 | operational |
| `src/cli/init.ts:timeout:inline:timeout=3000#2` | src/cli/init.ts:69:153, src/cli/init.ts:72:158, src/cli/init.ts:166:146, src/cli/init.ts:169:105, src/cli/init.ts:173:148 | operational |
| `src/cli/init.ts:timeout:inline:timeout=3000#3` | src/cli/init.ts:69:153, src/cli/init.ts:72:158, src/cli/init.ts:166:146, src/cli/init.ts:169:105, src/cli/init.ts:173:148 | operational |
| `src/cli/init.ts:timeout:inline:timeout=3000#4` | src/cli/init.ts:69:153, src/cli/init.ts:72:158, src/cli/init.ts:166:146, src/cli/init.ts:169:105, src/cli/init.ts:173:148 | operational |

### src/cli/kimi-mcp.ts

Path exclusion: `src/cli/kimi-mcp.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/kimi-mcp.ts:timeout:inline:timeout=3000#0` | src/cli/kimi-mcp.ts:37:118 | operational |

### src/cli/launch.ts

Path exclusion: `src/cli/launch.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/launch.ts:<anonymous>:inline:setTimeout=25#0` | src/cli/launch.ts:147:60 | operational |
| `src/cli/launch.ts:bytes:inline:Buffer.alloc=4#0` | src/cli/launch.ts:247:34 | contract |
| `src/cli/launch.ts:deadline:inline:deadline=250#0` | src/cli/launch.ts:132:42 | operational |
| `src/cli/launch.ts:refreshInterval:inline:tee.original?.refreshInterval ?? 10=10#0` | src/cli/launch.ts:300:117 | operational |
| `src/cli/launch.ts:timeout:inline:timeout=5#0` | src/cli/launch.ts:329:179 | operational |

### src/cli/main.ts

Path exclusion: `src/cli/main.ts` is outside H7 accepted files; 43 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/main.ts:"check-path":inline:hub.request=1000#0` | src/cli/main.ts:1923:73 | operational |
| `src/cli/main.ts:<anonymous>:inline:Number(one[--limit]) \|\| 20=20#0` | src/cli/main.ts:1941:78 | operational |
| `src/cli/main.ts:<anonymous>:inline:key.length > 160=160#0` | src/cli/main.ts:1603:313 | contract |
| `src/cli/main.ts:ask:inline:e.text.slice=150#0` | src/cli/main.ts:1469:123 | safety floor |
| `src/cli/main.ts:backlog:inline:args.length >= 3=3#0` | src/cli/main.ts:1165:41 | contract |
| `src/cli/main.ts:backlog:inline:args.length >= 4=4#0` | src/cli/main.ts:1162:141, src/cli/main.ts:1169:48 | contract |
| `src/cli/main.ts:backlog:inline:args.length >= 4=4#1` | src/cli/main.ts:1162:141, src/cli/main.ts:1169:48 | contract |
| `src/cli/main.ts:bench:inline:groups.length < 2=2#0` | src/cli/main.ts:1775:27 | contract |
| `src/cli/main.ts:connect:inline:timeoutMs=3000#0` | src/cli/main.ts:280:36 | test seam |
| `src/cli/main.ts:early:inline:args.length > 2=2#0` | src/cli/main.ts:1332:25, src/cli/main.ts:1377:79, src/cli/main.ts:1552:60 | contract |
| `src/cli/main.ts:id:inline:id=2#0` | src/cli/main.ts:1114:126 | operational |
| `src/cli/main.ts:killOrphan:inline:Bun.sleep=100#0` | src/cli/main.ts:414:70, src/cli/main.ts:423:66 | operational |
| `src/cli/main.ts:killOrphan:inline:Bun.sleep=100#1` | src/cli/main.ts:414:70, src/cli/main.ts:423:66 | operational |
| `src/cli/main.ts:permission:inline:positional.length > 2=2#0` | src/cli/main.ts:1501:29 | contract |
| `src/cli/main.ts:recovery:inline:reason.length > 500=500#0` | src/cli/main.ts:776:38 | safety floor |
| `src/cli/main.ts:request:inline:request=2#0` | src/cli/main.ts:1114:97 | operational |
| `src/cli/main.ts:res:inline:timeoutMs ?? (op === github_import ? 60_000 : 30_000)=30_000#0` | src/cli/main.ts:459:111 | operational |
| `src/cli/main.ts:res:inline:timeoutMs ?? (op === github_import ? 60_000 : 30_000)=60_000#0` | src/cli/main.ts:459:102 | operational |
| `src/cli/main.ts:resetsInMs:inline:resetsInMs=2#0` | src/cli/main.ts:1140:148 | contract |
| `src/cli/main.ts:role:inline:args.length > 3=3#0` | src/cli/main.ts:2109:85 | contract |
| `src/cli/main.ts:sdlc:inline:args.length < 4=4#0` | src/cli/main.ts:1342:117 | contract |
| `src/cli/main.ts:sdlc:inline:args.length < 5=5#0` | src/cli/main.ts:1328:189 | contract |
| `src/cli/main.ts:sdlc:inline:args.length > 2=2#0` | src/cli/main.ts:1332:25, src/cli/main.ts:1377:79, src/cli/main.ts:1552:60 | contract |
| `src/cli/main.ts:sdlc:inline:args.length > 2=2#1` | src/cli/main.ts:1332:25, src/cli/main.ts:1377:79, src/cli/main.ts:1552:60 | contract |
| `src/cli/main.ts:sdlc:inline:args.length > 34=34#0` | src/cli/main.ts:1306:34 | contract |
| `src/cli/main.ts:sdlc:inline:rawReason.length > 2048=2048#0` | src/cli/main.ts:1350:142 | contract |
| `src/cli/main.ts:sdlc:inline:size > 128 * 1024=128 * 1024#0` | src/cli/main.ts:1276:119 | safety floor |
| `src/cli/main.ts:settings:inline:Buffer.byteLength(JSON.stringify(result), utf8) > 131_072=131_072#0` | src/cli/main.ts:1609:67 | safety floor |
| `src/cli/main.ts:settings:inline:String(row.key).slice=160#0` | src/cli/main.ts:1601:147, src/cli/main.ts:1631:149 | safety floor |
| `src/cli/main.ts:settings:inline:String(row.key).slice=160#1` | src/cli/main.ts:1601:147, src/cli/main.ts:1631:149 | safety floor |
| `src/cli/main.ts:settings:inline:String(row.reason).slice=1000#0` | src/cli/main.ts:1601:184, src/cli/main.ts:1631:186 | safety floor |
| `src/cli/main.ts:settings:inline:String(row.reason).slice=1000#1` | src/cli/main.ts:1601:184, src/cli/main.ts:1631:186 | safety floor |
| `src/cli/main.ts:settings:inline:confirmation.keys.length > 200=200#0` | src/cli/main.ts:1603:225 | contract |
| `src/cli/main.ts:settings:inline:confirmation.token.length > 256=256#0` | src/cli/main.ts:1603:125 | safety floor |
| `src/cli/main.ts:settings:inline:result.rejected.slice=100#0` | src/cli/main.ts:1601:88, src/cli/main.ts:1631:90 | safety floor |
| `src/cli/main.ts:settings:inline:result.rejected.slice=100#1` | src/cli/main.ts:1601:88, src/cli/main.ts:1631:90 | safety floor |
| `src/cli/main.ts:settings:inline:row.min ?? 0=0#0` | src/cli/main.ts:1671:208 | contract |
| `src/cli/main.ts:signal:inline:AbortSignal.timeout=30_000#0` | src/cli/main.ts:1625:128 | operational |
| `src/cli/main.ts:startupDiagnostic:inline:message.replace(/[\p{Cc}\p{Cf}]/gu, ).replace(/\s+/g, ).trim().slice=512#0` | src/cli/main.ts:447:88 | safety floor |
| `src/cli/main.ts:timeout:inline:timeout=10_000#0` | src/cli/main.ts:868:73 | operational |
| `src/cli/main.ts:timeout:inline:timeout=2000#0` | src/cli/main.ts:1262:162 | operational |
| `src/cli/main.ts:usage:inline:flags[i]!.slice=40#0` | src/cli/main.ts:1868:103 | safety floor |
| `src/cli/main.ts:usage:inline:limit >= 1=1#0` | src/cli/main.ts:1874:43 | contract |

### src/cli/memory.ts

Path exclusion: `src/cli/memory.ts` is outside H7 accepted files; 8 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/memory.ts:cutoffMs:inline:cutoffMs=(opts.now ?? Date.now)() - days * 24 * 3600_000#0` | src/cli/memory.ts:60:22 | contract |
| `src/cli/memory.ts:days:inline:days=90#0` | src/cli/memory.ts:55:16 | operational |
| `src/cli/memory.ts:memoryCommand:inline:/^[1-9][0-9]*$/.test=2#0` | src/cli/memory.ts:57:83 | contract |
| `src/cli/memory.ts:memoryCommand:inline:Math.abs(cutoffMs) > 8_640_000_000_000_000=8_640_000_000_000_000#0` | src/cli/memory.ts:61:91 | contract |
| `src/cli/memory.ts:profileOutput:inline:profile.generation.slice=8#0` | src/cli/memory.ts:45:139 | contract |
| `src/cli/memory.ts:timeout:inline:timeout=1000#0` | src/cli/memory.ts:200:170 | operational |
| `src/cli/memory.ts:ttlMs:inline:loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14=14#0` | src/cli/memory.ts:88:110 | operational |
| `src/cli/memory.ts:ttlMs:inline:ttlMs=(loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000#0` | src/cli/memory.ts:88:63 | operational |

### src/cli/models-setup.ts

Path exclusion: `src/cli/models-setup.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/models-setup.ts:post:inline:result.error.slice=200#0` | src/cli/models-setup.ts:20:87 | safety floor |
| `src/cli/models-setup.ts:signal:inline:AbortSignal.timeout=10_000#0` | src/cli/models-setup.ts:31:80 | operational |
| `src/cli/models-setup.ts:signal:inline:AbortSignal.timeout=30 * 60_000#0` | src/cli/models-setup.ts:16:63 | operational |

### src/cli/output.ts

Path exclusion: `src/cli/output.ts` is outside H7 accepted files; 9 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/output.ts:<anonymous>:inline:text=0#0` | src/cli/output.ts:132:102 | operational |
| `src/cli/output.ts:<anonymous>:inline:text=1#0` | src/cli/output.ts:132:119 | operational |
| `src/cli/output.ts:<anonymous>:inline:tone=1#0` | src/cli/output.ts:132:144 | operational |
| `src/cli/output.ts:itemChunks:inline:characters(split.at(-1)!).filter(unit => width(unit) > 0).length < 3=3#0` | src/cli/output.ts:75:128 | contract |
| `src/cli/output.ts:pathFloor:inline:columns > 80=80#0` | src/cli/output.ts:126:85 | contract |
| `src/cli/output.ts:pathFloor:inline:pathFloor=12#0` | src/cli/output.ts:126:116 | contract |
| `src/cli/output.ts:shortId:inline:String(id).slice=8#0` | src/cli/output.ts:43:131 | contract |
| `src/cli/output.ts:stageCode:inline:characters(next).slice=9#0` | src/cli/output.ts:283:82 | contract |
| `src/cli/output.ts:units:inline:split.slice=-2#0` | src/cli/output.ts:76:44 | contract |

### src/cli/settings-edit.ts

Path exclusion: `src/cli/settings-edit.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/settings-edit.ts:runSettingsEdit:inline:argv.length > 2=2#0` | src/cli/settings-edit.ts:55:23 | contract |

### src/cli/statusline-tee.ts

Path exclusion: `src/cli/statusline-tee.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/statusline-tee.ts:timeout:inline:timeout=5000#0` | src/cli/statusline-tee.ts:57:90 | operational |

### src/cli/watch.ts

Path exclusion: `src/cli/watch.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/cli/watch.ts:time:inline:new Date(item.at).toISOString().slice=19#0` | src/cli/watch.ts:7:58 | contract |

### src/hub/action-class.ts

Path exclusion: `src/hub/action-class.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/action-class.ts:LIMIT:constant:LIMIT=16384#0` | src/hub/action-class.ts:7:7 | safety floor |
| `src/hub/action-class.ts:boundedArgv:inline:value.length <= 256=256#0` | src/hub/action-class.ts:542:102 | safety floor |
| `src/hub/action-class.ts:classify:inline:depth < 2=2#0` | src/hub/action-class.ts:454:58 | safety floor |
| `src/hub/action-class.ts:classify:inline:words.length > 2=2#0` | src/hub/action-class.ts:518:107 | contract |
| `src/hub/action-class.ts:classify:inline:words[0] ?? =0#0` | src/hub/action-class.ts:498:117 | safety floor |
| `src/hub/action-class.ts:classifyAction:inline:tool.length > 128=128#0` | src/hub/action-class.ts:533:49 | safety floor |
| `src/hub/action-class.ts:commands:inline:words.length + outputs.length > 256=256#0` | src/hub/action-class.ts:163:41 | safety floor |
| `src/hub/action-class.ts:name:inline:text.slice=256#0` | src/hub/action-class.ts:313:67 | safety floor |
| `src/hub/action-class.ts:segmentLimit:inline:++count > 64=64#0` | src/hub/action-class.ts:25:21 | safety floor |
| `src/hub/action-class.ts:sequence:inline:cwd.size >= 128=128#0` | src/hub/action-class.ts:439:39, src/hub/action-class.ts:444:25 | safety floor |
| `src/hub/action-class.ts:sequence:inline:cwd.size >= 128=128#1` | src/hub/action-class.ts:439:39, src/hub/action-class.ts:444:25 | safety floor |

### src/hub/action-policy.ts

Path exclusion: `src/hub/action-policy.ts` is outside H7 accepted files; 7 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/action-policy.ts:"external-write":inline:external-write=5#0` | src/hub/action-policy.ts:5:98 | safety floor |
| `src/hub/action-policy.ts:complete:inline:full.length <= 512=512#0` | src/hub/action-policy.ts:123:73 | safety floor |
| `src/hub/action-policy.ts:destroy:inline:destroy=3#0` | src/hub/action-policy.ts:5:77 | safety floor |
| `src/hub/action-policy.ts:install:inline:install=2#0` | src/hub/action-policy.ts:5:110 | safety floor |
| `src/hub/action-policy.ts:line:inline:full.length > 512=512#0` | src/hub/action-policy.ts:121:82 | safety floor |
| `src/hub/action-policy.ts:line:inline:full.slice=512#0` | src/hub/action-policy.ts:121:102 | safety floor |
| `src/hub/action-policy.ts:title:inline:sanitize(view.title).replace(/[\p{Cc}\p{Cf}]/gu, ).slice=160#0` | src/hub/action-policy.ts:117:114 | safety floor |

### src/hub/activity.ts

Path exclusion: `src/hub/activity.ts` is outside H7 accepted files; 7 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/activity.ts:ActivityRing:inline:maxBytes=256 * 1024#0` | src/hub/activity.ts:36:76 | test seam |
| `src/hub/activity.ts:ActivityRing:inline:maxItems=500#0` | src/hub/activity.ts:36:43 | test seam |
| `src/hub/activity.ts:TEXT_CAP:constant:TEXT_CAP=4096#0` | src/hub/activity.ts:4:7 | safety floor |
| `src/hub/activity.ts:text:inline:u.entries.slice=32#0` | src/hub/activity.ts:29:112 | operational |
| `src/hub/activity.ts:updateActivity:inline:activityText(c.content.text).split(\n).slice=-8#0` | src/hub/activity.ts:24:68 | operational |
| `src/hub/activity.ts:updateActivity:inline:u.content.slice=12#0` | src/hub/activity.ts:19:67 | operational |
| `src/hub/activity.ts:updateActivity:inline:u.locations.slice=12#0` | src/hub/activity.ts:16:78 | safety floor |

### src/hub/ask.ts

Path exclusion: `src/hub/ask.ts` is outside H7 accepted files; 12 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/ask.ts:EVIDENCE_CHARS:constant:EVIDENCE_CHARS=6000#0` | src/hub/ask.ts:46:7 | operational |
| `src/hub/ask.ts:ITEM_CHARS:constant:ITEM_CHARS=300#0` | src/hub/ask.ts:47:7 | operational |
| `src/hub/ask.ts:LOG_TAIL_BYTES:constant:LOG_TAIL_BYTES=256 * 1024#0` | src/hub/ask.ts:49:7 | operational |
| `src/hub/ask.ts:MAX_TASKS:constant:MAX_TASKS=25#0` | src/hub/ask.ts:48:7 | operational |
| `src/hub/ask.ts:answer:inline:raw.slice=2000#0` | src/hub/ask.ts:176:31 | operational |
| `src/hub/ask.ts:id:inline:l.slice=10#0` | src/hub/ask.ts:117:42 | operational |
| `src/hub/ask.ts:id:inline:l.slice=23#0` | src/hub/ask.ts:117:61 | contract |
| `src/hub/ask.ts:matching:inline:thisRunsLog(d.logFile).filter((l) => hit(l) > 0).slice=-12#0` | src/hub/ask.ts:110:75 | operational |
| `src/hub/ask.ts:note:inline:invented.slice=3#0` | src/hub/ask.ts:183:148 | operational |
| `src/hub/ask.ts:prefix:inline:row.id.slice=12#0` | src/hub/ask.ts:128:36 | contract |
| `src/hub/ask.ts:text:inline:l.slice=25#0` | src/hub/ask.ts:117:108 | operational |
| `src/hub/ask.ts:timeoutMs:inline:timeoutMs=45_000#0` | src/hub/ask.ts:173:37 | operational |

### src/hub/bench.ts

Path exclusion: `src/hub/bench.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/bench.ts:<anonymous>:inline:String(r.header.suiteHash ?? ).slice=12#0` | src/hub/bench.ts:188:128 | contract |
| `src/hub/bench.ts:<anonymous>:inline:t.timeout_s < 10=10#0` | src/hub/bench.ts:40:91 | operational |
| `src/hub/bench.ts:<anonymous>:inline:t.timeout_s > 86_400=86_400#0` | src/hub/bench.ts:40:111 | operational |
| `src/hub/bench.ts:HEAD:inline:attempts.padStart=8#0` | src/hub/bench.ts:196:54 | operational |
| `src/hub/bench.ts:HEAD:inline:tokens p50.padStart=10#0` | src/hub/bench.ts:196:188 | operational |
| `src/hub/bench.ts:MIN_ATTEMPTS:constant:MIN_ATTEMPTS=5#0` | src/hub/bench.ts:149:14 | operational |
| `src/hub/bench.ts:benchCompare:inline:resamples=1000#0` | src/hub/bench.ts:156:87 | test seam |
| `src/hub/bench.ts:dur:inline:ms < 120_000=120_000#0` | src/hub/bench.ts:194:61 | operational |
| `src/hub/bench.ts:row:inline:${m.pass}/${m.fail}/${m.timeout}/${m.error}.padStart=11#0` | src/hub/bench.ts:195:188 | operational |
| `src/hub/bench.ts:row:inline:String(m.attempts).padStart=8#0` | src/hub/bench.ts:195:94 | operational |
| `src/hub/bench.ts:row:inline:num(m.tokensMedian).padStart=10#0` | src/hub/bench.ts:195:335 | operational |

### src/hub/budget.ts

Path exclusion: `src/hub/budget.ts` is outside H7 accepted files; 12 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/budget.ts:<anonymous>:inline:this.db.query(INSERT INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES (?, ?, ?, ?, ?, ?, ?)) .run=0#0` | src/hub/budget.ts:177:114 | operational |
| `src/hub/budget.ts:<anonymous>:inline:this.db.query(INSERT INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES (?, ?, ?, ?, ?, ?, ?)) .run=1#0` | src/hub/budget.ts:177:110 | operational |
| `src/hub/budget.ts:FALLBACK_WINDOW_MINS:constant:FALLBACK_WINDOW_MINS=300#0` | src/hub/budget.ts:108:7 | operational |
| `src/hub/budget.ts:HYSTERESIS:constant:HYSTERESIS=0.1#0` | src/hub/budget.ts:95:7 | operational |
| `src/hub/budget.ts:RESET_DROP:constant:RESET_DROP=0.5#0` | src/hub/budget.ts:97:7 | operational |
| `src/hub/budget.ts:RESET_JITTER_MS:constant:RESET_JITTER_MS=15 * 60000#0` | src/hub/budget.ts:103:7 | operational |
| `src/hub/budget.ts:checkpoint_timeout_s:inline:checkpoint_timeout_s=90#0` | src/hub/budget.ts:57:109 | operational |
| `src/hub/budget.ts:poll_min:inline:poll_min=10#0` | src/hub/budget.ts:57:83 | operational |
| `src/hub/budget.ts:reasonWindow:inline:/^(\S+) window at /.exec(reason)?.[1] ?? unknown=1#0` | src/hub/budget.ts:64:85 | operational |
| `src/hub/budget.ts:stale_min:inline:stale_min=30#0` | src/hub/budget.ts:57:69 | operational |
| `src/hub/budget.ts:waitMin:inline:Math.max=0#0` | src/hub/budget.ts:426:66 | operational |
| `src/hub/budget.ts:wait_max_min:inline:wait_max_min=0#0` | src/hub/budget.ts:57:146 | operational |

### src/hub/check-runner.ts

Path exclusion: `src/hub/check-runner.ts` is outside H7 accepted files; 31 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/check-runner.ts:<anonymous>:inline:(stdout + data.toString()).slice=-1_048_576#0` | src/hub/check-runner.ts:85:138 | operational |
| `src/hub/check-runner.ts:<anonymous>:inline:name.slice=-5#0` | src/hub/check-runner.ts:490:100, src/hub/check-runner.ts:495:32 | operational |
| `src/hub/check-runner.ts:<anonymous>:inline:setTimeout=5#0` | src/hub/check-runner.ts:454:68 | operational |
| `src/hub/check-runner.ts:ContainerRunner:inline:setInterval=60_000#0` | src/hub/check-runner.ts:118:72 | operational |
| `src/hub/check-runner.ts:DAY:constant:DAY=86400000#0` | src/hub/check-runner.ts:13:7 | operational |
| `src/hub/check-runner.ts:MAX_OUTPUT:constant:MAX_OUTPUT=1048576#0` | src/hub/check-runner.ts:14:7 | safety floor |
| `src/hub/check-runner.ts:command:inline:limit=15_000#0` | src/hub/check-runner.ts:349:54 | operational |
| `src/hub/check-runner.ts:cut:inline:Buffer.byteLength(result) > 4096=4096#0` | src/hub/check-runner.ts:71:77 | operational |
| `src/hub/check-runner.ts:cut:inline:lines.length > 40=40#0` | src/hub/check-runner.ts:71:43 | operational |
| `src/hub/check-runner.ts:duration_ms:inline:duration_ms=0#0` | src/hub/check-runner.ts:183:76 | operational |
| `src/hub/check-runner.ts:id:inline:name.slice=-5#0` | src/hub/check-runner.ts:490:100, src/hub/check-runner.ts:495:32 | operational |
| `src/hub/check-runner.ts:platform:inline:version.stdout.trim().slice=80#0` | src/hub/check-runner.ts:166:105 | operational |
| `src/hub/check-runner.ts:regularFile:inline:stat.size > 64 * 1024 * 1024=64 * 1024 * 1024#0` | src/hub/check-runner.ts:323:69 | operational |
| `src/hub/check-runner.ts:result:inline:lines.slice=-40#0` | src/hub/check-runner.ts:70:28 | safety floor |
| `src/hub/check-runner.ts:snapshot:inline:bytes > 512 * 1024 * 1024=512 * 1024 * 1024#0` | src/hub/check-runner.ts:284:41 | operational |
| `src/hub/check-runner.ts:snapshot:inline:entries.length > 100_000=100_000#0` | src/hub/check-runner.ts:253:26 | safety floor |
| `src/hub/check-runner.ts:start:inline:request.files.length > 32=32#0` | src/hub/check-runner.ts:177:122 | operational |
| `src/hub/check-runner.ts:start:inline:this.entries.size >= 3=3#0` | src/hub/check-runner.ts:179:30 | safety floor |
| `src/hub/check-runner.ts:timeout:inline:Math.max=1#0` | src/hub/check-runner.ts:81:68, src/hub/check-runner.ts:340:32 | operational |
| `src/hub/check-runner.ts:timeout:inline:Math.min=600_000#0` | src/hub/check-runner.ts:81:80, src/hub/check-runner.ts:340:44 | operational |
| `src/hub/check-runner.ts:timeout:inline:this.options.timeoutMs ?? 600_000=600_000#0` | src/hub/check-runner.ts:340:79 | operational |
| `src/hub/check-runner.ts:timeout:inline:timeout=15_000#0` | src/hub/check-runner.ts:125:151, src/hub/check-runner.ts:281:185 | operational |
| `src/hub/check-runner.ts:timeout:inline:timeout=15_000#1` | src/hub/check-runner.ts:125:151, src/hub/check-runner.ts:281:185 | operational |
| `src/hub/check-runner.ts:timeoutMs:inline:timeoutMs=15_000#0` | src/hub/check-runner.ts:152:70 | operational |
| `src/hub/check-runner.ts:timer:inline:Math.max=1#0` | src/hub/check-runner.ts:81:68, src/hub/check-runner.ts:340:32 | operational |
| `src/hub/check-runner.ts:timer:inline:Math.min=600_000#0` | src/hub/check-runner.ts:81:80, src/hub/check-runner.ts:340:44 | operational |
| `src/hub/check-runner.ts:timer:inline:options.timeoutMs ?? 15_000=15_000#0` | src/hub/check-runner.ts:81:110 | test seam |
| `src/hub/check-runner.ts:timer:inline:this.options.lockPollMs ?? 10_000=10_000#0` | src/hub/check-runner.ts:243:207 | operational |
| `src/hub/check-runner.ts:until:inline:this.options.lockWaitMs ?? 1_800_000=1_800_000#0` | src/hub/check-runner.ts:224:60 | operational |
| `src/hub/check-runner.ts:walk:inline:++count > 100_000=100_000#0` | src/hub/check-runner.ts:298:21 | operational |
| `src/hub/check-runner.ts:walk:inline:size > 1024 * 1024 * 1024=1024 * 1024 * 1024#0` | src/hub/check-runner.ts:311:37 | safety floor |

### src/hub/claude-launch-proof.ts

Path exclusion: `src/hub/claude-launch-proof.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/claude-launch-proof.ts:bytes:inline:Buffer.alloc=16 * 1024 + 1#0` | src/hub/claude-launch-proof.ts:22:32 | operational |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:count > 16 * 1024=16 * 1024#0` | src/hub/claude-launch-proof.ts:24:17 | operational |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:row.executionCwd.length <= 4096=4096#0` | src/hub/claude-launch-proof.ts:28:78 | operational |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:row.launchId.length > 128=128#0` | src/hub/claude-launch-proof.ts:26:118 | operational |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:stat.size > 16 * 1024=16 * 1024#0` | src/hub/claude-launch-proof.ts:21:39 | operational |

### src/hub/cohorts.ts

Path exclusion: `src/hub/cohorts.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/cohorts.ts:MAX_REQUESTS:constant:MAX_REQUESTS=3#0` | src/hub/cohorts.ts:20:14 | operational |
| `src/hub/cohorts.ts:RETRY_MS:constant:RETRY_MS=2000#0` | src/hub/cohorts.ts:22:14 | operational |
| `src/hub/cohorts.ts:join:inline:all.length < 2=2#0` | src/hub/cohorts.ts:109:39 | operational |

### src/hub/config-apply.ts

Path exclusion: `src/hub/config-apply.ts` is outside H7 accepted files; 40 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/config-apply.ts:applies:inline:[classes, stay_switch, signals, constraints, hub_routes, max_switch_prefill_tokens].includes=1#0` | src/hub/config-apply.ts:247:143 | contract |
| `src/hub/config-apply.ts:approval_wait_s:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:approval_wait_s:inline:number=2_147_483_647 / 1000#0` | src/hub/config-apply.ts:133:32, src/hub/config-apply.ts:164:85 | contract |
| `src/hub/config-apply.ts:batch_max:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:batch_max:inline:number=100_000#0` | src/hub/config-apply.ts:156:24, src/hub/config-apply.ts:167:65 | contract |
| `src/hub/config-apply.ts:batch_ms:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:batch_ms:inline:number=2_147_483_647#0` | src/hub/config-apply.ts:151:26, src/hub/config-apply.ts:156:60 | contract |
| `src/hub/config-apply.ts:brief_items:inline:number=10_000#0` | src/hub/config-apply.ts:157:118 | contract |
| `src/hub/config-apply.ts:budgets:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:budgets:inline:number=1000#0` | src/hub/config-apply.ts:152:130 | contract |
| `src/hub/config-apply.ts:contextWindow:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:digest_min_chars:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:digest_min_chars:inline:number=10_000_000#0` | src/hub/config-apply.ts:167:109 | contract |
| `src/hub/config-apply.ts:digest_min_items:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:digest_min_items:inline:number=100_000#0` | src/hub/config-apply.ts:156:24, src/hub/config-apply.ts:167:65 | contract |
| `src/hub/config-apply.ts:inject_tokens:inline:number=1_000_000#0` | src/hub/config-apply.ts:156:97, src/hub/config-apply.ts:157:77 | contract |
| `src/hub/config-apply.ts:maxConcurrency:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:maxConcurrency:inline:number=1024#0` | src/hub/config-apply.ts:170:106 | contract |
| `src/hub/config-apply.ts:min_reviews:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:no_writes_turns:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:number:inline:min=0#0` | src/hub/config-apply.ts:113:23 | test seam |
| `src/hub/config-apply.ts:pair_per_min:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:port:inline:number=65535#0` | src/hub/config-apply.ts:169:144 | contract |
| `src/hub/config-apply.ts:queue_cap:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:queue_cap:inline:number=1_000_000#0` | src/hub/config-apply.ts:156:97, src/hub/config-apply.ts:157:77 | contract |
| `src/hub/config-apply.ts:release_after_min:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:repeat_window_s:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:sender_per_min:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:short_ttl_days:inline:number=1#0` | src/hub/config-apply.ts:156:21, src/hub/config-apply.ts:156:94, src/hub/config-apply.ts:158:28, src/hub/config-apply.ts:167:62, src/hub/config-apply.ts:167:106, src/hub/config-apply.ts:170:27, src/hub/config-apply.ts:170:103, src/hub/config-apply.ts:183:55 | contract |
| `src/hub/config-apply.ts:short_ttl_days:inline:number=3650#0` | src/hub/config-apply.ts:158:31 | contract |
| `src/hub/config-apply.ts:strings:inline:v.length > 1024=1024#0` | src/hub/config-apply.ts:117:72 | contract |
| `src/hub/config-apply.ts:sync_interval_min:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:sync_interval_min:inline:number=1440#0` | src/hub/config-apply.ts:158:73 | contract |
| `src/hub/config-apply.ts:text:inline:v.length > 16_384=16_384#0` | src/hub/config-apply.ts:112:73 | contract |
| `src/hub/config-apply.ts:timerMinutes:inline:number=2_147_483_647 / 60_000#0` | src/hub/config-apply.ts:133:80 | contract |
| `src/hub/config-apply.ts:timerSeconds:inline:number=2_147_483_647 / 1000#0` | src/hub/config-apply.ts:133:32, src/hub/config-apply.ts:164:85 | contract |
| `src/hub/config-apply.ts:wait_max_min:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:watchdog_ms:inline:number=2_147_483_647#0` | src/hub/config-apply.ts:151:26, src/hub/config-apply.ts:156:60 | contract |
| `src/hub/config-apply.ts:wip_limits:inline:number=0#0` | src/hub/config-apply.ts:152:127, src/hub/config-apply.ts:156:57, src/hub/config-apply.ts:158:70, src/hub/config-apply.ts:164:82, src/hub/config-apply.ts:165:172, src/hub/config-apply.ts:171:105, src/hub/config-apply.ts:171:132, src/hub/config-apply.ts:172:95, src/hub/config-apply.ts:182:42, src/hub/config-apply.ts:182:67, src/hub/config-apply.ts:182:126 | contract |
| `src/hub/config-apply.ts:wip_limits:inline:number=32#0` | src/hub/config-apply.ts:171:135 | contract |

### src/hub/config-edit-host.ts

Path exclusion: `src/hub/config-edit-host.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/config-edit-host.ts:REASON_BYTES:constant:REASON_BYTES=400#0` | src/hub/config-edit-host.ts:49:7 | safety floor |
| `src/hub/config-edit-host.ts:backups:inline:configBackups(host.stateDir).slice=10#0` | src/hub/config-edit-host.ts:84:54 | operational |

### src/hub/config-edit.ts

Path exclusion: `src/hub/config-edit.ts` is outside H7 accepted files; 8 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/config-edit.ts:"config.local.json":inline:config.local.json=1024 * 1024#0` | src/hub/config-edit.ts:24:79 | safety floor |
| `src/hub/config-edit.ts:"sdlc.toml":inline:sdlc.toml=64 * 1024#0` | src/hub/config-edit.ts:24:105 | safety floor |
| `src/hub/config-edit.ts:BACKUPS_KEPT:constant:BACKUPS_KEPT=5#0` | src/hub/config-edit.ts:25:14 | operational |
| `src/hub/config-edit.ts:MAX_EDIT_SETS:constant:MAX_EDIT_SETS=16#0` | src/hub/config-edit.ts:22:14 | operational |
| `src/hub/config-edit.ts:MAX_VALUE_BYTES:constant:MAX_VALUE_BYTES=16 * 1024#0` | src/hub/config-edit.ts:23:14 | safety floor |
| `src/hub/config-edit.ts:parseConfigEditRequest:inline:entry.path.length > 6=6#0` | src/hub/config-edit.ts:73:81 | contract |
| `src/hub/config-edit.ts:valueHash:inline:sha(JSON.stringify(canonical(value))).slice=16#0` | src/hub/config-edit.ts:30:137 | contract |
| `src/hub/config-edit.ts:writeConfigEdit:inline:sha(plan.before).slice=8#0` | src/hub/config-edit.ts:265:86 | contract |

### src/hub/config-reload.ts

Path exclusion: `src/hub/config-reload.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/config-reload.ts:<anonymous>:inline:x.length > 4096=4096#0` | src/hub/config-reload.ts:59:141 | contract |
| `src/hub/config-reload.ts:MAX_CONFIG_BYTES:constant:MAX_CONFIG_BYTES=1024 * 1024#0` | src/hub/config-reload.ts:24:7 | safety floor |
| `src/hub/config-reload.ts:number:inline:min=1#0` | src/hub/config-reload.ts:51:51, src/hub/config-reload.ts:70:20 | contract |
| `src/hub/config-reload.ts:numeric:inline:min=1#0` | src/hub/config-reload.ts:51:51, src/hub/config-reload.ts:70:20 | contract |
| `src/hub/config-reload.ts:openValue:inline:depth > 16=16#0` | src/hub/config-reload.ts:62:17 | operational |
| `src/hub/config-reload.ts:openValue:inline:v.length > 1024=1024#0` | src/hub/config-reload.ts:66:49 | safety floor |
| `src/hub/config-reload.ts:openValue:inline:v.length > 16_384=16_384#0` | src/hub/config-reload.ts:63:49 | operational |
| `src/hub/config-reload.ts:peers:inline:v.length > 128=128#0` | src/hub/config-reload.ts:57:41 | safety floor |
| `src/hub/config-reload.ts:strings:inline:v.length > 256=256#0` | src/hub/config-reload.ts:59:86 | contract |
| `src/hub/config-reload.ts:table:inline:Object.keys(v).length > 256=256#0` | src/hub/config-reload.ts:46:84 | operational |
| `src/hub/config-reload.ts:text:inline:v.length > 4096=4096#0` | src/hub/config-reload.ts:50:93 | operational |

### src/hub/config-tier.ts

Path exclusion: `src/hub/config-tier.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/config-tier.ts:<anonymous>:inline:part.length > 64=64#0` | src/hub/config-tier.ts:40:92 | safety floor |

### src/hub/conflicts.ts

Path exclusion: `src/hub/conflicts.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/conflicts.ts:<anonymous>:inline:String(r.title).slice=100#0` | src/hub/conflicts.ts:60:72 | operational |

### src/hub/context-window.ts

Path exclusion: `src/hub/context-window.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/context-window.ts:ContextWindows:inline:cfg.gate > 1=1#0` | src/hub/context-window.ts:35:66 | operational |
| `src/hub/context-window.ts:report:inline:reading.used > 1=1#0` | src/hub/context-window.ts:42:147 | operational |
| `src/hub/context-window.ts:stale_min:inline:stale_min=30#0` | src/hub/context-window.ts:28:69 | operational |

### src/hub/cost-governance.ts

Path exclusion: `src/hub/cost-governance.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/cost-governance.ts:ciReruns:inline:[...attempts.values()].reduce=0#0` | src/hub/cost-governance.ts:61:126 | operational |
| `src/hub/cost-governance.ts:costMetrics:inline:attempts.get(run.id) ?? 0=0#0` | src/hub/cost-governance.ts:56:61 | operational |
| `src/hub/cost-governance.ts:costMetrics:inline:pr.ciRuns.length > 100=100#0` | src/hub/cost-governance.ts:58:41 | operational |
| `src/hub/cost-governance.ts:costMetrics:inline:pr.ciRuns.slice=100#0` | src/hub/cost-governance.ts:54:57 | operational |
| `src/hub/cost-governance.ts:costMetrics:inline:prs.slice=200#0` | src/hub/cost-governance.ts:34:33 | operational |
| `src/hub/cost-governance.ts:costMetrics:inline:run.attempt < 1=1#0` | src/hub/cost-governance.ts:55:110 | contract |
| `src/hub/cost-governance.ts:costMetrics:inline:run.attempt > 10_000=10_000#0` | src/hub/cost-governance.ts:55:129 | safety floor |
| `src/hub/cost-governance.ts:costMetrics:inline:run.id < 1=1#0` | src/hub/cost-governance.ts:55:53 | contract |
| `src/hub/cost-governance.ts:costMetrics:inline:tasks.slice=500#0` | src/hub/cost-governance.ts:41:39 | operational |
| `src/hub/cost-governance.ts:truncated:inline:prs.length > 200=200#0` | src/hub/cost-governance.ts:32:54 | operational |
| `src/hub/cost-governance.ts:truncated:inline:tasks.length > 500=500#0` | src/hub/cost-governance.ts:32:34 | operational |

### src/hub/daemon.ts

Path exclusion: `src/hub/daemon.ts` is outside H7 accepted files; 165 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/daemon.ts:<anonymous>:inline:Bun.sleep=0#0` | src/hub/daemon.ts:6281:78 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:Date.now() - o.at > 60_000=60_000#0` | src/hub/daemon.ts:1711:104 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:Math.min=50#0` | src/hub/daemon.ts:6140:58 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:Math.min=delay * 2#0` | src/hub/daemon.ts:6140:62 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:String(view.detail).slice=1000#0` | src/hub/daemon.ts:2749:224 | safety floor |
| `src/hub/daemon.ts:<anonymous>:inline:e.env.body.slice=200#0` | src/hub/daemon.ts:3627:171 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:m.slice=8#0` | src/hub/daemon.ts:1133:336 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:sanitize((error as Error).message).slice=160#0` | src/hub/daemon.ts:2284:105 | safety floor |
| `src/hub/daemon.ts:<anonymous>:inline:selected.slice=100#0` | src/hub/daemon.ts:6439:48 | operational |
| `src/hub/daemon.ts:<anonymous>:inline:uiEvents.length > 200=200#0` | src/hub/daemon.ts:3449:27 | operational |
| `src/hub/daemon.ts:admit:inline:reviewPolicies.size >= 64=64#0` | src/hub/daemon.ts:4569:38 | operational |
| `src/hub/daemon.ts:approvalAgeMs:inline:approvalAgeMs=(config.conductor?.approval_wait_s ?? 30) * 1000#0` | src/hub/daemon.ts:1276:26 | operational |
| `src/hub/daemon.ts:approvalAgeMs:inline:config.conductor?.approval_wait_s ?? 30=30#0` | src/hub/daemon.ts:1276:64 | operational |
| `src/hub/daemon.ts:approval_wait_s:inline:approval_wait_s=30#0` | src/hub/daemon.ts:253:46 | operational |
| `src/hub/daemon.ts:armRecoveryLease:inline:delayMs=10 * 60_000#0` | src/hub/daemon.ts:1044:39 | operational |
| `src/hub/daemon.ts:attempt:inline:attempt=0#0` | src/hub/daemon.ts:1235:26 | operational |
| `src/hub/daemon.ts:batch_max:inline:batch_max=3#0` | src/hub/daemon.ts:247:14 | operational |
| `src/hub/daemon.ts:batch_ms:inline:batch_ms=15_000#0` | src/hub/daemon.ts:248:13 | operational |
| `src/hub/daemon.ts:brief_items:inline:brief_items=8#0` | src/hub/daemon.ts:250:62 | operational |
| `src/hub/daemon.ts:changeRosterSetting:inline:setTimeout=100#0` | src/hub/daemon.ts:5261:242, src/hub/daemon.ts:6777:51 | operational |
| `src/hub/daemon.ts:checkCapability:inline:factsFor(peer).pending(peer).filter((o) => !o.done && Date.now() - o.at > 60_000).length >= 3=3#0` | src/hub/daemon.ts:1711:122 | operational |
| `src/hub/daemon.ts:checkTimeoutS:inline:Math.min=3600#0` | src/hub/daemon.ts:1307:137 | operational |
| `src/hub/daemon.ts:checkTimeoutS:inline:checkTimeoutS=600#0` | src/hub/daemon.ts:1307:145 | operational |
| `src/hub/daemon.ts:checkTimeoutS:inline:config.checks.timeout_s >= 1=1#0` | src/hub/daemon.ts:1307:99 | operational |
| `src/hub/daemon.ts:claudeUsageTimer:inline:setInterval=2000#0` | src/hub/daemon.ts:2989:60 | operational |
| `src/hub/daemon.ts:contextWindow:inline:config.mlx.contextWindow ?? 8192=8192#0` | src/hub/daemon.ts:4319:256 | operational |
| `src/hub/daemon.ts:contextWindow:inline:contextWindow=8192#0` | src/hub/daemon.ts:259:125 | operational |
| `src/hub/daemon.ts:deadline:inline:deadline=2000#0` | src/hub/daemon.ts:6128:45 | operational |
| `src/hub/daemon.ts:deadline:inline:deadline=25_000#0` | src/hub/daemon.ts:2449:37 | operational |
| `src/hub/daemon.ts:delay:inline:delay=5#0` | src/hub/daemon.ts:6129:27 | operational |
| `src/hub/daemon.ts:drainCliAuditsNow:inline:retainedCliAudits.size > 4096=4096#0` | src/hub/daemon.ts:2225:36 | operational |
| `src/hub/daemon.ts:ensurePreface:inline:recallMemoryLines=30#0` | src/hub/daemon.ts:1209:214 | operational |
| `src/hub/daemon.ts:error:inline:(error as Error).message.slice=120#0` | src/hub/daemon.ts:1972:147, src/hub/daemon.ts:6663:133 | operational |
| `src/hub/daemon.ts:every:inline:config.memory.sync_interval_min ?? 10=10#0` | src/hub/daemon.ts:6793:54 | operational |
| `src/hub/daemon.ts:fileSdlc:inline:sanitize((error as Error).message).slice=300#0` | src/hub/daemon.ts:5437:199 | operational |
| `src/hub/daemon.ts:first:inline:setTimeout=5_000#0` | src/hub/daemon.ts:6795:54 | operational |
| `src/hub/daemon.ts:generation:inline:publicStatus.generation.slice=8#0` | src/hub/daemon.ts:1096:160 | operational |
| `src/hub/daemon.ts:goalLine:inline:g.id.slice=8#0` | src/hub/daemon.ts:1133:59 | contract |
| `src/hub/daemon.ts:goalLine:inline:g.lease.holder.slice=8#0` | src/hub/daemon.ts:1133:213 | operational |
| `src/hub/daemon.ts:goals:inline:goals.slice=50#0` | src/hub/daemon.ts:4764:56 | operational |
| `src/hub/daemon.ts:heartbeat:inline:Math.max=10#0` | src/hub/daemon.ts:5916:174 | operational |
| `src/hub/daemon.ts:heartbeat:inline:Math.min=1000#0` | src/hub/daemon.ts:5916:187 | operational |
| `src/hub/daemon.ts:hits:inline:screenMemory(memoryStore!.list({ project: memoryProject, limit: Number.MAX_SAFE_INTEGER })).map((v) => [v, score(v)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice=6#0` | src/hub/daemon.ts:6586:215 | operational |
| `src/hub/daemon.ts:hops:inline:hops=1#0` | src/hub/daemon.ts:4756:39 | operational |
| `src/hub/daemon.ts:hops:inline:hops=2#0` | src/hub/daemon.ts:4756:35 | operational |
| `src/hub/daemon.ts:hubTokenWindow:inline:hubTokenWindows.set=5 * 3_600_000#0` | src/hub/daemon.ts:2193:128 | operational |
| `src/hub/daemon.ts:id:inline:randomUUID().slice=8#0` | src/hub/daemon.ts:3693:38 | contract |
| `src/hub/daemon.ts:importantWaitingStatus:inline:Date.now() - since < config.budget.stale_min * 60_000=60_000#0` | src/hub/daemon.ts:2858:79 | operational |
| `src/hub/daemon.ts:inject_tokens:inline:inject_tokens=2000#0` | src/hub/daemon.ts:250:43 | operational |
| `src/hub/daemon.ts:instance:inline:instanceId.slice=8#0` | src/hub/daemon.ts:1619:134, src/hub/daemon.ts:1643:129 | contract |
| `src/hub/daemon.ts:instance:inline:instanceId.slice=8#1` | src/hub/daemon.ts:1619:134, src/hub/daemon.ts:1643:129 | contract |
| `src/hub/daemon.ts:interval:inline:interval=100#0` | src/hub/daemon.ts:6780:52 | operational |
| `src/hub/daemon.ts:intervals:inline:opts.bandsEveryMs ?? 300_000=300_000#0` | src/hub/daemon.ts:2285:29 | test seam |
| `src/hub/daemon.ts:intervals:inline:setInterval=1000#0` | src/hub/daemon.ts:2268:8 | operational |
| `src/hub/daemon.ts:intervals:inline:setInterval=10_000#0` | src/hub/daemon.ts:2270:34 | operational |
| `src/hub/daemon.ts:intervals:inline:setInterval=30_000#0` | src/hub/daemon.ts:2269:38, src/hub/daemon.ts:2293:84 | operational |
| `src/hub/daemon.ts:intervals:inline:setInterval=30_000#1` | src/hub/daemon.ts:2269:38, src/hub/daemon.ts:2293:84 | operational |
| `src/hub/daemon.ts:intervals:inline:setInterval=5_000#0` | src/hub/daemon.ts:2291:8, src/hub/daemon.ts:2309:8 | operational |
| `src/hub/daemon.ts:intervals:inline:setInterval=5_000#1` | src/hub/daemon.ts:2291:8, src/hub/daemon.ts:2309:8 | operational |
| `src/hub/daemon.ts:kill:inline:setTimeout=5000#0` | src/hub/daemon.ts:3645:49 | operational |
| `src/hub/daemon.ts:latencyMs:inline:Math.max=0#0` | src/hub/daemon.ts:2001:145, src/hub/daemon.ts:3726:36 | operational |
| `src/hub/daemon.ts:leases:inline:setInterval=10 * 60_000#0` | src/hub/daemon.ts:6792:48 | operational |
| `src/hub/daemon.ts:limit:inline:limit=100#0` | src/hub/daemon.ts:4801:63 | operational |
| `src/hub/daemon.ts:limit:inline:limit=50#0` | src/hub/daemon.ts:4759:250 | operational |
| `src/hub/daemon.ts:listener:inline:setTimeout=100#0` | src/hub/daemon.ts:5261:242, src/hub/daemon.ts:6777:51 | operational |
| `src/hub/daemon.ts:maxConcurrency:inline:maxConcurrency=1#0` | src/hub/daemon.ts:259:186 | operational |
| `src/hub/daemon.ts:maxInputTokens:inline:maxInputTokens=16_000#0` | src/hub/daemon.ts:426:117 | operational |
| `src/hub/daemon.ts:maxInputTokens:inline:maxInputTokens=6000#0` | src/hub/daemon.ts:259:147 | operational |
| `src/hub/daemon.ts:maxLeaseMs:inline:maxLeaseMs=10 * 60_000#0` | src/hub/daemon.ts:5546:84 | operational |
| `src/hub/daemon.ts:maxTokens:inline:Math.min=8192#0` | src/hub/daemon.ts:4319:445 | operational |
| `src/hub/daemon.ts:maxTokens:inline:config.mlx.maxTokens ?? 2048=2048#0` | src/hub/daemon.ts:4319:439, src/hub/daemon.ts:4319:503 | operational |
| `src/hub/daemon.ts:maxTokens:inline:config.mlx.maxTokens ?? 2048=2048#1` | src/hub/daemon.ts:4319:439, src/hub/daemon.ts:4319:503 | operational |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=2048#0` | src/hub/daemon.ts:259:164, src/hub/daemon.ts:426:136 | operational |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=2048#1` | src/hub/daemon.ts:259:164, src/hub/daemon.ts:426:136 | operational |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=8192#0` | src/hub/daemon.ts:4319:399, src/hub/daemon.ts:4319:511 | operational |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=8192#1` | src/hub/daemon.ts:4319:399, src/hub/daemon.ts:4319:511 | operational |
| `src/hub/daemon.ts:memoryLine:inline:${v.title ? ${v.title}: : }${v.text}.replace(/\s+/g, ).slice=160#0` | src/hub/daemon.ts:1127:163 | operational |
| `src/hub/daemon.ts:memoryLine:inline:v.id.slice=8#0` | src/hub/daemon.ts:1127:62 | contract |
| `src/hub/daemon.ts:message:inline:sanitize(error instanceof Error ? error.message : configuration reload could not be confirmed).slice=600#0` | src/hub/daemon.ts:5121:129 | operational |
| `src/hub/daemon.ts:min_reviews:inline:min_reviews=5#0` | src/hub/daemon.ts:273:43 | operational |
| `src/hub/daemon.ts:ms:inline:Math.max=0#0` | src/hub/daemon.ts:2001:145, src/hub/daemon.ts:3726:36 | operational |
| `src/hub/daemon.ts:ms:inline:Math.max=1#0` | src/hub/daemon.ts:2031:56 | operational |
| `src/hub/daemon.ts:ms:inline:Math.min=250#0` | src/hub/daemon.ts:2031:68 | operational |
| `src/hub/daemon.ts:ms:inline:ms=250#0` | src/hub/daemon.ts:2031:87 | operational |
| `src/hub/daemon.ts:near:inline:screenMemory(memoryStore!.related(memoryProject, [...new Set(hits.flatMap((v) => v.about))], Number.MAX_SAFE_INTEGER)).slice=6#0` | src/hub/daemon.ts:6587:154 | operational |
| `src/hub/daemon.ts:note:inline:${c.title ?? }\n${c.text}.slice=600#0` | src/hub/daemon.ts:1170:164 | operational |
| `src/hub/daemon.ts:note:inline:${v.title ?? }\n${v.text}.slice=1500#0` | src/hub/daemon.ts:1170:71 | operational |
| `src/hub/daemon.ts:offerFor:inline:factsFor(peer).pending(peer).filter((o) => !o.done).length >= 3=3#0` | src/hub/daemon.ts:1723:93 | operational |
| `src/hub/daemon.ts:onMessage:inline:(msg.limit as number) >= 1=1#0` | src/hub/daemon.ts:6649:102 | operational |
| `src/hub/daemon.ts:onMessage:inline:(msg.liveIssues ?? []).length > 32=32#0` | src/hub/daemon.ts:6402:119 | operational |
| `src/hub/daemon.ts:onMessage:inline:msg.id.length > 256=256#0` | src/hub/daemon.ts:5970:70 | operational |
| `src/hub/daemon.ts:onMessage:inline:msg.launchId.length <= 128=128#0` | src/hub/daemon.ts:5868:74 | operational |
| `src/hub/daemon.ts:onMessage:inline:msg.reason.length > 2000=2000#0` | src/hub/daemon.ts:5954:91, src/hub/daemon.ts:5975:231 | operational |
| `src/hub/daemon.ts:onMessage:inline:msg.reason.length > 2000=2000#1` | src/hub/daemon.ts:5954:91, src/hub/daemon.ts:5975:231 | operational |
| `src/hub/daemon.ts:onMessage:inline:setTimeout=0#0` | src/hub/daemon.ts:5677:120, src/hub/daemon.ts:6673:113 | operational |
| `src/hub/daemon.ts:onResult:inline:checkBindings.size > 200=200#0` | src/hub/daemon.ts:1364:35 | operational |
| `src/hub/daemon.ts:onUnavailable:inline:sanitize(reason).slice=1000#0` | src/hub/daemon.ts:4583:69 | operational |
| `src/hub/daemon.ts:onUnavailable:inline:sanitize(reason).slice=300#0` | src/hub/daemon.ts:4582:102 | operational |
| `src/hub/daemon.ts:openWatchPane:inline:watchOpening.get(peer) ?? 0=0#0` | src/hub/daemon.ts:3813:49 | operational |
| `src/hub/daemon.ts:orphanWatch:inline:opts.orphanWatchMs ?? 10_000=10_000#0` | src/hub/daemon.ts:6761:28 | test seam |
| `src/hub/daemon.ts:owners:inline:msg.owners.filter((o: unknown): o is string => typeof o === string).slice=20#0` | src/hub/daemon.ts:6342:131 | operational |
| `src/hub/daemon.ts:peerArg:inline:JSON.stringify(v).slice=60#0` | src/hub/daemon.ts:2391:127 | operational |
| `src/hub/daemon.ts:platformContext:inline:trimToTokens=800#0` | src/hub/daemon.ts:1902:208 | operational |
| `src/hub/daemon.ts:pollUsageRollup:inline:(error as Error).message.slice=120#0` | src/hub/daemon.ts:1972:147, src/hub/daemon.ts:6663:133 | operational |
| `src/hub/daemon.ts:prepareConfiguration:inline:guarded.length > 200=200#0` | src/hub/daemon.ts:5002:105 | safety floor |
| `src/hub/daemon.ts:prepareConfiguration:inline:key.length > 160=160#0` | src/hub/daemon.ts:4973:28 | operational |
| `src/hub/daemon.ts:prepareReviewBrief:inline:reviewSymbols.size > 64=64#0` | src/hub/daemon.ts:1494:32 | operational |
| `src/hub/daemon.ts:project:inline:chain.at=-1#0` | src/hub/daemon.ts:6590:29 | operational |
| `src/hub/daemon.ts:projectKey:inline:createHash(sha256).update(realPath(opts.cwd)).digest(hex).slice=24#0` | src/hub/daemon.ts:1355:88 | contract |
| `src/hub/daemon.ts:queue_cap:inline:queue_cap=200#0` | src/hub/daemon.ts:249:14 | operational |
| `src/hub/daemon.ts:readTranscript:inline:injected.size > 512=512#0` | src/hub/daemon.ts:1755:33 | operational |
| `src/hub/daemon.ts:reading:inline:Math.abs(Date.now() - at) > 1000=1000#0` | src/hub/daemon.ts:1910:218 | operational |
| `src/hub/daemon.ts:reason:inline:p.trace.at(-1)!.replace(/^ {2}unknown: /, ).slice=200#0` | src/hub/daemon.ts:1579:270 | operational |
| `src/hub/daemon.ts:reason:inline:sanitize(e.reason ?? delivery retries exhausted).replace(/\s+/g, ).slice=300#0` | src/hub/daemon.ts:3617:166 | operational |
| `src/hub/daemon.ts:reason:inline:sanitize(error.message).slice=1000#0` | src/hub/daemon.ts:4593:153 | safety floor |
| `src/hub/daemon.ts:reason:inline:sanitize(msg.reason).replace(/\s+/g, ).trim().slice=300#0` | src/hub/daemon.ts:5994:115 | safety floor |
| `src/hub/daemon.ts:recordConflictLink:inline:recentConflicts.length > 12=12#0` | src/hub/daemon.ts:3256:34 | operational |
| `src/hub/daemon.ts:recoveryOp:inline:msg.operationId.length > 128=128#0` | src/hub/daemon.ts:5601:103 | operational |
| `src/hub/daemon.ts:recoveryOp:inline:setTimeout=0#0` | src/hub/daemon.ts:5677:120, src/hub/daemon.ts:6673:113 | operational |
| `src/hub/daemon.ts:releaseOwners:inline:Date.now() - since < limit * 60_000=60_000#0` | src/hub/daemon.ts:3236:40 | operational |
| `src/hub/daemon.ts:releaseTimer:inline:setInterval=60_000#0` | src/hub/daemon.ts:3241:68, src/hub/daemon.ts:6796:63 | operational |
| `src/hub/daemon.ts:release_after_min:inline:release_after_min=30#0` | src/hub/daemon.ts:263:31 | operational |
| `src/hub/daemon.ts:renewLeases:inline:Date.parse(g.lease.until!) - Date.now() > DEFAULT_LEASE_MS / 2=DEFAULT_LEASE_MS / 2#0` | src/hub/daemon.ts:1149:73 | operational |
| `src/hub/daemon.ts:requested:inline:opts.snapshotBurstMs ?? 250=250#0` | src/hub/daemon.ts:2030:49 | operational |
| `src/hub/daemon.ts:rescheduleSweep:inline:setInterval=sweep.interval_s * 1000#0` | src/hub/daemon.ts:2320:10 | operational |
| `src/hub/daemon.ts:researchGraceMs:inline:opts.researchGraceMs ?? 10_000=10_000#0` | src/hub/daemon.ts:812:51 | test seam |
| `src/hub/daemon.ts:retainedConfigAfterReload:inline:sanitize(row.key).slice=160#0` | src/hub/daemon.ts:721:69 | operational |
| `src/hub/daemon.ts:retainedConfigAfterReload:inline:sanitize(row.reason).slice=1200#0` | src/hub/daemon.ts:721:105 | operational |
| `src/hub/daemon.ts:retryAfter:inline:retryAfter=30_000#0` | src/hub/daemon.ts:3384:79 | operational |
| `src/hub/daemon.ts:running:inline:tasks.wipLimit=2#0` | src/hub/daemon.ts:5157:140 | operational |
| `src/hub/daemon.ts:runs:inline:runs.slice=20#0` | src/hub/daemon.ts:4736:45 | operational |
| `src/hub/daemon.ts:sessionId:inline:msg.sessionId.slice=128#0` | src/hub/daemon.ts:6170:103 | operational |
| `src/hub/daemon.ts:settle:inline:id=0#0` | src/hub/daemon.ts:3347:54 | operational |
| `src/hub/daemon.ts:settle:inline:mine[0] && tasks.silentFor(mine[0].id)=0#0` | src/hub/daemon.ts:3347:27 | operational |
| `src/hub/daemon.ts:shown:inline:open.filter((task) => !tasks.isPii(task)).slice=20#0` | src/hub/daemon.ts:5389:72 | operational |
| `src/hub/daemon.ts:startPeerBody:inline:setTimeout=30_000#0` | src/hub/daemon.ts:3992:62 | operational |
| `src/hub/daemon.ts:suite:inline:rs[0]!.header.suiteHash.slice=8#0` | src/hub/daemon.ts:4737:154 | contract |
| `src/hub/daemon.ts:taskOpBody:inline:a.delivery_id.length > 256=256#0` | src/hub/daemon.ts:2517:234 | safety floor |
| `src/hub/daemon.ts:taskOpBody:inline:a.files.length > 32=32#0` | src/hub/daemon.ts:2479:101 | safety floor |
| `src/hub/daemon.ts:taskOpBody:inline:a.reason.length > 2000=2000#0` | src/hub/daemon.ts:2580:127 | safety floor |
| `src/hub/daemon.ts:taskOpBody:inline:a.release.length > 100=100#0` | src/hub/daemon.ts:2634:81 | safety floor |
| `src/hub/daemon.ts:taskOpBody:inline:a.superseded_by.length > 2000=2000#0` | src/hub/daemon.ts:2581:139 | safety floor |
| `src/hub/daemon.ts:terminalLaunchTimer:inline:setInterval=1_000#0` | src/hub/daemon.ts:2841:89 | operational |
| `src/hub/daemon.ts:text:inline:String(msg.question).slice=300#0` | src/hub/daemon.ts:6604:126 | operational |
| `src/hub/daemon.ts:text:inline:max=200#0` | src/hub/daemon.ts:4752:39 | safety floor |
| `src/hub/daemon.ts:text:inline:res.evidence.map((e) => e.id).join(, ).slice=600#0` | src/hub/daemon.ts:6604:217 | operational |
| `src/hub/daemon.ts:text:inline:v.text.slice=600#0` | src/hub/daemon.ts:4760:229 | operational |
| `src/hub/daemon.ts:timeoutMs:inline:Math.min=15_000#0` | src/hub/daemon.ts:2459:154 | operational |
| `src/hub/daemon.ts:timeoutMs:inline:opts.permissionTimeoutMs ?? approvalTimeoutS * 1000=approvalTimeoutS * 1000#0` | src/hub/daemon.ts:3699:51 | operational |
| `src/hub/daemon.ts:timeout_s:inline:timeout_s=120#0` | src/hub/daemon.ts:262:27 | operational |
| `src/hub/daemon.ts:timeout_s:inline:timeout_s=600#0` | src/hub/daemon.ts:265:24 | operational |
| `src/hub/daemon.ts:timer:inline:setInterval=60_000#0` | src/hub/daemon.ts:3241:68, src/hub/daemon.ts:6796:63 | operational |
| `src/hub/daemon.ts:timer:inline:setTimeout=config.budget.checkpoint_timeout_s * 1000#0` | src/hub/daemon.ts:1871:55 | contract |
| `src/hub/daemon.ts:title:inline:String(msg.question).slice=80#0` | src/hub/daemon.ts:6603:78 | operational |
| `src/hub/daemon.ts:tool:inline:msg.tool.slice=64#0` | src/hub/daemon.ts:6167:71 | operational |
| `src/hub/daemon.ts:toolUseId:inline:msg.toolUseId.slice=128#0` | src/hub/daemon.ts:6169:103 | operational |
| `src/hub/daemon.ts:trace:inline:p.trace.slice(1).map((l) => l.trim()).slice=10#0` | src/hub/daemon.ts:1579:338 | operational |
| `src/hub/daemon.ts:truncated:inline:selected.length > 100=100#0` | src/hub/daemon.ts:6444:92 | operational |
| `src/hub/daemon.ts:ttlMs:inline:config.memory.short_ttl_days ?? 14=14#0` | src/hub/daemon.ts:1082:140 | operational |
| `src/hub/daemon.ts:ttlMs:inline:ttlMs=(config.memory.short_ttl_days ?? 14) * 24 * 3600_000#0` | src/hub/daemon.ts:1082:107 | operational |
| `src/hub/daemon.ts:uiAction:inline:a.to.length > 32=32#0` | src/hub/daemon.ts:5474:74 | operational |
| `src/hub/daemon.ts:uiAction:inline:liveIssues.length > 32=32#0` | src/hub/daemon.ts:5455:91 | operational |
| `src/hub/daemon.ts:usagePollMs:inline:usagePollMs=60_000#0` | src/hub/daemon.ts:4238:47 | operational |
| `src/hub/daemon.ts:wait_max_min:inline:wait_max_min=30#0` | src/hub/daemon.ts:462:55 | operational |
| `src/hub/daemon.ts:wipLimit:inline:wipLimit=1#0` | src/hub/daemon.ts:1464:110 | operational |

### src/hub/db-timeout.ts

Path exclusion: `src/hub/db-timeout.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/db-timeout.ts:HUB_DB_BUSY_TIMEOUT_MS:constant:HUB_DB_BUSY_TIMEOUT_MS=3000#0` | src/hub/db-timeout.ts:3:14 | operational |

### src/hub/deliverable-files.ts

Path exclusion: `src/hub/deliverable-files.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/deliverable-files.ts:CHUNK:constant:CHUNK=1024 * 1024#0` | src/hub/deliverable-files.ts:29:7 | operational |
| `src/hub/deliverable-files.ts:locate:inline:(error as Error).message.replace(path, the path).slice=160#0` | src/hub/deliverable-files.ts:47:99 | safety floor |

### src/hub/dogfood-read.ts

Path exclusion: `src/hub/dogfood-read.ts` is outside H7 accepted files; 20 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/dogfood-read.ts:<anonymous>:inline:collected.length>100=100#0` | src/hub/dogfood-read.ts:138:32 | operational |
| `src/hub/dogfood-read.ts:<anonymous>:inline:part.workflow_runs.length>100=100#0` | src/hub/dogfood-read.ts:132:90 | operational |
| `src/hub/dogfood-read.ts:DOGFOOD_BYTE_CAP:constant:DOGFOOD_BYTE_CAP=16 * 1024 * 1024#0` | src/hub/dogfood-read.ts:10:14 | safety floor |
| `src/hub/dogfood-read.ts:MAX_CI_HEADS:constant:MAX_CI_HEADS=8#0` | src/hub/dogfood-read.ts:11:38 | operational |
| `src/hub/dogfood-read.ts:MAX_CI_READS:constant:MAX_CI_READS=32#0` | src/hub/dogfood-read.ts:11:56 | operational |
| `src/hub/dogfood-read.ts:MAX_PRS:constant:MAX_PRS=16#0` | src/hub/dogfood-read.ts:11:24 | operational |
| `src/hub/dogfood-read.ts:MAX_TASKS:constant:MAX_TASKS=500#0` | src/hub/dogfood-read.ts:11:7 | operational |
| `src/hub/dogfood-read.ts:at:inline:line.slice=24#0` | src/hub/dogfood-read.ts:194:32 | operational |
| `src/hub/dogfood-read.ts:complete:inline:list.length < 100=100#0` | src/hub/dogfood-read.ts:110:32 | operational |
| `src/hub/dogfood-read.ts:connection:inline:value.nodes.length <= 100=100#0` | src/hub/dogfood-read.ts:98:149 | safety floor |
| `src/hub/dogfood-read.ts:deadline:inline:deadline=20000#0` | src/hub/dogfood-read.ts:102:40 | operational |
| `src/hub/dogfood-read.ts:digests:inline:rows.slice=10000#0` | src/hub/dogfood-read.ts:94:74, src/hub/dogfood-read.ts:94:133 | operational |
| `src/hub/dogfood-read.ts:dogfoodJournal:inline:rows.length<=10000=10000#0` | src/hub/dogfood-read.ts:94:199 | operational |
| `src/hub/dogfood-read.ts:dogfoodLines:inline:cap < 1=1#0` | src/hub/dogfood-read.ts:20:45 | operational |
| `src/hub/dogfood-read.ts:dogfoodTasks:inline:history.length > 4096=4096#0` | src/hub/dogfood-read.ts:72:30 | operational |
| `src/hub/dogfood-read.ts:gh:inline:cap ?? 128*1024=128*1024#0` | src/hub/dogfood-read.ts:104:102 | operational |
| `src/hub/dogfood-read.ts:gh:inline:timeout ?? 5000=5000#0` | src/hub/dogfood-read.ts:104:48 | operational |
| `src/hub/dogfood-read.ts:held:inline:rows.slice=10000#0` | src/hub/dogfood-read.ts:94:74, src/hub/dogfood-read.ts:94:133 | operational |
| `src/hub/dogfood-read.ts:text:inline:dogfoodLines=128*1024#0` | src/hub/dogfood-read.ts:175:34 | safety floor |
| `src/hub/dogfood-read.ts:validRun:inline:r.pull_requests.length <= 100=100#0` | src/hub/dogfood-read.ts:117:68 | operational |

### src/hub/dogfood.ts

Path exclusion: `src/hub/dogfood.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/dogfood.ts:bugObservationDays:inline:Math.max=0#0` | src/hub/dogfood.ts:99:49 | operational |
| `src/hub/dogfood.ts:bugObservationDays:inline:Math.min=14#0` | src/hub/dogfood.ts:99:36 | operational |
| `src/hub/dogfood.ts:formatDogfood:inline:JSON.stringify=2#0` | src/hub/dogfood.ts:162:85 | contract |

### src/hub/events.ts

Path exclusion: `src/hub/events.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/events.ts:EVENTS_SCHEMA:constant:EVENTS_SCHEMA=1#0` | src/hub/events.ts:9:14 | contract |

### src/hub/github-import.ts

Path exclusion: `src/hub/github-import.ts` is outside H7 accepted files; 8 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/github-import.ts:<anonymous>:inline:row.body.length>8000=8000#0` | src/hub/github-import.ts:21:243 | operational |
| `src/hub/github-import.ts:<anonymous>:inline:row.title.length>300=300#0` | src/hub/github-import.ts:21:194 | operational |
| `src/hub/github-import.ts:deadline:inline:deadline=10_000#0` | src/hub/github-import.ts:11:36 | operational |
| `src/hub/github-import.ts:issues:inline:issues.slice=32#0` | src/hub/github-import.ts:27:33 | operational |
| `src/hub/github-import.ts:partial:inline:issues.length>32=32#0` | src/hub/github-import.ts:27:59 | operational |
| `src/hub/github-import.ts:read:inline:new TextEncoder().encode(result.stdout).length>2*1024*1024=2*1024*1024#0` | src/hub/github-import.ts:12:366 | operational |
| `src/hub/github-import.ts:readGitHubImport:inline:raw.length>33=33#0` | src/hub/github-import.ts:18:65 | safety floor |
| `src/hub/github-import.ts:selectionText:inline:value.length<=100=100#0` | src/hub/github-import.ts:6:131 | operational |

### src/hub/hub-tools.ts

Path exclusion: `src/hub/hub-tools.ts` is outside H7 accepted files; 57 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/hub-tools.ts:enum:inline:enum=2#0` | src/hub/hub-tools.ts:115:405 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=16#0` | src/hub/hub-tools.ts:33:41, src/hub/hub-tools.ts:109:824 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=16#1` | src/hub/hub-tools.ts:33:41, src/hub/hub-tools.ts:109:824 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#0` | src/hub/hub-tools.ts:54:37, src/hub/hub-tools.ts:55:37, src/hub/hub-tools.ts:88:336, src/hub/hub-tools.ts:109:940 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#1` | src/hub/hub-tools.ts:54:37, src/hub/hub-tools.ts:55:37, src/hub/hub-tools.ts:88:336, src/hub/hub-tools.ts:109:940 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#2` | src/hub/hub-tools.ts:54:37, src/hub/hub-tools.ts:55:37, src/hub/hub-tools.ts:88:336, src/hub/hub-tools.ts:109:940 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#3` | src/hub/hub-tools.ts:54:37, src/hub/hub-tools.ts:55:37, src/hub/hub-tools.ts:88:336, src/hub/hub-tools.ts:109:940 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#0` | src/hub/hub-tools.ts:38:28, src/hub/hub-tools.ts:93:979, src/hub/hub-tools.ts:95:690, src/hub/hub-tools.ts:109:743 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#1` | src/hub/hub-tools.ts:38:28, src/hub/hub-tools.ts:93:979, src/hub/hub-tools.ts:95:690, src/hub/hub-tools.ts:109:743 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#2` | src/hub/hub-tools.ts:38:28, src/hub/hub-tools.ts:93:979, src/hub/hub-tools.ts:95:690, src/hub/hub-tools.ts:109:743 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#3` | src/hub/hub-tools.ts:38:28, src/hub/hub-tools.ts:93:979, src/hub/hub-tools.ts:95:690, src/hub/hub-tools.ts:109:743 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#0` | src/hub/hub-tools.ts:95:488, src/hub/hub-tools.ts:95:794, src/hub/hub-tools.ts:109:1128, src/hub/hub-tools.ts:114:233, src/hub/hub-tools.ts:115:268 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#1` | src/hub/hub-tools.ts:95:488, src/hub/hub-tools.ts:95:794, src/hub/hub-tools.ts:109:1128, src/hub/hub-tools.ts:114:233, src/hub/hub-tools.ts:115:268 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#2` | src/hub/hub-tools.ts:95:488, src/hub/hub-tools.ts:95:794, src/hub/hub-tools.ts:109:1128, src/hub/hub-tools.ts:114:233, src/hub/hub-tools.ts:115:268 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#3` | src/hub/hub-tools.ts:95:488, src/hub/hub-tools.ts:95:794, src/hub/hub-tools.ts:109:1128, src/hub/hub-tools.ts:114:233, src/hub/hub-tools.ts:115:268 | contract |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#4` | src/hub/hub-tools.ts:95:488, src/hub/hub-tools.ts:95:794, src/hub/hub-tools.ts:109:1128, src/hub/hub-tools.ts:114:233, src/hub/hub-tools.ts:115:268 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=200#0` | src/hub/hub-tools.ts:115:321 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=2048#0` | src/hub/hub-tools.ts:46:59 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=300#0` | src/hub/hub-tools.ts:95:580 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#0` | src/hub/hub-tools.ts:44:54, src/hub/hub-tools.ts:54:77, src/hub/hub-tools.ts:55:77 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#1` | src/hub/hub-tools.ts:44:54, src/hub/hub-tools.ts:54:77, src/hub/hub-tools.ts:55:77 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#2` | src/hub/hub-tools.ts:44:54, src/hub/hub-tools.ts:54:77, src/hub/hub-tools.ts:55:77 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=64#0` | src/hub/hub-tools.ts:114:286 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=8000#0` | src/hub/hub-tools.ts:95:624 | contract |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=96#0` | src/hub/hub-tools.ts:41:52 | contract |
| `src/hub/hub-tools.ts:maximum:inline:maximum=120#0` | src/hub/hub-tools.ts:115:458 | contract |
| `src/hub/hub-tools.ts:maximum:inline:maximum=20#0` | src/hub/hub-tools.ts:113:362 | contract |
| `src/hub/hub-tools.ts:maximum:inline:maximum=3#0` | src/hub/hub-tools.ts:93:784 | contract |
| `src/hub/hub-tools.ts:maximum:inline:maximum=8#0` | src/hub/hub-tools.ts:50:154 | contract |
| `src/hub/hub-tools.ts:minItems:inline:minItems=2#0` | src/hub/hub-tools.ts:95:475 | contract |
| `src/hub/hub-tools.ts:minLength:inline:minLength=6#0` | src/hub/hub-tools.ts:114:272 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#0` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#1` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#10` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#11` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#12` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#13` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#2` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#3` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#4` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#5` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#6` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#7` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#8` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#9` | src/hub/hub-tools.ts:50:142, src/hub/hub-tools.ts:93:394, src/hub/hub-tools.ts:93:719, src/hub/hub-tools.ts:93:772, src/hub/hub-tools.ts:94:279, src/hub/hub-tools.ts:95:377, src/hub/hub-tools.ts:95:851, src/hub/hub-tools.ts:97:287, src/hub/hub-tools.ts:99:248, src/hub/hub-tools.ts:100:231, src/hub/hub-tools.ts:101:243, src/hub/hub-tools.ts:106:280, src/hub/hub-tools.ts:122:238, src/hub/hub-tools.ts:125:243 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#0` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#1` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#10` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#2` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#3` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#4` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#5` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#6` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#7` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#8` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#9` | src/hub/hub-tools.ts:93:637, src/hub/hub-tools.ts:93:836, src/hub/hub-tools.ts:93:893, src/hub/hub-tools.ts:93:941, src/hub/hub-tools.ts:93:1037, src/hub/hub-tools.ts:95:748, src/hub/hub-tools.ts:96:187, src/hub/hub-tools.ts:99:300, src/hub/hub-tools.ts:100:314, src/hub/hub-tools.ts:113:350, src/hub/hub-tools.ts:115:446 | contract |
| `src/hub/hub-tools.ts:projectPeerIds:inline:value.length > 256=256#0` | src/hub/hub-tools.ts:144:47 | contract |

### src/hub/inbox-polling.ts

Path exclusion: `src/hub/inbox-polling.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/inbox-polling.ts:read:inline:streak.reads.length < 3=3#0` | src/hub/inbox-polling.ts:20:31 | operational |

### src/hub/instances.ts

Path exclusion: `src/hub/instances.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/instances.ts:MAX_INSTANCES:constant:MAX_INSTANCES=64#0` | src/hub/instances.ts:29:7 | operational |
| `src/hub/instances.ts:MAX_JCODE_INSTANCES:constant:MAX_JCODE_INSTANCES=8#0` | src/hub/instances.ts:24:14 | operational |

### src/hub/kimi-usage.ts

Path exclusion: `src/hub/kimi-usage.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/kimi-usage.ts:FLOOR_SLACK_MS:constant:FLOOR_SLACK_MS=1000#0` | src/hub/kimi-usage.ts:11:7 | operational |
| `src/hub/kimi-usage.ts:KIMI_WINDOW_MS:constant:KIMI_WINDOW_MS=5 * 3600000#0` | src/hub/kimi-usage.ts:9:14 | contract |
| `src/hub/kimi-usage.ts:PASSES:constant:PASSES=16#0` | src/hub/kimi-usage.ts:12:7 | operational |

### src/hub/lifecycle-schema.ts

Path exclusion: `src/hub/lifecycle-schema.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/lifecycle-schema.ts:activeLifecycle:inline:ControlClient.connect=1000#0` | src/hub/lifecycle-schema.ts:9:100 | operational |
| `src/hub/lifecycle-schema.ts:activeLifecycle:inline:stages.length > 32=32#0` | src/hub/lifecycle-schema.ts:16:69 | contract |

### src/hub/listen.ts

Path exclusion: `src/hub/listen.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/listen.ts:attempt:inline:attempt=0#0` | src/hub/listen.ts:6:24 | operational |

### src/hub/memory-candidates.ts

Path exclusion: `src/hub/memory-candidates.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-candidates.ts:[field]:inline:[field]=1#0` | src/hub/memory-candidates.ts:97:108 | safety floor |
| `src/hub/memory-candidates.ts:correctionInput:inline:bytes(JSON.stringify(result)) > 8192=8192#0` | src/hub/memory-candidates.ts:16:39 | safety floor |
| `src/hub/memory-candidates.ts:visibleId:inline:bytes(input) < 6=6#0` | src/hub/memory-candidates.ts:28:51 | safety floor |
| `src/hub/memory-candidates.ts:visibleId:inline:bytes(input) > 64=64#0` | src/hub/memory-candidates.ts:28:71 | safety floor |
| `src/hub/memory-candidates.ts:visibleId:inline:id.length < 6=6#0` | src/hub/memory-candidates.ts:30:19 | contract |

### src/hub/memory-fail.ts

Path exclusion: `src/hub/memory-fail.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-fail.ts:REMEMBER_TEXT_MAX_BYTES:constant:REMEMBER_TEXT_MAX_BYTES=4000#0` | src/hub/memory-fail.ts:1:14 | safety floor |

### src/hub/memory-observations.ts

Path exclusion: `src/hub/memory-observations.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-observations.ts:delivery:inline:this.pending.size > 2048=2048#0` | src/hub/memory-observations.ts:25:36 | safety floor |

### src/hub/memory-profile-check.ts

Path exclusion: `src/hub/memory-profile-check.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-profile-check.ts:receipt:inline:value.home.length > 4096=4096#0` | src/hub/memory-profile-check.ts:59:94 | safety floor |

### src/hub/memory-stale-anchors.ts

Path exclusion: `src/hub/memory-stale-anchors.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-stale-anchors.ts:MEMORY_STALE_SCAN_LIMIT:constant:MEMORY_STALE_SCAN_LIMIT=256#0` | src/hub/memory-stale-anchors.ts:6:14 | safety floor |
| `src/hub/memory-stale-anchors.ts:NODE_SCAN_LIMIT:constant:NODE_SCAN_LIMIT=256#0` | src/hub/memory-stale-anchors.ts:7:18 | safety floor |
| `src/hub/memory-stale-anchors.ts:PAGE:constant:PAGE=64#0` | src/hub/memory-stale-anchors.ts:7:7 | operational |

### src/hub/memory-staleness.ts

Path exclusion: `src/hub/memory-staleness.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-staleness.ts:STALENESS_MAX_PROBES:constant:STALENESS_MAX_PROBES=32#0` | src/hub/memory-staleness.ts:8:14 | safety floor |
| `src/hub/memory-staleness.ts:missing:inline:path.length > 4096=4096#0` | src/hub/memory-staleness.ts:29:32 | safety floor |

### src/hub/memory-symbols.ts

Path exclusion: `src/hub/memory-symbols.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/memory-symbols.ts:MEMORY_SYMBOL_LIMIT:constant:MEMORY_SYMBOL_LIMIT=16#0` | src/hub/memory-symbols.ts:8:14 | safety floor |
| `src/hub/memory-symbols.ts:MEMORY_SYMBOL_START_BUDGET_MS:constant:MEMORY_SYMBOL_START_BUDGET_MS=2000#0` | src/hub/memory-symbols.ts:9:14 | operational |

### src/hub/path-policy.ts

Path exclusion: `src/hub/path-policy.ts` is outside H7 accepted files; 14 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/path-policy.ts:<anonymous>:inline:(p.match(/[?*]/g)?.length ?? 0) > 16=16#0` | src/hub/path-policy.ts:9:79 | safety floor |
| `src/hub/path-policy.ts:<anonymous>:inline:p.length > 200=200#0` | src/hub/path-policy.ts:8:105 | safety floor |
| `src/hub/path-policy.ts:aliasScope:inline:budget.entries >= 4096=4096#0` | src/hub/path-policy.ts:58:27, src/hub/path-policy.ts:60:29, src/hub/path-policy.ts:134:45, src/hub/path-policy.ts:140:49 | safety floor |
| `src/hub/path-policy.ts:aliasScope:inline:budget.entries >= 4096=4096#1` | src/hub/path-policy.ts:58:27, src/hub/path-policy.ts:60:29, src/hub/path-policy.ts:134:45, src/hub/path-policy.ts:140:49 | safety floor |
| `src/hub/path-policy.ts:directAliasTarget:inline:hops <= 40=40#0` | src/hub/path-policy.ts:33:30 | safety floor |
| `src/hub/path-policy.ts:entries:inline:entries=0#0` | src/hub/path-policy.ts:165:31 | safety floor |
| `src/hub/path-policy.ts:hops:inline:hops=0#0` | src/hub/path-policy.ts:33:19 | safety floor |
| `src/hub/path-policy.ts:matchesPolicy:inline:path.length > 4096=4096#0` | src/hub/path-policy.ts:162:23 | safety floor |
| `src/hub/path-policy.ts:policyPaths:inline:raw.length > 64=64#0` | src/hub/path-policy.ts:8:43 | safety floor |
| `src/hub/path-policy.ts:visit:inline:++budget.entries > 4096=4096#0` | src/hub/path-policy.ts:141:32 | safety floor |
| `src/hub/path-policy.ts:visit:inline:budget.entries > 4096=4096#0` | src/hub/path-policy.ts:135:63 | safety floor |
| `src/hub/path-policy.ts:visit:inline:budget.entries >= 4096=4096#0` | src/hub/path-policy.ts:58:27, src/hub/path-policy.ts:60:29, src/hub/path-policy.ts:134:45, src/hub/path-policy.ts:140:49 | safety floor |
| `src/hub/path-policy.ts:visit:inline:budget.entries >= 4096=4096#1` | src/hub/path-policy.ts:58:27, src/hub/path-policy.ts:60:29, src/hub/path-policy.ts:134:45, src/hub/path-policy.ts:140:49 | safety floor |
| `src/hub/path-policy.ts:visit:inline:depth > 32=32#0` | src/hub/path-policy.ts:135:17 | safety floor |

### src/hub/plan-conformance.ts

Path exclusion: `src/hub/plan-conformance.ts` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/plan-conformance.ts:completePlanInventory:inline:evidence.paths.length > 1000=1000#0` | src/hub/plan-conformance.ts:22:226 | operational |
| `src/hub/plan-conformance.ts:encode:inline:depth > 64=64#0` | src/hub/plan-conformance.ts:53:17 | safety floor |
| `src/hub/plan-conformance.ts:pathIdentity:inline:raw.length > 1000=1000#0` | src/hub/plan-conformance.ts:12:55 | safety floor |
| `src/hub/plan-conformance.ts:planConformance:inline:planPaths.length > 1000=1000#0` | src/hub/plan-conformance.ts:37:77 | operational |

### src/hub/profiles.ts

Path exclusion: `src/hub/profiles.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/profiles.ts:<anonymous>:inline:value.length > 500=500#0` | src/hub/profiles.ts:68:217 | operational |
| `src/hub/profiles.ts:resolveProfile:inline:Object.keys(data.classes).length > 32=32#0` | src/hub/profiles.ts:44:128 | safety floor |
| `src/hub/profiles.ts:resolveProfile:inline:Object.keys(data.role_text).length > 8=8#0` | src/hub/profiles.ts:55:136 | operational |
| `src/hub/profiles.ts:resolveProfile:inline:data.example_checks.length > 16=16#0` | src/hub/profiles.ts:64:77 | operational |
| `src/hub/profiles.ts:resolveProfile:inline:data.review_checklist.length > 16=16#0` | src/hub/profiles.ts:68:114 | safety floor |

### src/hub/progress.ts

Path exclusion: `src/hub/progress.ts` is outside H7 accepted files; 9 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/progress.ts:<anonymous>:inline:turns.size >= 2=2#0` | src/hub/progress.ts:216:73 | operational |
| `src/hub/progress.ts:MAX_OBSERVATIONS:constant:MAX_OBSERVATIONS=28#0` | src/hub/progress.ts:10:7 | operational |
| `src/hub/progress.ts:MAX_STATES:constant:MAX_STATES=256#0` | src/hub/progress.ts:9:7 | operational |
| `src/hub/progress.ts:MAX_TEXT:constant:MAX_TEXT=500#0` | src/hub/progress.ts:11:7 | operational |
| `src/hub/progress.ts:TTL_MS:constant:TTL_MS=60 * 60000#0` | src/hub/progress.ts:8:7 | operational |
| `src/hub/progress.ts:name:inline:item.name.slice=80#0` | src/hub/progress.ts:185:30 | operational |
| `src/hub/progress.ts:name:inline:tool.slice=80#0` | src/hub/progress.ts:35:32 | operational |
| `src/hub/progress.ts:source:inline:item.source.slice=40#0` | src/hub/progress.ts:189:73 | operational |
| `src/hub/progress.ts:validTurn:inline:turn.trim().slice=120#0` | src/hub/progress.ts:195:73 | safety floor |

### src/hub/projected-diff.ts

Path exclusion: `src/hub/projected-diff.ts` is outside H7 accepted files; 6 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/projected-diff.ts:DIFF_MS:constant:DIFF_MS=8000#0` | src/hub/projected-diff.ts:12:22 | operational |
| `src/hub/projected-diff.ts:MAX_FILES:constant:MAX_FILES=8#0` | src/hub/projected-diff.ts:12:7 | operational |
| `src/hub/projected-diff.ts:PROJECTED_DIFF_BYTES:constant:PROJECTED_DIFF_BYTES=12000#0` | src/hub/projected-diff.ts:11:14 | operational |
| `src/hub/projected-diff.ts:size:inline:run=2#0` | src/hub/projected-diff.ts:29:45 | operational |
| `src/hub/projected-diff.ts:timeout:inline:Math.max=1#0` | src/hub/projected-diff.ts:22:178, src/hub/projected-diff.ts:42:219 | operational |
| `src/hub/projected-diff.ts:timeout:inline:Math.max=1#1` | src/hub/projected-diff.ts:22:178, src/hub/projected-diff.ts:42:219 | operational |

### src/hub/projection-exec.ts

Path exclusion: `src/hub/projection-exec.ts` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/projection-exec.ts:limit:constant:limit=256 * 1024#0` | src/hub/projection-exec.ts:10:7 | operational |
| `src/hub/projection-exec.ts:timeout:inline:Math.max=1#0` | src/hub/projection-exec.ts:18:114 | operational |
| `src/hub/projection-exec.ts:timeout:inline:Math.min=5000#0` | src/hub/projection-exec.ts:18:126 | safety floor |
| `src/hub/projection-exec.ts:timeout:inline:timeout=5000#0` | src/hub/projection-exec.ts:18:155 | operational |

### src/hub/read-tools.ts

Path exclusion: `src/hub/read-tools.ts` is outside H7 accepted files; 20 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/read-tools.ts:array:inline:v.length <= 8=8#0` | src/hub/read-tools.ts:22:122 | contract |
| `src/hub/read-tools.ts:cap:inline:cap=4096#0` | src/hub/read-tools.ts:64:66 | contract |
| `src/hub/read-tools.ts:cap:inline:cap=8192#0` | src/hub/read-tools.ts:64:59 | contract |
| `src/hub/read-tools.ts:excerpt:inline:max=200#0` | src/hub/read-tools.ts:8:38 | test seam |
| `src/hub/read-tools.ts:graph:inline:a.hops ?? 1=1#0` | src/hub/read-tools.ts:98:66 | contract |
| `src/hub/read-tools.ts:limit:inline:Number(a.limit) >= 1=1#0` | src/hub/read-tools.ts:23:108 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:a.limit ?? 60=60#0` | src/hub/read-tools.ts:115:49 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:a.limit ?? 8=8#0` | src/hub/read-tools.ts:71:59 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > (eligibleEdges.length ? 5120 : 6144)=5120#0` | src/hub/read-tools.ts:117:64 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > (eligibleEdges.length ? 5120 : 6144)=6144#0` | src/hub/read-tools.ts:117:71 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > 6144=6144#0` | src/hub/read-tools.ts:123:40 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:lines.length >= (show ? 8 : Number(a.limit ?? 8))=8#0` | src/hub/read-tools.ts:71:37 | contract |
| `src/hub/read-tools.ts:memoryRead:inline:out.edges.length >= 240=240#0` | src/hub/read-tools.ts:121:71 | contract |
| `src/hub/read-tools.ts:resolve:inline:id.length < 6=6#0` | src/hub/read-tools.ts:48:23 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:array=1#0` | src/hub/read-tools.ts:28:24 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:array=200#0` | src/hub/read-tools.ts:28:27 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:limit=120#0` | src/hub/read-tools.ts:28:100 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:limit=20#0` | src/hub/read-tools.ts:26:71 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:string=0#0` | src/hub/read-tools.ts:26:53 | contract |
| `src/hub/read-tools.ts:validateMemoryRead:inline:string=200#0` | src/hub/read-tools.ts:26:56 | contract |

### src/hub/registry.ts

Path exclusion: `src/hub/registry.ts` is outside H7 accepted files; 5 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/registry.ts:BASE_PORT:constant:BASE_PORT=4600#0` | src/hub/registry.ts:8:7 | contract |
| `src/hub/registry.ts:MAX_PORT:constant:MAX_PORT=65535 - 3#0` | src/hub/registry.ts:11:7 | contract |
| `src/hub/registry.ts:REGISTRY_DB_BUSY_TIMEOUT_MS:constant:REGISTRY_DB_BUSY_TIMEOUT_MS=5000#0` | src/hub/registry.ts:10:14 | operational |
| `src/hub/registry.ts:STRIDE:constant:STRIDE=10#0` | src/hub/registry.ts:9:7 | contract |
| `src/hub/registry.ts:idFor:inline:createHash(sha256).update(root).digest(hex).slice=24#0` | src/hub/registry.ts:41:95 | operational |

### src/hub/research.ts

Path exclusion: `src/hub/research.ts` is outside H7 accepted files; 6 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/research.ts:addonReport:inline:resamples=1000#0` | src/hub/research.ts:332:79 | test seam |
| `src/hub/research.ts:head:inline:tokens p50.padStart=10#0` | src/hub/research.ts:291:194 | operational |
| `src/hub/research.ts:head:inline:tokens p90.padStart=10#0` | src/hub/research.ts:291:224 | operational |
| `src/hub/research.ts:projectKey:inline:createHash(sha256).update(projectId).digest(hex).slice=16#0` | src/hub/research.ts:66:120 | operational |
| `src/hub/research.ts:row:inline:fmtNum(m.tokensPerTask.median).padStart=10#0` | src/hub/research.ts:290:335 | operational |
| `src/hub/research.ts:row:inline:fmtNum(m.tokensPerTask.p90).padStart=10#0` | src/hub/research.ts:290:380 | operational |

### src/hub/roles.ts

Path exclusion: `src/hub/roles.ts` is outside H7 accepted files; 13 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/roles.ts:bytes:inline:Buffer.alloc=8193#0` | src/hub/roles.ts:56:32 | safety floor |
| `src/hub/roles.ts:catalogAssignments:inline:Object.keys(raw).length > 64=64#0` | src/hub/roles.ts:85:90 | safety floor |
| `src/hub/roles.ts:catalogAssignments:inline:ids.length > 2=2#0` | src/hub/roles.ts:88:109 | safety floor |
| `src/hub/roles.ts:catalogSection:inline:roles.length > 2=2#0` | src/hub/roles.ts:102:22 | safety floor |
| `src/hub/roles.ts:id:inline:file.slice=-3#0` | src/hub/roles.ts:76:32 | contract |
| `src/hub/roles.ts:loadRoleCatalog:inline:files.length > 64=64#0` | src/hub/roles.ts:74:24 | safety floor |
| `src/hub/roles.ts:parseRole:inline:header.name!.length > 80=80#0` | src/hub/roles.ts:29:112 | contract |
| `src/hub/roles.ts:parseRole:inline:header.source!.length > 300=300#0` | src/hub/roles.ts:29:174 | contract |
| `src/hub/roles.ts:parseRole:inline:header.summary!.length > 160=160#0` | src/hub/roles.ts:29:143 | contract |
| `src/hub/roles.ts:parseRole:inline:sanitize(body).length > 2000=2000#0` | src/hub/roles.ts:36:40 | safety floor |
| `src/hub/roles.ts:projectRole:inline:before.size > 8192=8192#0` | src/hub/roles.ts:55:65 | operational |
| `src/hub/roles.ts:review:inline:index=5#0` | src/hub/roles.ts:48:51 | operational |
| `src/hub/roles.ts:taskRoleText:inline:text.length > 2000=2000#0` | src/hub/roles.ts:121:21 | safety floor |

### src/hub/settings.ts

Path exclusion: `src/hub/settings.ts` is outside H7 accepted files; 17 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/settings.ts:<anonymous>:inline:def.path.slice=2#0` | src/hub/settings.ts:441:121 | contract |
| `src/hub/settings.ts:PEERS_MAX:constant:PEERS_MAX=8#0` | src/hub/settings.ts:46:7 | contract |
| `src/hub/settings.ts:checkSettingValue:inline:def.min ?? 0=0#0` | src/hub/settings.ts:156:134, src/hub/settings.ts:156:290 | contract |
| `src/hub/settings.ts:checkSettingValue:inline:def.min ?? 0=0#1` | src/hub/settings.ts:156:134, src/hub/settings.ts:156:290 | contract |
| `src/hub/settings.ts:checkSettingValue:inline:raw.length > 2=2#0` | src/hub/settings.ts:165:45 | contract |
| `src/hub/settings.ts:max:inline:max=10#0` | src/hub/settings.ts:58:139 | contract |
| `src/hub/settings.ts:max:inline:max=1000#0` | src/hub/settings.ts:56:263, src/hub/settings.ts:64:183 | contract |
| `src/hub/settings.ts:max:inline:max=1000#1` | src/hub/settings.ts:56:263, src/hub/settings.ts:64:183 | contract |
| `src/hub/settings.ts:max:inline:max=2_147_483_647 / (key === "interval_s" ? 1000 : 60_000)#0` | src/hub/settings.ts:56:223 | contract |
| `src/hub/settings.ts:max:inline:max=32#0` | src/hub/settings.ts:57:167 | contract |
| `src/hub/settings.ts:max:inline:max=60_000#0` | src/hub/settings.ts:56:270 | contract |
| `src/hub/settings.ts:min:inline:min=0#0` | src/hub/settings.ts:55:143, src/hub/settings.ts:57:159, src/hub/settings.ts:64:175 | contract |
| `src/hub/settings.ts:min:inline:min=0#1` | src/hub/settings.ts:55:143, src/hub/settings.ts:57:159, src/hub/settings.ts:64:175 | contract |
| `src/hub/settings.ts:min:inline:min=0#2` | src/hub/settings.ts:55:143, src/hub/settings.ts:57:159, src/hub/settings.ts:64:175 | contract |
| `src/hub/settings.ts:min:inline:min=1#0` | src/hub/settings.ts:56:215, src/hub/settings.ts:58:131 | contract |
| `src/hub/settings.ts:min:inline:min=1#1` | src/hub/settings.ts:56:215, src/hub/settings.ts:58:131 | contract |
| `src/hub/settings.ts:settingDef:inline:key.length > 80=80#0` | src/hub/settings.ts:141:47 | safety floor |

### src/hub/spec-read.ts

Path exclusion: `src/hub/spec-read.ts` is outside H7 accepted files; 11 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/spec-read.ts:BODY_LIMIT:constant:BODY_LIMIT=64 * 1024#0` | src/hub/spec-read.ts:7:7 | safety floor |
| `src/hub/spec-read.ts:RESULT_LIMIT:constant:RESULT_LIMIT=80 * 1024#0` | src/hub/spec-read.ts:7:31 | safety floor |
| `src/hub/spec-read.ts:STDOUT_LIMIT:constant:STDOUT_LIMIT=512 * 1024#0` | src/hub/spec-read.ts:7:57 | safety floor |
| `src/hub/spec-read.ts:killMs:inline:killMs=500#0` | src/hub/spec-read.ts:101:72 | operational |
| `src/hub/spec-read.ts:qualifiedTitleRepos:inline:found.size >= 4=4#0` | src/hub/spec-read.ts:77:23 | operational |
| `src/hub/spec-read.ts:siblingTitleRefs:inline:[...found].slice=4#0` | src/hub/spec-read.ts:62:30 | operational |
| `src/hub/spec-read.ts:specRefs:inline:issues.size > 3=3#0` | src/hub/spec-read.ts:46:23 | operational |
| `src/hub/spec-read.ts:termMs:inline:termMs=100#0` | src/hub/spec-read.ts:101:59 | operational |
| `src/hub/spec-read.ts:timeout:inline:Math.max=1#0` | src/hub/spec-read.ts:103:106 | operational |
| `src/hub/spec-read.ts:timeout:inline:Math.min=15_000#0` | src/hub/spec-read.ts:103:118 | operational |
| `src/hub/spec-read.ts:timeout:inline:timeout=15_000#0` | src/hub/spec-read.ts:103:88 | test seam |

### src/hub/terminal-launch.ts

Path exclusion: `src/hub/terminal-launch.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/terminal-launch.ts:<anonymous>:inline:bytes > 1024 * 1024=1024 * 1024#0` | src/hub/terminal-launch.ts:30:21 | operational |
| `src/hub/terminal-launch.ts:register:inline:this.candidates.size >= 64=64#0` | src/hub/terminal-launch.ts:83:33, src/hub/terminal-launch.ts:85:33 | operational |
| `src/hub/terminal-launch.ts:register:inline:this.candidates.size >= 64=64#1` | src/hub/terminal-launch.ts:83:33, src/hub/terminal-launch.ts:85:33 | operational |

### src/hub/test-integrity.ts

Path exclusion: `src/hub/test-integrity.ts` is outside H7 accepted files; 10 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/test-integrity.ts:<anonymous>:inline:text=100#0` | src/hub/test-integrity.ts:71:45 | safety floor |
| `src/hub/test-integrity.ts:deadline:inline:deadline=20_000#0` | src/hub/test-integrity.ts:82:40 | safety floor |
| `src/hub/test-integrity.ts:parseIssueLabels:inline:nodes.length > 100=100#0` | src/hub/test-integrity.ts:70:122 | safety floor |
| `src/hub/test-integrity.ts:read:inline:cap=128 * 1024#0` | src/hub/test-integrity.ts:83:45 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:changes.length <= 1000=1000#0` | src/hub/test-integrity.ts:106:160 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:commit.files.length >= 100=100#0` | src/hub/test-integrity.ts:137:132 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:contexts.nodes.length > 100=100#0` | src/hub/test-integrity.ts:150:148 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:current.commits.nodes.length > 100=100#0` | src/hub/test-integrity.ts:124:178 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:preloaded.length > 100=100#0` | src/hub/test-integrity.ts:94:57 | safety floor |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:seen.size >= 100=100#0` | src/hub/test-integrity.ts:134:50 | safety floor |

### src/hub/text-projection.ts

Path exclusion: `src/hub/text-projection.ts` is outside H7 accepted files; 15 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/text-projection.ts:<anonymous>:inline:arg.length > 2000=2000#0` | src/hub/text-projection.ts:20:169 | safety floor |
| `src/hub/text-projection.ts:MAX_PROJECTION_INPUT:constant:MAX_PROJECTION_INPUT=16 * 1024 * 1024#0` | src/hub/text-projection.ts:12:14 | safety floor |
| `src/hub/text-projection.ts:MAX_TEXT:constant:MAX_TEXT=256 * 1024#0` | src/hub/text-projection.ts:13:41 | safety floor |
| `src/hub/text-projection.ts:boundedCache:inline:st.size > MAX_TEXT * 2=2#0` | src/hub/text-projection.ts:44:64 | safety floor |
| `src/hub/text-projection.ts:choices:inline:(process.env.PATH ?? /usr/bin:/bin).split(:).slice=32#0` | src/hub/text-projection.ts:32:141 | safety floor |
| `src/hub/text-projection.ts:convert:inline:Buffer.byteLength(cached) <= MAX_TEXT * 2=2#0` | src/hub/text-projection.ts:114:53 | safety floor |
| `src/hub/text-projection.ts:failure:inline:this.failed.size >= 1024=1024#0` | src/hub/text-projection.ts:143:85 | safety floor |
| `src/hub/text-projection.ts:projectionConfig:inline:Object.keys(raw).length > 16=16#0` | src/hub/text-projection.ts:17:90 | safety floor |
| `src/hub/text-projection.ts:projectionConfig:inline:argv.length > 16=16#0` | src/hub/text-projection.ts:20:98 | safety floor |
| `src/hub/text-projection.ts:timeout:inline:Math.max=1#0` | src/hub/text-projection.ts:138:83, src/hub/text-projection.ts:139:321 | operational |
| `src/hub/text-projection.ts:timeout:inline:Math.min=8000#0` | src/hub/text-projection.ts:138:95 | safety floor |
| `src/hub/text-projection.ts:timeout:inline:timeout=8000#0` | src/hub/text-projection.ts:138:57 | safety floor |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.max=1#0` | src/hub/text-projection.ts:138:83, src/hub/text-projection.ts:139:321 | operational |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.min=100#0` | src/hub/text-projection.ts:139:370 | safety floor |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.min=5000#0` | src/hub/text-projection.ts:139:333 | safety floor |

### src/hub/tooling.ts

Path exclusion: `src/hub/tooling.ts` is outside H7 accepted files; 3 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/tooling.ts:<anonymous>:inline:setTimeout=50#0` | src/hub/tooling.ts:79:125 | operational |
| `src/hub/tooling.ts:PROBE_BYTES:constant:PROBE_BYTES=4096#0` | src/hub/tooling.ts:26:24 | safety floor |
| `src/hub/tooling.ts:PROBE_MS:constant:PROBE_MS=2000#0` | src/hub/tooling.ts:26:7 | operational |

### src/hub/usage-rollup.ts

Path exclusion: `src/hub/usage-rollup.ts` is outside H7 accepted files; 18 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/usage-rollup.ts:DEFAULT_MAX_BYTES:constant:DEFAULT_MAX_BYTES=8 * 1024 * 1024#0` | src/hub/usage-rollup.ts:33:14 | operational |
| `src/hub/usage-rollup.ts:LIMITS_DEFAULT:constant:LIMITS_DEFAULT=200#0` | src/hub/usage-rollup.ts:63:14 | operational |
| `src/hub/usage-rollup.ts:LIMITS_MAX:constant:LIMITS_MAX=5000#0` | src/hub/usage-rollup.ts:63:36 | operational |
| `src/hub/usage-rollup.ts:MAX_LINE_BYTES:constant:MAX_LINE_BYTES=4 * 1024 * 1024#0` | src/hub/usage-rollup.ts:35:7 | operational |
| `src/hub/usage-rollup.ts:NO_TASK:constant:NO_TASK=0#0` | src/hub/usage-rollup.ts:36:7 | contract |
| `src/hub/usage-rollup.ts:bounds:inline:new Date(q.since).toISOString().slice=10#0` | src/hub/usage-rollup.ts:254:111 | contract |
| `src/hub/usage-rollup.ts:bounds:inline:new Date(q.until).toISOString().slice=10#0` | src/hub/usage-rollup.ts:255:111 | contract |
| `src/hub/usage-rollup.ts:daily:inline:days=14#0` | src/hub/usage-rollup.ts:372:16 | test seam |
| `src/hub/usage-rollup.ts:day:inline:new Date(Date.parse(today + T00:00:00Z) - i * dayMs).toISOString().slice=10#0` | src/hub/usage-rollup.ts:386:97 | contract |
| `src/hub/usage-rollup.ts:day:inline:new Date(t).toISOString().slice=10#0` | src/hub/usage-rollup.ts:184:138 | contract |
| `src/hub/usage-rollup.ts:dayMs:inline:dayMs=86_400_000#0` | src/hub/usage-rollup.ts:383:19 | operational |
| `src/hub/usage-rollup.ts:deadline:inline:Math.max=0#0` | src/hub/usage-rollup.ts:105:51 | operational |
| `src/hub/usage-rollup.ts:deadline:inline:Math.min=20#0` | src/hub/usage-rollup.ts:105:63 | operational |
| `src/hub/usage-rollup.ts:limits:inline:limit < 1=1#0` | src/hub/usage-rollup.ts:317:45 | operational |
| `src/hub/usage-rollup.ts:poll:inline:maxMs=20#0` | src/hub/usage-rollup.ts:104:16 | test seam |
| `src/hub/usage-rollup.ts:start:inline:start=0#0` | src/hub/usage-rollup.ts:140:26 | operational |
| `src/hub/usage-rollup.ts:sumVal:inline:knownCounters.reduce=0#0` | src/hub/usage-rollup.ts:408:77 | operational |
| `src/hub/usage-rollup.ts:today:inline:new Date(now).toISOString().slice=10#0` | src/hub/usage-rollup.ts:383:76 | contract |

### src/hub/usage.ts

Path exclusion: `src/hub/usage.ts` is outside H7 accepted files; 9 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/hub/usage.ts:COMPLETION_SCAN_BYTES:constant:COMPLETION_SCAN_BYTES=64 * 1024 * 1024#0` | src/hub/usage.ts:80:14 | operational |
| `src/hub/usage.ts:COMPLETION_TAIL_BYTES:constant:COMPLETION_TAIL_BYTES=4 * 1024 * 1024#0` | src/hub/usage.ts:75:14 | operational |
| `src/hub/usage.ts:budget:inline:Math.max=0#0` | src/hub/usage.ts:28:71, src/hub/usage.ts:93:28 | operational |
| `src/hub/usage.ts:budget:inline:Math.min=1200#0` | src/hub/usage.ts:28:56 | operational |
| `src/hub/usage.ts:budget:inline:budget=1200#0` | src/hub/usage.ts:28:88 | operational |
| `src/hub/usage.ts:limit:inline:Math.max=0#0` | src/hub/usage.ts:28:71, src/hub/usage.ts:93:28 | operational |
| `src/hub/usage.ts:readClaudeTranscriptUsage:inline:statSync(transcriptPath).size > 32 * 1024 * 1024=32 * 1024 * 1024#0` | src/hub/usage.ts:64:41 | operational |
| `src/hub/usage.ts:waitForClaudeCompletion:inline:Math.min=40#0` | src/hub/usage.ts:45:30 | operational |
| `src/hub/usage.ts:waitForClaudeCompletion:inline:timeoutMs=1200#0` | src/hub/usage.ts:27:162 | test seam |

### src/memory/brief.ts

Path exclusion: `src/memory/brief.ts` is outside H7 accepted files; 2 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/memory/brief.ts:Briefs:inline:maxItems=8#0` | src/memory/brief.ts:48:58 | test seam |
| `src/memory/brief.ts:hits:inline:query.slice=300#0` | src/memory/brief.ts:22:61 | safety floor |

### src/memory/capture.ts

Path exclusion: `src/memory/capture.ts` is outside H7 accepted files; 1 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/memory/capture.ts:observe:inline:this.toolTimes.size > 1024=1024#0` | src/memory/capture.ts:50:33 | operational |

### src/memory/client.ts

Path exclusion: `src/memory/client.ts` is outside H7 accepted files; 8 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/memory/client.ts:cap:inline:Math.max=0#0` | src/memory/client.ts:87:62 | operational |
| `src/memory/client.ts:cap:inline:Math.min=30#0` | src/memory/client.ts:87:49 | operational |
| `src/memory/client.ts:limit:inline:limit=256#0` | src/memory/client.ts:68:66 | operational |
| `src/memory/client.ts:limit:inline:limit=4096#0` | src/memory/client.ts:47:63, src/memory/client.ts:62:62 | operational |
| `src/memory/client.ts:limit:inline:limit=4096#1` | src/memory/client.ts:47:63, src/memory/client.ts:62:62 | operational |
| `src/memory/client.ts:rows:inline:page < 16=16#0` | src/memory/client.ts:67:31 | operational |
| `src/memory/client.ts:rows:inline:this.rows(o).filter(v => v.tier === short).slice=30#0` | src/memory/client.ts:79:74 | safety floor |
| `src/memory/client.ts:search:inline:limit=10#0` | src/memory/client.ts:84:57 | test seam |

### src/memory/recall.ts

Path exclusion: `src/memory/recall.ts` is outside H7 accepted files; 6 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/memory/recall.ts:RECALL_LINE_CHARS:constant:RECALL_LINE_CHARS=200#0` | src/memory/recall.ts:49:14 | safety floor |
| `src/memory/recall.ts:count:inline:count=4#0` | src/memory/recall.ts:61:29 | contract |
| `src/memory/recall.ts:idChars:inline:note.id.slice=8#0` | src/memory/recall.ts:71:37, src/memory/recall.ts:78:51 | contract |
| `src/memory/recall.ts:max:inline:max=3#0` | src/memory/recall.ts:13:24 | contract |
| `src/memory/recall.ts:prefix:inline:note.id.slice=8#0` | src/memory/recall.ts:71:37, src/memory/recall.ts:78:51 | contract |
| `src/memory/recall.ts:recallMemoryLines:inline:limit=30#0` | src/memory/recall.ts:68:73 | test seam |

### src/pet/window.jxa.js

Path exclusion: `src/pet/window.jxa.js` is outside H7 accepted files; 4 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/pet/window.jxa.js:implementation:inline:body.text.length <= 65536=65536#0` | src/pet/window.jxa.js:56:113 | safety floor |
| `src/pet/window.jxa.js:run:inline:$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats=0.1#0` | src/pet/window.jxa.js:120:86 | operational |
| `src/pet/window.jxa.js:run:inline:$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats=1#0` | src/pet/window.jxa.js:119:81 | operational |
| `src/pet/window.jxa.js:runCommand:inline:commands.length >= 8=8#0` | src/pet/window.jxa.js:23:37 | safety floor |

### src/pet/window.ts

Path exclusion: `src/pet/window.ts` is outside H7 accepted files; 7 keys remain unchanged with the work owning this path.

| Stable H0 key | Frozen location(s) | Unchanged H0 class |
| --- | --- | --- |
| `src/pet/window.ts:closePetWindow:inline:Bun.sleep=50#0` | src/pet/window.ts:84:21, src/pet/window.ts:98:109, src/pet/window.ts:132:109 | operational |
| `src/pet/window.ts:deadline:inline:deadline=5000#0` | src/pet/window.ts:79:33, src/pet/window.ts:97:35 | operational |
| `src/pet/window.ts:deadline:inline:deadline=5000#1` | src/pet/window.ts:79:33, src/pet/window.ts:97:35 | operational |
| `src/pet/window.ts:readyDeadline:inline:readyDeadline=4000#0` | src/pet/window.ts:131:40 | operational |
| `src/pet/window.ts:runPetWindowHost:inline:Bun.sleep=50#0` | src/pet/window.ts:84:21, src/pet/window.ts:98:109, src/pet/window.ts:132:109 | operational |
| `src/pet/window.ts:runPetWindowHost:inline:setInterval=1000#0` | src/pet/window.ts:129:73 | operational |
| `src/pet/window.ts:startPetWindow:inline:Bun.sleep=50#0` | src/pet/window.ts:84:21, src/pet/window.ts:98:109, src/pet/window.ts:132:109 | operational |

## Verification state

Read-only source/inventory analysis and document reconciliation only. No source/tests edited; no tests, build, install, typecheck, model/account calls or commit performed. Scope remains pending reviewer ruling.
