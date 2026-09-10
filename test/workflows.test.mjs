import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { validateDefinition, cronSlot, parseCron, bodyTemplate, template, condition } from '../lib/workflow-definition.mjs';

const node = (id, type, config = {}) => ({ id, type, name: id, x: 36, y: 36, config });
const edge = (from, to, port = 'next') => ({ id: `${from}-${port}-${to}`, from, to, port });
const definition = (type = 'start', url = 'http://127.0.0.1:1') => ({ name: '실제 워크플로우', nodes: [node('trigger', type, type === 'cron' ? { expression: '* * * * *', timezone: 'Asia/Seoul' } : { service: '' }), node('http', 'http', { method: 'POST', url, intent: 'read', headers: '{"Content-Type":"application/json","Authorization":"Bearer {{secrets.ACCESS}}"}', body: '{"title":"{{event.title}}"}', timeoutMs: 1000, retries: 0, onError: 'stop' }), node('condition', 'condition', { field: 'response.status', operator: 'gte', value: '400' }), node('success', 'finish', { result: 'success', message: '작성자가 허용한 응답' }), node('failure', 'finish', { result: 'failure', message: '작성자가 거부한 응답' })], edges: [edge('trigger', 'http'), edge('http', 'condition'), edge('condition', 'success', 'true'), edge('condition', 'failure', 'false')] });
const minimal = (type = 'start') => ({ name: `${type} 일정`, nodes: [node('trigger', type, type === 'cron' ? { expression: '* * * * *', timezone: 'Asia/Seoul' } : { service: '' }), node('finish', 'finish', { result: 'success', message: '' })], edges: [edge('trigger', 'finish')] });

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-workflows-'));
  let at = '2026-09-10T00:00:00.000Z';
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, clock: () => at, ...extra }, logMaintenance: { autoStart: false } };
  const app = await createApp(options);
  await app.vault.setup('workflow-test-password'); await app.workflowEngine.unlock();
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-workflows-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, options, directory, time: value => { at = value; }, async create(def) { const flow = await app.workflows.create({ ...def, requestId: randomUUID() }); await legacySecrets(app, flow.id); return app.workflows.save(flow.id, flow); } };
}
async function legacySecrets(app, id) {
  // Seed a pre-existing record: new secret registration is no longer supported.
  await app.vault.mutate(state => { state.workflows.find(flow => flow.id === id).secrets = { ACCESS: 'private-workflow-value' }; }, { scope: {} });
}
async function settle(app, id) {
  await app.workflowEngine.tick();
  for (let i = 0; i < 200; i++) { const run = await app.workflows.readRun(id); if (['success', 'failure', 'canceled', 'interrupted'].includes(run.status)) return run; await delay(10); }
  throw Error('Run did not finish: ' + JSON.stringify({ run: await app.workflows.readRun(id), engine: app.workflowEngine.status() }));
}
async function seedEvent(app, extra = {}) {
  return (await app.vault.add({ title: '제목 "인용"\n다음 줄', description: '', service: '', services: [], category: 'maintenance', start: '2026-09-10T00:00:10.000Z', end: '2026-09-10T00:00:20.000Z', ...extra })).event;
}

test('실행 그래프 검증, 초안 저장, 안전한 템플릿과 조건', () => {
  assert.equal(validateDefinition({ name: '초안', nodes: [], edges: [] }).nodes.length, 0);
  assert.throws(() => validateDefinition({ name: '초안', nodes: [], edges: [] }, { executable: true }));
  const def = definition(); assert.equal(validateDefinition(def, { executable: true }).nodes.length, 5);
  for (const mutate of [d => d.edges.push(edge('http', 'success')), d => d.edges.push(edge('failure', 'http')), d => d.nodes.push(node('orphan', 'finish', { result: 'success' })), d => d.nodes.push(node('second', 'end')), d => { d.nodes[1].config.url = 'file:///etc/passwd'; }, d => { d.nodes[1].config.onError = 'branch'; }, d => { d.nodes[1].config.headers = '{"Host":"example.com"}'; }]) { const broken = structuredClone(def); mutate(broken); assert.throws(() => validateDefinition(broken, { executable: true })); }
  const ctx = { event: { title: '"a"\nb', id: 'a/b?c' }, response: { status: 500, body: { accepted: true } } };
  assert.deepEqual(JSON.parse(bodyTemplate('{"value":"{{event.title}}"}', ctx)), { value: ctx.event.title });
  assert.equal(template('/{{event.id}}', ctx, true), '/a%2Fb%3Fc');
  assert.throws(() => template('{{event.constructor}}', ctx));
  assert.throws(() => template('{{event.missing}}', ctx));
  assert.equal(condition({ field: 'response.body.accepted', operator: 'equals', value: 'true' }, ctx), true);
  assert.equal(condition({ field: 'response.status', operator: 'gte', value: '400' }, ctx), true);
  assert.equal(condition({ field: 'response.missing', operator: 'exists', value: '' }, ctx), false);
});

test('5필드 cron: 시간대, 범위·간격·요일, DST 중복 슬롯', () => {
  const slot = (expression, instant, timezone = 'Asia/Seoul') => cronSlot({ expression, timezone }, instant);
  assert.equal(slot('*/15 9-18 * * 1-5', '2026-09-10T00:15:00Z'), '2026-09-10T09:15');
  assert.equal(slot('*/15 9-18 * * 1-5', '2026-09-10T00:16:00Z'), null);
  assert.equal(slot('0 0 10 * 1', '2026-09-10T00:00:00Z', 'UTC'), '2026-09-10T00:00');
  assert.equal(slot('0 0 * * 7', '2026-09-13T00:00:00Z', 'UTC'), '2026-09-13T00:00');
  assert.equal(slot('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'), slot('30 1 * * *', '2026-11-01T06:30:00Z', 'America/New_York'));
  for (const value of ['* * * *', '60 * * * *', '*/0 * * * *', '* * * * MON', '* * 32 * *']) assert.throws(() => parseCron(value));
});

test('실제 HTTP, 작성자 조건 판정, 비밀 가림, 중복 방지와 같은 정의·입력 재실행', async t => {
  const calls = [];
  const remote = http.createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; calls.push({ body: JSON.parse(body), authorization: req.headers.authorization }); res.writeHead(500, { 'Content-Type': 'application/json', 'Set-Cookie': 'private-cookie' }); res.end(JSON.stringify({ echo: req.headers.authorization, accepted: true })); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => remote.close(resolve)));
  const { app } = await fixture(t);
  const event = await seedEvent(app), flow = await (async () => { const value = await app.workflows.create({ ...definition('start', `http://127.0.0.1:${remote.address().port}`), requestId: randomUUID() }); await legacySecrets(app, value.id); return app.workflows.save(value.id, value); })();
  assert.equal(flow.enabled, false); assert.equal('secrets' in flow, false);
  await assert.rejects(app.workflows.run(flow.id, { requestId: randomUUID(), version: flow.version }), /이벤트/);
  const input = { eventId: event.id, requestId: randomUUID(), version: flow.version };
  const queued = await app.workflows.run(flow.id, input), result = await settle(app, queued.id);
  assert.equal(result.status, 'success', 'HTTP 500을 작성자가 성공으로 처리');
  assert.equal(calls.length, 1); assert.equal(calls[0].body.title, event.title);
  assert.equal(calls[0].authorization, 'Bearer private-workflow-value');
  assert.equal(result.steps.find(step => step.type === 'http').output.status, 500);
  for (const value of ['private-workflow-value', 'private-cookie']) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal((await app.workflows.run(flow.id, input)).id, queued.id);
  await assert.rejects(app.workflows.save(flow.id, { ...flow, secrets: { ACCESS: 'rotated-private-value' } }), /추가·수정/);
  const saved = await app.workflows.save(flow.id, { ...flow, name: '바뀐 정의', nodes: minimal().nodes, edges: minimal().edges });
  const rerun = await app.workflows.rerun(result.id, { requestId: randomUUID() }), repeated = await settle(app, rerun.id);
  assert.equal(repeated.status, 'success'); assert.equal(repeated.definitionVersion, flow.definitionVersion); assert.equal(repeated.parentId, result.id);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, calls[1].body); assert.equal(calls[1].authorization, 'Bearer private-workflow-value');
  assert.equal(JSON.stringify((await app.workflows.readRun(result.id))), JSON.stringify(result));
  assert.equal((await app.workflows.read(flow.id)).activity.runId, rerun.id);
  const encrypted = await fs.readFile(app.vault.file, 'utf8'); assert.equal(encrypted.includes('private'), false);
  await app.workflows.remove(flow.id, { version: saved.version });
  assert.equal((await app.workflows.readRun(result.id)).canRerun, false); assert.equal(app.workflows.list().workflows.length, 0);
});

test('입력한 시작·종료 시각 실행, 지난 등록·수정·활성화와 OFF 구간 소급 없음', async t => {
  const { app, time, create } = await fixture(t);
  const event = await seedEvent(app);
  await app.vault.mutate(state => { Object.assign(state.events[0], { createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }); });
  const flows = [];
  for (const type of ['start', 'end', 'cron']) { const flow = await create(minimal(type)); flows.push(await app.workflows.enable(flow.id, { version: flow.version, enabled: true })); }
  time('2026-09-10T00:00:09.000Z'); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 0);
  time(event.start); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 1);
  await settle(app, (await app.vault.snapshot()).workflowRuns[0].id); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 1);
  time(event.end); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 2);
  time('2026-09-10T00:01:00.000Z'); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 3);
  const start = flows[0]; time('2026-09-10T00:01:01.000Z');
  await app.vault.mutate(state => { const copy = { ...state.events[0], id: randomUUID(), start: '2026-09-10T00:00:50.000Z', end: null, createdAt: '2026-09-10T00:01:01.000Z', updatedAt: '2026-09-10T00:01:01.000Z' }; state.events.push(copy); });
  await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 3);
  const off = await app.workflows.enable(start.id, { version: start.version, enabled: false });
  await app.vault.mutate(state => { Object.assign(state.events[0], { start: '2026-09-10T00:01:10.000Z', end: null, updatedAt: '2026-09-10T00:01:01.000Z' }); });
  time('2026-09-10T00:01:11.000Z'); await app.workflowEngine.tick();
  await app.workflows.enable(off.id, { version: off.version, enabled: true });
  time('2026-09-10T00:01:12.000Z'); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 3);
  time('2026-09-10T00:10:00.000Z'); await app.workflowEngine.tick(); assert.equal((await app.vault.snapshot()).workflowRuns.length, 4, '긴 중단 구간은 현재 분만 확인');
});

test('네트워크 오류: 명시적 재시도와 오류 분기, 호출 전 기록 및 저장 실패 후 호출 중지', async t => {
  let calls = 0, app;
  const setup = await fixture(t, { fetch: async () => { calls++; assert.equal((await app.vault.snapshot()).workflowRuns.at(-1).steps.at(-1).attempts.at(-1).status, undefined, '요청 시도 기록이 먼저 저장됨'); throw new TypeError('network down'); } }); app = setup.app;
  const event = await seedEvent(app), def = definition(); def.nodes[1].config.retries = 1; def.nodes[1].config.onError = 'branch'; def.edges.push(edge('http', 'failure', 'error'));
  const flow = await setup.create(def), run = await app.workflows.run(flow.id, { eventId: event.id, version: flow.version, requestId: randomUUID() });
  const result = await settle(app, run.id); assert.equal(calls, 2); assert.equal(result.status, 'failure'); assert.equal(result.steps[1].status, 'handled-error'); assert.equal(result.steps.at(-1).nodeId, 'failure');
  const retryDefinition = definition(); retryDefinition.nodes[1].config.retries = 3;
  const updated = await app.workflows.save(flow.id, { ...flow, ...retryDefinition });
  const next = await app.workflows.run(flow.id, { eventId: event.id, version: updated.version, requestId: randomUUID() });
  const write = app.vault.write;
  app.workflowEngine.fetch = async () => { calls++; app.vault.write = async () => { throw Error('disk failure'); }; return new Response('{}', { status: 200 }); };
  await app.workflowEngine.tick(); await Promise.all([...app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.equal(calls, 3); assert.ok(app.workflowEngine.fault); assert.equal((await app.vault.snapshot()).workflowRuns.find(run => run.id === next.id).status, 'running');
  app.vault.write = write;
});

test('취소·응답 제한·timeout, 서버 재시작 시 중단 기록과 자동 재개 금지', async t => {
  const { app, create, options } = await fixture(t, { fetch: async (_url, { signal }) => { await delay(5000, null, { signal }); return new Response('{}'); } });
  const event = await seedEvent(app), def = definition(); def.nodes[1].config.timeoutMs = 100;
  const flow = await create(def), runInput = () => ({ eventId: event.id, version: flow.version, requestId: randomUUID() });
  const timed = await settle(app, (await app.workflows.run(flow.id, runInput())).id); assert.equal(timed.status, 'failure');
  app.workflowEngine.fetch = async () => new Response('x'.repeat(131073));
  const large = await settle(app, (await app.workflows.run(flow.id, runInput())).id); assert.equal(large.status, 'failure'); assert.match(large.message, /128KB/);
  app.workflowEngine.fetch = async (_url, { signal }) => { await delay(5000, null, { signal }); return new Response('{}'); };
  const canceled = await app.workflows.run(flow.id, runInput()); await app.workflowEngine.tick(); await delay(20); await app.workflows.cancel(canceled.id); app.workflowEngine.stop(canceled.id);
  assert.equal((await settle(app, canceled.id)).status, 'canceled');
  const pending = await app.workflows.run(flow.id, runInput());
  await app.close();
  let calls = 0; const resumed = await createApp({ ...options, workflows: { autoStart: false, fetch: async () => { calls++; return new Response('{}'); } } });
  try { await resumed.vault.unlock('workflow-test-password'); await resumed.workflowEngine.unlock(); await resumed.workflowEngine.tick(); assert.equal(calls, 0); assert.equal((await resumed.workflows.readRun(pending.id)).status, 'interrupted'); assert.equal(resumed.workflows.read(flow.id).name, flow.name); }
  finally { await resumed.close(); }
});

test('워크플로우 API: 인증·CSRF·버전 충돌·실행 및 감사 로그', async t => {
  const { app } = await fixture(t);
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`; let cookie = '';
  const call = async (url, method = 'GET', body, origin = base) => { const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return { status: response.status, data: await response.json() }; };
  assert.equal((await call('/api/workflows')).status, 401);
  assert.equal((await call('/api/login', 'POST', { password: 'workflow-test-password' })).status, 200);
  const draft = (await call('/api/workflows', 'POST', { name: '초안', requestId: randomUUID() })).data;
  assert.equal(draft.enabled, false);
  assert.equal((await call(`/api/workflows/${draft.id}/enabled`, 'PUT', { enabled: true, version: draft.version })).status, 400);
  const flow = (await call(`/api/workflows/${draft.id}`, 'PUT', { ...minimal('cron'), version: draft.version })).data;
  assert.equal((await call(`/api/workflows/${draft.id}`, 'PUT', { ...flow, version: draft.version })).status, 409);
  assert.equal((await call(`/api/workflows/${draft.id}`, 'DELETE', { version: flow.version }, 'https://example.invalid')).status, 403);
  const queued = await call(`/api/workflows/${flow.id}/run`, 'POST', { version: flow.version, requestId: randomUUID() }); assert.equal(queued.status, 202);
  await settle(app, queued.data.id);
  const history = (await call('/api/audit?kind=workflows&workflowId=' + flow.id)).data; assert.equal(history.total, 1); assert.equal(history.items[0].status, 'success');
  assert.equal((await call('/api/workflow-runs/' + queued.data.id)).data.definitionVersion, flow.definitionVersion);
});

test('통신 오류 계속 진행과 동시 실행 제한: 전체 2개, 같은 흐름 1개', async t => {
  let active = 0, maximum = 0;
  const { app, create } = await fixture(t, { fetch: async () => { active++; maximum = Math.max(maximum, active); await delay(80); active--; throw Error('offline'); } });
  const event = await seedEvent(app), def = definition();
  def.nodes[1].config.onError = 'continue'; def.nodes[2].config = { field: 'response.error', operator: 'exists', value: '' };
  const a = await create(def), b = await create(def), c = await create(def), runs = [];
  for (const flow of [a, a, b, c]) runs.push(await app.workflows.run(flow.id, { eventId: event.id, version: flow.version, requestId: randomUUID() }));
  await app.workflowEngine.tick(); assert.equal(app.workflowEngine.jobs.size, 2); assert.equal(new Set([...app.workflowEngine.jobs.values()].map(job => job.workflowId)).size, 2);
  for (const run of runs) assert.equal((await settle(app, run.id)).status, 'success');
  assert.equal(maximum, 2);
});

test('실제 타이머가 미래 일정만 실행하고 늦게 입력한 일정은 생략한다', async t => {
  const { app, create } = await fixture(t, { autoStart: true, intervalMs: 20, clock: () => new Date().toISOString() });
  const flow = await create(minimal()); await app.workflows.enable(flow.id, { version: flow.version, enabled: true });
  const event = await seedEvent(app, { start: new Date(Date.now() + 200).toISOString(), end: null });
  await delay(400);
  assert.equal((await app.vault.snapshot()).workflowRuns.length, 1); assert.equal((await app.vault.snapshot()).workflowRuns[0].input.event.id, event.id);
  await seedEvent(app, { start: new Date(Date.now() - 10).toISOString(), end: null });
  await delay(80); assert.equal((await app.vault.snapshot()).workflowRuns.length, 1);
});
