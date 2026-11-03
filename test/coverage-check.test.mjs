import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { changedLines, coverageWarnings } from '../scripts/coverage-changes.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

async function write(root, file, content) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-coverage-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('timeline-coverage-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Coverage Test');
  git(root, 'config', 'user.email', 'coverage@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  await write(root, '.gitignore', '.tmp/\nignored/\n');
  await write(root, 'package.json', '{"type":"module"}\n');
  await write(root, 'lib/value.mjs', 'export const first = 1;\nexport const second = 2;\nexport const third = 3;\n');
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
  git(root, 'tag', 'baseline');
  return root;
}

test('변경 줄은 최종 작업 파일 기준으로 staged·unstaged·새 파일을 포함하고 삭제·외부 코드는 제외한다', async t => {
  const root = await fixture(t);
  await write(root, 'lib/value.mjs', 'export const first = 10;\nexport const second = 2;\nexport const third = 3;\n');
  git(root, 'add', 'lib/value.mjs');
  await write(root, 'lib/value.mjs', 'export const first = 10;\nexport const second = 2;\nexport const third = 30;\n');
  await write(root, 'lib/새 파일.mjs', '\nexport const added = true;\n');
  await write(root, 'public/vendor/skip.js', 'throw Error();');
  await write(root, 'test/skip.test.mjs', 'throw Error();');
  await write(root, 'ignored/skip.mjs', 'throw Error();');
  assert.deepEqual([...await changedLines(root)], [['lib/value.mjs', [1, 3]], ['lib/새 파일.mjs', [2]]]);
  await write(root, 'lib/value.mjs', 'export const second = 2;\nexport const third = 3;\n');
  assert.equal((await changedLines(root)).has('lib/value.mjs'), false);
  await fs.unlink(path.join(root, 'lib/value.mjs'));
  assert.equal((await changedLines(root)).has('lib/value.mjs'), false);
});

test('명시적 기준은 공통 조상부터 커밋된 변경과 새 이름의 파일까지 검사한다', async t => {
  const root = await fixture(t);
  git(root, 'mv', 'lib/value.mjs', 'lib/renamed.mjs');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'rename');
  assert.equal((await changedLines(root)).size, 0);
  assert.deepEqual([...await changedLines(root, 'baseline')], [['lib/renamed.mjs', [1, 2, 3]]]);
  await assert.rejects(changedLines(root, 'missing-ref'));
});

test('LCOV의 미실행 변경 줄·분기와 미측정 파일만 경고하고 정상 실행·기존 누락은 허용한다', () => {
  const root = path.resolve('coverage-fixture');
  const changed = new Map([['lib/value.mjs', [2, 3, 4, 5]], ['public/화면.js', [1]]]);
  const report = 'SF:lib/value.mjs\r\nDA:1,0\r\nDA:2,0\r\nDA:3,1\r\nDA:4,1\r\nBRDA:3,0,0,0\r\nBRDA:4,0,0,1\r\nend_of_record\r\n';
  const warnings = coverageWarnings(root, changed, report);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /lib\/value.mjs:2:.*실행되지/);
  assert.match(warnings[1], /lib\/value.mjs:3:.*분기/);
  assert.match(warnings[2], /public\/화면.js:.*측정 정보가 없습니다/);
  assert.equal(coverageWarnings(root, new Map([['lib/value.mjs', [4]]]), report).length, 0);
  assert.throws(() => coverageWarnings(root, changed, ''), /비어/);
  assert.throws(() => coverageWarnings(root, changed, 'SF:lib/value.mjs\nDA:1,no\n'), /올바르지/);
});

test('실제 명령은 coverage 경고에서 성공하고 테스트 실패·측정 누락·잘못된 인자에서 실패한다', async t => {
  const root = await fixture(t);
  for (const file of ['coverage-check.mjs', 'coverage-changes.mjs']) {
    await write(root, `scripts/${file}`, await fs.readFile(new URL(`../scripts/${file}`, import.meta.url), 'utf8'));
  }
  await write(root, 'lib/changed.mjs', 'export function value(ok) {\n  if (ok) return 1;\n  return 2;\n}\n');
  await write(root, 'public/app.js', 'document.title = "브라우저 전용";\n');
  await write(root, 'public/password-spec.js', 'export function valid(ok) {\n  if (ok) return 1;\n  return 2;\n}\n');
  await write(root, 'public/audit-ui.js', 'export function range(ok) {\n  if (ok) return 1;\n  return 2;\n}\n');
  await write(root, 'public/새 화면.js', 'document.title = "화면";\n');
  const passing = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../lib/changed.mjs";\nimport { valid } from "../public/password-spec.js";\nimport { range } from "../public/audit-ui.js";\ntest("정상 경로", () => { assert.equal(value(true), 1); assert.equal(valid(true), 1); assert.equal(range(true), 1); });\n';
  await write(root, 'test/value.test.mjs', passing);
  const env = { ...process.env };
  // Nested runners must not inherit the outer runner's context or coverage directory.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/coverage-check.mjs'), ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const warned = run();
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stderr, /lib\/changed.mjs:3:.*실행되지/);
  assert.match(warned.stderr, /public\/password-spec.js:3:.*실행되지/);
  assert.match(warned.stderr, /public\/audit-ui.js:3:.*실행되지/);
  assert.match(warned.stderr, /public\/새 화면.js:.*측정 정보가 없습니다/);
  assert.doesNotMatch(warned.stderr, /public\/app.js/);
  assert.match(warned.stdout, /브라우저 전용 변경: 1개 파일/);
  assert.match(warned.stdout, /\[브라우저 검증 필요\] public\/app.js/);
  await write(root, 'test/value.test.mjs', passing + 'test("오류 경로", () => { assert.equal(value(false), 2); assert.equal(valid(false), 2); assert.equal(range(false), 2); });\n');
  await fs.unlink(path.join(root, 'public/새 화면.js'));
  const covered = run();
  assert.equal(covered.status, 0, covered.stdout + covered.stderr);
  assert.doesNotMatch(covered.stderr, /coverage 경고/);
  assert.match(covered.stdout, /\[브라우저 검증 필요\] public\/app.js/);
  await write(root, 'test/value.test.mjs', passing + 'test("실패", () => assert.fail("expected"));\n');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /테스트 또는 coverage 수집이 실패/);
  await write(root, 'test/value.test.mjs', 'import test from "node:test";\ntest("빈 테스트", () => {});\n');
  assert.equal(run().status, 1);
  assert.equal(run('--base', 'missing-ref').status, 1);
  assert.equal(run('--unknown').status, 1);
});
