import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { validateEvent } from '../lib/vault.mjs';
import { dryRunWorkflow } from '../lib/workflow-dry-run.mjs';
import { eventDryRunValues } from '../public/workflow-dry-run-spec.js';

const input = { title: '협력사 점검', description: '운영 메모', category: 'maintenance', services: [], start: '2026-09-09T01:00:00.000Z', end: '2026-09-09T02:00:00.000Z' };
const html = '  <!doctype html>\r\n<table><tr><td>협력사 &amp; 점검</td></tr></table>\r\n<script>untrusted()</script>  ';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-event-content-'));
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } };
  let app = await createApp(options);
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`, password = 'event-content-test-password';
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-event-content-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { get app() { return app; }, async request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }, async restart() { await app.close(); app = await createApp(options); await app.vault.unlock(password); } };
}

test('메모와 본문은 독립적이며 원문·빈 값·형식·UTF-8 용량을 검증한다', () => {
  const legacy = validateEvent(input);
  assert.equal(legacy.description, '운영 메모');
  assert.equal(legacy.body, '');
  assert.equal(legacy.bodyFormat, 'text');
  for (const bodyFormat of ['text', 'html']) {
    const result = validateEvent({ ...input, body: html, bodyFormat });
    assert.equal(result.body, html);
    assert.equal(result.description, '운영 메모');
    assert.equal(result.bodyFormat, bodyFormat);
  }
  for (const extra of [{ body: null }, { body: 1 }, { body: {} }, { bodyFormat: null }, { bodyFormat: '' }, { bodyFormat: 'HTML' }]) assert.throws(() => validateEvent({ ...input, ...extra }), { status: 400 });
  const limit = '한'.repeat(43690) + 'ab';
  assert.equal(Buffer.byteLength(limit), 131072);
  assert.equal(validateEvent({ ...input, body: limit }).body, limit);
  assert.throws(() => validateEvent({ ...input, body: limit + 'a' }), { status: 400 });
});

test('기존 파일은 읽을 때 변경하지 않고 수정한 이벤트에만 빈 본문을 기록한다', async t => {
  const f = await fixture(t), original = (await f.app.vault.add(input)).event, sibling = (await f.app.vault.add(input)).event;
  await f.app.vault.mutate(state => { for (const event of state.events) { delete event.body; delete event.bodyFormat; } });
  const refs = f.app.vault.daily.refs().filter(ref => ref.kind === 'events');
  const bytes = await Promise.all(refs.map(ref => fs.readFile(path.join(f.app.vault.directory, ref.file))));
  const revision = f.app.vault.state.revision;
  const result = await f.request('/api/events');
  assert.equal(result.status, 200);
  assert.ok(result.data.events.every(event => event.body === '' && event.bodyFormat === 'text' && event.description === '운영 메모'));
  const detail = await f.request(`/api/events/${original.id}`);
  assert.equal(detail.data.event.body, '');
  assert.equal((await f.app.vault.snapshot()).events[0].bodyFormat, 'text');
  assert.equal(f.app.vault.state.revision, revision);
  for (const [index, ref] of refs.entries()) assert.deepEqual(await fs.readFile(path.join(f.app.vault.directory, ref.file)), bytes[index]);
  const saved = await f.request(`/api/events/${original.id}`, 'PUT', { ...input, version: 1, description: '메모 수정' });
  assert.equal(saved.status, 200);
  const raw = (await f.app.vault.daily.readBucket(f.app.vault.daily.refs().find(ref => ref.kind === 'events'))).events;
  assert.equal(raw.find(event => event.id === original.id).body, '');
  assert.equal(raw.find(event => event.id === original.id).bodyFormat, 'text');
  assert.equal(Object.hasOwn(raw.find(event => event.id === sibling.id), 'body'), false);
  await f.restart();
  assert.equal((await f.app.vault.getRecord('events', sibling.id)).body, '');
  assert.equal((await f.app.vault.getRecord('events', original.id)).description, '메모 수정');
});

test('API는 HTML 원문을 저장하며 구버전 수정 요청·감사 기록·재시작에서도 보존한다', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/events', 'POST', { ...input, body: html, bodyFormat: 'html' });
  assert.equal(created.status, 201);
  const source = created.data.event;
  assert.equal(source.body, html);
  const edited = await f.request(`/api/events/${source.id}`, 'PUT', { ...input, version: 1, description: '구버전 메모 수정' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.event.body, html);
  assert.equal(edited.data.event.bodyFormat, 'html');
  const audit = await f.app.vault.audit(new URLSearchParams({ eventId: source.id }));
  const change = audit.items.find(row => row.action === 'event-updated');
  assert.equal(change.before.body, html);
  assert.equal(change.after.body, html);
  for (const body of [null, 'a'.repeat(131073)]) assert.equal((await f.request(`/api/events/${source.id}`, 'PUT', { ...input, version: 2, body })).status, 400);
  assert.equal((await f.app.vault.getRecord('events', source.id)).version, 2);
  const escaped = '\u0000'.repeat(131072);
  assert.equal((await f.request('/api/events', 'POST', { ...input, body: escaped })).status, 201, 'JSON escaping does not reduce the permitted body size');
  await f.restart();
  assert.equal((await f.app.vault.getRecord('events', source.id)).body, html);
  const cleared = (await f.app.vault.update(source.id, { ...input, version: 2, body: '', bodyFormat: 'text' })).event;
  assert.equal(cleared.body, '');
  assert.equal(cleared.bodyFormat, 'text');
});

test('기존 이벤트와 실행 입력의 본문은 실제 실행·재실행·Dry-Run에서 빈 Text로 평가된다', async t => {
  const f = await fixture(t), event = (await f.app.vault.add(input)).event;
  await f.app.vault.mutate(state => { delete state.events[0].body; delete state.events[0].bodyFormat; });
  const definition = { name: '본문 호환', nodes: [
    { id: 'start', type: 'start', name: '시작', x: 36, y: 36, config: {} },
    { id: 'end', type: 'finish', name: '완료', x: 36, y: 234, config: { result: 'success', message: '{{event.bodyFormat}}|{{event.body}}|{{event.description}}' } }
  ], edges: [{ id: 'next', from: 'start', to: 'end', port: 'next' }] };
  const flow = await f.app.workflows.create({ ...definition, requestId: randomUUID() });
  const run = await f.app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID(), eventId: event.id });
  assert.equal(run.input.event.body, '');
  await f.app.vault.mutate(state => { const saved = state.workflowRuns.find(row => row.id === run.id); delete saved.input.event.body; delete saved.input.event.bodyFormat; });
  await f.app.workflowEngine.execute(run.id, new AbortController());
  const completed = await f.app.workflows.readRun(run.id);
  assert.equal(completed.status, 'success');
  assert.equal(completed.message, 'text||운영 메모');
  const rerun = await f.app.workflows.rerun(run.id, { requestId: randomUUID() });
  assert.equal(rerun.input.event.bodyFormat, 'text');
  const setup = { now: input.start, nodes: { start: { type: 'start', event: JSON.stringify(input), trigger: JSON.stringify({ scheduledAt: input.start }) } } };
  assert.equal(dryRunWorkflow(definition, setup).message, 'text||운영 메모');
  assert.equal(JSON.parse(eventDryRunValues(definition.nodes[0], input).values.event).body, '');
  setup.nodes.start.event = JSON.stringify({ ...input, body: '<p>본문</p>', bodyFormat: 'html' });
  assert.equal(dryRunWorkflow(definition, setup).message, 'html|<p>본문</p>|운영 메모');
});
