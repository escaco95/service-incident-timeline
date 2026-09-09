import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { SETUP_FILE, SETUP_CONTROL_FILE } from '../lib/setup-marker.mjs';

const password = 'operator-reset-old-password', replacement = 'operator-reset-new-password';
async function fixture(t, workflows = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-marker-'));
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, ...workflows }, logMaintenance: { autoStart: false } };
  let app, base, cookie = '';
  const f = {
    options, marker: path.join(options.dataDir, SETUP_FILE), control: path.join(options.dataDir, SETUP_CONTROL_FILE),
    get app() { return app; },
    async start() { app = await createApp(options); base = `http://127.0.0.1:${(await app.listen(0)).port}`; },
    async stop() { if (app) await app.close(); app = null; },
    async restart() { await this.stop(); await this.start(); },
    async call(url, method = 'GET', body) {
      const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    },
    async setup(value = password) { assert.equal((await this.call('/api/setup', 'POST', { password: value })).status, 200); },
    async seed() {
      await app.vault.add({ title: '삭제할 이벤트', description: '', category: 'incident', services: [], start: new Date().toISOString(), end: null });
      await app.vault.saveServices({ version: 1, services: [{ id: 'svc', name: '삭제할 서비스', active: true }] });
      const flow = await app.workflows.create({ name: '삭제할 흐름', requestId: randomUUID(), nodes: [{ id: 'cron', type: 'cron', name: '예약', x: 36, y: 36, config: { expression: '* * * * *', timezone: 'UTC' } }], edges: [] });
      const settings = (await this.call('/api/settings/branding')).data;
      assert.equal((await this.call('/api/settings/branding', 'PUT', { version: settings.version, branding: { ...settings.branding, name: '삭제할 시스템 이름', passwordNotice: '삭제할 안내문' } })).status, 200);
      return flow;
    }
  };
  t.after(async () => { await f.stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-marker-')); await fs.rm(directory, { recursive: true, force: true }); });
  await f.start(); return f;
}
async function absent(file) { await assert.rejects(fs.access(file), { code: 'ENOENT' }); }
async function resetState(f) {
  assert.deepEqual((await f.call('/api/status')).data, { initialized: false, authenticated: false, unlocked: false });
  assert.equal((await f.call('/api/events')).status, 401);
  assert.equal((await f.call('/api/branding')).data.name, 'Service Timeline');
  await absent(path.join(f.options.dataDir, 'store.json')); await absent(path.join(f.options.dataDir, 'store.json.bak'));
  await absent(f.marker); await absent(f.control); await absent(f.options.brandingFile);
  for (const kind of ['events', 'events-open', 'audit', 'audit-active', 'lookup']) assert.deepEqual(await fs.readdir(path.join(f.options.dataDir, kind)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
}

test('최초 설정 성공 시에만 true 파일을 만들고 재시작 시 기록을 보존한다', async t => {
  const f = await fixture(t);
  await absent(f.marker); await absent(f.control);
  assert.equal((await f.call('/api/setup', 'POST', { password: 'short' })).status, 400); await absent(f.marker);
  await f.setup(); await f.seed();
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'true\n'); assert.equal(await fs.readFile(f.control, 'utf8'), '1\n');
  const before = await f.app.vault.snapshot();
  await f.restart(); assert.equal((await f.call('/api/status')).data.initialized, true);
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.deepEqual(await f.app.vault.snapshot(), before);
  assert.equal((await f.call('/SETUP_COMPLETE.txt')).status, 404, '파일은 웹에 제공하지 않음');
});

test('파일 삭제는 이전 비밀번호 없이 모든 데이터와 세션을 초기화하고 새 비밀번호를 받는다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed();
  await fs.writeFile(path.join(f.options.dataDir, 'operator-note.txt'), 'preserve');
  await fs.unlink(f.marker);
  const responses = await Promise.all([f.call('/api/status'), f.call('/api/branding'), f.call('/api/events')]);
  assert.deepEqual(responses.map(result => result.status), [200, 200, 401]);
  await resetState(f);
  assert.equal(await fs.readFile(path.join(f.options.dataDir, 'operator-note.txt'), 'utf8'), 'preserve');
  await f.setup(replacement); assert.equal(await fs.readFile(f.marker, 'utf8'), 'true\n');
  assert.equal((await f.app.vault.snapshot()).events.length, 0); assert.deepEqual(f.app.vault.state.catalog.services, []); assert.deepEqual(f.app.vault.state.workflows, []);
  await f.restart(); assert.equal((await f.call('/api/login', 'POST', { password })).status, 401);
  assert.equal((await f.call('/api/login', 'POST', { password: replacement })).status, 200);
});

test('잠긴 서버와 서버 시작 전 파일 삭제 모두 비밀번호 없이 초기화한다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed(); await f.restart();
  assert.equal(f.app.vault.unlocked, false); await fs.unlink(f.marker); await resetState(f);
  await f.setup(); await f.seed(); await f.stop(); await fs.unlink(f.marker);
  // Reset must work even when corrupted settings/storage prevented login.
  await fs.writeFile(f.options.brandingFile, '{broken'); await fs.writeFile(path.join(f.options.dataDir, 'store.json'), '{broken');
  await f.start(); await resetState(f); await f.setup(replacement);
});

test('기존 설치 최초 업그레이드는 데이터 변경 없이 완료 파일을 도입한다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed(); const state = await f.app.vault.snapshot();
  await f.stop();
  await fs.unlink(f.marker); await fs.unlink(f.control); // Simulate an installation predating this feature.
  const store = await fs.readFile(path.join(f.options.dataDir, 'store.json'));
  await f.start();
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'true\n'); assert.equal(await fs.readFile(f.control, 'utf8'), '1\n');
  assert.deepEqual(await fs.readFile(path.join(f.options.dataDir, 'store.json')), store);
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200); assert.deepEqual(await f.app.vault.snapshot(), state);
  await f.stop(); await fs.unlink(f.marker); await f.start(); await resetState(f);
});

test('false·빈 내용·잘못된 파일 형식은 초기화로 취급하지 않는다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed();
  const store = await fs.readFile(f.app.vault.file), state = await f.app.vault.snapshot();
  for (const content of ['false', '', 'TRUE', 'true'.repeat(30)]) {
    await fs.writeFile(f.marker, content);
    assert.equal((await f.call('/api/status')).status, 503);
    assert.deepEqual(await fs.readFile(f.app.vault.file), store); assert.deepEqual(await f.app.vault.snapshot(), state);
  }
  await f.stop(); await fs.unlink(f.marker); await fs.mkdir(f.marker);
  await assert.rejects(f.start(), { status: 503 }); assert.deepEqual(await fs.readFile(path.join(f.options.dataDir, 'store.json')), store);
  await fs.rmdir(f.marker); await fs.writeFile(f.marker, 'true\n'); await f.start();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
});

test('접속이 없어도 파일 삭제를 감지하고 실행 중인 API 작업을 중지한다', async t => {
  let started = false, stopped = false;
  const f = await fixture(t, { fetch: async (_url, { signal }) => { started = true; try { await delay(30000, null, { signal }); } finally { stopped = true; } return new Response('{}'); } });
  await f.setup(); const flow = await f.seed();
  const saved = await f.app.workflows.save(flow.id, { ...flow, nodes: [...flow.nodes, { id: 'http', type: 'http', name: '요청', x: 36, y: 216, config: { method: 'GET', url: 'http://127.0.0.1:1', headers: '{}', body: '', timeoutMs: 30000, retries: 0, onError: 'stop' } }], edges: [{ id: 'edge', from: 'cron', to: 'http', port: 'next' }] });
  assert.equal((await f.call(`/api/workflows/${flow.id}/run`, 'POST', { version: saved.version, requestId: randomUUID() })).status, 202);
  for (let i = 0; i < 200 && !started; i++) await delay(10);
  assert.equal(started, true); await fs.unlink(f.marker);
  for (let i = 0; i < 300 && f.app.vault.initialized; i++) await delay(10);
  assert.equal(f.app.vault.initialized, false); assert.equal(stopped, true); assert.equal(f.app.workflowEngine.jobs.size, 0);
  await resetState(f);
});

test('초기화가 중단되면 최초 설정을 차단하고 재시작 시 삭제를 완료한다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed();
  await fs.unlink(f.options.brandingFile); await fs.mkdir(f.options.brandingFile);
  await fs.unlink(f.marker);
  assert.equal((await f.call('/api/status')).status, 503); assert.equal((await f.call('/api/status')).status, 503);
  assert.equal((await f.call('/api/setup', 'POST', { password: replacement })).status, 503);
  await fs.access(path.join(f.options.dataDir, '.system-reset-pending'));
  await fs.rmdir(f.options.brandingFile); await f.restart(); await resetState(f); await f.setup(replacement);
});

test('이미 접수한 쓰기를 기다린 뒤 초기화하여 이전 기록이 다시 생기지 않는다', async t => {
  const f = await fixture(t); await f.setup();
  const original = f.app.vault.write; let writing = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.app.vault.write = async function (...args) { writing = true; await gate; return original.apply(this, args); };
  const create = f.call('/api/events', 'POST', { title: '진행 중인 저장', description: '', category: 'incident', services: [], start: new Date().toISOString(), end: null });
  for (let i = 0; i < 100 && !writing; i++) await delay(10);
  assert.equal(writing, true); await fs.unlink(f.marker);
  let completed = false;
  const status = f.call('/api/status').then(value => { completed = true; return value; });
  await delay(80); assert.equal(completed, false);
  release(); assert.equal((await create).status, 201); assert.equal((await status).data.initialized, false);
  f.app.vault.write = original; await resetState(f); await f.setup(replacement); assert.deepEqual((await f.app.vault.snapshot()).events, []);
});
