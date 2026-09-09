import { AppError } from './errors.mjs';
import { eventPartitionMatches, intersects } from './daily-index.mjs';
import { readAudit } from './audit.mjs';

const instant = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const newer = (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export function eventQuery(parameters = new URLSearchParams()) {
  const from = parameters.get('from') ?? '', until = parameters.get('until') ?? '';
  const page = Number(parameters.get('page') ?? 1), limit = Number(parameters.get('limit') ?? 100);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError(400, '이벤트 조회 범위를 확인해 주세요.');
  if (Boolean(from) !== Boolean(until) || from && (!instant(from) || !instant(until) || from >= until || Date.parse(until) - Date.parse(from) > 366 * 86400000)) throw new AppError(400, '이벤트 조회 기간은 시작 이상·종료 미만으로 최대 366일까지 지정해 주세요.');
  return { from, until, page, limit, revision: parameters.has('revision') ? Number(parameters.get('revision')) : null };
}

export async function queryEvents(daily, metadata, parameters) {
  const query = eventQuery(parameters), { from, until, page, limit } = query;
  if (query.revision !== null && query.revision !== metadata.revision) throw new AppError(409, '조회 중 이벤트가 변경되었습니다. 다시 불러와 주세요.');
  const refs = daily.refs().filter(ref => ref.kind.startsWith('events') && (!from || eventPartitionMatches(ref, query))).sort((a, b) => b.day.localeCompare(a.day) || a.kind.localeCompare(b.kind));
  const events = []; let total = 0;
  for (const ref of refs) {
    // The default list has no overlap filter, so entirely skipped pages need no decryption.
    const count = ref.summary?.counts?.events;
    if (!from && count !== undefined && (total + count <= (page - 1) * limit || events.length >= limit)) { total += count; continue; }
    const rows = (await daily.readBucket(ref)).events ?? [];
    for (const row of [...rows].sort((a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id))) {
      if (from && !(row.start < until && (row.end === null || row.end > from))) continue;
      if (total >= (page - 1) * limit && events.length < limit) events.push(row);
      total++;
    }
  }
  return structuredClone({ revision: metadata.revision, events, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), from, until });
}

// Retain only compact references to the requested page, never the bodies of all
// matching audit entries. A max heap keeps the newest offset + limit references.
class Window {
  constructor(limit) { this.limit = limit; this.rows = []; }
  add(row) {
    const rows = this.rows;
    if (rows.length === this.limit) {
      if (newer(row, rows[0]) >= 0) return;
      rows[0] = row;
      let index = 0;
      while (index * 2 + 1 < rows.length) {
        let child = index * 2 + 1;
        if (child + 1 < rows.length && newer(rows[child + 1], rows[child]) > 0) child++;
        if (newer(rows[index], rows[child]) >= 0) break;
        [rows[index], rows[child]] = [rows[child], rows[index]]; index = child;
      }
    } else {
      rows.push(row); let index = rows.length - 1;
      while (index > 0) { const parent = Math.floor((index - 1) / 2); if (newer(rows[parent], rows[index]) >= 0) break; [rows[index], rows[parent]] = [rows[parent], rows[index]]; index = parent; }
    }
  }
}

export async function queryAudit(daily, metadata, parameters) {
  // The pure query validates the same API contract and applies record filters.
  const empty = readAudit({ changes: [], workflowRuns: [] }, parameters), field = empty.kind === 'workflows' ? 'workflowRuns' : 'changes';
  const from = parameters.get('from') ?? '', until = parameters.get('until') ?? '';
  const counts = daily.counts(), capacity = Math.min(counts[field], empty.page * empty.limit), window = new Window(Math.max(1, capacity));
  const plainTime = !['targetId', 'eventId', 'workflowId', 'result', 'mode', 'search'].some(key => parameters.get(key));
  const refs = daily.refs().filter(ref => ref.kind.startsWith('audit') && (ref.summary?.counts?.[field] ?? 0) > 0 && intersects(ref.summary[field], from, until)).sort((a, b) => b.summary[field].max.localeCompare(a.summary[field].max));
  const filter = new URLSearchParams(parameters); filter.set('page', '1'); filter.set('limit', '100');
  let total = 0;
  for (const ref of refs) {
    const bounds = ref.summary[field], complete = plainTime && (!from || bounds.min >= from) && (!until || bounds.max < until);
    if (complete && window.rows.length === window.limit && bounds.max < window.rows[0].at) { total += ref.summary.counts[field]; continue; }
    const data = await daily.readBucket(ref);
    // Bound each filter operation to a small batch; readAudit returns copied bodies.
    const rows = data[field] ?? [];
    for (let index = 0; index < rows.length; index += 100) {
      const result = readAudit({ changes: [], workflowRuns: [], [field]: rows.slice(index, index + 100) }, filter);
      total += result.total;
      for (const row of result.items) window.add({ id: row.id, at: row.at, ref });
    }
  }
  const items = [];
  for (const row of window.rows.sort(newer).slice((empty.page - 1) * empty.limit)) {
    const data = await daily.readBucket(row.ref), record = data[field].find(item => item.id === row.id);
    items.push(readAudit({ changes: [], workflowRuns: [], [field]: [record] }, filter).items[0]);
  }
  return structuredClone({ ...empty, revision: metadata.revision, total, pages: Math.max(1, Math.ceil(total / empty.limit)), items, counts: { changes: counts.changes, workflows: counts.workflowRuns } });
}
