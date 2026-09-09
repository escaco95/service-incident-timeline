import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ARCHIVE_LIMITS } from './archive-zip.mjs';
import { archiveDate } from './archive-data.mjs';
import { linkCopy } from './restore-journal.mjs';
import { AppError } from './errors.mjs';

const ID = /^[0-9a-f-]{36}$/, REQUEST = /^[a-zA-Z0-9_-]{8,100}$/;
const ACTIVE = new Set(['preparing', 'uploading', 'validating', 'restoring']);
const READY_TTL = 24 * 60 * 60 * 1000, WORK_TTL = 2 * 60 * 60 * 1000;
export class DataTransfers {
  constructor(vault, branding) { this.vault = vault; this.branding = branding; this.root = path.join(vault.directory, '.transfers'); this.jobs = new Map(); this.creating = false; this.closed = false; }
  async open() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root); if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(this.root) !== this.vault.directory) throw Error('Invalid transfer directory');
    for (const item of await fs.readdir(this.root, { withFileTypes: true })) if (ID.test(item.name)) await this.removeFiles(path.join(this.root, item.name));
    this.timer = setInterval(() => { this.expire().catch(() => {}); }, 15000); this.timer.unref(); return this;
  }
  async removeFiles(directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.root || !ID.test(path.basename(resolved))) throw Error('Invalid transfer cleanup path');
    const stat = await fs.lstat(resolved).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return; if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid transfer cleanup directory');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  view(job) {
    return { id: job.id, type: job.type, status: job.status, name: job.name, createdAt: job.createdAt, expiresAt: new Date(job.expires).toISOString(), received: job.received ?? 0, expectedBytes: job.expectedBytes, progress: job.progress, ...job.result, error: job.error, downloadUrl: job.type === 'export' && job.status === 'ready' ? `/api/settings/transfers/${job.id}/download` : undefined };
  }
  get(id, owner) { const job = this.jobs.get(id); if (!job || job.owner !== owner || job.expires <= Date.now()) throw new AppError(404, '작업이 없거나 만료되었습니다. 다시 시작해 주세요.'); return job; }
  list(owner) { return { jobs: [...this.jobs.values()].filter(job => job.owner === owner && job.expires > Date.now()).map(job => this.view(job)), limits: ARCHIVE_LIMITS }; }
  async create(type, owner, body) {
    if (!REQUEST.test(body.requestId ?? '')) throw new AppError(400, '작업 요청 식별자를 확인해 주세요.');
    const previous = [...this.jobs.values()].find(job => job.owner === owner && job.type === type && job.requestId === body.requestId && job.expires > Date.now());
    if (previous) return previous;
    if (this.closed || this.creating || [...this.jobs.values()].some(job => ACTIVE.has(job.status))) throw new AppError(409, '다른 데이터 작업을 처리 중입니다. 완료 후 다시 시도해 주세요.');
    if (type === 'import' && (typeof body.name !== 'string' || !body.name.toLowerCase().endsWith('.zip') || body.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(body.name) || !Number.isSafeInteger(body.bytes) || body.bytes < 22 || body.bytes > ARCHIVE_LIMITS.zipBytes)) throw new AppError(400, '8 GiB 이하의 ZIP 파일을 선택해 주세요.');
    this.creating = true;
    try {
      for (const job of [...this.jobs.values()]) if (job.type === type || job.expires <= Date.now()) await this.remove(job);
      const id = randomUUID(), createdAt = new Date().toISOString(), job = { id, owner, requestId: body.requestId, type, status: type === 'export' ? 'preparing' : 'uploading', createdAt, expires: Date.now() + WORK_TTL, directory: path.join(this.root, id), controller: new AbortController(), name: type === 'export' ? `${archiveDate(createdAt, this.branding.branding.timezone)}.zip` : body.name, expectedBytes: body.bytes };
      await fs.mkdir(job.directory, { mode: 0o700 }); this.jobs.set(id, job);
      if (type === 'export') job.promise = this.snapshot(job).then(() => this.work(job)).catch(error => this.failed(job, error));
      return job;
    } finally { this.creating = false; }
  }
  async snapshot(job) {
    const labels = await this.branding.read(); job.branding = labels.branding;
    await this.vault.serialize(async () => {
      this.vault.assertUnlocked(); job.controller.signal.throwIfAborted();
      const snapshot = path.join(job.directory, 'snapshot'); await fs.mkdir(snapshot, { mode: 0o700 });
      await linkCopy(this.vault.file, path.join(snapshot, 'store.json'));
      for (const ref of this.vault.daily?.refs() ?? []) {
        if (ref.kind === 'lookup') continue; job.controller.signal.throwIfAborted();
        if (!/^(events|events-open|audit|audit-active)$/.test(ref.kind) || !new RegExp(`^${ref.kind}/(?:\\d{4}-\\d{2}-\\d{2}|undated)\\.[0-9a-f-]{36}\\.json$`).test(ref.file)) throw Error('Invalid snapshot reference');
        await fs.mkdir(path.join(snapshot, ref.kind), { recursive: true, mode: 0o700 });
        await linkCopy(path.join(this.vault.directory, ref.file), path.join(snapshot, ref.file));
      }
    });
  }
  async work(job) {
    job.controller.signal.throwIfAborted(); this.vault.assertUnlocked();
    if (job.type === 'import') job.status = 'validating';
    const key = Buffer.from(this.vault.key);
    const worker = job.worker = new Worker(new URL('./archive-worker.mjs', import.meta.url), { workerData: { type: job.type, directory: job.directory, createdAt: job.createdAt, key, kdf: this.vault.envelope.kdf, branding: job.branding, versionStamp: Math.max(Date.now(), this.vault.state.revision + 1) }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    key.fill(0);
    await new Promise((resolve, reject) => {
      let result, failure;
      worker.on('message', message => { if (message.progress) job.progress = message.progress; if (message.result) result = message.result; if (message.error) failure = new AppError(400, message.error); });
      worker.on('error', error => { failure = error; });
      worker.once('exit', code => { job.worker = null; if (failure || code !== 0 || !result) reject(failure ?? Error('Data worker interrupted')); else { job.result = result; resolve(); } });
    });
    // Retention starts on completion, so processing time does not consume the 24 hours.
    if (job.type === 'export') {
      // Snapshot links are ciphertext and are removed with the job directory.
      job.branding = null;
    } else await fs.unlink(path.join(job.directory, 'upload.zip'));
    job.status = 'ready'; job.expires = Date.now() + READY_TTL;
  }
  async failed(job, error) {
    if (job.status === 'canceled') return;
    job.status = 'failed'; job.error = error instanceof AppError ? error.message : '데이터 작업을 완료하지 못했습니다. 서버의 남은 공간과 파일 권한을 확인해 주세요.'; job.expires = Date.now() + READY_TTL;
    await this.removeFiles(job.directory).catch(() => {});
  }
  async upload(job, req) {
    if (job.type !== 'import' || job.status !== 'uploading' || job.receiving) throw new AppError(409, '이미 업로드했거나 업로드할 수 없는 작업입니다.');
    if (!/^application\/(zip|octet-stream)(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'ZIP 파일을 업로드해 주세요.');
    if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== job.expectedBytes) throw new AppError(400, '선택한 파일의 크기가 일치하지 않습니다.');
    job.receiving = true; job.received = 0; req.setTimeout(120000);
    const count = new Transform({ transform(chunk, _encoding, callback) { job.received += chunk.length; callback(job.received > job.expectedBytes ? new AppError(413, '선택한 ZIP 파일 크기를 초과했습니다.') : null, chunk); } });
    try {
      job.io = pipeline(req, count, createWriteStream(path.join(job.directory, 'upload.zip'), { flags: 'wx', mode: 0o600 }), { signal: job.controller.signal });
      await job.io;
      if (job.received !== job.expectedBytes) throw new AppError(400, '파일 업로드가 완료되지 않았습니다. 다시 선택해 주세요.');
      job.promise = this.work(job).catch(error => this.failed(job, error));
      return this.view(job);
    } catch (error) { await this.failed(job, error); throw error; }
    finally { job.io = null; }
  }
  async download(job, res) {
    if (job.type !== 'export' || job.status !== 'ready') throw new AppError(409, '다운로드할 파일이 아직 준비되지 않았습니다.');
    job.downloads ??= new Set();
    if (job.downloads.size >= 2) throw new AppError(429, '이미 파일을 다운로드하고 있습니다. 잠시 후 다시 시도해 주세요.');
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), WORK_TTL); timer.unref();
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${job.name}"`, 'Content-Length': job.result.bytes, 'Cache-Control': 'no-store' });
    const pending = pipeline(createReadStream(path.join(job.directory, 'export.zip')), res, { signal: AbortSignal.any([job.controller.signal, timeout.signal]) }); job.downloads.add(pending);
    try { await pending; } finally { clearTimeout(timer); job.downloads.delete(pending); }
  }
  canRestore(job) {
    if (job.type !== 'import' || !['ready', 'restoring', 'completed'].includes(job.status)) throw new AppError(409, '검증이 완료된 ZIP 파일만 복원할 수 있습니다.');
    if ([...this.jobs.values()].some(other => other !== job && ACTIVE.has(other.status))) throw new AppError(409, '다른 데이터 작업이 끝난 후 복원해 주세요.');
  }
  restore(job, commit) {
    this.canRestore(job); if (['restoring', 'completed'].includes(job.status)) return this.view(job);
    job.status = 'restoring'; job.expires = Date.now() + WORK_TTL;
    job.promise = (async () => {
      try { const result = await commit(); job.result = { ...job.result, ...result }; job.status = 'completed'; job.expires = Date.now() + READY_TTL; await this.removeFiles(job.directory).catch(() => { job.result.warning = '데이터를 복원했습니다. 임시 파일은 서버 재시작 시 정리합니다.'; }); }
      catch (error) { await this.failed(job, error); }
    })();
    return this.view(job);
  }
  async remove(job) {
    if (job.status === 'restoring') throw new AppError(409, '적용 중인 복원은 취소할 수 없습니다.');
    job.status = 'canceled'; job.controller.abort();
    await job.worker?.terminate(); await Promise.allSettled([job.promise, job.io, ...(job.downloads ?? [])]);
    await this.removeFiles(job.directory); this.jobs.delete(job.id);
  }
  async clearOwner(owner) { for (const job of [...this.jobs.values()]) if (job.owner === owner && job.status !== 'restoring') await this.remove(job); }
  async clearExcept(id) { for (const job of [...this.jobs.values()]) if (job.id !== id) await this.remove(job); }
  async clear() { for (const job of [...this.jobs.values()]) await this.remove(job); }
  async expire() { for (const job of [...this.jobs.values()]) if (job.expires <= Date.now() && job.status !== 'restoring' && !job.downloads?.size) await this.remove(job); }
  async close() { this.closed = true; clearInterval(this.timer); for (const job of [...this.jobs.values()]) if (job.status !== 'restoring') await this.remove(job); for (const job of this.jobs.values()) if (job.status === 'restoring') await job.promise; await this.clear(); }
}
