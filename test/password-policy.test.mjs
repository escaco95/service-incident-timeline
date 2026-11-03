import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { encryptState, checkPassword, checkSetupPassword } from '../lib/vault.mjs';
import { validNewPassword, NEW_PASSWORD_HINT } from '../public/password-spec.js';
import { readUnlockPassword } from '../lib/startup.mjs';

const password = 'policy-test-password-2026';
const rejected = [undefined, null, 123456789012345, '', 'x'.repeat(14), 'x'.repeat(257), ' '.repeat(15), ' leading-space-password', 'trailing-space-password ', 'internal space password', 'tab\tpassword-2026', 'line\npassword-2026', 'line\rpassword-2026', 'nul\0password-2026', 'delete\u007fpassword-2026', 'control\u0085password-2026', 'nonbreaking\u00a0password', 'zero\u200bwidth-password', 'ideographic\u3000password', 'bidi\u202epassword-2026', 'bom\ufeffpassword-2026', 'surrogate\ud800password', '암호화-password-2026', 'ｅｘａｍｐｌｅ-password', 'emoji-🔑-password-2026'];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-password-policy-'));
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } };
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-password-policy-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, options, async app(extra = {}) { const app = await createApp({ ...options, ...extra }); apps.push(app); return app; } };
}

async function seedLegacy(f, legacy) {
  const app = await f.app({ unlockPassword: password }), state = await app.vault.snapshot(), kdf = app.vault.envelope.kdf;
  const key = await promisify(scrypt)(legacy, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
  try { await app.vault.write(encryptState(state, key, kdf)); }
  finally { key.fill(0); await app.close(); }
}

test('신규 비밀번호는 공백 없는 출력 가능 ASCII 15~256자만 허용하며 문자 종류를 강제하지 않는다', () => {
  const printable = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).join('');
  for (const value of ['x'.repeat(15), 'x'.repeat(256), '123456789012345', '!'.repeat(15), '--valid-startup-password-2026', printable]) {
    assert.equal(validNewPassword(value), true); assert.doesNotThrow(() => checkSetupPassword(value));
  }
  for (const value of rejected) {
    assert.equal(validNewPassword(value), false);
    assert.throws(() => checkSetupPassword(value), { status: 400, message: NEW_PASSWORD_HINT });
  }
  for (const legacy of [' '.repeat(12), 'legacy-암호화-2026', 'legacy\tpassword', 'x'.repeat(12)]) assert.doesNotThrow(() => checkPassword(legacy));
});

test('신규 웹 설정은 부적합한 암호를 안내문·암호화 파일·완료 표시를 쓰기 전에 거부한다', async t => {
  for (const value of rejected) await t.test(String(JSON.stringify(value)), async t => {
    const f = await fixture(t), app = await f.app(), base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    const response = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: value, passwordNotice: '저장되면 안 되는 안내문' }) });
    assert.equal(response.status, 400); assert.equal((await response.json()).error, NEW_PASSWORD_HINT);
    assert.equal(app.vault.initialized, false); assert.equal(app.branding.passwordNotice, '');
    for (const file of ['store.json', 'SETUP_COMPLETE.txt', '.setup-marker-enabled']) await assert.rejects(fs.access(path.join(f.options.dataDir, file)), { code: 'ENOENT' });
    await assert.rejects(fs.access(f.options.brandingFile), { code: 'ENOENT' });
  });
});

test('신규 웹 설정은 15자·256자 경계와 모든 출력 가능 ASCII를 변환 없이 저장한다', async t => {
  const printable = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).join('');
  for (const value of ['x'.repeat(15), 'x'.repeat(256), printable]) await t.test(value.length + ' characters', async t => {
    const f = await fixture(t), app = await f.app(), base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    const response = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: value }) });
    assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), true);
    await app.vault.verifyPassword(value);
  });
});

test('신규 실행 인자·암호 파일도 최초 설정에서 같은 규칙을 적용하고 기존 값은 읽을 때 보존한다', async t => {
  for (const value of ['x'.repeat(12), '  legacy-password-2026  ', 'legacy-암호화-2026', 'legacy\tpassword-2026']) await t.test(JSON.stringify(value), async t => {
    const f = await fixture(t), file = path.join(f.directory, 'password');
    await fs.writeFile(file, value + '\r\n', { mode: 0o600 });
    for (const args of [['--unlock-password', value], ['--unlock-password-file', file]]) {
      const supplied = await readUnlockPassword(args); assert.equal(supplied, value);
      await assert.rejects(f.app({ unlockPassword: supplied }), { status: 400, message: NEW_PASSWORD_HINT });
      assert.deepEqual(await fs.readdir(f.options.dataDir), []);
    }
  });
});

test('구형 공백·Unicode·제어 문자·12자 암호는 원문 그대로 로그인과 암호 재확인이 가능하다', async t => {
  for (const legacy of ['  old-password-2026  ', 'legacy-암호화-2026', 'old\tpassword-2026', 'old\npassword-2026', 'old\0password-2026', 'old\ud800password-2026', ' '.repeat(12), 'x'.repeat(12)]) await t.test(JSON.stringify(legacy), async t => {
    const f = await fixture(t); await seedLegacy(f, legacy);
    const before = await fs.readFile(path.join(f.options.dataDir, 'store.json'));
    const app = await f.app(), base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: legacy }) });
    assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), true);
    await app.vault.verifyPassword(legacy);
    assert.deepEqual(await fs.readFile(app.vault.file), before);
    if (legacy.includes(' ')) await assert.rejects(app.vault.verifyPassword(legacy.replaceAll(' ', '')), error => error.status === 400 || error.status === 403);
    await app.close();
    if (!/[\r\n\0\ud800]/.test(legacy)) {
      const supplied = await readUnlockPassword(['--unlock-password', legacy]);
      const unlocked = await f.app({ unlockPassword: supplied }); assert.equal(unlocked.workflowEngine.status().ready, true);
      assert.deepEqual(await fs.readFile(unlocked.vault.file), before);
    }
  });
});
