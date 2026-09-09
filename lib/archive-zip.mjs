// ZIP/ZIP64, stored and Deflate entries. Files are processed one partition at a time.
// Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
import * as fs from 'node:fs/promises';
import { deflateRaw, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

const deflate = promisify(deflateRaw), inflate = promisify(inflateRaw), U32 = 0xffffffff;
export const ARCHIVE_LIMITS = Object.freeze({ zipBytes: 8 * 1024 ** 3, expandedBytes: 32 * 1024 ** 3, entryBytes: 64 * 1024 ** 2, entries: 20000 });
const bad = () => { throw new AppError(400, '지원하는 형식의 올바른 데이터 ZIP 파일이 아닙니다.'); };
const table = Uint32Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
export function crc32(buffer) { let crc = U32; for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ U32) >>> 0; }
function safeName(name) { return typeof name === 'string' && /^[a-zA-Z0-9_/-]+\.json$/.test(name) && !name.startsWith('/') && !name.includes('//') && !name.split('/').some(part => ['.', '..'].includes(part)); }
const number64 = (buffer, offset) => { const value = buffer.readBigUInt64LE(offset); if (value > BigInt(Number.MAX_SAFE_INTEGER)) bad(); return Number(value); };
async function read(handle, size, position) {
  if (!Number.isSafeInteger(size) || size < 0 || size > ARCHIVE_LIMITS.entryBytes + 65536 || !Number.isSafeInteger(position) || position < 0) bad();
  const output = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const { bytesRead } = await handle.read(output, offset, size - offset, position + offset); if (!bytesRead) bad(); offset += bytesRead; }
  return output;
}

export class ZipWriter {
  async open(file) { this.handle = await fs.open(file, 'wx', 0o600); this.position = 0; this.entries = []; this.expanded = 0; return this; }
  async write(buffer) {
    if (this.position + buffer.length > ARCHIVE_LIMITS.zipBytes) throw new AppError(413, 'ZIP 파일은 최대 8 GiB까지 만들 수 있습니다.');
    let offset = 0;
    while (offset < buffer.length) { const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset, this.position); if (!bytesWritten) throw Error('Short ZIP write'); offset += bytesWritten; this.position += bytesWritten; }
  }
  async add(name, buffer) {
    if (!safeName(name) || this.entries.some(entry => entry.name === name) || this.entries.length >= ARCHIVE_LIMITS.entries) bad();
    if (buffer.length > ARCHIVE_LIMITS.entryBytes || this.expanded + buffer.length > ARCHIVE_LIMITS.expandedBytes) throw new AppError(413, '백업의 파일별 또는 전체 데이터 용량 한도를 초과했습니다.');
    const compressed = await deflate(buffer, { level: 6 }), bytes = Buffer.from(name), crc = crc32(buffer), offset = this.position;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(buffer.length, 22); header.writeUInt16LE(bytes.length, 26);
    await this.write(header); await this.write(bytes); await this.write(compressed);
    this.entries.push({ name, bytes, crc, size: buffer.length, compressed: compressed.length, offset }); this.expanded += buffer.length;
  }
  async finish() {
    const start = this.position;
    for (const entry of this.entries) {
      const wide = entry.offset >= U32, extra = Buffer.alloc(wide ? 12 : 0), header = Buffer.alloc(46);
      if (wide) { extra.writeUInt16LE(1); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(entry.offset), 4); }
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(45, 4); header.writeUInt16LE(wide ? 45 : 20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(33, 14);
      header.writeUInt32LE(entry.crc, 16); header.writeUInt32LE(entry.compressed, 20); header.writeUInt32LE(entry.size, 24); header.writeUInt16LE(entry.bytes.length, 28); header.writeUInt16LE(extra.length, 30); header.writeUInt32LE(wide ? U32 : entry.offset, 42);
      await this.write(header); await this.write(entry.bytes); await this.write(extra);
    }
    const size = this.position - start, count = this.entries.length, wide = start >= U32 || size >= U32 || count >= 65535;
    if (wide) {
      const offset = this.position, end = Buffer.alloc(56), locator = Buffer.alloc(20);
      end.writeUInt32LE(0x06064b50); end.writeBigUInt64LE(44n, 4); end.writeUInt16LE(45, 12); end.writeUInt16LE(45, 14); end.writeBigUInt64LE(BigInt(count), 24); end.writeBigUInt64LE(BigInt(count), 32); end.writeBigUInt64LE(BigInt(size), 40); end.writeBigUInt64LE(BigInt(start), 48);
      locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset), 8); locator.writeUInt32LE(1, 16); await this.write(end); await this.write(locator);
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(wide ? 65535 : count, 8); end.writeUInt16LE(wide ? 65535 : count, 10); end.writeUInt32LE(wide ? U32 : size, 12); end.writeUInt32LE(wide ? U32 : start, 16);
    await this.write(end); await this.handle.sync(); await this.close(); return this.position;
  }
  async close() { await this.handle?.close(); this.handle = null; }
}

export class ZipReader {
  async open(file) {
    this.handle = await fs.open(file, 'r');
    try {
      const stat = await this.handle.stat(); if (!stat.isFile() || stat.size < 22 || stat.size > ARCHIVE_LIMITS.zipBytes) bad();
      const tailOffset = Math.max(0, stat.size - 65557), tail = await read(this.handle, stat.size - tailOffset, tailOffset);
      let at = tail.length - 22;
      while (at >= 0 && (tail.readUInt32LE(at) !== 0x06054b50 || at + 22 + tail.readUInt16LE(at + 20) !== tail.length)) at--;
      if (at < 0 || tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6) || tail.readUInt16LE(at + 8) !== tail.readUInt16LE(at + 10)) bad();
      let count = tail.readUInt16LE(at + 10), size = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16), endOffset = tailOffset + at;
      if (count === 65535 || size === U32 || start === U32) {
        const locator = await read(this.handle, 20, endOffset - 20);
        if (locator.readUInt32LE() !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) bad();
        const offset = number64(locator, 8), end = await read(this.handle, 56, offset);
        if (end.readUInt32LE() !== 0x06064b50 || number64(end, 4) !== 44 || offset + 56 !== endOffset - 20 || end.readUInt32LE(16) || end.readUInt32LE(20) || number64(end, 24) !== number64(end, 32)) bad();
        count = number64(end, 32); size = number64(end, 40); start = number64(end, 48); endOffset = offset;
      }
      if (!count || count > ARCHIVE_LIMITS.entries || size > 16 * 1024 ** 2 || start + size !== endOffset) bad();
      this.entries = new Map(); const central = await read(this.handle, size, start); let position = 0, expanded = 0; const ranges = [];
      for (let index = 0; index < count; index++) {
        if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) bad();
        const h = central.subarray(position), flags = h.readUInt16LE(8), method = h.readUInt16LE(10), nameLength = h.readUInt16LE(28), extraLength = h.readUInt16LE(30), comment = h.readUInt16LE(32);
        if (flags & ~0x808 || ![0, 8].includes(method) || h.readUInt16LE(34) || position + 46 + nameLength + extraLength + comment > central.length || (h.readUInt32LE(38) >>> 16 & 0xf000) === 0xa000) bad();
        const name = h.subarray(46, 46 + nameLength).toString('utf8'); if (!safeName(name) || this.entries.has(name)) bad();
        let compressed = h.readUInt32LE(20), length = h.readUInt32LE(24), offset = h.readUInt32LE(42);
        const extra = h.subarray(46 + nameLength, 46 + nameLength + extraLength); let zip64 = null;
        for (let p = 0; p < extra.length;) { if (p + 4 > extra.length) bad(); const id = extra.readUInt16LE(p), bytes = extra.readUInt16LE(p + 2); if (p + 4 + bytes > extra.length) bad(); if (id === 1) { if (zip64) bad(); zip64 = extra.subarray(p + 4, p + 4 + bytes); } p += 4 + bytes; }
        let wideAt = 0;
        const wideValue = () => { if (!zip64 || wideAt + 8 > zip64.length) bad(); const value = number64(zip64, wideAt); wideAt += 8; return value; };
        if (length === U32) length = wideValue(); if (compressed === U32) compressed = wideValue(); if (offset === U32) offset = wideValue();
        expanded += length;
        if (length > ARCHIVE_LIMITS.entryBytes || compressed > ARCHIVE_LIMITS.entryBytes + 65536 || expanded > ARCHIVE_LIMITS.expandedBytes || offset + 30 > start) bad();
        const local = await read(this.handle, 30, offset), localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
        if (local.readUInt32LE() !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || (await read(this.handle, localNameLength, offset + 30)).toString('utf8') !== name) bad();
        const dataOffset = offset + 30 + localNameLength + localExtraLength, dataEnd = dataOffset + compressed;
        if (dataEnd > start || !compressed && length || method === 0 && compressed !== length) bad();
        if (!(flags & 8) && (local.readUInt32LE(14) !== h.readUInt32LE(16) || local.readUInt32LE(18) !== U32 && local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== U32 && local.readUInt32LE(22) !== length)) bad();
        let rangeEnd = dataEnd;
        if (flags & 8) {
          const descriptor = await read(this.handle, Math.min(24, start - dataEnd), dataEnd); const shift = descriptor.readUInt32LE() === 0x08074b50 ? 4 : 0;
          const wide = h.readUInt32LE(20) === U32 || h.readUInt32LE(24) === U32;
          if (descriptor.length < shift + (wide ? 20 : 12) || descriptor.readUInt32LE(shift) !== h.readUInt32LE(16) || (wide ? number64(descriptor, shift + 4) : descriptor.readUInt32LE(shift + 4)) !== compressed || (wide ? number64(descriptor, shift + 12) : descriptor.readUInt32LE(shift + 8)) !== length) bad();
          rangeEnd += shift + (wide ? 20 : 12);
        }
        ranges.push([offset, rangeEnd]); this.entries.set(name, { name, method, length, compressed, dataOffset, crc: h.readUInt32LE(16) }); position += 46 + nameLength + extraLength + comment;
      }
      if (position !== central.length) bad(); ranges.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < ranges.length; i++) if (ranges[i][0] !== (i ? ranges[i - 1][1] : 0)) bad();
      if (ranges.at(-1)[1] !== start) bad(); return this;
    } catch (error) { await this.close(); if (error instanceof AppError) throw error; bad(); }
  }
  async get(name) {
    try {
      const entry = this.entries.get(name); if (!entry) bad();
      const bytes = await read(this.handle, entry.compressed, entry.dataOffset), output = entry.method === 8 ? await inflate(bytes, { maxOutputLength: Math.max(1, entry.length) }) : bytes;
      if (output.length !== entry.length || crc32(output) !== entry.crc) bad(); return output;
    } catch (error) { if (error instanceof AppError) throw error; bad(); }
  }
  async close() { await this.handle?.close(); this.handle = null; }
}
