import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { invokeStage, normalizeResult, transitionContext, loadConnector } from '../lib/connector-contract.mjs';
import { createConnector } from '../connectors/mock.mjs';

const context = (overrides = {}) => ({ contractVersion: 1, transitionId: 'transition-a', attemptId: randomUUID(), targetId: 'resource-a', targetSequence: 1, previousState: null, targetState: 'limited', evaluatedAt: '2026-09-09T09:00:00.000Z', policyVersion: 1, mappingVersion: 1, evidence: [{ eventId: 'event-a', version: 1 }], ...overrides });
const invoke = (connector, stage, input = context(), options = {}) => invokeStage(connector, stage, input, { record: async () => {}, timeoutMs: 30, ...options });

test('모의 커넥터: 사전 확인·적용·검증·조회, 중복 적용과 오래된 순번 거부', async () => {
  const connector = await loadConnector(fileURLToPath(new URL('../connectors/mock.mjs', import.meta.url)));
  const records = [], record = async entry => records.push(entry);
  assert.equal((await invoke(connector, 'preflight', context(), { record })).code, 'ready');
  assert.equal((await invoke(connector, 'apply', context(), { record })).verification, 'not-performed');
  assert.equal((await invoke(connector, 'verify', context(), { record })).verification, 'confirmed');
  assert.equal((await invoke(connector, 'apply')).code, 'already-applied');
  assert.equal((await invoke(connector, 'query')).code, 'already-applied');
  assert.equal((await invoke(connector, 'apply', context({ transitionId: 'older' }))).code, 'stale-sequence');
  assert.equal((await invoke(connector, 'apply', context({ targetState: 'unavailable' }))).code, 'rejected');
  assert.equal(records.length, 6);
  assert.deepEqual(records.map(entry => entry.type), ['attempt-started', 'attempt-finished', 'attempt-started', 'attempt-finished', 'attempt-started', 'attempt-finished']);
  assert.equal(new Set(records.filter(entry => entry.type === 'attempt-started').map(entry => entry.context.attemptId)).size, 3);
});

test('HTTP 성공·업무 실패, 접수·미검증, 검증 불일치를 분리', async () => {
  const business = await invoke(createConnector({ scenario: 'http-business-failure' }), 'apply');
  assert.equal(business.httpStatus, 200);
  assert.equal(business.processing, 'failed');
  const accepted = await invoke(createConnector({ scenario: 'accepted' }), 'apply');
  assert.equal(accepted.httpStatus, 202);
  assert.equal(accepted.processing, 'pending');
  assert.equal(accepted.verification, 'not-performed');
  const connector = createConnector({ scenario: 'verification-mismatch' });
  await invoke(connector, 'apply');
  assert.equal((await invoke(connector, 'verify')).verification, 'mismatch');
});

test('적용 후 응답 유실은 불명으로 기록하고 같은 전이를 조회', async () => {
  const connector = createConnector({ scenario: 'response-lost' });
  const records = [];
  const first = await invoke(connector, 'apply', context(), { record: async row => records.push(row), timeoutMs: 5 });
  assert.equal(first.processing, 'unknown');
  assert.equal(first.httpStatus, null);
  assert.equal(first.retry.action, 'query');
  assert.equal(records.at(-1).result.code, 'timeout');
  assert.equal((await invoke(connector, 'query')).code, 'already-applied');
  assert.equal((await invoke(connector, 'verify')).verification, 'confirmed');
});

test('예외·잘못된 계약은 허용 필드만 남기고 자동 재시도하지 않음', async () => {
  for (const [scenario, code] of [['exception', 'connector-exception'], ['invalid-result', 'invalid-result']]) {
    const records = [];
    const result = await invoke(createConnector({ scenario }), 'apply', context({ title: 'private title', rawSecret: 'synthetic-secret' }), { record: async row => records.push(row) });
    assert.equal(result.code, code);
    assert.equal(result.processing, 'unknown');
    assert.equal(records.length, 2);
    assert.equal(JSON.stringify(records).includes('synthetic-secret'), false);
    assert.equal(JSON.stringify(records).includes('private title'), false);
  }
  const clean = normalizeResult({ contractVersion: 1, stage: 'apply', processing: 'succeeded', httpStatus: 200, transportStatus: 200, verification: 'not-performed', code: 'applied', retry: { action: 'none', raw: 'secret' }, raw: 'secret', calls: [{ ordinal: 1, httpStatus: 200, processing: 'succeeded', code: 'applied', body: 'secret' }] }, 'apply');
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.throws(() => normalizeResult({ ...clean, processing: 'unknown', retry: { action: 'retry' } }, 'apply'));
  assert.equal(Object.hasOwn(transitionContext(context({ title: 'omit' })), 'title'), false);
  const connector = createConnector();
  connector.verify = async () => ({ contractVersion: 1, stage: 'verify', processing: 'failed', httpStatus: 200, verification: 'mismatch', code: 'mismatch', retry: { action: 'manual' }, observedState: 'synthetic-secret' });
  const records = [];
  assert.equal((await invoke(connector, 'verify', context(), { record: async entry => records.push(entry), allowedStates: ['limited', 'nominal'] })).code, 'invalid-result');
  assert.equal(JSON.stringify(records).includes('synthetic-secret'), false);
});

test('호출 전 기록 실패는 호출하지 않고, 결과 저장 실패는 성공으로 반환하지 않음', async () => {
  let calls = 0;
  const connector = createConnector();
  const apply = connector.apply;
  connector.apply = async (...args) => { calls++; return apply(...args); };
  await assert.rejects(invoke(connector, 'apply', context(), { record: async () => { throw new Error('storage unavailable'); } }));
  assert.equal(calls, 0);
  await assert.rejects(invoke(connector, 'apply', context(), { record: async entry => { if (entry.type === 'attempt-finished') throw new Error('storage unavailable'); } }));
  assert.equal(calls, 1);
  assert.equal((await invoke(connector, 'query')).code, 'already-applied');
});

test('잘못된 단계·모순된 성공·접수 후 적용 재시도 제안은 계약 오류', async () => {
  const valid = { contractVersion: 1, stage: 'apply', processing: 'succeeded', httpStatus: 200, verification: 'not-performed', code: 'applied', retry: { action: 'none' } };
  const invalidResults = [
    { code: 'ready' },
    { code: 'rejected' },
    { code: 'unavailable' },
    { code: 'timeout' },
    { code: 'verified', verification: 'confirmed', observedState: 'limited' },
    { code: 'not-found', processing: 'failed' },
    { code: 'accepted', processing: 'pending', retry: { action: 'retry' } },
    { retry: { action: 'retry' } },
    { calls: [{ ordinal: 1, processing: 'succeeded', code: 'rejected', httpStatus: 200 }] },
    { calls: [{ ordinal: 2, processing: 'succeeded', code: 'applied', httpStatus: 200 }] }
  ];
  for (const overrides of invalidResults) {
    const connector = createConnector(), records = [];
    connector.apply = async () => ({ ...valid, ...overrides });
    const result = await invoke(connector, 'apply', context(), { record: async entry => records.push(entry) });
    assert.equal(result.code, 'invalid-result', JSON.stringify(overrides));
    assert.equal(result.processing, 'unknown');
    assert.equal(records.at(-1).result.verification, 'unknown');
  }
  assert.equal(normalizeResult({ ...valid, code: 'unavailable', processing: 'failed', retry: { action: 'retry', afterMs: 500 } }, 'apply').processing, 'failed');
});

test('조회·중복 처리 미지원 커넥터도 가능하며 불명 결과는 수동 확인으로 멈춤', async () => {
  const connector = createConnector();
  connector.capabilities = { contractVersion: 1, idempotency: 'none', query: false };
  delete connector.query;
  let applies = 0;
  connector.apply = async () => { applies++; throw new Error('synthetic-secret'); };
  const result = await invoke(connector, 'apply');
  assert.equal(result.processing, 'unknown');
  assert.equal(result.retry.action, 'manual');
  assert.equal(applies, 1);
  await assert.rejects(invoke(connector, 'query'));
  connector.apply = async () => ({ contractVersion: 1, stage: 'apply', processing: 'pending', httpStatus: 202, verification: 'not-performed', code: 'accepted', retry: { action: 'query' } });
  const inconsistent = await invoke(connector, 'apply');
  assert.equal(inconsistent.code, 'invalid-result');
  assert.equal(inconsistent.retry.action, 'manual');
});
