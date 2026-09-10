// Verify real browser behavior on an ordinary HTTP origin (localhost is trusted).
// Uses an installed Chromium browser and isolated temporary application data.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const tempRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp');
await fs.mkdir(tempRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(tempRoot, 'http-browser-'));
const executable = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
await fs.access(executable);
const app = await createApp({ dataDir: path.join(runDir, 'data'), brandingFile: path.join(runDir, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } });
const address = await app.listen(0);
const localhost = process.argv.includes('--localhost');
const origin = `http://${localhost ? '127.0.0.1' : 'navix.test'}:${address.port}`;
const browser = spawn(executable, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--no-proxy-server', '--host-resolver-rules=MAP navix.test 127.0.0.1',
  '--remote-debugging-port=0', `--user-data-dir=${path.join(runDir, 'profile')}`, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sequence = 0;
const pending = new Map(), errors = [];
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function openServices() {
  await click('#user-menu-toggle');
  await click('[data-action="branding-settings"]');
  await click('#open-services-settings');
  await until(() => evaluate('!document.querySelector("#services-fields").disabled'), 'service settings loaded');
}
try {
  let port;
  await until(async () => { try { port = Number((await fs.readFile(path.join(runDir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; } catch { return false; } }, 'browser start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data), request = pending.get(data.id);
    if (request) { pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
  });
  await command('Page.enable'); await command('Runtime.enable');
  await command('Page.navigate', { url: origin });
  await until(() => evaluate('!!document.querySelector("#auth-form")'), 'authentication form');
  const context = await evaluate('({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues })');
  assert.equal(context.secure, localhost);
  assert.equal(context.randomUUID, localhost ? 'function' : 'undefined');
  assert.equal(context.getRandomValues, 'function');
  console.log(JSON.stringify({ origin, context }));
  await evaluate('(() => { const form = document.querySelector("#auth-form"); form.elements.password.value = "temporary-http-browser-test"; form.elements.confirm.value = "temporary-http-browser-test"; form.requestSubmit(); })()');
  await until(() => evaluate('!!document.querySelector(".calendar")'), 'authentication');
  await openServices();
  assert.equal(await evaluate('document.querySelectorAll("[data-catalog-row]").length'), 0);
  for (const [index, name] of ['HTTP service A', 'HTTP service B'].entries()) {
    await click('#catalog-add');
    assert.equal(await evaluate('document.querySelectorAll("[data-catalog-row]").length'), index + 1, `service add: ${errors.join('\n')}`);
    await evaluate(`document.querySelectorAll('[data-catalog-row] [data-key="name"]')[${index}].value = ${JSON.stringify(name)}`);
  }
  const ids = await evaluate('[...document.querySelectorAll("[data-catalog-row]")].map(row => row.dataset.serviceId)');
  assert.equal(new Set(ids).size, 2);
  ids.forEach(id => assert.match(id, /^service-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  await evaluate('document.querySelector("#services-form").requestSubmit()');
  await until(() => evaluate('!document.querySelector("[data-remove-row]") && !document.querySelector("#services-save").disabled'), 'services saved');
  const saved = await evaluate('fetch("/api/services").then(response => response.json())');
  assert.deepEqual(saved.services.map(service => service.id), ids);
  assert.deepEqual(saved.services.map(service => service.name), ['HTTP service A', 'HTTP service B']);
  await evaluate('window.httpCheckReloading = true');
  await command('Page.reload');
  await until(async () => { try { return await evaluate('!window.httpCheckReloading && !!document.querySelector(".calendar")'); } catch { return false; } }, 'reload');
  await openServices();
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-catalog-row]")].map(row => row.dataset.serviceId)'), ids);
  await click('#branding-dialog [data-close]');

  // Node, edge and request IDs use the same browser capability as service IDs.
  await click('[data-view="workflow"]');
  await until(() => evaluate('!!document.querySelector("[data-wf-command=new]")'), 'workflow list');
  await click('[data-wf-command="new"]');
  await until(() => evaluate('!!document.querySelector("[data-wf-name]")'), 'workflow editor');
  await evaluate('document.querySelector("[data-wf-name]").value = "HTTP workflow"; document.querySelector("[data-wf-name]").dispatchEvent(new Event("input", { bubbles: true }))');
  await click('[data-wf-add="start"]'); await click('[data-wf-add="finish"]');
  const nodes = await evaluate('[...document.querySelectorAll(".wf-node")].map(node => node.dataset.nodeId)');
  assert.equal(nodes.length, 2);
  await click(`[data-wf-output="${nodes[0]}"]`); await click(`[data-wf-select="${nodes[1]}"]`);
  await click('[data-wf-command="save"]');
  await until(() => evaluate('document.querySelector("[data-wf-save-state]")?.textContent === "저장됨 · v2"'), 'workflow saved');
  assert.equal(app.vault.state.workflows[0].edges.length, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', origin, services: saved.services.length, workflowNodes: nodes.length, errors }));
} catch (error) {
  console.error(JSON.stringify({ origin, errors }));
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await command('Browser.close').catch(() => {}); socket.close(); }
  browser.kill(); await app.close();
  const resolved = path.resolve(runDir);
  assert.equal(path.dirname(resolved), tempRoot); assert.ok(path.basename(resolved).startsWith('http-browser-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
