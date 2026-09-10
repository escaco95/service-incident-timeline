import assert from 'node:assert/strict';
import { nodeBounds } from '../public/workflow-layout.js';

export async function checkSelection({app,evaluate,click,input,until,command,viewport,screen}) {
  const node=(id,type,config,x,y)=>({id,name:id,type,config,x,y});
  const edge=(from,to,port='next')=>({id:from+'-'+to,from,to,port});
  const flow=await app.workflows.create({name:'Multiple selection',requestId:crypto.randomUUID(),nodes:[node('root','service-state',{service:''},72,72),node('values','context',{entries:[{key:'service',value:'A'}]},396,252),node('route','switch',{field:'nodes.values.count',cases:[{id:'case-one',value:1},{id:'case-two',value:2}]},720,252),node('done','finish',{result:'success',message:'done'},1044,252)],edges:[edge('root','values'),edge('values','route'),edge('route','done','case-one')]});
  await viewport(1440,1000); await command('Page.reload'); await until(()=>evaluate('!!document.querySelector(".calendar")'));
  await click('[data-view="workflow"]'); await until(()=>evaluate(`!!document.querySelector('[data-wf-open="${flow.id}"]')`));
  await click(`[data-wf-open="${flow.id}"]`);
  const closeDocks=async()=>{for(const name of ['palette','inspector'])if(!await evaluate(`document.querySelector('.wf-${name}').hidden`))await click(`[data-wf-close-dock="${name}"]`);};
  const positions=()=>evaluate('Object.fromEntries([...document.querySelectorAll(".wf-node")].map(n=>[n.dataset.nodeId,{x:parseFloat(n.style.left),y:parseFloat(n.style.top)}]))');
  const selected=()=>evaluate('[...document.querySelectorAll(".wf-node.is-selected")].map(n=>n.dataset.nodeId).sort()');
  const client=async(x,y)=>evaluate(`(()=>{const s=document.querySelector('.wf-stage').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {x:s.left+m.e+${x}*m.a,y:s.top+m.f+${y}*m.a};})()`);
  const press=async(point,button='left')=>command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button,buttons:button==='left'?1:2,clickCount:1});
  const release=async(point,button='left')=>command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button,buttons:0,clickCount:1});
  const move=async(point,buttons=1)=>command('Input.dispatchMouseEvent',{type:'mouseMoved',...point,buttons});
  const escape=async()=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});};
  const marquee=async(reverse=false,cancel=false)=>{
    await closeDocks(); await click('[data-wf-command="fit"]');
    const coords=await positions(), from=await client(coords.values.x-36,coords.values.y-72), to=await client(coords.route.x+248,coords.route.y+246);
    const start=reverse?to:from,end=reverse?from:to;
    const camera=await evaluate('document.querySelector(".wf-world").style.transform');
    assert.equal(await evaluate(`!!document.elementFromPoint(${start.x},${start.y})?.closest('.wf-stage') && !document.elementFromPoint(${start.x},${start.y})?.closest('.wf-node,button,[data-wf-edge]')`),true);
    await press(start);
    assert.equal(await evaluate('document.querySelector(".wf-stage").classList.contains("is-selecting")'),true,'background left press starts marquee');
    await move(end);
    assert.deepEqual(await selected(),['route','values']);
    assert.equal(await evaluate('document.querySelectorAll("[data-wf-field]").length'),0,'properties locked while selecting');
    assert.equal(await evaluate('document.querySelector(".wf-selection-box").hidden'),false);
    assert.equal(await evaluate('document.querySelector("[data-wf-command=duplicate-node]").disabled'),true,'actions wait for selection to finish');
    assert.equal(await evaluate('document.querySelector(".wf-world").style.transform'),camera,'left marquee does not pan');
    await screen('workflow-multiselect-marquee');
    if(cancel)await escape();
    await release(end);
    assert.equal(await evaluate('document.querySelector(".wf-selection-box").hidden'),true);
  };
  const initial=await positions();
  await marquee();
  assert.equal(await evaluate('document.querySelectorAll(".wf-node-select[aria-pressed=true]").length'),2);
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-field]").length'),0);
  assert.equal(await evaluate('document.querySelector("[data-wf-command=duplicate-node]").disabled'),false);
  assert.deepEqual(await positions(),initial);
  assert.equal(await evaluate('document.querySelector("[data-wf-command=save]").disabled'),true,'selection is not a definition edit');
  await screen('workflow-multiselect-panel');
  // A double click on a selected switch cannot open its property dialog.
  const switchPoint=await client(initial.route.x+115,initial.route.y+50);
  for(const clickCount of [1,2]){
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...switchPoint,button:'left',buttons:1,clickCount});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...switchPoint,button:'left',buttons:0,clickCount});
  }
  assert.equal(await evaluate('document.querySelector("#workflow-switch-dialog").open'),false);
  assert.deepEqual(await selected(),['route','values']);
  await closeDocks();
  const start=await client(initial.values.x+115,initial.values.y+50), zoom=await evaluate('new DOMMatrix(getComputedStyle(document.querySelector(".wf-world")).transform).a');
  await press(start); await move({x:start.x+81*zoom,y:start.y+47*zoom}); await release({x:start.x+81*zoom,y:start.y+47*zoom});
  let moved=await positions();
  for(const id of ['values','route']){assert.equal(moved[id].x-initial[id].x,90);assert.equal(moved[id].y-initial[id].y,54);}
  for(const id of ['root','done'])assert.deepEqual(moved[id],initial[id]);
  assert.deepEqual(await selected(),['route','values']);
  await screen('workflow-multiselect-moved');
  // One captured drag crosses every corner; all members retain the same offsets.
  const groupStart=await client(moved.values.x+115,moved.values.y+50);
  await press(groupStart);
  for(const [x,y] of [[100000,100000],[-100000,-100000],[100000,-100000],[-100000,100000]]){
    await evaluate(`(()=>{const h=document.querySelector('[data-wf-select=values]');if(!h.hasPointerCapture(1))throw Error('Group drag not captured');h.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:${x},clientY:${y},buttons:1,bubbles:true}));})()`);
    const capped=await positions();
    assert.equal(capped.route.x-capped.values.x,initial.route.x-initial.values.x);
    assert.equal(capped.route.y-capped.values.y,initial.route.y-initial.values.y);
    for(const id of ['values','route']){const bounds=nodeBounds(flow.nodes.find(n=>n.id===id));assert.ok(capped[id].x>=bounds.minX&&capped[id].x<=bounds.maxX&&capped[id].y>=bounds.minY&&capped[id].y<=bounds.maxY);}
    assert.deepEqual(capped.root,initial.root);assert.deepEqual(capped.done,initial.done);
  }
  await release(groupStart);await click('[data-wf-command="revert"]');
  assert.deepEqual(await positions(),initial);
  await marquee(true);
  await closeDocks();
  const cancelStart=await client(initial.values.x+115,initial.values.y+50);
  await press(cancelStart);await move({x:cancelStart.x+60,y:cancelStart.y+60});await escape();await release(cancelStart);
  assert.deepEqual(await positions(),initial,'Esc restores the entire moved group');
  assert.deepEqual(await selected(),['route','values']);
  await press(cancelStart);
  await evaluate('document.querySelector("[data-wf-select=values]").releasePointerCapture(1)');
  await move({x:cancelStart.x+54,y:cancelStart.y+54});
  assert.notDeepEqual(await positions(),initial,'drag continues when pointer capture is released');
  await escape();await release(cancelStart);
  assert.deepEqual(await positions(),initial);
  const bodyStart=await client(initial.route.x+12,initial.route.y+170);
  await press(bodyStart);await move({x:bodyStart.x+54,y:bodyStart.y+54});
  assert.notDeepEqual(await positions(),initial,'the blank switch body also drags the selected group');
  assert.deepEqual(await selected(),['route','values']);
  await escape();await release(bodyStart);assert.deepEqual(await positions(),initial);
  // Background right drag keeps both selection and node positions, and consumes its context menu.
  const background=await evaluate('(()=>{const r=document.querySelector(".wf-stage").getBoundingClientRect();return {x:r.left+8,y:r.bottom-8};})()');
  const camera=await evaluate('document.querySelector(".wf-world").style.transform');
  await press(background,'right');assert.equal(await evaluate('document.querySelector(".wf-stage").classList.contains("is-panning")'),true);
  await move({x:background.x+60,y:background.y-30},2);await release({x:background.x+60,y:background.y-30},'right');
  assert.notEqual(await evaluate('document.querySelector(".wf-world").style.transform'),camera);
  assert.deepEqual(await positions(),initial);assert.deepEqual(await selected(),['route','values']);
  assert.equal(await evaluate('!document.querySelector(".wf-stage").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2}))'),true);
  await marquee(false,true);assert.deepEqual(await selected(),['route','values'],'canceling a new marquee restores the previous selection');
  await press(background);await release(background);assert.deepEqual(await selected(),[],'empty background click clears selection');
  await marquee();
  await click('[data-wf-command="duplicate-node"]');
  const copies=await selected();assert.equal(copies.length,2);assert.ok(copies.every(id=>!['values','route'].includes(id)));
  assert.equal(await evaluate('document.querySelectorAll(".wf-node").length'),6);
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-edge]").length'),4);
  await click('[data-wf-command="save"]');await until(()=>app.workflows.read(flow.id).nodes.length===6);
  await until(()=>evaluate('document.querySelector("[data-wf-command=save]").disabled'));
  assert.deepEqual(await selected(),copies,'save retains the selection');
  const saved=app.workflows.read(flow.id), copiedNodes=saved.nodes.filter(n=>copies.includes(n.id)), copiedValues=copiedNodes.find(n=>n.type==='context'), copiedSwitch=copiedNodes.find(n=>n.type==='switch');
  assert.equal(copiedSwitch.config.field,'nodes.'+copiedValues.id+'.count');
  assert.equal(copiedSwitch.x-copiedValues.x,initial.route.x-initial.values.x);
  assert.deepEqual(saved.edges.filter(e=>copies.includes(e.from)||copies.includes(e.to)).map(e=>[e.from,e.to]),[[copiedValues.id,copiedSwitch.id]]);
  assert.equal(Object.hasOwn(saved,'selection'),false,'UI selection is not persisted as workflow configuration');
  await click('[data-wf-command="reload"]');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===6'));
  assert.deepEqual(await selected(),copies);
  await viewport(390,844);if(await evaluate('document.querySelector(".wf-inspector").hidden'))await click('[data-wf-dock="inspector"]');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-field]").length'),0);
  await screen('workflow-multiselect-mobile');
  await click('[data-wf-command="delete-node"]');
  assert.equal(await evaluate('document.querySelectorAll(".wf-node").length'),4);assert.equal(await evaluate('document.querySelectorAll("[data-wf-edge]").length'),3);
  await click('[data-wf-command="save"]');await until(()=>app.workflows.read(flow.id).nodes.length===4);
  await viewport(1440,1000);await marquee();
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
  assert.deepEqual(Object.keys(await positions()).sort(),['done','root']);assert.equal(await evaluate('document.querySelectorAll("[data-wf-edge]").length'),0);
  await click('[data-wf-command="revert"]');assert.deepEqual(await positions(),initial);
}
