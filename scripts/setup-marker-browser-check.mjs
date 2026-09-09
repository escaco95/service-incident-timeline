import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { SETUP_FILE } from '../lib/setup-marker.mjs';

const tempRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp');
await fs.mkdir(tempRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(tempRoot, 'setup-marker-browser-'));
const dataDir = path.join(runDir, 'data');
const app = await createApp({ dataDir, brandingFile: path.join(runDir, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } });
const address = await app.listen(0);
const browser = spawn(process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${path.join(runDir, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sequence = 0;
const pending = new Map(), errors = [], authRequests = [];
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); } throw Error('Browser wait timed out'); }
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function setup(password) {
  await until(() => evaluate('!!document.querySelector("#auth-form [name=confirm]")'));
  await evaluate(`(()=>{const f=document.querySelector('#auth-form');f.elements.password.value=${JSON.stringify(password)};f.elements.confirm.value=${JSON.stringify(password)};f.requestSubmit();})()`);
  await until(() => evaluate('!!document.querySelector(".calendar")'));
  assert.equal(await fs.readFile(path.join(dataDir, SETUP_FILE), 'utf8'), 'true\n');
}
async function seed() { await app.vault.add({ title: '삭제 전 기록', description: '', services: [], category: 'incident', start: new Date().toISOString(), end: null }); }
try {
  let port;
  await until(async () => { try { port = Number((await fs.readFile(path.join(runDir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; } catch { return false; } });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data), item = pending.get(data.id);
    if (item) { pending.delete(data.id); data.error ? item.reject(Error(data.error.message)) : item.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    if (data.method === 'Network.requestWillBeSent' && /\/api\/(setup|login)$/.test(data.params.request.url)) authRequests.push(new URL(data.params.request.url).pathname);
  });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  await setup('browser-original-password'); await seed();

  // An authenticated screen must clear its session and render setup after its next API request.
  await fs.unlink(path.join(dataDir, SETUP_FILE));
  await click('[data-view="workflow"]');
  await until(() => evaluate('!!document.querySelector("#auth-form [name=confirm]")'));
  assert.equal(app.vault.initialized, false);
  assert.equal(await evaluate('document.querySelector("#auth-form").elements.password.value'), '');
  await setup('browser-second-password'); assert.deepEqual((await app.vault.snapshot()).events, []); await seed();

  // An already-open login page changes automatically, without entering the old password.
  await click('#user-menu-toggle'); await click('[data-action="logout"]');
  await until(() => evaluate('!!document.querySelector("#auth-form") && !document.querySelector("#auth-form [name=confirm]")'));
  await fs.unlink(path.join(dataDir, SETUP_FILE));
  await until(() => evaluate('!!document.querySelector("#auth-form [name=confirm]")'));
  assert.equal(app.vault.initialized, false); assert.ok(authRequests.every(url => url === '/api/setup'));
  await setup('browser-third-password'); assert.deepEqual((await app.vault.snapshot()).events, []);

  // Reloading the page also enters setup immediately after deletion.
  await fs.unlink(path.join(dataDir, SETUP_FILE)); await command('Page.reload');
  await until(() => evaluate('!!document.querySelector("#auth-form [name=confirm]")'));
  await setup('browser-final-password');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', checks: ['authenticated screen', 'login screen polling', 'no old password', 'page reload', 'new password', 'empty records', 'marker recreated'], errors }));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) console.log(JSON.stringify({ errors, screen: await evaluate('document.body.innerText') }));
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await command('Browser.close').catch(() => {}); socket.close(); }
  browser.kill(); await app.close();
  const resolved = path.resolve(runDir); assert.equal(path.dirname(resolved), tempRoot); assert.ok(path.basename(resolved).startsWith('setup-marker-browser-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
