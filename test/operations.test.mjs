import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyOperations, validateServices, validatePolicy, prepareEvent, eligibility, evaluateStates, previewPlan } from '../lib/operations.mjs';
import { createApp } from '../server.mjs';
import { Vault } from '../lib/vault.mjs';

const example = JSON.parse(await fs.readFile(new URL('../examples/operations.example.json', import.meta.url), 'utf8'));
const settings = () => ({ version: 1, services: validateServices(example.services), policy: validatePolicy(example.policy, 1) });
const instant = value => `2026-09-09T${value}:00.000Z`;
const base = { title: '기록 원문은 실행 계약에 전달하지 않음', service: '', description: '', category: 'maintenance', start: instant('09:00'), end: instant('11:00') };
function event(id, overrides = {}, operations = settings()) {
  const input = { ...base, services: [{ kind: 'catalog', id: 'resource-a' }], execution: { enabled: true, impact: 'limited', endMode: 'scheduled', confirmedEnd: null, confirmAuthorization: true }, ...overrides };
  input.execution = { ...input.execution, confirmSettingsVersion: operations.version };
  return { id, version: 1, ...prepareEvent(input, input, operations) };
}

test('중첩 상태: 상위 종료 후 하위 복원, 반개구간, 대상 독립, 화면 유형과 무관', () => {
  const operations = settings();
  const events = [event('limited'), event('unavailable', { start: instant('09:30'), end: instant('10:00'), category: 'maintenance', execution: { enabled: true, impact: 'unavailable', endMode: 'scheduled', confirmAuthorization: true } })];
  for (const [time, expected] of [['08:59', 'nominal'], ['09:00', 'limited'], ['09:30', 'unavailable'], ['10:00', 'limited'], ['11:00', 'nominal']]) {
    const actual = evaluateStates(events, operations, instant(time));
    assert.equal(actual.states[0].state, expected);
    assert.equal(actual.states[1].state, 'nominal');
    assert.equal(actual.externalCalls, false);
  }
  assert.equal(evaluateStates(events, operations, instant('09:45')).states[0].evidence.length, 2);
  assert.deepEqual(previewPlan(events, operations, instant('08:00'), instant('12:00')).transitions.map(item => item.targetState), ['limited', 'unavailable', 'limited', 'nominal']);
});

test('같은 영향·같은 시각 경계는 근거만 변경하고 중간 기준 상태를 만들지 않음', () => {
  const events = [event('first', { end: instant('10:00') }), event('second', { start: instant('10:00') }), event('overlap', { start: instant('09:30'), end: instant('10:30') })];
  const plan = previewPlan(events, settings(), instant('08:00'), instant('12:00'));
  assert.deepEqual(plan.transitions.filter(item => item.applyRequired).map(item => [item.evaluatedAt, item.targetState]), [[instant('09:00'), 'limited'], [instant('11:00'), 'nominal']]);
  assert.equal(plan.transitions.find(item => item.evaluatedAt === instant('10:00')).applyRequired, false);
});

test('확인 종료와 복수 대상: 예정 시각 뒤에도 유지하며 확인 시 종료', () => {
  const operations = settings();
  const first = event('held', { services: example.services.map(service => ({ kind: 'catalog', id: service.id })), execution: { enabled: true, impact: 'unavailable', endMode: 'confirmed', confirmAuthorization: true } });
  assert.ok(evaluateStates([first], operations, instant('12:00')).states.every(state => state.state === 'unavailable'));
  const input = { ...first, execution: { ...first.execution, confirmedEnd: instant('12:00'), confirmAuthorization: true, confirmSettingsVersion: operations.version } };
  const ended = { ...first, ...prepareEvent(input, input, operations, first) };
  assert.ok(evaluateStates([ended], operations, instant('12:00')).states.every(state => state.state === 'nominal'));
  const future = event('future', { start: instant('13:00'), end: null });
  assert.equal(evaluateStates([future], operations, instant('12:00')).states[0].state, 'nominal');
});

test('정책·연결 변경은 승인 무효, 표시명 변경은 ID와 과거 표시명 보존', () => {
  const operations = settings(), original = event('original');
  const changed = structuredClone(operations);
  changed.services[0].name = '새 이름';
  assert.equal(eligibility(original, changed).eligible, true);
  const updated = prepareEvent({ ...original, title: '다른 제목' }, { ...original, title: '다른 제목' }, changed, original);
  assert.equal(updated.services[0].label, example.services[0].name);
  changed.services = validateServices(changed.services.map(service => ({ ...service, connectorId: 'another' })), changed.services);
  assert.ok(eligibility(original, changed).reasons.includes('authorization-required'));
  assert.throws(() => prepareEvent(original, original, changed, original), /범위|승인/);
  const reapproved = prepareEvent(original, { ...original, execution: { ...original.execution, confirmAuthorization: true, confirmSettingsVersion: changed.version } }, changed, original);
  assert.equal(eligibility(reapproved, changed).eligible, true);
  changed.policy.version++;
  assert.equal(eligibility(reapproved, changed).eligible, false);
  changed.services[0].active = false;
  assert.ok(eligibility(original, changed).reasons.includes('inactive-target'));
  assert.throws(() => validateServices([], operations.services), /비활성/);
  const toggled = structuredClone(operations);
  toggled.services = validateServices(toggled.services.map(service => ({ ...service, active: false })), toggled.services);
  assert.ok(eligibility(original, toggled).reasons.includes('inactive-target'));
  toggled.services = validateServices(toggled.services.map(service => ({ ...service, active: true })), toggled.services);
  assert.ok(eligibility(original, toggled).reasons.includes('authorization-required'), '재활성화해도 이전 승인이 자동 복원되지 않음');
});

test('범위 확인 중 설정이 바뀌면 최신 연결에 자동 승인하지 않음', () => {
  const operations = settings(), original = event('reviewed');
  const stale = { ...original, execution: { ...original.execution, confirmAuthorization: true, confirmSettingsVersion: operations.version } };
  operations.services = validateServices(operations.services.map(service => ({ ...service, connectorId: 'changed-connector' })), operations.services);
  operations.version++;
  assert.throws(() => prepareEvent(stale, stale, operations, original), /확인한 업무 설정/);
  delete stale.execution.confirmSettingsVersion;
  assert.throws(() => prepareEvent(stale, stale, operations, original), /확인한 업무 설정/);
  stale.execution.confirmSettingsVersion = operations.version;
  assert.equal(eligibility(prepareEvent(stale, stale, operations, original), operations).eligible, true);
});

test('직접 입력은 자동 연결되지 않고 중복 ID·빈 항목을 정리', () => {
  const operations = settings();
  const input = { ...base, services: [{ kind: 'custom', label: ' 가상 서비스 A ' }, { kind: 'custom', label: '' }, { kind: 'custom', label: '가상 서비스 A' }] };
  const record = prepareEvent(input, input, operations);
  assert.deepEqual(record.services, [{ kind: 'custom', label: '가상 서비스 A', targetId: null }]);
  assert.equal(record.execution.enabled, false);
  assert.throws(() => event('unmapped', { services: input.services }), /unmapped-service/);
  assert.throws(() => event('duplicate', { services: [{ kind: 'catalog', id: 'resource-a' }, { kind: 'catalog', id: 'resource-a' }] }), /중복/);
  const both = event('both', { services: [{ kind: 'catalog', id: 'resource-a' }, { kind: 'custom', label: '직접 기록', targetId: 'resource-b' }] });
  assert.ok(evaluateStates([both], operations, instant('10:00')).states.every(state => state.state === 'limited'));
  assert.equal(emptyOperations().policy.baseline, null);
  const multiple = { ...base, services: [{ kind: 'custom', label: '첫 서비스' }, { kind: 'custom', label: '두 번째 서비스' }] };
  const stored = prepareEvent(multiple, multiple, operations);
  const legacy = { ...base, service: '변경된 서비스' };
  assert.throws(() => prepareEvent(legacy, legacy, operations, stored), /새로고침/);
  assert.deepEqual(prepareEvent({ ...legacy, service: stored.service }, { ...legacy, service: stored.service }, operations, stored).services, stored.services);
});

test('동순위 설정과 정책 변경 재승인, 조회 범위 제한', () => {
  const operations = settings();
  operations.policy.states[0].priority = operations.policy.states[1].priority;
  const events = [event('first', { execution: { enabled: true, impact: 'unavailable', endMode: 'scheduled', confirmAuthorization: true } }, operations), event('later', { start: instant('09:30') }, operations)];
  assert.equal(evaluateStates(events, operations, instant('10:00')).states[0].state, 'unavailable');
  operations.policy.tieBreak = 'latest-start';
  // Normal settings writes increment this version; the pure fixture renews authorization explicitly.
  operations.policy.version++;
  const renewed = events.map(original => ({ ...original, ...prepareEvent(original, { ...original, execution: { ...original.execution, confirmAuthorization: true, confirmSettingsVersion: operations.version } }, operations, original) }));
  assert.equal(evaluateStates(renewed, operations, instant('10:00')).states[0].state, 'limited');
  assert.throws(() => previewPlan(events, operations, instant('08:00'), '2028-01-01T00:00:00.000Z'), /366일/);
});

test('업무 API: 인증·암호화·충돌·원자적 이력·재시작·확인 종료', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-operations-'));
  let app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json') });
  let address = await app.listen(0), baseUrl = `http://127.0.0.1:${address.port}`, cookie = '';
  const password = 'operations-test-only-password';
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(baseUrl + url, { method, headers: { Origin: baseUrl, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    for (const url of ['/api/operations/settings', '/api/operations/changes']) assert.equal((await call(url)).status, 401);
    assert.equal((await call('/api/operations/preview', 'POST', {})).status, 401);
    cookie = (await call('/api/setup', 'POST', { password })).cookie;
    const initial = (await call('/api/operations/settings')).data;
    const saved = await call('/api/operations/settings', 'PUT', { ...example, version: initial.version });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.policy.version, 2);
    const input = { ...base, start: '2020-01-01T00:00:00.000Z', end: '2020-01-01T01:00:00.000Z', services: [{ kind: 'catalog', id: 'resource-a' }], execution: { enabled: true, impact: 'limited', endMode: 'confirmed', confirmAuthorization: true, confirmSettingsVersion: saved.data.version } };
    const created = await call('/api/events', 'POST', input);
    assert.equal(created.status, 201);
    assert.equal((await call('/api/operations/preview', 'POST', {})).data.states[0].state, 'limited');
    assert.equal((await call(`/api/events/${created.data.event.id}/confirm-end`, 'POST', { version: 1 })).status, 200);
    assert.equal((await call('/api/operations/preview', 'POST', {})).data.states[0].state, 'nominal');
    const [a, b] = await Promise.all([call('/api/operations/settings', 'PUT', { ...example, version: saved.data.version }), call('/api/operations/settings', 'PUT', { ...example, version: saved.data.version })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await call('/api/events', 'POST', input)).status, 409, '이전 화면에서 확인한 설정으로 승인할 수 없음');
    input.execution.confirmSettingsVersion = (a.status === 200 ? a : b).data.version;
    const before = await fs.readFile(app.vault.file, 'utf8');
    const changes = (await call('/api/operations/changes')).data;
    assert.equal(changes.total, 4);
    assert.equal(JSON.stringify(changes).includes(base.title), false);
    assert.equal(JSON.stringify(changes).includes(example.services[0].name), false);
    const write = app.vault.write;
    app.vault.write = async () => { throw new Error('simulated storage failure'); };
    assert.equal((await call('/api/events', 'POST', input)).status, 500);
    app.vault.write = write;
    assert.equal((await call('/api/operations/changes')).data.total, changes.total);
    assert.equal(await fs.readFile(app.vault.file, 'utf8'), before);
    assert.equal(JSON.stringify((await call('/api/branding')).data).includes('resource-a'), false);
    for (const value of [password, 'resource-a', example.services[0].name, 'connectorId']) assert.equal(before.includes(value), false);
    await app.close();
    app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json') });
    address = await app.listen(0); baseUrl = `http://127.0.0.1:${address.port}`; cookie = '';
    cookie = (await call('/api/login', 'POST', { password })).cookie;
    assert.equal((await call('/api/operations/settings')).data.services.length, 2);
    assert.equal((await call('/api/operations/changes')).data.total, changes.total);
    assert.equal(await fs.readFile(app.vault.file, 'utf8'), before, 'login and preview never persist a write');
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('schema 1 이관: 읽기는 파일 보존, 서비스 문자열을 기록 전용으로 변환', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-migration-'));
  let vault = await new Vault(directory).open();
  const password = 'migration-test-only-password';
  try {
    await vault.setup(password);
    await vault.mutate(state => {
      state.schemaVersion = 1;
      delete state.operations; delete state.changes;
      state.events = [{ ...base, service: '원래 이름  보존', id: 'legacy-id', version: 7 }, { ...base, service: '', id: 'empty-id', version: 1 }];
    });
    const old = await fs.readFile(vault.file, 'utf8');
    await vault.close(); vault = await new Vault(directory).open();
    await vault.unlock(password);
    assert.deepEqual(vault.read().events[0].services, [{ kind: 'custom', label: '원래 이름  보존', targetId: null }]);
    assert.deepEqual(vault.read().events[1].services, []);
    assert.equal(vault.read().events[0].execution.enabled, false);
    assert.equal(vault.read().events[0].version, 7);
    assert.equal(await fs.readFile(vault.file, 'utf8'), old);
    await vault.add(base);
    assert.equal(vault.state.schemaVersion, 2);
    assert.equal(await fs.readFile(vault.file + '.bak', 'utf8'), old);
  } finally { await vault.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
