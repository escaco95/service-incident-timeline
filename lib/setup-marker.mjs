import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

export const SETUP_FILE = 'SETUP_COMPLETE.txt';
// Tracks adoption so upgrading an existing installation cannot erase its data.
export const SETUP_CONTROL_FILE = '.setup-marker-enabled';

async function readFlag(directory, name, expected) {
  const file = path.join(directory, name);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new AppError(503, '초기 설정 완료 파일을 확인하지 못했습니다. 서버 파일 권한을 확인해 주세요.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) throw new AppError(503, `${name} 파일 형식을 확인해 주세요.`);
  let value;
  try { value = await fs.readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new AppError(503, '초기 설정 완료 파일을 읽지 못했습니다. 서버 파일 권한을 확인해 주세요.');
  }
  if (value.trim() !== expected) throw new AppError(503, `${name} 내용이 올바르지 않습니다. 임의의 값 변경은 초기화로 처리하지 않습니다.`);
  return true;
}

async function writeFlag(directory, name, value) {
  const temporary = path.join(directory, `.setup-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, name));
    if (process.platform !== 'win32') { const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export async function createSetupMarker(directory) {
  await writeFlag(directory, SETUP_FILE, 'true');
  await writeFlag(directory, SETUP_CONTROL_FILE, '1');
}

export async function enrollSetupMarker(vault) {
  if (!await readFlag(vault.directory, SETUP_CONTROL_FILE, '1') && vault.initialized) {
    // Enrollment creates only control files; the encrypted store is untouched.
    if (!await readFlag(vault.directory, SETUP_FILE, 'true')) await writeFlag(vault.directory, SETUP_FILE, 'true');
    await writeFlag(vault.directory, SETUP_CONTROL_FILE, '1');
  }
}

export async function operatorResetRequested(vault) {
  if (!await readFlag(vault.directory, SETUP_CONTROL_FILE, '1')) return false;
  if (!await readFlag(vault.directory, SETUP_FILE, 'true')) return true;
  if (!vault.initialized) throw new AppError(503, '설정 완료 파일은 있지만 저장소가 없습니다. 복원하거나 SETUP_COMPLETE.txt를 삭제하여 초기화해 주세요.');
  return false;
}

export async function removeSetupMarker(directory) {
  await fs.rm(path.join(directory, SETUP_FILE), { force: true });
  await fs.rm(path.join(directory, SETUP_CONTROL_FILE), { force: true });
}
