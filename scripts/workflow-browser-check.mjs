import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fileURLToPath } from 'node:url';
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
async function screen(name) { const result=await command('Page.captureScreenshot',{format:'png'}); await fs.writeFile(path.join(tempRoot,name+'.png'),Buffer.from(result.data,'base64')); }
async function viewport(width,height=1000) { await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await delay(200); }
async function checkGrid(label) {
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const layout=await evaluate(`(()=>{const stage=document.querySelector('.wf-stage'),s=getComputedStyle(stage),r=stage.getBoundingClientRect(),step=parseFloat(s.backgroundSize),pos=s.backgroundPosition.split(' ').map(parseFloat),origin={x:r.left+stage.clientLeft+pos[0]+step/2,y:r.top+stage.clientTop+pos[1]+step/2},distance=v=>Math.abs(v-Math.round(v/step)*step);return {step,nodes:[...document.querySelectorAll('.wf-node')].map(n=>{const p=n.getBoundingClientRect();return {id:n.dataset.nodeId,x:parseFloat(n.style.left),y:parseFloat(n.style.top),gridX:distance(p.left-origin.x),gridY:distance(p.top-origin.y)};})};})()`);
 assert.ok(layout.step>0,label);
 for(const node of layout.nodes) { assert.equal(node.x%18,0,label+JSON.stringify(node));assert.equal(node.y%18,0,label+JSON.stringify(node));assert.ok(node.gridX<0.1&&node.gridY<0.1,label+JSON.stringify(node)); }
}
async function panCanvas(dx,dy) {
 await evaluate(`document.querySelector('.wf-stage').scrollIntoView({block:'center',behavior:'instant'})`);
 const before=await evaluate(`(()=>{const s=document.querySelector('.wf-stage'),r=s.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);for(const [x,y] of [[r.left+12,r.top+12],[r.right-12,r.top+12],[r.left+12,r.bottom-12],[r.right-12,r.bottom-12]]){const e=document.elementFromPoint(x,y);if(e?.closest('.wf-stage')&&!e.closest('.wf-node,[data-wf-edge],button'))return {x,y,panX:m.e,panY:m.f,nodes:[...document.querySelectorAll('.wf-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top])};}throw Error('No background point');})()`);
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:before.x,y:before.y,button:'left',buttons:1,clickCount:1});
 assert.equal(await evaluate('document.querySelector(".wf-stage").classList.contains("is-panning")'),true);
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.x+dx,y:before.y+dy,buttons:1});
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:before.x+dx,y:before.y+dy,button:'left',buttons:0,clickCount:1});
 const after=await evaluate(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {panX:m.e,panY:m.f,nodes:[...document.querySelectorAll('.wf-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top]),panning:document.querySelector('.wf-stage').classList.contains('is-panning')};})()`);
 assert.ok(Math.abs(after.panX-before.panX-dx)<.002,JSON.stringify({before,after,dx}));
 assert.ok(Math.abs(after.panY-before.panY-dy)<.002);
 assert.deepEqual(after.nodes,before.nodes);
 assert.equal(after.panning,false);
 await checkGrid('panning');
}
async function wheelZoom(delta) {
 const before=await evaluate(`(()=>{const s=document.querySelector('.wf-stage').getBoundingClientRect(),r=document.querySelector('.wf-world').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform),x=Math.round(s.left+s.width*.61),y=Math.round(s.top+s.height*.42);return {x,y,worldX:(x-r.left)/m.a,worldY:(y-r.top)/m.a,zoom:m.a,pageY:scrollY};})()`);
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:delta});
 await delay(50);
 const after=await evaluate(`(()=>{const r=document.querySelector('.wf-world').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.wf-world')).transform);return {worldX:(${before.x}-r.left)/m.a,worldY:(${before.y}-r.top)/m.a,zoom:m.a,pageY:scrollY};})()`);
 assert.ok(Math.abs(before.worldX-after.worldX)<.02&&Math.abs(before.worldY-after.worldY)<.02,JSON.stringify({before,after}));
 assert.equal(after.pageY,before.pageY);
 const expected=Math.max(.35,Math.min(1.5,before.zoom*Math.exp(-Math.max(-240,Math.min(240,delta))*.002)));
 assert.ok(Math.abs(after.zoom-expected)<.00001,JSON.stringify({after,expected}));
 await checkGrid('wheel zoom');
}
async function dragGridNode(dx,dy,scroll=0) {
 await evaluate(`document.querySelector('[data-wf-select="condition"]').scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);
 await delay(50);
 const point=await evaluate(`(()=>{const n=document.querySelector('[data-node-id="condition"]'),r=n.getBoundingClientRect(),w=document.querySelector('.wf-world');return {x:r.left+r.width/2,y:r.top+r.height/3,left:parseFloat(n.style.left),top:parseFloat(n.style.top),zoom:new DOMMatrix(getComputedStyle(w).transform).a};})()`);
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
 if(scroll) await evaluate(`document.querySelector('.wf-stage').scrollTop+=${scroll}`);
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,buttons:1});
 await checkGrid('during drag');
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',buttons:0,clickCount:1});
 await checkGrid('after drag');
 const actual=await evaluate(`({x:parseFloat(document.querySelector('[data-node-id="condition"]').style.left),y:parseFloat(document.querySelector('[data-node-id="condition"]').style.top)})`);
 assert.equal(actual.x,Math.max(18,Math.round((point.left+dx/point.zoom)/18)*18));
 if(!scroll) assert.equal(actual.y,Math.max(36,Math.round((point.top+dy/point.zoom)/18)*18));
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
 saved=await app.workflows.save(flow.id,{...saved,nodes:[node('trigger','start',{service:''}),node('http','http',{method:'POST',url:'http://127.0.0.1:1',headers:'{"Authorization":"Bearer {{secrets.ACCESS}}"}',body:'{"title":"{{event.title}}"}',onError:'stop',timeoutMs:1000,retries:0},252),node('condition','condition',{field:'response.status',operator:'gte',value:'400'},468),node('success','finish',{result:'success',message:'완료'},684,72),node('failure','finish',{result:'failure',message:'거부'},684,396)],edges:[edge('trigger','http'),edge('http','condition'),edge('condition','success','true'),edge('condition','failure','false')],secrets:{ACCESS:'browser-private-secret'}});
 await click('[data-wf-open]');await click('[data-wf-command="reload"]');await until(()=>evaluate('document.querySelectorAll(".wf-node").length===5'));
 await checkGrid('loaded');await panCanvas(40,30);await wheelZoom(-100);await dragGridNode(45,35);await click('[data-wf-command="arrange"]');await checkGrid('arrange');
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
 await click('[data-wf-command="save"]');await until(()=>app.workflows.read(imported.id).nodes.length===100);
 await click('[data-wf-command="arrange"]');await checkGrid('100 nodes');
 for(const width of [1440,390]) {await viewport(width,width===390?844:1000);await click('[data-wf-command="fit"]');assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);}
 await screen('workflow-100-nodes');
 await viewport(1440);await click('[data-wf-command="list"]');await click('[data-wf-command="services"]');await until(()=>evaluate('document.querySelector("#workflow-file-dialog").open'));await click('#workflow-file-dialog [data-close]');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',calls:calls.length,layouts,errors}));
} catch(error) {console.log(JSON.stringify({errors,screen:await evaluate('document.body.innerText')}));await screen('workflow-real-error');throw error;}
finally {
 if(socket?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});socket.close();}
 browser.kill();await app.close();
 const resolved=path.resolve(runDir);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('workflow-browser-'));
 await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
