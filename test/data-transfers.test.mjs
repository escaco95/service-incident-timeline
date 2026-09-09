import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import http from 'node:http';
import { ZipReader, ZipWriter } from '../lib/archive-zip.mjs';

const password = 'data-transfer-first-password', nextPassword = 'data-transfer-current-password';
async function fixture(t, workflows = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-transfer-'));
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, ...workflows }, logMaintenance: { autoStart: false } };
  let app, base, cookie = '';
  const f = {
    directory, options, get app() { return app; }, get cookie() { return cookie; }, get base() { return base; },
    async start() { app = await createApp(options); base = `http://127.0.0.1:${(await app.listen(0)).port}`; },
    async stop() { if (app) await app.close(); app = null; },
    async restart() { await this.stop(); await this.start(); },
    async raw(url, method = 'GET', body, headers = {}) { const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json', ...headers }, ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) }); if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return response; },
    async call(...args) { const response = await this.raw(...args); return { status: response.status, data: await response.json() }; },
    async setup(value = password) { assert.equal((await this.call('/api/setup', 'POST', { password: value })).status, 200); },
    async done(id) { for (let i = 0; i < 3000; i++) { const result = await this.call(`/api/settings/transfers/${id}`); assert.equal(result.status, 200); if (['ready', 'failed', 'completed'].includes(result.data.status)) return result.data; await delay(20); } throw Error('Transfer timeout'); },
    async exported() {
      const start = await this.call('/api/settings/transfers/export', 'POST', { requestId: randomUUID() }); assert.equal(start.status, 202);
      const result = await this.done(start.data.id); assert.equal(result.status, 'ready', result.error);
      const response = await this.raw(result.downloadUrl); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /filename="\d{4}_\d{2}_\d{2}\.zip"/);
      return { job: result, bytes: Buffer.from(await response.arrayBuffer()) };
    },
    async uploaded(bytes, name = '2026_09_10.zip') {
      const start = await this.call('/api/settings/transfers/import', 'POST', { requestId: randomUUID(), name, bytes: bytes.length }); assert.equal(start.status, 202);
      assert.equal((await this.call(`/api/settings/transfers/${start.data.id}/upload`, 'PUT', bytes)).status, 202);
      return this.done(start.data.id);
    },
    async restore(job, value = password) { const result = await this.call(`/api/settings/transfers/${job.id}/restore`, 'POST', { confirmed: true, password: value }); assert.equal(result.status, 202, result.data.error); return this.done(job.id); },
    async seed() {
      await app.vault.saveServices({ version: app.vault.state.catalog.version, services: [{ id: 'svc', name: '복원 서비스', active: true }] });
      const event = (await app.vault.add({ title: '복원할 이벤트', description: '한글 내용', services: [{ kind: 'catalog', id: 'svc' }], category: 'incident', start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' })).event;
      let flow = await app.workflows.create({ name: '복원할 워크플로우', requestId: randomUUID(), nodes: [{ id: 'cron', type: 'cron', name: '예약', x: 36, y: 36, config: { expression: '* * * * *', timezone: 'UTC' } }], edges: [] });
      flow = await app.workflows.save(flow.id, { ...flow, secrets: { ACCESS_TOKEN: 'plain-export-private-value' } });
      const run = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
      const brand = (await this.call('/api/settings/branding')).data;
      await this.call('/api/settings/branding', 'PUT', { version: brand.version, branding: { ...brand.branding, name: '백업 시스템', passwordNotice: '백업 안내' } });
      return { event, flow, run };
    }
  };
  t.after(async () => { await f.stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-transfer-')); await fs.rm(directory, { recursive: true, force: true }); });
  await f.start(); return f;
}
async function contents(f, bytes) {
  const file = path.join(f.directory, randomUUID() + '.zip'); await fs.writeFile(file, bytes);
  const zip = await new ZipReader().open(file);
  try { return new Map(await Promise.all([...zip.entries.keys()].map(async name => [name, JSON.parse((await zip.get(name)).toString('utf8'))]))); } finally { await zip.close(); }
}
async function repack(f, data) {
  const file = path.join(f.directory, randomUUID() + '.zip'), writer = await new ZipWriter().open(file), manifest = data.get('manifest.json');
  manifest.files = [];
  for (const [name, value] of data) if (name !== 'manifest.json') { const bytes = Buffer.from(JSON.stringify(value)); await writer.add(name, bytes); manifest.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  await writer.add('manifest.json', Buffer.from(JSON.stringify(manifest))); await writer.finish(); return fs.readFile(file);
}

test('workflow review results and service holds survive archive validation, restore and restart', async t => {
  const f = await fixture(t); await f.setup();
  const flow = await f.app.workflows.create({ name: 'Held service', requestId: randomUUID(), nodes: [
    { id: 'trigger', type: 'service-state', name: 'Service', x: 36, y: 36, config: { service: '' } },
    { id: 'review', type: 'finish', name: 'Review', x: 36, y: 234, config: { result: 'review', message: 'External result needs confirmation' } }
  ], edges: [{ id: 'next', from: 'trigger', to: 'review', port: 'next' }] });
  const run = await f.app.workflows.run(flow.id, { version: flow.version, service: 'resource-a', requestId: randomUUID() });
  await f.app.workflowEngine.tick(); await Promise.all([...f.app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.equal((await f.app.workflows.readRun(run.id)).status, 'review');
  const hold = f.app.workflows.serviceStates()[0].hold;
  const { bytes } = await f.exported(), exported = await contents(f, bytes);
  assert.deepEqual(exported.get('settings.json').metadata.serviceState.services[0].hold, hold);
  const uploaded = await f.uploaded(bytes); assert.equal(uploaded.status, 'ready', uploaded.error);
  assert.equal((await f.restore(uploaded)).status, 'completed');
  assert.equal((await f.app.workflows.readRun(run.id)).status, 'review');
  assert.deepEqual(f.app.workflows.serviceStates()[0].hold, hold);
  await f.restart(); await f.call('/api/login', 'POST', { password });
  assert.deepEqual(f.app.workflows.serviceStates()[0].hold, hold);
  const invalid = await contents(f, bytes); invalid.get('settings.json').metadata.serviceState.services[0].hold.runId = 'invalid';
  assert.equal((await f.uploaded(await repack(f, invalid))).status, 'failed');
});

test('내보내기·업로드·상태·다운로드는 인증·출처·세션 소유권을 확인한다', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/settings/transfers')).status, 401); await f.setup();
  assert.equal((await f.call('/api/settings/transfers/export', 'POST', { requestId: randomUUID() }, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.call('/api/settings/transfers/import', 'POST', { requestId: randomUUID(), name: '../bad.zip', bytes: 30 })).status, 400);
  const requestId = randomUUID(), start = await f.call('/api/settings/transfers/export', 'POST', { requestId });
  assert.equal((await f.call('/api/settings/transfers/export', 'POST', { requestId })).data.id, start.data.id);
  const ready = await f.done(start.data.id); assert.equal(ready.status, 'ready', ready.error);
  assert.equal((await f.call(`/api/settings/transfers/${ready.id}`, 'GET', undefined, { Cookie: '' })).status, 401);
  const owner = f.cookie;
  await f.call('/api/login', 'POST', { password }, { Cookie: '' });
  assert.equal((await f.call(`/api/settings/transfers/${ready.id}`)).status, 404);
  assert.equal((await f.call(ready.downloadUrl)).status, 404);
  assert.equal((await f.raw(ready.downloadUrl, 'GET', undefined, { Cookie: owner })).status, 200);
});

test('ZIP은 준비 완료부터 24시간 보관하고 새 생성 시작 전에 이전 파일을 삭제한다', async t => {
  const f = await fixture(t); await f.setup();
  const before = Date.now(), started = await f.call('/api/settings/transfers/export', 'POST', { requestId: randomUUID() });
  const ready = await f.done(started.data.id); assert.equal(ready.status, 'ready', ready.error);
  const expires = Date.parse(ready.expiresAt), day = 24 * 60 * 60 * 1000;
  assert.ok(expires >= before + day && expires <= Date.now() + day, '준비 완료 후 24시간 만료');
  const oldDirectory = f.app.transfers.jobs.get(ready.id).directory;
  await fs.access(path.join(oldDirectory, 'export.zip'));
  assert.equal((await f.call(`/api/settings/transfers/${ready.id}`)).data.expiresAt, ready.expiresAt, '조회로 보존 기간을 연장하지 않음');
  const snapshot = f.app.transfers.snapshot;
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.app.transfers.snapshot = async () => { await gate; throw Error('new export failed'); };
  try {
    const requestId = randomUUID(), next = await f.call('/api/settings/transfers/export', 'POST', { requestId });
    assert.equal(next.status, 202); assert.equal(next.data.status, 'preparing');
    await assert.rejects(fs.access(oldDirectory), { code: 'ENOENT' });
    assert.equal((await f.call(ready.downloadUrl)).status, 404);
    assert.equal((await f.call('/api/settings/transfers/export', 'POST', { requestId })).data.id, next.data.id);
    release(); assert.equal((await f.done(next.data.id)).status, 'failed');
    await assert.rejects(fs.access(oldDirectory), { code: 'ENOENT' });
  } finally { release(); f.app.transfers.snapshot = snapshot; }
});

test('복호화 ZIP 왕복: 검증 전 보존, 전체 교체, 현재 암호 유지, 미완료 실행 중단과 재시작', async t => {
  const f = await fixture(t); await f.setup(); const seed = await f.seed(); const exported = await f.exported();
  const data = await contents(f, exported.bytes);
  assert.equal(data.get('settings.json').metadata.workflows[0].secrets.ACCESS_TOKEN, 'plain-export-private-value');
  assert.equal(data.get('settings.json').metadata.password, undefined); assert.equal(data.get('manifest.json').counts.events, 1);
  assert.equal((await f.call('/api/settings/reset', 'POST', { target: 'system', confirmed: true, password, requestId: randomUUID() })).status, 200);
  await f.setup(nextPassword); await f.app.vault.add({ ...seed.event, title: '교체될 현재 기록', services: [] });
  const before = await fs.readFile(f.app.vault.file), imported = await f.uploaded(exported.bytes);
  assert.equal(imported.status, 'ready', imported.error); assert.equal(imported.counts.events, 1); assert.deepEqual(await fs.readFile(f.app.vault.file), before);
  const restoreUrl = `/api/settings/transfers/${imported.id}/restore`;
  assert.equal((await f.call(restoreUrl, 'POST', { confirmed: false, password: nextPassword })).status, 409);
  assert.equal((await f.call(restoreUrl, 'POST', { confirmed: true, password })).status, 403);
  assert.deepEqual(await fs.readFile(f.app.vault.file), before);
  const complete = await f.restore(imported, nextPassword); assert.equal(complete.status, 'completed', complete.error); assert.equal(complete.warning, undefined);
  assert.equal((await f.app.vault.read()).events[0].id, seed.event.id); assert.equal((await f.app.vault.read()).events[0].title, seed.event.title);
  assert.equal(f.app.vault.state.workflows[0].secrets.ACCESS_TOKEN, 'plain-export-private-value'); assert.equal((await f.app.workflows.readRun(seed.run.id)).status, 'interrupted'); assert.equal(f.app.workflowEngine.jobs.size, 0);
  assert.equal(f.app.branding.name, '백업 시스템'); assert.equal(await fs.readFile(path.join(f.options.dataDir, 'SETUP_COMPLETE.txt'), 'utf8'), 'true\n');
  const revision = f.app.vault.state.revision; assert.equal((await f.restore(imported, nextPassword)).status, 'completed'); assert.equal(f.app.vault.state.revision, revision, '반복된 적용 요청은 다시 복원하지 않음');
  await f.restart(); assert.equal((await f.call('/api/login', 'POST', { password })).status, 401); assert.equal((await f.call('/api/login', 'POST', { password: nextPassword })).status, 200);
  assert.equal((await f.app.vault.read()).events.length, 1);
});

test('손상 ZIP·변경된 체크섬·중복 ID·잘못된 설정은 기존 파일을 바꾸지 않는다', async t => {
  const f = await fixture(t); await f.setup(); await f.seed(); const exported = await f.exported(), original = await fs.readFile(f.app.vault.file);
  assert.equal((await f.uploaded(Buffer.alloc(50, 1))).status, 'failed');
  const badVersion = await contents(f, exported.bytes); badVersion.get('manifest.json').version = 999;
  assert.equal((await f.uploaded(await repack(f, badVersion))).status, 'failed');
  const badSettings = await contents(f, exported.bytes); badSettings.get('settings.json').metadata.catalog.version = 0;
  assert.equal((await f.uploaded(await repack(f, badSettings))).status, 'failed');
  const duplicate = await contents(f, exported.bytes), entry = duplicate.get('data/events/2026-01-02.json').events[0];
  duplicate.set('data/events/2026-01-03.json', { events: [{ ...entry, end: '2026-01-03T00:00:00.000Z' }] }); duplicate.get('manifest.json').counts.events++;
  const failed = await f.uploaded(await repack(f, duplicate)); assert.equal(failed.status, 'failed'); assert.match(failed.error, /중복/);
  const corrupted = Buffer.from(exported.bytes); corrupted[70] ^= 1; assert.equal((await f.uploaded(corrupted)).status, 'failed');
  assert.deepEqual(await fs.readFile(f.app.vault.file), original);
});

test('적용 중 저장 실패는 일반 API를 차단하고 재시작에서 승인된 복원을 완료한다', async t => {
  const f = await fixture(t); await f.setup(); const seed = await f.seed(), exported = await f.exported();
  await f.app.vault.remove(seed.event.id, seed.event.version);
  const imported = await f.uploaded(exported.bytes); assert.equal(imported.status, 'ready', imported.error);
  const write = f.app.vault.write; f.app.vault.write = async () => { throw Error('disk full'); };
  const failed = await f.restore(imported); assert.equal(failed.status, 'failed'); assert.match(failed.error, /재시작/);
  assert.equal((await f.call('/api/events')).status, 503); await fs.access(path.join(f.options.dataDir, '.restore-pending.json'));
  f.app.vault.write = write; await f.restart(); assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.app.vault.read()).events[0].id, seed.event.id); await assert.rejects(fs.access(path.join(f.options.dataDir, '.restore-pending.json')), { code: 'ENOENT' });
});

test('로그아웃·만료·파일 초기화 시 ZIP과 준비 데이터를 정리한다', async t => {
  const f = await fixture(t); await f.setup();
  let exported = await f.exported(), directory = f.app.transfers.jobs.get(exported.job.id).directory;
  for (let i = 0; i < 100 && f.app.transfers.jobs.get(exported.job.id).downloads.size; i++) await delay(10);
  assert.equal(f.app.transfers.jobs.get(exported.job.id).downloads.size, 0);
  f.app.transfers.jobs.get(exported.job.id).expires = Date.now() - 1; await f.app.transfers.expire(); await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  exported = await f.exported(); directory = f.app.transfers.jobs.get(exported.job.id).directory;
  assert.equal((await f.call('/api/logout', 'POST', {})).status, 200); await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  await f.call('/api/login', 'POST', { password }); exported = await f.exported(); directory = f.app.transfers.jobs.get(exported.job.id).directory;
  await fs.unlink(path.join(f.options.dataDir, 'SETUP_COMPLETE.txt')); assert.equal((await f.call('/api/status')).data.initialized, false); await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('10년의 일별 기록을 순차 내보내고 복원하며 내보내기 도중의 변경은 분리한다', async t => {
  const f = await fixture(t); await f.setup();
  const from = Date.parse('2016-01-01T00:00:00.000Z'), until = Date.parse('2026-01-01T00:00:00.000Z'), count = (until - from) / 86400000;
  await f.app.vault.mutate(state => {
    for (let at = from; at < until; at += 86400000) state.events.push({ id: randomUUID(), title: '10년 일별 기록', description: '', service: '', services: [], category: 'maintenance', start: new Date(at).toISOString(), end: new Date(at + 3600000).toISOString(), createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), version: 1 });
  }, { scope: {} });
  const started = await f.call('/api/settings/transfers/export', 'POST', { requestId: randomUUID() });
  const job = f.app.transfers.jobs.get(started.data.id);
  for (let i = 0; i < 3000 && !job.worker && job.status !== 'failed'; i++) await delay(10);
  assert.ok(job.worker, job.error);
  await f.app.vault.add({ title: '스냅샷 이후 추가', description: '', services: [], category: 'incident', start: '2026-02-01T00:00:00.000Z', end: null });
  const exported = await f.done(job.id); assert.equal(exported.status, 'ready', exported.error); assert.equal(exported.counts.events, count);
  const response = await f.raw(exported.downloadUrl), bytes = Buffer.from(await response.arrayBuffer());
  const imported = await f.uploaded(bytes); assert.equal(imported.status, 'ready', imported.error); assert.equal(imported.counts.events, count);
  assert.equal((await f.call('/healthz')).status, 200);
  const restored = await f.restore(imported); assert.equal(restored.status, 'completed', restored.error);
  assert.equal((await f.app.vault.read()).total, count); assert.deepEqual(f.app.vault.state.events, [], '서버 메타데이터에 전체 기록을 상주시키지 않음');
  const early = await f.app.vault.read(new URLSearchParams({ from: '2016-01-01T00:00:00.000Z', until: '2016-01-02T00:00:00.000Z' })); assert.equal(early.events.length, 1);
  const late = await f.app.vault.read(new URLSearchParams({ from: '2025-12-31T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' })); assert.equal(late.events.length, 1);
});

test('복원은 현재 실행 중인 HTTP를 중지하고 ZIP의 실행을 자동 재개하지 않는다', async t => {
  let started = false, stopped = false, calls = 0;
  const f = await fixture(t, { fetch: async (_url, { signal }) => { started = true; calls++; try { await delay(30000, null, { signal }); } finally { stopped = true; } return new Response('{}'); } });
  await f.setup(); const seed = await f.seed();
  const flow = await f.app.workflows.save(seed.flow.id, { ...seed.flow, nodes: [...seed.flow.nodes, { id: 'http', type: 'http', name: '요청', x: 36, y: 216, config: { method: 'GET', url: 'http://127.0.0.1:1', headers: '{}', body: '', timeoutMs: 30000, retries: 0, onError: 'stop' } }], edges: [{ id: 'edge', from: 'cron', to: 'http', port: 'next' }] });
  assert.equal((await f.call(`/api/workflows/${flow.id}/run`, 'POST', { requestId: randomUUID(), version: flow.version })).status, 202);
  for (let i = 0; i < 300 && !started; i++) await delay(10); assert.equal(started, true);
  const exported = await f.exported(), imported = await f.uploaded(exported.bytes); assert.equal(imported.status, 'ready', imported.error);
  const restored = await f.restore(imported); assert.equal(restored.status, 'completed', restored.error); assert.equal(stopped, true);
  await delay(50); assert.equal(calls, 1); assert.equal(f.app.workflowEngine.jobs.size, 0); assert.ok((await f.app.vault.snapshot({ activeRuns: true })).workflowRuns.length === 0);
});

test('진행 중 업로드도 파일 초기화와 서버 종료에서 취소하고 임시 파일을 제거한다', async t => {
  const f = await fixture(t); await f.setup();
  for (const action of ['reset', 'close']) {
    const result = await f.call('/api/settings/transfers/import', 'POST', { name: 'upload.zip', bytes: 1048576, requestId: randomUUID() });
    const job = f.app.transfers.jobs.get(result.data.id);
    const req = http.request(f.base + `/api/settings/transfers/${job.id}/upload`, { method: 'PUT', headers: { Cookie: f.cookie, Origin: f.base, 'Content-Type': 'application/zip', 'Content-Length': 1048576 } });
    req.on('error', () => {}); req.on('response', response => response.resume()); req.write(Buffer.alloc(32));
    for (let i = 0; i < 100 && !job.receiving; i++) await delay(10); assert.equal(job.receiving, true);
    if (action === 'reset') { await fs.unlink(path.join(f.options.dataDir, 'SETUP_COMPLETE.txt')); assert.equal((await f.call('/api/status')).data.initialized, false); await f.setup(); }
    else await f.stop();
    req.destroy(); await assert.rejects(fs.access(job.directory), { code: 'ENOENT' });
  }
  const orphan = path.join(f.options.dataDir, '.transfers', randomUUID()); await fs.mkdir(orphan); await fs.writeFile(path.join(orphan, 'export.zip'), 'old plaintext');
  await f.start(); await assert.rejects(fs.access(orphan), { code: 'ENOENT' });
});
