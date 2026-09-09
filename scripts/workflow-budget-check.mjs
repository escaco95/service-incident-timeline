import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { TERMINAL } from '../lib/workflows.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-budget-'));
let app, calls = 0;
const remote = http.createServer(async (_req, res) => { calls++; await delay(2); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
try {
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } });
  await app.vault.setup('workflow-budget-password'); await app.workflowEngine.unlock();
  for (const kind of ['condition', 'http']) for (const count of [20, 60, 100]) {
    const n = (id, type, config) => ({ id, type, config, name: id, x: 36, y: 36 });
    const config = kind === 'condition' ? { field: 'run.id', operator: 'isPresent' } : { method: 'GET', intent: 'read', url: `http://127.0.0.1:${remote.address().port}`, outputMode: 'none' };
    const nodes = [n('root', 'cron', { expression: '* * * * *', timezone: 'UTC' }), ...Array.from({ length: count - 2 }, (_, i) => n('n' + i, kind, config)), n('done', 'finish', { result: 'success', message: '' })];
    const edges = nodes.slice(1).map((node, i) => ({ id: 'e' + i, from: nodes[i].id, to: node.id, port: nodes[i].type === 'condition' ? 'true' : 'next' }));
    const flow = await app.workflows.create({ name: `${kind}-${count}`, nodes, edges, requestId: randomUUID() });
    const start = Date.now(), before = calls;
    const run = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
    await app.workflowEngine.tick(); let result;
    do { result = await app.workflows.readRun(run.id); if (TERMINAL.has(result.status)) break; await delay(20); } while (Date.now() - start < 120000);
    assert.equal(result.status, 'success'); assert.equal(result.steps.length, count); assert.equal(calls - before, kind === 'http' ? count - 2 : 0);
    console.log(JSON.stringify({ kind, nodes: count, httpCalls: calls - before, elapsedMs: Date.now() - start, runBytes: Buffer.byteLength(JSON.stringify(result)), heapBytes: process.memoryUsage().heapUsed }));
  }
} finally {
  await app?.close(); await new Promise(resolve => remote.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^workflow-budget-/); await fs.rm(directory, { recursive: true, force: true });
}
