import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ZipWriter, ZipReader, ARCHIVE_LIMITS } from './archive-zip.mjs';
import { encryptState, decryptState } from './vault.mjs';
import { DailyStorage } from './daily-storage.mjs';
import { RECORD_FIELDS, partitionRecords, entriesFor, lookupKey, entryKey, summarize } from './daily-index.mjs';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, exportedSettings, validateSettings, validateManifest, validateRecords } from './archive-data.mjs';
import { AppError } from './errors.mjs';

const key = Buffer.from(workerData.key), directory = workerData.directory;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const progress = (phase, done, total) => parentPort.postMessage({ progress: { phase, done, total } });
const readJSON = async file => { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > ARCHIVE_LIMITS.entryBytes) throw new AppError(400, '데이터 파일 용량 한도를 초과했습니다.'); return JSON.parse(await fs.readFile(file, 'utf8')); };

async function exportArchive() {
  const snapshot = path.join(directory, 'snapshot'), state = decryptState(await readJSON(path.join(snapshot, 'store.json')), key);
  const metadata = state.dailyStorageVersion ? state.metadata : state;
  const settings = validateSettings(exportedSettings(metadata, workerData.branding));
  const files = [], counts = Object.fromEntries(RECORD_FIELDS.map(field => [field, 0]));
  const writer = await new ZipWriter().open(path.join(directory, 'export.zip'));
  const add = async (name, data) => { const bytes = encode(data); await writer.add(name, bytes); files.push({ name, bytes: bytes.length, sha256: hash(bytes) }); };
  try {
    await add('settings.json', settings);
    const daily = new DailyStorage(snapshot); daily.decode = (envelope, scope) => decryptState(envelope, key, scope);
    const parts = state.dailyStorageVersion ? state.files.filter(ref => ref.kind !== 'lookup').map(ref => ({ key: `${ref.kind}/${ref.day}`, ref })) : [...partitionRecords(state)].map(([key, bucket]) => ({ key, data: bucket.data }));
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], data = part.ref ? await daily.readBucket(part.ref) : part.data;
      validateRecords(data, part.key, settings);
      for (const field of RECORD_FIELDS) counts[field] += data[field]?.length ?? 0;
      await add(`data/${part.key}.json`, data); progress('exporting', i + 1, parts.length);
    }
    const manifest = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: workerData.createdAt, files, counts };
    await writer.add('manifest.json', encode(manifest));
    return { bytes: await writer.finish(), counts, createdAt: manifest.createdAt };
  } finally { await writer.close(); }
}

async function importArchive() {
  const reader = await new ZipReader().open(path.join(directory, 'upload.zip'));
  const staged = path.join(directory, 'prepared'), spool = path.join(directory, 'index');
  await fs.mkdir(staged, { mode: 0o700 }); await fs.mkdir(spool, { mode: 0o700 });
  try {
    const manifest = validateManifest(JSON.parse((await reader.get('manifest.json')).toString('utf8')), reader.entries);
    const get = async name => {
      const descriptor = manifest.files.find(file => file.name === name), bytes = await reader.get(name);
      if (!descriptor || hash(bytes) !== descriptor.sha256) throw new AppError(400, 'ZIP 파일의 데이터가 변경되었거나 손상되었습니다.');
      return JSON.parse(bytes.toString('utf8'));
    };
    const settings = validateSettings(await get('settings.json'));
    const counts = Object.fromEntries(RECORD_FIELDS.map(field => [field, 0])), refs = [], indexFiles = new Set(), runsByDay = {};
    const writeBucket = async (kind, day, data) => {
      const bytes = encode(data), summary = summarize(data), file = `${kind}/${day}.${randomUUID()}.json`, encrypted = encode(encryptState(data, key, workerData.kdf, { kind, day }));
      if (encrypted.length > ARCHIVE_LIMITS.entryBytes) throw new AppError(413, '복원할 날짜별 데이터 또는 조회 인덱스가 64 MiB 한도를 초과했습니다.');
      await fs.mkdir(path.join(staged, kind), { recursive: true, mode: 0o700 });
      const handle = await fs.open(path.join(staged, file), 'wx', 0o600);
      try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
      refs.push({ kind, day, file, hash: hash(bytes), summary, count: summary.count ?? Object.values(summary.counts).reduce((a, b) => a + b, 0) });
    };
    const parts = manifest.files.filter(file => file.name.startsWith('data/'));
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i].name, partition = name.slice(5, -5), data = await get(name);
      validateRecords(data, partition, settings);
      for (const event of data.events ?? []) event.version = workerData.versionStamp;
      for (const run of data.workflowRuns ?? []) { const day = run.createdAt.slice(0, 10); if ((runsByDay[day] = (runsByDay[day] ?? 0) + 1) > 10000) throw new AppError(400, '하루 워크플로우 실행 기록 한도를 초과했습니다.'); }
      for (const field of RECORD_FIELDS) counts[field] += data[field]?.length ?? 0;
      await writeBucket(...partition.split('/'), data);
      const groups = new Map();
      for (const entry of entriesFor(data, partition)) { const name = lookupKey(entry.field, entry.key).slice(7); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(JSON.stringify(entry)); }
      for (const [name, lines] of groups) {
        const file = path.join(spool, name); await fs.appendFile(file, lines.join('\n') + '\n', { mode: 0o600 }); indexFiles.add(name);
        if ((await fs.stat(file)).size > ARCHIVE_LIMITS.entryBytes) throw new AppError(413, '조회 인덱스 용량 한도를 초과했습니다.');
      }
      progress('validating', i + 1, parts.length + 256);
    }
    for (const field of RECORD_FIELDS) if (counts[field] !== manifest.counts[field]) throw new AppError(400, 'ZIP 파일의 기록 개수가 일치하지 않습니다.');
    let done = parts.length;
    for (const name of [...indexFiles].sort()) {
      const entries = (await fs.readFile(path.join(spool, name), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)), seen = new Set();
      for (const entry of entries) { const id = entryKey(entry); if (seen.has(id)) throw new AppError(400, '서로 다른 날짜에 중복된 기록 ID 또는 실행 요청 ID가 있습니다.'); seen.add(id); }
      entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b))); await writeBucket('lookup', name, { entries }); await fs.unlink(path.join(spool, name));
      progress('indexing', ++done, parts.length + indexFiles.size);
    }
    const metadata = settings.metadata; metadata.revision = workerData.versionStamp; metadata.updatedAt = new Date().toISOString(); metadata.catalog.version = workerData.versionStamp;
    for (const flow of metadata.workflows) { flow.version = workerData.versionStamp; }
    if (metadata.logPolicy) metadata.logPolicy.version = workerData.versionStamp;
    const envelope = encryptState({ dailyStorageVersion: 2, metadata, files: refs, garbage: [] }, key, workerData.kdf);
    const handle = await fs.open(path.join(staged, 'store.json'), 'wx', 0o600);
    try { const bytes = encode(envelope); if (bytes.length > ARCHIVE_LIMITS.entryBytes) throw new AppError(413, '관리 파일 용량 한도를 초과했습니다.'); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.writeFile(path.join(staged, 'branding.json'), JSON.stringify(settings.branding), { flag: 'wx', mode: 0o600 });
    return { counts: { ...counts, workflows: metadata.workflows.filter(flow => !flow.deletedAt).length, services: metadata.catalog.services.length }, createdAt: manifest.createdAt, bytes: (await fs.stat(path.join(directory, 'upload.zip'))).size };
  } finally { await reader.close(); }
}

try { parentPort.postMessage({ result: await (workerData.type === 'export' ? exportArchive() : importArchive()) }); }
catch (error) { parentPort.postMessage({ error: error instanceof AppError ? error.message : '데이터 파일을 처리하지 못했습니다. ZIP 형식과 서버의 남은 디스크 공간을 확인해 주세요.' }); }
finally { key.fill(0); workerData.key.fill(0); parentPort.close(); }
