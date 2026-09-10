import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importWorkflow } from '../lib/workflow-file.mjs';
import { routeEdges } from '../public/workflow-routing.js';

export async function checkTopology({ app, calls, runDir, evaluate, click, until, command, viewport, screen, uploadFile }) {
  const count = calls.length;
  await viewport(1440,1000);
  await click('[data-view="workflow"]');
  await until(()=>evaluate('!!document.querySelector("[data-wf-command=list]")'));
  await click('[data-wf-command="list"]'); await click('[data-wf-command="upload"]');
  const filename = path.resolve('test/fixtures/workflow-branching-39.json');
  const original = importWorkflow(JSON.parse(await fs.readFile(filename,'utf8')),{executable:true}).definition;
  await uploadFile(filename); await evaluate('document.querySelector("#workflow-file-dialog form").requestSubmit()');
  await until(() => evaluate('document.querySelectorAll(".wf-node").length===39'));
  await click('[data-wf-command="arrange"]');
  const coordinates = () => evaluate('Object.fromEntries([...document.querySelectorAll(".wf-node")].map(n=>[n.dataset.nodeId,[parseFloat(n.style.left),parseFloat(n.style.top)]]))');
  const arranged = await coordinates();
  assert.equal(arranged['node-010'][1],arranged['node-013'][1]);
  assert.ok(arranged['node-010'][0]<arranged['node-011'][0] && arranged['node-011'][0]<arranged['node-012'][0] && arranged['node-012'][0]<arranged['node-013'][0]);
  assert.ok(arranged['node-039'][1]>arranged['node-010'][1]);
  await click('[data-wf-command="arrange"]'); assert.deepEqual(await coordinates(),arranged);
  await click('[data-wf-command="save"]');
  const flow = app.workflows.list().workflows.find(item=>item.name===original.name); assert.ok(flow);
  await until(()=>app.workflows.read(flow.id).nodes.find(node=>node.id==='node-010').x===arranged['node-010'][0]);
  await until(()=>evaluate('document.querySelector("[data-wf-save-state]").textContent.startsWith("저장됨")'));
  const saved = app.workflows.read(flow.id);
  const structure = ({nodes,edges})=>({nodes:nodes.map(({x,y,...node})=>node),edges});
  assert.deepEqual(structure(saved),structure(original));
  const routes = routeEdges(saved.nodes,saved.edges);
  const rendered = await evaluate('Object.fromEntries([...document.querySelectorAll("[data-wf-edge]")].map(e=>[e.dataset.wfEdge,e.getAttribute("d")]))');
  for(const [id,route]of routes) {assert.equal(route.routed,true,id);assert.equal(rendered[id],route.path);}
  assert.equal(await evaluate('document.querySelectorAll(".wf-edge-line[marker-end]").length'),61);
  await until(()=>evaluate('document.querySelector(".wf-diagnostics").hidden'));
  await screen('workflow-topology-39-desktop');
  // Whole-graph fit must work below the former 35% zoom floor, including mobile.
  for(const width of [1440,390]) {
    await viewport(width,width===390?844:1000);
    for(const name of ['palette','inspector']) if(!await evaluate(`document.querySelector('.wf-${name}').hidden`)) await click(`[data-wf-close-dock="${name}"]`);
    await click('[data-wf-command="fit"]');
    assert.ok(await evaluate('parseInt(document.querySelector("[data-wf-zoom-label]").textContent)<35'));
    const visible=await evaluate(`(()=>{const bar=document.querySelector('.wf-canvas-bar').getBoundingClientRect(),footer=document.querySelector('.wf-canvas-footer').getBoundingClientRect();return [...document.querySelectorAll('.wf-node')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=bar.bottom&&r.bottom<=footer.top;});})()`);
    assert.equal(visible,true,'whole graph fits at '+width); await screen('workflow-topology-39-'+width);
  }
  await viewport(1440,1000); await click('[data-wf-command="download"]');
  const download=path.join(runDir,'workflow-'+flow.id+'.json');
  await until(async()=>{try{await fs.access(download);return true;}catch{return false;}});
  assert.deepEqual(importWorkflow(JSON.parse(await fs.readFile(download,'utf8')),{executable:true}).definition,{name:saved.name,nodes:saved.nodes,edges:saved.edges});
  // Reopen the saved flow, then select one routed connection through its hit path.
  await click('[data-wf-command="reload"]'); await until(()=>evaluate('document.querySelectorAll(".wf-node").length===39'));
  assert.deepEqual(await coordinates(),arranged);
  await evaluate('document.querySelector("[data-wf-edge=edge-012]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
  assert.equal(await evaluate('document.querySelector(".wf-edge.is-selected [data-wf-edge]").dataset.wfEdge'),'edge-012');
  assert.equal(calls.length,count,'layout checks never execute fixture HTTP');
}
