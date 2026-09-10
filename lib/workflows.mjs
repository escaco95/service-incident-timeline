import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { recordChange } from './vault.mjs';
import { isChange } from '../public/workflow-spec.js';
import { activeScope, effectiveServices, reconcileServices } from './service-state.mjs';
import { secretNames, validateReferences } from './workflow-file.mjs';
import { validateDefinition, TRIGGERS, plain, redact } from './workflow-definition.mjs';
import { validateDryRunSetup, dryRunWorkflow } from './workflow-dry-run.mjs';
import { serviceEventInstant, serviceEventDryRun } from './workflow-dry-run-service.mjs';

export const TERMINAL = new Set(['success', 'failure', 'canceled', 'interrupted', 'review', 'skipped']);
const requestId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new AppError(400, '요청 식별자를 확인해 주세요.'); return value; };
const get = (state, id) => { const flow = state.workflows.find(flow => flow.id === id && !flow.deletedAt); if (!flow) throw new AppError(404, '워크플로우를 찾을 수 없습니다.'); return flow; };
const version = (flow, value) => { if (flow.version !== value) throw new AppError(409, '다른 화면에서 워크플로우가 변경되었습니다. 현재 편집 내용을 확인한 뒤 다시 불러와 주세요.'); };
const snapshot = flow => ({ workflowId: flow.id, name: flow.name, version: flow.version, definitionVersion: flow.definitionVersion, enabled: flow.enabled, nodes: flow.nodes.length });
export const definitionOf = flow => structuredClone({ name: flow.name, nodes: flow.nodes, edges: flow.edges });

function publicFlow(flow, runs, activity) {
  const own = activity ? [] : runs.filter(run => run.workflowId === flow.id).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = activity?.last ?? own[0], success = activity?.success ?? own.find(run => run.status === 'success');
  const { secrets, dryRunSetup, ...record } = flow;
  return { ...structuredClone(record), secretNames: Object.keys(secrets ?? {}), activity: { status: last?.status ?? 'never', lastRun: last?.createdAt ?? null, lastSuccess: success?.finishedAt ?? null, duration: last?.durationMs === undefined ? null : last.durationMs / 1000, runId: last?.id ?? null } };
}

export function enqueueRun(state, flow, input, key, kind, at, parent = null) {
  const existing = state.workflowRuns.find(run => run.requestKey === key);
  if (existing) return existing;
  const day = at.slice(0, 10), count = state.recordCounts?.runsByDay[day] ?? state.workflowRuns.filter(run => run.createdAt.slice(0, 10) === day).length;
  if (count >= 10000) throw new AppError(409, '하루 워크플로우 실행 기록 한도(10,000건)에 도달했습니다.');
  const definition = parent?.definition ?? validateDefinition(flow, { executable: true });
  const root = definition.nodes.find(node => TRIGGERS.includes(node.type));
  if (root?.config.executionService) { const service = root.config.executionService, stored = state.serviceState?.services.find(item => item.service === service); input = { ...input, trigger: { ...input.trigger, service, severity: stored?.severity ?? '', generation: stored?.generation ?? 0 } }; }
  const run = { id: randomUUID(), workflowId: flow.id, workflowName: definition.name, definitionVersion: parent?.definitionVersion ?? flow.definitionVersion, definition: structuredClone(definition), input: structuredClone(input), kind, requestKey: key, parentId: parent?.id ?? null, status: 'queued', createdAt: at, steps: [], cancelRequested: false };
  state.workflowRuns.push(run);
  if (state.recordCounts) state.recordCounts.runsByDay[day] = count + 1;
  return run;
}

export class Workflows {
  constructor(vault, { clock = () => new Date().toISOString() } = {}) { this.vault = vault; this.clock = clock; }
  list() { this.vault.assertUnlocked(); const activity = this.vault.daily?.activities(); return { workflows: this.vault.state.workflows.filter(flow => !flow.deletedAt).map(flow => publicFlow(flow, this.vault.state.workflowRuns, activity ? activity.get(flow.id) ?? {} : undefined)) }; }
  read(id) { this.vault.assertUnlocked(); return publicFlow(get(this.vault.state, id), this.vault.state.workflowRuns, this.vault.daily ? this.vault.daily.activities().get(id) ?? {} : undefined); }
  readDryRunSetup(id) {
    this.vault.assertUnlocked();
    return structuredClone(get(this.vault.state, id).dryRunSetup ?? { version: 0, setup: { now: '', nodes: {} } });
  }
  async saveDryRunSetup(id, input) {
    const setup = validateDryRunSetup(input.setup);
    const result = await this.vault.mutate(state => {
      const flow = get(state, id), currentVersion = flow.dryRunSetup?.version ?? 0;
      if (input.version !== currentVersion) throw new AppError(409, '다른 화면에서 Dry-Run 입력값을 변경했습니다. 서버 설정을 다시 불러와 주세요.');
      flow.dryRunSetup = { version: currentVersion + 1, setup };
      // Test fixtures are independent of definition versions and audit history.
      return structuredClone(flow.dryRunSetup);
    }, { scope: {} });
    return result.event;
  }
  dryRun(id, input) {
    this.vault.assertUnlocked();
    const flow = get(this.vault.state, id);
    return dryRunWorkflow(input.definition, input.setup, flow.secrets);
  }
  async dryRunServiceEvent(id, input) {
    this.vault.assertUnlocked(); get(this.vault.state, id);
    if (typeof input.eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.eventId)) throw new AppError(400, '등록된 일정을 선택해 주세요.');
    const selected = await this.vault.getRecord('events', input.eventId), at = serviceEventInstant(selected, input.occurrence);
    const state = await this.vault.snapshot({ ids: { events: [selected.id] }, eventRange: { from: new Date(Date.parse(at) - 1).toISOString(), until: new Date(Date.parse(at) + 1).toISOString() } });
    get(state, id);
    const event = state.events.find(item => item.id === selected.id);
    if (!event || event.version !== selected.version) throw new AppError(409, '계산 중 일정이 변경되었습니다. 다시 적용해 주세요.');
    return serviceEventDryRun(state, event, input.occurrence, input.service);
  }
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
        if (!plain(input.secrets) || Object.keys(input.secrets).length > 50) throw new AppError(400, '기존 비밀 변수의 삭제 목록을 확인해 주세요.');
        for (const [key, value] of Object.entries(input.secrets)) {
          if (value !== null) throw new AppError(400, '비밀 변수는 추가·수정할 수 없습니다. 컨텍스트 값 주입 노드를 사용해 주세요.');
          if (!Object.hasOwn(secrets, key)) throw new AppError(400, '삭제할 비밀 변수를 찾을 수 없습니다.');
          delete secrets[key];
        }
      }
      if (flow.enabled) { validateReferences(definition); if (secretNames(definition).some(name => !secrets[name])) throw new AppError(400, '참조하는 기존 비밀 변수가 없습니다. 컨텍스트 값 주입 노드로 바꾸거나 참조를 제거해 주세요.'); }
      Object.assign(flow, definition, { secrets, version: flow.version + 1, definitionVersion: flow.definitionVersion + 1, updatedAt: this.clock() });
      recordChange(state, 'workflow-updated', before, snapshot(flow));
    }, { scope: {} });
    return this.read(id);
  }
  async enable(id, input) {
    await this.vault.mutate(state => {
      const flow = get(state, id); version(flow, input.version);
      if (typeof input.enabled !== 'boolean') throw new AppError(400, '자동 실행 여부를 확인해 주세요.');
      if (input.enabled) { validateDefinition(flow, { executable: true }); validateReferences(flow); if (secretNames(flow).some(name => !flow.secrets[name])) throw new AppError(400, '참조하는 기존 비밀 변수가 없습니다. 컨텍스트 값 주입 노드로 바꾸거나 참조를 제거해 주세요.'); }
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
      delete flow.dryRunSetup;
      for (const run of state.workflowRuns.filter(run => run.workflowId === id && !TERMINAL.has(run.status))) {
        run.cancelRequested = true;
        if (run.status === 'queued') { run.status = 'canceled'; run.finishedAt = this.clock(); run.durationMs = 0; }
      }
      recordChange(state, 'workflow-deleted', before, null);
    }, { scope: { activeRuns: true } });
    return { ok: true };
  }
  async run(id, input, { parentId = null } = {}) {
    const key = `manual:${id}:${requestId(input.requestId)}`;
    const result = await this.vault.mutate(state => {
      const previous = state.workflowRuns.find(run => run.requestKey === key);
      if (previous) return previous.id;
      const flow = get(state, id); version(flow, input.version);
      const root = flow.nodes.find(node => TRIGGERS.includes(node.type));
      const event = input.eventId ? state.events.find(event => event.id === input.eventId) : null;
      if (!['cron', 'service-state'].includes(root?.type) && !event) throw new AppError(400, '수동 실행에 사용할 이벤트를 선택해 주세요.');
      const at = this.clock(), context = { event: structuredClone(event), trigger: { type: root?.type, scheduledAt: at } };
      validateReferences(validateDefinition(flow, { executable: true }));
      if (secretNames(flow).some(name => !flow.secrets[name])) throw new AppError(400, '참조하는 기존 비밀 변수가 없습니다. 컨텍스트 값 주입 노드로 바꾸거나 참조를 제거해 주세요.');
      if (root?.type === 'service-state') {
        const service = input.service ?? root.config.service;
        if (typeof service !== 'string' || !service || service.length > 100 || root.config.service && root.config.service !== service) throw new AppError(400, '평가할 서비스 문자열을 확인해 주세요.');
        reconcileServices(state, at, enqueueRun);
        const stored = state.serviceState.services.find(item => item.service === service);
        if (stored?.hold && flow.nodes.some(isChange)) throw new AppError(409, '이전 변경 결과를 확인하고 보류를 해소해 주세요.');
        context.trigger = { type: 'service-state', service, previous: stored?.severity ?? '', severity: stored?.severity ?? '', scheduledAt: at, events: stored?.events ?? [], generation: stored?.generation ?? 0 };
      }
      const run = enqueueRun(state, flow, context, key, 'manual', at);
      run.parentId = parentId;
      recordChange(state, parentId ? 'workflow-reevaluated' : 'workflow-run-requested', null, { workflowId: id, runId: run.id, version: flow.definitionVersion }); return run.id;
    }, { scope: { ids: { events: input.eventId ? [input.eventId] : [] }, activeRuns: true, ...activeScope(this.clock()), requests: [key] } });
    return this.readRun(result.event);
  }
  async readRun(id) {
    const run = await this.vault.getRecord('workflowRuns', id), state = this.vault.state;
    const flow = state.workflows.find(flow => flow.id === run.workflowId);
    const { requestKey, ...record } = run;
    const result = redact(record, Object.values(flow?.secrets ?? {}));
    for (const node of result.definition.nodes) if (node.type === 'http') { node.config.url = '[가림]'; node.config.headers = '[가림]'; node.config.body = '[가림]'; }
    for (const node of result.definition.nodes) if (node.type === 'context') node.config.entries = node.config.entries.map(entry => ({ key: entry.key, value: '[가림]' }));
    return { ...result, canRerun: !!flow && !flow.deletedAt && TERMINAL.has(run.status) && !run.input.trigger.service, canReevaluate: !!flow && !flow.deletedAt && run.input.trigger.type === 'service-state' };
  }
  async rerun(id, input) {
    const key = `rerun:${id}:${requestId(input.requestId)}`;
    const result = await this.vault.mutate(state => {
      const existing = state.workflowRuns.find(run => run.requestKey === key);
      if (existing) return existing.id;
      const parent = state.workflowRuns.find(run => run.id === id);
      if (!parent || !TERMINAL.has(parent.status)) throw new AppError(409, '종료된 실행만 다시 실행할 수 있습니다.');
      if (parent.input.trigger.service) throw new AppError(409, '서비스 실행은 이전 입력을 반복할 수 없습니다. 현재 상태 재평가를 사용해 주세요.');
      const flow = get(state, parent.workflowId), run = enqueueRun(state, flow, parent.input, key, 'rerun', this.clock(), parent);
      recordChange(state, 'workflow-rerun-requested', { runId: parent.id }, { workflowId: flow.id, runId: run.id, version: parent.definitionVersion }); return run.id;
    }, { scope: { ids: { workflowRuns: [id] }, requests: [key] } });
    return this.readRun(result.event);
  }
  serviceStates() { this.vault.assertUnlocked(); return structuredClone(this.vault.state.serviceState?.services ?? []); }
  async resolveService(input) {
    requestId(input.requestId);
    if (typeof input.service !== 'string' || typeof input.runId !== 'string' || input.confirmed !== true || input.previousRequestFinished !== true) throw new AppError(400, '이전 요청의 종료·적용 결과를 확인한 뒤 보류를 해소해 주세요.');
    await this.vault.mutate(state => {
      const item = state.serviceState?.services.find(item => item.service === input.service);
      if (!item?.hold) { if (item?.resolution?.requestId === input.requestId) return; throw new AppError(409, '해소할 서비스 보류가 없습니다.'); }
      if (item.hold.runId !== input.runId) throw new AppError(409, '보류 대상 실행이 바뀌었습니다. 다시 확인해 주세요.');
      if (state.workflowRuns.some(run => run.input.trigger?.service === input.service && run.status === 'running')) throw new AppError(409, '서비스 실행이 아직 진행 중입니다. 완료된 뒤 해소해 주세요.');
      const at = this.clock();
      recordChange(state, 'service-hold-resolved', { service: item.service, runId: item.hold.runId }, { service: item.service, requestId: input.requestId }, { at });
      item.resolution = { requestId: input.requestId, runId: item.hold.runId, at }; item.hold = null;
      // Do not release old queued changes. The operator explicitly reevaluates
      // the current service after resolving the earlier external request.
      for (const run of state.workflowRuns.filter(run => run.status === 'queued' && run.input.trigger.service === input.service)) Object.assign(run, { status: 'skipped', finishedAt: at, durationMs: 0, message: '보류 해소 후 현재 상태를 새로 평가해 주세요.' });
    }, { scope: { activeRuns: true } });
    return { ok: true };
  }
  async reevaluate(id, input) {
    const parent = await this.vault.getRecord('workflowRuns', id), flow = this.read(parent.workflowId);
    if (parent.input.trigger.type !== 'service-state' || !TERMINAL.has(parent.status)) throw new AppError(409, '종료된 서비스 실행을 선택해 주세요.');
    return this.run(flow.id, { ...input, version: flow.version, service: parent.input.trigger.service }, { parentId: parent.id });
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
