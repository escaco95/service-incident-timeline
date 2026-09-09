import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptState, decryptState } from './vault.mjs';
import { AppError } from './errors.mjs';
import { validateBranding } from './branding.mjs';

const journalFile = vault => path.join(vault.directory, '.restore-pending.json');
export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function linkCopy(source, target) {
  try { await fs.link(source, target); }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error;
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    const handle = await fs.open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  }
}
export async function hasPendingRestore(vault) { try { await fs.access(journalFile(vault)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

// Once this journal exists, restoration is committed and startup must finish it.
// All encrypted date files are durable before the journal can be published.
export async function completeRestore(vault, branding) {
  const file = journalFile(vault), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw Error('Invalid restore journal');
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  if (journal.version !== 1 || !journal.envelope || journal.envelope.version !== 1) throw Error('Invalid restore journal');
  const labels = validateBranding(journal.branding);
  await branding.replace(labels); await syncDirectory(path.dirname(branding.file));
  await vault.write(journal.envelope); await vault.adoptEnvelope(journal.envelope);
  // If deletion is interrupted, replaying the same committed snapshot is safe.
  await fs.unlink(file);
  return branding.branding;
}

export async function publishRestore(vault, branding, prepared) {
  const envelope = JSON.parse(await fs.readFile(path.join(prepared, 'store.json'), 'utf8'));
  const manifest = decryptState(envelope, vault.key), labels = validateBranding(JSON.parse(await fs.readFile(path.join(prepared, 'branding.json'), 'utf8')));
  if (manifest.dailyStorageVersion !== 2 || !Array.isArray(manifest.files)) throw new AppError(400, '검증한 복원 데이터를 다시 확인해 주세요.');
  const linked = [], directories = new Set(), temporary = path.join(vault.directory, `.restore-${randomUUID()}.tmp`);
  let committed = false;
  try {
    for (const ref of manifest.files) {
      if (!/^(events|events-open|audit|audit-active|lookup)$/.test(ref.kind) || !new RegExp(`^${ref.kind}/(?:\\d{4}-\\d{2}-\\d{2}|undated|[0-9a-f]{2})\\.[0-9a-f-]{36}\\.json$`).test(ref.file)) throw Error('Invalid prepared path');
      const destination = path.resolve(vault.directory, ref.file), directory = path.dirname(destination);
      if (path.dirname(directory) !== vault.directory) throw Error('Invalid restore path');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid restore directory');
      await linkCopy(path.join(prepared, ref.file), destination); linked.push(destination); directories.add(directory);
    }
    for (const directory of directories) await syncDirectory(directory);
    const live = new Set(manifest.files.map(ref => ref.file));
    manifest.garbage = [...new Map([...(vault.daily?.refs() ?? []), ...(vault.daily?.backup?.files ?? []), ...(vault.daily?.garbage ?? [])].filter(ref => !live.has(ref.file)).map(ref => [ref.file, ref])).values()];
    manifest.metadata.revision = Math.max(manifest.metadata.revision, vault.state.revision + 1); manifest.metadata.updatedAt = new Date().toISOString();
    const journal = { version: 1, envelope: encryptState(manifest, vault.key, vault.envelope.kdf), branding: labels };
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, journalFile(vault)); committed = true; await syncDirectory(vault.directory);
    return await completeRestore(vault, branding);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (!committed) for (const file of linked) await fs.unlink(file).catch(() => {});
  }
}
