# JSON으로 워크플로우 작성하기

2026-09-10. 사내 에이전트는 JSON 파일을 작성·검증하고, 운영자는 워크플로우 화면에서 가져오기·검토·저장할 수 있다. 실행은 기존 단일 서버의 순차 실행기를 사용한다. 워크플로우당 최대 100개 노드·200개 연결이며 반복·병렬 분기는 지원하지 않는다.

## 시작 순서

1. [서비스 상태 조회·적용·검증 예제](../examples/workflows/service-state-http.json)를 복사한다. 15개 노드이며 가상 서비스 `resource-a`와 로컬 URL을 사용한다.
2. 서비스 문자열 조건, 외부 URL, 요청값, 응답 배열의 키와 성공·검증 조건을 배포 환경에 맞게 수정한다. 비밀 값은 `{{secrets.TOKEN}}`처럼 참조하고 파일의 `requiredSecrets`에 이름을 추가한다.
3. 아래 검증 명령으로 파일·연결·변수 선행 조건·시도 예산을 확인한다. 이 명령은 서버나 외부 API를 호출하지 않는다.
4. 화면의 **JSON 가져오기**에서 파일과 정규화된 정의를 확인하고 **새 OFF 초안**으로 가져온다. **현재 편집 초안에 적용**하면 기존 저장 버전은 유지되고, 저장 버튼을 누를 때 반영된다.
5. 필요한 비밀 변수를 설정한 뒤 저장한다. 상태 트리거의 수동 실행에서는 평가할 서비스 문자열을 입력한다. 실제 호출 전에 해당 배포의 요청·응답 조건을 확인한다.
6. ON으로 활성화하면 이후 서비스 계산 상태 변경을 자동 접수한다. 최초 기준점 수립은 자동 호출을 발생시키지 않는다. 최초 동기화가 필요하면 현재 상태 수동 실행을 사용한다.

```sh
node scripts/workflow-validate.mjs examples/workflows/service-state-http.json
node scripts/workflow-validate.mjs my-workflow.json --draft
node scripts/workflow-validate.mjs my-workflow.json --normalize
```

기본 명령은 실행 가능한 정의를 요구한다. `--draft`는 미완성 초안을 허용하고 `executableError`를 알려준다. `--normalize`는 좌표와 설정 기본값을 포함한 교환 JSON을 표준 출력에 쓴다. 실패 시 종료 코드는 1이며 오류 위치 또는 노드 ID를 제공한다.

## 파일 계약

[JSON Schema](../schemas/workflow-file-v1.schema.json)는 편집기 자동 완성용이며, 실행 의미 검증은 위 CLI와 서버의 공통 검증기를 사용한다.

```json
{
  "format": "service-incident-timeline/workflow",
  "formatVersion": 1,
  "definition": { "name": "워크플로우 이름", "nodes": [], "edges": [] },
  "requiredSecrets": []
}
```

- 파일 형식 버전, 저장 충돌용 `version`, 실행 정의의 `definitionVersion`은 서로 다르다. 지원하지 않는 버전·노드·설정 필드를 조용히 버리지 않는다.
- 노드는 `id`, `type`, `config`, 선택적인 `name`, `x`, `y`를 사용한다. ID는 영문·숫자·밑줄·하이픈 1~80자다. 좌표가 없으면 파일 순서대로 같은 격자에 배치한다. 화면의 자동 정렬로 연결 순서에 맞출 수 있다.
- 연결은 `id`, `from`, `to`, `port`다. 조건 출력은 `true/false`, 검색 출력은 `zero/one/many`, 일반 출력은 `next`, HTTP 오류 분기는 `error`다. 같은 출력에 두 연결을 만들거나 순환할 수 없다.
- 다운로드는 저장된 정의를 대상으로 하며 비밀 값·서버 workflow ID·ON/OFF·실행 이력을 제외한다. 인라인 인증 헤더는 secret 참조로 옮겨야 파일로 교환할 수 있다. URL·임의 본문에 직접 쓴 업무 값까지 자동 익명화하지 않으므로 공유 전 내용을 확인한다.
- 파일은 UTF-8 JSON으로 최대 1MiB다. 이름·노드별 본문 등 개별 필드 제한과 저장 파일 64MiB 한도도 적용된다. 워크플로우 API의 요청 봉투는 비밀 값 등을 포함해 최대 1.25MiB다. 다른 API의 256KiB 제한은 유지한다.

## 서비스 상태 변경 트리거

`type: "service-state"`, `config: { "service": "" }`로 설정한다. 빈 문자열은 모든 서비스이며 값이 있으면 정확히 같은 서비스만 선택한다. `모든 서비스` 같은 특별한 이름은 이 트리거에서 사용하지 않는다.

활성 구간은 `[start, end)`이고 종료 미정은 계속 활성이다. 서버는 화면 필터와 무관하게 현재 활성 이벤트 전체를 집계한다. 서비스 키는 이벤트의 `services[].label` 그대로이며 catalog ID·직접 입력 종류로 구분하지 않는다. 한 이벤트에 같은 label이 여러 번 있어도 한 번만 집계한다. 복수 선택의 표시용 호환 문자열 `event.service`를 분리해 추측하지 않는다.

| 입력 경로 | 의미 |
| --- | --- |
| `trigger.service` | 이벤트에 저장된 서비스 문자열 |
| `trigger.previous` | 직전 계산 심각도 |
| `trigger.severity` | 현재 계산 심각도: `incident`, `warning`, `""` |
| `trigger.scheduledAt` | 이번 평가 기준 시각, UTC ISO |
| `trigger.events` | 현재 근거 이벤트의 `{id, version}` 목록 |
| `trigger.generation` | 내부 오래된 작업 판별용 값. 외부 API의 중복 방지 키 보장이 아님 |
| `run.id`, `run.startedAt` | 실행 식별자와 실제 시작 시각 |

이 트리거의 `event`는 `null`이다. 이벤트 category `maintenance`는 집계 심각도 `warning`으로 표현하며, 활성 이벤트가 없으면 기존 심각도 규칙의 빈 문자열이다. 별도 제품용 상태 ID·우선순위 정책을 추가하지 않는다.

같은 평가 시각의 시작·종료를 함께 반영하고, 최종 심각도가 같으면 근거 변경 이력만 남긴다. 활성 이벤트 수정·삭제·서비스 선택 변경도 다음 평가에 반영한다. 서버는 약 1초마다 현재 상태를 대조한다. 종료 미정·오래전에 시작한 이벤트도 포함한다.

처음 기준점을 만들 때는 현재 상태를 저장하고 호출하지 않는다. 재시작·잠금 해제 때는 영속 기준점과 현재 상태의 차이만 접수한다. 중단 중 끝난 상태들을 차례로 전송하지 않는다. 이미 접수되어 끝나지 않은 실행은 중단 처리하고 자동 반복하지 않는다. 현재 상태를 수동 실행할 때는 `previous`와 `severity`가 동일한 현재 값일 수 있다.

## 조건·검색·시각·JSON 값

기존 조건의 `field`, `operator`, `value`를 유지한다. `valueSource: "path"`이면 `value`를 다른 경로로 읽으며 기본 `literal`이면 JSON 고정값으로 해석한다. 경로의 숫자·불리언·객체 자료형을 유지한다. 누락 값을 서로 비교해서 일치로 간주하지 않는다.

`exists`는 기존처럼 null·누락·빈 문자열을 제외한다. `isPresent`는 null을 포함한 필드 존재, `isMissing`은 누락, `isNull`은 명시적인 null이다. `rules`에는 다음 JSON을 **문자열로** 넣는다. 입력하면 단일 조건 대신 사용하며 깊이 8·총 항목 64개 제한이 있다.

```json
{"all":[
  {"field":"response.status","operator":"equals","value":"200"},
  {"field":"response.body.state","operator":"equals","valueSource":"path","value":"trigger.severity"}
]}
```

`all`은 AND, `any`는 OR다. 중첩 가능하며 각 비교의 고정값도 문자열 필드 안의 JSON으로 해석한다. 값 경로가 있는 모든 진입 경로에서 참조한 노드가 먼저 실행되어야 한다.

`find` 설정은 `source`(배열 경로), `field`(항목 안의 키 경로), `value`, `valueSource`다. 최대 1,000개 항목을 비교하고 `{count, item}`을 출력한다. 정확히 한 건일 때만 item이 있으며 0건·복수 건에서는 null이다. 원본 배열 순서에 의존하지 않는다. 이력에는 count만 남기고 다음 노드는 전체 item을 사용한다.

`datetime` 설정은 `source: "now"` 또는 시각 경로, IANA `timezone`, `format`이다. `iso`는 UTC ISO, `local`은 시차 포함 현지 ISO, `date`·`time`은 현지 날짜·시각, `unix-ms`는 숫자다. 출력은 `{value, iso, timezone, evaluatedAt}`다. `now`는 그 노드의 실행 시각에 평가하고, `trigger.scheduledAt`은 접수한 입력 시각을 유지한다. 같은 출력 재사용은 `nodes.clock.value`처럼 참조한다.

HTTP JSON 본문에서 문자열 템플릿 `"{{path}}"`는 기존 동작을 유지한다. 숫자·불리언·객체를 그대로 삽입하려면 `{"$path":"경로"}`를 사용한다.

```json
{"state":{"$path":"trigger.severity"},"checkedAt":"{{nodes.clock.value}}"}
```

## 호출 순서·불명 결과·기록

- 전체 동시 실행 2개·같은 workflow 1개를 유지하며, 같은 서비스 문자열을 가진 실행은 workflow가 달라도 직렬화한다. start/end/cron에서도 `config.executionService`에 변경 대상 서비스 문자열을 지정하면 같은 실행 제어를 사용한다. 대상이 선언되지 않은 임의 HTTP 흐름까지 자동으로 동일 서비스로 인식하지 않는다.
- 변경 전송 직전에 현재 활성 이벤트, 계산 심각도, 내부 세대, 최신 정의, 자동 실행 ON/OFF와 취소 여부를 확인한다. 오래된 작업은 `skipped`로 끝내고 새 계산 결과를 따른다. 네트워크 전송 이후 이미 도착한 요청은 되돌릴 수 없다.
- HTTP `intent`는 `auto/read/change`다. auto는 GET·HEAD를 조회, 나머지를 변경으로 취급한다. POST 조회처럼 실제 의미가 다르면 명시한다. 서비스 변경 요청의 timeout·응답 유실·응답 크기 초과는 `review`로 끝내고 그 서비스의 다음 변경을 보류한다.
- 변경 재시도는 기본 0회이며 `idempotency: "verified"`로 외부 중복 방지 보장을 확인한 경우에만 설정할 수 있다. 이 표기 자체가 외부 기능을 구현하지 않는다. 같은 실행의 재시도에서 안정적인 키가 필요하면 외부 API가 요구하는 필드에 `{{run.id}}`를 사용하고 실제 보장·조회 범위를 사내에서 확인한다. HTTP 4xx·5xx는 자동 재시도하지 않는다.
- 모든 응답의 업무 성공 여부는 작성자가 조건으로 판단한다. 종료 결과는 `success/failure/review/skipped`다. 접수만 됐거나 검증이 불확실하면 review로 끝낸다. 연결이 없는 일반 경로는 기존처럼 성공 종료하므로 연동 예제의 모든 미일치·오류 경로는 명시적으로 연결한다.
- **서비스 상태** 화면에서 보류를 확인한다. 외부의 이전 요청이 끝났고 적용 결과를 확인한 뒤 **확인 후 보류 해소**를 사용한다. 해소는 감사 기록을 추가하고 이전 review 결과를 보존한다. 기존 대기 변경은 생략하고 최신 상태를 명시적으로 다시 평가한다.
- 조회만 수행하는 별도 workflow는 보류 중에도 실행할 수 있다. 조회 결과만으로 보류를 자동 해소하지 않는다. 자동 장기 폴링·중단 지점 재개·일반 실패 지점부터의 재시도는 이번 범위에 포함하지 않는다. 필요하면 조회 workflow와 수동 해소를 사용한다.
- 서비스 실행의 **현재 서비스 상태 재평가**는 최신 정의와 현재 입력으로 새 실행을 만들고 원래 실행 ID를 연결한다. 서비스 실행은 과거 입력을 처음부터 반복하는 재실행을 허용하지 않는다. 일반 실행의 기존 재실행 기능은 유지한다.
- HTTP `outputMode`는 `summary/none/allowlist`다. none은 상태·오류만, allowlist는 쉼표로 구분한 `outputPaths`(예: `status,body.accepted`)만 저장한다. 출력에 비밀 가림을 추가 적용한다. 다음 노드는 저장 요약과 무관하게 원래 응답을 사용한다. 종료 메시지 등 작성자가 명시적으로 출력하는 값도 공유 전에 검토한다.
- 호출 전에 시도를 저장하고, 호출 후 기록 실패 시 후속 실행을 멈춘다. 재시작 시 끝나지 않은 변경 시도 또는 응답 처리 단계가 있으면 서비스 보류를 복구한다. 기준점·보류는 감사 로그 보관 만료와 별도로 암호화 메타데이터에 유지된다.
- 전체 ZIP 백업·복원에도 서비스 기준점·보류와 review/skipped 실행 결과를 포함한다. 단일 workflow JSON은 정의 교환용이므로 실행 상태·보류를 옮기지 않는다.

## API

아래 API는 로그인 세션을 요구하고 쓰기에는 기존 동일 출처 검사가 적용된다. 개인 식별이 없는 공유 인증 모델을 유지한다.

| API | 역할 |
| --- | --- |
| `POST /api/workflows/validate` | 파일 JSON을 검증·정규화하고 실행 가능 여부 반환. 저장·호출 없음 |
| `GET /api/workflow-schema` | 파일 스키마 |
| `GET /api/workflows/:id/export` | 저장된 정의의 교환 JSON |
| 기존 `POST /api/workflows`, `PUT /api/workflows/:id` | 검증된 definition의 생성·버전 확인 저장 |
| `POST /api/workflows/:id/run` | 상태 트리거는 `{version, requestId, service}`로 현재 상태 실행 |
| `GET /api/workflow-services` | 계산 상태·근거·보류 조회 |
| `POST /api/workflow-services/resolve` | `{service, runId, requestId, confirmed: true, previousRequestFinished: true}`로 수동 해소 |
| `POST /api/workflow-runs/:id/reevaluate` | `{requestId}`로 현재 상태 재평가, 원래 실행 연결 |

해소·재평가 요청에는 중복 클릭 시 같은 requestId를 유지한다. 감사 조회의 `targetId`는 서비스 상태 실행에 대해 정확한 서비스 문자열도 받고, `eventId`는 집계 근거 이벤트를 검색한다. 원문 서비스 문자열을 URL에 넣을 때 URL 인코딩한다.

## 검증과 범위

```sh
node --test --test-reporter=spec test/*.test.mjs
node scripts/workflow-browser-check.mjs
node scripts/workflow-demo.mjs
node scripts/workflow-demo.mjs response-lost
node scripts/workflow-demo.mjs accepted
node scripts/workflow-demo.mjs mismatch
node scripts/workflow-demo.mjs duplicates
node scripts/workflow-demo.mjs unknown-service
node scripts/workflow-budget-check.mjs
```

예제 실행은 임시 암호화 저장소와 임의 포트의 로컬 HTTP 서버만 사용한다. 성공은 GET→POST→GET, 응답 유실·접수·검증 불일치는 review, 중복 대상은 변경 없이 review, 미일치 서비스는 호출 없이 skipped를 검사한다.

단일 실행은 여전히 120초, HTTP 시도는 최대 100회, 요청당 최대 30초, 응답당 128KiB다. 100개 노드가 100개의 긴 외부 대기를 허용한다는 뜻은 아니다. 부하 스크립트는 20·60·100개 조건/HTTP 경로의 실제 저장·실행 시간과 이력 크기를 출력한다. 호출 전 기록을 생략하거나 별도 워커를 도입하지 않았다.

Windows / Node.js 24.13.1의 한 차례 로컬 측정은 다음과 같다. HTTP fixture는 응답 전 2ms 대기하고, 각 경로의 트리거·종료를 제외한 모든 노드가 실제 로컬 HTTP를 호출했다. 운영 처리량 보장이 아닌 저장 비용을 포함한 기준 측정이다.

| 노드 수 | 조건 경로 | HTTP 경로 | HTTP 횟수 | HTTP 실행 이력 JSON |
| --- | --- | --- | --- | --- |
| 20 | 320ms | 995ms | 18 | 13,089 bytes |
| 60 | 1,093ms | 3,261ms | 58 | 39,450 bytes |
| 100 | 2,345ms | 6,765ms | 98 | 65,812 bytes |

Windows / Node.js 24.13.1과 22.23.1에서 검증했다. LANTERN이 보고한 원본 `f050753`도 별도 작업 트리의 Node.js 22.23.1에서 전체 85개가 통과해 `EPERM`의 원인은 재현·확정하지 못했다. Windows 파일 교체에 한정된 최대 7번·누적 대기 800ms의 일시 오류 재시도와 실패 주입 검증을 추가했다. 목적지 선삭제나 HTTP 재전송으로 저장 오류를 우회하지 않는다. macOS·실제 업무 API는 검증하지 않았다.

ZIP 백업 변경을 통합한 작업본의 전체 테스트 112개가 두 Node.js 버전에서 통과했다. Node.js 24.13.1 / Edge headless에서는 1440·900·390px 편집 화면, 실제 JSON 파일 선택·검증·OFF 생성·다운로드·기존 초안 적용, 100개 노드 편집, 서비스 수동 실행·현재 상태 재평가·보류 해소를 확인했고 브라우저 예외는 없었다. 모의 연동 시나리오 6개와 위 예산 측정도 통과했다.
