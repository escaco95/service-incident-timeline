import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fileURLToPath } from 'node:url';
const tempRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp');
await fs.mkdir(tempRoot, {recursive:true});
const runDir = await fs.mkdtemp(path.join(tempRoot, 'danger-browser-'));
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

async function settings() {await click('#user-menu-toggle');await click('[data-action="branding-settings"]');await until(()=>evaluate('document.querySelector("#branding-dialog").open'));await click('[data-settings-group="danger-zone"]');}
async function choose(target) {await click('[data-reset-target="'+target+'"]');await until(()=>evaluate('document.querySelector("#reset-confirm-dialog").open'));assert.equal(await evaluate('document.querySelector("#reset-password-dialog").open'),false);await click('[data-reset-confirm]');await until(()=>evaluate('document.querySelector("#reset-password-dialog").open'));assert.equal(await evaluate('document.querySelector("#reset-confirm-dialog").open'),false);}
async function submit(value='temporary-workflow-browser-check') {await input('#reset-password-form [name=password]',value);await evaluate('document.querySelector("#reset-password-form").requestSubmit()');}
async function seed() {await app.vault.add({title:'초기화할 기록',description:'',services:[],category:'incident',start:new Date().toISOString(),end:null});await app.workflows.create({name:'초기화할 흐름',requestId:crypto.randomUUID(),nodes:[],edges:[]});}
try {
 let port;
 await until(async()=>{try{port=Number((await fs.readFile(path.join(runDir,'profile','DevToolsActivePort'),'utf8')).split('\n')[0]);return port>0;}catch{return false;}});
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(targets.find(item=>item.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const data=JSON.parse(event.data),item=pending.get(data.id);if(item){pending.delete(data.id);data.error?item.reject(new Error(data.error.message)):item.resolve(data.result);}if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description??data.params.exceptionDetails.text);if(data.method==='Network.requestWillBeSent'&&data.params.request.url.endsWith('/api/settings/reset'))requests.push(data.params.request.url);});
 await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await viewport(1440);
 await command('Page.navigate',{url:'http://127.0.0.1:'+address.port});await until(()=>evaluate('!!document.querySelector("#auth-form")'));
 await evaluate('(()=>{const f=document.querySelector("#auth-form");f.elements.password.value="temporary-workflow-browser-check";f.elements.confirm.value="temporary-workflow-browser-check";f.requestSubmit();})()');
 await until(()=>evaluate('!!document.querySelector(".calendar")'));await seed();await settings();
 assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-reset-target]")].map(n=>n.textContent)'),['감사 로그 초기화','이벤트 초기화','워크플로우 초기화','시스템 초기화']);
 await screen('danger-zone-desktop');await viewport(390,844);await screen('danger-zone-mobile');assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await viewport(1440);
 await click('[data-reset-target="events"]');await click('#reset-confirm-dialog [data-reset-cancel]');assert.equal(requests.length,0);assert.equal((await app.vault.snapshot()).events.length,1);
 await choose('events');await click('#reset-password-dialog [data-reset-cancel]');assert.equal(requests.length,0);assert.equal((await app.vault.snapshot()).events.length,1);
 await choose('events');await submit('incorrect-password');await until(()=>evaluate('!document.querySelector("#reset-password-error").hidden'));
 assert.equal((await app.vault.snapshot()).events.length,1);assert.equal(await evaluate('document.querySelector("#reset-password-form").elements.password.value'),'');assert.equal(await evaluate('!!document.querySelector("#user-menu-toggle")'),true);
 await screen('danger-zone-password-error');await submit();assert.equal(await evaluate('document.querySelector("#reset-submit").disabled'),true);
 assert.equal(await evaluate('document.querySelector("#reset-password-dialog").dispatchEvent(new Event("cancel",{cancelable:true}))'),false);
 await until(()=>evaluate('!document.querySelector("#reset-password-dialog").open && !document.querySelector("#branding-dialog").open'));
 assert.equal((await app.vault.snapshot()).events.length,0);assert.equal(app.vault.state.workflows.length,1);
 await settings();await choose('workflows');await submit();await until(()=>app.vault.state.workflows.length===0);await until(()=>evaluate('!document.querySelector("#branding-dialog").open'));
 await settings();await choose('audit');await submit();await until(async ()=>(await app.vault.snapshot()).changes.length===0);await until(()=>evaluate('!document.querySelector("#branding-dialog").open'));
 await seed();await settings();await choose('system');await screen('danger-zone-system-password');await submit();
 await until(()=>evaluate('!!document.querySelector("#auth-form [name=confirm]")'));assert.equal(app.vault.initialized,false);assert.equal(app.vault.unlocked,false);assert.equal(await evaluate('document.querySelector("#reset-password-form").elements.password.value'),'');
 await evaluate('(()=>{const f=document.querySelector("#auth-form");f.elements.password.value="brand-new-browser-password";f.elements.confirm.value="brand-new-browser-password";f.requestSubmit();})()');await until(()=>evaluate('!!document.querySelector(".calendar")'));assert.equal((await app.vault.snapshot()).events.length,0);assert.equal(app.vault.state.workflows.length,0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',resetRequests:requests.length,checks:['four actions','two dialogs','cancel','wrong password','busy guard','scopes','mobile','system reset','new password'],errors}));
} catch(error) {console.log(JSON.stringify({errors,screen:await evaluate('document.body.innerText')}));await screen('danger-zone-error');throw error;}
finally {if(socket?.readyState===WebSocket.OPEN){await command('Browser.close').catch(()=>{});socket.close();}browser.kill();await app.close();const resolved=path.resolve(runDir);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('danger-browser-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
