import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { validateDefinition, redact } from '../lib/workflow-definition.mjs';
import { validateReferences, exportWorkflow, importWorkflow } from '../lib/workflow-file.mjs';
import { prepareRequest } from '../lib/workflow-step.mjs';
import { encryptState } from '../lib/vault.mjs';
import { validVaultKey } from '../public/vault-spec.js';

const password = 'vault-test-encryption-password';
const node = (id, type, config = {}) => ({ id, type, name: id, x: 36, y: 36, config });
const root = () => node('root', 'cron', { expression: '* * * * *', timezone: 'UTC' });
const request = (id = 'request', config = {}) => node(id, 'http', { method: 'POST', intent: 'read', url: 'https://example.invalid/notices', headers: '{"Authorization":"Bearer {{vault.api_token}}"}', body: '{"access":{"$path":"vault.api_token"}}', ...config });
const chain = nodes => ({ name: '공용 vault 참조', nodes, edges: nodes.slice(1).map((current, i) => ({ id: `${nodes[i].id}-${current.id}`, from: nodes[i].id, to: current.id, port: 'next' })) });

async function fixture(t, send = async () => new Response('{}')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-vault-'));
  const options = { dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, fetch: send }, logMaintenance: { autoStart: false } };
  let app = await createApp(options), base, cookie = '';
  await app.vault.setup(password); await app.workflowEngine.unlock();
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-vault-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    get app() { return app; }, directory,
    async restart() { await app.close(); app = await createApp(options); await app.vault.unlock(password); await app.workflowEngine.unlock(); },
    async call(url, method = 'GET', body, headers = {}) {
      if (!base) base = `http://127.0.0.1:${(await app.listen(0)).port}`;
      const response = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    },
    async put(key, value) { return app.secretStore.save({ version: app.secretStore.read().version, key, value }); },
    async flow(definition = chain([root(), request()])) { return app.workflows.create({ ...definition, requestId: randomUUID() }); },
    async run(flow) {
      const run = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
      await app.workflowEngine.tick();
      await Promise.all([...app.workflowEngine.jobs.values()].map(job => job.promise));
      return app.workflows.readRun(run.id);
    }
  };
}

test('vault API enforces authentication, origin and versions and returns only configured keys', async t => {
  const f = await fixture(t), value = 'private-api-registration-value';
  assert.equal((await f.call('/api/settings/vault')).status, 401);
  assert.equal((await f.call('/api/settings/vault', 'PUT', { version: 0, key: 'api_token', value })).status, 401);
  assert.equal((await f.call('/api/login', 'POST', { password })).status, 200);
  assert.deepEqual((await f.call('/api/settings/vault')).data, { version: 0, keys: [] });
  assert.equal((await f.call('/api/settings/vault', 'PUT', { version: 0, key: 'api_token', value }, { Origin: 'https://example.invalid' })).status, 403);
  const saved = await f.call('/api/settings/vault', 'PUT', { version: 0, key: 'api_token', value });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, { version: 1, keys: [{ key: 'api_token', configured: true }] });
  assert.equal((await f.call('/api/settings/vault', 'PUT', { version: 0, key: 'api_token', value: 'stale' })).status, 409);
  assert.equal(JSON.stringify((await f.call('/api/settings/vault')).data).includes(value), false);
  assert.equal((await f.call('/api/settings/vault', 'PUT', null)).status, 400);
  assert.equal((await f.call('/api/settings/vault', 'PUT', { version: 1, key: 'api_token', value: null })).status, 200);
  const changes = (await f.app.vault.snapshot()).changes.filter(row => row.action.startsWith('vault-'));
  assert.deepEqual(changes.map(row => row.after), [{ key: 'api_token', operation: 'created' }, { key: 'api_token', operation: 'deleted' }]);
  assert.equal(JSON.stringify(changes).includes(value), false);
});

test('vault key, value and capacity limits allow boundary values and preserve rejected writes', async t => {
  const f = await fixture(t);
  for (const key of ['api_token', 'a', 'a'.repeat(64)]) assert.equal(validVaultKey(key), true);
  for (const key of ['', 'API_TOKEN', 'a.b', 'a-b', 'a'.repeat(65), '__proto__', 'constructor', 'prototype']) {
    assert.equal(validVaultKey(key), false);
    await assert.rejects(f.put(key, 'value'));
  }
  for (const value of ['', undefined, 1, {}, 'x'.repeat(4001)]) await assert.rejects(f.put('bad_value', value));
  await f.put('api_token', '  keep surrounding whitespace  ');
  assert.equal(f.app.secretStore.resolve(['api_token']).api_token, '  keep surrounding whitespace  ');
  await f.put('api_token', 'x'.repeat(4000));
  for (let i = 0; i < 49; i++) await f.put('key_' + i, 'v');
  assert.equal(f.app.secretStore.read().keys.length, 50);
  await assert.rejects(f.put('extra', 'v'), /50/);
  await f.put('api_token', 'replacement');
  await f.put('key_0', null); await f.put('extra', 'v');
  assert.equal(f.app.secretStore.resolve(['api_token']).api_token, 'replacement');
});

test('workflow exchange declares vault keys without values and validates scope and key syntax', () => {
  const definition = chain([root(), request()]), file = exportWorkflow(definition);
  assert.deepEqual(file.requiredVaultKeys, ['api_token']);
  assert.deepEqual(importWorkflow(file, { executable: true }).requiredVaultKeys, ['api_token']);
  for (const requiredVaultKeys of [undefined, null, [], ['api_token', 'api_token'], ['other']]) assert.throws(() => importWorkflow({ ...file, requiredVaultKeys }));
  for (const bad of [request('request', { url: 'https://example.invalid/{{vault.api_token}}' }), request('request', { headers: '{"X-Key":"{{vault.api_token.nested}}"}' }), node('end', 'finish', { result: 'success', message: '{{vault.api_token}}' }), node('check', 'condition', { field: 'vault.api_token', operator: 'exists' })]) {
    assert.throws(() => validateReferences(validateDefinition(chain([root(), bad]), { executable: true })));
  }
  const literal = node('literal', 'context', { entries: [{ key: 'example', value: '{{vault.not_a_reference}}' }] });
  assert.equal(Object.hasOwn(exportWorkflow(chain([root(), literal])), 'requiredVaultKeys'), false);
  assert.throws(() => prepareRequest(request('request', { url: 'https://example.invalid/{{vault.api_token}}' }), { vault: { api_token: 'private' } }), /HTTP 헤더/);
});

test('missing vault values send zero requests and fail independently of HTTP retry and onError policies', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response('{}'); });
  for (const intent of ['read', 'change']) for (const onError of ['stop', 'continue', 'branch']) {
    const definition = chain([root(), request('request', { intent, onError, retries: 3, idempotency: 'verified' })]);
    if (onError === 'branch') {
      definition.nodes.push(node('handled', 'finish', { result: 'success' }));
      definition.edges.push({ id: 'error', from: 'request', to: 'handled', port: 'error' });
    }
    const result = await f.run(await f.flow(definition));
    assert.equal(result.status, 'failure'); assert.match(result.message, /vault.api_token/);
    assert.equal(result.steps.at(-1).attempts.length, 1);
    assert.equal(result.steps.at(-1).attempts[0].status, 'not-sent');
  }
  assert.equal(calls, 0);
});

test('shared values rotate within one execution, remain absent from definitions and redact echoed outputs', async t => {
  const oldValue = 'old-vault-private-value', newValue = 'new-vault-private-value', calls = [];
  let f;
  f = await fixture(t, async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) await f.put('api_token', newValue);
    const sentValue = options.headers.Authorization.slice(7);
    return new Response(JSON.stringify({ echo: options.headers.Authorization, [sentValue]: sentValue }));
  });
  await f.put('api_token', oldValue);
  const flow = await f.flow(chain([root(), request('first'), request('second')]));
  const result = await f.run(flow);
  assert.equal(result.status, 'success');
  assert.deepEqual(calls.map(call => call.headers.Authorization), ['Bearer ' + oldValue, 'Bearer ' + newValue]);
  assert.deepEqual(calls.map(call => JSON.parse(call.body).access), [oldValue, newValue]);
  const stored = await f.app.vault.getRecord('workflowRuns', result.id);
  for (const value of [oldValue, newValue]) {
    assert.equal(JSON.stringify(result).includes(value), false);
    assert.equal(JSON.stringify(stored).includes(value), false);
    assert.equal(JSON.stringify(exportWorkflow(flow)).includes(value), false);
  }
  const another = await f.flow(); assert.equal((await f.run(another)).status, 'success');
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer ' + newValue);
  await f.app.workflows.remove(flow.id, { version: flow.version });
  assert.equal(f.app.secretStore.resolve(['api_token']).api_token, newValue);
});

test('redaction masks matching JSON scalars recursively and preserves unrelated scalar types', () => {
  const input = { number: 123456789012, positive: true, negative: false, zero: 0, empty: null, nested: [123456789012, { value: false }] };
  assert.deepEqual(redact(input, ['123456789012', 'true', 'false', '0', 'null']), {
    number: '[가림]', positive: '[가림]', negative: '[가림]', zero: '[가림]', empty: '[가림]', nested: ['[가림]', { value: '[가림]' }]
  });
  const ordinary = { count: 42, enabled: true, disabled: false, zero: 0, optional: null, nested: [12, true, false, null] };
  assert.deepEqual(redact(ordinary, ['unrelated-private-value']), ordinary);
  assert.equal(redact(1234, ['123']), 1234);
  assert.equal(redact(true, ['tr']), true);
  assert.equal(redact(false, ['false']), '[가림]');
  assert.equal(redact(0, ['0']), '[가림]');
  assert.equal(redact(null, ['null']), '[가림]');
  assert.deepEqual(input, { number: 123456789012, positive: true, negative: false, zero: 0, empty: null, nested: [123456789012, { value: false }] });
});

test('numeric and boolean vault echoes are masked before storage and API reads while downstream comparisons keep their types', async t => {
  const f = await fixture(t, async (_url, options) => {
    const value = JSON.parse(options.headers.Authorization.slice(7));
    return new Response(JSON.stringify({ echo: value, same: value, nested: [value, { echo: value }], count: 42, enabled: value !== true, optional: value === null ? 'available' : null }));
  });
  await f.call('/api/login', 'POST', { password });
  const definition = chain([root(), request(), node('check', 'condition', { field: 'response.body.echo', operator: 'equals', valueSource: 'path', value: 'response.body.same' })]);
  definition.nodes.push(node('success', 'finish', { result: 'success' }), node('failure', 'finish', { result: 'failure' }));
  definition.edges.push({ id: 'matched', from: 'check', to: 'success', port: 'true' }, { id: 'unmatched', from: 'check', to: 'failure', port: 'false' });
  const flow = await f.flow(definition);
  for (const secret of ['123456789012', 'true', 'false', '0', 'null']) {
    await f.put('api_token', secret);
    const result = await f.run(flow);
    assert.equal(result.status, 'success');
    await f.put('api_token', null);
    const stored = await f.app.vault.getRecord('workflowRuns', result.id);
    const response = await f.call('/api/workflow-runs/' + result.id);
    assert.equal(response.status, 200);
    for (const run of [result, stored, response.data]) {
      const body = run.steps.find(step => step.nodeId === 'request').output.body;
      assert.deepEqual(body, {
        echo: '[가림]', same: '[가림]', nested: ['[가림]', { echo: '[가림]' }], count: 42, enabled: secret !== 'true', optional: secret === 'null' ? 'available' : null
      });
    }
  }
});

test('deleting a key during execution stops the next HTTP and reruns resolve current server values', async t => {
  let f, calls = 0;
  f = await fixture(t, async () => { calls++; await f.put('api_token', null); return new Response('{}'); });
  await f.put('api_token', 'value-before-delete');
  const flow = await f.flow(chain([root(), request('first'), request('second')]));
  const result = await f.run(flow);
  assert.equal(result.status, 'failure'); assert.equal(calls, 1); assert.match(result.message, /vault.api_token/);
  const rerun = await f.app.workflows.rerun(result.id, { requestId: randomUUID() });
  await f.app.workflowEngine.tick(); await Promise.all([...f.app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.equal((await f.app.workflows.readRun(rerun.id)).status, 'failure'); assert.equal(calls, 1);
});

test('each HTTP retry resolves the latest value and deleted keys prevent the retry dispatch', async t => {
  let f; const calls = [];
  f = await fixture(t, async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (calls.length === 1) { await f.put('api_token', 'rotated-retry-value'); throw Error('response lost'); }
    await f.put('api_token', null); throw Error('response lost again');
  });
  await f.put('api_token', 'initial-retry-value');
  const result = await f.run(await f.flow(chain([root(), request('request', { retries: 3, onError: 'continue' })])));
  assert.deepEqual(calls, ['Bearer initial-retry-value', 'Bearer rotated-retry-value']);
  assert.equal(result.status, 'failure'); assert.match(result.message, /vault.api_token/);
});

test('Dry-Run uses masked placeholders without reading registered values or writing execution history', async t => {
  const f = await fixture(t, async () => { throw Error('Dry-Run must not send'); });
  const flow = await f.flow();
  const setup = { now: '2031-04-03T00:00:00.000Z', nodes: { root: { type: 'cron', trigger: '{}' }, request: { type: 'http', outcome: 'response', status: '200', headers: '{}', body: '{}' } } };
  assert.equal(f.app.workflows.dryRun(flow.id, { definition: flow, setup }).status, 'success');
  const value = 'never-copy-this-vault-value'; await f.put('api_token', value);
  const before = await f.app.vault.snapshot();
  const dry = f.app.workflows.dryRun(flow.id, { definition: flow, setup });
  assert.equal(dry.status, 'success'); assert.equal(JSON.stringify(dry).includes(value), false);
  assert.deepEqual(dry.steps.at(-1).vaultKeys, ['api_token']);
  assert.equal(dry.steps.at(-1).request.headers.Authorization, '[가림]');
  assert.deepEqual(await f.app.vault.snapshot(), before);
});

test('vault survives encrypted storage restart and corruption fails before any HTTP', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response('{}'); });
  const value = 'encrypted-store-private-value';
  await f.put('api_token', value); const flow = await f.flow();
  assert.equal((await fs.readFile(path.join(f.directory, 'store.json'), 'utf8')).includes(value), false);
  await f.restart();
  assert.equal(f.app.secretStore.resolve(['api_token']).api_token, value);
  assert.equal((await f.run(flow)).status, 'success');
  const original = f.app.vault.state.secretStore;
  try {
    f.app.vault.state.secretStore = { version: 1, entries: { api_token: '' } };
    const result = await f.run(flow);
    assert.equal(result.status, 'failure'); assert.match(result.message, /비밀 값 저장소/); assert.equal(calls, 1);
  } finally { f.app.vault.state.secretStore = original; }
});

test('failed vault writes preserve the previous value, version and audit and locked reads fail', async t => {
  const f = await fixture(t); await f.put('api_token', 'preserved-private-value');
  const before = await f.app.vault.snapshot(), write = f.app.vault.write;
  try {
    f.app.vault.write = async () => { throw Error('simulated write failure'); };
    await assert.rejects(f.put('api_token', 'must-not-be-committed'), /write failure/);
    assert.deepEqual(await f.app.vault.snapshot(), before);
  } finally { f.app.vault.write = write; }
  const key = f.app.vault.key;
  try {
    f.app.vault.key = null;
    assert.throws(() => f.app.secretStore.read(), /잠금/);
    assert.throws(() => f.app.secretStore.resolve(['api_token']), /잠금/);
  } finally { f.app.vault.key = key; }
});

test('partial resets retain global vault values and full system reset removes them', async t => {
  const f = await fixture(t); await f.put('api_token', 'keep-until-system-reset');
  await f.call('/api/login', 'POST', { password });
  for (const target of ['audit', 'events', 'workflows']) {
    const result = await f.call('/api/settings/reset', 'POST', { target, confirmed: true, requestId: randomUUID(), password });
    assert.equal(result.status, 200, result.data.error);
    assert.equal(f.app.secretStore.resolve(['api_token']).api_token, 'keep-until-system-reset');
  }
  assert.equal((await f.call('/api/settings/reset', 'POST', { target: 'system', confirmed: true, requestId: randomUUID(), password })).status, 200);
  assert.equal(f.app.vault.initialized, false);
  await f.app.vault.setup(password);
  assert.deepEqual(f.app.secretStore.read(), { version: 0, keys: [] });
});

test('pre-vault schema 5 installations upgrade without rewriting or losing existing records', async t => {
  for (const format of ['daily', 'single-file']) await t.test(format, async t => {
    const f = await fixture(t);
    const flow = await f.flow(chain([root(), node('done', 'finish', { result: 'success', message: '기존 워크플로우' })]));
    await f.app.vault.add({ title: '업데이트 전 이벤트', category: 'maintenance', services: [], start: '2031-04-03T00:00:00.000Z', end: null });
    await f.app.vault.mutate(state => { state.workflows.find(item => item.id === flow.id).secrets = { OLD: 'pre-vault-existing-secret' }; }, { scope: {} });
    const before = await f.app.vault.snapshot();
    assert.equal(before.schemaVersion, 5); assert.equal(Object.hasOwn(before, 'secretStore'), false);
    if (format === 'single-file') await f.app.vault.write(encryptState(before, f.app.vault.key, f.app.vault.envelope.kdf));
    const file = path.join(f.directory, 'store.json'), originalFile = await fs.readFile(file);
    await f.restart();
    assert.deepEqual(f.app.secretStore.read(), { version: 0, keys: [] });
    assert.deepEqual(await f.app.vault.snapshot(), before);
    assert.deepEqual(await fs.readFile(file), originalFile);
    await f.put('api_token', 'first-value-after-upgrade');
    await f.restart();
    const after = await f.app.vault.snapshot();
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.workflows, before.workflows);
    assert.equal(f.app.secretStore.resolve(['api_token']).api_token, 'first-value-after-upgrade');
    assert.equal(after.changes.length, before.changes.length + 1);
  });
});
