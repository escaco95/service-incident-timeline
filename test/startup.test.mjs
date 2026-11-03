import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { Vault } from '../lib/vault.mjs';
import { WorkflowEngine } from '../lib/workflow-engine.mjs';
import { readUnlockPassword } from '../lib/startup.mjs';
import { SETUP_FILE, SETUP_CONTROL_FILE } from '../lib/setup-marker.mjs';

const password = 'startup-password-2026';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-startup-'));
  const shutdownHook = path.join(directory, 'shutdown.mjs');
  // Windows child.kill() terminates Node without dispatching its signal handlers.
  await fs.writeFile(shutdownHook, "process.on('message', signal => { if (['SIGINT', 'SIGTERM'].includes(signal)) process.emit(signal); }); process.channel.unref();\n");
  const options = { dataDir: path.join(directory, 'data'), brandingFile: path.join(directory, 'branding.json'), workflows: { autoStart: false }, logMaintenance: { autoStart: false } };
  const apps = [], children = [];
  t.after(async () => {
    for (const { child, done } of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; }
    for (const app of apps) await app.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('timeline-startup-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, options, children, shutdownHook, async app(extra = {}) { const app = await createApp({ ...options, ...extra }); apps.push(app); return app; } };
}
async function unusedPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function cli(f, args, extra = [], env = {}) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(f.shutdownHook).href, ...extra, 'server.mjs', ...args], { cwd: f.sourceRoot ?? root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(f.port), DATA_DIR: f.options.dataDir, BRANDING_FILE: f.options.brandingFile, TLS_CERT: '', TLS_KEY: '', PUBLIC_ORIGIN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', data => { output += data; });
  child.stderr.setEncoding('utf8').on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const done = once(child, 'close').then(([code, signal]) => { clearTimeout(timer); return { code, signal, output }; });
  f.children.push({ child, done });
  return {
    child, done, get output() { return output; },
    async stop(signal = 'SIGTERM') {
      child.send(signal);
      const result = await done;
      assert.equal(result.code, 0, result.output); assert.equal(result.signal, null);
      await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
    }
  };
}
async function ready(process) {
  return Promise.race([
    new Promise(resolve => { const check = data => { if (data.includes('http://127.0.0.1:')) { process.child.stdout.off('data', check); resolve(); } }; process.child.stdout.on('data', check); }),
    process.done.then(result => { throw Error(`Server exited before listening: ${result.output}`); })
  ]);
}

test('시작 옵션은 두 전달 방식·생략·암호 경계값을 지원하고 잘못된 옵션을 거부한다', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'unlock-password');
  assert.equal(await readUnlockPassword([]), undefined);
  for (const value of [password, '  legacy-password-2026  ', 'x'.repeat(12), 'x'.repeat(256), '--valid-startup-password-2026', 'password-with=equals']) {
    assert.equal(await readUnlockPassword(['--unlock-password', value]), value);
    assert.equal(await readUnlockPassword(['--unlock-password=' + value]), value);
  }
  assert.equal(await readUnlockPassword(['--unlock-password=--unlock-password-file']), '--unlock-password-file');
  for (const suffix of ['', '\n', '\r\n']) {
    await fs.writeFile(file, password + suffix, { mode: 0o600 });
    assert.equal(await readUnlockPassword(['--unlock-password-file', file]), password);
    assert.equal(await readUnlockPassword(['--unlock-password-file=' + file]), password);
  }
  for (const args of [['--unknown', password], ['--unlock-password'], ['--unlock-password-file'], ['--unlock-password', ''], ['--unlock-password', 'short'], ['--unlock-password', 'x'.repeat(257)], ['--unlock-password', password, '--unlock-password', password], ['--unlock-password-file', file, '--unlock-password-file', file], ['--unlock-password', password, '--unlock-password-file', file], ['--unlock-password', '--unlock-password-file']]) await assert.rejects(readUnlockPassword(args));
  for (const args of [['--unlock-password='], ['--unlock-password-file='], ['--unknown=value'], ['--unlock-password=' + password, '--unlock-password-file=' + file], ['--unlock-password=' + password, '--unlock-password=' + password], ['--unlock-password=' + password, 'extra']]) await assert.rejects(readUnlockPassword(args));
  for (const bytes of [Buffer.from(''), Buffer.from('short'), Buffer.from(password + '\n\n'), Buffer.from(password + '\r'), Buffer.from(password + '\0'), Buffer.from('\uFEFF' + password), Buffer.from([0xc3, 0x28]), Buffer.alloc(1027)]) {
    await fs.writeFile(file, bytes); await assert.rejects(readUnlockPassword(['--unlock-password-file', file]));
  }
  await assert.rejects(readUnlockPassword(['--unlock-password-file', path.join(f.directory, 'missing')]));
  await assert.rejects(readUnlockPassword(['--unlock-password-file', f.directory]));
  if (process.platform !== 'win32') {
    await fs.writeFile(file, password); await fs.chmod(file, 0o644);
    await assert.rejects(readUnlockPassword(['--unlock-password-file', file]));
  }
});

test('시작 잠금 해제는 새 저장소와 기존 저장소에서 실행기를 준비하고 웹 인증을 유지한다', async t => {
  const f = await fixture(t);
  let app = await f.app({ unlockPassword: password });
  assert.equal(app.vault.unlocked, true); assert.equal(app.workflowEngine.status().ready, true);
  await app.vault.add({ title: '보존할 일정', category: 'incident', services: [], start: '2031-04-03T00:00:00.000Z', end: null });
  await app.close();
  const before = await fs.readFile(path.join(f.options.dataDir, 'store.json'));
  const unlock = Vault.prototype.unlock; let calls = 0;
  try {
    Vault.prototype.unlock = function (...args) { calls++; return unlock.apply(this, args); };
    app = await f.app({ unlockPassword: password });
  } finally { Vault.prototype.unlock = unlock; }
  assert.equal(calls, 1); assert.deepEqual(await fs.readFile(app.vault.file), before);
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
  const status = await fetch(base + '/api/status');
  assert.deepEqual(await status.json(), { initialized: true, authenticated: false, unlocked: true }); assert.equal(status.headers.has('set-cookie'), false);
  assert.equal((await fetch(base + '/api/events')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); assert.equal(login.headers.has('set-cookie'), true);
  await app.close();
  const locked = await f.app(); assert.equal(locked.vault.unlocked, false); assert.equal(locked.workflowEngine.status().ready, false);
});

test('잘못된 시작 암호는 한 번만 검증하고 파일과 백업을 보존하며 잠금을 해제한다', async t => {
  const f = await fixture(t), app = await f.app({ unlockPassword: password });
  await app.vault.add({ title: '보존', category: 'incident', services: [], start: '2031-04-03T00:00:00.000Z', end: null }); await app.close();
  const files = ['store.json', 'store.json.bak', SETUP_FILE, SETUP_CONTROL_FILE], before = await Promise.all(files.map(file => fs.readFile(path.join(f.options.dataDir, file))));
  const unlock = Vault.prototype.unlock; let calls = 0;
  try {
    Vault.prototype.unlock = function (...args) { calls++; return unlock.apply(this, args); };
    await assert.rejects(f.app({ unlockPassword: 'incorrect-startup-password' }), { status: 401 });
  } finally { Vault.prototype.unlock = unlock; }
  assert.equal(calls, 1);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(f.options.dataDir, file)))), before);
  await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
  const restarted = await f.app({ unlockPassword: password }); assert.equal(restarted.workflowEngine.status().ready, true);
});

test('불완전한 저장소·완료 파일·복원 및 초기화 대기 상태는 변경 없이 시작을 거부한다', async t => {
  for (const artifact of ['store.json', 'store.json.bak', SETUP_FILE, SETUP_CONTROL_FILE, '.system-reset-pending', '.restore-pending.json', 'events', '.store-orphan.tmp']) await t.test(artifact, async t => {
    const f = await fixture(t); await fs.mkdir(f.options.dataDir);
    const file = path.join(f.options.dataDir, artifact);
    if (artifact === 'events') await fs.mkdir(file); else await fs.writeFile(file, artifact === SETUP_FILE ? 'true\n' : artifact === SETUP_CONTROL_FILE ? '1\n' : 'preserve-original');
    await assert.rejects(f.app({ unlockPassword: password }));
    assert.deepEqual(await fs.readdir(f.options.dataDir), [artifact]);
    if (artifact !== 'events') assert.equal(await fs.readFile(file, 'utf8'), artifact === SETUP_FILE ? 'true\n' : artifact === SETUP_CONTROL_FILE ? '1\n' : 'preserve-original');
  });
  for (const missing of ['store.json', SETUP_FILE, SETUP_CONTROL_FILE]) await t.test('기존 저장소에서 ' + missing + ' 누락', async t => {
    const f = await fixture(t), app = await f.app({ unlockPassword: password }); await app.close();
    await fs.unlink(path.join(f.options.dataDir, missing));
    const names = await fs.readdir(f.options.dataDir), before = await Promise.all(names.filter(name => name !== '.transfers').map(async name => [name, await fs.readFile(path.join(f.options.dataDir, name), 'utf8')]));
    await assert.rejects(f.app({ unlockPassword: password }));
    assert.deepEqual(await fs.readdir(f.options.dataDir), names);
    for (const [name, contents] of before) assert.equal(await fs.readFile(path.join(f.options.dataDir, name), 'utf8'), contents);
  });
});

test('실행기 초기화 실패는 준비 완료로 처리하지 않고 키·타이머·디렉터리 잠금을 정리한다', async t => {
  const f = await fixture(t), unlock = WorkflowEngine.prototype.unlock; let engine;
  try {
    WorkflowEngine.prototype.unlock = async function () { engine = this; throw Error('initialization-failed-' + password); };
    await assert.rejects(f.app({ unlockPassword: password }), /initialization-failed/);
  } finally { WorkflowEngine.prototype.unlock = unlock; }
  assert.equal(engine.status().ready, false); assert.equal(engine.vault.unlocked, false); assert.equal(engine.closing, true);
  await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
  const restarted = await f.app({ unlockPassword: password }); assert.equal(restarted.workflowEngine.status().ready, true);
});

test('시작 잠금 해제 후 웹 로그인 없이 새 예약 시각의 HTTP 작업을 실행한다', async t => {
  const f = await fixture(t); let at = '2031-04-03T00:00:00.000Z', calls = 0;
  const workflows = { autoStart: false, clock: () => at, fetch: async () => { calls++; return new Response('{}'); } };
  let app = await f.app({ unlockPassword: password, workflows });
  const flow = await app.workflows.create({ requestId: randomUUID(), name: '로그인 전 예약', nodes: [
    { id: 'cron', type: 'cron', name: '예약', x: 36, y: 36, config: { expression: '* * * * *', timezone: 'UTC' } },
    { id: 'http', type: 'http', name: '호출', x: 36, y: 216, config: { method: 'GET', url: 'https://example.invalid' } }
  ], edges: [{ id: 'next', from: 'cron', to: 'http', port: 'next' }] });
  await app.workflows.enable(flow.id, { version: flow.version, enabled: true }); await app.close();
  app = await f.app({ unlockPassword: password, workflows });
  const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
  at = '2031-04-03T00:01:00.000Z'; await app.workflowEngine.tick();
  await Promise.all([...app.workflowEngine.jobs.values()].map(job => job.promise));
  assert.equal(calls, 1); assert.equal(app.workflowEngine.status().ready, true);
  assert.equal((await fetch(base + '/api/events')).status, 401);
});

test('완료 표시가 있는 손상 저장소도 암호 검증 실패 후 원본과 백업을 보존한다', async t => {
  for (const damage of ['envelope', 'ciphertext', 'unreadable-file']) await t.test(damage, async t => {
    const f = await fixture(t), app = await f.app({ unlockPassword: password }); await app.close();
    const file = path.join(f.options.dataDir, 'store.json');
    const original = await fs.readFile(file); await fs.writeFile(file + '.bak', original);
    if (damage === 'unreadable-file') { await fs.unlink(file); await fs.mkdir(file); }
    else if (damage === 'envelope') await fs.writeFile(file, 'invalid-store');
    else { const envelope = JSON.parse(original); envelope.cipher.tag = Buffer.alloc(16).toString('base64'); await fs.writeFile(file, JSON.stringify(envelope)); }
    const before = damage === 'unreadable-file' ? null : await fs.readFile(file);
    await assert.rejects(f.app({ unlockPassword: password }));
    if (before) assert.deepEqual(await fs.readFile(file), before); else assert.equal((await fs.stat(file)).isDirectory(), true);
    assert.deepEqual(await fs.readFile(file + '.bak'), original);
    await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
  });
});

test('실제 CLI에서 옵션 생략 시 새 저장소는 웹 최초 설정을 기다린다', async t => {
  const f = await fixture(t); f.port = await unusedPort();
  const process = cli(f, []); await ready(process);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${f.port}/api/status`)).json(), { initialized: false, authenticated: false, unlocked: false });
  await assert.rejects(fs.access(path.join(f.options.dataDir, 'store.json')), { code: 'ENOENT' });
  await process.stop();
});

test('기본 데이터 경로는 소스 옆 data이며 다른 작업 데이터 경로를 변경하지 않는다', async t => {
  const f = await fixture(t); f.port = await unusedPort();
  f.sourceRoot = path.join(f.directory, 'source'); await fs.mkdir(f.sourceRoot);
  for (const name of ['server.mjs', 'package.json', 'lib', 'public']) await fs.cp(path.join(root, name), path.join(f.sourceRoot, name), { recursive: true });
  f.options.dataDir = path.join(f.sourceRoot, 'data');
  const process = cli(f, ['--unlock-password', password], [], { DATA_DIR: undefined }); await ready(process);
  assert.equal((await (await fetch(`http://127.0.0.1:${f.port}/api/status`)).json()).unlocked, true);
  const file = path.join(f.options.dataDir, 'store.json'), original = await fs.readFile(file);
  assert.equal(original.toString().includes(password), false);
  await assert.rejects(fs.access(path.join(f.directory, 'data')), { code: 'ENOENT' });
  await process.stop('SIGINT');
  const restarted = cli(f, ['--unlock-password', password], [], { DATA_DIR: undefined }); await ready(restarted);
  assert.deepEqual(await fs.readFile(file), original);
  await restarted.stop();
});

test('PORT 생략 시 기본 8787 포트 충돌은 시작 실패이며 다른 포트로 대체하지 않는다', async t => {
  const f = await fixture(t), occupied = net.createServer();
  try { occupied.listen(8787, '127.0.0.1'); await once(occupied, 'listening'); }
  catch (error) { if (error.code === 'EADDRINUSE') { t.skip('기본 포트를 사용 중인 외부 서버에 영향을 주지 않습니다.'); return; } throw error; }
  try {
    const result = await cli(f, [], [], { PORT: undefined }).done;
    assert.equal(result.code, 1, result.output); assert.equal(result.signal, null);
    assert.match(result.output, /EADDRINUSE.*8787/); assert.equal(result.output.includes('http://'), false);
    await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.options.dataDir, 'store.json')), { code: 'ENOENT' });
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('실제 CLI는 --로 시작하거나 =를 포함한 비밀번호를 두 인자와 = 형식으로 그대로 수용한다', async t => {
  for (const [value, joined] of [['--valid-startup-password-2026', false], ['--valid-startup-password-2026', true], ['--unlock-password-file', true], ['password-with=equals-2026', false], ['password-with=equals-2026', true]]) await t.test(value + (joined ? ' joined' : ' pair'), async t => {
    const f = await fixture(t); f.port = await unusedPort();
    const args = joined ? ['--unlock-password=' + value] : ['--unlock-password', value];
    const process = cli(f, args); await ready(process);
    assert.equal((await (await fetch(`http://127.0.0.1:${f.port}/api/status`)).json()).unlocked, true);
    assert.equal(process.output.includes(value), false);
    await process.stop();
    const app = await f.app({ unlockPassword: value }); assert.equal(app.workflowEngine.status().ready, true);
  });
});

test('실제 CLI의 신규 문자 정책 오류는 원문 없이 안내하고 암호화 파일을 만들지 않는다', async t => {
  for (const value of [' '.repeat(15), 'legacy-암호화-2026', 'x'.repeat(14), 'tab\tpassword-2026']) await t.test(JSON.stringify(value), async t => {
    const f = await fixture(t); f.port = await unusedPort();
    const file = path.join(f.directory, 'password'); await fs.writeFile(file, value + '\n', { mode: 0o600 });
    for (const args of [['--unlock-password=' + value], ['--unlock-password-file=' + file]]) {
      const result = await cli(f, args).done;
      assert.equal(result.code, 1, result.output); assert.equal(result.signal, null);
      assert.match(result.output, /ASCII.*15~256/); assert.equal(result.output.includes(value), false);
      assert.deepEqual(await fs.readdir(f.options.dataDir), []);
    }
  });
});

test('실제 CLI는 두 암호 전달 방식으로 신규·기존 저장소를 시작하고 로그인 세션을 발급하지 않는다', async t => {
  for (const flag of ['--unlock-password', '--unlock-password-file']) await t.test(flag, async t => {
    const f = await fixture(t); f.port = await unusedPort();
    const file = path.join(f.directory, 'password'); await fs.writeFile(file, password + '\r\n', { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const process = cli(f, [flag, flag === '--unlock-password' ? password : file]); await ready(process);
      const base = `http://127.0.0.1:${f.port}`;
      assert.equal((await fetch(base + '/healthz')).status, 200);
      assert.deepEqual(await (await fetch(base + '/api/status')).json(), { initialized: true, authenticated: false, unlocked: true });
      assert.equal((await fetch(base + '/api/events')).status, 401); assert.equal(process.output.includes(password), false);
      await process.stop(attempt ? 'SIGINT' : 'SIGTERM');
    }
  });
});

test('실제 CLI의 입력·암호·초기화 오류는 코드 1로 종료하고 비밀번호와 readiness를 출력하지 않는다', async t => {
  const f = await fixture(t); f.port = await unusedPort();
  const app = await f.app({ unlockPassword: password }); await app.close();
  const stored = await fs.readFile(path.join(f.options.dataDir, 'store.json'));
  const preload = path.join(f.directory, 'fail-engine.mjs');
  await fs.writeFile(preload, `import { WorkflowEngine } from ${JSON.stringify(pathToFileURL(path.join(root, 'lib/workflow-engine.mjs')).href)}; const unlock = WorkflowEngine.prototype.unlock; WorkflowEngine.prototype.unlock = async function () { try { throw Error(${JSON.stringify(password)}); } finally { WorkflowEngine.prototype.unlock = unlock; } };`);
  const cases = [
    { args: ['--unlock-password', 'incorrect-startup-password'] },
    { args: ['--unlock-password-file', path.join(f.directory, 'missing')] },
    { args: ['--unlock-password', password, '--unlock-password-file', 'missing'] },
    { args: ['--unlock-password'] }, { args: ['--unlock-password-file'] },
    { args: ['--unlock-password', password, '--unlock-password', password] },
    { args: ['--unlock-password-file', 'missing', '--unlock-password-file', 'missing'] },
    { args: ['--unlock-password', ''] }, { args: ['--unknown', password] },
    { args: ['--unlock-password', password], extra: ['--import', pathToFileURL(preload).href] },
    { args: ['--unlock-password', password], env: { PORT: 'invalid' } },
    { args: ['--unlock-password', password], env: { TLS_CERT: preload, TLS_KEY: preload } }
  ];
  const occupied = net.createServer(); occupied.listen(f.port, '127.0.0.1'); await once(occupied, 'listening');
  try {
    cases.push({ args: ['--unlock-password', password] });
    for (const { args, extra, env } of cases) {
      const result = await cli(f, args, extra, env).done;
      assert.equal(result.code, 1, result.output); assert.equal(result.signal, null);
      assert.equal(result.output.includes(password), false); assert.equal(result.output.includes('http://'), false);
      assert.deepEqual(await fs.readFile(path.join(f.options.dataDir, 'store.json')), stored);
      await assert.rejects(fs.access(path.join(f.options.dataDir, '.process-lock')), { code: 'ENOENT' });
    }
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});
