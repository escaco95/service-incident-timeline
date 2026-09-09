import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readAudit } from '../lib/audit.mjs';
import { createApp } from '../server.mjs';

const password = 'audit-test-only-password';
const at = '2026-09-10T03:00:00.000Z';
const event = { title: '감사 기록 확인', description: '', category: 'incident', start: at, end: null, services: [] };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-audit-'));
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } };
  let app = await createApp(options), base = `http://127.0.0.1:${(await app.listen(0)).port}`, cookie = '';
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('timeline-audit-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    get app() { return app; },
    async call(url, method = 'GET', body) {
      const response = await fetch(base + url, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    },
    async restart() { await app.close(); app = await createApp(options); base = `http://127.0.0.1:${(await app.listen(0)).port}`; cookie = ''; }
  };
}

test('변경·워크플로우 감사 조회: 기간, 대상, 검색, 페이지와 결과 복사', () => {
  const state = { changes: [
    { id: 'a', at, action: 'event-created', before: null, after: { id: 'event-a', title: '결제', services: [{ id: 'service-a' }] } },
    { id: 'b', at, action: 'event-deleted', before: { id: 'event-a', services: [{ id: 'service-a' }] }, after: null },
    { id: 'c', at: '2026-09-11T03:00:00.000Z', action: 'workflow-created', before: null, after: { workflowId: 'flow-a', name: '알림' } }
  ], workflowRuns: [
    { id: 'run-a', createdAt: at, workflowId: 'flow-a', workflowName: '결제 알림', status: 'success', kind: 'manual', input: { event: { id: 'event-a', services: [{ id: 'service-a' }] } } },
    { id: 'run-b', createdAt: at, workflowId: 'flow-b', workflowName: '예약', status: 'failure', kind: 'automatic', input: { event: null } }
  ] };
  const read = query => readAudit(state, new URLSearchParams(query));
  assert.equal(read('').kind, 'changes');
  assert.equal(read('').total, 3);
  assert.deepEqual(read(`from=${at}&until=2026-09-11T03:00:00.000Z&targetId=service-a&eventId=event-a`).items.map(row => row.id), ['b', 'a']);
  assert.deepEqual(read('search=결제').items.map(row => row.id), ['a']);
  assert.deepEqual(read('workflowId=flow-a').items.map(row => row.id), ['c']);
  const page = read('limit=1&page=2');
  assert.equal(page.total, 3); assert.equal(page.pages, 3); assert.equal(page.items[0].id, 'b');
  const runs = read(`kind=workflows&from=${at}&workflowId=flow-a&eventId=event-a&targetId=service-a&result=success&mode=manual&search=결제`);
  assert.deepEqual(runs.items.map(row => row.id), ['run-a']);
  assert.equal(read('kind=workflows&mode=automatic').items[0].id, 'run-b');
  runs.items[0].workflowName = 'changed';
  assert.equal(state.workflowRuns[0].workflowName, '결제 알림');
  for (const query of ['kind=execution', 'kind=invalid', 'page=0', 'limit=101', 'from=bad', `from=${at}&until=${at}`]) assert.throws(() => read(query), { status: 400 });
});

test('감사 API와 현재 저장소: 폐기 경로, 원자적 변경, 워크플로우 이력과 재시작', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/audit')).status, 401);
  assert.equal((await f.call('/api/setup', 'POST', { password })).status, 200);
  assert.equal(Object.hasOwn(f.app.vault.state, 'legacyArchive'), false);
  const created = (await f.call('/api/events', 'POST', event)).data.event;
  for (const url of ['/api/audit/transitions/b0000000-0000-4000-8000-000000000001', '/api/execution/settings', '/api/operations/settings']) assert.equal((await f.call(url)).status, 404, url);
  assert.equal((await f.call('/api/audit?kind=execution')).status, 400);
  const before = structuredClone(f.app.vault.state), write = f.app.vault.write;
  f.app.vault.write = async () => { throw new Error('simulated disk error'); };
  try {
    assert.equal((await f.call('/api/events/' + created.id, 'PUT', { ...created, title: '실패할 수정' })).status, 500);
    assert.deepEqual(f.app.vault.state, before);
  } finally { f.app.vault.write = write; }
  assert.equal((await f.call('/api/events/' + created.id, 'PUT', { ...created, title: '저장된 수정' })).status, 200);
  const changes = (await f.call('/api/audit?eventId=' + created.id)).data;
  assert.equal(changes.total, 2);
  assert.equal(changes.items.find(row => row.type === 'event-updated').after.title, '저장된 수정');
  assert.equal(Object.hasOwn(changes, 'archive'), false);
  const flow = (await f.call('/api/workflows', 'POST', {
    requestId: 'audit-flow-request', name: '감사 검증 워크플로우',
    nodes: [{ id: 'start', type: 'start', name: '시작', x: 0, y: 0, config: { service: '' } }, { id: 'finish', type: 'finish', name: '완료', x: 0, y: 180, config: { result: 'success', message: '' } }],
    edges: [{ id: 'edge', from: 'start', to: 'finish', port: 'next' }]
  })).data;
  const requested = await f.call(`/api/workflows/${flow.id}/run`, 'POST', { requestId: 'audit-run-request', version: flow.version, eventId: created.id });
  assert.equal(requested.status, 202);
  let run;
  const deadline = Date.now() + 5000;
  do {
    await f.app.workflowEngine.tick();
    run = (await f.call('/api/workflow-runs/' + requested.data.id)).data;
    if (run.status === 'success') break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.length, 2);
  assert.equal((await f.call('/api/audit?kind=workflows&workflowId=' + flow.id)).data.items[0].id, run.id);
  const current = await f.app.vault.snapshot();
  await f.app.vault.mutate(state => { state.legacyArchive = { retired: true }; });
  const ciphertext = await fs.readFile(f.app.vault.file, 'utf8');
  await f.restart();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  const restored = await f.app.vault.snapshot();
  for (const key of ['events', 'catalog', 'changes', 'workflows', 'workflowRuns']) assert.deepEqual(restored[key], current[key]);
  assert.equal(Object.hasOwn(f.app.vault.state, 'legacyArchive'), false);
  assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), ciphertext, '로그인은 원본 파일을 다시 쓰지 않는다');
  await f.app.vault.mutate(() => {});
  const saved = await fs.readFile(f.app.vault.file, 'utf8');
  assert.equal(await fs.readFile(f.app.vault.file + '.bak', 'utf8'), ciphertext);
  assert.equal(saved.includes('저장된 수정'), false);
  await f.restart();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal(Object.hasOwn(f.app.vault.state, 'legacyArchive'), false);
  assert.equal((await f.call('/api/workflow-runs/' + run.id)).data.status, 'success');
});

test('지원하지 않는 저장소 schema는 이관·초기화하지 않고 원본을 보존한다', async t => {
  const f = await fixture(t);
  await f.app.vault.setup(password);
  for (const schemaVersion of [1, 2, 3, 4, 6]) {
    await f.app.vault.mutate(state => { state.schemaVersion = schemaVersion; });
    const original = await fs.readFile(f.app.vault.file, 'utf8');
    await assert.rejects(f.app.vault.unlock(password), { status: 409 });
    assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), original);
    await assert.rejects(f.app.vault.setup(password), { status: 409 });
  }
  await f.restart();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 409);
  assert.equal(f.app.vault.unlocked, false);
  assert.equal(f.app.vault.initialized, true);
});
