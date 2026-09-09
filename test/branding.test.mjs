import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

const password = 'branding-test-only-2026';
const defaults = { name: 'Service Timeline', subtitle: '서비스 운영 기록', showSubtitle: true, defaultTheme: 'light', timezone: 'UTC' };

async function removeTestDirectory(directory) {
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('timeline-branding-'));
  await fs.rm(target, { recursive: true, force: true });
}

test('웹 브랜딩 설정: 인증, 검증, 충돌, 파일 보존, 즉시 반영과 재시작', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-branding-'));
  const brandingFile = path.join(directory, 'branding.json');
  const dataDir = path.join(directory, 'data');
  let app = await createApp({ brandingFile, dataDir });
  let address = await app.listen(0);
  let base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const call = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, json: await response.json() };
  };
  let current, encrypted;
  try {
    await t.test('익명 사용자는 설정을 읽거나 저장할 수 없고 다른 출처의 쓰기를 차단', async () => {
      assert.equal((await call('/api/settings/branding')).response.status, 401);
      assert.equal((await call('/api/settings/branding', 'PUT', {})).response.status, 401);
      const setup = await call('/api/setup', 'POST', { password });
      cookie = setup.response.headers.get('set-cookie').split(';')[0];
      assert.equal((await call('/api/settings/branding', 'PUT', {}, { Origin: 'https://untrusted.example' })).response.status, 403);
      current = (await call('/api/settings/branding')).json;
      assert.deepEqual(current.branding, defaults);
      encrypted = await fs.readFile(path.join(dataDir, 'store.json'), 'utf8');
    });

    await t.test('파일이 없어도 저장하며 숨긴 부제는 편집 화면에만 보존', async () => {
      const branding = { ...defaults, name: 'Payment <Ops> & $&', subtitle: '숨긴 부제', showSubtitle: false, defaultTheme: 'dark', timezone: 'Asia/Seoul', unexpected: 'ignored' };
      const result = await call('/api/settings/branding', 'PUT', { branding, version: current.version });
      assert.equal(result.response.status, 200);
      current = result.json;
      assert.equal(current.branding.subtitle, '숨긴 부제');
      assert.equal(current.branding.showSubtitle, false);
      assert.equal(current.branding.unexpected, undefined);
      const publicConfig = (await call('/api/branding', 'GET', undefined, { Cookie: '' })).json;
      assert.deepEqual(publicConfig, { name: branding.name, subtitle: '', defaultTheme: 'dark', timezone: 'Asia/Seoul' });
      assert.equal(app.branding.name, branding.name);
      const html = await (await fetch(base + '/')).text();
      assert.ok(html.includes('<title>Payment &lt;Ops&gt; &amp; $&amp;</title>'));
      assert.ok(html.includes('data-default-theme="dark"'));
      const saved = JSON.parse(await fs.readFile(brandingFile, 'utf8'));
      assert.equal(saved.subtitle, branding.subtitle);
      assert.equal(saved.unexpected, undefined);
    });

    await t.test('잘못된 필드와 버전은 파일·공개 설정을 바꾸지 않음', async () => {
      const original = await fs.readFile(brandingFile, 'utf8');
      for (const patch of [{ name: ' ' }, { name: 'x\ny' }, { name: 'x'.repeat(65) }, { subtitle: 'x'.repeat(81) }, { subtitle: null }, { showSubtitle: 'false' }, { defaultTheme: 'automatic' }, { timezone: '../invalid' }, { timezone: 'Not/A_Zone' }]) {
        const result = await call('/api/settings/branding', 'PUT', { branding: { ...current.branding, ...patch }, version: current.version });
        assert.equal(result.response.status, 400, JSON.stringify(patch));
      }
      assert.equal((await call('/api/settings/branding', 'PUT', { branding: current.branding })).response.status, 400);
      assert.equal((await call('/api/settings/branding', 'PUT', { branding: [], version: current.version })).response.status, 400);
      assert.equal(await fs.readFile(brandingFile, 'utf8'), original);
      assert.deepEqual((await call('/api/branding')).json, current.publicBranding);
    });

    await t.test('같은 버전의 동시 저장 중 하나만 반영', async () => {
      const results = await Promise.all(['First', 'Second'].map(name => call('/api/settings/branding', 'PUT', { branding: { ...current.branding, name }, version: current.version })));
      assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
      current = results.find(result => result.response.status === 200).json;
      assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).name, current.branding.name);
    });

    await t.test('파일에서 직접 바꾼 설정도 충돌 감지, 알려지지 않은 필드는 비공개로 보존', async () => {
      await fs.writeFile(brandingFile, JSON.stringify({ ...current.branding, name: 'External', privateExtension: 'keep-this-value' }));
      assert.equal((await call('/api/settings/branding', 'PUT', current)).response.status, 409);
      current = (await call('/api/settings/branding')).json;
      assert.equal(current.branding.name, 'External');
      assert.equal(current.branding.privateExtension, undefined);
      const result = await call('/api/settings/branding', 'PUT', { branding: { ...current.branding, name: 'Saved', showSubtitle: true, privateExtension: 'do-not-write' }, version: current.version });
      assert.equal(result.response.status, 200);
      current = result.json;
      assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).privateExtension, 'keep-this-value');
      assert.equal((await call('/api/branding')).json.subtitle, '숨긴 부제');
      assert.equal(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8'), encrypted);
      assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
    });

    await t.test('서버 재시작 후 저장한 설정과 이벤트 데이터 유지', async () => {
      await app.close();
      app = await createApp({ brandingFile, dataDir });
      address = await app.listen(0);
      base = `http://127.0.0.1:${address.port}`;
      assert.deepEqual((await call('/api/branding')).json, current.publicBranding);
      assert.equal((await call('/api/settings/branding')).response.status, 401);
      const login = await call('/api/login', 'POST', { password });
      cookie = login.response.headers.get('set-cookie').split(';')[0];
      assert.deepEqual((await call('/api/settings/branding')).json, { branding: current.branding, version: current.version });
      assert.equal(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8'), encrypted);
    });
  } finally { await app.close(); await removeTestDirectory(directory); }
});

test('브랜딩 저장 실패는 현재 설정을 유지하고 다음 저장을 막지 않음', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-branding-failure-'));
  const brandingFile = path.join(directory, 'missing-parent', 'branding.json');
  const app = await createApp({ dataDir: path.join(directory, 'data'), brandingFile });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0] };
    const current = await (await fetch(base + '/api/settings/branding', { headers })).json();
    const request = { method: 'PUT', headers, body: JSON.stringify({ branding: { ...current.branding, name: 'After retry' }, version: current.version }) };
    assert.equal((await fetch(base + '/api/settings/branding', request)).status, 500);
    assert.equal(app.branding.name, defaults.name);
    await assert.rejects(fs.access(brandingFile), { code: 'ENOENT' });
    await fs.mkdir(path.dirname(brandingFile));
    assert.equal((await fetch(base + '/api/settings/branding', request)).status, 200);
    assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).name, 'After retry');
  } finally { await app.close(); await removeTestDirectory(directory); }
});
