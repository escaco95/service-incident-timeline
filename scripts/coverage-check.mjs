import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { changedLines, coverageWarnings } from './coverage-changes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--base' || !args[1])) throw Error('사용법: node scripts/coverage-check.mjs [--base 기준브랜치]');
  const changed = await changedLines(root, args[1]);
  const temporaryRoot = path.join(root, '.tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'coverage-'));
  const reportFile = path.join(directory, 'coverage.lcov');
  const tests = (await fs.readdir(path.join(root, 'test'))).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join('test', file));
  if (!tests.length) throw Error('실행할 테스트 파일이 없습니다.');
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--test', '--experimental-test-coverage',
      '--test-coverage-exclude=test/**', '--test-coverage-exclude=scripts/**', '--test-coverage-exclude=public/vendor/**',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=lcov', `--test-reporter-destination=${reportFile}`, ...tests,
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) throw Error(`테스트 또는 coverage 수집이 실패했습니다 (${status.signal || status.code}).`);
  const warnings = coverageWarnings(root, changed, await fs.readFile(reportFile, 'utf8'));
  console.log(`\n변경 코드 coverage: ${changed.size}개 파일, 경고 ${warnings.length}개`);
  for (const warning of warnings) console.warn(`[coverage 경고] ${warning}`);
  console.log(`측정 보고서: ${path.relative(root, reportFile)}`);
  console.log('\n[작업 완료 전 재확인 — 자동 검사로 판정하지 않는 항목]');
  console.log('- 변경한 요구사항의 정상·오류·경계값을 의미 있는 검증문으로 테스트했는지 확인하세요.');
  console.log('- 화면 동작을 변경했다면 관련 브라우저 검증을 실행했는지 확인하세요.');
  console.log('- coverage 경고를 보완했거나 측정 한계·미검증 사유를 완료 보고에 남겼는지 확인하세요.');
  console.log('- 커밋 시 type: 제목 형식, 제목에 변경 영역 표기, 필요한 본문의 짧은 대시 항목을 준수했는지 확인하세요.');
} catch (error) {
  console.error(`[coverage 오류] ${error.message}`);
  process.exitCode = 1;
}
