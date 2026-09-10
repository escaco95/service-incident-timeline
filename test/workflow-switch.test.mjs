import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { validateDefinition } from '../lib/workflow-definition.mjs';
import { importWorkflow, exportWorkflow, validateReferences } from '../lib/workflow-file.mjs';
import { evaluateStep } from '../lib/workflow-step.mjs';
import { dryRunWorkflow } from '../lib/workflow-dry-run.mjs';
import { mergeDryRunSetup } from '../public/workflow-dry-run-spec.js';
import { ports, validateSwitchCases } from '../public/workflow-spec.js';
import { diagnoseWorkflow } from '../lib/workflow-diagnostics.mjs';

const node = (id, type, config) => ({ id, name:id, type, x:36, y:36, config });
const edge = (from, to, port = 'next') => ({ id:`${from}-${port}-${to}`, from, to, port });
const cases = ['A', 'B', 200, '200', true, false, null, ''].map((value, i) => ({ id:`case-${i}`, value }));
const make = () => ({ name:'Switch fixture', nodes:[node('root', 'service-state', { service:'' }), node('route', 'switch', { field:'trigger.service', cases:structuredClone(cases) }), ...[...cases.map(entry => entry.id), 'default'].map(port => node('end-' + port, 'finish', { result:'success', message:port }))], edges:[edge('root', 'route'), ...[...cases.map(entry => entry.id), 'default'].map(port => edge('route', 'end-' + port, port))] });

test('switch selects one typed case, uses default for missing/objects, and never evaluates literal templates', () => {
  const route = make().nodes[1], context = { trigger:{} };
  for (const entry of cases) {
    context.trigger.service = entry.value;
    const result = evaluateStep(route, context, '');
    assert.equal(result.port, entry.id); assert.deepEqual(result.output, { matched:true, port:entry.id });
  }
  for (const value of [undefined, 'unknown', {}, [], 'true', 0]) {
    context.trigger.service = value;
    assert.deepEqual(evaluateStep(route, context, '').output, { matched:false, port:'default' });
  }
  route.config.cases = [{ id:'case-literal', value:'{{secrets.TOKEN}}' }];
  context.trigger.service = '{{secrets.TOKEN}}';
  assert.equal(evaluateStep(route, context, '').port, 'case-literal');
  assert.equal(Object.hasOwn(exportWorkflow(make()), 'requiredSecrets'), false);
});

test('switch validates typed duplicates, stable ports, references, and file round trips', () => {
  const def = make(), normalized = validateDefinition(def, { executable:true });
  assert.deepEqual(ports(normalized.nodes[1]), [...cases.map(entry => entry.id), 'default']);
  assert.deepEqual(importWorkflow(exportWorkflow(def), { executable:true }).definition, normalized);
  for (const invalid of [null, {}, [{ id:'default', value:'A' }], [{ id:'case-x', value:undefined }], [{ id:'case-x', value:{} }], [{ id:'case-x', value:[] }], [{ id:'case-x', value:Infinity }], [{ id:'case-x', value:'x'.repeat(2001) }], [{ id:'case-x', value:'A', extra:true }], [{ id:'case-x', value:1 }, { id:'case-y', value:1 }], [{ id:'case-x', value:0 }, { id:'case-y', value:-0 }], [{ id:'case-x', value:'A' }, { id:'case-x', value:'B' }], Array.from({length:21},(_,i)=>({id:'case-'+i,value:i}))]) assert.throws(() => validateSwitchCases(invalid));
  const badPort = structuredClone(def); badPort.edges[1].port = 'case-missing';
  assert.throws(() => validateDefinition(badPort), /연결/);
  const badRef = structuredClone(def);
  for (const field of ['event.title', 'response.status', 'context.missing', 'nodes.end-default.message', 'secrets.__proto__']) {
    badRef.nodes[1].config.field = field;
    assert.throws(() => validateReferences(validateDefinition(badRef, { executable:true })));
  }
  badRef.nodes[1].config.field = 'secrets.TOKEN';
  assert.deepEqual(exportWorkflow(badRef).requiredSecrets, ['TOKEN']);
  const literal = make(); literal.nodes[1].config.cases[0].value = '{{secrets.NOT_A_REFERENCE}}';
  assert.equal(Object.hasOwn(exportWorkflow(literal), 'requiredSecrets'), false);
});

test('Dry-Run follows only the chosen switch branch with the real evaluator', () => {
  const def = make(), setup = mergeDryRunSetup(def, {}, '2026-09-10T00:00:00.000Z');
  for (const [value, port] of [...cases.map(entry => [entry.value, entry.id]), ['other', 'default'], [undefined, 'default']]) {
    setup.nodes.root.trigger = JSON.stringify({ service:value, scheduledAt:setup.now });
    const result = dryRunWorkflow(def, setup);
    assert.equal(result.status, 'success'); assert.equal(result.message, port);
    assert.deepEqual(result.steps.map(step => step.nodeId), ['root', 'route', 'end-' + port]);
    assert.equal(result.followedEdges.length, 2); assert.equal(result.skipped.length, cases.length);
  }
  const unconnected = make(); unconnected.nodes = unconnected.nodes.slice(0, 2); unconnected.edges = [edge('root', 'route')];
  setup.nodes.root.trigger = JSON.stringify({ service:'missing', scheduledAt:setup.now });
  assert.equal(dryRunWorkflow(unconnected, setup).status, 'success');
});

test('switch diagnostics identify invalid paths, case values, IDs and limits on the switch node', () => {
  for (const [config, message, saveAllowed] of [
    [{field:''}, /경로/, true],
    [{field:'unknown.value'}, /경로/, true],
    [{field:'trigger.__proto__'}, /경로/, true],
    [{field:'trigger.'+'x'.repeat(201)}, /길이/, false],
    [{cases:null}, /최대 20/, false],
    [{cases:[{id:'case-a',value:'A'},{id:'case-b',value:'A'}]}, /중복된 분기 값/, false],
    [{cases:[{id:'case-a',value:0},{id:'case-b',value:-0}]}, /중복된 분기 값/, false],
    [{cases:[{id:'case-a',value:'A'},{id:'case-a',value:'B'}]}, /분기 ID/, false],
    [{cases:[{id:'default',value:'A'}]}, /분기 ID/, false],
    ...[{},[],undefined,Infinity,'x'.repeat(2001)].map(value=>[{cases:[{id:'case-a',value}]}, /분기 값/, false]),
    [{cases:Array.from({length:21},(_,i)=>({id:'case-'+i,value:i}))}, /최대 20/, false]
  ]) {
    const draft = make(); Object.assign(draft.nodes[1].config,config);
    const result = diagnoseWorkflow(draft);
    assert.equal(result.executable,false); assert.equal(result.saveAllowed,saveAllowed);
    assert.deepEqual(result.issues[0].nodeIds,['route']); assert.match(result.issues[0].message,message);
    assert.throws(()=>validateDefinition(draft,{executable:true}),{message:result.issues[0].message});
    assert.equal(diagnoseWorkflow(draft,{enabled:true}).saveAllowed,false);
  }
  assert.deepEqual(diagnoseWorkflow(make()),{executable:true,saveAllowed:true,issues:[]});
});

test('switch diagnostics check input availability and ignore literal case text and unconnected outputs', () => {
  for (const [field,message] of [['event.title',/단일 이벤트/],['response.status',/HTTP 응답/],['nodes.end-default.message',/먼저 실행/],['context.service',/먼저 주입/],['secrets.MISSING',/기존 비밀 변수/]]) {
    const draft = make(); draft.nodes[1].config.field = field;
    const result = diagnoseWorkflow(draft);
    assert.equal(result.issues.length,1); assert.equal(result.executable,false); assert.equal(result.saveAllowed,true);
    assert.deepEqual(result.issues[0].nodeIds,['route']); assert.match(result.issues[0].message,message);
  }
  const draft = make(), route = draft.nodes[1];
  route.config.field = 'context.service';
  draft.nodes.splice(1,0,node('values','context',{entries:[{key:'service',value:'A'}]}));
  draft.edges[0] = edge('root','values'); draft.edges.push(edge('values','route'));
  assert.equal(diagnoseWorkflow(draft).executable,true);
  route.config.field = 'response.status';
  assert.equal(diagnoseWorkflow(draft).executable,false);
  draft.nodes.splice(2,0,node('http','http',{url:'https://example.invalid',method:'GET'}));
  draft.edges[draft.edges.length-1] = edge('values','http'); draft.edges.push(edge('http','route'));
  assert.equal(diagnoseWorkflow(draft).executable,true);
  route.config.field = 'nodes.http.status'; assert.equal(diagnoseWorkflow(draft).executable,true);
  route.config.field = 'secrets.PRESENT'; assert.equal(diagnoseWorkflow(draft,{availableSecrets:['PRESENT']}).executable,true);
  const empty = {name:'Default only',nodes:[node('root','service-state',{}),node('route','switch',{field:'trigger.service',cases:[]})],edges:[edge('root','route')]};
  assert.equal(diagnoseWorkflow(empty).executable,true);
  empty.nodes[1].config.cases = [{id:'case-literal',value:'{{secrets.NOT_A_REFERENCE}}'}];
  assert.equal(diagnoseWorkflow(empty).executable,true);
});

test('switch connection diagnostics locate the source for missing, stale, duplicate and default ports', () => {
  for (const port of ['case-deleted','next','true']) {
    const draft = make(); draft.edges[1].port = port;
    const original = structuredClone(draft), result = diagnoseWorkflow(draft);
    assert.equal(result.saveAllowed,false); assert.equal(result.executable,false);
    assert.deepEqual(result.issues[0].nodeIds,['route']); assert.match(result.issues[0].message,/존재하지 않는 분기/);
    assert.throws(()=>validateDefinition(draft),{message:result.issues[0].message});
    assert.deepEqual(draft,original);
    draft.edges[1].port = 'case-0'; assert.equal(diagnoseWorkflow(draft).executable,true);
  }
  for (const port of ['case-0','default']) {
    const draft = make(); draft.edges.push({id:'duplicate-port',from:'route',to:'end-case-1',port});
    const result = diagnoseWorkflow(draft);
    assert.equal(result.saveAllowed,false); assert.deepEqual(result.issues[0].nodeIds,['route']);
    assert.match(result.issues[0].message,/같은 분기/);
    draft.edges.pop(); assert.equal(diagnoseWorkflow(draft).executable,true);
  }
  const missing = make(); missing.edges[1].to = 'deleted-node';
  assert.deepEqual(diagnoseWorkflow(missing).issues[0].nodeIds,['route']);
  const orphan = make(); orphan.edges.splice(1,1);
  assert.deepEqual(diagnoseWorkflow(orphan).issues.find(issue=>issue.code==='unreachable').nodeIds,['end-case-0']);
});

test('context node diagnostics reject invalid injected entries without interpreting literal values', () => {
  for (const entries of [[{key:'same',value:'A'},{key:'same',value:'B'}],[{key:'__proto__',value:'A'}],[{key:'service',value:1}],[{key:'service',value:'x'.repeat(4001)}],Array.from({length:51},(_,i)=>({key:'key'+i,value:'A'}))]) {
    const draft = {name:'Context diagnostics',nodes:[node('root','start',{}),node('values','context',{entries})],edges:[edge('root','values')]};
    const result = diagnoseWorkflow(draft);
    assert.equal(result.saveAllowed,false); assert.deepEqual(result.issues[0].nodeIds,['values']);
  }
});

test('real switch runs and snapshot reruns choose one branch; dry runs create no audit records', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-switch-'));
  const app = await createApp({ dataDir:directory, brandingFile:path.join(directory, 'branding.json'), workflows:{ autoStart:false, fetch:async()=>{throw Error('Unexpected HTTP');} }, logMaintenance:{ autoStart:false } });
  await app.vault.setup('switch-test-password'); await app.workflowEngine.unlock();
  t.after(async()=>{await app.close(); assert.equal(path.dirname(directory),path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('workflow-switch-')); await fs.rm(directory,{recursive:true,force:true});});
  const def = make(); def.nodes[0] = node('root','cron',{expression:'* * * * *',timezone:'UTC'});
  def.nodes.splice(1, 0, node('values','context',{entries:[{key:'service',value:'B'}]}));
  def.nodes.find(n=>n.id==='route').config.field = 'context.service';
  def.edges[0] = edge('root','values'); def.edges.push(edge('values','route'));
  let flow = await app.workflows.create({...def,requestId:randomUUID()});
  const settle = async id => { for(let i=0;i<300;i++){await app.workflowEngine.tick();const run=await app.workflows.readRun(id);if(['success','failure','review'].includes(run.status))return run;await delay(10);}throw Error('Switch run timed out'); };
  const first = await app.workflows.run(flow.id,{version:flow.version,requestId:randomUUID()});
  const run = await settle(first.id);
  assert.equal(run.status,'success'); assert.equal(run.message,'case-1');
  assert.deepEqual(run.steps.map(step=>step.nodeId),['root','values','route','end-case-1']);
  const before = await app.vault.snapshot();
  const preview = app.workflows.dryRun(flow.id,{definition:def,setup:mergeDryRunSetup(def,{},'2026-09-10T00:00:00.000Z')});
  assert.equal(preview.message,run.message);
  const after = await app.vault.snapshot();
  for(const key of ['workflowRuns','changes','serviceState'])assert.deepEqual(after[key],before[key]);
  def.nodes.find(n=>n.id==='values').config.entries[0].value='A';
  flow = await app.workflows.save(flow.id,{...def,version:flow.version});
  const repeated = await app.workflows.rerun(first.id,{requestId:randomUUID()});
  assert.equal((await settle(repeated.id)).message,'case-1');
  const latest = await app.workflows.run(flow.id,{version:flow.version,requestId:randomUUID()});
  assert.equal((await settle(latest.id)).message,'case-0');
});
