import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fileURLToPath } from 'node:url';
import { CANVAS_SIZE, NODE_BOUNDS } from '../public/workflow-layout.js';
const tempRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp');
await fs.mkdir(tempRoot, {recursive:true});
const runDir = await fs.mkdtemp(path.join(tempRoot, 'workflow-browser-'));
const calls = [];
const app = await createApp({ dataDir: path.join(runDir, 'data'), brandingFile: path.join(runDir, 'branding.json'), workflows: { autoStart: false, fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({accepted:true}),{status:500}); } }, logMaintenance: { autoStart: false } });
const address = await app.listen(0);
const browser = spawn(process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0', `--user-data-dir=${path.join(runDir,'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, id = 0, tracking = false;
const pending = new Map(), requests = [], errors = [];
async function until(check) { for(let i=0;i<100;i++) { if(await check()) return; await delay(100); } throw new Error('Browser wait timed out'); }
function command(method, params = {}) { const requestId=++id; return new Promise((resolve,reject) => { const timeout=setTimeout(()=>{pending.delete(requestId);reject(new Error(method+' timeout'));},10000); pending.set(requestId,{resolve:result=>{clearTimeout(timeout);resolve(result);},reject:error=>{clearTimeout(timeout);reject(error);}}); socket.send(JSON.stringify({id:requestId,method,params})); }); }
async function evaluate(expression) { const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true}); if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function deleteFlow(selector) { await click(selector); await click('[data-wf-confirm-delete]'); }
async function input(selector,value) { await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function deleteKey() {
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
}
async function checkNodeActions() {
 const nodeCount=()=>evaluate('document.querySelectorAll(".wf-node").length');
 const edgeCount=()=>evaluate('document.querySelectorAll("[data-wf-edge]").length');
 const focusNode=id=>evaluate(`document.querySelector(${JSON.stringify('[data-wf-select="'+id+'"]')}).focus()`);
 const configFields=()=>evaluate('[...document.querySelectorAll("[data-wf-field]")].filter(field=>field.dataset.wfField!=="name").map(field=>[field.dataset.wfField,field.value])');
 await click('[data-wf-select="http"]');
 const originalFields=await configFields();
 for(const width of [1440,1100,900,390]) {
  await viewport(width,width===390?844:1000);
  const layout=await evaluate(`(()=>{const header=document.querySelector('.wf-inspector>.wf-panel-title'),r=header.getBoundingClientRect(),label=header.firstElementChild.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,header:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},labelRight:label.right,buttons:[...header.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};}),bottomDelete:!!document.querySelector('.wf-inspector-body [data-wf-command="delete-node"]')};})()`);
  assert.equal(layout.buttons.length,2);assert.equal(layout.bottomDelete,false);assert.ok(layout.page<=width+1);
  for(const button of layout.buttons) assert.ok(button.left>=layout.labelRight&&button.right<=layout.header.right&&button.top>=layout.header.top&&button.bottom<=layout.header.bottom,JSON.stringify(layout));
 }
 await viewport(1440);
 await evaluate('document.querySelector(".wf-inspector-body").scrollTop=10000');
 assert.equal(await evaluate('(()=>{const b=document.querySelector("[data-wf-command=delete-node]"),r=b.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest("button")===b;})()'),true,'delete stays above the scrolled settings');
 await screen('workflow-node-actions');
 await evaluate('document.querySelector(".wf-inspector-body").scrollTop=0');
 await click('[data-wf-command="duplicate-node"]');
 const copy=await evaluate('document.querySelector(".wf-node.is-selected").dataset.nodeId');
 assert.notEqual(copy,'http');assert.equal(await nodeCount(),6);assert.equal(await edgeCount(),4);
 assert.deepEqual(await configFields(),originalFields);
 assert.equal(await evaluate('document.activeElement.dataset.wfSelect'),copy);
 assert.equal(await evaluate('document.querySelector("[data-wf-field=name]").value'),'http 복사본');
 await checkGrid('duplicated node');
 await input('[data-wf-field="url"]','https://example.invalid/copy');
 await click('[data-wf-select="http"]');assert.deepEqual(await configFields(),originalFields);
 await click('[data-wf-select="'+copy+'"]');await focusNode(copy);await deleteKey();
 assert.equal(await nodeCount(),5);assert.equal(await edgeCount(),4);
 assert.equal(await evaluate('document.activeElement.classList.contains("wf-stage")'),true);
 await deleteKey();assert.equal(await nodeCount(),5,'Delete without a selection changes nothing');
 await click('[data-wf-select="http"]');
 for(const key of ['name','body']) {
  const selector='[data-wf-field="'+key+'"]';
  const before=await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
  await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.focus();field.setSelectionRange(0,1);})()`);
  await deleteKey();assert.equal(await nodeCount(),5,'Delete edits '+key);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),before.slice(1));
  await input(selector,before);
 }
 await evaluate('document.querySelector("[data-wf-field=method]").focus()');await deleteKey();assert.equal(await nodeCount(),5);
 await evaluate('(()=>{const editor=document.createElement("div");editor.id="test-editable";editor.contentEditable="true";editor.textContent="editable";document.querySelector(".wf-inspector").append(editor);editor.focus();})()');
 await deleteKey();assert.equal(await nodeCount(),5);await evaluate('document.querySelector("#test-editable").remove()');
 await focusNode('http');
 for(const flags of [{repeat:true},{isComposing:true},{ctrlKey:true},{altKey:true},{metaKey:true},{shiftKey:true}]) {
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true,...${JSON.stringify(flags)}}))`);
  assert.equal(await nodeCount(),5,'modified/composing/repeated Delete is ignored');
 }
 await evaluate(`document.querySelector('[data-wf-edge="http-next-condition"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('[data-wf-edge="http-next-condition"]').focus()`);
 await deleteKey();assert.equal(await nodeCount(),5,'edge selection must not delete a previously selected node');
 await click('[data-wf-select="condition"]');await focusNode('condition');await deleteKey();
 assert.equal(await nodeCount(),4);assert.equal(await edgeCount(),1,'deleting a node removes its incoming and outgoing edges');
 assert.equal(await evaluate('document.querySelector("[data-wf-command=save]").disabled'),false);
 await click('[data-wf-command="revert"]');assert.equal(await nodeCount(),5);assert.equal(await edgeCount(),4);
 await click('[data-wf-select="http"]');await click('[data-wf-command="delete-node"]');
 assert.equal(await nodeCount(),4);assert.equal(await edgeCount(),2,'header button uses the same deletion behavior');
 await click('[data-wf-command="revert"]');assert.equal(await nodeCount(),5);assert.equal(await edgeCount(),4);
}
async function screen(name) { const result=await command('Page.captureScreenshot',{format:'png'}); await fs.writeFile(path.join(tempRoot,name+'.png'),Buffer.from(result.data,'base64')); }
async function viewport(width,height=1000) { await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await delay(200); }
async function checkCamera(label, expected) {
 const camera=await evaluate(`(()=>{const s=document.querySelector('.wf-stage'),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {x:(s.clientWidth/2-m.e)/m.a,y:(s.clientHeight/2-m.f)/m.a};})()`);
 assert.ok(camera.x>=-.02&&camera.x<=CANVAS_SIZE+.02&&camera.y>=-.02&&camera.y<=CANVAS_SIZE+.02,label+JSON.stringify(camera));
 if(expected) assert.ok(Math.abs(camera.x-expected.x)<.02&&Math.abs(camera.y-expected.y)<.02,label+JSON.stringify({camera,expected}));
 return camera;
}
async function checkGrid(label) {
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 await checkCamera(label);
 const layout=await evaluate(`(()=>{const stage=document.querySelector('.wf-stage'),s=getComputedStyle(stage),r=stage.getBoundingClientRect(),step=parseFloat(s.backgroundSize),pos=s.backgroundPosition.split(' ').map(parseFloat),origin={x:r.left+stage.clientLeft+pos[0]+step/2,y:r.top+stage.clientTop+pos[1]+step/2},distance=v=>Math.abs(v-Math.round(v/step)*step);return {step,nodes:[...document.querySelectorAll('.wf-node')].map(n=>{const p=n.getBoundingClientRect();return {id:n.dataset.nodeId,x:parseFloat(n.style.left),y:parseFloat(n.style.top),gridX:distance(p.left-origin.x),gridY:distance(p.top-origin.y)};})};})()`);
 assert.ok(layout.step>0,label);
 for(const node of layout.nodes) assert.ok(node.x>=NODE_BOUNDS.minX&&node.x<=NODE_BOUNDS.maxX&&node.y>=NODE_BOUNDS.minY&&node.y<=NODE_BOUNDS.maxY,label+JSON.stringify(node));
 const boundary=await evaluate(`(()=>{const b=document.querySelector('.wf-boundary'),r=b.querySelector('rect'),s=getComputedStyle(r),w=document.querySelector('.wf-world').getBoundingClientRect(),p=b.getBoundingClientRect();return {width:Number(r.getAttribute('width')),height:Number(r.getAttribute('height')),stroke:s.strokeWidth,effect:s.vectorEffect,x:p.left-w.left,y:p.top-w.top,pointer:getComputedStyle(b).pointerEvents};})()`);
 assert.deepEqual(boundary,{width:CANVAS_SIZE,height:CANVAS_SIZE,stroke:'6px',effect:'non-scaling-stroke',x:0,y:0,pointer:'none'});
 for(const node of layout.nodes) { assert.equal(node.x%18,0,label+JSON.stringify(node));assert.equal(node.y%18,0,label+JSON.stringify(node));assert.ok(node.gridX<0.1&&node.gridY<0.1,label+JSON.stringify(node)); }
}
async function panCanvas(dx,dy,reverse) {
 await evaluate(`document.querySelector('.wf-stage').scrollIntoView({block:'center',behavior:'instant'})`);
 const before=await evaluate(`(()=>{const s=document.querySelector('.wf-stage'),r=s.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);for(const [x,y] of [[r.left+12,r.top+12],[r.right-12,r.top+12],[r.left+12,r.bottom-12],[r.right-12,r.bottom-12]]){const e=document.elementFromPoint(x,y);if(e?.closest('.wf-stage')&&!e.closest('.wf-node,[data-wf-edge],button'))return {x,y,panX:m.e,panY:m.f,zoom:m.a,width:s.clientWidth,height:s.clientHeight,nodes:[...document.querySelectorAll('.wf-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top])};}throw Error('No background point');})()`);
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:before.x,y:before.y,button:'left',buttons:1,clickCount:1});
 assert.equal(await evaluate('document.querySelector(".wf-stage").classList.contains("is-panning")'),true);
 const distant=Math.max(Math.abs(dx),Math.abs(dy))>1000;
 const move=async(x,y)=>{
  if(distant) await evaluate(`(()=>{const s=document.querySelector('.wf-stage');if(!s.hasPointerCapture(1))throw Error('Pan pointer was not captured');s.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:${x},clientY:${y},buttons:1,bubbles:true}));})()`);
  else await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,buttons:1});
 };
 await move(before.x+dx,before.y+dy);
 const capped=await checkCamera('during pan');
 if(reverse) {await move(before.x+dx+reverse.x,before.y+dy+reverse.y);await checkCamera('reverse at cap',{x:capped.x-reverse.x/before.zoom,y:capped.y-reverse.y/before.zoom});}
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:distant?before.x:before.x+dx,y:distant?before.y:before.y+dy,button:'left',buttons:0,clickCount:1});
 const after=await evaluate(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {panX:m.e,panY:m.f,nodes:[...document.querySelectorAll('.wf-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top]),panning:document.querySelector('.wf-stage').classList.contains('is-panning')};})()`);
 const expectedX=Math.max(before.width/2-CANVAS_SIZE*before.zoom,Math.min(before.width/2,before.panX+dx))+(reverse?.x??0);
 const expectedY=Math.max(before.height/2-CANVAS_SIZE*before.zoom,Math.min(before.height/2,before.panY+dy))+(reverse?.y??0);
 assert.ok(Math.abs(after.panX-expectedX)<.03,JSON.stringify({before,after,dx,expectedX}));
 assert.ok(Math.abs(after.panY-expectedY)<.03,JSON.stringify({before,after,dy,expectedY}));
 assert.deepEqual(after.nodes,before.nodes);
 assert.equal(after.panning,false);
 await checkGrid('panning');
}
async function wheelZoom(delta,bounded=false) {
 const before=await evaluate(`(()=>{const s=document.querySelector('.wf-stage').getBoundingClientRect(),r=document.querySelector('.wf-world').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform),x=Math.round(s.left+s.width*.61),y=Math.round(s.top+s.height*.42);return {x,y,worldX:(x-r.left)/m.a,worldY:(y-r.top)/m.a,zoom:m.a,pageY:scrollY};})()`);
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:delta});
 await delay(50);
 const after=await evaluate(`(()=>{const r=document.querySelector('.wf-world').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {worldX:(${before.x}-r.left)/m.a,worldY:(${before.y}-r.top)/m.a,zoom:m.a,pageY:scrollY};})()`);
 if(!bounded) assert.ok(Math.abs(before.worldX-after.worldX)<.02&&Math.abs(before.worldY-after.worldY)<.02,JSON.stringify({before,after}));
 assert.equal(after.pageY,before.pageY);
 const expected=Math.max(.35,Math.min(1.5,before.zoom*Math.exp(-Math.max(-240,Math.min(240,delta))*.002)));
 assert.ok(Math.abs(after.zoom-expected)<.00001,JSON.stringify({after,expected}));
 await checkGrid('wheel zoom');
}
async function checkCameraControls() {
 for(const [sx,sy] of [[1,1],[-1,-1],[1,-1],[-1,1]]) {
  await panCanvas(sx*20000,sy*20000);
  const corner={x:sx>0?0:CANVAS_SIZE,y:sy>0?0:CANVAS_SIZE};
  await checkCamera('corner',corner);
  for(const [key,code] of [[sx>0?'ArrowLeft':'ArrowRight',sx>0?37:39],[sy>0?'ArrowUp':'ArrowDown',sy>0?38:40]]) {
   await command('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,modifiers:8});
   await command('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
   await checkCamera('keyboard at corner',corner);
  }
  await click('[data-wf-command="zoom-out"]');await checkCamera('toolbar zoom out',corner);
  await click('[data-wf-command="zoom-in"]');await checkCamera('toolbar zoom in',corner);
  await wheelZoom(100,true);await wheelZoom(-100,true);
  await panCanvas(sx*20000,sy*20000,{x:-sx*18,y:-sy*18});
  await panCanvas(sx*20000,sy*20000);
  await viewport(sx>0?390:1800,sy>0?700:1200);await checkGrid('resized at cap');
  await viewport(1440);await checkCamera('desktop restored');
 }
 await click('[data-wf-command="fit"]');await checkGrid('fit after capped camera');
}
async function dragGridNode(dx,dy,scroll=0) {
 await evaluate(`document.querySelector('[data-wf-select="condition"]').scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);
 await delay(50);
 const point=await evaluate(`(()=>{const n=document.querySelector('[data-node-id="condition"]'),r=n.getBoundingClientRect(),w=document.querySelector('.wf-world');return {x:r.left+r.width/2,y:r.top+r.height/3,left:parseFloat(n.style.left),top:parseFloat(n.style.top),zoom:new DOMMatrix(getComputedStyle(w).transform).a};})()`);
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
 if(scroll) await evaluate(`document.querySelector('.wf-stage').scrollTop+=${scroll}`);
 if(Math.max(Math.abs(dx),Math.abs(dy))>1000) {
  // Headless Chromium drops OS mouse moves outside its virtual display. Exercise
  // captured pointer movement at distant world coordinates through the DOM.
  await evaluate(`(()=>{const h=document.querySelector('[data-wf-select="condition"]');if(!h.hasPointerCapture(1))throw Error('Node pointer was not captured');h.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:${point.x+dx},clientY:${point.y+dy},buttons:1,bubbles:true}));})()`);
 } else await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,buttons:1});
 await checkGrid('during drag');
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:Math.max(Math.abs(dx),Math.abs(dy))>1000?point.x:point.x+dx,y:Math.max(Math.abs(dx),Math.abs(dy))>1000?point.y:point.y+dy,button:'left',buttons:0,clickCount:1});
 await checkGrid('after drag');
 const actual=await evaluate(`({x:parseFloat(document.querySelector('[data-node-id="condition"]').style.left),y:parseFloat(document.querySelector('[data-node-id="condition"]').style.top)})`);
 assert.equal(actual.x,Math.min(NODE_BOUNDS.maxX,Math.max(18,Math.round((point.left+dx/point.zoom)/18)*18)));
 if(!scroll) assert.equal(actual.y,Math.min(NODE_BOUNDS.maxY,Math.max(36,Math.round((point.top+dy/point.zoom)/18)*18)));
}
try {
 let port;
 await until(async()=>{try{port=Number((await fs.readFile(path.join(runDir,'profile','DevToolsActivePort'),'utf8')).split('\n')[0]);return port>0;}catch{return false;}});
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 socket=new WebSocket(targets.find(item=>item.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const data=JSON.parse(event.data);const item=pending.get(data.id);if(item){pending.delete(data.id);data.error?item.reject(new Error(data.error.message)):item.resolve(data.result);}if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description??data.params.exceptionDetails.text);if(tracking&&data.method==='Network.requestWillBeSent')requests.push(data.params.request.url);if(data.method==='Page.javascriptDialogOpening')command('Page.handleJavaScriptDialog',{accept:true});});
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await viewport(1440);
 await command('Page.navigate',{url:'http://127.0.0.1:'+address.port});
 await until(()=>evaluate('!!document.querySelector("#auth-form")'));
 await evaluate('(()=>{const form=document.querySelector("#auth-form");form.elements.password.value="temporary-workflow-browser-check";form.elements.confirm.value="temporary-workflow-browser-check";form.requestSubmit();})()');
 await until(()=>evaluate('!!document.querySelector(".calendar")'));
 await click('[data-view="workflow"]');await until(()=>evaluate('document.querySelector(".wf-list-empty strong")?.textContent==="등록된 워크플로우가 없습니다."'));
 assert.equal(await evaluate('document.querySelector("#main").innerText.includes("목업")'),false);
 await click('[data-wf-command="new"]');await until(()=>evaluate('!!document.querySelector("[data-wf-name]")'));
 assert.equal(await evaluate('!!document.querySelector(".wf-secrets")'),false);
 await input('[data-wf-name]','브라우저 저장 검증');await click('[data-wf-add="start"]');await click('[data-wf-add="finish"]');
 const ids=await evaluate('[...document.querySelectorAll(".wf-node")].map(n=>n.dataset.nodeId)');
 await click('[data-wf-output="'+ids[0]+'"]');await click('[data-wf-select="'+ids[1]+'"]');
 await click('[data-wf-command="save"]');await until(()=>evaluate('document.querySelector("[data-wf-save-state]")?.textContent==="저장됨 · v2"'));
 assert.equal(app.vault.state.workflows[0].name,'브라우저 저장 검증');assert.equal(app.vault.state.workflows[0].edges.length,1);assert.equal(calls.length,0);
 await command('Page.reload');await until(()=>evaluate('!!document.querySelector(".calendar")'));await click('[data-view="workflow"]');await until(()=>evaluate('document.querySelectorAll("[data-wf-open]").length===1'));
 await click('[data-wf-toggle]');await until(()=>evaluate('document.querySelector("[data-wf-toggle]")?.getAttribute("aria-checked")==="true"'));
 const flow=app.workflows.list().workflows[0];assert.equal(flow.enabled,true);
 await click('[data-wf-toggle]');await until(()=>evaluate('document.querySelector("[data-wf-toggle]")?.getAttribute("aria-checked")==="false"'));
 const event=(await app.vault.add({title:'브라우저 "실행"',description:'',services:[],category:'maintenance',start:'2026-09-10T00:00:00.000Z',end:null})).event;
 const node=(id,type,config,y=36,x=270)=>({id,type,name:id,x,y,config});const edge=(from,to,port='next')=>({id:from+'-'+port+'-'+to,from,to,port});
 let saved=app.workflows.read(flow.id);
 await app.vault.mutate(state=>{state.workflows.find(item=>item.id===flow.id).secrets={ACCESS:'browser-private-secret'};},{scope:{}});
 saved=await app.workflows.save(flow.id,{...saved,nodes:[node('trigger','start',{service:''}),node('http','http',{method:'POST',url:'http://127.0.0.1:1',headers:'{"Authorization":"Bearer {{secrets.ACCESS}}"}',body:'{"title":"{{event.title}}"}',onError:'stop',timeoutMs:1000,retries:0},252),node('condition','condition',{field:'response.status',operator:'gte',value:'400'},468),node('success','finish',{result:'success',message:'완료'},684,72),node('failure','finish',{result:'failure',message:'거부'},684,396)],edges:[edge('trigger','http'),edge('http','condition'),edge('condition','success','true'),edge('condition','failure','false')]});
 await click('[data-wf-open]');await click('[data-wf-command="reload"]');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===5'));
 await checkNodeActions();
 await checkGrid('loaded');await checkCameraControls();await panCanvas(40,30);await wheelZoom(-100);await dragGridNode(45,35);await click('[data-wf-command="arrange"]');await checkGrid('arrange');
 for(const [dx,dy] of [[20000,20000],[-20000,-20000],[20000,-20000],[-20000,20000]]) {await dragGridNode(dx,dy);await click('[data-wf-command="arrange"]');}
 assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'),true);
 await click('[data-wf-command="save"]');await until(()=>evaluate('document.querySelector("[data-wf-save-state]")?.textContent.startsWith("저장됨")'));
 await screen('workflow-real-desktop');
 const layouts=[];
 for(const width of [1440,900,390]) {await viewport(width,width===390?844:1000);await click('[data-wf-command="fit"]');const layout=await evaluate('({width:innerWidth,page:document.documentElement.scrollWidth,save:!!document.querySelector("[data-wf-command=save]"),main:document.querySelector("#main").getBoundingClientRect().width})');assert.ok(layout.page<=layout.width+1,JSON.stringify(layout));layouts.push(layout);await checkGrid('width '+width);}
 await screen('workflow-real-mobile');await viewport(1440);
 await click('[data-wf-command="rename"]');await input('[data-wf-name]','저장하지 않을 이름');await click('[data-wf-command="revert"]');assert.equal(await evaluate('document.querySelector("[data-wf-editor-title]").textContent'),saved.name);
 await click('[data-wf-command="run"]');await until(()=>evaluate('document.querySelector("#workflow-run-dialog")?.open'));
 await input('#workflow-run-dialog [name=eventId]',event.id);await evaluate('document.querySelector("[data-wf-run-form]").requestSubmit()');
 await until(()=>evaluate('!!document.querySelector("#audit-detail-dialog .audit-result.success")'));
 assert.equal(calls.length,1);assert.equal(calls[0].title,event.title);
 assert.equal(await evaluate('document.querySelectorAll(".audit-run-graph g.success").length'),4);
 assert.equal(await evaluate('document.querySelector("#audit-detail-dialog").innerText.includes("browser-private-secret")'),false);
 await screen('workflow-real-run');await click('[data-audit-run-action="rerun"]');await until(async ()=>(await app.vault.snapshot()).workflowRuns.length===2);
 const rerun = (await app.vault.snapshot()).workflowRuns.find(run => run.parentId);
 await until(()=>evaluate(`document.querySelector('#audit-detail-dialog').innerText.includes('${rerun.id}') && !!document.querySelector('#audit-detail-dialog .audit-result.success')`));assert.equal(calls.length,2);
 await click('#audit-detail-dialog [data-close]');await click('[data-view="workflow"]');await click('[data-wf-command="list"]');await until(()=>evaluate('document.querySelectorAll("[data-wf-open]").length===1'));
 await click('[data-wf-delete-flow]');assert.equal(app.workflows.list().workflows.length,1);await click('#workflow-delete-dialog [data-close]');assert.equal(app.workflows.list().workflows.length,1);
 await click('[data-wf-delete-flow]');await click('[data-wf-confirm-delete]');await until(()=>evaluate('document.querySelector(".wf-list-empty strong")?.textContent==="등록된 워크플로우가 없습니다."'));
 assert.equal((await app.vault.snapshot()).workflowRuns.length,2);assert.equal((await app.workflows.readRun((await app.vault.snapshot()).workflowRuns[0].id)).canRerun,false);
 // Exercise real file selection, validation, OFF import, saved download and current draft replacement.
 await click('[data-wf-command="upload"]');
 await command('DOM.enable');
 async function uploadFile(filename) {
   const doc = await command('DOM.getDocument');
   const selected = await command('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-workflow-file]' });
   await command('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [filename] });
   await until(() => evaluate('!document.querySelector("#workflow-file-dialog [type=submit]").disabled'));
 }
 await uploadFile(path.resolve('examples/workflows/service-state-http.json'));
 assert.equal(app.workflows.list().workflows.length,0);
 await evaluate('document.querySelector("#workflow-file-dialog form").requestSubmit()');
 await until(() => evaluate('document.querySelectorAll(".wf-node").length===15'));
 const imported = app.workflows.list().workflows[0]; assert.equal(imported.enabled,false); assert.equal(calls.length,2);
 for(const type of ['service-state','find','datetime']) assert.equal(await evaluate('!!document.querySelector('+JSON.stringify('[data-wf-add="'+type+'"]')+')'),true);
 await click('[data-wf-select="find"]'); assert.equal(await evaluate('document.querySelectorAll("[data-wf-output=find]").length'),3);
 await click('[data-wf-select="severity"]'); assert.ok(await evaluate('document.querySelector("[data-wf-field=rules]").value.includes("any")'));
 await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: runDir });
 await click('[data-wf-command="download"]');
 const downloaded = path.join(runDir,'workflow-'+imported.id+'.json');
 await until(async () => {try {await fs.access(downloaded);return true;}catch{return false;}});
 assert.equal(JSON.parse(await fs.readFile(downloaded,'utf8')).definition.nodes.length,15);
 const largeNodes = [node('root','cron',{expression:'* * * * *',timezone:'UTC'}), ...Array.from({length:98},(_,i)=>node('date'+i,'datetime',{source:'now',timezone:'UTC',format:'iso'})), node('done','finish',{result:'success',message:''})];
 const large = {format:'service-incident-timeline/workflow',formatVersion:1,requiredSecrets:[],definition:{name:'100 node browser fixture',nodes:largeNodes.map(({x,y,...rest})=>rest),edges:largeNodes.slice(1).map((node,i)=>edge(largeNodes[i].id,node.id))}};
 const largeFile=path.join(runDir,'100-nodes.json');await fs.writeFile(largeFile,JSON.stringify(large));
 await click('[data-wf-command="upload"]');await uploadFile(largeFile);await input('#workflow-file-dialog [name=destination]','current');
 await evaluate('document.querySelector("#workflow-file-dialog form").requestSubmit()');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===100'));
 assert.equal(app.workflows.read(imported.id).nodes.length,15);
 await click('[data-wf-add="datetime"]');assert.equal(await evaluate('document.querySelectorAll(".wf-node").length'),100);
 await click('[data-wf-select="date0"]');assert.equal(await evaluate('document.querySelector("[data-wf-command=duplicate-node]").disabled'),true);
 await click('[data-wf-command="duplicate-node"]');assert.equal(await evaluate('document.querySelectorAll(".wf-node").length'),100);
 await click('[data-wf-command="save"]');await until(()=>app.workflows.read(imported.id).nodes.length===100);
 await click('[data-wf-command="arrange"]');await checkGrid('100 nodes');
 for(const width of [1440,390]) {await viewport(width,width===390?844:1000);await click('[data-wf-command="fit"]');assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);}
 await screen('workflow-100-nodes');
 await viewport(1440);await click('[data-wf-command="list"]');await click('[data-wf-command="services"]');await until(()=>evaluate('document.querySelector("#workflow-file-dialog").open'));await click('#workflow-file-dialog [data-close]');
 // Service manual execution and explicit review resolution use the real authenticated APIs.
 let serviceFlow=app.workflows.read(imported.id);
 serviceFlow=await app.workflows.save(serviceFlow.id,{...serviceFlow,nodes:[node('trigger','service-state',{service:'resource-a'}),node('review','finish',{result:'review',message:'Fixture confirmation required'})],edges:[edge('trigger','review')]});
 await click('[data-wf-open]');await click('[data-wf-command="reload"]');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===2'));
 await click('[data-wf-command="run"]');await until(()=>evaluate('document.querySelector("#workflow-run-dialog").open'));
 assert.equal(await evaluate('document.querySelector("#workflow-run-dialog [name=service]").value'),'resource-a');
 await evaluate('document.querySelector("[data-wf-run-form]").requestSubmit()');await until(()=>evaluate('!!document.querySelector("#audit-detail-dialog .audit-result.review")'));
 assert.ok(await evaluate('!!document.querySelector("[data-audit-run-action=reevaluate]")'));
 const reviewRun=(await app.vault.snapshot()).workflowRuns.find(run=>run.workflowId===imported.id&&run.status==='review');assert.ok(reviewRun);
 await click('[data-audit-run-action="reevaluate"]');await until(async()=>(await app.vault.snapshot()).workflowRuns.some(run=>run.parentId===reviewRun.id&&run.status==='review'));
 await click('#audit-detail-dialog [data-close]');await click('[data-view="workflow"]');await click('[data-wf-command="list"]');await click('[data-wf-command="services"]');await until(()=>evaluate('!!document.querySelector("[data-resolve-service]")'));
 await click('[data-resolve-service]');await until(()=>!app.workflows.serviceStates().find(item=>item.service==='resource-a').hold);
 assert.equal((await app.workflows.readRun(reviewRun.id)).status,'review');assert.equal(calls.length,2);
 await click('#workflow-file-dialog [data-close]');
 // Context values are authored in a real double-click dialog and saved with the node.
 await click('[data-view="workflow"]');
 if(await evaluate('!!document.querySelector("[data-wf-command=list]")')) await click('[data-wf-command="list"]');
 await click('[data-wf-command="new"]');await until(()=>evaluate('!!document.querySelector("[data-wf-name]")'));
 await input('[data-wf-name]','컨텍스트 편집 검증');await click('[data-wf-add="context"]');
 const contextFlow=app.workflows.list().workflows.find(item=>item.name==='새 워크플로우');
 const contextId=await evaluate('document.querySelector(".wf-node").dataset.nodeId');
 await evaluate('document.querySelector("[data-wf-select]").scrollIntoView({block:"center",behavior:"instant"})');
 const contextPoint=await evaluate('(()=>{const r=document.querySelector("[data-wf-select]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
 for(const clickCount of [1,2]) {
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...contextPoint,button:'left',buttons:1,clickCount});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...contextPoint,button:'left',buttons:0,clickCount});
 }
 await until(()=>evaluate('document.querySelector("#workflow-context-dialog").open'));
 const contextKey='#workflow-context-dialog [data-context-key]',contextValue='#workflow-context-dialog [data-context-value]';
 const entryValue='"인용"\n<svg onload="window.contextXss=true">';
 await input(contextKey,'token');await input(contextValue,entryValue);
 await click('[data-context-add]');
 await input('.wf-context-row:last-child [data-context-key]','token');
 await evaluate('document.querySelector("#workflow-context-dialog form").requestSubmit()');
 assert.equal(await evaluate('document.querySelector("#workflow-context-dialog").open'),true);
 assert.ok(await evaluate('document.querySelector("[data-context-error]").textContent.includes("중복")'));
 await input('.wf-context-row:last-child [data-context-key]','empty');
 await screen('workflow-context-desktop');
 await viewport(390,844);
 assert.equal(await evaluate('(()=>{const d=document.querySelector("#workflow-context-dialog"),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1;})()'),true);
 await screen('workflow-context-mobile');
 await evaluate('document.querySelector("#workflow-context-dialog form").requestSubmit()');
 await until(()=>evaluate('!document.querySelector("#workflow-context-dialog").open'));
 assert.equal(await evaluate('window.contextXss===true'),false);
 assert.equal(app.workflows.read(contextFlow.id).nodes.length,0);
 await click('[data-wf-command="save"]');await until(()=>app.workflows.read(contextFlow.id).nodes.length===1);
 assert.deepEqual(app.workflows.read(contextFlow.id).nodes[0].config.entries,[{key:'token',value:entryValue},{key:'empty',value:''}]);
 await viewport(1440);await command('Page.reload');await until(()=>evaluate('!!document.querySelector(".calendar")'));
 await click('[data-view="workflow"]');await until(()=>evaluate('!!document.querySelector('+JSON.stringify('[data-wf-open="'+contextFlow.id+'"]')+')'));
 await click('[data-wf-open="'+contextFlow.id+'"]');await click('[data-wf-select="'+contextId+'"]');
 await evaluate('document.querySelector("[data-wf-select]").focus()');
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until(()=>evaluate('document.querySelector("#workflow-context-dialog").open'));
 assert.equal(await evaluate('document.querySelector("[data-context-value]").value'),entryValue);
 await input(contextValue,'discarded edit');
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await until(()=>evaluate('!document.querySelector("#workflow-context-dialog").open'));
 assert.equal(await evaluate('document.querySelector("[data-wf-command=save]").disabled'),true);
 await click('[data-wf-command="edit-context"]');
 assert.equal(await evaluate('document.querySelector("[data-context-value]").value'),entryValue);
 await click('.wf-context-row:last-child [data-context-remove]');
 await evaluate('document.querySelector("#workflow-context-dialog form").requestSubmit()');
 await click('[data-wf-command="save"]');await until(()=>app.workflows.read(contextFlow.id).nodes[0].config.entries.length===1);
 // Pre-existing secrets expose names and deletion controls only.
 await app.vault.mutate(state=>{state.workflows.find(item=>item.id===contextFlow.id).secrets={LEGACY:'hidden-legacy-value'};},{scope:{}});
 await click('[data-wf-command="reload"]');await until(()=>evaluate('!!document.querySelector("[data-wf-delete-secret]")'));
 assert.equal(await evaluate('!!document.querySelector(".wf-secrets input,.wf-secrets textarea")'),false);
 assert.equal(await evaluate('document.querySelector(".wf-secrets").innerText.includes("hidden-legacy-value")'),false);
 await click('[data-wf-delete-secret]');
 assert.equal(app.vault.state.workflows.find(item=>item.id===contextFlow.id).secrets.LEGACY,'hidden-legacy-value');
 await click('[data-wf-command="revert"]');
 assert.equal(await evaluate('document.querySelector("[data-wf-delete-secret]").disabled'),false);
 await click('[data-wf-delete-secret]');await click('[data-wf-command="save"]');
 await until(()=>evaluate('!document.querySelector(".wf-secrets")'));
 assert.deepEqual(app.workflows.read(contextFlow.id).secretNames,[]);
 // Dry-Run uses the current draft, persists only fixtures, and never makes real calls or audit records.
 let dryFlow=app.workflows.read(contextFlow.id);
 dryFlow=await app.workflows.save(dryFlow.id,{...dryFlow,nodes:[node('dry-trigger','start',{service:''}),node('dry-http','http',{method:'GET',url:'http://127.0.0.1:1',headers:'{}',body:'',onError:'branch',intent:'read',timeoutMs:1000,retries:0},252),node('dry-condition','condition',{field:'response.body.accepted',operator:'equals',value:'true'},468),node('dry-success','finish',{result:'success',message:'fixture success'},684,72),node('dry-failure','finish',{result:'failure',message:'fixture failure'},684,396)],edges:[edge('dry-trigger','dry-http'),edge('dry-http','dry-condition'),edge('dry-http','dry-failure','error'),edge('dry-condition','dry-success','true'),edge('dry-condition','dry-failure','false')]});
 await click('[data-wf-command="reload"]');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===5'));
 await click('[data-wf-select="dry-success"]');await input('[data-wf-field="message"]','unsaved draft result');
 assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'),true);
 assert.equal(await evaluate('document.querySelector("[data-wf-command=dry-run]").disabled'),false);
 const schedule=(await app.vault.add({title:'Saved <img src=x onerror="window.scheduleXss=true"> schedule',description:'registered details',services:[{kind:'custom',label:'payments'}],category:'maintenance',start:'2026-09-09T00:00:00.000Z',end:'2026-09-09T03:00:00.000Z'})).event;
 for(let i=0;i<50;i++) await app.vault.add({title:'Page fixture '+i,description:'',services:[],category:'maintenance',start:'2026-09-11T00:00:00.000Z',end:null});
 const beforeDry=await app.vault.snapshot(),callsBeforeDry=calls.length;
 await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 const dryEvent='[data-dry-node="dry-trigger"] [data-dry-field="event"]';
 const dryBody='[data-dry-node="dry-http"] [data-dry-field="body"]';
 await click('[data-dry-event-open]');await until(()=>evaluate('!!document.querySelector("[data-dry-event-select]")'));
 assert.equal(await evaluate('document.querySelector("[data-dry-events=previous]").disabled'),true);
 await click('[data-dry-events="next"]');await until(()=>evaluate('document.querySelector("[data-dry-event-page-label]").textContent.startsWith("2 / 2")'));
 await input('[data-dry-event-select]',schedule.id);await click('[data-dry-events="apply"]');
 await until(()=>evaluate('JSON.parse(document.querySelector('+JSON.stringify(dryEvent)+').value).id==='+JSON.stringify(schedule.id)));
 assert.deepEqual(await evaluate('JSON.parse(document.querySelector('+JSON.stringify(dryEvent)+').value)'),schedule);
 assert.equal(await evaluate('document.querySelector("[data-dry-field=now]").value'),schedule.start);
 assert.equal(await evaluate('JSON.parse(document.querySelector("[data-dry-field=trigger]").value).scheduledAt'),schedule.start);
 assert.equal(await evaluate('window.scheduleXss===true'),false);
 await screen('workflow-dry-run-schedule');
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 assert.deepEqual(await evaluate('JSON.parse(document.querySelector('+JSON.stringify(dryEvent)+').value)'),schedule);
 const dryValue=JSON.stringify({accepted:true,html:'<img src=x onerror="window.dryXss=true">'});
 await input(dryEvent,JSON.stringify({title:'dry fixture event',category:'incident',services:[]}));
 await input(dryBody,dryValue);
 await until(()=>evaluate('document.querySelector("[data-dry-save-state]").textContent==="입력값 저장됨"'));
 await screen('workflow-dry-run-setup');
 await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');
 await until(()=>evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));
 assert.ok(await evaluate('document.querySelector("[data-dry-result]").innerText.includes("unsaved draft result")'));
 assert.equal(await evaluate('window.dryXss===true'),false);
 assert.ok(await evaluate('!!document.querySelector("[data-dry-result] .wf-dry-status.success")'));
 await screen('workflow-dry-run-result');
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 assert.equal(await evaluate('document.querySelector('+JSON.stringify(dryBody)+').value'),dryValue);
 await input(dryBody,'{unfinished json');
 // Esc flushes the most recent edit even when the autosave timer has not fired.
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 assert.equal(app.workflows.readDryRunSetup(dryFlow.id).setup.nodes['dry-http'].body,'{unfinished json');
 assert.deepEqual((await app.vault.snapshot()).changes,beforeDry.changes);
 assert.deepEqual((await app.vault.snapshot()).workflowRuns,beforeDry.workflowRuns);
 assert.deepEqual((await app.vault.snapshot()).serviceState,beforeDry.serviceState);
 assert.equal(calls.length,callsBeforeDry);
 assert.equal(app.workflows.read(dryFlow.id).definitionVersion,dryFlow.definitionVersion);
 await click('[data-wf-command="revert"]');await command('Page.reload');await until(()=>evaluate('!!document.querySelector(".calendar")'));
 await click('[data-view="workflow"]');await until(()=>evaluate('!!document.querySelector('+JSON.stringify('[data-wf-open="'+dryFlow.id+'"]')+')'));
 await click('[data-wf-open="'+dryFlow.id+'"]');await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 assert.equal(await evaluate('document.querySelector('+JSON.stringify(dryBody)+').value'),'{unfinished json');
 await input(dryBody,'{"accepted":false}');
 await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');await until(()=>evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));
 assert.ok(await evaluate('document.querySelector("[data-dry-result]").innerText.includes("fixture failure")'));
 await input('[data-dry-node="dry-http"] [data-dry-field="outcome"]','error');
 await input('[data-dry-node="dry-http"] [data-dry-field="error"]','simulated timeout');
 await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');await until(()=>evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));
 assert.ok(await evaluate('!!document.querySelector("[data-dry-result] .handled-error")'));
 await viewport(390,844);
 assert.equal(await evaluate('(()=>{const d=document.querySelector("#workflow-dry-run-dialog"),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1;})()'),true);
 await screen('workflow-dry-run-mobile');
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 assert.equal(calls.length,callsBeforeDry);
 const endDraft=await app.workflows.create({name:'Schedule end dry-run',requestId:crypto.randomUUID()});
 const endFlow=await app.workflows.save(endDraft.id,{...endDraft,nodes:[node('end-trigger','end',{service:''}),node('end-finish','finish',{result:'success',message:'{{event.title}}'},252)],edges:[edge('end-trigger','end-finish')]});
 const beforeEnd=await app.vault.snapshot();
 await viewport(1440);await command('Page.reload');await until(()=>evaluate('!!document.querySelector(".calendar")'));
 await click('[data-view="workflow"]');await until(()=>evaluate('!!document.querySelector('+JSON.stringify('[data-wf-open="'+endFlow.id+'"]')+')'));
 await click('[data-wf-open="'+endFlow.id+'"]');await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 await click('[data-dry-event-open]');await until(()=>evaluate('!!document.querySelector("[data-dry-event-select]")'));
 assert.equal(await evaluate('[...document.querySelector("[data-dry-event-select]").options].slice(1).every(option=>option.disabled)'),true);
 await click('[data-dry-events="next"]');await until(()=>evaluate('document.querySelector("[data-dry-event-page-label]").textContent.startsWith("2 / 2")'));
 await input('[data-dry-event-select]',schedule.id);await click('[data-dry-events="apply"]');
 await until(()=>evaluate('document.querySelector("[data-dry-field=now]").value==='+JSON.stringify(schedule.end)));
 assert.equal(await evaluate('JSON.parse(document.querySelector("[data-dry-field=trigger]").value).scheduledAt'),schedule.end);
 await viewport(390,844);
 assert.equal(await evaluate('(()=>{const d=document.querySelector("#workflow-dry-run-dialog");return d.scrollWidth<=d.clientWidth+1;})()'),true);
 await screen('workflow-dry-run-schedule-mobile');
 await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');await until(()=>evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));
 assert.equal(await evaluate('!!document.querySelector("[data-dry-result] .wf-dry-status.success")'),true);
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 assert.deepEqual((await app.vault.snapshot()).changes,beforeEnd.changes);
 assert.deepEqual((await app.vault.snapshot()).workflowRuns,beforeEnd.workflowRuns);
 assert.equal(calls.length,callsBeforeDry);
 { // Service-state schedule scenarios, including unchanged aggregate state.
 const serviceIncident=(await app.vault.add({title:'Multi-service incident',description:'',services:[{kind:'custom',label:'payments'},{kind:'custom',label:'login'}],category:'incident',start:'2026-09-09T01:00:00.000Z',end:'2026-09-09T02:00:00.000Z'})).event;
 const serviceCovered=(await app.vault.add({title:'Covered maintenance',description:'',services:[{kind:'custom',label:'payments'}],category:'maintenance',start:'2026-09-09T01:15:00.000Z',end:'2026-09-09T01:45:00.000Z'})).event;
 const serviceOpen=(await app.vault.add({title:'Open service event',description:'',services:[{kind:'custom',label:'login'}],category:'maintenance',start:'2026-09-12T00:00:00.000Z',end:null})).event;
 const serviceFlow=await app.workflows.create({name:'Service schedule dry-run',requestId:crypto.randomUUID(),nodes:[node('service-trigger','service-state',{service:''}),node('service-finish','finish',{result:'success',message:'{{trigger.service}}:{{trigger.previous}}->{{trigger.severity}}'},252)],edges:[edge('service-trigger','service-finish')]});
 const beforeService=await app.vault.snapshot();
 await viewport(1440);await command('Page.reload');await until(()=>evaluate('!!document.querySelector(".calendar")'));
 await click('[data-view="workflow"]');await until(()=>evaluate('!!document.querySelector('+JSON.stringify('[data-wf-open="'+serviceFlow.id+'"]')+')'));
 await click('[data-wf-open="'+serviceFlow.id+'"]');await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 const serviceTrigger=()=>evaluate('JSON.parse(document.querySelector("[data-dry-field=trigger]").value)');
 const pageTwo=async()=>{await click('[data-dry-event-open]');await until(()=>evaluate('!!document.querySelector("[data-dry-event-select]")'));await click('[data-dry-events="next"]');await until(()=>evaluate('document.querySelector("[data-dry-event-page-label]").textContent.startsWith("2 / 2")'));};
 const runDry=async()=>{await evaluate('document.querySelector("[data-dry-form]").requestSubmit()');await until(()=>evaluate('document.querySelector("[data-dry-result]")?.hidden===false'));};
 await pageTwo();await input('[data-dry-event-select]',serviceIncident.id);
 assert.deepEqual(await evaluate('[...document.querySelector("[data-dry-service]").options].map(option=>option.value)'),['payments','login']);
 await click('[data-dry-events="apply"]');await until(async()=>(await serviceTrigger()).scheduledAt===serviceIncident.start);
 let serviceValues=await serviceTrigger();assert.equal(serviceValues.previous,'warning');assert.equal(serviceValues.severity,'incident');
 assert.deepEqual(serviceValues.events.map(value=>value.id).sort(),[schedule.id,serviceIncident.id].sort());
 assert.equal(await evaluate('!!document.querySelector("[data-dry-field=event]")'),false);
 await input('[data-dry-occurrence]','end');await click('[data-dry-events="apply"]');await until(async()=>(await serviceTrigger()).scheduledAt===serviceIncident.end);
 serviceValues=await serviceTrigger();assert.equal(serviceValues.previous,'incident');assert.equal(serviceValues.severity,'warning');assert.deepEqual(serviceValues.events,[{id:schedule.id,version:schedule.version}]);
 await runDry();assert.equal(await evaluate('document.querySelector("[data-dry-result]").innerText.includes("payments:incident->warning")'),true);
 await input('[data-dry-service]','login');await click('[data-dry-events="apply"]');await until(async()=>(await serviceTrigger()).service==='login');
 serviceValues=await serviceTrigger();assert.equal(serviceValues.previous,'incident');assert.equal(serviceValues.severity,'');assert.deepEqual(serviceValues.events,[]);
 await screen('workflow-dry-run-service');
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));
 assert.deepEqual(await serviceTrigger(),serviceValues);
 await pageTwo();await input('[data-dry-event-select]',serviceIncident.id);
 assert.equal(await evaluate('document.querySelector("[data-dry-service]").value'),'login');
 assert.equal(await evaluate('document.querySelector("[data-dry-occurrence]").value'),'end');
 await input('[data-dry-event-select]',serviceCovered.id);await click('[data-dry-events="apply"]');await until(async()=>(await serviceTrigger()).scheduledAt===serviceCovered.end);
 serviceValues=await serviceTrigger();assert.equal(serviceValues.previous,'incident');assert.equal(serviceValues.severity,'incident');
 await runDry();assert.equal(await evaluate('!!document.querySelector("[data-dry-result] .wf-dry-status.skipped")'),true);
 assert.equal(await evaluate('document.querySelectorAll(".wf-dry-steps>li").length'),1);
 await viewport(390,844);
 assert.equal(await evaluate('(()=>{const d=document.querySelector("#workflow-dry-run-dialog");return d.scrollWidth<=d.clientWidth+1;})()'),true);
 await screen('workflow-dry-run-service-mobile');
 await input('[data-dry-field=trigger]',JSON.stringify({...serviceValues,previous:'warning'}));await runDry();
 assert.equal(await evaluate('!!document.querySelector("[data-dry-result] .wf-dry-status.success")'),true);
 assert.equal(Object.hasOwn(app.workflows.readDryRunSetup(serviceFlow.id).setup.nodes['service-trigger'],'scenario'),false);
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 await viewport(1440);await click('[data-wf-select="service-trigger"]');await input('[data-wf-field=service]','login');
 await click('[data-wf-command="dry-run"]');await until(()=>evaluate('!!document.querySelector("[data-dry-form]")'));await pageTwo();
 assert.equal(await evaluate('document.querySelector('+JSON.stringify('[data-dry-event-select] option[value="'+serviceCovered.id+'"]')+').disabled'),true);
 await input('[data-dry-event-select]',serviceIncident.id);
 assert.deepEqual(await evaluate('[...document.querySelector("[data-dry-service]").options].map(option=>option.value)'),['login']);
 await click('[data-dry-events="previous"]');await until(()=>evaluate('document.querySelector("[data-dry-event-page-label]").textContent.startsWith("1 / 2")'));
 await input('[data-dry-event-select]',serviceOpen.id);
 assert.equal(await evaluate('document.querySelector("[data-dry-occurrence] option[value=end]").disabled'),true);
 await click('[data-dry-close]');await until(()=>evaluate('!document.querySelector("#workflow-dry-run-dialog").open'));
 const afterService=await app.vault.snapshot();
 for(const key of ['events','changes','workflowRuns','serviceState']) assert.deepEqual(afterService[key],beforeService[key]);
 assert.equal(calls.length,callsBeforeDry);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',calls:calls.length,layouts,errors}));
} catch(error) {console.log(JSON.stringify({errors,screen:await evaluate('document.body.innerText')}));await screen('workflow-real-error');throw error;}
finally {
 if(socket?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});socket.close();}
 browser.kill();await app.close();
 const resolved=path.resolve(runDir);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('workflow-browser-'));
 await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
