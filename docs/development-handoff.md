# 개발 메모 — 2026-09-10

## 현재 상태

이벤트·서비스는 독립적으로 관리하고 자동화는 워크플로우로 구성한다. 상단 메뉴는 `캘린더 | 타임라인 | 워크플로우 | 감사 로그`다.

- 이벤트·서비스 검증은 `lib/services.mjs`, 암호화 저장은 `lib/vault.mjs`에서 담당한다. 서비스 UI는 `public/services-ui.js`다.
- 감사 로그는 변경 기록과 실제 워크플로우 실행을 조회한다. 실행 상세에서 노드 결과·실행 당시 구성·입력을 확인하고 중지·다시 실행을 제공한다.
- 워크플로우는 `lib/workflow-definition.mjs`, `lib/workflows.mjs`, `lib/workflow-engine.mjs`로 저장·버전·실행·스케줄링을 제공한다. 화면은 `public/workflow-ui.js`와 `public/workflow.css`다. 저장·되돌리기·수동 실행·ON/OFF를 지원하며 목업 예시는 제거했다.

## 저장소

내부 schema는 5이며 워크플로우 정의와 실행 기록을 포함한다. 현재 저장소 모델만 지원하고 이전 schema를 자동 이관하지 않는다. 날짜별 암호화 저장·보관 정책과 API는 [서비스 모델](services-model.md), README와 명세를 참고한다.

프런트엔드와 서버를 함께 갱신하고 기존 개발 서버는 재시작한다. 실제 데이터, `.env`, `branding.json`은 수정하거나 커밋하지 않는다.

설정의 Danger Zone은 대상 확인 후 별도 비밀번호 팝업을 거쳐 부분·전체 초기화한다. 비밀번호를 잊은 운영자는 `DATA_DIR/SETUP_COMPLETE.txt`를 삭제해 전체 초기화할 수 있다. `lib/setup-marker.mjs`가 완료 파일 생성·삭제 감지·기존 설치 도입을, `lib/reset.mjs`가 작업 중지 후 데이터 삭제와 중단 복구를 담당한다. `.setup-marker-enabled`는 기존 설치를 보호하는 내부 파일이다. 백업 시 두 파일도 포함한다. 서버 시작과 요청 및 1초 타이머에서 삭제를 감지하며 초기화가 완료된 뒤에만 새 비밀번호를 받는다. `test/setup-marker.test.mjs`는 재시작·잠금·기존 설치 보존·잘못된 파일·작업 중지·실패 복구·진행 중 쓰기를 검증한다. 자세한 운영 순서는 README를 참고한다.

## 확정된 데이터 보관 정책

시스템 설정의 **로그 관리 정책**에서 cron, 이벤트 보관 **30~3,650일**(기본 **1,825일**), 감사 로그 로테이션 **7~180일**(기본 **90일**)을 저장한다. 기본 일정은 서비스 시간대 기준 매일 03:00이다. 이벤트는 종료 시각부터 계산하고 종료 미정은 제외하며, 기한이 지난 감사 로그는 삭제한다.

`lib/log-policy.mjs`가 정책을 검증하고 `lib/log-maintenance.mjs`가 예약 정리·감사 기록·중복 실행 방지를 담당한다. `lib/daily-storage.mjs`가 날짜별 암호화 JSON과 작은 관리 파일을 저장한다. cron은 UTC 기준일 이전의 날짜 파일을 삭제하며 종료 미정·진행 중인 실행은 별도로 유지한다. 미완료 삭제 목록을 저장해 재시작 후 이어서 처리하고 완료 여부를 감사 기록에 반영한다. `public/log-policy-ui.js`가 설정 그룹을, `public/audit-ui.js`가 처리 결과 상세를 제공한다. API·기준일·백업 절차는 [명세의 데이터 보관 정책](specification.md#데이터-보관-정책)과 README에 있다. `test/log-maintenance.test.mjs`에서 경계·인증·충돌·파일 삭제·재시작·저장 실패·타이머를 검증한다.

`lib/daily-index.mjs`·`lib/record-queries.mjs`가 기간 요약·ID 색인·페이지 조회를 담당하며 새 형식의 잠금 해제는 날짜 본문을 읽지 않는다. `public/event-loader.js`는 요청 취소·응답 순서·페이지 revision 충돌을 제어한다. `test/period-storage.test.mjs`와 `test/event-loader.test.mjs`에서 파일 접근 범위·캐시·손상 격리·이동 실패 재시도·응답 순서 역전을 검증한다.

`Vault.state`는 메타데이터와 빈 기록 배열이며, 본문은 비동기 `read`/`audit`/`getRecord` 또는 범위를 지정한 `snapshot`으로 읽는다. `Workflows.readRun`도 비동기다. `mutate`의 운영 호출은 필요한 `scope`를 지정한다. 기본 전체 `snapshot`·`mutate`는 테스트·명시적 전체 관리 작업에만 사용한다.

## 검증

`node --test test/*.test.mjs`는 암호화·인증·동시 쓰기·충돌·날짜·브랜딩·서비스·지원하지 않는 schema 보존·감사 이력·폐기 API를 검증한다. `node scripts/browser-check.mjs`는 설치된 Chromium 브라우저와 임시 데이터로 캘린더·타임라인·수기 편집·설정·감사 조회·모바일·XSS 렌더링·세션을 검증한다. `node --test test/workflows.test.mjs`와 `node scripts/workflow-browser-check.mjs`는 저장·예약·조건·HTTP·비밀 가림·취소·재시작·이력·재실행과 편집 화면을 검증한다. HTTP 통합 테스트는 로컬 서버만 호출한다.

시작·종료는 입력한 시각에 실행하고 지난 시각은 소급하지 않는 기준으로 확정했다. HTTP 응답에 따른 전체 성공·실패는 작성자가 조건과 종료 노드로 정의한다. [워크플로우 사용 안내](workflow-transition-plan.md)에 실제 구현과 제한을 정리했다.

## JSON 작성과 서비스 상태 트리거

워크플로우당 100개 노드, JSON 입출력·CLI 검증, 서비스 상태 변경·목록 검색·날짜 시각 노드, 경로 비교·복합 조건, 서비스별 직렬화·불명 결과 보류·수동 해소를 제공한다. [작성·연동 안내](workflow-authoring.md), `examples/workflows/service-state-http.json`, `scripts/workflow-demo.mjs`를 인계 기준으로 사용한다. Windows 일시 파일 교체 오류는 `lib/file-replace.mjs`의 제한된 재시도를 사용한다. 새 기능의 저장·재시작·UI·예제 검증은 안내의 명령을 따른다.
