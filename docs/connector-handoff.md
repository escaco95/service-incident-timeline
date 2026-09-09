# 커넥터 개발 인계

[LANTERN의 합의](https://github.com/escaco95/service-incident-timeline/issues/1#issuecomment-5604797721)에 따라 서비스 데이터 모델·상태 계산과 커넥터 계약 v1·모의 구현을 먼저 제공한다. 사내 담당자는 이 계약을 기준으로 API 변환·응답 해석과 커넥터 자체 테스트를 시작할 수 있다. 계약 검토와 실제 예약 실행기 개발은 이어서 진행한다. 이슈 #1 전체 완료나 운영 API 자동 실행을 의미하지 않는다.

## 시작 순서

1. 공개 저장소의 이번 변경을 사내 fork에 반영한다. Node.js 22.13 이상을 준비한다. 빌드·npm 설치·CDN은 사용하지 않는다.
2. [계약 v1](connector-contract-v1.md)의 모듈·입력·결과 조합 표를 읽고 [모의 커넥터](../connectors/mock.mjs)를 실행한다.
3. 사내 전용 `connectors/<connector-id>.mjs`에 `createConnector(configuration)`을 구현한다. 공개 코어 파일을 수정하지 않는다. 배포별 서비스 ID와 정책 상태 ID를 실제 API 값으로 변환하는 테이블·인증·응답 파서는 이 모듈 또는 사내 설정에서 관리한다.
4. factory에 연결 설정과 secret을 주입한다. 전이 context나 반환 결과에 복사하지 않는다. 함수 형태의 secret 공급자를 configuration에 주입해도 된다. 공개 예제에 실제 URL·토큰·응답을 추가하지 않는다.
5. 사내 테스트에서 아래처럼 `loadConnector()`와 `invokeStage()`를 호출한다. 처음에는 외부 API를 대신하는 로컬 응답 fixture로 검증하고, 사내 테스트 환경의 적용 검증은 내부 절차에 따라 수행한다.
6. 이슈에 계약 수용 여부, 중복 처리·조회 지원 범위와 필요한 범용 필드 변경만 답변한다. 내부 요청·응답의 원문은 공유하지 않는다.

서비스 설정의 `connectorId`는 논리 ID다. 현재 웹 서버는 이 값으로 모듈을 자동 실행하지 않는다. 실제 실행기에는 신뢰된 배포 설정의 `connectorId → modulePath + configuration` 등록부를 연결할 예정이다. 공개 HTTP 입력으로 모듈 경로를 받지 않는다. 커넥터 모듈 자체를 개발·검증하는 데 웹 서버 자동 실행기는 필요하지 않다.

## 실행 가능한 호출 예제

프로젝트 루트에서 다음 명령을 실행한다. Windows PowerShell과 macOS 터미널에서 같은 명령을 사용한다.

```sh
node --test test/*.test.mjs
node scripts/connector-demo.mjs
node scripts/connector-demo.mjs response-lost
node scripts/connector-demo.mjs http-business-failure
node scripts/connector-demo.mjs accepted
node scripts/connector-demo.mjs verification-mismatch
node scripts/connector-demo.mjs exception
node scripts/connector-demo.mjs invalid-result
```

데모는 가상 대상만 호출하고 시도 기록을 메모리 배열에 남긴다. 성공·응답 유실 후 조회·처리 접수 후 조회는 마지막 `verify`에서 `verified`를 반환한다. 업무 실패는 `rejected`, 검증 불일치는 `mismatch`, 예외·계약 오류는 불명으로 기록한 뒤 `query`의 `not-found / unknown / manual`에서 멈춘다. 오류 시나리오를 정상적으로 재현한 데모 프로세스의 종료 코드는 0이며, 실제 결과는 출력된 `records[].result`로 확인한다.

사내 테스트 파일에서 모듈과 주입 설정만 교체하는 최소 예제다. 공개 모의 모듈로 그대로 실행할 수 있다. 다음 코드를 프로젝트 루트의 임시 `.mjs` 파일에 저장해 `node <파일명>.mjs`로 실행한다.

```js
import { randomUUID } from 'node:crypto';
import { loadConnector, invokeStage } from './lib/connector-contract.mjs';

const connector = await loadConnector('./connectors/mock.mjs', {
  targets: ['resource-a']
});
const context = {
  contractVersion: 1,
  transitionId: randomUUID(), targetId: 'resource-a', targetSequence: 1,
  previousState: null, targetState: 'limited',
  evaluatedAt: new Date().toISOString(), policyVersion: 1, mappingVersion: 1,
  evidence: [{ eventId: 'event-example', version: 1 }]
};
const records = [];
const stage = name => invokeStage(connector, name, {
  ...context, attemptId: randomUUID()
}, {
  timeoutMs: 10000,
  allowedStates: ['nominal', 'limited', 'unavailable'],
  record: async entry => { records.push(entry); }
});
if ((await stage('preflight')).code === 'ready') {
  let result = await stage('apply');
  if (['pending', 'unknown'].includes(result.processing)
      && result.retry.action === 'query') result = await stage('query');
  if (result.processing === 'succeeded') await stage('verify');
}
console.log(JSON.stringify(records, null, 2));
```

이 예제의 기록은 영속화되지 않으며 대상 잠금·재시도 예약을 제공하지 않는다. `record`를 빈 함수로 두는 방식은 운영 실행기로 사용할 수 없다. 실제 실행기는 호출 전에 전이·시도·허용 범위를 암호화 저장하고, 조회 불명 또는 기록 실패 시 대상의 다음 변경을 보류한다. 이전 전이의 결과 조회가 현재 목표 상태 검증을 대신하지 않는다.

## 구현자가 확인할 사항

| 항목 | 커넥터에서 구현·확인할 내용 |
| --- | --- |
| 매핑 | `targetId`, 범용 `targetState`를 외부 값으로 명시적으로 매핑. 이름·제목·설명으로 추측하지 않음 |
| 단계 | factory·preflight·query·verify는 상태를 변경하지 않음. apply에서 변경을 한 번 요청 |
| 식별자 | 단계·재시도마다 attemptId 변경, 같은 전이의 transitionId·targetSequence 유지. 외부 요청·조회 식별자 변환은 커넥터 책임 |
| 중복 처리 | 외부 시스템까지 중복 판별할 때만 `idempotency: transition`. 메모리 캐시만으로 재시작 보장을 주장하지 않음 |
| 조회 | query는 해당 전이의 처리 여부, verify는 현재 상태 확인. 조회 보존 기간·대상 범위·오래된 전이 조회 동작을 사내 문서에 명시 |
| 결과 불명 | 시간 초과·응답 유실을 미적용으로 단정하지 않음. 조회 불가·not-found는 manual 확인. 숨긴 변경 재시도 없음 |
| 결과 정규화 | HTTP 200 업무 실패, 202 접수, 검증 불일치, 예외·잘못된 반환을 구분. 상세 원문 대신 허용 코드만 반환 |
| 취소 | AbortSignal을 가능한 요청에 전달. 취소 요청이 외부 적용을 되돌린다고 가정하지 않음 |
| 복수 대상 | 하나의 호출 context는 하나의 targetId. 선택하지 않은 대상을 함께 변경하지 않음 |
| 설정 변경 | 모듈·매핑·권한 범위가 바뀌면 배포 운영자가 코어의 연결 버전과 실행 허용을 갱신. 기존 승인을 조용히 재사용하지 않음 |

`idempotency: none`, `query: false`도 허용한다. 이 경우 불명 결과는 수동 확인이 필요하며 코어가 정확히 한 번 적용이나 안전한 자동 재시도를 대신 보장하지 않는다. 기능을 과장해 선언할 필요가 없다.

## 제공 범위와 후속 작업

| 이슈 영역 | 현재 제공·검증한 범위 | 후속 범위 |
| --- | --- | --- |
| 1. 서비스·이벤트 | 인증된 암호화 설정, 고정 ID·표시명 보존, 다중 선택·직접 입력, 명시적 연결, schema 1 이관 | 운영 실행 준비 검사 |
| 2. 상태 계산 | 반개구간, 중첩 우선순위·동순위 정책, 대상별 계산, 확인 종료, 근거·예상 변경 조회 | 실행기 평가와 영속 계획 연결 |
| 3. 서버 실행기 | 기존 단일 저장 프로세스 잠금 유지 | 예약·재시작 평가, 지연, 브라우저와 독립된 자동 실행 |
| 4. 커넥터 | 버전 계약, 모듈 로더, 단일 시도 어댑터, 모의 구현·검증 사례 | 배포 등록부와 실제 실행기 연결 |
| 5. 영속 실행 | 전이·시도 ID 계약, 호출 전후 record 훅과 저장 실패 전달 검증 | 원자적 outbox, 대상별 순번·직렬화, 재시작 복원·재시도 |
| 6. 실행 제어 | 기본 계산 비활성, 범위 재확인·설정 버전 충돌 검사, 읽기 전용 미리보기 | 전체·대상별 중지/재개, 실행 허용 범위, 준비 상태, 키 공급 확장 |
| 7. 이력 | 암호화된 업무 변경 이력과 인증된 읽기 API, 호출 결과 정제 | 실행·변경 이력 화면·필터, 영속 호출 이력, 보존·정리 정책 |

`test/operations.test.mjs`는 계산·명시적 연결·범위 재확인·이관·원자적 업무 이력을 검증한다. `test/connector-contract.test.mjs`는 단계 계약·결과 구분·응답 유실 조회·중복과 오래된 순번·기록 실패·불명 시 보류를 로컬에서 검증한다. `scripts/browser-check.mjs`는 기존 화면과 새 서비스 설정·다중 선택·미리보기·로그아웃 시 비공개 정보 제거를 확인한다. 브라우저 검증에는 로컬 Chromium 계열 브라우저가 필요하다.

현재 Windows와 Node.js 24.13.1에서 검증했다. macOS와 Node.js 22.13에서의 실측 검증, 사내 API의 중복 처리·조회 보장, 프로세스 종료 후 실제 외부 적용 복구는 아직 검증하지 않았다. 이슈의 전체 19개 완료 조건은 실제 실행기와 이력 화면까지 구현한 뒤 별도로 검증한다.
