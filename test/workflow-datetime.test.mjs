import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { dateValue, parseDateInstant } from '../lib/workflow-values.mjs';
import { DATETIME_LIMITS, parseDatePattern } from '../public/workflow-spec.js';
import { validateDefinition, bodyTemplate } from '../lib/workflow-definition.mjs';
import { diagnoseWorkflow } from '../lib/workflow-diagnostics.mjs';
import { importWorkflow, exportWorkflow, fileSchema } from '../lib/workflow-file.mjs';
import { dryRunWorkflow } from '../lib/workflow-dry-run.mjs';
import { mergeDryRunSetup } from '../public/workflow-dry-run-spec.js';
import { createApp } from '../server.mjs';

const at = '2031-04-03T07:08:09.123Z';
const config = { source: 'now', timezone: 'UTC', format: 'custom', pattern: 'yyyy/MM/dd HH:mm:ss' };
const node = (id, type, config) => ({ id, type, name: id, x: 36, y: 36, config });
const edge = (from, to) => ({ id: `${from}-${to}`, from, to, port: 'next' });
const definition = (timestamp = at, extra = {}) => ({ name: 'Date formatting', nodes: [
  node('root', 'cron', { expression: '* * * * *', timezone: 'UTC' }),
  node('input', 'context', { entries: [{ key: 'timestamp', value: timestamp }] }),
  node('clock', 'datetime', { ...config, source: 'context.timestamp', ...extra }),
  node('http', 'http', { method: 'POST', intent: 'read', url: 'https://example.invalid/date', headers: '{}', body: '{"formatted":"{{nodes.clock.value}}","compact":"{{nodes.clock.components.year}}{{nodes.clock.components.month}}{{nodes.clock.components.day}}","offset":"{{nodes.clock.components.offset}}"}', onError: 'stop' }),
  node('done', 'finish', { result: 'success', message: '' })
], edges: [edge('root', 'input'), edge('input', 'clock'), edge('clock', 'http'), edge('http', 'done')] });

test('datetime custom patterns, literals, components and all existing presets', () => {
  const result = dateValue(config, {}, at);
  assert.equal(result.value, '2031/04/03 07:08:09');
  assert.equal(result.iso, at); assert.equal(result.evaluatedAt, at);
  assert.deepEqual(result.components, { year: '2031', month: '04', day: '03', hour: '07', minute: '08', second: '09', millisecond: '123', offset: '+00:00' });
  for (const [pattern, expected] of [
    ['yyyyMMddHHmmss', '20310403070809'],
    ["yyyyMMdd'T'HHmmss.SSS XXX", '20310403T070809.123 +00:00'],
    ["yyyy'년' MM'월' dd'일' HH:mm:ss", '2031년 04월 03일 07:08:09'],
    ["yyyy 'it''s UTC' ''", "2031 it's UTC '"],
    ["yyyy '{{secrets.LITERAL}}'", '2031 {{secrets.LITERAL}}']
  ]) assert.equal(dateValue({ ...config, pattern }, {}, at).value, expected);
  for (const [format, expected] of [['iso', at], ['local', '2031-04-03T07:08:09+00:00'], ['date', '2031-04-03'], ['time', '07:08:09'], ['unix-ms', Date.parse(at)]]) {
    const value = dateValue({ ...config, format, pattern: '' }, {}, at);
    assert.equal(value.value, expected); assert.equal(value.components.year, '2031');
  }
  const body = bodyTemplate('{"value":"{{nodes.clock.components.year}}/{{nodes.clock.components.month}}/{{nodes.clock.components.day}}"}', { nodes: { clock: result } });
  assert.deepEqual(JSON.parse(body), { value: '2031/04/03' });
});

test('datetime uses local calendar years, midnight, date boundaries and DST offsets', () => {
  const render = (instant, timezone = 'UTC') => dateValue({ ...config, timezone, pattern: "yyyy-MM-dd'T'HH:mm:ssXXX" }, {}, instant).value;
  assert.equal(render('2031-04-03T15:00:00Z', 'Asia/Seoul'), '2031-04-04T00:00:00+09:00');
  assert.equal(render('2020-12-31T15:00:00Z', 'Asia/Seoul'), '2021-01-01T00:00:00+09:00');
  assert.equal(render('2021-01-01T00:00:00Z', 'America/Los_Angeles'), '2020-12-31T16:00:00-08:00');
  assert.equal(render('2024-02-29T23:59:59Z'), '2024-02-29T23:59:59+00:00');
  assert.equal(render('2031-04-03T07:08:09+05:45'), '2031-04-03T01:23:09+00:00');
  assert.equal(render('2031-04-03T00:00Z', 'Asia/Kathmandu'), '2031-04-03T05:45:00+05:45');
  for (const [instant, expected] of [
    ['2025-03-09T06:59:59Z', '2025-03-09T01:59:59-05:00'],
    ['2025-03-09T07:00:00Z', '2025-03-09T03:00:00-04:00'],
    ['2025-11-02T05:30:00Z', '2025-11-02T01:30:00-04:00'],
    ['2025-11-02T06:30:00Z', '2025-11-02T01:30:00-05:00']
  ]) assert.equal(render(instant, 'America/New_York'), expected);
  assert.equal(render('0001-01-01T00:00:00Z'), '0001-01-01T00:00:00+00:00');
  const input = { trigger: { scheduledAt: '2031-04-03T00:00:00Z' } };
  assert.equal(dateValue({ ...config, source: 'trigger.scheduledAt' }, input, at).value, '2031/04/03 00:00:00');
  assert.equal(dateValue(config, input, at).value, '2031/04/03 07:08:09');
});

test('datetime rejects unsupported patterns, invalid calendar dates and implicit time zones', () => {
  for (const pattern of ['', 'YYYY/MM/dd', 'yyyy/MMMM/dd', 'yy/MM/dd', 'yyyy-MM-ddTHH:mm:ss', "yyyy 'open", 'yyyy\nMM', 'yyyy' + ' '.repeat(125), '---']) {
    assert.throws(() => parseDatePattern(pattern));
    assert.throws(() => validateDefinition(definition(at, { pattern }), { executable: true }));
  }
  for (const invalid of [null, 0, {}, '', '2031-04-03', '2031-04-03T07:08:09', '2031-02-29T00:00:00Z', '2031-02-30T00:00:00Z', '2031-04-31T00:00:00Z', '2031-13-01T00:00:00Z', '2031-01-00T00:00:00Z', '2031-01-01T24:00:00Z', '2031-01-01T00:00:60Z', '2031-01-01T00:00:00+24:00', '0000-01-01T00:00:00Z']) assert.throws(() => parseDateInstant(invalid), /ISO/);
  for (const timezone of ['', 'Invalid/Zone', '+09:00', null]) assert.throws(() => dateValue({ ...config, timezone }, {}, at), /시간대/);
  assert.throws(() => dateValue({ ...config, format: 'script' }, {}, at), /형식/);
  const bounded = dateValue({ ...config, pattern: 'XXX '.repeat(32) }, {}, at).value;
  assert.equal(bounded.length, 224); assert.ok(bounded.length <= DATETIME_LIMITS.output);
});

test('datetime configuration round-trips through files, schema and the CLI validator', async t => {
  const def = definition(at, { pattern: "yyyyMMdd 'UTC'" });
  const file = exportWorkflow(def), imported = importWorkflow(file, { executable: true });
  assert.deepEqual(exportWorkflow(imported.definition), file);
  const literalFile = exportWorkflow(definition(at, { pattern: "yyyy '{{secrets.LITERAL}}'" }));
  assert.equal('requiredSecrets' in literalFile, false);
  assert.equal(importWorkflow(literalFile, { executable: true }).executable, true);
  const schema = fileSchema().properties.definition.properties.nodes.items.oneOf.find(item => item.properties.type.const === 'datetime').properties.config;
  assert.ok(schema.properties.format.enum.includes('custom')); assert.equal(schema.properties.pattern.maxLength, 128);
  assert.deepEqual(schema.allOf[0].then.required, ['pattern']);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-datetime-cli-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-datetime-cli-')); await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'workflow.json'); await fs.writeFile(filename, JSON.stringify(file));
  const run = promisify(execFile), cli = new URL('../scripts/workflow-validate.mjs', import.meta.url);
  const { stdout } = await run(process.execPath, [fileURLToPath(cli), filename]);
  assert.equal(JSON.parse(stdout).executable, true);
  file.definition.nodes.find(item => item.type === 'datetime').config.pattern = 'YYYY'; await fs.writeFile(filename, JSON.stringify(file));
  await assert.rejects(run(process.execPath, [fileURLToPath(cli), filename]), error => error.code === 1);
});

test('datetime diagnostics cover source, timezone, format and custom pattern errors', () => {
  for (const [change, message, saveAllowed = true] of [
    [{ source: '' }, /값 경로/],
    [{ source: 'unknown.timestamp' }, /값 경로/],
    [{ timezone: '' }, /IANA/],
    [{ timezone: '+09:00' }, /IANA/],
    [{ timezone: 'Invalid/Zone' }, /IANA/],
    [{ format: 'unknown' }, /출력 형식/],
    [{ pattern: '' }, /1~128/],
    [{ pattern: 'YYYY/MM/dd' }, /토큰/],
    [{ pattern: "yyyy 'open" }, /작은따옴표/],
    [{ pattern: 'yyyy\nMM' }, /줄바꿈/],
    [{ pattern: '---' }, /토큰/],
    [{ pattern: 'yyyy' + ' '.repeat(125) }, /pattern.*길이/, false]
  ]) {
    const draft = definition(at, change), result = diagnoseWorkflow(draft);
    assert.equal(result.executable, false, JSON.stringify(change));
    assert.equal(result.saveAllowed, saveAllowed);
    assert.deepEqual(result.issues[0].nodeIds, ['clock']);
    assert.match(result.issues[0].message, message);
    assert.throws(() => validateDefinition(draft, { executable: true }), { message: result.issues[0].message });
    assert.equal(diagnoseWorkflow(draft, { enabled: true }).saveAllowed, false);
  }
});

test('datetime diagnostics show independent errors together and clear as fields are corrected', () => {
  const draft = definition(at, { timezone: 'Invalid/Zone', pattern: 'YYYY' });
  const issues = diagnoseWorkflow(draft).issues;
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map(issue => [issue.code, ...issue.nodeIds]), [['node-config', 'clock'], ['node-config', 'clock']]);
  assert.match(issues[0].message, /IANA/); assert.match(issues[1].message, /토큰/);
  const clock = draft.nodes.find(item => item.id === 'clock');
  clock.config.timezone = 'UTC';
  assert.deepEqual(diagnoseWorkflow(draft).issues, [issues[1]]);
  clock.config.pattern = config.pattern;
  assert.deepEqual(diagnoseWorkflow(draft, { enabled: true }), { executable: true, saveAllowed: true, issues: [] });
  Object.assign(clock.config, { source: '', format: 'unknown', timezone: '+09:00' });
  assert.equal(diagnoseWorkflow(draft).issues.filter(issue => issue.code === 'node-config').length, 3);
});

test('datetime diagnostics check input availability and preserve literal patterns and preset outputs', () => {
  for (const [source, message] of [['context.missing', /주입/], ['nodes.http.body.timestamp', /먼저 실행/], ['response.body.timestamp', /HTTP 응답/], ['event.start', /이 트리거/]]) {
    const result = diagnoseWorkflow(definition(at, { source }));
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'reference');
    assert.deepEqual(result.issues[0].nodeIds, ['clock']);
    assert.match(result.issues[0].message, message);
  }
  assert.deepEqual(diagnoseWorkflow(definition(at, { pattern: "yyyy '{{secrets.LITERAL}}'" })).issues, []);
  for (const format of ['iso', 'local', 'date', 'time', 'unix-ms']) {
    assert.deepEqual(diagnoseWorkflow(definition(at, { format, pattern: 'unused invalid pattern' })).issues, []);
  }
  assert.deepEqual(diagnoseWorkflow(definition(at, { source: 'now' })).issues, []);
});

test('Dry-Run passes exact formatted and component strings to its mock HTTP body', () => {
  const def = definition(at, { source: 'now' }), setup = mergeDryRunSetup(def, {}, '2031-04-04T00:01:02Z');
  const result = dryRunWorkflow(def, setup);
  assert.equal(result.status, 'success');
  assert.deepEqual(JSON.parse(result.steps.find(step => step.nodeId === 'http').request.body), { formatted: '2031/04/04 00:01:02', compact: '20310404', offset: '+00:00' });
  for (const bad of ['2031-02-30T00:00:00Z', 'not-a-date']) {
    const invalid = definition(bad), failed = dryRunWorkflow(invalid, mergeDryRunSetup(invalid, {}, at));
    assert.equal(failed.status, 'failure'); assert.equal(failed.steps.at(-1).nodeId, 'clock');
    assert.ok(!failed.steps.some(step => step.nodeId === 'http'));
  }
  assert.throws(() => dryRunWorkflow(def, { ...setup, now: '2031-02-30T00:00:00Z' }), /기준 시각/);
});

test('real datetime execution formats before HTTP and stops invalid input before sending', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-datetime-run-'));
  const requests = []; let now = at;
  const app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false, clock: () => now, fetch: async (url, options) => {
    if (String(url).endsWith('/advance')) { now = '2031-04-04T00:01:02.000Z'; return new Response('{}'); }
    requests.push(JSON.parse(options.body)); return new Response('{}');
  } }, logMaintenance: { autoStart: false } });
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-datetime-run-')); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await app.vault.setup('datetime-integration-password'); await app.workflowEngine.unlock();
  async function execute(def) {
    const flow = await app.workflows.create({ ...def, requestId: randomUUID() });
    const started = await app.workflows.run(flow.id, { version: flow.version, requestId: randomUUID() });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await app.workflowEngine.tick(); const run = await app.workflows.readRun(started.id);
      if (!['queued', 'running'].includes(run.status)) return run;
      await delay(10);
    }
    throw new Error('datetime run timed out');
  }
  const first = await execute(definition()); assert.equal(first.status, 'success', JSON.stringify(first));
  assert.deepEqual(requests, [{ formatted: '2031/04/03 07:08:09', compact: '20310403', offset: '+00:00' }]);
  for (const invalid of ['2031-02-30T00:00:00Z', '2031-04-03T07:08:09', 'invalid']) {
    const result = await execute(definition(invalid));
    assert.equal(result.status, 'failure'); assert.equal(result.steps.at(-1).nodeId, 'clock');
  }
  assert.equal(requests.length, 1);
  const live = definition(at, { source: 'now' });
  live.nodes.splice(2, 0, node('advance', 'http', { method: 'GET', url: 'https://example.invalid/advance', onError: 'stop' }));
  live.edges = live.edges.filter(item => item.from !== 'input').concat(edge('input', 'advance'), edge('advance', 'clock'));
  assert.equal((await execute(live)).status, 'success');
  assert.equal(requests[1].formatted, '2031/04/04 00:01:02');
});
