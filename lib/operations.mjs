import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

export const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const validInstant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = message => { throw new AppError(400, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' ? value.trim() : '';
const own = (object, key) => Object.hasOwn(object, key);
const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;

export function emptyOperations() {
  return { version: 1, services: [], policy: { version: 1, baseline: null, tieBreak: 'state-order', states: [] } };
}

export function recordOnlyExecution() {
  return { enabled: false, impact: null, endMode: 'scheduled', confirmedEnd: null, authorization: null };
}

export function validatePolicy(input, version) {
  if (!plain(input) || !Array.isArray(input.states) || input.states.length > 32 || !['state-order', 'latest-start'].includes(input.tieBreak)) fail('상태 정책 형식을 확인해 주세요.');
  const seen = new Set();
  const states = input.states.map(state => {
    if (!plain(state) || !identifier(state.id) || seen.has(state.id) || !Number.isSafeInteger(state.priority) || Math.abs(state.priority) > 100000) fail('상태 ID는 고유해야 하며 우선순위는 -100000~100000의 정수여야 합니다.');
    seen.add(state.id);
    const name = label(state.name) || state.id;
    if (name.length > 80) fail('상태 이름은 80자까지 입력할 수 있습니다.');
    return { id: state.id, name, priority: state.priority };
  });
  if (states.length ? !seen.has(input.baseline) : input.baseline !== null) fail('기준 상태를 정책에 등록한 상태 중에서 선택해 주세요.');
  return { version, baseline: input.baseline, tieBreak: input.tieBreak, states };
}

export function validateServices(input, previous = []) {
  if (!Array.isArray(input) || input.length > 200) fail('서비스 제안 목록은 최대 200개입니다.');
  const seen = new Set();
  const services = input.map((entry, order) => {
    if (!plain(entry) || !identifier(entry.id) || seen.has(entry.id)) fail('서비스 ID는 영문 소문자로 시작하는 고유한 1~64자 값이어야 합니다.');
    seen.add(entry.id);
    const name = label(entry.name);
    if (!name || name.length > 80 || typeof entry.active !== 'boolean') fail('서비스 이름(1~80자)과 활성 여부를 확인해 주세요.');
    const connectorId = entry.connectorId ?? null;
    if (connectorId !== null && !identifier(connectorId)) fail('커넥터 ID 형식을 확인해 주세요.');
    const old = previous.find(item => item.id === entry.id);
    const mappingVersion = old ? old.mappingVersion + Number(old.connectorId !== connectorId || old.active !== entry.active) : 1;
    return { id: entry.id, name, active: entry.active, order, connectorId, mappingVersion };
  });
  if (previous.some(entry => !seen.has(entry.id))) fail('기존 서비스 ID는 삭제하거나 변경할 수 없습니다. 사용하지 않는 서비스는 비활성화해 주세요.');
  return services;
}

export function normalizeSelections(input, catalog, original = []) {
  if (!Array.isArray(input) || input.length > 50) fail('한 이벤트에 최대 50개의 서비스를 선택할 수 있습니다.');
  const seen = new Set();
  const selections = [];
  for (const entry of input) {
    if (!plain(entry) || !['catalog', 'custom'].includes(entry.kind)) fail('서비스 선택 형식을 확인해 주세요.');
    if (entry.kind === 'catalog') {
      const service = catalog.find(item => item.id === entry.id);
      const old = original.find(item => item.kind === 'catalog' && item.id === entry.id);
      if (!service || (!service.active && !old)) fail('새로 선택할 수 없는 서비스입니다. 제안 목록을 확인해 주세요.');
      const key = `catalog:${entry.id}`;
      if (seen.has(key)) fail('같은 서비스 ID를 중복 선택할 수 없습니다.');
      seen.add(key);
      selections.push({ kind: 'catalog', id: entry.id, label: old?.label ?? service.name });
    } else {
      const name = label(entry.label);
      if (!name) continue;
      if (name.length > 80) fail('직접 입력한 서비스명은 80자까지 입력할 수 있습니다.');
      const targetId = entry.targetId ?? null;
      if (targetId !== null && !catalog.some(item => item.id === targetId)) fail('직접 입력 항목의 연결 대상을 확인해 주세요.');
      const key = `custom:${name}`;
      if (seen.has(key)) {
        if (selections.find(item => item.kind === 'custom' && item.label === name).targetId !== targetId) fail('같은 직접 입력 항목의 연결 대상이 서로 다릅니다.');
        continue;
      }
      seen.add(key);
      selections.push({ kind: 'custom', label: name, targetId });
    }
  }
  const targets = selections.map(selectionTarget).filter(Boolean);
  if (new Set(targets).size !== targets.length) fail('같은 실행 대상에 여러 항목을 연결할 수 없습니다.');
  return selections;
}

export const selectionTarget = entry => entry.kind === 'catalog' ? entry.id : entry.targetId;
export const serviceText = event => event.services.map(entry => entry.label).join(', ');
export const effectiveEnd = event => event.execution.endMode === 'confirmed' ? event.execution.confirmedEnd : event.end;

export function authorizationFingerprint(event, operations) {
  const targets = event.services.map(selectionTarget).map(id => {
    const service = operations.services.find(item => item.id === id);
    return { id, connectorId: service?.connectorId ?? null, mappingVersion: service?.mappingVersion ?? null };
  }).sort((a, b) => compare(String(a.id), String(b.id)));
  return createHash('sha256').update(JSON.stringify({ targets, start: event.start, end: event.end, impact: event.execution.impact, endMode: event.execution.endMode, confirmedEnd: event.execution.confirmedEnd, policyVersion: operations.policy.version })).digest('hex');
}

export function eligibility(event, operations, { checkAuthorization = true } = {}) {
  const reasons = [];
  if (!event.execution.enabled) reasons.push('execution-disabled');
  if (!operations.policy.states.length) reasons.push('policy-unconfigured');
  if (!operations.policy.states.some(state => state.id === event.execution.impact)) reasons.push('unknown-impact');
  if (!event.services.length) reasons.push('no-targets');
  for (const selection of event.services) {
    const id = selectionTarget(selection);
    if (!id) { reasons.push('unmapped-service'); continue; }
    const service = operations.services.find(item => item.id === id);
    if (!service?.active) reasons.push('inactive-target');
    if (!service?.connectorId) reasons.push('unconnected-target');
  }
  if (checkAuthorization && event.execution.authorization !== authorizationFingerprint(event, operations)) reasons.push('authorization-required');
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function normalizeExecution(input, original = recordOnlyExecution()) {
  if (input === undefined) return structuredClone(original);
  if (!plain(input) || typeof input.enabled !== 'boolean' || !['scheduled', 'confirmed'].includes(input.endMode)) fail('실행 여부와 종료 방식을 확인해 주세요.');
  if (input.impact !== null && !identifier(input.impact)) fail('상태 영향을 선택해 주세요.');
  const confirmedEnd = input.confirmedEnd ?? null;
  if (confirmedEnd !== null && !validInstant(confirmedEnd)) fail('확인된 종료 시각이 올바르지 않습니다.');
  if (input.endMode === 'scheduled' && confirmedEnd !== null) fail('시각 종료 방식에서는 확인된 종료 시각을 지정할 수 없습니다.');
  return { enabled: input.enabled, impact: input.impact, endMode: input.endMode, confirmedEnd, authorization: original.authorization };
}

export function prepareEvent(fields, input, operations, original) {
  if (!own(input, 'services') && original && fields.service !== original.service && (original.services.length > 1 || original.services.some(entry => entry.kind === 'catalog' || entry.targetId))) throw new AppError(409, '서비스 선택 형식이 변경되었습니다. 화면을 새로고침한 뒤 편집해 주세요.');
  const services = own(input, 'services') ? normalizeSelections(input.services, operations.services, original?.services) : original && fields.service === original.service ? original.services : (fields.service ? [{ kind: 'custom', label: fields.service, targetId: null }] : []);
  const execution = normalizeExecution(input.execution, original?.execution);
  const event = { ...fields, services, execution };
  event.service = serviceText(event); // Compatibility display only; never used for target matching.
  if (execution.confirmedEnd !== null && Date.parse(execution.confirmedEnd) <= Date.parse(event.start)) fail('확인된 종료 시각은 시작 시각보다 늦어야 합니다.');
  if (execution.enabled) {
    const status = eligibility(event, operations, { checkAuthorization: false });
    if (!status.eligible) throw new AppError(400, `상태 계산에 포함할 수 없습니다: ${status.reasons.join(', ')}`);
    if (input.execution?.confirmAuthorization === true) {
      if (input.execution.confirmSettingsVersion !== operations.version) throw new AppError(409, '확인한 업무 설정이 변경되었습니다. 편집 창을 다시 열고 적용 범위를 확인해 주세요.');
      execution.authorization = authorizationFingerprint(event, operations);
    }
    if (execution.authorization !== authorizationFingerprint(event, operations)) throw new AppError(409, '대상·일정·영향·정책 또는 연결이 바뀌었습니다. 적용 범위를 확인한 뒤 다시 승인해 주세요.');
  } else execution.authorization = null;
  return event;
}

export function migrateState(state) {
  if (state.schemaVersion === 1) {
    return { ...state, schemaVersion: 2, operations: emptyOperations(), changes: [], events: state.events.map(event => ({ ...event, services: event.service ? [{ kind: 'custom', label: event.service, targetId: null }] : [], execution: recordOnlyExecution() })) };
  }
  return state;
}

export function validateOperationsState(state) {
  const operations = state.operations;
  if (!plain(operations) || !Number.isSafeInteger(operations.version) || operations.version < 1 || !Number.isSafeInteger(operations.policy?.version) || operations.policy.version < 1) fail('업무 설정 버전이 올바르지 않습니다.');
  validatePolicy(operations.policy, operations.policy.version);
  validateServices(operations.services);
  for (const service of operations.services) if (!Number.isSafeInteger(service.mappingVersion) || service.mappingVersion < 1) fail('연결 버전이 올바르지 않습니다.');
  for (const event of state.events) {
    for (const selection of event.services ?? []) if (typeof selection.label !== 'string' || !selection.label.trim() || selection.label.length > 80) fail('저장된 서비스 표시명이 올바르지 않습니다.');
    normalizeSelections(event.services, operations.services, event.services);
    normalizeExecution(event.execution);
    if (event.execution.authorization !== null && !/^[a-f0-9]{64}$/.test(event.execution.authorization)) fail('실행 허용 범위가 올바르지 않습니다.');
  }
}

/** Pure calculation: no connector access, timers, writes or UI filters. */
export function evaluateStates(events, operations, at) {
  if (!validInstant(at)) fail('평가 시각은 UTC ISO 형식이어야 합니다.');
  const time = Date.parse(at);
  const ranked = new Map(operations.policy.states.map((state, order) => [state.id, { ...state, order }]));
  const byTarget = new Map(operations.services.map(service => [service.id, []]));
  const excluded = [];
  for (const event of events) {
    const status = eligibility(event, operations);
    if (!status.eligible) { excluded.push({ eventId: event.id, version: event.version, reasons: status.reasons }); continue; }
    const end = effectiveEnd(event);
    if (Date.parse(event.start) > time || (end !== null && time >= Date.parse(end))) continue;
    for (const targetId of event.services.map(selectionTarget)) byTarget.get(targetId)?.push(event);
  }
  const states = operations.services.map(service => {
    const active = byTarget.get(service.id);
    active.sort((a, b) => {
      const x = ranked.get(a.execution.impact), y = ranked.get(b.execution.impact);
      return y.priority - x.priority || (operations.policy.tieBreak === 'latest-start' ? compare(b.start, a.start) : 0) || x.order - y.order || compare(a.id, b.id);
    });
    return { targetId: service.id, name: service.name, active: service.active, connectorId: service.connectorId, mappingVersion: service.mappingVersion, state: active[0]?.execution.impact ?? operations.policy.baseline, basis: active.length ? 'events' : 'baseline', evidence: active.map(event => ({ eventId: event.id, version: event.version, impact: event.execution.impact, decisive: event.execution.impact === active[0].execution.impact })), externalState: null };
  });
  return { evaluatedAt: at, policyVersion: operations.policy.version, settingsVersion: operations.version, states, excluded, externalCalls: false };
}

export function previewPlan(events, operations, from, until) {
  const initial = evaluateStates(events, operations, from);
  if (!validInstant(until) || Date.parse(until) <= Date.parse(from) || Date.parse(until) - Date.parse(from) > 366 * 86400000) fail('조회 종료는 시작 이후 366일 이내의 UTC 시각이어야 합니다.');
  const times = new Set();
  for (const event of events) {
    if (!eligibility(event, operations).eligible) continue;
    for (const time of [event.start, effectiveEnd(event)]) if (time && time > from && time <= until) times.add(time);
  }
  if (times.size > 500) fail('평가 경계가 500개를 넘습니다. 조회 기간을 줄여 주세요.');
  if (events.length * times.size > 2000000) fail('평가할 이벤트가 너무 많습니다. 조회 기간을 줄여 주세요.');
  let previous = initial;
  const transitions = [];
  for (const time of [...times].sort()) {
    const next = evaluateStates(events, operations, time);
    for (let index = 0; index < next.states.length; index++) {
      const current = next.states[index], before = previous.states[index];
      if (current.state !== before.state || JSON.stringify(current.evidence) !== JSON.stringify(before.evidence)) transitions.push({ evaluatedAt: time, targetId: current.targetId, previousState: before.state, targetState: current.state, evidence: current.evidence, applyRequired: current.state !== before.state });
      if (transitions.length > 5000) fail('예상 변경이 5000건을 넘습니다. 조회 기간을 줄여 주세요.');
    }
    previous = next;
  }
  return { ...initial, until, transitions };
}
