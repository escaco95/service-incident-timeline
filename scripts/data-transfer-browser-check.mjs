import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { ZipReader } from '../lib/archive-zip.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), tempRoot = path.join(root, '.tmp');
await fs.mkdir(tempRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(tempRoot, 'data-transfer-browser-')), downloads = path.join(runDir, 'downloads');
await fs.mkdir(downloads);
const app = await createApp({ dataDir: path.join(runDir, 'data'), brandingFile: path.join(runDir, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } });
const address = await app.listen(0), password = 'browser-data-transfer-password';
const browser = spawn(process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${path.join(runDir, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sequence = 0;
const pending = new Map(), errors = [], restoreRequests = [];
async function until(check) { for (let i = 0; i < 150; i++) { if (await check()) return; await delay(100); } throw Error('Browser wait timed out'); }
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function settings() { await click('#user-menu-toggle'); await click('[data-action="branding-settings"]'); await until(() => evaluate('document.querySelector("#branding-dialog").open')); await click('#danger-zone-tab'); }
async function selectFile(file) { const { root } = await command('DOM.getDocument'); const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: '#data-archive' }); await command('DOM.setFileInputFiles', { nodeId, files: [file] }); }
async function screenshot(name) { const result = await command('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(tempRoot, name + '.png'), Buffer.from(result.data, 'base64')); }
try {
  let port;
  await until(async () => { try { port = Number((await fs.readFile(path.join(runDir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; } catch { return false; } });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data), item = pending.get(data.id);
    if (item) { pending.delete(data.id); data.error ? item.reject(Error(data.error.message)) : item.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    if (data.method === 'Network.requestWillBeSent' && /\/transfers\/.+\/restore$/.test(data.params.request.url)) restoreRequests.push(data.params.request.url);
  });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `http://127.0.0.1:${address.port}` }); await until(() => evaluate('!!document.querySelector("#auth-form [name=confirm]")'));
  await evaluate(`(()=>{const f=document.querySelector('#auth-form');f.elements.password.value=${JSON.stringify(password)};f.elements.confirm.value=${JSON.stringify(password)};f.requestSubmit();})()`);
  await until(() => evaluate('!!document.querySelector(".calendar")'));
  await app.vault.add({ title: 'ZIP에 보관할 기록', description: '복원할 내용', services: [], category: 'incident', start: new Date().toISOString(), end: null });
  await settings(); await click('#data-export');
  assert.equal(await evaluate('document.querySelector("#data-export").disabled'), true);
  await until(() => evaluate('!document.querySelector("#data-download").hidden'));
  assert.equal(await evaluate('document.querySelector("#data-export").textContent'), '데이터 내보내기');
  const name = await evaluate('document.querySelector("#data-download").download'); assert.match(name, /^\d{4}_\d{2}_\d{2}\.zip$/);
  await click('#data-download'); const archive = path.join(downloads, name);
  await until(async () => { try { return (await fs.stat(archive)).size > 0; } catch { return false; } });
  const zip = await new ZipReader().open(archive); assert.equal(JSON.parse((await zip.get('manifest.json')).toString()).counts.events, 1); await zip.close();
  await app.vault.add({ title: '복원으로 교체될 기록', description: '', services: [], category: 'incident', start: new Date().toISOString(), end: null });
  const invalid = path.join(runDir, 'bad.zip'); await fs.writeFile(invalid, Buffer.alloc(100, 1)); await selectFile(invalid);
  await until(() => evaluate('document.querySelector("#import-status").classList.contains("form-error")'));
  assert.equal(await evaluate('document.querySelector("#data-restore").hidden'), true); assert.equal((await app.vault.read()).total, 2);
  await selectFile(archive); await until(() => evaluate('!document.querySelector("#data-restore").hidden'));
  assert.equal(await evaluate('document.querySelector("#data-import").textContent'), '데이터 복원하기'); assert.equal(await evaluate('document.querySelector("#data-restore").textContent'), name + ' 데이터로 복원');
  assert.equal((await app.vault.read()).total, 2); assert.equal(restoreRequests.length, 0);
  await screenshot('data-transfers-ready'); await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await screenshot('data-transfers-mobile');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('#data-restore'); await until(() => evaluate('document.querySelector("#reset-confirm-dialog").open')); await click('#reset-confirm-dialog [data-reset-cancel]'); assert.equal(restoreRequests.length, 0);
  await click('#data-restore'); await click('[data-reset-confirm]'); await until(() => evaluate('document.querySelector("#reset-password-dialog").open'));
  await evaluate('(()=>{const f=document.querySelector("#reset-password-form");f.elements.password.value="incorrect-password";f.requestSubmit();})()');
  await until(() => evaluate('!document.querySelector("#reset-password-error").hidden')); assert.equal((await app.vault.read()).total, 2);
  await evaluate(`(()=>{const f=document.querySelector('#reset-password-form');f.elements.password.value=${JSON.stringify(password)};f.requestSubmit();})()`);
  await until(() => evaluate('!document.querySelector("#branding-dialog").open'));
  assert.equal((await app.vault.read()).total, 1); assert.equal((await app.vault.read()).events[0].title, 'ZIP에 보관할 기록'); assert.equal(await evaluate('!!document.querySelector(".calendar")'), true);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ result: 'passed', checks: ['export progress', 'native ZIP download', 'invalid upload', 'validated preview', 'no early mutation', 'two confirmations', 'wrong password', 'restore', 'mobile'], errors }));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) { console.log(JSON.stringify({ errors, screen: await evaluate('document.body.innerText') })); await screenshot('data-transfers-error'); }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await command('Browser.close').catch(() => {}); socket.close(); }
  browser.kill(); await app.close(); const resolved = path.resolve(runDir); assert.equal(path.dirname(resolved), tempRoot); assert.ok(path.basename(resolved).startsWith('data-transfer-browser-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
