# 개발 안내

## 문서 작성 원칙

문서에는 현재 구현의 스펙·지원 범위·사용법·운영 절차만 기록한다. 변경 이력, 구현 전 계획, 도입 배경, 특정 시점의 테스트·성능 측정 결과는 Git 이력으로 확인한다. 기능을 변경할 때는 해당 명세를 직접 갱신하고 중복 설명은 기준 문서로 연결한다. 현재 지원하는 호환 동작과 제한은 명세에 포함한다.

## 실행 환경

서버는 Node.js 22.13 이상과 기본 모듈을 사용하며 패키지 설치·빌드가 필요하지 않다. 브라우저의 HTML 정제용 DOMPurify 배포 파일을 저장소에 포함하며 [버전·라이선스·갱신 절차](third-party.md)를 따른다. `node server.mjs`로 실행한다. 환경 변수와 VS Code 디버깅은 [README](../README.md#실행)를 참고한다.

프런트엔드와 서버는 함께 갱신하며 서버 코드 변경 후 개발 서버를 재시작한다. 실제 데이터, `.env`, `branding.json`은 환경별로 관리하고 커밋하지 않는다. 테스트는 임시 데이터 디렉터리와 로컬 HTTP 서버를 사용한다.

## 코드 구조

| 영역 | 파일과 역할 |
| --- | --- |
| 서버 | `server.mjs`: HTTP/HTTPS, 세션, 인증·출처 검사, API와 정적 파일 |
| 시작 암호 | `lib/startup.mjs`: 실행 옵션·암호 파일 검증. `lib/setup-marker.mjs`: 시작 시 신규·완료·불완전 저장소 구분. [운영 계약](deployment.md#시작-암호로-백그라운드-준비) |
| 비밀번호 정책 | `public/password-spec.js`: 신규 설정의 공통 문자·길이 규칙. `lib/vault.mjs`: 신규 설정과 기존 암호 검증 분리. [호환 계약](passwords.md) |
| 이벤트·서비스 | `lib/services.mjs`: 서비스 목록·이벤트 서비스 선택 검증. `lib/vault.mjs`: 이벤트 검증·키 도출·암호화 저장 |
| 이벤트 본문 | `public/event-content.js`: 기존 데이터의 본문 기본값. `public/event-body-ui.js`: 입력·미리보기·HTML 정제와 격리 표시 |
| 저장·조회 | `lib/daily-storage.mjs`: 날짜별 파일과 관리 파일. `lib/daily-index.mjs`, `lib/record-queries.mjs`: 기간 요약·ID 색인·페이지 조회 |
| 브랜딩 | `lib/branding.mjs`: 설정 읽기·검증·저장·충돌 검사. `public/theme.js`: 브라우저별 테마 |
| 비밀 값 저장소 | `lib/secret-store.mjs`: 앱 공용 값 저장·버전·요청 직전 조회. `public/vault-spec.js`: 키·한도. `public/vault-ui.js`: 설정 화면. [계약](vault.md) |
| 워크플로우 정의 | `public/workflow-spec.js`: 공통 노드 규격·제한. `lib/workflow-definition.mjs`: 정의·cron·템플릿 검증. `lib/workflow-file.mjs`: JSON 교환·참조 검증 |
| 워크플로우 실행 | `lib/workflows.mjs`: 저장·버전·실행 접수. `lib/workflow-engine.mjs`: 예약·큐·HTTP 호출. `lib/service-state.mjs`: 서비스 상태 집계·보류 |
| 노드 계산·Dry-Run | `lib/workflow-step.mjs`, `lib/workflow-values.mjs`: 실제 실행·모의 실행의 공통 계산. `lib/workflow-dry-run.mjs`, `lib/workflow-dry-run-service.mjs`: 모의 실행·일정 경계 재현 |
| 감사·보관 정책 | `lib/audit.mjs`: 변경·실행 기록. `lib/log-policy.mjs`, `lib/log-maintenance.mjs`: 정책 검증·예약 정리·중단 복구 |
| 초기화 | `lib/setup-marker.mjs`: 완료 파일 생성·삭제 감지. `lib/reset.mjs`: 작업 중지·부분/전체 초기화·복구 |
| 내보내기·복원 | `lib/data-transfers.mjs`: 작업 수명. `lib/archive-worker.mjs`, `lib/archive-data.mjs`, `lib/archive-zip.mjs`: ZIP·검증·암호화 준비. `lib/restore-journal.mjs`: 적용·복구 |
| 화면 | `public/app.js`, `public/date-utils.js`, `public/event-loader.js`: 캘린더·타임라인·날짜·조회. `public/*-ui.js`: 기능별 화면. `public/workflow-layout.js`: 그래프 배치 |

워크플로우 배치는 `workflow-layout.js`에서 위상 순서의 계층을 만들고, 포트 순서를 유지하는 무게중심 정렬로 교차를 줄인 뒤 간격·열 분할 후보를 비교한다. 경계와 겹침 방지를 우선하며 지원 상한인 노드 100개·연결 200개에서도 고정 캔버스를 사용한다. `workflow-routing.js`는 노드 경계와 포트 탈출점을 좌표축으로 사용해 직교 회피 경로를 탐색한다. 배치와 경로 계산은 외부 패키지·서버 호출 없이 수행한다. 경로는 같은 기하 정보에서 재사용하며 노드 드래그 중에는 기본 곡선으로 연결하고 이동 종료 후 다시 계산한다. 교차 수의 전역 최솟값이나 공유 구간 제거를 보장하지 않는다.

## 저장과 실행 경계

내부 저장소는 schema 5를 지원한다. 지원하지 않는 schema는 원본을 보존하고 오류를 반환한다. 날짜별 파일 형식과 인증 API는 [서비스 모델](services-model.md), 보관 기준은 [화면·동작 명세](specification.md#데이터-보관-정책), 백업·복구 절차는 [README](../README.md#저장백업복구)에 정의한다.

`Vault.state`에는 메타데이터와 빈 기록 배열을 유지한다. 본문은 비동기 `read`/`audit`/`getRecord` 또는 범위를 지정한 `snapshot`으로 읽는다. `Workflows.readRun`도 비동기다. 운영 경로의 `mutate` 호출에는 필요한 `scope`를 지정한다. 기본 전체 `snapshot`·`mutate`는 테스트·명시적인 전체 관리 작업에 사용한다. `public/event-loader.js`는 요청 취소·응답 순서·페이지 revision 충돌을 처리한다.

저장은 같은 인스턴스의 큐에서 직렬화한다. 날짜 파일을 먼저 기록·동기화한 뒤 관리 파일을 교체한다. `lib/file-replace.mjs`는 Windows의 `EPERM`·`EACCES`·`EBUSY` 파일 교체 오류를 최초 시도 포함 최대 7회, 누적 대기 최대 800ms로 재시도한다. 목적지를 먼저 삭제하거나 외부 HTTP 요청을 반복하지 않는다.

이벤트·서비스 검증은 워크플로우 실행 결과와 독립적이다. 실행기는 외부 호출 전에 시도를 저장하고 결과 저장 후 다음 노드로 이동한다. 기록 저장에 실패하면 후속 호출·새 접수를 중지한다. 실행·중단·재평가 기준은 [워크플로우 사용 안내](workflows.md)와 [JSON 작성 안내](workflow-authoring.md)를 따른다.

초기화와 복원은 새 API 작업을 막고 진행 중 쓰기·워크플로우·정리 작업을 조율한다. 완료 파일과 내부 파일은 데이터와 함께 백업한다. ZIP 검증은 원본을 변경하지 않으며, 승인된 복원은 재시작 후 완료할 수 있도록 기록한다. 상세 범위는 [초기화 명세](specification.md#danger-zone)와 [데이터 내보내기·복원](data-transfer.md)에 정의한다.

## 검증

```sh
node scripts/coverage-check.mjs
```

작업 완료 시 위 명령 또는 `npm run check`를 실행한다. 전체 Node 테스트를 실행하고, 기본적으로 HEAD 대비 staged·unstaged 변경과 Git에서 무시하지 않는 새 파일을 함께 검사한다. 이미 커밋한 브랜치 변경은 `node scripts/coverage-check.mjs --base main` 또는 `npm run check -- --base main`으로 검사한다. 이 경우 기준 ref와 HEAD의 공통 조상부터 현재 작업 파일까지 비교한다.

변경 추적 대상은 `server.mjs`, `lib/**/*.mjs`, `lib/**/*.js`, `public/**/*.mjs`, `public/**/*.js`이며 `public/vendor/`는 제외한다. `scripts/coverage-changes.mjs`의 `BROWSER_ONLY_FILES`에 명시한 브라우저 전용 파일은 Node 측정·경고 대상에서 분리하고, 변경 시 `[브라우저 검증 필요]`로 파일 목록을 출력한다. 이 안내는 브라우저 검증을 자동 실행하거나 통과를 판정하지 않는다. 해당 파일은 아래 화면 검증으로 확인한다.

서버와 공통 모듈은 Node 측정을 유지한다. `password-spec.js`, `date-utils.js`, `workflow-spec.js`와 같은 공통 모듈, Node 테스트에서 날짜 계산을 검증하는 `audit-ui.js`는 브라우저 전용 목록에 포함하지 않는다. 새 파일도 목록에 명시하기 전에는 Node 검사 대상이다. 모듈의 실행 환경·역할이 바뀌면 목록과 검증 범위를 함께 확인한다.

삭제된 줄·파일과 빈 줄은 검사하지 않는다. Node 검사 대상의 현재 추가·수정 줄 중 LCOV가 미실행으로 기록한 줄·분기를 파일명과 줄 번호로 경고한다. 줄 측정 항목이 없는 위치는 실행 여부를 판정하지 않으며, 파일 전체가 보고서에서 빠졌으면 측정 정보 없음으로 경고한다.

coverage 경고만으로는 실패하지 않는다. 테스트 실패, 잘못된 기준 ref, 측정 보고서 누락·빈 결과는 종료 코드 1로 처리한다. 실행별 보고서는 `.tmp/coverage-*/coverage.lcov`에 보관한다. Node 내장 실험적 coverage를 사용하며 브라우저 coverage는 합산하지 않는다. coverage는 실행 여부만 나타내므로 요구사항 누락, 검증문 적절성, 경계값 검증을 보장하지 않는다. 화면 변경 시 아래 브라우저 검증도 실행한다.

검증 명령이 성공하면 마지막에 요구사항별 TC, 화면 검증, coverage 경고 처리, 커밋 형식을 재확인하는 안내를 출력한다. 안내 항목은 자동으로 판정하지 않으며 종료 코드에도 영향을 주지 않는다. 작업 완료 절차와 커밋 작성 기준은 [에이전트 작업 규칙](../AGENTS.md)을 따른다.

coverage 없이 Node 테스트만 실행할 때는 다음 명령을 사용한다.

```sh
node --test test/*.test.mjs
```

암호화·인증·충돌·날짜·브랜딩·서비스·저장 범위·감사 기록·워크플로우·초기화·ZIP 복원을 검증한다. 테스트 파일은 `test/`에서 기능별로 나뉜다. 워크플로우 파일 검증·로컬 연동 예제·실행 예산 명령은 [작성 안내](workflow-authoring.md#실행-한도와-검증)를 참고한다.

화면 검증에는 설치된 Chromium 계열 브라우저를 사용한다. 기본 경로는 Windows Microsoft Edge이며 다른 환경에서는 `BROWSER_PATH`로 실행 파일을 지정한다. 테스트용 서버·프로필·암호화 파일은 임시 생성 후 정리하고 캡처는 `.tmp/screenshots/`에 남긴다.

| 명령 | 검증 범위 |
| --- | --- |
| `node scripts/browser-check.mjs` | 캘린더·타임라인·수기 편집·이벤트 복제·메모와 Text/HTML 본문·설정·비밀 값 등록·교체·삭제·충돌·감사 조회·모바일·XSS 렌더링·외부 리소스 차단·안내문 링크와 외부 이동 확인·세션 |
| `node scripts/http-browser-check.mjs` | 브라우저 내부에서 `navix.test`를 로컬 서버로 연결한 일반 HTTP 환경. `--localhost`로 로컬 주소 비교 |
| `node scripts/workflow-browser-check.mjs` | 워크플로우 파일 교환·편집·저장·실행·Dry-Run·보류·재평가 |
| `node scripts/danger-zone-browser-check.mjs` | 부분·전체 초기화 확인과 취소 |
| `node scripts/setup-marker-browser-check.mjs` | 완료 파일 삭제에 따른 최초 설정 화면 |
| `node scripts/data-transfer-browser-check.mjs` | ZIP 다운로드·업로드·검증·복원·모바일 |
