import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export async function changedLines(root, base) {
  const revision = git(root, ['rev-parse', '--verify', '--end-of-options', `${base || 'HEAD'}^{commit}`]).trim();
  const comparison = base ? git(root, ['merge-base', revision, 'HEAD']).trim() : revision;
  const tracked = git(root, ['diff', '--name-only', '-z', '--no-renames', comparison, '--']).split('\0').filter(Boolean);
  const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  const changed = new Map();
  for (const file of [...new Set([...tracked, ...untracked])].sort()) {
    if (!(file === 'server.mjs' || /^(lib|public)\/.*\.(mjs|js)$/.test(file)) || file.startsWith('public/vendor/')) continue;
    let source;
    try { source = await fs.readFile(path.join(root, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const lines = new Set();
    const contents = source.split('\n');
    if (untracked.has(file)) {
      for (let index = 0; index < contents.length; index++) lines.add(index + 1);
    } else {
      const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', comparison, '--', file]);
      for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) lines.add(line);
      }
    }
    const nonempty = [...lines].filter(line => contents[line - 1]?.trim());
    if (nonempty.length) changed.set(file, nonempty);
  }
  return changed;
}

export function coverageWarnings(root, changed, report) {
  const files = new Map();
  let current;
  for (const row of report.split(/\r?\n/)) {
    if (row.startsWith('SF:')) {
      current = { lines: new Map(), branches: new Set() };
      files.set(path.resolve(root, row.slice(3)), current);
    } else if (row.startsWith('DA:') && current) {
      const [line, count] = row.slice(3).split(',').map(Number);
      if (!Number.isInteger(line) || line < 1 || !Number.isFinite(count) || count < 0) throw Error('coverage 줄 측정값이 올바르지 않습니다.');
      current.lines.set(line, count);
    } else if (row.startsWith('BRDA:') && current) {
      const [line, , , count] = row.slice(5).split(',');
      if (count === '-' || Number(count) === 0) current.branches.add(Number(line));
    } else if (row === 'end_of_record') current = undefined;
  }
  if (!files.size || ![...files.values()].some(file => file.lines.size)) throw Error('coverage 측정 결과가 비어 있습니다.');
  const warnings = [];
  for (const [file, lines] of changed) {
    const coverage = files.get(path.resolve(root, file));
    if (!coverage) {
      warnings.push(`${file}: 변경 파일의 Node coverage 측정 정보가 없습니다. 테스트 연결 여부와 해당 브라우저 검증을 확인하세요.`);
      continue;
    }
    for (const line of lines) {
      if (coverage.lines.get(line) === 0) warnings.push(`${file}:${line}: 변경된 줄이 테스트에서 실행되지 않았습니다.`);
      else if (coverage.branches.has(line)) warnings.push(`${file}:${line}: 변경된 줄에 실행되지 않은 분기가 있습니다.`);
    }
  }
  return warnings;
}
