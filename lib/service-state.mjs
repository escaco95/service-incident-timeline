import { severity } from '../public/date-utils.js';
import { recordChange } from './vault.mjs';

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
