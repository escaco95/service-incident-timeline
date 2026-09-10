# 개발 안내

## 문서 작성 원칙

문서에는 현재 구현의 스펙·지원 범위·사용법·운영 절차만 기록한다. 변경 이력, 구현 전 계획, 도입 배경, 특정 시점의 테스트·성능 측정 결과는 Git 이력으로 확인한다. 기능을 변경할 때는 해당 명세를 직접 갱신하고 중복 설명은 기준 문서로 연결한다. 현재 지원하는 호환 동작과 제한은 명세에 포함한다.

## 실행 환경

Node.js 22.13 이상과 기본 모듈만 사용하며 패키지 설치·빌드가 필요하지 않다. `node server.mjs`로 실행한다. 환경 변수와 VS Code 디버깅은 [README](../README.md#실행)를 참고한다.

프런트엔드와 서버는 함께 갱신하며 서버 코드 변경 후 개발 서버를 재시작한다. 실제 데이터, `.env`, `branding.json`은 환경별로 관리하고 커밋하지 않는다. 테스트는 임시 데이터 디렉터리와 로컬 HTTP 서버를 사용한다.

## 코드 구조

| 영역 | 파일과 역할 |
| --- | --- |
| 서버 | `server.mjs`: HTTP/HTTPS, 세션, 인증·출처 검사, API와 정적 파일 |
| 이벤트·서비스 | `lib/services.mjs`: 서비스 목록·이벤트 서비스 선택 검증. `lib/vault.mjs`: 이벤트 검증·키 도출·암호화 저장 |
| 저장·조회 | `lib/daily-storage.mjs`: 날짜별 파일과 관리 파일. `lib/daily-index.mjs`, `lib/record-queries.mjs`: 기간 요약·ID 색인·페이지 조회 |
| 브랜딩 | `lib/branding.mjs`: 설정 읽기·검증·저장·충돌 검사. `public/theme.js`: 브라우저별 테마 |
| 워크플로우 정의 | `public/workflow-spec.js`: 공통 노드 규격·제한. `lib/workflow-definition.mjs`: 정의·cron·템플릿 검증. `lib/workflow-file.mjs`: JSON 교환·참조 검증 |
| 워크플로우 실행 | `lib/workflows.mjs`: 저장·버전·실행 접수. `lib/workflow-engine.mjs`: 예약·큐·HTTP 호출. `lib/service-state.mjs`: 서비스 상태 집계·보류 |
| 노드 계산·Dry-Run | `lib/workflow-step.mjs`, `lib/workflow-values.mjs`: 실제 실행·모의 실행의 공통 계산. `lib/workflow-dry-run.mjs`, `lib/workflow-dry-run-service.mjs`: 모의 실행·일정 경계 재현 |
| 감사·보관 정책 | `lib/audit.mjs`: 변경·실행 기록. `lib/log-policy.mjs`, `lib/log-maintenance.mjs`: 정책 검증·예약 정리·중단 복구 |
| 초기화 | `lib/setup-marker.mjs`: 완료 파일 생성·삭제 감지. `lib/reset.mjs`: 작업 중지·부분/전체 초기화·복구 |
| 내보내기·복원 | `lib/data-transfers.mjs`: 작업 수명. `lib/archive-worker.mjs`, `lib/archive-data.mjs`, `lib/archive-zip.mjs`: ZIP·검증·암호화 준비. `lib/restore-journal.mjs`: 적용·복구 |
| 화면 | `public/app.js`, `public/date-utils.js`, `public/event-loader.js`: 캘린더·타임라인·날짜·조회. `public/*-ui.js`: 기능별 화면. `public/workflow-layout.js`: 그래프 배치 |

## 저장과 실행 경계

내부 저장소는 schema 5를 지원한다. 지원하지 않는 schema는 원본을 보존하고 오류를 반환한다. 날짜별 파일 형식과 인증 API는 [서비스 모델](services-model.md), 보관 기준은 [화면·동작 명세](specification.md#데이터-보관-정책), 백업·복구 절차는 [README](../README.md#저장백업복구)에 정의한다.

`Vault.state`에는 메타데이터와 빈 기록 배열을 유지한다. 본문은 비동기 `read`/`audit`/`getRecord` 또는 범위를 지정한 `snapshot`으로 읽는다. `Workflows.readRun`도 비동기다. 운영 경로의 `mutate` 호출에는 필요한 `scope`를 지정한다. 기본 전체 `snapshot`·`mutate`는 테스트·명시적인 전체 관리 작업에 사용한다. `public/event-loader.js`는 요청 취소·응답 순서·페이지 revision 충돌을 처리한다.

저장은 같은 인스턴스의 큐에서 직렬화한다. 날짜 파일을 먼저 기록·동기화한 뒤 관리 파일을 교체한다. `lib/file-replace.mjs`는 Windows의 `EPERM`·`EACCES`·`EBUSY` 파일 교체 오류를 최초 시도 포함 최대 7회, 누적 대기 최대 800ms로 재시도한다. 목적지를 먼저 삭제하거나 외부 HTTP 요청을 반복하지 않는다.

이벤트·서비스 검증은 워크플로우 실행 결과와 독립적이다. 실행기는 외부 호출 전에 시도를 저장하고 결과 저장 후 다음 노드로 이동한다. 기록 저장에 실패하면 후속 호출·새 접수를 중지한다. 실행·중단·재평가 기준은 [워크플로우 사용 안내](workflows.md)와 [JSON 작성 안내](workflow-authoring.md)를 따른다.

초기화와 복원은 새 API 작업을 막고 진행 중 쓰기·워크플로우·정리 작업을 조율한다. 완료 파일과 내부 파일은 데이터와 함께 백업한다. ZIP 검증은 원본을 변경하지 않으며, 승인된 복원은 재시작 후 완료할 수 있도록 기록한다. 상세 범위는 [초기화 명세](specification.md#danger-zone)와 [데이터 내보내기·복원](data-transfer.md)에 정의한다.

## 검증

```sh
node --test test/*.test.mjs
```

암호화·인증·충돌·날짜·브랜딩·서비스·저장 범위·감사 기록·워크플로우·초기화·ZIP 복원을 검증한다. 테스트 파일은 `test/`에서 기능별로 나뉜다. 워크플로우 파일 검증·로컬 연동 예제·실행 예산 명령은 [작성 안내](workflow-authoring.md#실행-한도와-검증)를 참고한다.

화면 검증에는 설치된 Chromium 계열 브라우저를 사용한다. 기본 경로는 Windows Microsoft Edge이며 다른 환경에서는 `BROWSER_PATH`로 실행 파일을 지정한다. 테스트용 서버·프로필·암호화 파일은 임시 생성 후 정리하고 캡처는 `.tmp/screenshots/`에 남긴다.

| 명령 | 검증 범위 |
| --- | --- |
| `node scripts/browser-check.mjs` | 캘린더·타임라인·수기 편집·설정·감사 조회·모바일·XSS 렌더링·세션 |
| `node scripts/http-browser-check.mjs` | 브라우저 내부에서 `navix.test`를 로컬 서버로 연결한 일반 HTTP 환경. `--localhost`로 로컬 주소 비교 |
| `node scripts/workflow-browser-check.mjs` | 워크플로우 파일 교환·편집·저장·실행·Dry-Run·보류·재평가 |
| `node scripts/danger-zone-browser-check.mjs` | 부분·전체 초기화 확인과 취소 |
| `node scripts/setup-marker-browser-check.mjs` | 완료 파일 삭제에 따른 최초 설정 화면 |
| `node scripts/data-transfer-browser-check.mjs` | ZIP 다운로드·업로드·검증·복원·모바일 |
