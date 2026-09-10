import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnoseWorkflow } from '../lib/workflow-diagnostics.mjs';
import { validateDefinition } from '../lib/workflow-definition.mjs';
import { createApp } from '../server.mjs';

const node = (id, type, config = {}) => ({ id, type, config, name: id, x: 36, y: 36 });
const edge = (from, to) => ({ id: `${from}-${to}`, from, to, port: 'next' });
const base = () => ({ name: 'Diagnostics', nodes: [node('root', 'start'), node('done', 'finish')], edges: [edge('root', 'done')] });

test('incomplete drafts are saveable and diagnostics identify every conflicting trigger', () => {
  const empty = diagnoseWorkflow({ name: 'Empty', nodes: [], edges: [] });
  assert.equal(empty.saveAllowed, true); assert.equal(empty.executable, false);
  assert.deepEqual(empty.issues[0].nodeIds, []);
  const draft = base(); draft.nodes.push(node('second', 'end'), node('orphan', 'finish'), node('http', 'http', { url: '' }));
  const result = diagnoseWorkflow(draft);
  assert.equal(result.saveAllowed, true); assert.equal(result.executable, false);
  assert.deepEqual(result.issues.find(issue => issue.code === 'trigger-count').nodeIds, ['root', 'second']);
  assert.deepEqual(result.issues.find(issue => issue.code === 'unreachable').nodeIds, ['orphan', 'http']);
  assert.ok(result.issues.some(issue => issue.code === 'node-config' && issue.nodeIds[0] === 'http'));
  assert.throws(() => validateDefinition(draft, { executable: true }), { message: result.issues[0].message });
  assert.equal(diagnoseWorkflow(draft, { enabled: true }).saveAllowed, false);
  assert.deepEqual(diagnoseWorkflow(base()), { executable: true, saveAllowed: true, issues: [] });
});

test('all reference errors and missing secrets point at their consuming nodes', () => {
  const draft = base();
  draft.nodes[1].config.message = '{{context.token}} {{response.status}} {{nodes.later.value}} {{secrets.TOKEN}}';
  const result = diagnoseWorkflow(draft);
  assert.deepEqual(result.issues.map(issue => issue.nodeIds), [['done'], ['done'], ['done'], ['done']]);
  assert.equal(result.issues.filter(issue => issue.code === 'reference').length, 3);
  assert.equal(result.issues.filter(issue => issue.code === 'missing-secret').length, 1);
  assert.equal(diagnoseWorkflow(draft, { availableSecrets: ['TOKEN'] }).issues.length, 3);
  const injected = base();
  injected.nodes.splice(1, 0, node('values', 'context', { entries: [{ key: 'token', value: '{{secrets.NOT_A_REFERENCE}}' }] }));
  injected.nodes[2].config.message = '{{context.token}}';
  injected.edges = [edge('root', 'values'), edge('values', 'done')];
  assert.equal(diagnoseWorkflow(injected).executable, true);
});

test('node execution diagnostics use the same rules as the execution validator', () => {
  const fixtures = [
    node('bad', 'cron', { expression: 'invalid' }),
    node('bad', 'condition', { field: 'unknown.value' }),
    node('bad', 'condition', { rules: '{' }),
    node('bad', 'switch', { field: 'invalid' }),
    node('bad', 'find', { source: 'invalid' }),
    node('bad', 'datetime', { timezone: 'Invalid/Timezone' }),
    node('bad', 'http', { url: 'file:///a' }),
    node('bad', 'http', { url: 'https://example.invalid', headers: '{' }),
    node('bad', 'http', { url: 'https://example.invalid', onError: 'branch' }),
    node('bad', 'http', { method: 'POST', url: 'https://example.invalid', retries: 1 }),
    node('bad', 'finish', { result: 'invalid' })
  ];
  for (const invalid of fixtures) {
    const draft = invalid.type === 'cron' ? { name: 'Bad cron', nodes: [invalid], edges: [] } : { name: 'Bad node', nodes: [node('root', 'start'), invalid], edges: [edge('root', 'bad')] };
    const result = diagnoseWorkflow(draft);
    assert.equal(result.saveAllowed, true, invalid.type);
    assert.deepEqual(result.issues[0].nodeIds, ['bad']);
    assert.throws(() => validateDefinition(draft, { executable: true }), { message: result.issues[0].message });
  }
});

test('malformed and cyclic definitions cannot be saved and do not enter reference traversal', () => {
  for (const draft of [null, {}, { ...base(), edges: [edge('missing', 'done')] }]) {
    const result = diagnoseWorkflow(draft);
    assert.equal(result.saveAllowed, false); assert.equal(result.issues[0].code, 'definition');
  }
  const draft = base(); draft.nodes.push(node('other', 'context')); draft.nodes[1].type = 'context';
  draft.edges.push(edge('done', 'other'), edge('other', 'done'));
  assert.match(diagnoseWorkflow(draft).issues[0].message, /순환/);
});

test('diagnostics API is read-only, respects stored secrets and preserves draft save/run rules', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-diagnostics-'));
  let calls = 0;
  const app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, fetch: async () => { calls++; return new Response('{}'); } }, logMaintenance: { autoStart: false } });
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^workflow-diagnostics-/); await fs.rm(directory, { recursive: true, force: true }); });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  const setup = await fetch(origin + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'diagnostics-test-password' }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const flow = await app.workflows.create({ ...base(), requestId: randomUUID() });
  const draft = { ...base(), nodes: [...base().nodes, node('second', 'end')] };
  const endpoint = `${origin}/api/workflows/${flow.id}/diagnostics`;
  const before = await app.vault.snapshot();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(draft) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.saveAllowed, true); assert.equal(result.executable, false);
  for (const kind of ['missing-port','duplicate-port','context-reference']) {
    const switchDraft = {name:'Switch diagnostics',nodes:[node('root','service-state'),node('route','switch',{field:kind==='context-reference'?'context.missing':'trigger.service',cases:[{id:'case-a',value:'A'}]}),node('done','finish')],edges:[edge('root','route'),{id:'route-done',from:'route',to:'done',port:kind==='missing-port'?'case-deleted':'default'}]};
    if(kind==='duplicate-port') switchDraft.edges.push({id:'duplicate',from:'route',to:'done',port:'default'});
    const checked = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify(switchDraft)});
    assert.equal(checked.status,200);
    const diagnostic = await checked.json();
    assert.equal(diagnostic.executable,false); assert.equal(diagnostic.saveAllowed,kind==='context-reference');
    assert.deepEqual(diagnostic.issues[0].nodeIds,['route']);
  }
  assert.deepEqual(await app.vault.snapshot(), before); assert.equal(calls, 0);
  const saved = await app.workflows.save(flow.id, { ...draft, version: flow.version });
  assert.equal(saved.nodes.length, 3);
  await assert.rejects(app.workflows.enable(flow.id, { version: saved.version, enabled: true }), /정확히 하나/);
  const event = (await app.vault.add({ title: 'Diagnostic event', description: '', services: [], category: 'incident', start: '2026-09-10T00:00:00.000Z', end: null })).event;
  await assert.rejects(app.workflows.run(flow.id, { version: saved.version, requestId: randomUUID(), eventId: event.id }), /정확히 하나/);
  const fixed = await app.workflows.save(flow.id, { ...base(), version: saved.version });
  await app.workflows.enable(flow.id, { version: fixed.version, enabled: true });
  assert.equal(app.workflows.diagnose(flow.id, draft).saveAllowed, false);
  await app.vault.mutate(state => { state.workflows.find(item => item.id === flow.id).secrets = { TOKEN: 'private-diagnostic-value' }; }, { scope: {} });
  const secretDraft = base(); secretDraft.nodes[1].config.message = '{{secrets.TOKEN}}';
  assert.equal(app.workflows.diagnose(flow.id, secretDraft).executable, true);
  const missing = app.workflows.diagnose(flow.id, { ...secretDraft, secrets: { TOKEN: null } });
  assert.equal(missing.issues[0].code, 'missing-secret'); assert.equal(JSON.stringify(missing).includes('private-diagnostic-value'), false);
  assert.equal(calls, 0);
});
