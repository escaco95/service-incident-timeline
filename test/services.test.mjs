import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { normalizeSelections, prepareEvent, validateServices } from '../lib/services.mjs';

test('서비스 선택은 표시명을 유지하고 비활성 항목의 신규 선택을 거부한다', () => {
  const catalog = { services: validateServices([{ id: 'service-a', name: '새 이름', active: false }]) };
  const original = { service: '기존 이름, 직접 입력', services: [{ kind: 'catalog', id: 'service-a', label: '기존 이름' }, { kind: 'custom', label: '직접 입력' }] };
  assert.deepEqual(prepareEvent(original, original, catalog, original).services, original.services);
  assert.throws(() => normalizeSelections([{ kind: 'catalog', id: 'service-a' }], catalog.services), /선택할 수 없는/);
  assert.deepEqual(normalizeSelections([{ kind: 'custom', label: ' 직접 입력 ' }, { kind: 'custom', label: '직접 입력' }, { kind: 'custom', label: '' }], catalog.services), [{ kind: 'custom', label: '직접 입력' }]);
  assert.throws(() => validateServices([], catalog.services), /비활성화/);
  assert.throws(() => prepareEvent({ service: '다른 값' }, {}, catalog, original), /새로고침/);
});

test('서비스 목록 API: 정책 없는 조회·저장, 접근 제어, 충돌, 기존 이벤트 편집과 재시작', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-services-'));
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json') };
  let app = await createApp(options);
  let address = await app.listen(0);
  let base = `http://127.0.0.1:${address.port}`, cookie = '';
  const password = 'services-test-only-password';
  const call = async (url, method = 'GET', body, extraHeaders = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await call('/api/services')).status, 401);
    assert.equal((await call('/api/services', 'PUT', {})).status, 401);
    assert.equal((await call('/api/setup', 'POST', { password })).status, 200);
    const initial = (await call('/api/services')).data;
    assert.deepEqual(initial, { version: 1, services: [] });
    const input = { version: initial.version, services: [{ id: 'service-a', name: '첫 서비스', active: true }, { id: 'service-b', name: '두 번째 서비스', active: true }] };
    assert.equal((await call('/api/services', 'PUT', input, { Origin: 'https://example.invalid' })).status, 403);
    const saved = await call('/api/services', 'PUT', input);
    assert.equal(saved.status, 200);
    assert.deepEqual(Object.keys(saved.data).sort(), ['services', 'version']);
    assert.ok(saved.data.services.every(service => Object.keys(service).sort().join(',') === 'active,id,name,order'));
    const audit = (await call('/api/audit?kind=changes&result=services-updated')).data;
    assert.equal(audit.items.length, 1);
    assert.equal(Object.hasOwn(audit.items[0].after, 'policy'), false);
    assert.ok(audit.items[0].after.services.every(service => Object.keys(service).sort().join(',') === 'active,id,name,order'));
    assert.equal((await call('/api/services', 'PUT', input)).status, 409);
    assert.equal((await call('/api/services', 'PUT', { version: saved.data.version, services: [{ ...input.services[0], name: '' }, input.services[1]] })).status, 400);

    const fields = { title: '일반 서비스 기록', description: '', category: 'incident', start: '2026-09-09T09:00:00.000Z', end: '2026-09-09T10:00:00.000Z', services: [{ kind: 'catalog', id: 'service-a' }, { kind: 'custom', label: '직접 입력' }] };
    const created = await call('/api/events', 'POST', fields);
    assert.equal(created.status, 201);
    assert.equal(Object.hasOwn(created.data.event, 'execution'), false);
    assert.deepEqual(created.data.event.services[1], { kind: 'custom', label: '직접 입력' });

    const catalog = (await call('/api/services')).data;
    const renamed = await call('/api/services', 'PUT', { version: catalog.version, services: catalog.services.slice().reverse().map(service => ({ ...service, name: service.name + ' 수정', connectorId: 'ignored' })), policy: { invalid: true } });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.services.map(service => service.id), ['service-b', 'service-a']);
    assert.deepEqual(app.vault.state.catalog, renamed.data);
    assert.equal(Object.hasOwn(app.vault.state, 'operations'), false);
    assert.ok(renamed.data.services.every(service => !Object.hasOwn(service, 'connectorId')));
    const updated = await call('/api/events/' + created.data.event.id, 'PUT', { ...fields, version: created.data.event.version, title: '독립적인 이벤트 수정', services: [{ kind: 'catalog', id: 'service-a' }], execution: { enabled: true } });
    assert.equal(updated.status, 200);
    assert.equal(Object.hasOwn(updated.data.event, 'execution'), false);
    assert.equal(updated.data.event.services[0].label, '첫 서비스');
    assert.equal(updated.data.event.start, fields.start);
    assert.equal(updated.data.event.end, fields.end);

    const before = await fs.readFile(app.vault.file, 'utf8');
    assert.equal(before.includes('첫 서비스'), false);
    await app.close();
    app = await createApp(options); address = await app.listen(0);
    base = `http://127.0.0.1:${address.port}`; cookie = '';
    assert.equal((await call('/api/login', 'POST', { password })).status, 200);
    assert.deepEqual((await call('/api/services')).data.services, renamed.data.services);
    assert.equal(await fs.readFile(app.vault.file, 'utf8'), before);
  } finally {
    await app.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('timeline-services-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
