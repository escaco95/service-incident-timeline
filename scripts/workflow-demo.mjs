// All requests stay on an ephemeral loopback fixture; no business API or secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { importWorkflow } from '../lib/workflow-file.mjs';
import { TERMINAL } from '../lib/workflows.mjs';

const mode = process.argv[2] ?? 'success';
if (!['success', 'response-lost', 'accepted', 'mismatch', 'duplicates', 'unknown-service'].includes(mode)) throw Error('Unknown fixture scenario');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-demo-'));
let app, state = '', reads = 0; const calls = [];
const remote = http.createServer(async (req, res) => {
  calls.push(req.method);
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(typeof body.state, 'string'); assert.match(body.requestedAt, /\+09:00$/); state = body.state;
    if (mode === 'response-lost') { req.socket.destroy(); return; }
    res.writeHead(mode === 'accepted' ? 202 : 200, { 'Content-Type': 'application/json' }); res.end('{}');
  } else {
    reads++; const item = { id: 'virtual-resource', name: 'resource-a', state: mode === 'mismatch' && reads > 1 ? '' : state };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items: mode === 'duplicates' ? [item, item] : [item], privateBusiness: 'never-store-this-body' }));
  }
});
try {
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const file = JSON.parse(await fs.readFile(new URL('../examples/workflows/service-state-http.json', import.meta.url), 'utf8'));
  for (const node of file.definition.nodes.filter(node => node.type === 'http')) node.config.url = node.config.url.replace(':8788', ':' + remote.address().port);
  const { definition } = importWorkflow(file, { executable: true });
  app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } });
  await app.vault.setup('temporary-workflow-demo'); await app.workflowEngine.unlock();
  const flow = await app.workflows.create({ ...definition, requestId: randomUUID() });
  const service = mode === 'unknown-service' ? 'unmapped-resource' : 'resource-a';
  await app.vault.add({ title: 'Virtual event', description: '', services: [{ kind: 'custom', label: service }], category: 'incident', start: new Date(Date.now() - 1000).toISOString(), end: null });
  const run = await app.workflows.run(flow.id, { service, version: flow.version, requestId: randomUUID() });
  await app.workflowEngine.tick(); let result;
  const deadline = Date.now() + 10000;
  do { result = await app.workflows.readRun(run.id); if (TERMINAL.has(result.status)) break; await delay(10); } while (Date.now() < deadline);
  assert.equal(result.status, mode === 'success' ? 'success' : mode === 'unknown-service' ? 'skipped' : 'review');
  assert.equal(calls.filter(method => method === 'POST').length, ['duplicates', 'unknown-service'].includes(mode) ? 0 : 1);
  const stored = await app.vault.snapshot(); assert.equal(JSON.stringify(stored.workflowRuns).includes('never-store-this-body'), false);
  assert.equal(Boolean(app.workflows.serviceStates().find(item => item.service === service)?.hold), result.status === 'review');
  console.log(JSON.stringify({ scenario: mode, status: result.status, calls, steps: result.steps.length, parentId: result.parentId }));
} finally {
  await app?.close(); await new Promise(resolve => remote.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^workflow-demo-/);
  await fs.rm(directory, { recursive: true, force: true });
}
