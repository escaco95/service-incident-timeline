import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { serviceEventDryRun } from '../lib/workflow-dry-run-service.mjs';
import { effectiveServices, reconcileServices } from '../lib/service-state.mjs';
import { dryRunWorkflow, validateDryRunSetup } from '../lib/workflow-dry-run.mjs';
import { mergeDryRunSetup } from '../public/workflow-dry-run-spec.js';

const at = hour => `2026-09-10T${hour}:00:00.000Z`;
const event = (title, start, end, category = 'maintenance', services = ['payments']) => ({ id: randomUUID(), version: 1, title, description: '', start, end, category, services: services.map(label => ({ kind: 'custom', label })) });
const node = (id, type, config) => ({ id, type, name: id, x: 36, y: 36, config });
const definition = () => ({ name: 'Service dry-run', nodes: [node('trigger', 'service-state', { service: '' }), node('done', 'finish', { result: 'success', message: '{{trigger.service}}:{{trigger.previous}}->{{trigger.severity}}' })], edges: [{ id: 'edge', from: 'trigger', to: 'done', port: 'next' }] });

test('service schedule fixtures match real aggregation for overlap, simultaneous boundaries and multiple services', () => {
  const maintenance = event('maintenance', at('00'), at('03'));
  const incident = event('incident', at('01'), at('02'), 'incident', ['payments', 'login']);
  const covered = event('covered', at('01'), at('02'));
  const replacement = event('replacement', at('03'), at('04'));
  const events = [maintenance, incident, covered, replacement];
  for (const [selected, occurrence, service, previous, severity] of [[maintenance, 'start', 'payments', '', 'warning'], [incident, 'start', 'payments', 'warning', 'incident'], [incident, 'end', 'payments', 'incident', 'warning'], [replacement, 'start', 'payments', 'warning', 'warning'], [maintenance, 'end', 'payments', 'warning', 'warning'], [replacement, 'end', 'payments', 'warning', ''], [incident, 'start', 'login', '', 'incident'], [incident, 'end', 'login', 'incident', '']]) {
    const now = selected[occurrence], before = effectiveServices(events, new Date(Date.parse(now) - 1).toISOString());
    const state = { events, changes: [], workflows: [{ ...definition(), id: randomUUID(), enabled: true }], serviceState: { version: 1, services: [...new Set(['payments', 'login', ...before.keys()])].map(service => ({ service, severity: before.get(service)?.severity ?? '', events: before.get(service)?.events ?? [], generation: 7, hold: null })) } };
    const original = structuredClone(state), selectedValues = serviceEventDryRun(state, selected, occurrence, service), trigger = JSON.parse(selectedValues.values.trigger);
    assert.deepEqual(state, original, 'the simulator must be pure');
    assert.equal(trigger.previous, previous); assert.equal(trigger.severity, severity);
    assert.equal(trigger.generation, previous === severity ? 7 : 8);
    assert.deepEqual(trigger.events, effectiveServices(events, now).get(service)?.events ?? []);
    const enqueued = [];
    reconcileServices(state, now, (_state, _flow, input) => enqueued.push(input));
    if (previous !== severity) assert.deepEqual(enqueued.find(input => input.trigger.service === service), { event: null, trigger });
    else assert.equal(enqueued.some(input => input.trigger.service === service), false);
    const def = definition(), setup = mergeDryRunSetup(def, {}, now); setup.nodes.trigger = selectedValues.values;
    const result = dryRunWorkflow(def, validateDryRunSetup(setup));
    assert.equal(result.context.event, null);
    assert.equal(result.status, previous === severity ? 'skipped' : 'success');
    if (previous === severity) { assert.deepEqual(result.followedEdges, []); assert.deepEqual(result.skipped, [{ nodeId: 'done', name: 'done' }]); }
  }
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-service-dry-run-'));
  let calls = 0;
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, clock: () => at('00'), fetch: async () => { calls++; throw Error('Unexpected network'); } }, logMaintenance: { autoStart: false } };
  const app = await createApp(options); await app.vault.setup('service-dry-run-password'); await app.workflowEngine.unlock();
  t.after(async () => { await app.close(); assert.equal(calls, 0); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-service-dry-run-')); await fs.rm(directory, { recursive: true, force: true }); });
  const flow = await app.workflows.create({ ...definition(), requestId: randomUUID() });
  const add = async value => (await app.vault.add(value)).event;
  return { app, flow, add, options };
}

test('service schedule API reads scoped records, persists snapshots and creates no audit, runs or service updates', async t => {
  const { app, flow, add, options } = await fixture(t);
  const long = await add(event('long maintenance', '2026-08-10T00:00:00.000Z', at('04')));
  const selected = await add(event('scheduled incident', at('01'), at('02'), 'incident', ['payments', 'login']));
  await add(event('unrelated', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'));
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`, url = `/api/workflows/${flow.id}/dry-run-service-event`;
  let cookie = '';
  const call = async (url, body, origin = base) => {
    const response = await fetch(base + url, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  const input = { eventId: selected.id, occurrence: 'end', service: 'payments' };
  assert.equal((await call(url, input)).status, 401);
  await call('/api/login', { password: 'service-dry-run-password' });
  assert.equal((await call(url, input, 'https://other.invalid')).status, 403);
  const before = await app.vault.snapshot(), scopes = [], originalSnapshot = app.vault.snapshot.bind(app.vault);
  app.vault.snapshot = async scope => { scopes.push(scope); return originalSnapshot(scope); };
  const result = await call(url, input); assert.equal(result.status, 200);
  assert.ok(scopes.every(scope => scope && !scope.all));
  assert.ok(scopes.some(scope => scope.eventRange?.from === '2026-09-10T01:59:59.999Z' && scope.eventRange.until === '2026-09-10T02:00:00.001Z'));
  app.vault.snapshot = originalSnapshot;
  const trigger = JSON.parse(result.data.values.trigger);
  assert.equal(trigger.previous, 'incident'); assert.equal(trigger.severity, 'warning');
  assert.deepEqual(trigger.events, [{ id: long.id, version: long.version }]);
  const setup = mergeDryRunSetup(flow, {}, result.data.now); setup.nodes.trigger = result.data.values;
  await app.workflows.saveDryRunSetup(flow.id, { version: 0, setup });
  assert.equal(app.workflows.dryRun(flow.id, { definition: flow, setup }).status, 'success');
  const after = await app.vault.snapshot();
  for (const field of ['events', 'changes', 'workflowRuns', 'serviceState']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(app.workflows.read(flow.id), flow);
  const saved = app.workflows.readDryRunSetup(flow.id);
  await app.close();
  const reopened = await createApp(options);
  try { await reopened.vault.unlock('service-dry-run-password'); assert.deepEqual(reopened.workflows.readDryRunSetup(flow.id), saved); }
  finally { await reopened.close(); }
});

test('invalid, deleted and concurrently edited schedule selections cannot apply partial service fixtures', async t => {
  const { app, flow, add } = await fixture(t);
  const open = await add(event('open', at('00'), null));
  for (const input of [{ eventId: 'bad', occurrence: 'start', service: 'payments' }, { eventId: open.id, occurrence: 'end', service: 'payments' }, { eventId: open.id, occurrence: 'start', service: 'missing' }, { eventId: open.id, occurrence: 'other', service: 'payments' }]) await assert.rejects(app.workflows.dryRunServiceEvent(flow.id, input), error => error.status === 400);
  const originalGet = app.vault.getRecord.bind(app.vault);
  app.vault.getRecord = async (...args) => { const selected = await originalGet(...args); await app.vault.update(selected.id, { ...selected, title: 'changed concurrently' }); return selected; };
  await assert.rejects(app.workflows.dryRunServiceEvent(flow.id, { eventId: open.id, occurrence: 'start', service: 'payments' }), error => error.status === 409);
  app.vault.getRecord = originalGet;
  const latest = await originalGet('events', open.id); await app.vault.remove(open.id, latest.version);
  await assert.rejects(app.workflows.dryRunServiceEvent(flow.id, { eventId: open.id, occurrence: 'start', service: 'payments' }), error => error.status === 404);
});
