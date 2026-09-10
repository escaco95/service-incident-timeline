import { TRIGGERS } from './workflow-spec.js';

export const DRY_RUN_LIMITS = Object.freeze({ bytes: 524288, json: 131072, headers: 16000 });
const json = value => JSON.stringify(value, null, 2);

export function eventDryRunValues(node, event) {
  if (!['start', 'end'].includes(node.type)) throw new Error('일정 초기값은 이벤트 시작·종료 노드에서 사용할 수 있습니다.');
  const now = event[node.type];
  if (!now || !Number.isFinite(Date.parse(now))) throw new Error(node.type === 'end' ? '종료 시각이 지정된 일정을 선택해 주세요.' : '시작 시각이 지정된 일정을 선택해 주세요.');
  const values = { type: node.type, event: json(event), trigger: json({ scheduledAt: now }) };
  if (values.event.length > DRY_RUN_LIMITS.json) throw new Error('일정 초기값이 너무 큽니다. 필요한 값을 직접 입력해 주세요.');
  return { now, values };
}

export function dryRunDefaults(node, now) {
  if (TRIGGERS.includes(node.type)) return {
    type: node.type,
    trigger: json({ scheduledAt: now, ...(node.type === 'cron' ? { timezone: node.config.timezone } : {}), ...(node.type === 'service-state' ? { service: node.config.service || 'test-service', previous: '', severity: 'warning', events: [], generation: 1 } : {}) }),
    ...(['start', 'end'].includes(node.type) ? { event: json({ id: 'dry-run-event', title: 'Dry-Run 테스트 이벤트', description: '', category: 'maintenance', services: [], start: now, end: node.type === 'end' ? now : null }) } : {})
  };
  if (node.type === 'http') return { type: 'http', outcome: 'response', status: '200', headers: '{}', body: '{}', error: '테스트 통신 오류' };
  return null;
}

export function mergeDryRunSetup(definition, saved = {}, now = new Date().toISOString()) {
  const setup = { now: saved.now ?? now, nodes: {} };
  for (const node of definition.nodes) {
    const defaults = dryRunDefaults(node, setup.now);
    if (defaults) setup.nodes[node.id] = { ...defaults, ...(saved.nodes?.[node.id]?.type === node.type ? saved.nodes[node.id] : {}) };
  }
  return setup;
}
