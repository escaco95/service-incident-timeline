import { AppError } from './errors.mjs';
import { effectiveServices } from './service-state.mjs';
import { DRY_RUN_LIMITS } from '../public/workflow-dry-run-spec.js';

export function serviceEventInstant(event, occurrence) {
  if (!['start', 'end'].includes(occurrence)) throw new AppError(400, '일정 시작 또는 종료를 선택해 주세요.');
  const at = event[occurrence];
  if (!at || !Number.isFinite(Date.parse(at))) throw new AppError(400, occurrence === 'end' ? '종료 시각이 지정된 일정을 선택해 주세요.' : '일정 시작 시각을 확인해 주세요.');
  return at;
}

// Reuse the scheduler's pure aggregation; never reconcile or enqueue real state.
export function serviceEventDryRun(state, event, occurrence, service) {
  const at = serviceEventInstant(event, occurrence);
  if (typeof service !== 'string' || !service || service.length > 100 || !event.services.some(item => item.label === service)) throw new AppError(400, '선택한 일정에 포함된 서비스를 선택해 주세요.');
  const before = effectiveServices(state.events, new Date(Date.parse(at) - 1).toISOString()).get(service);
  const after = effectiveServices(state.events, at).get(service);
  const previous = before?.severity ?? '', severity = after?.severity ?? '', changed = previous !== severity;
  const generationBase = state.serviceState?.services.find(item => item.service === service)?.generation ?? 0;
  const trigger = { type: 'service-state', service, previous, severity, scheduledAt: at, events: after?.events ?? [], generation: generationBase + Number(changed) };
  const scenario = { kind: 'service-event', eventId: event.id, eventVersion: event.version, eventTitle: event.title, occurrence, service, scheduledAt: at, previous, severity, changed, generationBase };
  const values = { type: 'service-state', trigger: JSON.stringify(trigger, null, 2), scenario: JSON.stringify(scenario) };
  if (values.trigger.length > DRY_RUN_LIMITS.json) throw new AppError(400, '관련 일정이 너무 많습니다. 필요한 트리거 초기값을 직접 입력해 주세요.');
  return { now: at, values };
}
