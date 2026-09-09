import { randomBytes, scrypt, createCipheriv, createDecipheriv, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { validateCatalogState, validateServices, prepareEvent } from './services.mjs';
import { validateStoredLogPolicy } from './log-policy.mjs';
import { DailyStorage } from './daily-storage.mjs';
import { createSetupMarker } from './setup-marker.mjs';
import { metadataOf, RECORD_FIELDS } from './daily-index.mjs';
import { queryEvents, queryAudit, eventQuery } from './record-queries.mjs';
export { AppError } from './errors.mjs';
export const NO_CHANGE = Symbol('no-change');

const derive = promisify(scrypt);
const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 });
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new AppError(400, '비밀번호는 12~256자로 입력해 주세요.');
  }
}

function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid envelope');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length && bytes.length !== length)) throw new Error('Invalid envelope');
  return bytes;
}

function validateEnvelope(envelope) {
  if (envelope?.version !== 1 || envelope.kdf?.name !== KDF.name || envelope.kdf.N !== KDF.N ||
      envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p || envelope.cipher?.name !== 'aes-256-gcm') {
    throw new Error('Unsupported envelope');
  }
  decode(envelope.kdf.salt, 16);
  decode(envelope.cipher.iv, 12);
  decode(envelope.cipher.tag, 16);
  decode(envelope.ciphertext);
}

function aad(kdf, scope) {
  return Buffer.from(JSON.stringify({ app: 'service-incident-timeline', version: 1, kdf, ...(scope ? { scope } : {}) }));
}

async function deriveKey(password, salt) {
  return derive(password, Buffer.from(salt, 'base64'), 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 });
}

function encrypt(state, key, kdf, scope) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(kdf, scope));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return {
    version: 1, kdf, ...(scope ? { scope } : {}),
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64')
  };
}

function decrypt(envelope, key, scope) {
  validateEnvelope(envelope);
  if (JSON.stringify(envelope.scope) !== JSON.stringify(scope)) throw new Error('Invalid file scope');
  const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.cipher.iv, 12));
  decipher.setAAD(aad(envelope.kdf, scope));
  decipher.setAuthTag(decode(envelope.cipher.tag, 16));
  return JSON.parse(Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString('utf8'));
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateEvent(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const service = typeof input?.service === 'string' ? input.service.trim() : '';
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!title || title.length > 120) throw new AppError(400, '이벤트 제목은 1~120자로 입력해 주세요.');
  if ((!Array.isArray(input.services) && service.length > 80) || description.length > 4000) throw new AppError(400, '서비스명은 80자, 상세 내용은 4,000자까지 입력할 수 있습니다.');
  if (!['incident', 'maintenance', 'instability'].includes(input.category)) throw new AppError(400, '이벤트 유형을 선택해 주세요.');
  if (!validDate(input.start) || (input.end !== null && !validDate(input.end))) throw new AppError(400, '올바른 시작·종료 시각을 입력해 주세요.');
  if (input.end !== null && Date.parse(input.end) <= Date.parse(input.start)) throw new AppError(400, '종료 시각은 시작 시각보다 늦어야 합니다.');
  const year = new Date(input.start).getUTCFullYear();
  if (year < 1900 || year > 9998 || (input.end && new Date(input.end).getUTCFullYear() > 9998)) {
    throw new AppError(400, '1900년부터 9998년까지 기록할 수 있습니다.');
  }
  return { title, service, description, category: input.category === 'instability' ? 'maintenance' : input.category, start: input.start, end: input.end };
}

function readState(state) {
  if (state?.schemaVersion !== 5) throw new AppError(409, '지원하지 않는 저장소 형식입니다. 현재 버전의 저장소를 사용해 주세요.');
  validateStoredLogPolicy(state);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.events)) throw new Error('Invalid state');
  const ids = new Set();
  for (const event of state.events) {
    validateEvent(event);
    if (typeof event.id !== 'string' || ids.has(event.id) || !Number.isSafeInteger(event.version) || event.version < 1) throw new Error('Invalid event');
    ids.add(event.id);
  }
  validateCatalogState(state);
  if (!Array.isArray(state.changes)) throw new Error('Invalid changes');
  if (!Array.isArray(state.workflows) || !Array.isArray(state.workflowRuns)) throw new Error('Invalid workflow state');
  // Keep only the current storage model when loading and subsequently saving.
  return Object.fromEntries(['schemaVersion', 'revision', 'createdAt', 'updatedAt', 'events', 'catalog', 'changes', 'workflows', 'workflowRuns', 'logPolicy', 'logMaintenance', 'resetRequests'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
}

function eventSnapshot(event) {
  if (!event) return null;
  return { id: event.id, version: event.version, title: event.title, category: event.category, description: event.description, services: structuredClone(event.services), start: event.start, end: event.end };
}

function decryptRecords(envelope, key, scope) {
  const data = decrypt(envelope, key, scope);
  const ids = new Set();
  for (const event of data.events ?? []) {
    validateEvent(event);
    if (typeof event.id !== 'string' || ids.has(event.id) || !Number.isSafeInteger(event.version) || event.version < 1) throw new Error('Invalid event');
    ids.add(event.id);
  }
  return data;
}

export function recordChange(state, action, before, after, { actor = 'shared-user', at = new Date().toISOString() } = {}) {
  if (state.changes.filter(row => row.at?.slice(0, 10) === at.slice(0, 10)).length >= 50000) throw new AppError(409, '하루 변경 이력 한도(50,000건)에 도달했습니다. 로그 관리 정책을 확인해 주세요.');
  state.changes.push({ id: randomUUID(), at, action, actor, before, after });
}

export class Vault {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'store.json');
    this.lockFile = path.join(this.directory, '.process-lock');
    this.key = null;
    this.state = null;
    this.envelope = null;
    this.daily = null;
    this.initialized = false;
    this.queue = Promise.resolve();
    this.lockToken = randomUUID();
  }

  get unlocked() { return this.key !== null; }

  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.acquireLock();
    try {
      const stat = await fs.stat(this.file);
      this.initialized = true;
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid file');
      const raw = await fs.readFile(this.file, 'utf8');
      this.envelope = JSON.parse(raw);
      validateEnvelope(this.envelope);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // An unreadable existing file must never become a fresh vault.
        this.initialized = true;
        this.envelope = null;
      }
    }
    return this;
  }

  async acquireLock() {
    try {
      const handle = await fs.open(this.lockFile, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); }
      finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8')); }
      catch { throw new Error('데이터 디렉터리의 .process-lock을 확인해 주세요. 다른 서버가 실행 중일 수 있습니다.'); }
      if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('잘못된 데이터 디렉터리 잠금입니다.');
      try { process.kill(lock.pid, 0); }
      catch (signalError) {
        if (signalError.code === 'ESRCH') {
          await fs.unlink(this.lockFile);
          return this.acquireLock();
        }
        throw signalError;
      }
      throw new Error('이 데이터 디렉터리를 사용하는 서버가 이미 실행 중입니다.');
    }
  }

  serialize(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  async setup(password) {
    checkPassword(password);
    return this.serialize(async () => {
      if (this.initialized) throw new AppError(409, '이미 설정된 서비스입니다. 로그인해 주세요.');
      const kdf = { ...KDF, salt: randomBytes(16).toString('base64') };
      const key = await deriveKey(password, kdf.salt);
      const now = new Date().toISOString();
      const state = { schemaVersion: 5, revision: 0, createdAt: now, updatedAt: now, events: [], catalog: { version: 1, services: [] }, changes: [], workflows: [], workflowRuns: [] };
      try {
        const envelope = encrypt(state, key, kdf);
        await this.write(envelope);
        await createSetupMarker(this.directory);
        this.key = key;
        this.state = state;
        this.envelope = envelope;
        this.initialized = true;
      } catch (error) { key.fill(0); throw error; }
    });
  }

  async unlock(password) {
    checkPassword(password);
    return this.serialize(async () => {
      if (!this.initialized) throw new AppError(409, '먼저 암호화 비밀번호를 설정해 주세요.');
      if (!this.envelope) throw new AppError(503, '저장 파일을 읽을 수 없습니다. 원본을 보존하고 백업을 확인해 주세요.');
      const key = await deriveKey(password, this.envelope.kdf.salt);
      let state;
      try {
        state = decrypt(this.envelope, key);
        let daily = null;
        if (state.dailyStorageVersion !== undefined) {
          daily = new DailyStorage(this.directory);
          let backup;
          try { backup = decrypt(JSON.parse(await fs.readFile(this.file + '.bak', 'utf8')), key); } catch { /* A damaged backup cannot block a valid current manifest. */ }
          state = await daily.load(state, (value, scope) => decryptRecords(value, key, scope), backup);
        }
        state = readState(state);
        state.events = state.events.map(event => event.category === 'instability' ? { ...event, category: 'maintenance' } : event);
        this.daily = daily;
      }
      catch (error) {
        key.fill(0);
        if (error instanceof AppError && error.status === 409) throw error;
        throw new AppError(401, '복호화하지 못했습니다. 비밀번호가 다르거나 저장 데이터가 손상되었습니다.');
      }
      this.key?.fill(0);
      this.key = key;
      this.state = state;
    });
  }

  assertUnlocked() {
    if (!this.unlocked) throw new AppError(423, '서비스의 잠금을 먼저 해제해 주세요.');
  }

  async snapshot(scope = { all: true }) {
    return this.serialize(async () => {
      this.assertUnlocked();
      const records = this.daily ? (await this.daily.loadSelection(scope)).records : Object.fromEntries(RECORD_FIELDS.map(field => [field, this.state[field]]));
      return structuredClone({ ...metadataOf(this.state), ...records });
    });
  }
  async getRecord(field, id) {
    const state = await this.snapshot({ ids: { [field]: [id] } }), record = state[field].find(row => row.id === id);
    if (!record) throw new AppError(404, field === 'events' ? '이벤트를 찾을 수 없습니다.' : '기록을 찾을 수 없습니다.');
    return record;
  }
  read(parameters = new URLSearchParams()) {
    return this.serialize(async () => {
      this.assertUnlocked();
      if (this.daily) return queryEvents(this.daily, this.state, parameters);
      const { from, until, page, limit, revision } = eventQuery(parameters), rows = this.state.events.filter(row => !from || row.start < until && (row.end === null || row.end > from));
      if (revision !== null && revision !== this.state.revision) throw new AppError(409, '조회 중 이벤트가 변경되었습니다. 다시 불러와 주세요.');
      return structuredClone({ revision: this.state.revision, events: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit, pages: Math.max(1, Math.ceil(rows.length / limit)), from, until });
    });
  }
  audit(parameters) {
    return this.serialize(async () => {
      this.assertUnlocked();
      if (this.daily) return queryAudit(this.daily, this.state, parameters);
      const { readAudit } = await import('./audit.mjs');
      return { ...readAudit(this.state, parameters), counts: { changes: this.state.changes.length, workflows: this.state.workflowRuns.length } };
    });
  }

  async verifyPassword(password) {
    checkPassword(password);
    if (!this.unlocked || !this.envelope) throw new AppError(423, '로그인이 필요합니다.');
    const key = await deriveKey(password, this.envelope.kdf.salt);
    try { if (!this.key || !timingSafeEqual(key, this.key)) throw new AppError(403, '비밀번호가 일치하지 않습니다.'); }
    finally { key.fill(0); }
  }

  async mutate(change, { discardBackup = false, scope = { all: true }, removeKeys = [] } = {}) {
    return this.serialize(async () => {
      if (!this.unlocked) throw new AppError(423, '서비스의 잠금을 먼저 해제해 주세요.');
      const selection = this.daily ? await this.daily.loadSelection(typeof scope === 'function' ? await scope(this.daily) : scope) : { records: Object.fromEntries(RECORD_FIELDS.map(field => [field, this.state[field]])), loaded: new Map() };
      const next = structuredClone({ ...metadataOf(this.state), ...selection.records, recordCounts: this.daily?.counts() });
      const result = change(next);
      if (result === NO_CHANGE) return { revision: this.state.revision, event: null };
      if (result && typeof result.then === 'function') throw new Error('Vault changes must be synchronous');
      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      const daily = this.daily ?? new DailyStorage(this.directory);
      daily.decode = (value, scope) => decryptRecords(value, this.key, scope);
      const retention = Boolean(next.logMaintenance?.pendingRun && next.logMaintenance.pendingRun.runId !== this.state.logMaintenance?.pendingRun?.runId);
      const removed = typeof removeKeys === 'function' ? removeKeys(next) : removeKeys;
      const envelope = await daily.save(next, (value, scope) => encrypt(value, this.key, this.envelope.kdf, scope), (value, backupEnvelope) => this.write(value, { backupEnvelope }), { retention, purge: discardBackup, loaded: selection.loaded, removeKeys: removed });
      this.state = { ...metadataOf(next), events: [], changes: [], workflowRuns: [] };
      this.envelope = envelope;
      this.daily = daily;
      if (!next.logMaintenance?.pendingRun) await daily.cleanup();
      return { revision: next.revision, event: result };
    });
  }

  add(input) {
    const fields = validateEvent(input);
    return this.mutate(state => {
      const now = new Date().toISOString();
      const event = { id: randomUUID(), ...prepareEvent(fields, input, state.catalog), version: 1, createdAt: now, updatedAt: now };
      state.events.push(event);
      recordChange(state, 'event-created', null, eventSnapshot(event));
      return event;
    }, { scope: {} });
  }

  update(id, input) {
    const fields = validateEvent(input);
    return this.mutate(state => {
      const index = state.events.findIndex(event => event.id === id);
      if (index < 0) throw new AppError(404, '이벤트를 찾을 수 없습니다.');
      const original = state.events[index];
      if (input.version !== original.version) throw new AppError(409, '다른 화면에서 이벤트가 변경되었습니다. 최신 내용을 확인한 후 다시 수정해 주세요.');
      state.events[index] = { ...original, ...prepareEvent(fields, input, state.catalog, original), version: original.version + 1, updatedAt: new Date().toISOString() };
      recordChange(state, 'event-updated', eventSnapshot(original), eventSnapshot(state.events[index]));
      return state.events[index];
    }, { scope: { ids: { events: [id] } } });
  }

  remove(id, version) {
    return this.mutate(state => {
      const index = state.events.findIndex(event => event.id === id);
      if (index < 0) throw new AppError(404, '이미 삭제된 이벤트입니다.');
      if (state.events[index].version !== version) throw new AppError(409, '다른 화면에서 변경된 이벤트입니다. 최신 내용을 확인한 후 삭제해 주세요.');
      recordChange(state, 'event-deleted', eventSnapshot(state.events[index]), null);
      state.events.splice(index, 1);
      return null;
    }, { scope: { ids: { events: [id] } } });
  }

  readServices() {
    this.assertUnlocked();
    return structuredClone(this.state.catalog);
  }

  async saveServices(input) {
    await this.mutate(state => {
      const previous = state.catalog;
      if (input.version !== previous.version) throw new AppError(409, '서비스 목록이 변경되었습니다. 최신 목록을 불러온 뒤 저장해 주세요.');
      state.catalog = { version: previous.version + 1, services: validateServices(input.services, previous.services) };
      recordChange(state, 'services-updated', structuredClone(previous), structuredClone(state.catalog));
    }, { scope: {} });
    return this.readServices();
  }

  async write(envelope, { backupEnvelope } = {}) {
    const output = JSON.stringify(envelope, null, 2) + '\n';
    if (Buffer.byteLength(output) > MAX_FILE_BYTES) throw new AppError(409, '저장 파일 한도(64MB)에 도달했습니다. 이전 기록을 정리해 주세요.');
    const temporary = path.join(this.directory, `.store-${randomUUID()}.tmp`);
    let committed = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(output, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      if (this.initialized) {
        const backupTemp = temporary + '.backup';
        try {
          if (backupEnvelope) {
            const backupHandle = await fs.open(backupTemp, 'wx', 0o600);
            try { await backupHandle.writeFile(JSON.stringify(backupEnvelope) + '\n', 'utf8'); await backupHandle.sync(); } finally { await backupHandle.close(); }
          } else await fs.copyFile(this.file, backupTemp);
          await fs.chmod(backupTemp, 0o600);
          await fs.rename(backupTemp, this.file + '.bak');
        } finally { await fs.rm(backupTemp, { force: true }); }
      }
      await fs.rename(temporary, this.file);
      committed = true;
      if (process.platform !== 'win32') {
        // The rename has committed. A directory-sync failure must not leave
        // the in-memory revision behind the file that is now on disk.
        try {
          const directory = await fs.open(this.directory, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } catch { console.error('데이터 파일 교체 후 디렉터리 동기화에 실패했습니다. 저장 장치를 확인해 주세요.'); }
      }
    } finally {
      if (committed) await fs.rm(temporary, { force: true }).catch(() => {});
      else await fs.rm(temporary, { force: true });
    }
  }

  async close() {
    await this.queue;
    this.key?.fill(0);
    this.key = null;
    this.state = null;
    this.daily?.clearCache();
    try {
      const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
      if (lock.token === this.lockToken) await fs.unlink(this.lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
