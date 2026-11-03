import assert from 'node:assert/strict';

export async function checkVault({ app, evaluate, click, waitFor, command, screenshot }) {
  const original = await evaluate('({width:innerWidth,height:innerHeight})');
  const key = 'browser_api_token', first = 'browser-private-original-value', second = 'browser-private-replacement-value';
  const open = async () => {
    await click('document.querySelector("[data-action=branding-settings]")');
    await waitFor('!document.querySelector("#branding-fields").disabled', 'system settings loaded');
    await click('document.querySelector("#vault-tab")');
    await waitFor('!document.querySelector("#vault-fields").disabled', 'vault settings loaded');
  };
  const submit = async value => {
    await evaluate(`(() => {const f=document.querySelector('#vault-form');f.elements.key.value=${JSON.stringify(key)};f.elements.value.value=${JSON.stringify(value)};f.requestSubmit();})()`);
  };
  const replace = async value => {
    await evaluate(`document.querySelector('[data-vault-value="${key}"]').value=${JSON.stringify(value)}`);
    await click(`document.querySelector('[data-vault-edit="${key}"]')`);
  };
  await open();
  await submit(first);
  await waitFor('document.querySelectorAll("[data-vault-edit]").length === 1 && !document.querySelector("#vault-fields").disabled', 'vault key registered');
  assert.equal(await evaluate('document.querySelector("#vault-form").elements.value.value'), '');
  assert.equal(await evaluate(`document.querySelector('#vault-panel').innerHTML.includes(${JSON.stringify(first)})`), false);
  assert.equal(app.secretStore.resolve([key])[key], first);
  assert.equal(await evaluate(`document.querySelector('[data-vault-value="${key}"]').value`), '');
  await replace(second);
  await waitFor(`!document.querySelector('#vault-fields').disabled && document.querySelector('[data-vault-value="${key}"]').value === ''`, 'vault key replaced');
  assert.equal(app.secretStore.resolve([key])[key], second);
  await screenshot('vault-settings');

  await evaluate(`document.querySelector('[data-vault-value="${key}"]').value='discard-row-on-close'`);
  await evaluate('document.querySelector("#vault-form").elements.value.value="discard-on-close"');
  await click('document.querySelector("[data-close=branding-dialog]")');
  await waitFor('document.querySelector("#vault-form").elements.value.value === ""', 'closing settings clears the secret input');
  assert.equal(await evaluate('document.querySelectorAll("[data-vault-value]").length'), 0);
  await open();
  await app.secretStore.save({ version: app.secretStore.read().version, key, value: first });
  await replace('must-not-overwrite-concurrent-change');
  await waitFor('!document.querySelector("#vault-error").hidden', 'stale vault edit rejected');
  assert.equal(app.secretStore.resolve([key])[key], first);
  assert.equal(await evaluate('document.querySelector("#vault-fields").disabled'), true);
  await click('document.querySelector("#vault-reload")');
  await waitFor('!document.querySelector("#vault-fields").disabled', 'reload after vault conflict');

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('vault-settings-mobile');
  const layout = await evaluate(`(() => {const p=document.querySelector('#vault-panel');return {overflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:p.scrollWidth>p.clientWidth+1,masked:document.querySelector('#vault-form').elements.value.type==='password'};})()`);
  assert.deepEqual(layout, { overflow: false, panelOverflow: false, masked: true });
  await click(`document.querySelector('[data-vault-delete="${key}"]')`);
  assert.equal(await evaluate('document.querySelector("#vault-delete-confirm").hidden'), false);
  await click('document.querySelector("#vault-delete-no")');
  assert.equal(app.secretStore.resolve([key])[key], first);
  await click(`document.querySelector('[data-vault-delete="${key}"]')`);
  await click('document.querySelector("#vault-delete-yes")');
  await waitFor('document.querySelectorAll("[data-vault-edit]").length === 0 && !document.querySelector("#vault-fields").disabled', 'vault key deleted');
  assert.throws(() => app.secretStore.resolve([key]), /browser_api_token/);
  await click('document.querySelector("[data-close=branding-dialog]")');
  await command('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor: 1, mobile: false });
}
