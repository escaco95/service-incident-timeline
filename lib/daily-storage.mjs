import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { RECORD_FIELDS, bucketKey, lookupKey, entryKey, metadataOf, partitionRecords, entriesFor, summarize, eventPartitionMatches } from './daily-index.mjs';

const KINDS = new Set(['events', 'events-open', 'audit', 'audit-active', 'lookup']);
const MAX_BYTES = 64 * 1024 * 1024, CACHE_BYTES = 16 * 1024 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checkRef(ref) {
  if (!ref || !KINDS.has(ref.kind) || !(ref.kind === 'lookup' ? /^[0-9a-f]{2}$/ : /^(?:\d{4}-\d{2}-\d{2}|undated)$/).test(ref.day) || typeof ref.file !== 'string' || !new RegExp(`^${ref.kind}/${ref.day}\\.[0-9a-f-]{36}\\.json$`).test(ref.file)) throw new Error('Invalid daily file reference');
  return ref;
}

export class DailyStorage {
  constructor(directory) {
    this.directory = directory; this.manifest = null; this.backup = null; this.garbage = [];
    this.cache = new Map(); this.cacheBytes = 0; this.legacyLookup = new Map(); this.reads = 0;
  }
  clearCache() { this.cache.clear(); this.cacheBytes = 0; }
  refs() { return this.manifest?.files ?? []; }
  ref(key) { return this.refs().find(ref => bucketKey(ref) === key); }
  async readBucket(ref) {
    if (!ref) return {};
    if (this.cache.has(ref.file)) { const item = this.cache.get(ref.file); this.cache.delete(ref.file); this.cache.set(ref.file, item); return item.data; }
    try {
      checkRef(ref);
      const file = path.join(this.directory, ref.file), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid daily file');
      const raw = await fs.readFile(file, 'utf8'); this.reads++;
      const data = this.decode(JSON.parse(raw), { kind: ref.kind, day: ref.day });
      const fields = ref.kind === 'lookup' ? ['entries'] : ref.kind.startsWith('events') ? ['events'] : ['changes', 'workflowRuns'];
      for (const [field, rows] of Object.entries(data)) if (!fields.includes(field) || !Array.isArray(rows)) throw new Error('Invalid daily records');
      if (ref.hash && digest(data) !== ref.hash) throw new Error('Invalid daily digest');
      if (stat.size <= CACHE_BYTES) {
        while (this.cache.size && this.cacheBytes + stat.size > CACHE_BYTES) { const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key); }
        this.cache.set(ref.file, { data, bytes: stat.size }); this.cacheBytes += stat.size;
      }
      return data;
    } catch { throw new AppError(503, '요청한 기간의 데이터 파일을 읽을 수 없습니다. 원본 파일과 백업을 확인해 주세요.'); }
  }
  async load(manifest, decode, backup) {
    if (![1, 2].includes(manifest.dailyStorageVersion) || !manifest.metadata || !Array.isArray(manifest.files) || !Array.isArray(manifest.garbage)) throw new Error('Invalid daily manifest');
    this.decode = decode;
    const keys = new Set(), files = new Set();
    for (const ref of manifest.files) { checkRef(ref); if (keys.has(bucketKey(ref)) || files.has(ref.file)) throw new Error('Duplicate daily partition'); keys.add(bucketKey(ref)); files.add(ref.file); }
    this.manifest = structuredClone(manifest);
    this.backup = [1, 2].includes(backup?.dailyStorageVersion) && Array.isArray(backup.files) ? backup : null;
    this.garbage = manifest.garbage.map(checkRef);
    if (this.garbage.some(ref => files.has(ref.file))) throw new Error('Live daily file marked for deletion');
    // Old daily manifests need a one-time streaming index build. The next write
    // persists the index; reading alone does not replace the original manifest.
    if (manifest.dailyStorageVersion === 1) for (const ref of this.refs()) {
      const data = await this.readBucket(ref); ref.summary = summarize(data); ref.hash = digest(data);
      for (const entry of entriesFor(data, bucketKey(ref))) {
        const key = lookupKey(entry.field, entry.key), entries = this.legacyLookup.get(key) ?? new Map();
        if (entries.has(entryKey(entry))) throw new Error('Duplicate record ID');
        entries.set(entryKey(entry), entry); this.legacyLookup.set(key, entries);
      }
    }
    this.clearCache();
    return { ...structuredClone(manifest.metadata), events: [], changes: [], workflowRuns: [] };
  }
  async lookup(field, id) {
    const key = lookupKey(field, id), legacy = this.legacyLookup.get(key);
    const entry = legacy ? legacy.get(field + '\0' + id) : (await this.readBucket(this.ref(key))).entries?.find(entry => entry.field === field && entry.key === id);
    return entry && this.ref(entry.partition) ? entry : null;
  }
  async select(scope = {}) {
    const keys = new Set(scope.keys ?? []);
    for (const ref of this.refs()) {
      if (ref.kind === 'lookup') continue;
      if (scope.all || scope.kinds?.includes(ref.kind) || scope.activeRuns && ref.kind === 'audit-active' || scope.eventRange && eventPartitionMatches(ref, scope.eventRange) || scope.eventTrigger && eventPartitionMatches(ref, { ...scope.eventTrigger, trigger: true }) || scope.auditDays?.includes(ref.day) && ref.kind === 'audit') keys.add(bucketKey(ref));
    }
    for (const [field, ids] of Object.entries(scope.ids ?? {})) for (const id of ids.filter(Boolean)) { const entry = await this.lookup(field, id); if (entry) keys.add(entry.partition); }
    for (const key of scope.requests ?? []) { const entry = await this.lookup('requests', key); if (entry) keys.add(entry.partition); }
    return [...keys].filter(key => this.ref(key));
  }
  async loadSelection(scope) {
    const loaded = new Map(), records = { events: [], changes: [], workflowRuns: [] };
    for (const key of await this.select(scope)) {
      const data = await this.readBucket(this.ref(key)); loaded.set(key, data);
      for (const field of RECORD_FIELDS) for (const row of data[field] ?? []) records[field].push(row);
    }
    return { loaded, records: structuredClone(records) };
  }
  counts() {
    const result = { events: 0, changes: 0, workflowRuns: 0, runsByDay: {} };
    for (const ref of this.refs()) {
      for (const field of RECORD_FIELDS) result[field] += ref.summary?.counts?.[field] ?? 0;
      for (const [day, count] of Object.entries(ref.summary?.createdRuns ?? {})) result.runsByDay[day] = (result.runsByDay[day] ?? 0) + count;
    }
    return result;
  }
  activities() {
    const result = new Map();
    for (const ref of this.refs()) for (const [id, info] of Object.entries(ref.summary?.workflows ?? {})) {
      const current = result.get(id) ?? {};
      for (const field of ['last', 'success']) if (info[field] && (!current[field] || info[field].createdAt >= current[field].createdAt)) current[field] = info[field];
      result.set(id, current);
    }
    return result;
  }
  async expired(policy, at) {
    const date = new Date(at); date.setUTCHours(0, 0, 0, 0);
    const eventCutoffDate = new Date(+date - policy.eventRetentionDays * 86400000).toISOString().slice(0, 10), auditCutoffDate = new Date(+date - policy.auditRetentionDays * 86400000).toISOString().slice(0, 10);
    const refs = this.refs().filter(ref => ref.day !== 'undated' && (ref.kind === 'events' && ref.day < eventCutoffDate || ref.kind === 'audit' && ref.day < auditCutoffDate));
    const keys = new Set(refs.map(bucketKey)), eventIds = [];
    for (const key of refs.some(ref => ref.kind === 'events') ? new Set([...this.refs().filter(ref => ref.kind === 'lookup').map(bucketKey), ...this.legacyLookup.keys()]) : []) {
      const entries = this.legacyLookup.has(key) ? [...this.legacyLookup.get(key).values()] : (await this.readBucket(this.ref(key))).entries ?? [];
      for (const entry of entries) if (entry.field === 'events' && keys.has(entry.partition)) eventIds.push(entry.key);
    }
    return { keys: [...keys], eventIds, eventCutoffDate, auditCutoffDate, counts: { changes: refs.reduce((sum, ref) => sum + (ref.summary?.counts?.changes ?? 0), 0), workflowRuns: refs.reduce((sum, ref) => sum + (ref.summary?.counts?.workflowRuns ?? 0), 0) } };
  }
  async save(state, encode, commit, { loaded = new Map(), removeKeys = [], retention = false, purge = false } = {}) {
    const buckets = partitionRecords(state), removed = new Set(removeKeys), previous = new Map(this.refs().map(ref => [bucketKey(ref), ref]));
    // A record can move to a date outside the read scope. Merge that destination
    // before writing it, preserving every unrelated event/log already there.
    for (const [key, bucket] of buckets) if (!loaded.has(key) && previous.has(key) && !removed.has(key)) {
      const original = await this.readBucket(previous.get(key)); loaded.set(key, original);
      for (const field of RECORD_FIELDS) if (original[field]) {
        const rows = new Map(original[field].map(row => [row.id, row]));
        for (const row of bucket.data[field] ?? []) rows.set(row.id, row);
        bucket.data[field] = [...rows.values()];
      }
    }
    const updates = new Map();
    for (const [key, data] of loaded) for (const entry of entriesFor(data, key)) updates.set(entryKey(entry), { old: entry });
    for (const [key, bucket] of buckets) for (const entry of entriesFor(bucket.data, key)) updates.set(entryKey(entry), { ...updates.get(entryKey(entry)), entry });
    const lookups = new Map([...this.legacyLookup].map(([key, entries]) => [key, new Map(entries)]));
    const index = async key => { if (!lookups.has(key)) lookups.set(key, new Map(((await this.readBucket(previous.get(key))).entries ?? []).map(entry => [entryKey(entry), entry]))); return lookups.get(key); };
    if (removed.size) for (const ref of this.refs().filter(ref => ref.kind === 'lookup')) await index(bucketKey(ref));
    for (const entries of lookups.values()) for (const [key, entry] of entries) if (removed.has(entry.partition)) entries.delete(key);
    for (const { old, entry } of updates.values()) {
      if (old && entry && old.partition === entry.partition && old.id === entry.id) continue;
      const value = entry ?? old, entries = await index(lookupKey(value.field, value.key));
      const existing = entries.get(entryKey(value));
      if (entry && !old && existing && !removed.has(existing.partition) && existing.partition !== entry.partition) throw new AppError(409, '이미 사용한 기록 식별자입니다. 최신 내용을 확인해 주세요.');
      if (entry) entries.set(entryKey(entry), entry); else entries.delete(entryKey(old));
    }
    for (const [key, entries] of lookups) { const [kind, day] = key.split('/'); if (entries.size) buckets.set(key, { kind, day, data: { entries: [...entries.values()].sort((a, b) => entryKey(a).localeCompare(entryKey(b))) } }); }
    const touched = new Set([...loaded.keys(), ...removed, ...buckets.keys(), ...lookups.keys()]);
    const refs = this.refs().filter(ref => !touched.has(bucketKey(ref))), created = [];
    let committed = false, committing = false;
    try {
      for (const [key, bucket] of buckets) {
        const hash = digest(bucket.data), old = previous.get(key);
        if (old?.hash === hash) { refs.push(old); continue; }
        const summary = summarize(bucket.data);
        if ((summary.counts?.changes ?? 0) > 50000) throw new AppError(409, '하루 변경 이력 한도(50,000건)에 도달했습니다.');
        const ref = { kind: bucket.kind, day: bucket.day, file: `${key}.${randomUUID()}.json`, hash, summary, count: summary.count ?? Object.values(summary.counts).reduce((sum, count) => sum + count, 0) };
        const file = path.join(this.directory, ref.file), output = JSON.stringify(encode(bucket.data, { kind: ref.kind, day: ref.day })) + '\n';
        if (Buffer.byteLength(output) > MAX_BYTES) throw new AppError(409, '날짜별 파일 한도(64MB)에 도달했습니다.');
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const handle = await fs.open(file, 'wx', 0o600); created.push(file);
        try { await handle.writeFile(output, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        refs.push(ref);
      }
      const keep = new Set([...refs, ...(retention || purge ? [] : this.refs())].map(ref => ref.file));
      const retired = [...this.garbage, ...(this.backup?.files ?? []), ...this.refs()];
      if (retention) for (const [kind, cutoff] of [['events', state.logMaintenance.pendingRun.eventCutoffDate], ['audit', state.logMaintenance.pendingRun.auditCutoffDate]]) {
        const entries = await fs.readdir(path.join(this.directory, kind), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const entry of entries) { const match = /^(\d{4}-\d{2}-\d{2})\.[0-9a-f-]{36}\.json$/.exec(entry.name); if (entry.isFile() && match && match[1] < cutoff) retired.push({ kind, day: match[1], file: `${kind}/${entry.name}` }); }
      }
      if (process.platform !== 'win32') for (const directory of new Set(created.map(file => path.dirname(file)))) { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
      const garbage = [...new Map(retired.filter(ref => !keep.has(ref.file)).map(ref => [ref.file, ref])).values()];
      if (retention) state.logMaintenance.pendingRun.targetFiles = garbage.filter(ref => ref.kind !== 'lookup').map(ref => ({ kind: ref.kind, day: ref.day, file: ref.file }));
      const manifest = { dailyStorageVersion: 2, metadata: metadataOf(state), files: refs, garbage }, envelope = encode(manifest);
      committing = true; await commit(envelope, retention || purge ? encode(manifest) : undefined); committed = true;
      this.backup = retention || purge ? manifest : this.manifest; this.manifest = manifest; this.garbage = garbage; this.legacyLookup.clear();
      return envelope;
    } finally { if (!committed && !(committing && (retention || purge))) for (const file of created) await fs.rm(file, { force: true }).catch(() => {}); }
  }
  async cleanup() {
    const remaining = [], counts = {}, live = new Set([...this.refs(), ...(this.backup?.files ?? [])].map(ref => ref.file));
    for (const ref of this.garbage) {
      checkRef(ref); if (live.has(ref.file)) { remaining.push(ref); continue; }
      try { await fs.unlink(path.join(this.directory, ref.file)); counts[ref.kind] = (counts[ref.kind] ?? 0) + 1; }
      catch (error) { if (error.code !== 'ENOENT') remaining.push(ref); }
      if (this.cache.has(ref.file)) { this.cacheBytes -= this.cache.get(ref.file).bytes; this.cache.delete(ref.file); }
    }
    this.garbage = remaining;
    return { deletedFiles: counts, pendingFiles: remaining.length };
  }
}
