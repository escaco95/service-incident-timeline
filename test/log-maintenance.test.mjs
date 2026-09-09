import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { DEFAULT_LOG_POLICY, validateLogPolicy } from '../lib/log-policy.mjs';
import { LogMaintenance, pruneLogsAndEvents } from '../lib/log-maintenance.mjs';
import { readAudit } from '../lib/audit.mjs';
import { cronSlot } from '../lib/workflow-definition.mjs';

const DAY = 86400000, at = '2026-09-10T03:00:00.000Z';
const ago = days => new Date(Date.parse(at) - days * DAY).toISOString();
const password = 'log-policy-test-only-password';
const policy = { version: 1, cron: '0 3 * * *', eventRetentionDays: 30, auditRetentionDays: 7 };
const event = end => ({ id: randomUUID(), title: '만료 정책 테스트', category: 'incident', service: '', services: [], start: ago(100), end, description: 'private-event-payload', version: 1, createdAt: ago(100), updatedAt: ago(100) });
const change = when => ({ id: randomUUID(), at: when, action: 'event-created', actor: 'shared-user', before: null, after: null });
const stateFixture = () => ({ schemaVersion: 5, revision: 0, createdAt: at, updatedAt: at, events: [], changes: [], workflowRuns: [], workflows: [], catalog: { version: 1, services: [] } });

async function fixture(t, clock = () => at) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-log-policy-'));
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false, clock } };
  let app = await createApp(options), base = `http://127.0.0.1:${(await app.listen(0)).port}`, cookie = '';
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('timeline-log-policy-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    get app() { return app; }, directory,
    async call(url, method = 'GET', body, headers = {}) {
      const response = await fetch(base + url, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    },
    async restart(afterClose) { await app.close(); await afterClose?.(); app = await createApp(options); base = `http://127.0.0.1:${(await app.listen(0)).port}`; cookie = ''; }
  };
}

test('로그 정책 범위·정수 검증, cron 문법과 일·요일 조건', () => {
  for (const [field, invalid] of [['eventRetentionDays', [29, 3651, 30.1, '30', null]], ['auditRetentionDays', [6, 181, 7.1, '7', null]]]) {
    for (const value of invalid) assert.throws(() => validateLogPolicy({ ...policy, [field]: value }), { status: 400 });
  }
  for (const days of [30, 3650]) assert.equal(validateLogPolicy({ ...policy, eventRetentionDays: days }).eventRetentionDays, days);
  for (const days of [7, 180]) assert.equal(validateLogPolicy({ ...policy, auditRetentionDays: days }).auditRetentionDays, days);
  for (const cron of ['', '* * * *', '* * * * * *', '60 * * * *', '0 24 * * *', '0 3 0 * *', '*/0 * * * *', '0 3 * * 8', '0 3 * * *; rm', '*'.repeat(101)]) assert.throws(() => validateLogPolicy({ ...policy, cron }), { status: 400 });
  assert.equal(validateLogPolicy({ ...policy, cron: '  0   3 * * *  ' }).cron, '0 3 * * *');
  assert.ok(cronSlot({ expression: '0 3 1 * 4', timezone: 'UTC' }, at));
  assert.equal(cronSlot({ expression: '0 3 * * 1', timezone: 'UTC' }, at), null);
  assert.ok(cronSlot({ expression: '*/15 3-5 * * 1,4', timezone: 'UTC' }, at));
});

test('정책 API: 인증, 범위, 충돌, 암호화, 재시작과 기존 저장소 기본값', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/settings/log-policy')).status, 401);
  assert.equal((await f.call('/api/settings/log-policy', 'PUT', { policy })).status, 401);
  assert.equal((await f.call('/api/setup', 'POST', { password })).status, 200);
  const original = await fs.readFile(f.app.vault.file, 'utf8');
  assert.deepEqual((await f.call('/api/settings/log-policy')).data.policy, DEFAULT_LOG_POLICY);
  assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), original, '기본값 조회만으로 기존 파일을 수정하지 않는다');
  assert.equal((await f.call('/api/settings/log-policy', 'PUT', { policy }, { Origin: 'https://untrusted.example' })).status, 403);
  for (const patch of [{ eventRetentionDays: 29 }, { eventRetentionDays: 3651 }, { auditRetentionDays: 6 }, { auditRetentionDays: 181 }, { auditRetentionDays: 7.5 }, { cron: 'invalid' }, { version: null }]) assert.equal((await f.call('/api/settings/log-policy', 'PUT', { policy: { ...policy, ...patch } })).status, 400);
  assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), original);
  const writes = await Promise.all([30, 3650].map(eventRetentionDays => f.call('/api/settings/log-policy', 'PUT', { policy: { ...policy, eventRetentionDays } })));
  assert.deepEqual(writes.map(row => row.status).sort(), [200, 409]);
  const savedPolicy = (await f.call('/api/settings/log-policy')).data.policy;
  assert.equal(savedPolicy.version, 2);
  const audit = (await f.call('/api/audit?search=log-policy-updated')).data.items;
  assert.equal(audit.length, 1); assert.deepEqual(audit[0].before, DEFAULT_LOG_POLICY); assert.deepEqual(audit[0].after, savedPolicy);
  const ciphertext = await fs.readFile(f.app.vault.file, 'utf8');
  assert.equal(ciphertext.includes('eventRetentionDays'), false); assert.equal(ciphertext.includes('log-policy-updated'), false);
  await f.restart();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.deepEqual((await f.call('/api/settings/log-policy')).data.policy, savedPolicy);
  assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), ciphertext);
});

test('만료 경계, 종료 미정·미래 일정 보존, 감사 실행 묶음·진행 중 실행 보존', () => {
  const state = stateFixture();
  const expiredEvent = event('2026-08-10T23:59:59.999Z'), recentEvent = event('2026-08-11T00:00:00.000Z'), ongoing = event(null), future = event(ago(-2));
  state.events = [expiredEvent, recentEvent, ongoing, future];
  const old = change('2026-09-02T23:59:59.999Z'), recent = change('2026-09-03T00:00:00.000Z'), undated = change('unknown');
  state.changes = [old, recent, undated];
  const runs = [['old', 'success', ago(8)], ['recent', 'failure', ago(6)], ['running', 'running', ago(9)], ['queued', 'queued', undefined]].map(([id, status, finishedAt]) => ({ id, status, finishedAt, createdAt: ago(10) }));
  state.workflowRuns = runs;
  const result = pruneLogsAndEvents(state, policy, at, 'UTC', at);
  assert.deepEqual(state.events, [recentEvent, ongoing, future]);
  assert.deepEqual(state.changes.slice(0, 2), [recent, undated]);
  assert.deepEqual(state.workflowRuns.map(row => row.id), ['recent', 'running', 'queued']);
  assert.deepEqual(result.rotatedAudit, { changes: 1, workflowRuns: 1 });
  const logs = state.changes.slice(-2);
  assert.deepEqual(logs.map(row => row.action), ['audit-rotated', 'events-expired']);
  assert.ok(logs.every(row => row.actor === 'system' && row.at === at && row.after.status === 'pending'));
  assert.equal(logs[0].after.count, 2); assert.deepEqual(logs[1].after.eventIds, [expiredEvent.id]);
  assert.equal(readAudit(state, new URLSearchParams({ eventId: expiredEvent.id })).items[0].action, 'events-expired');
});

test('cron 실행: 서비스 시간대, 동시 점검·재시작 중복 방지, 0건 결과와 다음 일정', async t => {
  let now = '2026-09-09T17:59:00.000Z';
  const f = await fixture(t, () => now);
  await f.app.logMaintenance.tick(); assert.equal(f.app.vault.state, null);
  await f.call('/api/setup', 'POST', { password });
  const brand = (await f.call('/api/settings/branding')).data;
  await f.call('/api/settings/branding', 'PUT', { ...brand, branding: { ...brand.branding, timezone: 'Asia/Seoul' } });
  await f.call('/api/settings/log-policy', 'PUT', { policy });
  const record = event(ago(32));
  await f.app.vault.mutate(state => { state.events.push(record); });
  const before = f.app.vault.state.revision;
  await f.app.logMaintenance.tick(); assert.equal(f.app.vault.state.revision, before);
  now = '2026-09-09T18:00:00.000Z';
  await Promise.all(Array.from({ length: 5 }, () => f.app.logMaintenance.tick()));
  assert.equal((await f.app.vault.snapshot()).events.length, 0); assert.equal(f.app.vault.state.revision, before + 2);
  const after = await fs.readFile(f.app.vault.file, 'utf8');
  assert.equal(after.includes(record.id), false);
  await f.restart(); await f.call('/api/login', 'POST', { password });
  await f.app.logMaintenance.tick(); assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), after);
  now = '2026-09-10T18:00:00.000Z'; await f.app.logMaintenance.tick();
  assert.equal((await f.app.vault.snapshot()).changes.filter(row => row.action === 'events-expired').length, 2);
  assert.equal(f.app.vault.state.logMaintenance.lastRun.expiredEvents, 0);
  assert.equal((await f.call('/api/settings/log-policy')).data.lastRun.status, 'success');
});

test('저장 실패는 삭제·완료 기록을 롤백하고 복구 후 실패 이력과 성공 이력을 남긴다', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  await f.call('/api/settings/log-policy', 'PUT', { policy });
  await f.app.vault.mutate(state => { state.events.push(event(ago(40))); state.changes.push(change(ago(10))); });
  const before = structuredClone(f.app.vault.state), stored = await fs.readFile(f.app.vault.file, 'utf8'), write = f.app.vault.write;
  f.app.vault.write = async () => { throw new Error('disk unavailable'); };
  await f.app.logMaintenance.tick();
  assert.deepEqual(f.app.vault.state, before); assert.equal(await fs.readFile(f.app.vault.file, 'utf8'), stored);
  assert.match(f.app.logMaintenance.read().fault, /실패 감사 기록도 아직 저장하지 못해/);
  f.app.vault.write = write;
  await f.app.logMaintenance.tick();
  const state = await f.app.vault.snapshot();
  assert.equal(state.events.length, 0); assert.equal(f.app.logMaintenance.fault, null);
  assert.equal(state.changes.filter(row => row.action === 'log-maintenance-failed').length, 1);
  assert.equal(state.changes.filter(row => row.action === 'events-expired').length, 1);
  assert.equal(state.logMaintenance.lastRun.status, 'success');
  await f.app.logMaintenance.tick(); assert.equal(f.app.vault.state.revision, state.revision);
});

test('감사 기록 한도에서도 만료 기록을 먼저 정리하고 시스템 기록을 저장한다', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  await f.app.vault.mutate(state => { state.logPolicy = policy; state.changes = Array.from({ length: 50000 }, () => change(ago(10))); });
  const write = f.app.vault.write;
  f.app.vault.write = async () => { throw new Error('disk unavailable'); };
  await f.app.logMaintenance.tick(); assert.equal((await f.app.vault.snapshot()).changes.length, 50000);
  f.app.vault.write = write;
  await f.app.logMaintenance.tick();
  assert.equal((await f.app.vault.snapshot()).changes.length, 3);
  assert.equal(f.app.vault.state.logMaintenance.lastRun.rotatedAudit.changes, 50000);
});

test('실제 타이머는 잠금 해제 후 실행하고 종료하면 멈춘다', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  await f.app.vault.mutate(state => { state.logPolicy = policy; });
  const runner = new LogMaintenance(f.app.vault, { clock: () => at, intervalMs: 10 });
  try {
    for (let index = 0; index < 100 && f.app.vault.state.logMaintenance?.lastRun?.status !== 'success'; index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.app.vault.state.logMaintenance.lastRun.status, 'success');
  } finally { await runner.close(); }
  const revision = f.app.vault.state.revision;
  await runner.tick(); assert.equal(f.app.vault.state.revision, revision);
});

test('일자별 암호화 파일: 변경 날짜만 저장, 종료일 수정 시 이동, 만료 파일과 백업 참조 정리', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  const old = event(ago(40)), recent = event(ago(2)), ongoing = event(null);
  await f.app.vault.mutate(state => { state.logPolicy = policy; state.events = [old, recent, ongoing]; state.changes = [change(ago(10)), change(ago(1))]; });
  const initial = f.app.vault.daily.manifest;
  assert.equal(initial.dailyStorageVersion, 2);
  assert.equal(Object.hasOwn(initial.metadata, 'events'), false); assert.equal(Object.hasOwn(initial.metadata, 'changes'), false);
  const recentFile = initial.files.find(ref => ref.kind === 'events' && ref.day === recent.end.slice(0, 10));
  const recentContent = await fs.readFile(path.join(f.directory, recentFile.file), 'utf8');
  assert.equal(recentContent.includes('private-event-payload'), false);
  assert.equal(recentContent.includes(recent.id), false);
  assert.deepEqual(JSON.parse(recentContent).scope, { kind: 'events', day: recent.end.slice(0, 10) });
  const moved = await f.app.vault.update(ongoing.id, { ...ongoing, end: ago(-1), version: 1 });
  assert.equal(moved.event.end, ago(-1));
  assert.equal(f.app.vault.daily.manifest.files.some(ref => ref.kind === 'events-open'), false);
  assert.equal(f.app.vault.daily.manifest.files.find(ref => ref.file === recentFile.file)?.file, recentFile.file);
  assert.equal(await fs.readFile(path.join(f.directory, recentFile.file), 'utf8'), recentContent);
  const oldRefs = f.app.vault.daily.manifest.files.filter(ref => ref.kind === 'events' && ref.day === old.end.slice(0, 10) || ref.kind === 'audit' && ref.day === ago(10).slice(0, 10));
  await f.app.logMaintenance.tick();
  assert.equal(f.app.vault.state.logMaintenance.lastRun.status, 'success');
  for (const ref of oldRefs) await assert.rejects(fs.access(path.join(f.directory, ref.file)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.directory, recentFile.file), 'utf8'), recentContent);
  const expiry = (await f.app.vault.snapshot()).changes.find(row => row.action === 'events-expired');
  assert.ok(expiry.after.files.some(ref => ref.day === old.end.slice(0, 10)));
  assert.equal(expiry.after.status, 'success');
  await f.restart(() => fs.copyFile(path.join(f.directory, 'store.json.bak'), path.join(f.directory, 'store.json')));
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.app.vault.snapshot()).events.some(row => row.id === old.id), false, '로컬 백업으로 만료 파일이 복구되지 않는다');
  await f.app.logMaintenance.tick();
  assert.equal(f.app.vault.state.logMaintenance.lastRun.status, 'success');
});

test('파일 삭제 실패는 감사 기록에 남고 재시작 후 cron 시각 밖에서도 미완료 정리를 재개한다', async t => {
  let now = at;
  const f = await fixture(t, () => now);
  await f.call('/api/setup', 'POST', { password });
  const old = event(ago(40));
  await f.app.vault.mutate(state => { state.logPolicy = policy; state.events.push(old); });
  const oldFile = f.app.vault.daily.manifest.files.find(ref => ref.kind === 'events').file;
  f.app.vault.daily.cleanup = async () => ({ deletedFiles: {}, pendingFiles: 1 });
  await f.app.logMaintenance.tick();
  assert.ok(f.app.vault.state.logMaintenance.pendingRun);
  assert.equal((await f.app.vault.snapshot()).changes.find(row => row.action === 'events-expired').after.status, 'pending');
  assert.equal((await f.app.vault.snapshot()).changes.filter(row => row.action === 'log-maintenance-failed').length, 1);
  await fs.access(path.join(f.directory, oldFile));
  now = '2026-09-10T12:00:00.000Z';
  await f.restart(); await f.call('/api/login', 'POST', { password });
  await f.app.logMaintenance.tick();
  await assert.rejects(fs.access(path.join(f.directory, oldFile)), { code: 'ENOENT' });
  assert.equal(f.app.vault.state.logMaintenance.pendingRun, undefined);
  assert.equal((await f.app.vault.snapshot()).changes.filter(row => row.action === 'events-expired').length, 1);
  assert.equal((await f.app.vault.snapshot()).changes.find(row => row.action === 'events-expired').after.status, 'success');
});

test('일자별 파일 누락·날짜 간 암호문 교체는 해당 조회를 거부하며 원본을 초기화하지 않는다', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  await f.app.vault.mutate(state => { state.events = [event(ago(2)), event(ago(1))]; });
  const refs = f.app.vault.daily.manifest.files.filter(ref => ref.kind === 'events');
  const first = path.join(f.directory, refs[0].file), second = path.join(f.directory, refs[1].file);
  const original = await fs.readFile(first), root = await fs.readFile(f.app.vault.file);
  await f.restart(() => fs.copyFile(second, first));
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.call('/api/events')).status, 503);
  assert.deepEqual(await fs.readFile(f.app.vault.file), root);
  await f.restart(() => fs.writeFile(first, original));
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  await f.restart(() => fs.unlink(first));
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.call('/api/events')).status, 503);
  assert.equal((await f.call('/api/setup', 'POST', { password })).status, 409);
  assert.deepEqual(await fs.readFile(f.app.vault.file), root);
});

test('10년 기록과 20,000개를 넘는 이벤트는 일자별 파일에 저장하고 관리 파일은 작게 유지한다', async t => {
  const f = await fixture(t);
  await f.call('/api/setup', 'POST', { password });
  await f.app.vault.mutate(state => {
    state.events = Array.from({ length: 20001 }, (_, index) => {
      const year = 2016 + index % 11;
      return { ...event(`${year}-09-09T02:00:00.000Z`), start: `${year}-09-09T01:00:00.000Z` };
    });
  });
  assert.equal(f.app.vault.daily.manifest.files.filter(ref => ref.kind === 'events').length, 11);
  assert.ok((await fs.stat(f.app.vault.file)).size < 256000, '관리 파일에는 이벤트 본문과 개별 ID를 넣지 않는다');
  const created = await f.app.vault.add(event(null));
  assert.ok(created.event.id);
  assert.equal((await f.app.vault.snapshot()).events.length, 20002);
  await f.restart();
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.equal((await f.app.vault.snapshot()).events.length, 20002);
});
