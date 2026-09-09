import { readFile, open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './vault.mjs';

const DEFAULT_BRANDING = Object.freeze({ name: 'Service Timeline', subtitle: '서비스 운영 기록', showSubtitle: true, defaultTheme: 'light', timezone: 'UTC', passwordNotice: '' });
const versionOf = source => createHash('sha256').update(source).digest('hex');

async function readBranding(file) {
  let document, source;
  try {
    source = await readFile(file, 'utf8');
    document = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return { document: {}, config: DEFAULT_BRANDING, version: versionOf('missing') };
    throw new Error('브랜딩 설정 파일을 읽을 수 없습니다. BRANDING_FILE 경로와 JSON 형식을 확인해 주세요.');
  }
  return { document, config: validateBranding(document), version: versionOf(source) };
}

export function validateBranding(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new AppError(400, '브랜딩 설정은 name과 subtitle을 가진 JSON 객체여야 합니다.');
  }
  const name = typeof config.name === 'string' ? config.name.trim() : '';
  const subtitle = config.subtitle === undefined ? '' : typeof config.subtitle === 'string' ? config.subtitle.trim() : null;
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError(400, '서비스 이름은 줄바꿈 없이 1~64자로 입력해 주세요.');
  }
  if (subtitle === null || subtitle.length > 80 || /[\u0000-\u001f\u007f]/.test(subtitle)) {
    throw new AppError(400, '부제는 줄바꿈 없이 80자 이내로 입력해 주세요.');
  }
  if (config.showSubtitle !== undefined && typeof config.showSubtitle !== 'boolean') {
    throw new AppError(400, '부제 표시 여부는 true 또는 false로 입력해 주세요.');
  }
  const passwordNotice = config.passwordNotice === undefined ? '' : typeof config.passwordNotice === 'string' ? config.passwordNotice.trim() : null;
  if (passwordNotice === null || passwordNotice.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(passwordNotice)) {
    throw new AppError(400, '비밀번호 안내문은 2,000자 이내의 문장 또는 URL로 입력해 주세요.');
  }
  const defaultTheme = config.defaultTheme === undefined ? DEFAULT_BRANDING.defaultTheme : config.defaultTheme;
  if (!['light', 'dark'].includes(defaultTheme)) {
    throw new AppError(400, '기본 테마는 라이트 또는 다크로 선택해 주세요.');
  }
  const timezone = config.timezone === undefined ? 'UTC' : typeof config.timezone === 'string' ? config.timezone.trim() : '';
  try {
    if (!timezone || timezone.length > 100 || !/^[A-Za-z][A-Za-z0-9._+\/-]*$/.test(timezone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  } catch {
    throw new AppError(400, '표시 시간대는 UTC 또는 Asia/Seoul 같은 유효한 IANA 시간대 이름으로 입력해 주세요.');
  }
  return Object.freeze({ name, subtitle, showSubtitle: config.showSubtitle ?? true, defaultTheme, timezone, passwordNotice });
}

function publicBranding(config) {
  // Only these public settings can be returned to an unauthenticated browser.
  return Object.freeze({ name: config.name, subtitle: config.showSubtitle ? config.subtitle : '', defaultTheme: config.defaultTheme, timezone: config.timezone, passwordNotice: config.passwordNotice });
}

export async function loadBranding(file) {
  return publicBranding((await readBranding(file)).config);
}

export class BrandingStore {
  constructor(file) { this.file = path.resolve(file); this.queue = Promise.resolve(); }

  async open() { this.snapshot = await readBranding(this.file); return this; }
  get branding() { return publicBranding(this.snapshot.config); }

  reset() {
    return this.enqueue(async () => {
      await rm(this.file, { force: true });
      this.snapshot = await readBranding(this.file);
    });
  }

  replace(input) {
    return this.enqueue(async () => {
      const config = validateBranding(input), source = JSON.stringify(config, null, 2) + '\n';
      const temporary = path.join(path.dirname(this.file), `.branding-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        this.snapshot = { document: config, config, version: versionOf(source) };
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      return this.branding;
    });
  }

  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  read() {
    return this.enqueue(async () => {
      this.snapshot = await readBranding(this.file);
      return { branding: this.snapshot.config, version: this.snapshot.version };
    });
  }

  save(input) {
    return this.enqueue(async () => {
      const config = validateBranding(input.branding);
      if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw new AppError(400, '최신 설정을 불러온 뒤 다시 저장해 주세요.');
      const current = await readBranding(this.file);
      this.snapshot = current;
      if (input.version !== current.version) throw new AppError(409, '다른 화면이나 파일에서 설정이 변경되었습니다. 최신 설정을 불러온 뒤 다시 수정해 주세요.');
      // Keep unrelated file fields private and intact; the API can only edit known settings.
      const document = { ...current.document, ...config };
      const source = JSON.stringify(document, null, 2) + '\n';
      const temporary = path.join(path.dirname(this.file), `.branding-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(source, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
      } catch {
        throw new AppError(500, '브랜딩 설정을 저장하지 못했습니다. 서버의 설정 파일과 폴더 쓰기 권한을 확인해 주세요.');
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.snapshot = { document, config, version: versionOf(source) };
      return { branding: config, version: this.snapshot.version, publicBranding: this.branding };
    });
  }
}

export function brandingTitle(branding) {
  return branding.subtitle ? `${branding.name} · ${branding.subtitle}` : branding.name;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
