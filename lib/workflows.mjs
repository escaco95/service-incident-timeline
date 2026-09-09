import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { recordChange } from './vault.mjs';
import { validateDefinition, TRIGGERS, plain, redact } from './workflow-definition.mjs';

export const TERMINAL = new Set(['success', 'failure', 'canceled', 'interrupted']);
const requestId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new AppError(400, '요청 식별자를 확인해 주세요.'); return value; };
const get = (state, id) => { const flow = state.workflows.find(flow => flow.id === id && !flow.deletedAt); if (!flow) throw new AppError(404, '워크플로우를 찾을 수 없습니다.'); return flow; };
const version = (flow, value) => { if (flow.version !== value) throw new AppError(409, '다른 화면에서 워크플로우가 변경되었습니다. 현재 편집 내용을 확인한 뒤 다시 불러와 주세요.'); };
const snapshot = flow => ({ workflowId: flow.id, name: flow.name, version: flow.version, definitionVersion: flow.definitionVersion, enabled: flow.enabled, nodes: flow.nodes.length });
export const definitionOf = flow => structuredClone({ name: flow.name, nodes: flow.nodes, edges: flow.edges });

function publicFlow(flow, runs, activity) {
  const own = activity ? [] : runs.filter(run => run.workflowId === flow.id).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = activity?.last ?? own[0], success = activity?.success ?? own.find(run => run.status === 'success');
  const { secrets, ...record } = flow;
  return { ...structuredClone(record), secretNames: Object.keys(secrets ?? {}), activity: { status: last?.status ?? 'never', lastRun: last?.createdAt ?? null, lastSuccess: success?.finishedAt ?? null, duration: last?.durationMs === undefined ? null : last.durationMs / 1000, runId: last?.id ?? null } };
}

export function enqueueRun(state, flow, input, key, kind, at, parent = null) {
  const existing = state.workflowRuns.find(run => run.requestKey === key);
  if (existing) return existing;
  const day = at.slice(0, 10), count = state.recordCounts?.runsByDay[day] ?? state.workflowRuns.filter(run => run.createdAt.slice(0, 10) === day).length;
  if (count >= 10000) throw new AppError(409, '하루 워크플로우 실행 기록 한도(10,000건)에 도달했습니다.');
  const definition = parent?.definition ?? validateDefinition(flow, { executable: true });
  const run = { id: randomUUID(), workflowId: flow.id, workflowName: definition.name, definitionVersion: parent?.definitionVersion ?? flow.definitionVersion, definition: structuredClone(definition), input: structuredClone(input), kind, requestKey: key, parentId: parent?.id ?? null, status: 'queued', createdAt: at, steps: [], cancelRequested: false };
  state.workflowRuns.push(run);
  if (state.recordCounts) state.recordCounts.runsByDay[day] = count + 1;
  return run;
}

export class Workflows {
  constructor(vault, { clock = () => new Date().toISOString() } = {}) { this.vault = vault; this.clock = clock; }
  list() { this.vault.assertUnlocked(); const activity = this.vault.daily?.activities(); return { workflows: this.vault.state.workflows.filter(flow => !flow.deletedAt).map(flow => publicFlow(flow, this.vault.state.workflowRuns, activity ? activity.get(flow.id) ?? {} : undefined)) }; }
  read(id) { this.vault.assertUnlocked(); return publicFlow(get(this.vault.state, id), this.vault.state.workflowRuns, this.vault.daily ? this.vault.daily.activities().get(id) ?? {} : undefined); }
  async create(input) {
    const key = requestId(input.requestId);
    const result = await this.vault.mutate(state => {
      const existing = state.workflows.find(flow => flow.createRequestId === key);
      if (existing) return existing.id;
      if (state.workflows.filter(flow => !flow.deletedAt).length >= 100) throw new AppError(409, '워크플로우는 최대 100개입니다.');
      const definition = validateDefinition({ name: input.name ?? '새 워크플로우', nodes: input.nodes ?? [], edges: input.edges ?? [] });
      const at = this.clock(), flow = { id: randomUUID(), ...definition, version: 1, definitionVersion: 1, enabled: false, createdAt: at, updatedAt: at, activatedAt: null, secrets: {}, createRequestId: key };
      state.workflows.push(flow); recordChange(state, 'workflow-created', null, snapshot(flow)); return flow.id;
    }, { scope: {} });
    return this.read(result.event);
  }
  async save(id, input) {
    await this.vault.mutate(state => {
      const flow = get(state, id); version(flow, input.version);
      const definition = validateDefinition(input, { executable: flow.enabled }), before = snapshot(flow);
      const secrets = { ...flow.secrets };
      if (input.secrets !== undefined) {
        if (!plain(input.secrets) || Object.keys(input.secrets).length > 50) throw new AppError(400, '비밀 변수는 JSON 객체로 최대 50개까지 입력해 주세요.');
        for (const [key, value] of Object.entries(input.secrets)) {
          if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || (value !== null && (typeof value !== 'string' || !value || value.length > 4000))) throw new AppError(400, '비밀 변수 이름과 값을 확인해 주세요.');
          if (value === null) delete secrets[key]; else secrets[key] = value;
        }
        if (Object.keys(secrets).length > 50) throw new AppError(400, '비밀 변수는 최대 50개입니다.');
      }
      Object.assign(flow, definition, { secrets, version: flow.version + 1, definitionVersion: flow.definitionVersion + 1, updatedAt: this.clock() });
      recordChange(state, 'workflow-updated', before, snapshot(flow));
    }, { scope: {} });
    return this.read(id);
  }
  async enable(id, input) {
    await this.vault.mutate(state => {
      const flow = get(state, id); version(flow, input.version);
      if (typeof input.enabled !== 'boolean') throw new AppError(400, '자동 실행 여부를 확인해 주세요.');
      if (input.enabled) validateDefinition(flow, { executable: true });
      const before = snapshot(flow), at = this.clock();
      if (input.enabled && !flow.enabled) flow.activatedAt = at;
      Object.assign(flow, { enabled: input.enabled, version: flow.version + 1, updatedAt: at });
      recordChange(state, 'workflow-enabled', before, snapshot(flow));
    }, { scope: {} });
    return this.read(id);
  }
  async remove(id, input) {
    await this.vault.mutate(state => {
      const flow = get(state, id); version(flow, input.version);
      const before = snapshot(flow);
      flow.deletedAt = this.clock(); flow.enabled = false; flow.secrets = {};
      for (const run of state.workflowRuns.filter(run => run.workflowId === id && !TERMINAL.has(run.status))) {
        run.cancelRequested = true;
        if (run.status === 'queued') { run.status = 'canceled'; run.finishedAt = this.clock(); run.durationMs = 0; }
      }
      recordChange(state, 'workflow-deleted', before, null);
    }, { scope: { activeRuns: true } });
    return { ok: true };
  }
  async run(id, input) {
    const key = `manual:${id}:${requestId(input.requestId)}`;
    const result = await this.vault.mutate(state => {
      const previous = state.workflowRuns.find(run => run.requestKey === key);
      if (previous) return previous.id;
      const flow = get(state, id); version(flow, input.version);
      const root = flow.nodes.find(node => TRIGGERS.includes(node.type));
      const event = input.eventId ? state.events.find(event => event.id === input.eventId) : null;
      if (root?.type !== 'cron' && !event) throw new AppError(400, '수동 실행에 사용할 이벤트를 선택해 주세요.');
      const at = this.clock(), context = { event: structuredClone(event), trigger: { type: root?.type, scheduledAt: at } };
      const run = enqueueRun(state, flow, context, key, 'manual', at);
      recordChange(state, 'workflow-run-requested', null, { workflowId: id, runId: run.id, version: flow.definitionVersion }); return run.id;
    }, { scope: { ids: { events: input.eventId ? [input.eventId] : [] }, requests: [key] } });
    return this.readRun(result.event);
  }
  async readRun(id) {
    const run = await this.vault.getRecord('workflowRuns', id), state = this.vault.state;
    const flow = state.workflows.find(flow => flow.id === run.workflowId);
    const { requestKey, ...record } = run;
    const result = redact(record, Object.values(flow?.secrets ?? {}));
    for (const node of result.definition.nodes) if (node.type === 'http') { node.config.url = '[가림]'; node.config.headers = '[가림]'; node.config.body = '[가림]'; }
    return { ...result, canRerun: !!flow && !flow.deletedAt && TERMINAL.has(run.status) };
  }
  async rerun(id, input) {
    const key = `rerun:${id}:${requestId(input.requestId)}`;
    const result = await this.vault.mutate(state => {
      const existing = state.workflowRuns.find(run => run.requestKey === key);
      if (existing) return existing.id;
      const parent = state.workflowRuns.find(run => run.id === id);
      if (!parent || !TERMINAL.has(parent.status)) throw new AppError(409, '종료된 실행만 다시 실행할 수 있습니다.');
      const flow = get(state, parent.workflowId), run = enqueueRun(state, flow, parent.input, key, 'rerun', this.clock(), parent);
      recordChange(state, 'workflow-rerun-requested', { runId: parent.id }, { workflowId: flow.id, runId: run.id, version: parent.definitionVersion }); return run.id;
    }, { scope: { ids: { workflowRuns: [id] }, requests: [key] } });
    return this.readRun(result.event);
  }
  async cancel(id) {
    await this.vault.mutate(state => {
      const run = state.workflowRuns.find(run => run.id === id);
      if (!run || TERMINAL.has(run.status)) throw new AppError(409, '대기하거나 실행 중인 작업만 중지할 수 있습니다.');
      run.cancelRequested = true;
      if (run.status === 'queued') { run.status = 'canceled'; run.finishedAt = this.clock(); run.durationMs = 0; }
      recordChange(state, 'workflow-run-canceled', null, { workflowId: run.workflowId, runId: run.id });
    }, { scope: { ids: { workflowRuns: [id] } } });
    return this.readRun(id);
  }
}
