import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, recordChange } from './vault.mjs';
import { TERMINAL } from './workflows.mjs';
import { removeSetupMarker } from './setup-marker.mjs';

export const RESET_TARGETS = ['audit', 'events', 'workflows', 'system'];
const marker = vault => path.join(vault.directory, '.system-reset-pending');
const dailyKinds = ['events', 'events-open', 'audit', 'audit-active', 'lookup'];

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function hasPendingSystemReset(vault) {
  try { await fs.access(marker(vault)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function beginSystemReset(vault) {
  if (await hasPendingSystemReset(vault)) return;
  const handle = await fs.open(marker(vault), 'wx', 0o600);
  try { await handle.writeFile('authorized system reset\n'); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(vault.directory);
}

// Only application-owned files inside the configured data directory are removed.
// The durable marker lets startup finish an authorized reset after interruption.
export async function finishSystemReset(vault, branding) {
  await vault.queue;
  await branding.reset();
  await syncDirectory(path.dirname(branding.file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  for (const kind of dailyKinds) {
    const directory = path.resolve(vault.directory, kind);
    if (path.dirname(directory) !== vault.directory) throw new Error('Invalid reset path');
    const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid daily directory');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !(kind === 'lookup' ? /^[0-9a-f]{2}\.[0-9a-f-]{36}\.json$/ : /^(?:\d{4}-\d{2}-\d{2}|undated)\.[0-9a-f-]{36}\.json$/).test(entry.name)) continue;
      const file = path.resolve(directory, entry.name);
      if (path.dirname(file) !== directory) throw new Error('Invalid reset file');
      await fs.unlink(file);
    }
    await syncDirectory(directory);
  }
  for (const entry of await fs.readdir(vault.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:store\.json(?:\.bak)?|\.store-[0-9a-f-]{36}\.tmp(?:\.backup)?|\.setup-[0-9a-f-]{36}\.tmp)$/.test(entry.name)) continue;
    const file = path.resolve(vault.directory, entry.name);
    if (path.dirname(file) !== vault.directory) throw new Error('Invalid reset file');
    await fs.unlink(file);
  }
  await removeSetupMarker(vault.directory);
  // Persist deletions before removing the recovery journal. If its final unlink
  // is interrupted, startup can safely repeat cleanup of the already-empty store.
  await syncDirectory(vault.directory);
  await fs.unlink(marker(vault));
  vault.key?.fill(0); vault.key = null; vault.state = null; vault.envelope = null; vault.daily = null; vault.initialized = false;
}

export async function resetData({ vault, branding, engine, maintenance }, target, requestId) {
  const previous = vault.state.resetRequests?.find(item => item.id === requestId);
  if (previous) {
    if (previous.target !== target) throw new AppError(409, '다른 초기화에 사용한 요청 식별자입니다.');
    const cleanup = vault.daily ? await vault.serialize(() => vault.daily.cleanup()) : { pendingFiles: 0 };
    return { ok: true, target, cleanupPending: cleanup.pendingFiles };
  }
  await maintenance.pause();
  await engine.pause(target !== 'events');
  let systemStarted = false, complete = false;
  try {
    if (target === 'system') {
      systemStarted = true;
      await beginSystemReset(vault);
      await finishSystemReset(vault, branding); complete = true;
      return { ok: true, target, initialized: false, publicBranding: branding.branding };
    }
    await vault.mutate(state => {
      const at = new Date().toISOString();
      if (target === 'events') {
        const count = state.recordCounts?.events ?? state.events.length; state.events = [];
        recordChange(state, 'events-reset', null, { count });
      } else if (target === 'workflows') {
        const count = state.workflows.filter(flow => !flow.deletedAt).length;
        state.workflows = [];
        for (const run of state.workflowRuns.filter(run => !TERMINAL.has(run.status))) Object.assign(run, { status: 'canceled', cancelRequested: true, finishedAt: at, message: '워크플로우 초기화로 중지되었습니다.' });
        recordChange(state, 'workflows-reset', null, { count });
      } else {
        state.changes = []; state.workflowRuns = [];
        if (state.logMaintenance) state.logMaintenance = { lastSlot: state.logMaintenance.lastSlot };
      }
      state.resetRequests = [...(state.resetRequests ?? []), { id: requestId, target, at }].slice(-256);
    }, { discardBackup: true, scope: { activeRuns: target === 'workflows' }, removeKeys: () => (vault.daily?.refs() ?? []).filter(ref => target === 'events' ? ref.kind.startsWith('events') : target === 'audit' ? ref.kind.startsWith('audit') : false).map(ref => `${ref.kind}/${ref.day}`) });
    complete = true;
    return { ok: true, target, cleanupPending: vault.daily.garbage.length };
  } finally {
    // Once disk deletion starts, normal API access stays blocked until it finishes.
    if (!systemStarted || complete || !await hasPendingSystemReset(vault)) { engine.resume(target === 'system'); maintenance.resume(complete && ['audit', 'system'].includes(target)); }
  }
}
