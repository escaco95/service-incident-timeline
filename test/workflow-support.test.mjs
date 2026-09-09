import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { validateDefinition, bodyTemplate } from '../lib/workflow-definition.mjs';
import { importWorkflow, exportWorkflow, FORMAT, fileSchema } from '../lib/workflow-file.mjs';
import { condition, findItems, dateValue, parseRules } from '../lib/workflow-values.mjs';
import { replaceFile } from '../lib/file-replace.mjs';
import { TERMINAL } from '../lib/workflows.mjs';

const node = (id, type, config = {}) => ({ id, type, name: id, x: 36, y: 36, config });
const edge = (from, to, port = 'next') => ({ id: `${from}-${port}-${to}`, from, to, port });
const finish = () => node('done', 'finish', { result: 'success', message: '' });
const base = () => ({ name: 'Service fixture', nodes: [node('trigger', 'service-state', { service: '' }), finish()], edges: [edge('trigger', 'done')] });
const http = (id = 'http', extra = {}) => node(id, 'http', { method: 'POST', intent: 'change', url: 'http://127.0.0.1:1', outputMode: 'none', timeoutMs: 1000, retries: 0, onError: 'stop', ...extra });
const changing = () => { const def = base(); def.nodes.splice(1, 0, http()); def.edges = [edge('trigger', 'http'), edge('http', 'done')]; return def; };
const file = definition => ({ format: FORMAT, formatVersion: 1, definition, requiredSecrets: [] });

async function fixture(t, fetch = async () => new Response('{}')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-support-'));
  let at = '2026-09-10T00:00:00.000Z';
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, clock: () => at, fetch }, logMaintenance: { autoStart: false } };
  const app = await createApp(options); await app.vault.setup('workflow-support-password'); await app.workflowEngine.unlock();
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^workflow-support-/); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, options, directory, time: value => { at = value; }, async flow(def = base()) { const flow = await app.workflows.create({ ...def, requestId: randomUUID() }); return app.workflows.enable(flow.id, { version: flow.version, enabled: true }); }, async event(extra = {}) { return (await app.vault.add({ title: 'Fixture', description: '', services: [{ kind: 'custom', label: 'resource-a' }], category: 'maintenance', start: '2026-09-10T00:00:10.000Z', end: null, ...extra })).event; } };
}
async function settle(app, id) {
  const until = Date.now() + 10000;
  do {
    await app.workflowEngine.tick();
    const run = await app.workflows.readRun(id);
    if (TERMINAL.has(run.status)) return run;
    if (app.workflowEngine.fault) throw Error(app.workflowEngine.fault);
    await delay(10);
  } while (Date.now() < until);
  throw Error('Run did not finish: ' + JSON.stringify(await app.workflows.readRun(id)));
}
async function drain(app) {
  await app.workflowEngine.tick();
  for (const run of (await app.vault.snapshot({ activeRuns: true })).workflowRuns) await settle(app, run.id);
}

test('file format, deterministic layout, 99/100/101 nodes, strict fields and secret-free round trip', async () => {
  const chain = count => {
    const nodes = [node('root', 'cron', { expression: '* * * * *', timezone: 'UTC' }), ...Array.from({ length: count - 2 }, (_, i) => node(`n${i}`, 'datetime', { source: 'now', timezone: 'UTC', format: 'iso' })), finish()];
    return { name: 'Budget', nodes: nodes.map(({ x, y, ...rest }) => rest), edges: nodes.slice(1).map((node, i) => edge(nodes[i].id, node.id)) };
  };
  for (const count of [99, 100]) {
    const imported = importWorkflow(file(chain(count)), { executable: true });
    assert.equal(imported.definition.nodes.length, count);
    assert.deepEqual(importWorkflow(exportWorkflow(imported.definition), { executable: true }).definition, imported.definition);
  }
  assert.throws(() => importWorkflow(file(chain(101))), /100/);
  assert.throws(() => importWorkflow({ ...file(base()), formatVersion: 2 }), /formatVersion/);
  assert.throws(() => importWorkflow({ ...file(base()), enabled: true }), /enabled/);
  const bad = base(); bad.nodes[0].config.typo = true; assert.throws(() => importWorkflow(file(bad)), /trigger/);
  const inline = changing(); inline.nodes[1].config.headers = '{"Authorization":"private-literal"}'; assert.throws(() => exportWorkflow(inline), /secrets/);
  inline.nodes[1].config.headers = '{"Authorization":"Bearer {{secrets.TOKEN}}"}';
  const exported = exportWorkflow({ ...inline, id: randomUUID(), enabled: true, secrets: { TOKEN: 'never-export-me' } });
  assert.deepEqual(exported.requiredSecrets, ['TOKEN']); assert.equal(JSON.stringify(exported).includes('never-export-me'), false); assert.equal('enabled' in exported, false);
  inline.nodes[1].config.body = '{"token":{"$path":"secrets.BODY_TOKEN"}}';
  assert.deepEqual(exportWorkflow(inline).requiredSecrets, ['BODY_TOKEN', 'TOKEN']);
  assert.throws(() => importWorkflow({ ...exported, requiredSecrets: [] }), /requiredSecrets/);
  assert.deepEqual(JSON.parse(await fs.readFile(new URL('../schemas/workflow-file-v1.schema.json', import.meta.url))), fileSchema());
});

test('conditions, path values, bounded AND/OR, null/missing, array cardinality and typed JSON', () => {
  const ctx = { response: { body: { n: null, zero: 0, flag: false, list: [{ id: 2 }, { id: 1 }, { id: 2 }] } }, trigger: { desired: 2 } };
  for (const [field, operator, expected] of [['n', 'isNull', true], ['n', 'isMissing', false], ['absent', 'isMissing', true], ['zero', 'isPresent', true], ['flag', 'isPresent', true]]) assert.equal(condition({ field: `response.body.${field}`, operator }, ctx), expected);
  assert.equal(condition({ field: 'response.body.absent', operator: 'equals', valueSource: 'path', value: 'response.body.alsoAbsent' }, ctx), false);
  const rules = JSON.stringify({ all: [{ field: 'response.body.zero', operator: 'equals', value: '0' }, { any: [{ field: 'response.body.n', operator: 'isNull' }, { field: 'response.body.flag', operator: 'equals', value: 'true' }] }] });
  assert.equal(condition({ rules }, ctx), true); assert.throws(() => parseRules(JSON.stringify({ all: Array(65).fill({ field: 'trigger.desired', operator: 'isPresent' }) })), /64/);
  const config = { source: 'response.body.list', field: 'id', valueSource: 'path', value: 'trigger.desired' };
  assert.deepEqual(findItems(config, ctx), { count: 2, item: null }); ctx.trigger.desired = 1; assert.deepEqual(findItems(config, ctx), { count: 1, item: { id: 1 } }); ctx.trigger.desired = 3; assert.equal(findItems(config, ctx).count, 0);
  assert.throws(() => findItems({ ...config, source: 'response.body.n' }, ctx), /배열/);
  assert.deepEqual(JSON.parse(bodyTemplate('{"n":{"$path":"response.body.zero"},"obj":{"$path":"response.body.list"}}', ctx)), { n: 0, obj: ctx.response.body.list });
});

test('date values separate frozen trigger time from node time and preserve timezone offsets', () => {
  const context = { trigger: { scheduledAt: '2026-09-09T23:30:00.000Z' } }, now = '2026-09-10T02:00:00.000Z';
  const config = { source: 'trigger.scheduledAt', timezone: 'Asia/Seoul', format: 'local' };
  assert.equal(dateValue(config, context, now).value, '2026-09-10T08:30:00+09:00');
  assert.equal(dateValue({ ...config, source: 'now' }, context, now).value, '2026-09-10T11:00:00+09:00');
  assert.equal(dateValue({ ...config, format: 'unix-ms' }, context, now).value, Date.parse(context.trigger.scheduledAt));
  assert.throws(() => dateValue(config, { trigger: { scheduledAt: '2026-09-10' } }, now), /ISO/);
});

test('file verification rejects non-dominating references and HTTP attempt budget; change retries require explicit external guarantee', () => {
  const def = changing(); def.nodes[1].config.body = '{"value":"{{nodes.done.message}}"}'; assert.throws(() => importWorkflow(file(def), { executable: true }), /먼저 실행/);
  def.nodes[1].config.body = ''; def.nodes[1].config.retries = 1; assert.throws(() => validateDefinition(def, { executable: true }), /중복 방지/);
  def.nodes[1].config.idempotency = 'verified'; assert.doesNotThrow(() => validateDefinition(def, { executable: true }));
  const nodes = [def.nodes[0], ...Array.from({ length: 26 }, (_, i) => http(`http${i}`, { intent: 'read', retries: 3 })), finish()];
  assert.throws(() => validateDefinition({ name: 'Budget', nodes, edges: nodes.slice(1).map((node, i) => edge(nodes[i].id, node.id)) }, { executable: true }), /100/);
});

test('Windows rename retries only transient uncommitted operations and preserves failures', async () => {
  let calls = 0; const waits = [];
  await replaceFile('from', 'to', { platform: 'win32', move: async () => { if (++calls < 3) throw Object.assign(Error('locked'), { code: 'EPERM' }); }, wait: async ms => waits.push(ms) });
  assert.equal(calls, 3); assert.deepEqual(waits, [20, 40]);
  calls = 0; await assert.rejects(replaceFile('from', 'to', { platform: 'win32', move: async () => { calls++; throw Object.assign(Error('full'), { code: 'ENOSPC' }); } }), /full/); assert.equal(calls, 1);
  calls = 0; await assert.rejects(replaceFile('from', 'to', { platform: 'win32', move: async () => { calls++; throw Object.assign(Error('locked'), { code: 'EPERM' }); }, wait: async () => {} }), /locked/); assert.equal(calls, 7);
});

test('service trigger aggregates overlap, same-time boundaries, strings and multiple services; evidence-only updates do not execute', async t => {
  const { app, flow, event, time } = await fixture(t); await flow();
  await app.workflowEngine.tick();
  await event({ end: '2026-09-10T00:00:40.000Z' });
  await event({ start: '2026-09-10T00:00:20.000Z', end: '2026-09-10T00:00:30.000Z', category: 'incident', services: [{ kind: 'custom', label: 'resource-a' }, { kind: 'custom', label: 'resource-b' }] });
  await event({ start: '2026-09-10T00:00:15.000Z', end: '2026-09-10T00:00:25.000Z' });
  await event({ start: '2026-09-10T00:00:40.000Z', end: '2026-09-10T00:00:50.000Z' });
  for (const seconds of [10, 15, 20, 25, 30, 40, 50]) { time(`2026-09-10T00:00:${seconds}.000Z`); await drain(app); }
  const state = await app.vault.snapshot();
  assert.deepEqual(state.workflowRuns.filter(run => run.input.trigger.service === 'resource-a').map(run => run.input.trigger.severity), ['warning', 'incident', 'warning', '']);
  assert.deepEqual(state.workflowRuns.filter(run => run.input.trigger.service === 'resource-b').map(run => run.input.trigger.severity), ['incident', '']);
  assert.ok(state.changes.some(row => row.action === 'service-state-evidence'));
  assert.ok(state.workflowRuns.every(run => run.input.event === null));
});

test('initial state does not propagate; active edit/delete and restart reconcile only current severity', async t => {
  const { app, flow, event, time, options } = await fixture(t); await flow();
  const first = await event({ start: '2026-09-09T00:00:00.000Z' }); await drain(app);
  assert.equal((await app.vault.snapshot()).workflowRuns.length, 0);
  await app.vault.update(first.id, { ...first, category: 'incident' }); await drain(app);
  assert.equal((await app.vault.snapshot()).workflowRuns[0].input.trigger.severity, 'incident');
  const edited = await app.vault.getRecord('events', first.id); await app.vault.remove(first.id, edited.version); await drain(app);
  assert.equal((await app.vault.snapshot()).workflowRuns.at(-1).input.trigger.severity, '');
  await event({ start: '2026-09-10T00:00:10.000Z', end: '2026-09-10T00:00:20.000Z', category: 'incident' });
  await app.close(); time('2026-09-10T00:00:30.000Z');
  const resumed = await createApp(options); try { await resumed.vault.unlock('workflow-support-password'); await resumed.workflowEngine.unlock(); await drain(resumed); assert.equal((await resumed.vault.snapshot()).workflowRuns.length, 2); } finally { await resumed.close(); }
});

test('same service serializes across workflows; response output policy does not affect downstream comparisons', async t => {
  let active = 0, maximum = 0;
  const { app, flow, event, time } = await fixture(t, async () => { active++; maximum = Math.max(maximum, active); await delay(40); active--; return new Response('{"privateBusiness":"not-for-history","value":2}'); });
  const def = changing(); def.nodes.splice(2, 0, node('check', 'condition', { field: 'response.body.value', operator: 'equals', value: '2' })); def.edges = [edge('trigger', 'http'), edge('http', 'check'), edge('check', 'done', 'true')];
  await flow(def); await flow(def); await app.workflowEngine.tick(); await event(); time('2026-09-10T00:00:10.000Z'); await drain(app);
  assert.equal(maximum, 1); const state = await app.vault.snapshot(); assert.equal(state.workflowRuns.length, 2); assert.ok(state.workflowRuns.every(run => run.status === 'success')); assert.equal(JSON.stringify(state.workflowRuns).includes('not-for-history'), false);
});

test('latest target is checked before change HTTP; edited target prevents an outdated send', async t => {
  let release, changes = 0;
  const { app, flow, event, time } = await fixture(t, async (_url, options) => { if (options.method === 'GET') { await new Promise(resolve => { release = resolve; }); return new Response('{}'); } changes++; return new Response('{}'); });
  const def = changing(); def.nodes.splice(1, 0, http('read', { method: 'GET', intent: 'read' })); def.edges = [edge('trigger', 'read'), edge('read', 'http'), edge('http', 'done')];
  await flow(def); await app.workflowEngine.tick(); const input = await event(); time(input.start); await app.workflowEngine.tick();
  for (let i = 0; !release && i < 200; i++) await delay(5); assert.ok(release);
  await app.vault.update(input.id, { ...input, category: 'incident' });
  release(); const run = (await app.vault.snapshot({ activeRuns: true })).workflowRuns[0];
  // settle would also schedule the new goal; wait only the already-running job.
  await Promise.all([...app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.equal((await app.workflows.readRun(run.id)).status, 'skipped'); assert.equal(changes, 0);
  app.workflowEngine.fetch = async () => new Response('{}');
});

test('lost change response holds the service, blocks the next change, and resolves with linked current-state reevaluation', async t => {
  let calls = 0;
  const { app, flow, event, time } = await fixture(t, async () => { calls++; throw Error('response lost'); });
  const saved = await flow(changing()); await app.workflowEngine.tick(); const input = await event(); time(input.start); await app.workflowEngine.tick();
  const first = (await app.vault.snapshot({ activeRuns: true })).workflowRuns[0]; assert.equal((await settle(app, first.id)).status, 'review'); assert.equal(calls, 1);
  await app.vault.remove(input.id, input.version); await app.workflowEngine.tick();
  assert.equal(calls, 1); assert.equal(app.workflows.serviceStates()[0].hold.runId, first.id);
  const query = changing(); query.nodes[1].config.intent = 'read'; query.nodes[1].config.method = 'GET';
  const queryFlow = await flow(query); app.workflowEngine.fetch = async () => new Response('{}');
  const observation = await app.workflows.run(queryFlow.id, { version: queryFlow.version, service: 'resource-a', requestId: randomUUID() });
  assert.equal((await settle(app, observation.id)).status, 'success');
  assert.equal(app.workflows.serviceStates()[0].hold.runId, first.id, 'observation does not clear uncertainty');
  await assert.rejects(app.workflows.rerun(first.id, { requestId: randomUUID() }), /재평가/);
  const resolution = { service: 'resource-a', runId: first.id, requestId: randomUUID(), confirmed: true, previousRequestFinished: true };
  await assert.rejects(app.workflows.resolveService({ ...resolution, previousRequestFinished: false }), /확인/);
  await app.workflows.resolveService(resolution); await app.workflows.resolveService(resolution);
  app.workflowEngine.fetch = async () => { calls++; return new Response('{}'); };
  const next = await app.workflows.reevaluate(first.id, { requestId: randomUUID() });
  assert.equal(next.parentId, first.id); assert.equal(next.input.trigger.severity, ''); assert.equal((await settle(app, next.id)).status, 'success');
  assert.equal(calls, 2); assert.equal((await app.workflows.readRun(first.id)).status, 'review'); assert.equal(app.workflows.read(saved.id).enabled, true);
});

test('a one-off pre-call storage failure stops all further dispatch', async t => {
  let calls = 0;
  const { app, flow, event, time } = await fixture(t, async () => { calls++; return new Response('{}'); });
  await flow(changing()); await app.workflowEngine.tick(); const input = await event(); time(input.start);
  const current = app.workflows.list().workflows[0];
  const off = await app.workflows.enable(current.id, { version: current.version, enabled: false });
  const run = await app.workflows.run(off.id, { version: off.version, service: 'resource-a', requestId: randomUUID() });
  const mutate = app.vault.mutate.bind(app.vault); let injected = false;
  app.vault.mutate = async (change, options) => {
    if (!injected && options?.scope?.eventRange && options.scope.ids?.workflowRuns) { injected = true; throw Error('one-off storage error'); }
    return mutate(change, options);
  };
  await app.workflowEngine.tick(); await Promise.all([...app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.ok(injected); assert.ok(app.workflowEngine.fault); assert.equal(calls, 0);
  assert.equal((await app.workflows.readRun(run.id)).status, 'failure');
});

test('restart reconstructs service hold for an unfinished change or response interpretation before dispatch', async t => {
 for (const responseReceived of [false, true]) {
  let calls = 0; const { app, flow, event, time, options } = await fixture(t, async () => { calls++; return new Response('{}'); });
  await flow(changing()); await app.workflowEngine.tick(); const input = await event(); time(input.start);
  // Queue from current state without starting the engine.
  const run = await app.workflows.run(app.workflows.list().workflows[0].id, { version: 2, service: 'resource-a', requestId: randomUUID() });
  await app.vault.mutate(state => { const row = state.workflowRuns.find(item => item.id === run.id); row.status = 'running'; row.startedAt = input.start; row.steps = [{ nodeId: 'http', type: 'http', status: 'running', attempts: [{ intent: 'change', startedAt: input.start, ...(responseReceived ? { finishedAt: input.start, status: 'response', httpStatus: 200 } : {}) }] }]; }, { scope: { ids: { workflowRuns: [run.id] } } });
  await app.close(); const resumed = await createApp(options);
  try { await resumed.vault.unlock('workflow-support-password'); await resumed.workflowEngine.unlock(); await resumed.workflowEngine.tick(); assert.equal(calls, 0); assert.equal((await resumed.workflows.readRun(run.id)).status, 'interrupted'); assert.equal(resumed.workflows.serviceStates()[0].hold.runId, run.id); } finally { await resumed.close(); }
 }
});

test('100 nodes execute through durable storage within the existing runtime limit', async t => {
  const { app, flow } = await fixture(t);
  const nodes = [node('trigger', 'cron', { expression: '* * * * *', timezone: 'UTC' }), ...Array.from({ length: 98 }, (_, i) => node(`date${i}`, 'datetime', { source: 'now', timezone: 'Asia/Seoul', format: 'local' })), finish()];
  const saved = await flow({ name: '100 nodes', nodes, edges: nodes.slice(1).map((node, i) => edge(nodes[i].id, node.id)) });
  const started = Date.now(), run = await app.workflows.run(saved.id, { version: saved.version, requestId: randomUUID() });
  const result = await settle(app, run.id); assert.equal(result.status, 'success'); assert.equal(result.steps.length, 100);
  t.diagnostic(`100 nodes: ${Date.now() - started}ms; persisted run JSON: ${Buffer.byteLength(JSON.stringify(result))} bytes`);
});

test('authenticated exchange API validates without mutation, imports OFF, exports no secrets and rejects conflicts', async t => {
  const { app } = await fixture(t), baseUrl = `http://127.0.0.1:${(await app.listen(0)).port}`; let cookie = '';
  const call = async (url, method = 'GET', body, origin = baseUrl) => { const response = await fetch(baseUrl + url, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return { status: response.status, data: await response.json() }; };
  assert.equal((await call('/api/workflows/validate', 'POST', file(base()))).status, 401);
  await call('/api/login', 'POST', { password: 'workflow-support-password' });
  const revision = app.vault.state.revision;
  const valid = await call('/api/workflows/validate', 'POST', file(base())); assert.equal(valid.status, 200); assert.equal(app.vault.state.revision, revision);
  assert.equal((await call('/api/workflows/validate', 'POST', file(base()), 'https://other.invalid')).status, 403);
  const created = (await call('/api/workflows', 'POST', { ...valid.data.definition, requestId: randomUUID() })).data; assert.equal(created.enabled, false);
  assert.equal((await call(`/api/workflows/${created.id}/export`)).data.format, FORMAT);
  assert.equal((await call(`/api/workflows/${created.id}`, 'PUT', { ...created, version: 999 })).status, 409);
});
