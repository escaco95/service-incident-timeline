import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const password = 'danger-zone-test-password';
async function fixture(t, workflows = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-reset-'));
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, ...workflows }, logMaintenance: { autoStart: false } };
  let app = await createApp(options), base = `http://127.0.0.1:${(await app.listen(0)).port}`, cookie = '';
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-reset-')); await fs.rm(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, options, directory,
    async call(url, method = 'GET', body, headers = {}) { const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return { status: response.status, data: await response.json() }; },
    async setup() { assert.equal((await this.call('/api/setup', 'POST', { password })).status, 200); },
    async reset(target, extra = {}, headers) { return this.call('/api/settings/reset', 'POST', { target, requestId: randomUUID(), confirmed: true, password, ...extra }, headers); },
    async restart() { await app.close(); app = await createApp(options); base = `http://127.0.0.1:${(await app.listen(0)).port}`; cookie = ''; }
  };
}
async function seed(f) {
  const event = (await f.app.vault.add({ title: '초기화할 이벤트', description: '', category: 'maintenance', services: [], start: new Date().toISOString(), end: null })).event;
  await f.app.vault.saveServices({ version: 1, services: [{ id: 'service', name: '보존 서비스', active: true }] });
  let flow = await f.app.workflows.create({ name: '초기화할 흐름', requestId: randomUUID(), nodes: [{ id: 'cron', type: 'cron', name: '예약', x: 36, y: 36, config: { expression: '* * * * *', timezone: 'UTC' } }], edges: [] });
  flow = await f.app.workflows.save(flow.id, { ...flow, secrets: { ACCESS: 'stored-private-value' } });
  const run = await f.app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
  return { event, flow, run };
}

test('초기화 API는 로그인·동일 출처·확인·현재 비밀번호를 모두 검증하고 실패 시 보존한다', async t => {
  const f = await fixture(t); assert.equal((await f.reset('system')).status, 401); await f.setup(); await seed(f);
  const state = structuredClone(f.app.vault.state), file = await fs.readFile(f.app.vault.file, 'utf8');
  assert.equal((await f.reset('invalid')).status, 400);
  assert.equal((await f.reset('events', { confirmed: false })).status, 400);
  assert.equal((await f.reset('events', {}, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.reset('events', { password: 'incorrect-password' })).status, 403);
  assert.equal((await f.call('/api/events')).status, 200, '비밀번호 재확인 실패로 로그아웃하지 않음');
  assert.deepEqual(f.app.vault.state, state); assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), file);
  for (let i = 0; i < 4; i++) assert.equal((await f.reset('system', { password: 'incorrect-password' })).status, 403);
  assert.equal((await f.reset('system')).status, 429); assert.deepEqual(f.app.vault.state, state);
});

test('이벤트·워크플로우·감사 로그 초기화의 범위, 백업, 중복 요청과 재시작', async t => {
  const f = await fixture(t); await f.setup(); const seeded = await seed(f);
  const eventRequest = randomUUID();
  assert.equal((await f.reset('events', { requestId: eventRequest })).status, 200);
  assert.deepEqual((await f.app.vault.snapshot()).events, []); assert.equal(f.app.vault.state.workflows.length, 1); assert.equal(f.app.vault.state.catalog.services.length, 1);
  assert.ok((await f.app.vault.snapshot()).changes.some(row => row.action === 'events-reset'));
  const replacement = (await f.app.vault.add({ ...seeded.event, title: '이후에 추가한 이벤트' })).event;
  assert.equal((await f.reset('events', { requestId: eventRequest })).status, 200); assert.equal((await f.app.vault.snapshot()).events[0].id, replacement.id);
  assert.equal((await f.reset('workflows', { requestId: eventRequest })).status, 409);
  assert.equal((await f.reset('workflows')).status, 200); assert.deepEqual(f.app.vault.state.workflows, []); assert.equal((await f.app.vault.snapshot()).events.length, 1);
  assert.equal((await f.app.workflows.readRun(seeded.run.id)).status, 'canceled'); assert.equal((await f.app.workflows.readRun(seeded.run.id)).canRerun, false);
  assert.equal((await f.reset('audit')).status, 200); assert.deepEqual((await f.app.vault.snapshot()).changes, []); assert.deepEqual((await f.app.vault.snapshot()).workflowRuns, []);
  assert.equal(f.app.vault.daily.garbage.length, 0); assert.ok(f.app.vault.daily.backup.files.every(ref => !ref.kind.startsWith('audit')));
  const files = await fs.readdir(path.join(f.options.dataDir, 'audit')); assert.equal(files.length, 0);
  await f.restart(); assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.reset('events', { requestId: eventRequest })).status, 200); assert.equal((await f.app.vault.snapshot()).events[0].id, replacement.id, '재시작 후에도 같은 요청은 재삭제하지 않음');
});

test('저장 실패는 초기화 전 상태를 유지하고 다시 시도할 수 있다', async t => {
  const f = await fixture(t); await f.setup(); await seed(f);
  const state = structuredClone(f.app.vault.state), file = await fs.readFile(f.app.vault.file, 'utf8'), original = f.app.vault.write;
  f.app.vault.write = async () => { throw Error('disk full'); };
  assert.equal((await f.reset('events')).status, 500);
  assert.deepEqual(f.app.vault.state, state); assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), file);
  f.app.vault.write = original;
  assert.equal((await f.reset('events')).status, 200); assert.equal((await f.app.vault.snapshot()).events.length, 0);
});

test('실행 중 API를 중지한 뒤 감사 로그를 비워 기록이 다시 생기지 않는다', async t => {
  let started = false, stopped = false;
  const f = await fixture(t, { fetch: async (_url, { signal }) => { started = true; try { await delay(10000, null, { signal }); } finally { stopped = true; } return new Response('{}'); } });
  await f.setup(); const { flow } = await seed(f);
  const saved = await f.app.workflows.save(flow.id, { ...flow, nodes: [...flow.nodes, { id: 'http', type: 'http', name: '요청', x: 36, y: 216, config: { method: 'GET', url: 'http://127.0.0.1:1', headers: '{}', body: '', timeoutMs: 30000, retries: 0, onError: 'stop' } }], edges: [{ id: 'edge', from: 'cron', to: 'http', port: 'next' }] });
  await f.call(`/api/workflows/${flow.id}/run`, 'POST', { requestId: randomUUID(), version: saved.version });
  for (let i = 0; i < 200 && !started; i++) await delay(10);
  assert.equal(started, true); assert.equal((await f.reset('audit')).status, 200); assert.equal(stopped, true);
  await delay(80); assert.equal(f.app.workflowEngine.jobs.size, 0); assert.deepEqual((await f.app.vault.snapshot()).workflowRuns, []); assert.deepEqual((await f.app.vault.snapshot()).changes, []); assert.equal(f.app.vault.state.workflows.length, 1);
});

test('시스템 초기화는 관리 파일·날짜 파일·브랜딩·세션을 지우고 새 비밀번호를 받는다', async t => {
  const f = await fixture(t); await f.setup(); await seed(f);
  const settings = (await f.call('/api/settings/branding')).data;
  await f.call('/api/settings/branding', 'PUT', { version: settings.version, branding: { ...settings.branding, name: '지울 시스템 이름', passwordNotice: '지울 안내문' } });
  await fs.writeFile(path.join(f.options.dataDir, 'operator-note.txt'), 'unrelated');
  const result = await f.reset('system'); assert.equal(result.status, 200); assert.equal(result.data.initialized, false);
  assert.deepEqual((await f.call('/api/status')).data, { initialized: false, unlocked: false, authenticated: false });
  assert.equal((await f.call('/api/events')).status, 401);
  assert.equal((await f.call('/api/branding')).data.name, 'Service Timeline');
  await assert.rejects(fs.access(f.app.vault.file)); await assert.rejects(fs.access(f.app.vault.file + '.bak')); await assert.rejects(fs.access(f.options.brandingFile));
  for (const kind of ['events', 'events-open', 'audit', 'audit-active']) assert.equal((await fs.readdir(path.join(f.options.dataDir, kind)).catch(() => [])).length, 0);
  assert.equal(await fs.readFile(path.join(f.options.dataDir, 'operator-note.txt'), 'utf8'), 'unrelated');
  assert.equal((await f.call('/api/setup', 'POST', { password: 'brand-new-password' })).status, 200);
  assert.equal(f.app.vault.state.workflows.length, 0); assert.equal(f.app.workflowEngine.ready, true);
  await f.restart(); assert.equal((await f.call('/api/login', 'POST', { password })).status, 401); assert.equal((await f.call('/api/login', 'POST', { password: 'brand-new-password' })).status, 200);
});

test('중단된 시스템 초기화는 정상 API를 차단하고 재시작 후 정리를 완료한다', async t => {
  const f = await fixture(t); await f.setup(); await seed(f);
  // A directory at the branding file path makes removal fail without deleting data.
  await fs.mkdir(f.options.brandingFile);
  assert.equal((await f.reset('system')).status, 503);
  assert.equal((await f.call('/api/events')).status, 503);
  assert.equal(await fs.readFile(path.join(f.options.dataDir, '.system-reset-pending'), 'utf8'), 'authorized system reset\n');
  await fs.rmdir(f.options.brandingFile);
  await f.restart(); assert.equal((await f.call('/api/status')).data.initialized, false); await f.setup(); assert.equal((await f.app.vault.snapshot()).events.length, 0);
});

test('초기화는 이미 접수한 쓰기가 끝난 뒤 적용하며 중간에 새 쓰기를 받지 않는다', async t => {
  const f = await fixture(t); await f.setup();
  const original = f.app.vault.write; let writing = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.app.vault.write = async function (...args) { writing = true; await gate; return original.apply(this, args); };
  const create = f.call('/api/events', 'POST', { title: '진행 중인 저장', description: '', category: 'incident', services: [], start: new Date().toISOString(), end: null });
  for (let i = 0; i < 100 && !writing; i++) await delay(10);
  assert.equal(writing, true);
  const reset = f.reset('events');
  let blocked = false;
  for (let i = 0; i < 100 && !blocked; i++) { blocked = (await f.call('/api/services')).status === 503; if (!blocked) await delay(10); }
  assert.equal(blocked, true);
  assert.equal((await f.call('/api/events', 'POST', { title: '끼어든 쓰기' })).status, 503);
  release(); assert.equal((await create).status, 201); assert.equal((await reset).status, 200); assert.deepEqual((await f.app.vault.snapshot()).events, []);
});
