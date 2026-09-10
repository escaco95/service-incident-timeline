import assert from 'node:assert/strict';

export async function checkDiagnostics({ evaluate, click, input, until, command, viewport, screen }) {
  const ready = () => until(() => evaluate('document.querySelector("[data-wf-diagnostics-status]").textContent !== "진단 중…"'));
  const invalid = () => evaluate('[...document.querySelectorAll(".wf-node.has-error")].map(node=>node.dataset.nodeId).sort()');
  const row = id => `[data-wf-diagnostic-node="${id}"]`;
  await ready();
  assert.equal(await evaluate('document.querySelector(".wf-diagnostics").hidden'), true);
  await click('[data-wf-select="trigger"]'); await click('[data-wf-command="duplicate-node"]');
  const copy = await evaluate('document.querySelector(".wf-node.is-selected").dataset.nodeId');
  await ready();
  assert.deepEqual(await invalid(), ['trigger', copy].sort());
  assert.equal(await evaluate('document.querySelectorAll("[data-wf-diagnostic-node]").length'), 2);
  assert.equal(await evaluate('document.querySelector("[data-wf-command=save]").disabled'), false);
  assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'), true);
  const signature = await evaluate('document.querySelector("[data-wf-save-state]").textContent');
  const transform = await evaluate('document.querySelector(".wf-world").style.transform');
  await click(row('trigger'));
  assert.equal(await evaluate('document.querySelector(".wf-node.is-selected").dataset.nodeId'), 'trigger');
  assert.equal(await evaluate('document.querySelector("[data-wf-field=name]").value'), 'trigger');
  assert.equal(await evaluate('document.querySelector(".wf-world").style.transform'), transform, 'single click only selects');
  // Send an actual double click; replacing the list on the first click would lose this target.
  const point = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(row(copy))}),r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  for (const clickCount of [1, 2]) {
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount });
  }
  assert.equal(await evaluate('document.querySelector(".wf-node.is-selected").dataset.nodeId'), copy);
  const centered = await evaluate(`(()=>{const n=document.querySelector('.wf-node.is-selected').getBoundingClientRect(),s=document.querySelector('.wf-stage').getBoundingClientRect(),p=document.querySelector('.wf-palette').getBoundingClientRect(),i=document.querySelector('.wf-inspector').getBoundingClientRect(),d=document.querySelector('.wf-diagnostics').getBoundingClientRect(),b=document.querySelector('.wf-canvas-bar').getBoundingClientRect();return {x:n.left+n.width/2,y:n.top+n.height/2,cx:(p.right+16+i.left-16)/2,cy:(b.bottom+16+d.top-16)/2};})()`);
  assert.ok(Math.abs(centered.x-centered.cx)<1 && Math.abs(centered.y-centered.cy)<1, JSON.stringify(centered));
  assert.equal(await evaluate('document.querySelector("[data-wf-save-state]").textContent'), signature);
  for (const [width, height] of [[1440,900], [390,844], [667,375], [360,640]]) {
    await viewport(width,height); await click('[data-wf-command="fit"]');
    const layout = await evaluate(`(()=>{const d=document.querySelector('.wf-diagnostics').getBoundingClientRect(),f=document.querySelector('.wf-canvas-footer').getBoundingClientRect(),b=document.querySelector('.wf-canvas-bar').getBoundingClientRect();return {left:d.left,right:d.right,top:d.top,bottom:d.bottom,footer:f.top,bar:b.bottom,page:document.documentElement.scrollWidth};})()`);
    assert.ok(layout.left>=0&&layout.right<=width&&layout.top>=layout.bar&&layout.bottom<=layout.footer&&layout.page<=width, JSON.stringify({width,height,layout}));
    if(width===1440 || width===390) await screen('workflow-diagnostics-'+width);
    await click('[data-wf-diagnostics-toggle]');
    assert.equal(await evaluate('document.querySelector("[data-wf-diagnostics-toggle]").getAttribute("aria-expanded")'), 'false');
    assert.deepEqual(await invalid(), ['trigger', copy].sort(), 'collapsed diagnostics keep all error outlines');
    await click('[data-wf-diagnostics-toggle]');
  }
  await viewport(1440,900);
  await evaluate('document.documentElement.dataset.theme="dark"'); await screen('workflow-diagnostics-dark');
  await evaluate('document.documentElement.dataset.theme="light"');
  await click('[data-wf-command="save"]');
  await until(() => evaluate('document.querySelector("[data-wf-save-state]").textContent.startsWith("저장됨")')); await ready();
  assert.deepEqual(await invalid(), ['trigger', copy].sort(), 'saved incomplete draft keeps diagnostics');
  assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'), true);
  await click(row(copy));
  await evaluate(`document.querySelector(${JSON.stringify(row(copy))}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}))`);
  await click('[data-wf-command="delete-node"]'); await ready();
  assert.deepEqual(await invalid(), []);
  assert.equal(await evaluate('document.querySelector(".wf-diagnostics").hidden'), true);
  await click('[data-wf-select="http"]'); await input('[data-wf-field="url"]',''); await ready();
  assert.deepEqual(await invalid(), ['http']);
  assert.ok(await evaluate('document.querySelector(".wf-diagnostics").textContent.includes("HTTP URL")'));
  await input('[data-wf-field="url"]','http://127.0.0.1:1'); await ready();
  assert.deepEqual(await invalid(), []);
  await input('[data-wf-field="retries"]','1'); await ready();
  assert.deepEqual(await invalid(), ['http']);
  assert.ok(await evaluate('document.querySelector("[data-wf-diagnostics-notice]").textContent.startsWith("저장할 수")'));
  await input('[data-wf-field="retries"]','0'); await ready();
  assert.deepEqual(await invalid(), [], 'correcting numeric settings clears the diagnosis');
  // A delayed invalid response must not overwrite a more recent corrected draft.
  await evaluate(`window.diagnosticFetch=window.fetch;window.diagnosticDelayed=false;window.fetch=async(url,options)=>{const response=await window.diagnosticFetch(url,options);if(String(url).endsWith('/diagnostics')&&JSON.parse(options.body).nodes.some(n=>n.type==='http'&&n.config.url==='')){window.diagnosticDelayed=true;await new Promise(resolve=>window.releaseDiagnostic=resolve);}return response;}`);
  await input('[data-wf-field="url"]','');
  await until(() => evaluate('window.diagnosticDelayed'));
  await input('[data-wf-field="url"]','http://127.0.0.1:1'); await ready();
  await evaluate('window.releaseDiagnostic();window.fetch=window.diagnosticFetch');
  await evaluate('new Promise(resolve=>setTimeout(resolve,50))');
  assert.deepEqual(await invalid(), []);
  // Failed diagnosis stays visible and can be retried without changing the draft.
  await evaluate(`window.fetch=(url,options)=>String(url).endsWith('/diagnostics')?Promise.reject(new Error('Diagnostic test offline')):window.diagnosticFetch(url,options)`);
  await input('[data-wf-field="url"]','http://127.0.0.1:2');
  await until(() => evaluate('document.querySelector("[data-wf-diagnostics-retry]").hidden===false'));
  assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'), true);
  await evaluate('window.fetch=window.diagnosticFetch'); await click('[data-wf-diagnostics-retry]'); await ready();
  assert.equal(await evaluate('document.querySelector(".wf-diagnostics").hidden'), true);
  await input('[data-wf-field="url"]','http://127.0.0.1:1'); await ready();
  await click('[data-wf-command="save"]');
  await until(() => evaluate('document.querySelector("[data-wf-save-state]").textContent.startsWith("저장됨")')); await ready();
  assert.equal(await evaluate('document.querySelector("[data-wf-command=run]").disabled'), false);
  for (const name of ['palette','inspector']) if(await evaluate(`document.querySelector('.wf-${name}').hidden`)) await click(`[data-wf-dock="${name}"]`);
  await viewport(1440);
  await until(() => evaluate('document.querySelector("#toast").hidden'));
}
