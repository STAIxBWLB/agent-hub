---
title: Switchyard 라우팅 로직의 소스 수준 도입 계획 - agent-hub TypeScript 이식
date: 2026-10-04
project: agent-hub
status: approved (implementation requested 2026-10-04)
related: 261004-review-agent-hub-switchyard-comparison.md, 261004-plan-agent-hub-research-v2.md
---

# Switchyard 라우팅 로직의 소스 수준 도입 계획

## 요약

- **방식**: Switchyard 바이너리(sidecar)를 띄우는 대신, 필요한 라우팅 로직을 agent-hub의 TypeScript 소스로 옮겨 hub 프로세스 안에서 실행함.
  - 근거
    - agent-hub는 runtime 의존성 0이 원칙인데 Switchyard 서버는 "Demo" 등급, pre-1.0, 릴리스 바이너리가 없음(cargo 빌드).
    - hub가 이미 모델 호출 루프를 직접 가진 곳이 두 군데 있음: local worker, Pi용 model relay.
    - 그 루프 안에서는 HTTP 프록시도 프로토콜 변환도 필요 없음.
- **이식 대상** (Switchyard main `c8848511`, 2026-10-02)
  - 1순위 순수 로직
    - 도구 신호 추출 + Stage 점수기.
    - Plan/Execute.
    - Advisor gate(트리거, 검토 예산, transcript, 판정 해석, REDO).
    - Escalation(요약기, 확인 연속·latch).
    - 공용 도구: middle-drop, 판정 해석, 세션 상태.
  - 2순위: capability 분류기, 호출 재시도·cooldown·deadline 정책의 일부.
  - 이식하지 않음: decision judge(확률 응답 API 필요), 스트림 재생, Terminus 전용 중복 제거, Codex Responses 원시 블록, OTel 계측, 사용자 정의 ToolSemantics.
- **착륙 지점**
  - local worker의 모델 호출(`src/adapters/local-worker.ts`의 `call()`).
  - Pi model relay의 backend 선택(`src/models/relay.ts`의 `selectBackend`).
  - hub inference(`src/hub/inference.ts`).
  - peer 관측(`src/hub/facts.ts`, `codex-appserver.ts`의 항목).
- **바로 쓸 수 있는 tier**: OmniRoute 조합 `coding`(capable)과 `fast`(efficient), Mac 로컬 MLX(Qwen3.5 4B, 8k 컨텍스트). 새 모델 없이 시작 가능.
- **규모 추정**: 이식 코드 약 1,700~2,100줄, 연결 약 500~800줄, 테스트 약 1,500줄 이상. Switchyard 테스트 중 순수 함수 표 테스트 약 100건을 golden으로 옮김.
- **단계**
  - 0단계: spec·라이선스·뼈대.
  - 1단계: 순수 핵심 이식과 golden 테스트.
  - 2단계: local worker 연결.
  - 3단계: Pi relay 연결.
  - 4단계: peer 진행 신호와 정체 판정(연구용).
  - 5단계: sidecar 존치 결정.
- **연구와의 관계**
  - 4단계의 peer 진행 신호는 연구 계획 v2의 NC3(실행 신호로 조정 방식 전환) 자료.
  - Advisor gate 이식은 #42 AC2 감독자 regime과 NC2 commit gate의 시제품 기반.

## 이식 대상 분석 (소스 기준)

- 출처: Switchyard `crates/libsy/src`(아래 `A/`는 `algorithms/`). 줄 수는 원 저장소 기준.
- 모든 `.rs` 파일 머리에 `SPDX-License-Identifier: Apache-2.0`가 있음. 프롬프트 `.md`·`.json`에는 머리말이 없음.

| 구성 요소 | 원 로직(raw/code) | 원 테스트(건) | 순수 여부 | 턴당 외부 호출 | TS 추정 | 난이도 |
|---|---|---|---|---|---|---|
| Stage(`A/stage.rs`, `A/util/stage.rs`, `A/util/tool_signals.rs`) | 2,288 / 1,711 | 111 | 순수(판정기 선택) | 0, 모호할 때 판정기 1 | 950~1,100 | 중 |
| Advisor gate(`A/advisor_gate*`) | 1,195 / 882 | 47 | 혼합 | 검토 시 advisor 1, REDO 시 executor 1 | 300~400 | 하 |
| Escalation(`A/escalation.rs`, `A/util/escalation.rs`) | 1,008 / 825 | 29 | 혼합 | latch 전 efficient 1 + 판정기 1 | 450~550 | 중 |
| Capability 분류기(`A/llm_class.rs` 일부) | 일부 | 33 | 혼합 | 판정기 1 | 250~350 | 하 |
| Plan/Execute(`A/plan_execute.rs`) | 202 / 171 | 4 | 순수 | 0 | 80~120 | 하 |
| 공용(`llm_judge`, `robustness`, `affinity`, `fall_through`, `prompts`) | 1,282 / 911 | 57 | 판정 호출 외 순수 | - | 200~300 | 하 |
| 호출 정책(재시도, cooldown, deadline) | llm-client 쪽 | - | - | 모든 호출 | 120~180 | 하~중 |

### Stage 점수기 (원문 확인)

- **신호 추출**: 대화의 도구 호출·결과를 훑어 계산함.
  - 쓰기·편집·읽기·계획·새 호출 수(최근 3회 창).
  - 결과 창의 오류 심각도: SOFT 0.3, HARD 0.7, CRITICAL 1.0. 오류 문자열 표 약 11종(traceback, import error, assertion, timeout, out of memory 등)과 컴파일 오류·런타임 예외·panic 탐지.
  - 같은 오류 지문의 반복, 연속 무오류 수, 테스트 통과 판정(통과·실패 문구와 숫자 키워드).
- **도구 어휘**: 하네스별 도구 이름 표.
  - 편집: edit, multiedit, apply_patch 등. 쓰기: write, create_file 등.
  - 읽기: read, grep, glob 등. 계획: todowrite, update_plan 등. 셸: bash, shell_command, exec_command 등.
  - 셸 명령을 분해해 쓰기·편집·읽기를 추정함(`sed -i`, `cat >`, `git apply`, 포매터 등).
- **점수**
  - 차원: severity, spinning(깊이 8 이상에서 최근 쓰기·읽기·계획 없음), exploring(최근 읽기·계획만), production_intensity(최근 쓰기+편집 비율).
  - `score = tanh(5 · 0.1 · (severity/0.7 + spinning + exploring − production_intensity))`, 신뢰도 = |score|.
  - 무조건 capable: 컨텍스트 압축 흔적, 심각도 1.0, 같은 오류 반복.
  - 임계값 t의 모호 구간(|score| ≤ t)은 분류기 또는 picker 기본 tier로.
  - capable 결정 뒤 2회 유지(hold). 깨끗한 테스트 통과가 유지를 해제.
- **상태**: 세션별(1시간 TTL). hold 키는 agent id별로 나뉠 수 있음.
- **주의**: t = 0.5에서는 Dimensions 경로만으로 efficient를 고를 수 없음(최소가 −1 단위, 점수 −0.46). efficient는 picker 기본값으로만 선택됨.

### Advisor gate (원문 확인)

- **트리거**
  - `no_tool_call`: 도구 호출 없는 turn이면서 도구 결과가 `gate_min_tool_results` 이상.
  - `pattern`: 정규식.
  - 정체 검사: assistant turn이 `gate_stall_turns` 이상일 때 대화당 1회.
- **예산**: 범위(세션)별 `max_reviews`. 판정기 실패는 예산을 돌려주고, 실패 3회면 그 범위의 검토를 끔. 추적 범위 상한 1,024.
- **transcript**: 대화 JSON 뒤에 executor의 마지막 turn을 붙임. 상한을 넘으면 앞 1/4과 뒤 3/4만 남기고 가운데를 표시와 함께 버림(middle-drop).
- **판정 해석**: 첫 단어 APPROVE 또는 REDO(정규식, 대소문자 무시, "verdict:" 접두 허용). REDO 뒤 나머지가 계획.
- **REDO**: executor 응답을 assistant로, `redo_feedback_prefix + 계획`을 user로 붙여 executor를 다시 부름.
- **실패 처리**: fail-open(기본)이면 보류한 turn을 그대로 통과.
- **원문의 문서와 코드 불일치**: 문서는 "Rust runner가 fail_open과 무관하게 HTTP 실패에서 멈춘다"고 하나, 코드는 `fail_open`을 따름. 이식은 코드를 기준으로 함.

### Escalation (원문 확인)

- **기본값**: confirmations 2, recent_turn_window 28, window_message_chars 500.
- **판정 결과**: `escalate`, `category`(none, repetition, false_progress, drift, desperation, capability_gap), `new_evidence`, `reason`.
- **확인 연속**: 같은 범주의 새 증거면 +1, 범주가 바뀌면 1부터, 거절이나 낡은 증거면 0. 해석 실패는 연속을 유지.
- **latch**: 확인 수에 도달하면 capable로 고정. de-escalation은 선택.
- **요약기**: 판정기 입력은 지시문(1,000자), 첫 사용자 요청(4,000자), 최근 창. 전체 상한 18,000자.
- **실패 처리**: Rust 호스트에서는 판정기 HTTP 실패가 요청을 멈춤(fail-closed). 이식에서는 agent-hub inference 규칙(fail-open, backoff)을 따르도록 바꿈. 이는 의도한 차이로 spec에 적음.

### Plan/Execute (원문 확인)

- 첫 변경(편집·쓰기, 셸로 추정한 것 포함)이 보이기 전까지 capable로 계획. 변경을 보면 그 세션을 실행 단계로 고정하고 efficient로.
- 계획 단계에는 계획용 시스템 프롬프트를 앞에 붙임.

## agent-hub 착륙 지점

- **local worker** (`src/adapters/local-worker.ts`)
  - `call()`이 매 호출의 메시지(`system` + `history` + 이번 turn)와 도구 목록을 만들고, sidecar 경유 route 또는 OmniRoute `fixed_model`로 호출함.
  - 도구: `read`, `write`, `edit`, `bash`(+ 작업 도구). Stage 어휘의 read/write/edit/bash와 이름이 같음.
  - 호출은 스트리밍이 아님(`ChatResult`). advisor gate의 응답 보류가 자연스러움.
  - 작업 class별 route 선택이 이미 있음(`turnPolicy`). PII turn은 on-prem 경로 확인(`onCampus()`) 규칙이 있음.
- **Pi model relay** (`src/models/relay.ts`)
  - Pi의 OpenAI 호환 요청을 받아 MLX 또는 DGX(OmniRoute)로 보냄. 별칭은 `dgx/coding`, `dgx/fast`, `mlx/fast`이고 MLX 실패 시 `dgx/fast`로 폴백.
  - `selectBackend(request)` 훅이 정의돼 있으나 지금은 쓰이지 않음(`daemon.ts`가 넘기지 않음).
  - 응답을 SSE로 그대로 흘려보냄. 따라서 advisor gate에는 스트림 보류가 필요함.
- **hub inference** (`src/hub/inference.ts`)
  - digest 요약과 작업 분류(닫힌 목록)를 함.
  - 규칙: fail-open, 8초 제한, 실패 시 5분 backoff. 출력은 길이 제한 텍스트이거나 닫힌 목록과 대조한 값만.
- **peer 관측**
  - Codex: `item/completed`의 `fileChange`, `commandExecution`, `mcpToolCall`(`codex-appserver.ts`).
  - Claude: turn-free 프로젝트에서만 hook으로 도구 호출을 받음(Edit, Write, MultiEdit, Read, Bash 등).
  - local worker와 Pi: hub가 모든 호출을 앎.

## 설계 결정 (권고안)

- **E1 모듈 위치**
  - `src/models/route/`(모델 경로의 정책, 기존 `src/models/relay.ts`와 같은 층).
  - 작업 배정 정책인 `src/hub/routing.ts`와 이름이 겹치지 않게 함.
  - 파일: `signals.ts`, `stage.ts`, `plan-execute.ts`, `advisor.ts`, `escalation.ts`, `classifier.ts`(2순위), `judge.ts`(판정 해석, fence 제거, 닫힌 목록 대조), `text.ts`(middle-drop, truncate-middle, append-note), `state.ts`(세션별 상태, TTL, 상한), `prompts.ts`.
- **E2 호스트 주도 계약**
  - Switchyard의 `Step::CallModel`/`Done` 구조를 따름. 알고리즘은 "이 tier로" 또는 "이 판정기 요청을 대신 호출해 달라"를 돌려줌.
  - 호출은 호스트(local worker, relay, inference)가 기존 OmniRoute client로 수행. 순수 함수 테스트가 쉬워지고 runtime 의존성 0을 유지.
- **E3 충실도**
  - 상수, 공식, 어휘, 우선순위를 원문대로 옮김. 파일 머리에 원 경로와 커밋을 적음.
  - 의도한 차이는 spec에 목록으로 둠:
    - Escalation 판정기 실패를 fail-open으로.
    - REDO 피드백을 local worker 이력에 남김.
    - Responses·Codex 원시 블록 제외.
  - 문자 수는 Rust의 Unicode scalar 기준이므로 JS에서는 code point 단위(`[...s]`)로 셈. 정규식은 `u` 플래그.
- **E4 입력 정규화**
  - OpenAI chat 메시지를 Switchyard 내부 형태로 맞추는 어댑터.
    - `role: "tool"`은 사용자 역할의 도구 결과.
    - 인자 문자열은 JSON으로 해석하고, 실패하면 `{raw}`.
    - system 메시지는 지시문으로 분리.
  - peer 관측용 어댑터: Codex `commandExecution`(명령, exit code, 출력)과 `fileChange`, Claude hook 도구 호출을 같은 신호 구조로 변환.
- **E5 설정**
  - `routing.toml`에 `[hub_routes."<id>"]` 표를 새로 둠. 유형은 `stage`, `plan_execute`, `advisor`, `escalation`, tier는 OmniRoute 모델 id나 relay 별칭.
  - Switchyard sidecar용 `[routes.*]`와 분리해 sidecar 설정 생성기가 옮기지 않게 함.
  - local worker의 route가 `hub/` 접두면 hub 안에서, `sy/` 접두면 sidecar(있을 때)로 감.
- **E6 실패 처리**
  - 라우팅 판단이나 판정기 호출이 실패하면 기존 경로(`fixed_model`)로 폴백. turn과 전달을 늦추지 않음.
  - 판정기 호출에 deadline을 둠(inference와 같은 원칙).
- **E7 PII**
  - PII turn의 판정기·advisor 호출은 on-prem 경로가 확인될 때만(`onCampus()`). 아니면 검토 없이 진행.
  - peer 진행 판정은 PII 작업을 제외. 이벤트에 작업 텍스트를 넣지 않음(`publicView` 규칙).
- **E8 이벤트**
  - `route`: peer, route, tier, source(override, dimensions, hold, classifier, default), score, ms.
  - `advisor`: trigger, verdict, 버린 토큰.
  - `progress`: peer, task, severity, spinning, exploring, production.
  - `stuck`: peer, task, category, streak, latched.
  - `docs/events.md` 갱신. control WS 메시지 모양이 바뀌면 `PROTOCOL`을 올림.
- **E9 라이선스**
  - 이식한 파일마다 머리말을 둠: 원 SPDX 두 줄을 남기고, "Ported to TypeScript from NVIDIA NeMo Switchyard `<path>` at `c8848511`, modified"를 적음.
  - 저장소 루트에 `THIRD_PARTY_NOTICES.md`(Switchyard NOTICE 귀속 문구)와 `LICENSES/Apache-2.0.txt`.
  - `package.json` `files`와 `scripts/check.sh`의 npm tarball 내용 검사에 추가.
  - 프롬프트는 `prompts.ts`의 문자열 상수로 넣고 같은 머리말을 붙임.
- **E10 Switchyard 추적**
  - 고정 커밋 기준으로 이식. 상류 변경은 상수·어휘·프롬프트 파일의 diff를 보는 점검 스크립트로 분기마다 확인.
  - 자동 동기화는 하지 않음.

## 단계별 계획

### 0단계: spec과 뼈대

- 저장소 이슈 본문 = spec. 크기상 `docs/specs/`에 설계 파일을 둠(설계 spec의 L2 절 개정 포함).
- 라이선스 파일(E9), 모듈 뼈대, 프롬프트 상수, golden 테스트 틀.
- 완료 기준: `scripts/check.sh` 통과, npm tarball에 고지 파일 포함.

### 1단계: 순수 핵심 이식과 golden 테스트 (동작 변화 없음)

- **이식**
  - `signals.ts`: 추출, 어휘, 심각도, 지문, 테스트 통과 판정.
  - `stage.ts`: 차원, 점수, `pick_tier`, hold.
  - `plan-execute.ts`.
  - `text.ts`, `judge.ts`, `state.ts`.
  - `advisor.ts`: 트리거, 예산, transcript, 판정 해석, REDO 메시지 구성.
  - `escalation.ts`: 요약기, 연속·latch 상태기계.
- **golden 테스트** (Switchyard 테스트를 옮김)
  - tool_signals 표 테스트 약 60건(셸 분해, 포매터, 테스트 통과, 반복 실패 등).
  - `pick_tier`·override·note 동기 테스트 13건.
  - advisor 판정 해석 표 12건, middle-drop 정확 문자열, 예산 5건, 트리거 4건.
  - escalation 요약·창·상한·truncate 테스트 약 10건(Terminus 전용 5건 제외).
  - Plan/Execute 4건.
- **선택: 차등 검증**
  - 실제 agent-hub 대화(local worker·Pi 기록)를 모아 Rust 원본과 TS 이식의 결정을 비교.
  - Rust 빌드가 필요하므로 무거운 작업 규칙(한 번에 하나)을 따르고, 결과 fixture만 저장소에 넣음.
- **완료 기준**: golden 전부 통과, 판단 경로 p95가 메시지 200개 이력에서 수 ms 이내, `scripts/check.sh` 통과.

### 2단계: local worker 연결

- `call()`에 hub route를 추가.
  - stage: 매 호출 tier 선택.
  - plan_execute: 첫 변경 전 capable, 뒤로 efficient.
  - escalation: efficient 시작, 확인된 정체에서 capable로 latch.
  - advisor: 도구 호출 없는 마지막 응답을 상위 모델이 검토. REDO면 피드백을 이번 turn 메시지에 붙여 계속(`maxSteps` 안에서).
- 기본 tier: efficient `fast`, capable `coding`(OmniRoute 조합). 설정으로 바꿈.
- 이벤트(E8), 사용량 기록에 선택한 tier 표시.
- 기존 규칙 유지: 한 turn의 메시지는 turn 끝에 history로 합류(중간 push 금지), 부작용 있는 도구 실행 뒤 실패한 turn은 재전달하지 않음.
- 테스트: `test/fakes/model-server.ts`로 도구 결과를 각본화. 오류 반복 → capable, 테스트 통과 → hold 해제, APPROVE/REDO, 판정기 장애 → 폴백, PII → 판정기 생략.
- 완료 기준: 위 시나리오 통과, 라우팅 실패가 turn 실패로 번지지 않음, 문서(`docs/operations.md`, `templates/routing.toml`) 갱신.

### 3단계: Pi relay 연결

- **3a**: relay에 가상 별칭 `hub/auto`를 추가하고 `selectBackend`에서 stage 점수로 `dgx/coding`, `dgx/fast`, `mlx/fast` 중 선택.
  - MLX는 8k 컨텍스트이므로 입력이 크면 MLX를 후보에서 뺌. 기존 MLX→DGX 폴백 유지.
- **3b** (선택): Pi의 advisor gate. SSE 응답을 보류했다가 재생해야 하므로 스트림 버퍼(`buffered_response` 약 80줄)를 함께 이식.
- 완료 기준: 별칭 선택 테스트, 폴백 테스트, Pi 실사용 smoke 1회.

### 4단계: peer 진행 신호와 정체 판정 (연구용)

- **진행 신호**
  - E4의 관측 어댑터로 peer·작업별 신호를 계산해 `progress` 이벤트로 남김.
  - 대상: Codex, local, Pi, Claude(turn-free hook이 있을 때만).
- **정체 판정**
  - inference에 escalation 판정을 추가함. 프롬프트는 "모델 tier"를 "다른 peer로 이관"으로 바꿔 고쳐 씀. 결과는 닫힌 목록과 대조.
  - 판정기 호출은 진행 신호가 문제를 보일 때만(오류 반복, spinning) 해서 비용을 줄임.
  - 연속·latch는 peer·작업별.
- **출력**: 콘솔 알림과 `stuck` 이벤트, 재배정 제안까지. 자동 이관은 하지 않음(측정 뒤 결정).
- **연구 쪽**: 벤치마크 ledger에 진행 신호 시계열을 넣어 NC3 분석 자료로 씀(관측 범위가 peer마다 다르다는 점을 함께 기록).
- 완료 기준: Codex 각본 테스트, PII 제외 테스트, 판정기 장애 시 fail-open.

### 5단계: sidecar 존치 결정

- 2·3단계 뒤 hub 자체 트래픽이 in-process 라우팅으로 충분하면, Switchyard sidecar를 선택 기능으로 낮춤. 이식하지 않은 알고리즘(composite 분류기, sub-agent)이 필요할 때만 사용.
- 구독 에이전트 측정 프록시(비교 보고서의 D4)는 이 계획 밖. 별도 결정.

## 규모와 일정 (추정)

- 0단계: 0.5일.
- 1단계: 2~3일. 이식 약 1,700~2,100줄, 테스트 약 1,500줄.
- 2단계: 1.5~2일. 연결 약 300~500줄, 테스트.
- 3단계: 3a 0.5일, 3b 1일.
- 4단계: 2일.
- 각 단계는 별도 PR. Full PR 게이트(OCR 리뷰, CI 두 플랫폼) 적용.
- ICSE Tool Demo(10-23) 일정과 겹치므로 착수 시점은 결정 대기.

## 위험

- **보정 차이**: Switchyard의 임계값과 어휘는 그쪽 벤치마크 모델(GPT-5.6 Luna/Sol 등)로 맞춘 것. 우리 tier(OmniRoute `coding`·`fast`, MLX 4B)에서는 다시 맞춰야 함. 기본은 efficient-first, 임계값은 측정 뒤 조정.
- **휴리스틱의 오판**: 원문에서도 `ls x 2> /dev/null`이 쓰기로 분류되는 등 부분 문자열 규칙의 한계가 있음. 그대로 옮기고 golden으로 고정하되, 고칠 때는 의도한 차이로 기록.
- **하네스 어휘 변화**: 벤더 도구 이름이 바뀌면 신호가 틀어짐. 상류 점검(E10)과 peer 관측 어댑터의 테스트로 대응.
- **컨텍스트 한도**: MLX 8k에서 도구 이력이 길면 넘침. relay의 입력 추정과 폴백을 유지하고, 컨텍스트 초과 문구 탐지(Switchyard 호출 정책)를 2순위로 이식.
- **REDO와 이력**: Switchyard는 REDO를 클라이언트 이력에 남기지 않지만, 우리는 hub가 이력을 가지므로 남김. 같은 피드백이 다음 turn 판단에 영향을 줄 수 있음. 테스트로 확인.
- **라이선스**: 고지 누락 시 Apache-2.0 위반. tarball 검사에 넣어 막음.
- **관측 범위의 비대칭**: Claude는 turn-free hook이 있을 때만 도구 호출이 보임. 4단계 자료를 비교할 때 이 차이를 명시.

## 이슈 구성안 (등록은 승인 후)

- 상위: "Port Switchyard routing logic in-process (stage, plan/execute, advisor gate, escalation)". spec 파일 동반.
- 하위 A: "Pure routing core ported from Switchyard with golden tests and license notices" (0·1단계).
- 하위 B: "In-process model routes for the local worker" (2단계).
- 하위 C: "hub/auto alias in the Pi model relay" (3a, 3b는 선택).
- 하위 D: "Peer progress signals and stuck verdicts" (4단계).
- 각 이슈 본문 = spec. 착수는 이슈별 지시 후.

## 결정이 필요한 사항

- 이식 범위 A~D 승인과 이슈 등록.
- tier 대응: efficient `fast`, capable `coding`, MLX의 역할.
- REDO 피드백을 local worker 이력에 남기는 정책.
- 4단계의 자동 재배정 여부(권고: 하지 않음, 측정 뒤 결정).
- 1단계의 차등 검증(Rust 빌드 필요) 실행 여부.
- Switchyard sidecar의 장래(5단계).
- 착수 시점(ICSE Tool Demo 마감 10-23 이후 권고).

## 근거

- Switchyard(main `c8848511a7e2e1d605070c7a68905bdc24c6481a`, 2026-10-02, 로컬 shallow clone)
  - `crates/libsy/src/algorithms/stage.rs`, `util/stage.rs`(상수 35~47행, 점수 335~347행), `util/tool_signals.rs`(심각도 31~33행, 어휘 100~224행).
  - `advisor_gate.rs`, `advisor_gate/{budget,trigger,transcript,turn,signals}.rs`(middle-drop 51~73행, 실패 상한 18행).
  - `escalation.rs`, `util/escalation.rs`(기본값 134~143행), `plan_execute.rs`, `llm_class.rs`, `util/{llm_judge,robustness,affinity,prompts}.rs`, `fall_through.rs`.
  - `crates/libsy/src/prompts/*`, `crates/libsy-llm-client/src/{client,backend,run}.rs`(호출 정책).
  - 소스 분석 보고(조사 에이전트, 2026-10-04)와 주요 상수·공식의 직접 확인.
- agent-hub(main `ab16c7b`)
  - `src/adapters/local-worker.ts`(`call()`, `commit()`), `src/local/tools.ts`(도구 이름), `src/models/relay.ts`(`selectBackend`, 폴백), `src/hub/daemon.ts`(relay 시작, Pi 설정), `src/hub/inference.ts`, `src/hub/facts.ts`, `src/adapters/codex-appserver.ts`, `test/fakes/model-server.ts`, `docs/events.md`, `AGENTS.md`(inference·history·PII 규칙).
  - 기본 설정: Pi `dgx_coding = "coding"`, `dgx_fast = "fast"`, MLX `qwen3.5:4b-mlx`(8k).

## Implementation contract (approved 2026-10-04)

- Required scope: phases A (0/1), B (2), C (3a), D (4).
- Defaults: efficient `fast`, capable `coding`; MLX only within its configured input and output context limit.
- REDO feedback stays in the completed local turn history. Failed turns never leave unmatched tool calls.
- PII bypasses optional judges unless the exact on-campus gateway is positively confirmed; progress tracking is disabled while PII work is open.
- Optional Pi advisor SSE replay and Rust differential build are deferred. No automatic peer reassignment.
- Existing sidecar routes remain optional and backward compatible; `[hub_routes]` never enters generated sidecar TOML. The sidecar retirement decision remains evidence-driven.
- Each required phase is a separate reviewable commit and PR. No release or production configuration changes are implied.

Implementation tracking: [#124](https://github.com/STAIxBWLB/agent-hub/issues/124), core [#125](https://github.com/STAIxBWLB/agent-hub/issues/125), local [#126](https://github.com/STAIxBWLB/agent-hub/issues/126), Pi [#127](https://github.com/STAIxBWLB/agent-hub/issues/127), observations [#128](https://github.com/STAIxBWLB/agent-hub/issues/128).
