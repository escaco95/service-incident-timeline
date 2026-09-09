import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ZipWriter, ZipReader, crc32 } from '../lib/archive-zip.mjs';

// Produced independently by System.IO.Compression.ZipArchive (Deflate).
const fixture = Buffer.from('UEsDBBQAAAAIAJc1Kl1Z4Z5ZEQAAAA8AAAANAAAAc2V0dGluZ3MuanNvbqtWykjNyclXslKK8gxQqgUAUEsBAhQAFAAAAAgAlzUqXVnhnlkRAAAADwAAAA0AAAAAAAAAAAAAAAAAAAAAAHNldHRpbmdzLmpzb25QSwUGAAAAAAEAAQA7AAAAPAAAAAAA', 'base64');
async function directory(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-zip-'));
  t.after(async () => { assert.equal(path.dirname(folder), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('timeline-zip-')); await fs.rm(folder, { recursive: true, force: true }); });
  return folder;
}
async function open(folder, bytes) { const file = path.join(folder, randomUUID() + '.zip'); await fs.writeFile(file, bytes); return new ZipReader().open(file); }
test('외부 ZIP·data descriptor·ZIP64 디렉터리를 읽고 CRC를 검증한다', async t => {
  const folder = await directory(t);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const endAt = fixture.length - 22, start = fixture.readUInt32LE(endAt + 16);
  const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(fixture.readUInt32LE(14), 4); descriptor.writeUInt32LE(fixture.readUInt32LE(18), 8); descriptor.writeUInt32LE(fixture.readUInt32LE(22), 12);
  const streamed = Buffer.concat([fixture.subarray(0, start), descriptor, fixture.subarray(start)]);
  streamed.writeUInt16LE(8, 6); streamed.fill(0, 14, 26); streamed.writeUInt16LE(8, start + 16 + 8); streamed.writeUInt32LE(start + 16, streamed.length - 6);
  const end64 = Buffer.alloc(56), locator = Buffer.alloc(20), end32 = Buffer.from(fixture.subarray(endAt));
  end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14); end64.writeBigUInt64LE(1n, 24); end64.writeBigUInt64LE(1n, 32); end64.writeBigUInt64LE(BigInt(endAt - start), 40); end64.writeBigUInt64LE(BigInt(start), 48);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(endAt), 8); locator.writeUInt32LE(1, 16); end32.writeUInt16LE(65535, 8); end32.writeUInt16LE(65535, 10); end32.writeUInt32LE(0xffffffff, 12); end32.writeUInt32LE(0xffffffff, 16);
  const wide = Buffer.concat([fixture.subarray(0, endAt), end64, locator, end32]);
  for (const bytes of [fixture, streamed, wide]) { const zip = await open(folder, bytes); try { assert.deepEqual(JSON.parse((await zip.get('settings.json')).toString()), { hello: 'ZIP' }); } finally { await zip.close(); } }
});

test('ZIP 경로 탈출·암호화·과도한 해제 크기·헤더 불일치·변조를 거부한다', async t => {
  const folder = await directory(t), endAt = fixture.length - 22, start = fixture.readUInt32LE(endAt + 16);
  const traversal = Buffer.from(fixture.toString('latin1').replaceAll('settings.json', '../state.json'), 'latin1');
  const encrypted = Buffer.from(fixture); encrypted.writeUInt16LE(1, 6); encrypted.writeUInt16LE(1, start + 8);
  const oversized = Buffer.from(fixture); oversized.writeUInt32LE(65 * 1024 ** 2, 22); oversized.writeUInt32LE(65 * 1024 ** 2, start + 24);
  const mismatch = Buffer.from(fixture); mismatch.writeUInt32LE(2, 18);
  for (const bytes of [traversal, encrypted, oversized, mismatch, fixture.subarray(0, -2), Buffer.concat([fixture, Buffer.from('extra')])]) await assert.rejects(open(folder, bytes), { status: 400 });
  const bomb = Buffer.from(fixture); bomb.writeUInt32LE(1, 22); bomb.writeUInt32LE(1, start + 24);
  const changed = Buffer.from(fixture); changed[50] ^= 1;
  for (const bytes of [bomb, changed]) { const zip = await open(folder, bytes); try { await assert.rejects(zip.get('settings.json'), { status: 400 }); } finally { await zip.close(); } }
});

test('만든 ZIP은 외부 표준 압축 라이브러리에서도 복호화된 JSON으로 열린다', async t => {
  const folder = await directory(t), file = path.join(folder, 'output.zip'), writer = await new ZipWriter().open(file);
  await writer.add('settings.json', Buffer.from(JSON.stringify({ label: '복원 데이터' }))); await writer.finish();
  const reader = await new ZipReader().open(file); try { assert.equal(JSON.parse((await reader.get('settings.json')).toString()).label, '복원 데이터'); } finally { await reader.close(); }
  if (process.platform === 'win32') {
    const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem\n$archiveReader = [System.IO.Compression.ZipFile]::OpenRead('${file.replaceAll("'", "''")}')\ntry { $entryReader = New-Object System.IO.StreamReader($archiveReader.GetEntry('settings.json').Open()); try { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($entryReader.ReadToEnd())) } finally { $entryReader.Dispose() } } finally { $archiveReader.Dispose() }`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    assert.deepEqual(JSON.parse(Buffer.from(stdout.trim(), 'base64').toString()), { label: '복원 데이터' });
  }
});
