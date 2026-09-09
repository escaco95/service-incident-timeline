import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

const password = 'test-only-암호화-비밀번호-2026';
const fields = (suffix = '') => ({ title: `민감한 장애 기록 ${suffix}`, service: '결제 시스템', category: 'incident', start: '2026-09-09T01:00:00.000Z', end: null, description: '비공개 API 토큰 예시: sensitive-fixture' });

test('실제 HTTP 서버: 인증, 암호화, 동시 쓰기, 충돌, 재시작, 변조 보존', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-timeline-test-'));
  let app = await createApp({ dataDir: directory, brandingFile: path.join(directory, 'missing-branding.json') });
  let address = await app.listen(0);
  let base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function call(url, method = 'GET', body, overrides = {}) {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const json = await response.json();
    return { response, json };
  }
  try {
    await t.test('최초 설정 전에도 API 인증 필수, 다른 origin의 요청 거부', async () => {
      assert.deepEqual((await call('/api/branding')).json, { name: 'Service Timeline', subtitle: '서비스 운영 기록', defaultTheme: 'light', timezone: 'UTC', passwordNotice: '' });
      assert.match(await (await fetch(base + '/')).text(), /data-default-theme="light"/);
      assert.equal((await call('/api/status')).json.initialized, false);
      assert.equal((await call('/api/events')).response.status, 401);
      assert.equal((await call('/api/setup', 'POST', { password }, { Origin: 'https://attacker.example' })).response.status, 403);
      assert.equal((await call('/api/setup', 'POST', { password: 'short' })).response.status, 400);
      const result = await call('/api/setup', 'POST', { password });
      assert.equal(result.response.status, 200);
      const setCookie = result.response.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      cookie = setCookie.split(';')[0];
      assert.equal((await call('/api/setup', 'POST', { password })).response.status, 409);
      assert.equal((await call('/api/events', 'GET', undefined, { Cookie: '' })).response.status, 401);
    });

    let created;
    await t.test('동시에 추가한 이벤트가 모두 보존되고 저장 파일에 평문이 없음', async () => {
      const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => call('/api/events', 'POST', fields(index))));
      assert.ok(responses.every(result => result.response.status === 201));
      created = responses[0].json.event;
      const data = (await call('/api/events')).json;
      assert.equal(data.events.length, 12);
      assert.equal(data.revision, 12);
      const encrypted = await fs.readFile(path.join(directory, 'store.json'), 'utf8');
      for (const plain of [password, '민감한', '결제', 'sensitive-fixture', created.id, created.start]) assert.equal(encrypted.includes(plain), false);
      const envelope = JSON.parse(encrypted);
      assert.equal(envelope.cipher.name, 'aes-256-gcm');
      assert.equal(envelope.kdf.name, 'scrypt');
      assert.equal(Buffer.from(envelope.cipher.iv, 'base64').length, 12);
      const backup = JSON.parse(await fs.readFile(path.join(directory, 'store.json.bak'), 'utf8'));
      assert.notEqual(backup.cipher.iv, envelope.cipher.iv);
      assert.equal((await fs.readdir(directory)).some(file => file.endsWith('.tmp')), false);
    });

    await t.test('입력 검증·동시 수정 충돌·삭제 버전 확인', async () => {
      assert.equal((await call('/api/events', 'POST', { ...fields(), end: '2026-09-08T01:00:00.000Z' })).response.status, 400);
      assert.equal((await call('/api/events', 'POST', { ...fields(), start: '2026-02-30T01:00:00.000Z' })).response.status, 400);
      const [a, b] = await Promise.all([
        call(`/api/events/${created.id}`, 'PUT', { ...fields('편집 A'), version: 1 }),
        call(`/api/events/${created.id}`, 'PUT', { ...fields('편집 B'), version: 1 })
      ]);
      assert.deepEqual([a.response.status, b.response.status].sort(), [200, 409]);
      assert.equal((await call(`/api/events/${created.id}`, 'DELETE', { version: 1 })).response.status, 409);
      assert.equal((await call(`/api/events/${created.id}`, 'DELETE', { version: 2 })).response.status, 200);
      assert.equal((await call('/api/events')).json.events.length, 11);
    });

    await t.test('로그아웃은 세션만 종료하고 잘못된 비밀번호는 접근 불가', async () => {
      assert.equal((await call('/api/logout', 'POST', {})).response.status, 200);
      const status = (await call('/api/status')).json;
      assert.equal(status.unlocked, true);
      assert.equal(status.authenticated, false);
      assert.equal((await call('/api/events')).response.status, 401);
      assert.equal((await call('/api/login', 'POST', { password: password + 'wrong' })).response.status, 401);
      const login = await call('/api/login', 'POST', { password });
      assert.equal(login.response.status, 200);
      cookie = login.response.headers.get('set-cookie').split(';')[0];
    });

    await t.test('두 번째 서버는 같은 파일을 동시에 열 수 없음', async () => {
      await assert.rejects(createApp({ dataDir: directory }), /이미 실행 중/);
    });

    await t.test('이름 변경 후 재시작해도 같은 비밀번호로 데이터 복구, 공개 필드만 노출', async () => {
      await app.close();
      const brandingFile = path.join(directory, 'test-branding.json');
      const branding = { name: 'Payment <Ops> & $&', subtitle: '결제 서비스 운영 기록', defaultTheme: 'dark', timezone: 'Asia/Seoul' };
      await fs.writeFile(brandingFile, JSON.stringify({ ...branding, unrelatedField: 'must-not-be-exposed' }));
      const stored = await fs.readFile(path.join(directory, 'store.json'), 'utf8');
      app = await createApp({ dataDir: directory, brandingFile });
      address = await app.listen(0);
      base = `http://127.0.0.1:${address.port}`;
      assert.deepEqual((await call('/api/status')).json, { initialized: true, authenticated: false, unlocked: false });
      assert.deepEqual((await call('/api/branding')).json, { ...branding, passwordNotice: '' });
      assert.equal(app.branding.name, branding.name);
      assert.equal((await call('/api/events')).response.status, 401);
      const login = await call('/api/login', 'POST', { password });
      cookie = login.response.headers.get('set-cookie').split(';')[0];
      assert.equal(login.response.status, 200);
      assert.equal((await call('/api/events')).json.events.length, 11);
      assert.equal(await fs.readFile(path.join(directory, 'store.json'), 'utf8'), stored);
      assert.equal((await fetch(base + '/data/store.json')).status, 404);
      const html = await fetch(base + '/');
      assert.equal(html.status, 200);
      assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const body = await html.text();
      assert.ok(body.includes('<title>Payment &lt;Ops&gt; &amp; $&amp; · 결제 서비스 운영 기록</title>'));
      assert.equal(body.includes('{{APP_TITLE}}'), false);
      assert.ok(body.includes('data-default-theme="dark"'));
      assert.equal(body.includes('{{DEFAULT_THEME}}'), false);
      assert.equal(body.includes('must-not-be-exposed'), false);
    });

    await t.test('암호문 변조 시 로그인 실패하고 원본을 초기화하지 않음', async () => {
      await app.close();
      const file = path.join(directory, 'store.json');
      const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      const bytes = Buffer.from(envelope.ciphertext, 'base64');
      bytes[0] ^= 1;
      envelope.ciphertext = bytes.toString('base64');
      const tampered = JSON.stringify(envelope);
      await fs.writeFile(file, tampered);
      app = await createApp({ dataDir: directory });
      address = await app.listen(0);
      base = `http://127.0.0.1:${address.port}`;
      cookie = '';
      assert.equal((await call('/api/login', 'POST', { password })).response.status, 401);
      assert.equal((await call('/api/setup', 'POST', { password })).response.status, 409);
      assert.equal(await fs.readFile(file, 'utf8'), tampered);
    });

    await t.test('깨진 JSON 파일을 최초 설정 상태로 오인하지 않음', async () => {
      await app.close();
      const file = path.join(directory, 'store.json');
      await fs.writeFile(file, '{broken json');
      app = await createApp({ dataDir: directory });
      address = await app.listen(0);
      base = `http://127.0.0.1:${address.port}`;
      assert.equal((await call('/api/status')).json.initialized, true);
      assert.equal((await call('/api/login', 'POST', { password })).response.status, 503);
      assert.equal(await fs.readFile(file, 'utf8'), '{broken json');
    });
  } finally {
    await app.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('service-timeline-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
