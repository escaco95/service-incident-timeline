import { randomUUID } from 'node:crypto';
import { AppError, NO_CHANGE, recordChange } from './vault.mjs';
import { DEFAULT_LOG_POLICY, validateLogPolicy } from './log-policy.mjs';
import { cronSlot } from './workflow-definition.mjs';
import { TERMINAL } from './workflows.mjs';

const DAY = 86400000;
const expired = (at, cutoff) => typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) < cutoff;
const policyOf = state => state.logPolicy ?? DEFAULT_LOG_POLICY;
const FAILURE = '로그 로테이션·이벤트 만료 처리를 저장하지 못했습니다. 저장소를 확인해 주세요.';

function systemRecord(state, action, after, at) {
  recordChange(state, action, null, after, { actor: 'system', at });
}

// Drop whole UTC date partitions. Keep the boundary date until all its records
// are past retention; this can retain an individual record for one extra day.
export function pruneLogsAndEvents(state, policy, at, timezone, slot) {
  const today = Math.floor(Date.parse(at) / DAY) * DAY;
  const eventCutoff = today - policy.eventRetentionDays * DAY, auditCutoff = today - policy.auditRetentionDays * DAY;
  const eventIds = state.events.filter(event => expired(event.end, eventCutoff)).map(event => event.id);
  const removedEvents = new Set(eventIds);
  state.events = state.events.filter(event => !removedEvents.has(event.id));
  const counts = { changes: 0, workflowRuns: 0 };
  const prune = (rows, predicate, key) => rows.filter(row => { if (!predicate(row)) return true; counts[key]++; return false; });
  state.changes = prune(state.changes, row => expired(row.at, auditCutoff), 'changes');
  state.workflowRuns = prune(state.workflowRuns ?? [], run => TERMINAL.has(run.status) && expired(run.finishedAt, auditCutoff), 'workflowRuns');
  return recordCleanup(state, policy, at, timezone, slot, { eventIds, counts, eventCutoffDate: new Date(eventCutoff).toISOString().slice(0, 10), auditCutoffDate: new Date(auditCutoff).toISOString().slice(0, 10) });
}

function recordCleanup(state, policy, at, timezone, slot, { eventIds, counts, eventCutoffDate, auditCutoffDate }) {
  const runId = randomUUID(), eventCutoff = Date.parse(eventCutoffDate), auditCutoff = Date.parse(auditCutoffDate);
  const context = { runId, status: 'pending', cron: policy.cron, timezone, policyVersion: policy.version };
  systemRecord(state, 'audit-rotated', { ...context, retentionDays: policy.auditRetentionDays, cutoff: new Date(auditCutoff).toISOString(), count: Object.values(counts).reduce((sum, value) => sum + value, 0), counts }, at);
  systemRecord(state, 'events-expired', { ...context, retentionDays: policy.eventRetentionDays, cutoff: new Date(eventCutoff).toISOString(), count: eventIds.length, eventIds }, at);
  const pendingRun = { ...context, slot, at, eventCutoffDate: new Date(eventCutoff).toISOString().slice(0, 10), auditCutoffDate: new Date(auditCutoff).toISOString().slice(0, 10), expiredEvents: eventIds.length, rotatedAudit: counts };
  state.logMaintenance = { ...state.logMaintenance, lastSlot: slot, lastRun: pendingRun, pendingRun };
  return state.logMaintenance.lastRun;
}

export class LogMaintenance {
  constructor(vault, { clock = () => new Date().toISOString(), timezone = () => 'UTC', intervalMs = 15000, autoStart = true } = {}) {
    this.vault = vault; this.clock = clock; this.timezone = timezone; this.fault = null; this.pendingFailure = null; this.closing = false;
    if (autoStart) { this.timer = setInterval(() => { void this.tick(); }, intervalMs); this.timer.unref(); }
  }

  read() {
    this.vault.assertUnlocked();
    return structuredClone({ policy: policyOf(this.vault.state), timezone: this.timezone(), lastRun: this.vault.state.logMaintenance?.lastRun ?? null, fault: this.fault });
  }

  async save(input) {
    const fields = validateLogPolicy(input?.policy);
    if (!Number.isSafeInteger(input.policy.version) || input.policy.version < 1) throw new AppError(400, '로그 관리 정책 버전을 확인해 주세요.');
    await this.vault.mutate(state => {
      const before = policyOf(state);
      if (input.policy.version !== before.version) throw new AppError(409, '로그 관리 정책이 변경되었습니다. 최신 설정을 불러온 뒤 저장해 주세요.');
      state.logPolicy = { version: before.version + 1, ...fields };
      recordChange(state, 'log-policy-updated', structuredClone(before), structuredClone(state.logPolicy));
    }, { scope: {} });
    return this.read();
  }

  tick() {
    if (this.closing || this.paused || !this.vault.unlocked) return Promise.resolve();
    if (this.job) return this.job;
    this.job = this.runTick().catch(() => { this.fault = FAILURE; }).finally(() => { this.job = null; });
    return this.job;
  }

  async persistFailure() {
    if (!this.pendingFailure) return;
    const failure = this.pendingFailure;
    await this.vault.mutate(state => {
      if (state.logMaintenance?.lastFailureSlot === failure.slot) return NO_CHANGE;
      systemRecord(state, 'log-maintenance-failed', failure, failure.at);
      state.logMaintenance = { ...state.logMaintenance, lastFailureSlot: failure.slot, lastRun: failure };
    }, { scope: {} });
    this.pendingFailure = null;
  }

  async runTick() {
    if (this.vault.state.logMaintenance?.pendingRun) { await this.finishPending(); return; }
    try { await this.persistFailure(); } catch { this.fault = FAILURE; }
    const at = this.clock(), timezone = this.timezone();
    const initialMatch = cronSlot({ expression: policyOf(this.vault.state).cron, timezone }, at);
    if (!initialMatch || this.vault.state.logMaintenance?.lastSlot === `${timezone}:${initialMatch}`) return;
    let attempted, plan;
    try {
      await this.vault.mutate(state => {
        const policy = policyOf(state);
        const match = cronSlot({ expression: policy.cron, timezone }, at);
        const slot = `${timezone}:${match}`;
        if (!match || state.logMaintenance?.lastSlot === slot) return NO_CHANGE;
        attempted = { at, slot, timezone, policy: structuredClone(policy), status: 'failed', error: FAILURE };
        const result = plan ? recordCleanup(state, policy, at, timezone, slot, plan) : pruneLogsAndEvents(state, policy, at, timezone, slot);
        if (this.pendingFailure && state.logMaintenance.lastFailureSlot !== this.pendingFailure.slot) {
          systemRecord(state, 'log-maintenance-failed', this.pendingFailure, this.pendingFailure.at);
          state.logMaintenance.lastFailureSlot = this.pendingFailure.slot;
        }
        return result;
      }, { scope: async daily => {
        plan = daily ? await daily.expired(policyOf(this.vault.state), at) : null;
        return { auditDays: [at.slice(0, 10)] };
      }, removeKeys: () => plan?.keys ?? [] });
      if (attempted) { this.pendingFailure = null; await this.finishPending(); }
    } catch {
      this.fault = FAILURE;
      if (attempted) this.pendingFailure = attempted;
      try { await this.persistFailure(); }
      catch { this.fault = `${FAILURE} 실패 감사 기록도 아직 저장하지 못해 다음 점검 시 재시도합니다.`; }
    }
  }

  async finishPending() {
    const pending = this.vault.state.logMaintenance?.pendingRun;
    if (!pending) return;
    const result = await this.vault.serialize(() => this.vault.daily.cleanup());
    if (result.pendingFiles) {
      this.fault = `정리 대상 파일 ${result.pendingFiles}개를 삭제하지 못했습니다. 다음 점검 시 재시도합니다.`;
      this.pendingFailure = { at: this.clock(), slot: pending.slot, runId: pending.runId, status: 'failed', error: this.fault, pendingFiles: result.pendingFiles, timezone: pending.timezone, policy: policyOf(this.vault.state) };
      await this.persistFailure();
      return;
    }
    await this.vault.mutate(state => {
      const run = state.logMaintenance?.pendingRun;
      if (!run || run.runId !== pending.runId) return NO_CHANGE;
      const fileCounts = {};
      for (const ref of run.targetFiles ?? []) fileCounts[ref.kind] = (fileCounts[ref.kind] ?? 0) + 1;
      for (const row of state.changes) if (row.after?.runId === run.runId && ['audit-rotated', 'events-expired'].includes(row.action)) {
        row.after.status = 'success'; row.after.completedAt = this.clock(); row.after.files = (run.targetFiles ?? []).filter(ref => row.action === 'events-expired' ? ref.kind.startsWith('events') : ref.kind.startsWith('audit'));
      }
      const { targetFiles, ...summary } = run;
      state.logMaintenance.lastRun = { ...summary, status: 'success', completedAt: this.clock(), deletedFiles: fileCounts };
      delete state.logMaintenance.pendingRun;
    }, { scope: { auditDays: [pending.at.slice(0, 10)] } });
    this.fault = null; this.pendingFailure = null;
  }

  async pause() { this.paused = true; await this.job; }
  resume(clear = false) { if (clear) { this.pendingFailure = null; this.fault = null; } this.paused = false; }
  async close() { this.closing = true; clearInterval(this.timer); await this.job; }
}
