import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { nodeHeight, nodeBounds } from '../public/workflow-layout.js';

export async function checkSwitch({ app, calls, runDir, evaluate, click, input, until, command, viewport, screen, uploadFile }) {
  await viewport(1440, 1000);
  if (await evaluate('!!document.querySelector("[data-wf-command=list]")')) await click('[data-wf-command="list"]');
  await click('[data-wf-command="upload"]');
  await uploadFile(path.resolve('examples/workflows/service-switch.json'));
  await evaluate('document.querySelector("#workflow-file-dialog form").requestSubmit()');
  await until(() => evaluate('!!document.querySelector(".wf-switch-node")'));
  const flow = app.workflows.list().workflows.find(item => item.name === '서비스별 switch 분기 예제');
  assert.ok(flow);
  const row = id => `[data-case-id="${id}"]`;
  const outlets = () => evaluate('[...document.querySelectorAll("[data-wf-output=route]")].map(button=>({id:button.dataset.port,label:button.textContent.trim()}))');
  const edit = async () => {
    await click('[data-wf-select="route"]'); await click('[data-wf-command="edit-switch"]');
    await until(() => evaluate('document.querySelector("#workflow-switch-dialog").open'));
  };
  const submit = async () => {
    await evaluate('document.querySelector("#workflow-switch-dialog form").requestSubmit()');
    await until(() => evaluate('!document.querySelector("#workflow-switch-dialog").open'));
  };
  const diagnosed = () => until(() => evaluate('document.querySelector("[data-wf-diagnostics-status]").textContent !== "진단 중…"'));
  const invalidNodes = () => evaluate('[...document.querySelectorAll(".wf-node.has-error")].map(node=>node.dataset.nodeId).sort()');
  assert.deepEqual(await outlets(), [{id:'case-a',label:'"A"'},{id:'case-b',label:'"B"'},{id:'default',label:'기본'}]);
  await click('[data-wf-command="fit"]');
  assert.equal(await evaluate('(()=>{const node=document.querySelector(".wf-switch-node").getBoundingClientRect();return [...document.querySelectorAll(".wf-switch-output span")].every(label=>{const r=label.getBoundingClientRect(),p=label.parentElement.getBoundingClientRect();return r.left>=node.left&&r.right<=node.right&&r.top>=node.top&&r.bottom<=node.bottom&&Math.abs((r.top+r.bottom-p.top-p.bottom)/2)<4;});})()'),true,'switch labels stay inside their rows');
  await screen('workflow-switch-example');
  const point = await evaluate('(()=>{const b=document.querySelector("[data-wf-select=route]"),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(!b.contains(document.elementFromPoint(x,y)))throw Error("Switch is obscured");return {x,y};})()');
  for (const clickCount of [1, 2]) {
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount});
  }
  await until(() => evaluate('document.querySelector("#workflow-switch-dialog").open'));
  await input(row('case-a')+' [data-switch-value]', 'unsaved');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(() => evaluate('!document.querySelector("#workflow-switch-dialog").open'));
  await edit(); assert.equal(await evaluate('document.querySelector("[data-case-id=case-a] [data-switch-value]").value'),'A');
  await input('[data-switch-field]','response.status'); await submit(); await diagnosed();
  assert.deepEqual(await invalidNodes(),['route']);
  assert.equal(await evaluate('document.querySelector("[data-wf-diagnostic-node=route]").textContent.includes("HTTP 응답이 없는 경로")'),true);
  assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'),true);
  await click('[data-wf-diagnostic-node="route"]');
  assert.equal(await evaluate('document.querySelector(".wf-node.is-selected").dataset.nodeId'),'route');
  await screen('workflow-switch-diagnostics');
  await edit(); await input('[data-switch-field]','trigger.service'); await submit(); await diagnosed();
  assert.deepEqual(await invalidNodes(),[]);
  await edit();
  await input(row('case-a')+' [data-switch-value]', 'A2');
  for (const [type, value] of [['number','200'],['boolean','false'],['null',null]]) {
    await click('[data-switch-add]');
    await input('.wf-switch-row:last-child [data-switch-type]', type);
    if (value !== null) await input('.wf-switch-row:last-child [data-switch-value]', value);
  }
  await screen('workflow-switch-dialog'); await submit();
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-edge]").length'),4,'editing values preserves connections');
  assert.deepEqual((await outlets()).map(value=>value.label),['"A2"','"B"','200','false','null','기본']);
  await edit(); await click(row('case-a')+' [data-switch-remove]'); await submit();
  assert.equal(await evaluate('document.querySelectorAll(".wf-node").length'),5,'removing a branch preserves destination nodes');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-wf-edge]")].map(edge=>edge.dataset.wfEdge).sort()'),['changed-route','route-b','route-other']);
  await diagnosed(); assert.deepEqual(await invalidNodes(),['service-a']);
  await click('[data-wf-select="service-a"]'); await click('[data-wf-command="delete-node"]');
  await diagnosed(); assert.deepEqual(await invalidNodes(),[]);
  await edit();
  // Exercise the authoring limit and duplicate validation through the real controls.
  await evaluate('(()=>{for(let i=0;i<16;i++){document.querySelector("[data-switch-add]").click();const field=document.querySelector(".wf-switch-row:last-child [data-switch-value]");field.value="extra-"+i;field.dispatchEvent(new Event("input",{bubbles:true}));}})()');
  assert.equal(await evaluate('document.querySelector("[data-switch-add]").disabled'),true);
  await input('.wf-switch-row:last-child [data-switch-value]','B');
  await evaluate('document.querySelector("#workflow-switch-dialog form").requestSubmit()');
  assert.equal(await evaluate('document.querySelector("#workflow-switch-dialog").open'),true);
  assert.equal(await evaluate('document.querySelector("[data-switch-error]").hidden'),false);
  await input('.wf-switch-row:last-child [data-switch-value]','<img src=x onerror="window.switchXss=true">');
  await viewport(390,844);
  assert.equal(await evaluate('(()=>{const d=document.querySelector("#workflow-switch-dialog"),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1;})()'),true);
  await screen('workflow-switch-mobile'); await submit();
  assert.equal(await evaluate('window.switchXss===true'),false);
  assert.equal((await outlets()).length,21);
  await viewport(1440,1000); await click('[data-wf-command="arrange"]'); await click('[data-wf-command="fit"]');
  await click('[data-wf-select="route"]'); await click('[data-wf-command="duplicate-node"]');
  assert.equal(await evaluate('document.querySelectorAll(".wf-node.is-selected .wf-output").length'),21);
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-edge]").length'),3);
  await click('[data-wf-command="delete-node"]');
  await click('[data-wf-command="save"]');
  await until(() => app.workflows.read(flow.id).nodes.find(node=>node.id==='route').config.cases.length===20);
  await until(() => evaluate('document.querySelector("[data-wf-command=save]").disabled'));
  await click('[data-wf-command="reload"]');
  await until(() => evaluate('document.querySelectorAll("[data-wf-output=route]").length===21'));
  const stored = app.workflows.read(flow.id), route = stored.nodes.find(node=>node.id==='route');
  assert.equal(await evaluate('parseFloat(document.querySelector(".wf-switch-node").style.height)'),nodeHeight(route));
  assert.ok(route.y<=nodeBounds(route).maxY);
  for (const edge of stored.edges.filter(edge=>edge.from==='route')) {
    const coords = await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify('[data-wf-output="route"][data-port="'+edge.port+'"]')}),n=p.closest('.wf-node'),e=document.querySelector(${JSON.stringify('[data-wf-edge="'+edge.id+'"]')});return {x:parseFloat(n.style.left)+parseFloat(p.style.left)+7,y:parseFloat(n.style.top)+parseFloat(p.style.top)+7,path:e.getAttribute('d')};})()`);
    assert.ok(coords.path.startsWith(`M ${coords.x} ${coords.y} C `),'edge starts at its switch outlet');
  }
  await click('[data-wf-command="fit"]'); await screen('workflow-switch-canvas');
  await click('[data-wf-command="download"]');
  const download = path.join(runDir,'workflow-'+flow.id+'.json');
  await until(async()=>{try{await fs.access(download);return true;}catch{return false;}});
  const file = JSON.parse(await fs.readFile(download,'utf8'));
  assert.deepEqual(file.definition.nodes.find(node=>node.id==='route').config,route.config);
  assert.equal(Object.hasOwn(file,'requiredSecrets'),false);
  const before = await app.vault.snapshot(), beforeCalls = calls.length;
  await click('[data-wf-command="dry-run"]'); await until(() => evaluate('!!document.querySelector("[data-dry-form]")'));
  for (const [service,status,message] of [['B','success','B 서비스 경로'],['unmatched','skipped','처리 대상이 아닌 서비스']]) {
    await input('[data-dry-field="trigger"]',JSON.stringify({service,previous:'',severity:'incident',events:[],scheduledAt:'2026-09-10T00:00:00.000Z'}));
    await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');
    await until(() => evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));
    assert.equal(await evaluate(`!!document.querySelector('[data-dry-result] .wf-dry-status.${status}')`),true);
    assert.equal(await evaluate(`document.querySelector('[data-dry-result]').textContent.includes(${JSON.stringify(message)})`),true);
    assert.equal(await evaluate('document.querySelectorAll(".wf-dry-steps>li").length'),3);
    assert.equal(await evaluate(`document.querySelector('[data-dry-result]').textContent.includes(${JSON.stringify(service==='B'?'"B"':'기본')})`),true);
  }
  await screen('workflow-switch-dry-run');
  await click('[data-dry-close]'); await until(() => evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
  const after = await app.vault.snapshot();
  for (const key of ['changes','workflowRuns','serviceState']) assert.deepEqual(after[key],before[key]);
  assert.equal(calls.length,beforeCalls);
  await until(() => evaluate('!document.querySelector("[data-wf-command=run]").disabled'));
  await click('[data-wf-command="run"]'); await until(() => evaluate('document.querySelector("#workflow-run-dialog").open'));
  await input('#workflow-run-dialog [name="service"]','B');
  await evaluate('document.querySelector("[data-wf-run-form]").requestSubmit()');
  await until(() => evaluate('!!document.querySelector("#audit-detail-dialog .audit-result.success")'));
  assert.equal(await evaluate('document.querySelector("[data-run-step=route]").textContent.includes(\'선택한 분기: "B"\')'),true);
  await evaluate('document.querySelector("[data-run-step=route]").open=true'); await screen('workflow-switch-audit');
  await click('#audit-detail-dialog [data-close]');
  assert.equal(calls.length,beforeCalls);
}
