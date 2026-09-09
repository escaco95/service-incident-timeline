import { createHash } from 'node:crypto';

export const RECORD_FIELDS = ['events', 'changes', 'workflowRuns'];
export const TERMINAL_RUNS = new Set(['success', 'failure', 'canceled', 'interrupted', 'review', 'skipped']);
export const dayOf = at => typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString().slice(0, 10) : 'undated';
export const bucketKey = ref => `${ref.kind}/${ref.day}`;
export const lookupKey = (field, id) => `lookup/${createHash('sha256').update(`${field}\0${id}`).digest('hex').slice(0, 2)}`;
export const entryKey = entry => `${entry.field}\0${entry.key}`;
export const metadataOf = state => Object.fromEntries(Object.entries(state).filter(([key]) => !RECORD_FIELDS.includes(key) && key !== 'recordCounts'));

export function partitionRecords(state) {
  const buckets = new Map();
  const add = (kind, day, field, row) => {
    const key = `${kind}/${day}`, bucket = buckets.get(key) ?? { kind, day, data: {} };
    (bucket.data[field] ??= []).push(row); buckets.set(key, bucket);
  };
  for (const row of state.events ?? []) add(row.end === null ? 'events-open' : 'events', dayOf(row.end ?? row.start), 'events', row);
  for (const row of state.changes ?? []) add('audit', dayOf(row.at), 'changes', row);
  for (const row of state.workflowRuns ?? []) add(TERMINAL_RUNS.has(row.status) ? 'audit' : 'audit-active', dayOf(TERMINAL_RUNS.has(row.status) ? row.finishedAt : row.createdAt), 'workflowRuns', row);
  return buckets;
}

export function entriesFor(data, partition) {
  const entries = [];
  for (const field of RECORD_FIELDS) for (const row of data[field] ?? []) {
    entries.push({ field, key: row.id, partition });
    if (field === 'workflowRuns' && row.requestKey) entries.push({ field: 'requests', key: row.requestKey, partition, id: row.id });
  }
  return entries;
}

function bounds(values) {
  let min = null, max = null;
  for (const value of values) if (typeof value === 'string') { if (min === null || value < min) min = value; if (max === null || value > max) max = value; }
  return { min, max };
}
const activity = row => ({ id: row.id, workflowId: row.workflowId, createdAt: row.createdAt, finishedAt: row.finishedAt, status: row.status, durationMs: row.durationMs });

export function summarize(data) {
  if (data.entries) return { count: data.entries.length };
  const events = data.events ?? [], changes = data.changes ?? [], runs = data.workflowRuns ?? [];
  const workflows = {}, createdRuns = {};
  for (const row of runs) {
    const day = dayOf(row.createdAt); createdRuns[day] = (createdRuns[day] ?? 0) + 1;
    const current = workflows[row.workflowId] ?? {};
    if (!current.last || row.createdAt >= current.last.createdAt) current.last = activity(row);
    if (row.status === 'success' && (!current.success || row.createdAt >= current.success.createdAt)) current.success = activity(row);
    workflows[row.workflowId] = current;
  }
  return {
    counts: { events: events.length, changes: changes.length, workflowRuns: runs.length },
    events: { start: bounds(events.map(row => row.start)), end: bounds(events.map(row => row.end)), open: events.filter(row => row.end === null).length },
    changes: bounds(changes.map(row => row.at)), workflowRuns: bounds(runs.map(row => row.createdAt)), workflows, createdRuns
  };
}

export const intersects = (range, from, until) => typeof range?.min === 'string' && (!from || range.max >= from) && (!until || range.min < until);
export function eventPartitionMatches(ref, { from, until, trigger = false }) {
  if (!ref.kind.startsWith('events')) return false;
  const info = ref.summary?.events;
  if (!info) return true;
  return trigger ? intersects(info.start, from, until) || intersects(info.end, from, until)
    : info.start.min < until && (info.open > 0 || info.end.max > from);
}
