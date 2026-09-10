import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { validateDefinition } from '../lib/workflow-definition.mjs';
import { exportWorkflow, importWorkflow, validateReferences } from '../lib/workflow-file.mjs';

const node = (id, type, config = {}) => ({ id, type, name: id, x: 36, y: 36, config });
const edge = (from, to, port = 'next') => ({ id: `${from}-${port}-${to}`, from, to, port });
const inject = (id, values) => node(id, 'context', { entries: Object.entries(values).map(([key, value]) => ({ key, value })) });
const root = () => node('root', 'cron', { expression: '* * * * *', timezone: 'UTC' });
const done = () => node('done', 'finish', { result: 'success', message: '' });
const chain = nodes => ({ name: 'Context injection', nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)) });

async function fixture(t, send = async () => new Response('{}')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-context-'));
  const app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, fetch: send }, logMaintenance: { autoStart: false } });
  await app.vault.setup('workflow-context-password'); await app.workflowEngine.unlock();
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-context-')); await fs.rm(directory, { recursive: true, force: true }); });
  return app;
}
async function settle(app, id) {
  for (let i = 0; i < 300; i++) {
    await app.workflowEngine.tick();
    const run = await app.workflows.readRun(id);
    if (['success', 'failure', 'review', 'canceled', 'interrupted'].includes(run.status)) return run;
    await delay(10);
  }
  throw Error('Context run did not finish');
}

test('context entries validate strictly, remain literal and round-trip in workflow files', () => {
  const values = { token: 'sample-token', empty: '', text: '"quoted"\n한글', literal: '{{secrets.NOT_A_REFERENCE}}' };
  const definition = chain([root(), inject('values', values), done()]);
  const exported = exportWorkflow(definition);
  assert.equal(Object.hasOwn(exported, 'requiredSecrets'), false);
  assert.deepEqual(importWorkflow(exported).requiredSecrets, []);
  assert.deepEqual(importWorkflow(exported, { executable: true }).definition, validateDefinition(definition));
  const entries = Array.from({ length: 50 }, (_, i) => ({ key: 'key' + i, value: 'v'.repeat(4000) }));
  assert.equal(validateDefinition(chain([root(), node('values', 'context', { entries }), done()])).nodes[1].config.entries.length, 50);
  for (const invalid of [null, {}, [...entries, { key: 'extra', value: '' }], [{ key: '', value: 'x' }], [{ key: 'a.b', value: 'x' }], [{ key: 'a'.repeat(65), value: 'x' }], [{ key: '__proto__', value: 'x' }], [{ key: 'constructor', value: 'x' }], [{ key: 'prototype', value: 'x' }], [{ key: 'a', value: 1 }], [{ key: 'a', value: null }], [{ key: 'a', value: 'x'.repeat(4001) }], [{ key: 'a', value: '', other: true }], [{ key: 'a', value: '' }, { key: 'a', value: '2' }]]) {
    assert.throws(() => validateDefinition(chain([root(), node('values', 'context', { entries: invalid }), done()])));
  }
});

test('context references require injection on every incoming branch and allow later overwrites', () => {
  const output = node('output', 'finish', { result: 'success', message: '{{context.value}}' });
  const early = node('early', 'http', { method: 'GET', url: 'http://127.0.0.1:1/{{context.value}}' });
  assert.throws(() => validateReferences(validateDefinition(chain([root(), early, inject('late', { value: 'late' }), done()]))), /먼저 주입/);
  const branch = node('branch', 'condition', { field: 'trigger.type', operator: 'equals', value: 'cron' });
  const definition = { name: 'Branches', nodes: [root(), branch, inject('left', { value: 'left' }), inject('right', { value: 'right' }), output], edges: [edge('root', 'branch'), edge('branch', 'left', 'true'), edge('branch', 'right', 'false'), edge('left', 'output'), edge('right', 'output')] };
  assert.doesNotThrow(() => validateReferences(validateDefinition(definition, { executable: true })));
  definition.nodes.find(n => n.id === 'right').config.entries = [];
  assert.throws(() => validateReferences(validateDefinition(definition)), /먼저 주입/);
  assert.doesNotThrow(() => validateReferences(validateDefinition(chain([root(), inject('first', { value: '1' }), inject('second', { value: '2' }), output]))));
});

test('injection becomes available at execution time, merges and overwrites, with snapshot reruns and isolated runs', async t => {
  const calls = [];
  const app = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    await delay(5);
    return new Response(JSON.stringify({ echo: options.headers.Authorization, accepted: true }));
  });
  const request = id => node(id, 'http', { method: 'POST', intent: 'read', url: 'http://127.0.0.1:1/{{context.target}}', headers: '{"Authorization":"Bearer {{context.token}}"}', body: '{"text":"{{context.text}}","empty":"{{context.empty}}","literal":"{{context.literal}}","current":"{{context.target}}"}' });
  const definition = chain([root(), inject('initial', { token: 'private-context-token', target: 'first target', text: '"quoted"\n한글', empty: '', literal: '{{secrets.UNRESOLVED}}' }), request('first'), inject('update', { target: 'second' }), request('second'), done()]);
  let flow = await app.workflows.create({ ...definition, requestId: randomUUID() });
  const run = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
  const result = await settle(app, run.id);
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:1/first%20target');
  assert.equal(calls[1].url, 'http://127.0.0.1:1/second');
  assert.equal(calls[0].headers.Authorization, 'Bearer private-context-token');
  assert.deepEqual(calls[1].body, { text: '"quoted"\n한글', empty: '', literal: '{{secrets.UNRESOLVED}}', current: 'second' });
  assert.deepEqual(result.steps.find(step => step.nodeId === 'update').output, { keys: ['target'], count: 1 });
  assert.equal(JSON.stringify(result).includes('private-context-token'), false);
  const persisted = await app.vault.getRecord('workflowRuns', run.id);
  assert.equal(persisted.definition.nodes[1].config.entries[0].value, 'private-context-token');
  assert.equal(JSON.stringify(persisted.steps).includes('private-context-token'), false);
  flow.nodes[1].config.entries.find(entry => entry.key === 'target').value = 'changed';
  flow = await app.workflows.save(flow.id, flow);
  const rerun = await app.workflows.rerun(run.id, { requestId: randomUUID() });
  assert.equal((await settle(app, rerun.id)).status, 'success');
  assert.equal(calls[2].body.current, 'first target', 'reruns use the injection values in the original definition');
  const fresh = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
  assert.equal((await settle(app, fresh.id)).status, 'success');
  assert.equal(calls[4].body.current, 'changed');
  // A separate run with no injection must not inherit the previous run's values.
  const isolated = await app.workflows.create({ ...chain([root(), node('done', 'condition', { field: 'context.target', operator: 'isMissing', value: '' })]), requestId: randomUUID() });
  await app.vault.mutate(state => { state.workflowRuns.push({ ...structuredClone(persisted), id: 'isolation-run', workflowId: isolated.id, definition: { name: isolated.name, nodes: isolated.nodes, edges: isolated.edges }, status: 'queued', steps: [], requestKey: 'isolation-run' }); });
  const isolatedResult = await settle(app, 'isolation-run');
  assert.equal(isolatedResult.steps.at(-1).output.matched, true);
});

test('authenticated API permits only deletion of existing secrets and rejects mixed updates atomically', async t => {
  const app = await fixture(t);
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
  let cookie = '';
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  await call('/api/login', 'POST', { password: 'workflow-context-password' });
  const created = (await call('/api/workflows', 'POST', { ...chain([root(), done()]), requestId: randomUUID() })).data;
  assert.deepEqual(created.secretNames, []);
  const url = '/api/workflows/' + created.id;
  assert.equal((await call(url, 'PUT', { ...created, secrets: { NEW: 'denied' } })).status, 400);
  await app.vault.mutate(state => { state.workflows.find(flow => flow.id === created.id).secrets = { OLD: 'legacy-private-value', KEEP: 'keep-private-value' }; }, { scope: {} });
  for (const secrets of [{ OLD: 'changed' }, { OLD: null, NEW: 'new' }, { missing: null }]) {
    assert.equal((await call(url, 'PUT', { ...created, secrets })).status, 400);
    assert.equal(app.vault.state.workflows[0].secrets.OLD, 'legacy-private-value');
    assert.equal(app.workflows.read(created.id).version, created.version);
  }
  const updated = await call(url, 'PUT', { ...created, secrets: { OLD: null } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.secretNames, ['KEEP']);
  assert.equal(JSON.stringify(updated.data).includes('private-value'), false);
  assert.equal((await call(url, 'PUT', { ...created, secrets: { KEEP: null } })).status, 409);
  const removed = await call(url, 'PUT', { ...updated.data, secrets: { KEEP: null } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.secretNames, []);
});
