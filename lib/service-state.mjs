import { severity } from '../public/date-utils.js';
import { recordChange } from './vault.mjs';
import { AppError } from './errors.mjs';

export function validateServiceState(state) {
  if (state === undefined) return;
  const fail = () => { throw new AppError(400, '서비스 계산 상태·보류 형식을 확인해 주세요.'); };
  const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if (!state || state.version !== 1 || !Array.isArray(state.services)) fail();
  const seen = new Set();
  for (const item of state.services) {
    if (!item || typeof item.service !== 'string' || !item.service || item.service.length > 100 || seen.has(item.service) || !['', 'warning', 'incident'].includes(item.severity) || !Number.isSafeInteger(item.generation) || item.generation < 0 || !Array.isArray(item.events) || item.events.some(event => !event || !uuid(event.id) || !Number.isSafeInteger(event.version) || event.version < 1) || item.changedAt !== undefined && !instant(item.changedAt)) fail();
    if (item.hold !== null && item.hold !== undefined && (!item.hold || !uuid(item.hold.runId) || !instant(item.hold.at))) fail();
    if (item.resolution && (!uuid(item.resolution.runId) || !instant(item.resolution.at) || typeof item.resolution.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.resolution.requestId))) fail();
    seen.add(item.service);
  }
}

export const activeScope = at => ({ eventRange: { from: at, until: new Date(Date.parse(at) + 1).toISOString() } });
export function effectiveServices(events, at) {
  const grouped = new Map();
  for (const event of events) {
    if (event.start > at || event.end !== null && event.end <= at) continue;
    for (const label of new Set((event.services ?? []).map(item => item.label).filter(Boolean))) {
      const group = grouped.get(label) ?? []; group.push(event); grouped.set(label, group);
    }
  }
  return new Map([...grouped].map(([service, events]) => [service, { service, severity: severity(events), events: events.map(event => ({ id: event.id, version: event.version })).sort((a, b) => a.id.localeCompare(b.id)) }]));
}
export function reconcileServices(state, at, enqueue) {
  const initial = !state.serviceState;
  const stored = state.serviceState ??= { version: 1, services: [] };
  const current = effectiveServices(state.events, at);
  const services = new Set([...stored.services.map(item => item.service), ...current.keys()]);
  let changed = initial;
  for (const service of services) {
    let previous = stored.services.find(item => item.service === service);
    const next = current.get(service) ?? { service, severity: '', events: [] };
    if (previous && previous.severity === next.severity && JSON.stringify(previous.events) === JSON.stringify(next.events)) continue;
    const before = previous ? structuredClone(previous) : { service, severity: '', events: [], generation: 0 };
    if (!previous) { previous = { ...before, hold: null }; stored.services.push(previous); }
    Object.assign(previous, next);
    if (before.severity !== next.severity) { previous.generation = before.generation + 1; previous.changedAt = at; }
    recordChange(state, initial ? 'service-state-initialized' : before.severity === next.severity ? 'service-state-evidence' : 'service-state-changed', { service, severity: before.severity }, { service, severity: next.severity, eventIds: next.events.map(event => event.id) }, { actor: 'scheduler', at });
    if (!initial && before.severity !== next.severity) {
      for (const flow of state.workflows.filter(flow => flow.enabled && !flow.deletedAt)) {
        const root = flow.nodes.find(node => node.type === 'service-state');
        if (!root || root.config.service && root.config.service !== service) continue;
        enqueue(state, flow, { event: null, trigger: { type: 'service-state', service, previous: before.severity, severity: next.severity, scheduledAt: at, events: next.events, generation: previous.generation } }, `service:${flow.id}:${service}:${previous.generation}`, 'automatic', at);
      }
    }
    changed = true;
  }
  return changed;
}
export function holdService(state, run, at) {
  const service = run.input.trigger.service;
  if (!service) return;
  const stored = state.serviceState ??= { version: 1, services: [] };
  let item = stored.services.find(item => item.service === service);
  if (!item) { item = { service, severity: '', events: [], generation: 0 }; stored.services.push(item); }
  if (!item.hold) item.hold = { runId: run.id, at };
}
