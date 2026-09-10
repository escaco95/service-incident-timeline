import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { dryRunWorkflow, validateDryRunSetup } from '../lib/workflow-dry-run.mjs';
import { mergeDryRunSetup, eventDryRunValues } from '../public/workflow-dry-run-spec.js';
import { validateSettings, exportedSettings } from '../lib/archive-data.mjs';
import { exportWorkflow } from '../lib/workflow-file.mjs';

const at = '2026-09-10T00:00:00.000Z';
const node = (id, type, config = {}) => ({ id, type, name: id, x: 36, y: 36, config });
const edge = (from, to, port = 'next') => ({ id: `${from}-${port}-${to}`, from, to, port });
const definition = (type = 'start') => ({ name: 'Dry-Run fixture', nodes: [
  node('trigger', type, type === 'cron' ? { expression: '* * * * *', timezone: 'UTC' } : { service: '' }),
  node('values', 'context', { entries: [{ key: 'region', value: 'seoul' }, { key: 'token', value: 'dry-private-token' }] }),
  node('http', 'http', { method: 'POST', intent: 'read', url: 'http://127.0.0.1:1/{{context.region}}', headers: '{"Authorization":"Bearer {{context.token}}"}', body: '{"title":"{{event.title}}"}', onError: 'branch' }),
  node('find', 'find', { source: 'response.body.items', field: 'region', value: 'context.region', valueSource: 'path' }),
  node('clock', 'datetime', { source: 'now', timezone: 'Asia/Seoul', format: 'local' }),
  node('ok', 'finish', { result: 'success', message: '{{nodes.clock.value}}' }),
  node('fail', 'finish', { result: 'failure', message: 'not found' })
], edges: [edge('trigger', 'values'), edge('values', 'http'), edge('http', 'find'), edge('http', 'fail', 'error'), edge('find', 'clock', 'one'), edge('find', 'fail', 'zero'), edge('find', 'fail', 'many'), edge('clock', 'ok')] });
const setup = def => { const value = mergeDryRunSetup(def, {}, at); value.nodes.http.body = '{"items":[{"region":"seoul","id":1}]}'; return value; };

test('registered schedules reproduce start and end inputs while keeping an editable snapshot', () => {
  const event = { id: randomUUID(), title: '등록 일정', description: '점검', category: 'maintenance', service: 'payments', services: [{ kind: 'custom', label: 'payments' }], start: at, end: '2026-09-10T03:00:00.000Z' };
  for (const type of ['start', 'end']) {
    const def = definition(type), values = setup(def), selected = eventDryRunValues(def.nodes[0], event);
    values.now = selected.now; values.nodes.trigger = selected.values;
    const result = dryRunWorkflow(def, values);
    assert.deepEqual(result.context.event, event);
    assert.equal(result.context.trigger.type, type);
    assert.equal(result.context.trigger.scheduledAt, event[type]);
    assert.equal(result.context.run.startedAt, event[type]);
    assert.deepEqual(mergeDryRunSetup(def, validateDryRunSetup(values)).nodes.trigger, selected.values);
    values.nodes.trigger.event = JSON.stringify({ ...event, title: '직접 수정' });
    assert.equal(dryRunWorkflow(def, values).context.event.title, '직접 수정');
    assert.equal(event.title, '등록 일정');
  }
  assert.throws(() => eventDryRunValues(node('n', 'end'), { ...event, end: null }), /종료 시각/);
  assert.throws(() => eventDryRunValues(node('n', 'cron'), event), /시작·종료/);
});

async function fixture(t, send = async () => { throw Error('Unexpected real HTTP'); }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-dry-run-'));
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, fetch: send, clock: () => at }, logMaintenance: { autoStart: false } };
  const app = await createApp(options); await app.vault.setup('workflow-dry-run-password'); await app.workflowEngine.unlock();
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-dry-run-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, options, directory };
}

test('Dry-Run evaluates event, context, HTTP, search, time and branches without a network capability', () => {
  const def = definition(), values = setup(def);
  values.nodes.trigger.event = JSON.stringify({ title: 'test "quoted"\n한글' });
  const result = dryRunWorkflow(def, values);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.steps.map(step => step.nodeId), ['trigger', 'values', 'http', 'find', 'clock', 'ok']);
  assert.equal(result.message, '2026-09-10T09:00:00+09:00');
  assert.equal(result.steps[2].request.body, JSON.stringify({ title: 'test "quoted"\n한글' }));
  assert.equal(result.steps[2].request.url, 'http://127.0.0.1:1/seoul');
  assert.deepEqual(result.skipped, [{ nodeId: 'fail', name: 'fail' }]);
  assert.equal(JSON.stringify(result).includes('dry-private-token'), false);
  assert.equal(result.context.context.region, 'seoul');
  values.nodes.http.body = '{"items":[]}';
  const missing = dryRunWorkflow(def, values);
  assert.equal(missing.status, 'failure'); assert.equal(missing.steps.at(-1).nodeId, 'fail');
  values.nodes.http.body = '{"items":[{"region":"seoul"},{"region":"seoul"}]}';
  assert.equal(dryRunWorkflow(def, values).steps.find(step => step.nodeId === 'find').port, 'many');
});

test('HTTP status uses author conditions; errors honor stop, continue, branch and change review', () => {
  const def = definition(), values = setup(def);
  def.nodes[3] = node('find', 'condition', { field: 'response.status', operator: 'gte', value: '400' });
  def.edges = def.edges.filter(e => e.from !== 'find').concat(edge('find', 'clock', 'true'), edge('find', 'fail', 'false'));
  values.nodes.http.status = '500';
  assert.equal(dryRunWorkflow(def, values).status, 'success', 'HTTP 500 is not implicitly a workflow failure');
  values.nodes.http.outcome = 'error';
  def.nodes[2].config.retries = 2;
  const branch = dryRunWorkflow(def, values);
  assert.equal(branch.steps[2].port, 'error'); assert.equal(branch.steps[2].attempts, 3); assert.equal(branch.steps[2].status, 'handled-error');
  def.nodes[2].config.onError = 'stop'; def.edges = def.edges.filter(e => e.port !== 'error');
  const stop = dryRunWorkflow(def, values); assert.equal(stop.steps.at(-1).nodeId, 'http'); assert.equal(stop.status, 'failure');
  def.nodes[2].config.onError = 'continue';
  def.nodes[3].config = { field: 'response.error.message', operator: 'exists', value: '' };
  assert.equal(dryRunWorkflow(def, values).status, 'success');
  def.nodes[2].config.intent = 'change'; def.nodes[2].config.retries = 0;
  assert.equal(dryRunWorkflow(def, values).status, 'review');
});

test('all trigger types accept independent initial values and invalid fixtures identify the node', () => {
  for (const type of ['start', 'end', 'cron', 'service-state']) {
    const def = definition(type), values = setup(def);
    if (['cron', 'service-state'].includes(type)) def.nodes[2].config.body = '{"type":"{{trigger.type}}"}';
    const result = dryRunWorkflow(def, values);
    assert.equal(result.status, 'success'); assert.equal(result.context.trigger.type, type);
    if (type === 'service-state') assert.equal(result.context.trigger.severity, 'warning');
    if (['cron', 'service-state'].includes(type)) assert.equal(result.context.event, null);
  }
  const def = definition(), values = setup(def);
  values.nodes.http.body = '{unfinished';
  assert.doesNotThrow(() => validateDryRunSetup(values));
  const invalid = dryRunWorkflow(def, values);
  assert.equal(invalid.status, 'failure'); assert.equal(invalid.steps.at(-1).nodeId, 'http'); assert.match(invalid.message, /JSON/);
  values.now = 'invalid'; assert.throws(() => dryRunWorkflow(def, values), /기준 시각/);
  assert.throws(() => validateDryRunSetup({ now: at, nodes: { x: { type: 'http', body: 'x'.repeat(131073) } } }));
  const renamed = structuredClone(def); renamed.nodes[2].name = 'renamed';
  assert.equal(mergeDryRunSetup(renamed, setup(def)).nodes.http.body, setup(def).nodes.http.body);
  renamed.nodes = renamed.nodes.filter(node => node.id !== 'http');
  assert.equal(mergeDryRunSetup(renamed, setup(def)).nodes.http, undefined);
});

test('Dry-Run matches real node calculations while leaving audit, runs, service state and versions unchanged', async t => {
  let calls = 0;
  const { app } = await fixture(t, async () => { calls++; return new Response('{"items":[{"region":"seoul","id":1}]}'); });
  const def = definition(), values = setup(def);
  let flow = await app.workflows.create({ ...def, requestId: randomUUID() });
  const event = (await app.vault.add({ title: 'test', description: '', category: 'maintenance', services: [], start: at, end: null })).event;
  values.nodes.trigger.event = JSON.stringify(event);
  values.nodes.http.headers = '{"content-type":"text/plain;charset=UTF-8"}';
  const before = await app.vault.snapshot();
  const saved = await app.workflows.saveDryRunSetup(flow.id, { version: 0, setup: values });
  const result = app.workflows.dryRun(flow.id, { definition: def, setup: values });
  const after = await app.vault.snapshot();
  assert.deepEqual(after.changes, before.changes); assert.deepEqual(after.workflowRuns, before.workflowRuns); assert.deepEqual(after.serviceState, before.serviceState);
  assert.equal(calls, 0); assert.deepEqual(app.workflows.read(flow.id), flow);
  assert.equal(Object.hasOwn(exportWorkflow(app.workflows.read(flow.id)), 'dryRunSetup'), false);
  assert.equal(JSON.stringify(app.workflows.list()).includes('Dry-Run 테스트 이벤트'), false);
  assert.equal(saved.version, 1);
  await assert.rejects(app.workflows.saveDryRunSetup(flow.id, { version: 0, setup: values }), /다른 화면/);
  const queued = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID(), eventId: event.id });
  let real;
  for (let i = 0; i < 300; i++) { await app.workflowEngine.tick(); real = await app.workflows.readRun(queued.id); if (real.status === 'success') break; await delay(10); }
  assert.equal(real.status, result.status);
  assert.deepEqual(real.steps.map(step => [step.nodeId, step.port, step.output]), result.steps.map(step => [step.nodeId, step.port, step.type === 'find' ? { count: step.output.count } : step.output]));
  assert.equal(calls, 1);
  flow = await app.workflows.save(flow.id, { ...flow, name: 'new name' });
  assert.deepEqual(app.workflows.readDryRunSetup(flow.id).setup, values);
  const currentState = await app.vault.snapshot();
  assert.deepEqual(validateSettings(exportedSettings(currentState, { name: 'Test', subtitle: '', showSubtitle: false, defaultTheme: 'light', timezone: 'UTC', passwordNotice: '' })).metadata.workflows[0].dryRunSetup.setup, values);
});

test('authenticated API tests unsaved definitions, persists setups and produces no audit records', async t => {
  const { app, options } = await fixture(t);
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`; let cookie = '';
  const call = async (url, method = 'GET', body, origin = base) => {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  const flow = await app.workflows.create({ name: 'empty saved draft', requestId: randomUUID() }), url = '/api/workflows/' + flow.id;
  assert.equal((await call(url + '/dry-run-setup')).status, 401);
  assert.equal((await call(url + '/dry-run', 'POST', {})).status, 401);
  await call('/api/login', 'POST', { password: 'workflow-dry-run-password' });
  const def = definition(), values = setup(def), before = await app.vault.snapshot();
  assert.equal((await call(url + '/dry-run-setup', 'PUT', { version: 0, setup: values }, 'https://other.invalid')).status, 403);
  const saved = await call(url + '/dry-run-setup', 'PUT', { version: 0, setup: values }); assert.equal(saved.status, 200);
  const result = await call(url + '/dry-run', 'POST', { definition: def, setup: values }); assert.equal(result.status, 200); assert.equal(result.data.status, 'success');
  assert.equal(app.workflows.read(flow.id).nodes.length, 0);
  assert.deepEqual((await app.vault.snapshot()).changes, before.changes); assert.deepEqual((await app.vault.snapshot()).workflowRuns, before.workflowRuns);
  assert.deepEqual((await call(url + '/dry-run-setup')).data, saved.data);
  await app.close();
  const reopened = await createApp(options);
  try { await reopened.vault.unlock('workflow-dry-run-password'); assert.deepEqual(reopened.workflows.readDryRunSetup(flow.id), saved.data); }
  finally { await reopened.close(); }
});
