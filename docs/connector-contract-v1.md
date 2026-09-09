# 커넥터 계약 v1 — 검토 초안

[이슈 #1](https://github.com/escaco95/service-incident-timeline/issues/1)의 첫 검토 단계에 해당한다. 코어의 서비스 모델·순수 상태 계산과 함께 사용할 서버 측 모듈 계약이다. 실제 예약 실행기, 영속 outbox, 자동 재시도와 실행 이력 화면은 다음 구현 단계다. 현재 웹 앱은 외부 커넥터를 호출하지 않는다.

구현: [계약 검사·단일 시도 어댑터](../lib/connector-contract.mjs), [모의 커넥터](../connectors/mock.mjs), [검토용 실행 예제](../scripts/connector-demo.mjs), [검증 사례](../test/connector-contract.test.mjs).

사내 구현 시작 순서와 현재·후속 범위는 [커넥터 개발 인계](connector-handoff.md)를 참고한다. v1은 검토 초안이다. 아래 인터페이스로 개발을 시작할 수 있으며 검토 중 변경은 이슈에 명시하고 코드·문서·예제·테스트를 함께 수정한다.

## 모듈과 책임

커넥터 모듈은 `createConnector(configuration)`을 export한다. 동기 또는 비동기 factory가 다음 객체를 반환한다. 빌드나 패키지 설치는 필요하지 않다.

```js
export function createConnector(configuration) {
  return {
    capabilities: { contractVersion: 1, idempotency: 'transition', query: true },
    async preflight(context, { signal }) { /* 연결·지원 대상·적용 가능 여부 확인 */ },
    async apply(context, { signal }) { /* 한 번만 적용 요청 */ },
    async verify(context, { signal }) { /* 외부 현재 상태가 목표와 같은지 확인 */ },
    async query(context, { signal }) { /* 전이 ID로 이전 요청의 처리 여부 조회 */ }
  };
}
```

- `idempotency`: `transition` 또는 `none`. 같은 전이 ID의 중복 처리를 외부 시스템까지 포함해 판별할 수 있을 때만 `transition`을 선언한다.
- `query`: 전이 ID를 사용한 결과 조회 지원 여부. `false`면 `query` 메서드는 생략한다.
- `verify`는 현재 상태 확인이며 `query`는 특정 전이의 처리 결과 확인이다. 둘은 서로 대체되지 않는다.
- factory·`preflight`·`verify`·`query`는 외부 상태를 변경하지 않는다. 상태 변경은 `apply`에서만 수행한다. `preflight` 성공은 이후 적용의 성공이나 실행 허용을 보장하지 않는다.
- 모듈은 신뢰된 서버 코드다. `loadConnector(path, configuration)`으로 명시적으로 로드한다. 공개 HTTP 요청에서 모듈 경로나 configuration을 받지 않는다.
- 코어는 대상 ID, 정책 상태, 버전, 공통 결과만 다룬다. 외부 URL·인증·요청 필드·응답의 업무 코드 해석은 커넥터가 소유한다. `configuration`과 secret은 내부 배포 환경에서 주입하고 이력에 복사하지 않는다.
- 커넥터는 변경 요청을 숨겨서 재시도하지 않는다. 재시도 시점·횟수·최신 버전·실행 허용 범위 검사와 이력 저장은 실행기의 책임이다.

## 각 단계의 입력

```json
{
  "contractVersion": 1,
  "transitionId": "transition-123",
  "attemptId": "attempt-456",
  "targetId": "resource-a",
  "targetSequence": 7,
  "previousState": "limited",
  "targetState": "unavailable",
  "evaluatedAt": "2026-09-09T09:30:00.000Z",
  "policyVersion": 2,
  "mappingVersion": 1,
  "evidence": [{ "eventId": "event-789", "version": 3 }]
}
```

| 필드 | 의미 |
| --- | --- |
| `targetId` | 제안 목록의 변경되지 않는 서비스 ID. 실제 API의 대상 값으로 변환하는 일은 커넥터가 담당한다. |
| `transitionId` | 한 대상의 한 논리적 상태 변경. 재시도·조회·검증에서도 유지한다. 나중에 같은 상태로 돌아오는 별개 전이에는 새 ID를 쓴다. |
| `attemptId` | 개별 단계 호출 ID. 사전 확인·적용·조회·검증 및 각 재시도마다 새 ID를 만든다. |
| `targetSequence` | 대상별 단조 증가 순번. 재시도에서는 유지한다. 영속화와 대상별 직렬화는 실행기가 담당한다. |
| `previousState` | 직전 계산 상태 또는 최초의 `null`. 실제 외부 상태를 확인했다는 뜻이 아니다. |
| `targetState` | 정책에 등록한 범용 목표 상태 ID. 이벤트 표시 유형과 무관하다. |
| `evaluatedAt` | 이 전이를 계산한 UTC 시각. 호출 시작·완료 시각은 시도 기록에 별도로 남긴다. |
| `policyVersion`, `mappingVersion` | 계산 정책과 대상 연결의 버전. 호출 직전에 실행기가 최신 버전·허용 범위를 확인해야 한다. |
| `evidence` | 근거 이벤트 ID와 버전만 전달한다. 제목·서비스 표시명·설명은 자동 전달하지 않는다. 최대 1,000개. |

서비스·상태·커넥터 ID는 영문 소문자로 시작하며 영문 소문자, 숫자, `_`, `-`로 구성한 1~64자다. 전이·시도·이벤트 참조 ID는 영문 대소문자, 숫자, `_`, `-`의 1~128자다. 순번과 버전은 1 이상의 안전한 정수다. 시각은 밀리초를 포함한 UTC ISO 형식이다.

`transitionContext()`는 허용 필드만 새 객체로 만든다. 추가로 전달된 제목·secret·원문은 호출과 시도 기록에서 제외한다.

## 공통 결과

```json
{
  "contractVersion": 1,
  "stage": "apply",
  "processing": "succeeded",
  "httpStatus": 200,
  "verification": "not-performed",
  "code": "applied",
  "retry": { "action": "none" }
}
```

| 필드 | 허용 값·해석 |
| --- | --- |
| `stage` | `preflight`, `apply`, `verify`, `query` |
| `processing` | `succeeded`, `failed`, `pending`, `unknown` |
| `httpStatus` | 실제 대상 API 응답 상태 100~599 또는 `null`. HTTP를 사용하지 않거나 응답이 없으면 `null`. |
| `verification` | `confirmed`, `mismatch`, `not-performed`, `unknown` |
| `code` | 아래 고정 결과 코드 중 하나. 자유 서술 오류 메시지는 허용하지 않는다. |
| `retry.action` | `none`, `retry`, `query`, `manual`. 실행기에 대한 제안이며 자동 실행 권한이 아니다. |
| `retry.afterMs` | 선택 사항. 0~86,400,000ms의 대기 제안. 실행기의 정책으로 제한한다. |
| `observedState` | 선택 사항. 확인한 범용 상태 ID 또는 `null`. `confirmed`이면 목표와 같은 상태 ID가 필수다. |
| `transportStatus` | 선택 사항. HTTP 커넥터 서비스까지의 실제 통신 상태 또는 `null`. 대상 API의 `httpStatus`와 분리한다. |
| `calls` | 한 단계가 여러 외부 호출을 했다면 최대 20개 요약. 각각 `ordinal`, 실제 `httpStatus` 또는 `null`, `processing`, `code`만 기록한다. |

결과 코드: `ready`, `applied`, `already-applied`, `accepted`, `verified`, `mismatch`, `rejected`, `unavailable`, `not-found`, `timeout`, `connector-exception`, `invalid-result`, `stale-sequence`.

반환 가능한 조합은 다음과 같다. 표 밖의 단계·처리·검증 조합은 `invalid-result`로 처리한다.

| 코드 | 단계 | processing | verification |
| --- | --- | --- | --- |
| `ready` | preflight | succeeded | not-performed |
| `applied`, `already-applied` | apply, query | succeeded | not-performed |
| `accepted` | apply, query | pending | not-performed |
| `verified` | verify | succeeded | confirmed |
| `mismatch` | verify | failed | mismatch |
| `rejected` | 모든 단계 | failed | not-performed |
| `unavailable` | 모든 단계 | failed 또는 unknown | not-performed 또는 unknown. processing이 unknown이면 unknown 필수 |
| `not-found` | query | unknown | unknown |
| `timeout`, `connector-exception`, `invalid-result` | 모든 단계 | unknown | unknown |
| `stale-sequence` | apply | failed | not-performed |

성공 결과의 `retry.action`은 `none`이다. 처리 중·불명 결과는 `query` 또는 `manual`이며, 조회 기능을 선언하지 않았다면 `manual`을 사용한다. 실패 결과는 `none`, `retry`, `query`, `manual` 중 상황에 맞게 제안한다. 적용 단계의 `failed`는 미적용이 확정된 경우에만 사용한다. 요청 전송·적용 여부를 모르면 `unknown`이다. 조회 제안은 조회 기능이 있을 때만 유효하며, 제안된 단계의 실제 호출은 실행기가 판단한다.

여러 호출을 한 단계로 묶었다면 `calls`에 1부터 시작하는 연속 순번으로 모든 호출을 요약한다. 각 호출의 코드와 처리 결과도 모순되면 안 된다. 최상위 `httpStatus`는 단계의 주 작업 API 응답이며, 커넥터 서비스의 통신 응답은 `transportStatus`로만 반환한다. 하위 호출의 실패를 HTTP 200이라는 이유로 전체 성공에 합치지 않는다.

- HTTP 200이면서 업무상 실패한 응답은 `processing: failed`로 해석한다.
- 접수만 확인한 응답은 `pending / not-performed`이다. 완료로 간주하지 않는다.
- `apply` 성공이나 `already-applied`만으로 현재 목표 상태의 검증 완료를 표시하지 않는다. `verify`를 거친다.
- 응답 유실·적용 여부 미확정은 `unknown`이다. 이때 `retry.action`은 `query` 또는 `manual`만 허용한다. 확인 없이 적용을 다시 요청하지 않는다.
- `query`의 `not-found`는 미적용을 보장하지 않는다. 모의 구현도 `unknown / manual`로 반환한다.
- `verify`에서 실제 외부 상태가 정책 상태로 매핑되지 않으면 `observedState: null`로 반환할 수 있다. 원문 업무 코드를 대신 넣지 않는다. 목표와 같은 상태가 확인된 경우에만 `verified / confirmed`를 사용한다.
- 정상 반환도 계약 검사에서 실패하면 `invalid-result`가 된다. 알 수 없는 코드·상태, 잘못된 타입, 모순된 성공·검증 결과는 통과하지 않는다.
- `normalizeResult()`는 허용된 구조화 필드만 복사한다. 원문 URL·헤더·본문·응답·예외 메시지·임의 추가 필드는 저장하거나 UI로 보내지 않는다.

## 단일 시도 어댑터

```js
const result = await invokeStage(connector, 'apply', context, {
  timeoutMs: 10000,
  allowedStates: policy.states.map(state => state.id),
  record: async entry => persistEncryptedAttempt(entry)
});
```

`allowedStates`는 코어 정책에 등록한 상태 ID 목록이다. 생략하면 입력의 목표·이전 상태만 허용한다. 커넥터가 반환한 `observedState`가 이 목록에 없으면 `invalid-result`로 처리해 원문이나 알 수 없는 업무 값을 이력에 복사하지 않는다.

`record`는 필수이며 두 번 호출된다.

1. `attempt-started`: 단계, 정제한 context, 호출 시작 시각. 이 저장이 성공해야 커넥터를 호출한다.
2. `attempt-finished`: 전이·시도·대상 ID, 단계, 시작·완료 시각, 소요 시간과 정제한 결과.

예외·시간 초과·잘못된 반환은 원문 없이 `unknown` 결과로 기록한다. 실제 응답을 얻지 못한 경우 HTTP 코드는 `null`이다. 최종 기록 저장이 실패하면 어댑터는 성공을 반환하지 않고 예외를 전달한다. 실행기는 영속화된 미완료 시도를 결과 조회 또는 확인 필요 상태로 복구해야 한다.

`AbortSignal`은 취소 요청일 뿐 외부 적용 취소 보장이 아니다. 시간 초과 후에도 커넥터가 실행될 수 있으므로 결과를 확인하기 전까지 대상의 다음 변경 호출을 시작하면 안 된다. 어댑터 자체에는 대상 잠금·outbox·재시도 타이머가 없다. 실제 실행기를 구현할 때 반드시 이 책임을 연결해야 한다.

## 로컬 모의 실행

```sh
node scripts/connector-demo.mjs
node scripts/connector-demo.mjs response-lost
node scripts/connector-demo.mjs http-business-failure
node scripts/connector-demo.mjs accepted
node scripts/connector-demo.mjs verification-mismatch
node scripts/connector-demo.mjs exception
node scripts/connector-demo.mjs invalid-result
node --test test/connector-contract.test.mjs test/operations.test.mjs
```

기본 예제는 09:00 제한 → 09:30 중단 → 10:00 제한 → 11:00 기준 상태를 계산한다. 모든 서비스·상태·응답은 가상 값이다. 네트워크 요청, 운영 데이터 접근, 패키지 다운로드를 하지 않는다.

모의 커넥터는 전이 ID 중복과 대상별 순번을 메모리에서 판별한다. 데모의 시도 기록도 메모리 배열이다. 프로세스 재시작을 견디는 운영 실행기나 영속 중복 방지 예제로 설명하지 않는다. 재시작·순서·outbox 보장은 계약 검토 후 실행기에 구현할 작업이다.

## LANTERN 검토 요청 항목

1. 서비스·전이·시도 ID, 대상별 순번과 정책·연결 버전을 위 필드로 연결할 수 있는가?
2. 사전 확인·적용·검증·전이 결과 조회의 분리가 연동 API에 맞는가?
3. 공통 결과 코드와 HTTP·업무·검증의 구분으로 내부 응답을 원문 노출 없이 표현할 수 있는가?
4. 외부 시스템의 중복 처리와 조회 범위, 조회 결과의 보존 기간을 어떻게 선언할 것인가?
5. 조회 불가·미확인·시간 초과 후 대상별 실행을 보류하는 동작에 동의하는가?

내부 서비스 주소·인증 정보·원문 응답은 공개 이슈에 남기지 않는다. 검토 중 계약 필드가 바뀌면 구현·문서·모의 예제와 테스트를 함께 갱신한다.
