import { AppError } from './errors.mjs';
const validInstant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const text = value => String(value ?? '').toLocaleLowerCase();
const includes = (value, search) => !search || text(value).includes(text(search));
const eventIds = row => [row.before?.id, row.after?.id, ...(row.after?.eventIds ?? [])].filter(Boolean);
const serviceIds = row => [...(row.before?.services ?? []), ...(row.after?.services ?? [])].map(item => item.id).filter(Boolean);

export function readAudit(state, parameters) {
  const filters = Object.fromEntries(['kind', 'from', 'until', 'targetId', 'eventId', 'workflowId', 'result', 'mode', 'search'].map(key => [key, parameters.get(key) ?? '']));
  const page = Number(parameters.get('page') ?? 1), limit = Number(parameters.get('limit') ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || Object.values(filters).some(value => value.length > 128)) throw new AppError(400, '감사 로그 조회 범위를 확인해 주세요.');
  if ((filters.from && !validInstant(filters.from)) || (filters.until && !validInstant(filters.until)) || (filters.from && filters.until && filters.from >= filters.until)) throw new AppError(400, '조회 기간은 시작 이상·종료 미만의 UTC 시각으로 지정해 주세요.');
  if (!['', 'changes', 'workflows'].includes(filters.kind)) throw new AppError(400, '감사 로그 종류를 확인해 주세요.');
  const inRange = at => (!filters.from || at >= filters.from) && (!filters.until || at < filters.until);
  let rows;
  if (filters.kind === 'workflows') {
    rows = (state.workflowRuns ?? []).filter(run => inRange(run.createdAt) && (!filters.workflowId || run.workflowId === filters.workflowId) && (!filters.eventId || (run.input.event?.id === filters.eventId || run.input.trigger?.events?.some(event => event.id === filters.eventId))) && (!filters.targetId || (run.input.trigger?.service === filters.targetId || run.input.event?.services?.some(service => service.id === filters.targetId))) && includes(run.status, filters.result) && includes(run.kind, filters.mode) && includes([run.id, run.workflowName, run.input.event?.title, run.input.trigger?.service].join(' '), filters.search)).map(run => ({ id: run.id, at: run.createdAt, createdAt: run.createdAt, workflowId: run.workflowId, workflowName: run.workflowName, definitionVersion: run.definitionVersion, eventId: run.input.event?.id, kind: run.kind, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs, parentId: run.parentId, service: run.input.trigger?.service }));
  } else {
    rows = state.changes.map(row => ({ ...row, type: row.action })).filter(row =>
      inRange(row.at) && (!filters.workflowId || row.before?.workflowId === filters.workflowId || row.after?.workflowId === filters.workflowId) && (!filters.targetId || serviceIds(row).includes(filters.targetId)) && (!filters.eventId || eventIds(row).includes(filters.eventId)) && includes(row.type, filters.result) && !filters.mode && includes(JSON.stringify([row.id, row.type, row.before, row.after]), filters.search)
    );
  }
  rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return structuredClone({ kind: filters.kind || 'changes', page, limit, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / limit)), items: rows.slice((page - 1) * limit, page * limit) });
}
