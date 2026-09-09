import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { Vault } from '../lib/vault.mjs';
import { LogMaintenance } from '../lib/log-maintenance.mjs';
import { readAudit } from '../lib/audit.mjs';
import { Workflows } from '../lib/workflows.mjs';

const password = 'period-loading-test-password';
const stamp = day => `${day}T00:00:00.000Z`;
const event = (start, end, extra = {}) => ({ id: randomUUID(), title: '기간 조회', description: '', service: '', services: [], category: 'incident', start: stamp(start), end: end ? stamp(end) : null, createdAt: stamp('2016-01-01'), updatedAt: stamp('2016-01-01'), version: 1, ...extra });
const period = (from, until, extra = {}) => new URLSearchParams({ from: stamp(from), until: stamp(until), ...extra });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-period-'));
  let vault = await new Vault(directory).open(); await vault.setup(password);
  t.after(async () => { await vault.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-period-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, get vault() { return vault; }, async restart() { await vault.close(); vault = await new Vault(directory).open(); await vault.unlock(password); return vault; } };
}
function track(vault) {
  vault.daily.clearCache(); const read = vault.daily.readBucket.bind(vault.daily), files = [];
  vault.daily.readBucket = ref => { if (ref) files.push(ref); return read(ref); };
  return files;
}

test('잠금 해제는 본문을 읽지 않고, 표시 기간·장기 이벤트·종료 미정과 종료 경계를 조회한다', async t => {
  const f = await fixture(t);
  const old = event('2016-01-01', '2016-01-02'), recent = event('2026-09-10', '2026-09-11');
  const long = event('2020-01-01', '2027-01-01'), open = event('2018-01-01', null), boundary = event('2026-09-09', '2026-09-10');
  await f.vault.mutate(state => { state.events = [old, recent, long, open, boundary]; });
  const vault = await f.restart(); assert.equal(vault.daily.reads, 0); assert.deepEqual(vault.state.events, []);
  const files = track(vault), result = await vault.read(period('2026-09-10', '2026-09-11'));
  assert.deepEqual(new Set(result.events.map(row => row.id)), new Set([recent.id, long.id, open.id]));
  assert.equal(result.total, 3); assert.ok(files.every(ref => !['2016-01-02', '2026-09-10'].includes(ref.day)));
  const reads = vault.daily.reads; await vault.read(period('2026-09-10', '2026-09-11')); assert.equal(vault.daily.reads, reads, '같은 파일은 캐시에서 읽는다');
  files.length = 0; vault.daily.clearCache(); assert.equal((await vault.getRecord('events', old.id)).id, old.id);
  assert.deepEqual(files.map(ref => ref.kind), ['lookup', 'events']);
  assert.equal(files[1].day, '2016-01-02');
  const first = await vault.read(period('2026-09-10', '2026-09-11', { limit: '1' }));
  const pages = [first.events[0].id];
  for (let page = 2; page <= first.pages; page++) pages.push((await vault.read(period('2026-09-10', '2026-09-11', { limit: '1', page: String(page), revision: String(first.revision) }))).events[0].id);
  assert.equal(new Set(pages).size, 3);
  await vault.add(event('2026-09-10', '2026-09-11'));
  await assert.rejects(vault.read(period('2026-09-10', '2026-09-11', { revision: String(first.revision) })), { status: 409 });
  for (const query of ['from=2026-09-10', 'limit=1001', 'page=0', 'from=2020-01-01T00:00:00.000Z&until=2022-01-01T00:00:00.000Z']) await assert.rejects(vault.read(new URLSearchParams(query)), { status: 400 });
});

test('선택 수정은 다른 날짜 손상과 무관하며 이동 목적지·백업·ID 조회를 보존한다', async t => {
  const f = await fixture(t), old = event('2016-01-01', '2016-01-02'), moving = event('2026-09-10', null), other = event('2026-09-10', '2026-09-12');
  await f.vault.mutate(state => { state.events = [old, moving, other]; });
  const oldRef = f.vault.daily.refs().find(ref => ref.day === '2016-01-02');
  await fs.writeFile(path.join(f.directory, oldRef.file), 'damaged fixture');
  const vault = await f.restart();
  await vault.update(moving.id, { ...moving, end: stamp('2026-09-12') });
  assert.equal((await vault.getRecord('events', other.id)).id, other.id);
  assert.equal((await vault.getRecord('events', moving.id)).end, stamp('2026-09-12'));
  assert.ok(vault.daily.refs().some(ref => ref.file === oldRef.file));
  assert.equal(await fs.readFile(path.join(f.directory, oldRef.file), 'utf8'), 'damaged fixture');
  await assert.rejects(vault.getRecord('events', old.id), { status: 503 });
  await vault.remove(moving.id, 2); await assert.rejects(vault.getRecord('events', moving.id), { status: 404 });
  assert.equal((await vault.getRecord('events', other.id)).version, 1);
  const restored = await f.restart(); assert.equal((await restored.getRecord('events', other.id)).id, other.id);
});

test('감사 페이지는 전체 본문 없이 계산하고 실행 생성일과 종료 파일 날짜가 달라도 검색한다', async t => {
  const f = await fixture(t), changes = [], workflowRuns = [];
  for (let day = 1; day <= 20; day++) {
    const at = stamp(`2026-09-${String(day).padStart(2, '0')}`);
    changes.push(...Array.from({ length: 7 }, () => ({ id: randomUUID(), at, action: 'event-created', before: null, after: { title: day % 2 ? '검색' : '다른 기록' } })));
    workflowRuns.push({ id: randomUUID(), workflowId: 'flow', workflowName: '실행', createdAt: at, finishedAt: stamp('2026-10-01'), kind: 'manual', status: day % 2 ? 'success' : 'failure', input: { event: null }, requestKey: `test:${day}` });
  }
  await f.vault.mutate(state => { state.changes = changes; state.workflowRuns = workflowRuns; });
  const vault = await f.restart(), files = track(vault);
  assert.equal(vault.daily.activities().get('flow').last.createdAt, stamp('2026-09-20'));
  const newest = await vault.audit(new URLSearchParams('limit=5'));
  assert.equal(newest.total, changes.length); assert.equal(files.filter(ref => ref.kind === 'audit').length, 6, '최신 파일 한 번과 페이지 5건만 접근');
  for (const query of ['limit=13&page=4', 'search=검색&limit=9&page=3', 'kind=workflows&from=2026-09-05T00:00:00.000Z&until=2026-09-12T00:00:00.000Z', 'kind=workflows&result=success&limit=3&page=2']) {
    const params = new URLSearchParams(query), actual = await vault.audit(params), expected = readAudit({ changes, workflowRuns }, params);
    assert.equal(actual.total, expected.total); assert.deepEqual(actual.items, expected.items);
  }
  assert.equal((await vault.snapshot({ requests: ['test:7'] })).workflowRuns.find(run => run.requestKey === 'test:7').id, workflowRuns[6].id);
});

test('cron은 만료 파일 본문을 복호화하지 않고 삭제·감사 기록과 색인을 정리한다', async t => {
  const f = await fixture(t), old = event('2016-01-01', '2016-01-02'), kept = event('2026-09-10', null);
  await f.vault.mutate(state => { state.events = [old, kept]; state.changes = [{ id: randomUUID(), at: stamp('2016-01-01'), action: 'event-created', before: null, after: null }]; state.logPolicy = { version: 1, cron: '0 3 * * *', eventRetentionDays: 30, auditRetentionDays: 7 }; });
  const vault = await f.restart(), files = track(vault), runner = new LogMaintenance(vault, { autoStart: false, clock: () => '2026-09-10T03:00:00.000Z' });
  await runner.tick(); await runner.close();
  assert.equal(runner.fault, null); assert.equal(vault.state.logMaintenance.lastRun.status, 'success');
  assert.ok(files.every(ref => ref.kind === 'lookup' || ref.day >= '2026-09-10'));
  await assert.rejects(vault.getRecord('events', old.id), { status: 404 });
  assert.equal((await vault.getRecord('events', kept.id)).id, kept.id);
  const audit = await vault.audit(new URLSearchParams(`eventId=${old.id}`)); assert.equal(audit.items[0].action, 'events-expired'); assert.equal(audit.items[0].after.status, 'success');
});

test('이전 날짜 파일은 한 번 순회해 색인을 만들고 다음 저장·재시작부터 본문을 읽지 않는다', async t => {
  const f = await fixture(t), row = event('2026-09-10', '2026-09-11');
  await f.vault.mutate(state => { state.events = [row]; });
  const vault = f.vault, manifest = structuredClone(vault.daily.manifest);
  manifest.dailyStorageVersion = 1; manifest.files = manifest.files.filter(ref => ref.kind !== 'lookup').map(({ summary, hash, ...ref }) => ref);
  const kdf = vault.envelope.kdf, iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', vault.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify({ app: 'service-incident-timeline', version: 1, kdf })));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(manifest), 'utf8'), cipher.final()]);
  const encoded = JSON.stringify({ version: 1, kdf, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, ciphertext: ciphertext.toString('base64') });
  await fs.writeFile(vault.file, encoded);
  const legacy = await f.restart(); assert.equal(legacy.daily.reads, 1); assert.equal(await fs.readFile(legacy.file, 'utf8'), encoded);
  assert.equal((await legacy.getRecord('events', row.id)).id, row.id);
  await legacy.mutate(state => { state.updatedAt = stamp('2026-09-11'); }, { scope: {} });
  assert.equal(legacy.daily.manifest.files.find(ref => ref.kind === 'events').file, manifest.files[0].file);
  const indexed = await f.restart(); assert.equal(indexed.daily.reads, 0); assert.equal((await indexed.getRecord('events', row.id)).id, row.id);
});

test('여러 날짜를 읽어도 복호화 캐시는 16MiB를 넘지 않는다', async t => {
  const f = await fixture(t);
  await f.vault.mutate(state => { state.events = Array.from({ length: 3600 }, (_, i) => event(`2026-09-${10 + i % 3}`, `2026-09-${11 + i % 3}`, { description: 'x'.repeat(4000) })); });
  const vault = await f.restart();
  for (let day = 10; day <= 12; day++) {
    const result = await vault.read(period(`2026-09-${day}`, `2026-09-${day + 1}`, { limit: '1000' }));
    assert.equal(result.total, 1200); assert.equal(result.events.length, 1000); assert.ok(vault.daily.cacheBytes <= 16 * 1024 * 1024);
  }
  assert.ok(vault.daily.cache.size < 3, '오래 읽지 않은 날짜 파일은 캐시에서 제거한다');
});

test('같은 시각의 성공·실패 실행도 목록의 마지막 상태와 마지막 성공을 구분한다', async t => {
  const f = await fixture(t), createdAt = stamp('2026-09-10');
  const runs = ['success', 'failure'].map(status => ({ id: randomUUID(), workflowId: 'flow', workflowName: '예약', createdAt, finishedAt: createdAt, status, kind: 'manual', input: { event: null }, durationMs: 100 }));
  await f.vault.mutate(state => { state.workflows = [{ id: 'flow', name: '예약', secrets: {}, nodes: [] }]; state.workflowRuns = runs; });
  const vault = await f.restart(), workflows = new Workflows(vault), activity = workflows.list().workflows[0].activity;
  assert.equal(activity.status, 'failure'); assert.equal(activity.runId, runs[1].id); assert.equal(activity.lastSuccess, createdAt);
  assert.equal(vault.daily.reads, 0, '목록 통계는 날짜별 요약만 사용한다');
});

test('파일 이동 저장 실패 후 재시도는 원본·목적지·ID 색인과 재시작 결과가 일치한다', async t => {
  const f = await fixture(t), moving = event('2026-09-10', null), other = event('2026-09-10', '2026-09-12');
  await f.vault.mutate(state => { state.events = [moving, other]; });
  const before = await f.vault.snapshot(), root = await fs.readFile(f.vault.file), refs = structuredClone(f.vault.daily.refs()), write = f.vault.write;
  f.vault.write = async () => { throw new Error('simulated manifest failure'); };
  await assert.rejects(f.vault.update(moving.id, { ...moving, end: stamp('2026-09-12') }), /simulated manifest failure/);
  assert.deepEqual(await f.vault.snapshot(), before); assert.deepEqual(f.vault.daily.refs(), refs); assert.deepEqual(await fs.readFile(f.vault.file), root);
  assert.equal((await f.vault.getRecord('events', moving.id)).end, null);
  f.vault.write = write;
  await f.vault.update(moving.id, { ...moving, end: stamp('2026-09-12') });
  const vault = await f.restart(), rows = (await vault.snapshot()).events;
  assert.equal(rows.length, 2); assert.equal(rows.find(row => row.id === other.id).version, 1); assert.equal((await vault.getRecord('events', moving.id)).version, 2);
});

test('같은 날짜의 이벤트 하나 수정은 다른 ID 색인 전체를 읽지 않는다', async t => {
  const f = await fixture(t), rows = Array.from({ length: 600 }, () => event('2026-09-10', '2026-09-11'));
  await f.vault.mutate(state => { state.events = rows; });
  const vault = await f.restart(), files = track(vault);
  await vault.update(rows[0].id, { ...rows[0], title: '수정된 한 건' });
  assert.ok(files.filter(ref => ref.kind === 'lookup').length <= 3, 'ID 위치가 바뀌지 않은 기록의 색인은 읽거나 쓰지 않는다');
  assert.equal((await vault.read(period('2026-09-10', '2026-09-11'))).total, rows.length);
});
