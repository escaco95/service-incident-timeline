import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Retry only an uncommitted rename. Never remove the destination or repeat an
// external request; the original/backup remains available if the deadline expires.
export async function replaceFile(from, to, { move = rename, platform = process.platform, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await move(from, to); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      await wait(Math.min(20 * 2 ** attempt, 250));
    }
  }
}
