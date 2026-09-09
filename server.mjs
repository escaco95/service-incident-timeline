import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, AppError } from './lib/vault.mjs';
import { BrandingStore, brandingTitle, escapeHtml } from './lib/branding.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/date-utils.js', ['date-utils.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const SESSION_AGE = 8 * 60 * 60 * 1000;

export async function createApp(options = {}) {
  const brandingStore = await new BrandingStore(options.brandingFile ?? path.join(ROOT, 'branding.json')).open();
  const vault = await new Vault(options.dataDir ?? path.join(ROOT, 'data')).open();
  const sessions = new Map();
  const attempts = new Map();
  const cookieSecure = options.cookieSecure ?? Boolean(options.tls);
  const cookieName = 'timeline_session';
  let authBusy = false;
  let closing = false;

  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }

  function session(req) {
    const token = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const expires = sessions.get(token);
    if (!expires || expires <= Date.now() || !vault.unlocked) { if (token) sessions.delete(token); return null; }
    return token;
  }

  function setCookie(res, token, age = SESSION_AGE / 1000) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${cookieSecure ? '; Secure' : ''}`);
  }

  async function json(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'JSON 형식으로 요청해 주세요.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32 * 1024) throw new AppError(413, '요청 내용이 너무 큽니다.');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError(400, '잘못된 JSON 요청입니다.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '잘못된 요청입니다.');
    return body;
  }

  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (closing) throw new AppError(503, '서버가 종료 중입니다.');
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && ASSETS.has(pathname)) {
        const [file, type] = ASSETS.get(pathname);
        let content = await readFile(path.join(ROOT, 'public', file));
        if (file === 'index.html') {
          content = content.toString('utf8')
            .replace('{{APP_TITLE}}', () => escapeHtml(brandingTitle(brandingStore.branding)))
            .replace('{{DEFAULT_THEME}}', () => brandingStore.branding.defaultTheme);
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && pathname === '/api/branding') return send(res, 200, brandingStore.branding);
      if (req.method === 'GET' && pathname === '/api/status') {
        return send(res, 200, { initialized: vault.initialized, authenticated: Boolean(session(req)), unlocked: vault.unlocked });
      }
      if (!pathname.startsWith('/api/')) throw new AppError(404, '페이지를 찾을 수 없습니다.');
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new AppError(405, '지원하지 않는 요청입니다.');
      if (req.method !== 'GET') {
        const expected = options.publicOrigin ?? `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (!req.headers.origin || req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new AppError(403, '허용되지 않은 출처의 요청입니다.');
        }
      }
      if (req.method === 'POST' && ['/api/setup', '/api/login'].includes(pathname)) {
        const peer = req.socket.remoteAddress;
        const now = Date.now();
        let attempt = attempts.get(peer);
        if (!attempt || attempt.until <= now) { attempt = { count: 0, until: now + 5 * 60 * 1000 }; attempts.set(peer, attempt); }
        if (attempt.count >= 10 || authBusy) {
          res.setHeader('Retry-After', authBusy ? '2' : String(Math.ceil((attempt.until - now) / 1000)));
          throw new AppError(429, authBusy ? '다른 로그인 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.' : '로그인 시도가 많습니다. 5분 후 다시 시도해 주세요.');
        }
        const body = await json(req);
        if (authBusy) throw new AppError(429, '로그인 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
        authBusy = true;
        attempt.count += 1;
        try {
          if (pathname === '/api/setup') await vault.setup(body.password);
          else await vault.unlock(body.password);
          sessions.delete(session(req));
          const token = randomBytes(32).toString('base64url');
          sessions.set(token, Date.now() + SESSION_AGE);
          setCookie(res, token);
          attempts.delete(peer);
          return send(res, 200, { ok: true });
        } finally { body.password = null; authBusy = false; }
      }
      const token = session(req);
      if (!token) throw new AppError(401, '로그인이 필요합니다.');
      if (pathname === '/api/settings/branding') {
        if (req.method === 'GET') return send(res, 200, await brandingStore.read());
        if (req.method === 'PUT') return send(res, 200, await brandingStore.save(await json(req)));
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        sessions.delete(token);
        setCookie(res, '', 0);
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/events') {
        if (req.method === 'GET') return send(res, 200, vault.read());
        if (req.method === 'POST') return send(res, 201, await vault.add(await json(req)));
      }
      const match = /^\/api\/events\/([0-9a-f-]{36})$/.exec(pathname);
      if (match) {
        const body = await json(req);
        if (req.method === 'PUT') return send(res, 200, await vault.update(match[1], body));
        if (req.method === 'DELETE') return send(res, 200, await vault.remove(match[1], body.version));
      }
      throw new AppError(404, '요청을 찾을 수 없습니다.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Do not log request bodies, event data, passwords, keys or crypto errors.
      send(res, error.status ?? 500, { error: error.status ? error.message : '저장 또는 처리에 실패했습니다. 원본 데이터는 초기화하지 않았습니다.' });
    }
  };

  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
    for (const [peer, attempt] of attempts) if (attempt.until <= now) attempts.delete(peer);
  }, 60_000);
  maintenance.unref();

  return {
    server, vault, get branding() { return brandingStore.branding; },
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(maintenance);
      sessions.clear();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await brandingStore.queue;
      await vault.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) throw new Error('TLS_CERT와 TLS_KEY를 함께 지정해 주세요.');
    const tls = process.env.TLS_CERT ? { cert: await readFile(process.env.TLS_CERT), key: await readFile(process.env.TLS_KEY) } : undefined;
    const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : undefined;
    if (publicOrigin && !/^https?:\/\//.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN은 http 또는 https 주소여야 합니다.');
    app = await createApp({
      dataDir: process.env.DATA_DIR || undefined, brandingFile: process.env.BRANDING_FILE || undefined, tls, publicOrigin,
      cookieSecure: process.env.COOKIE_SECURE === 'true' || Boolean(tls) || publicOrigin?.startsWith('https:')
    });
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535여야 합니다.');
    const host = process.env.HOST || '127.0.0.1';
    await app.listen(port, host);
    console.log(`${app.branding.name}: ${tls ? 'https' : 'http'}://${host}:${port}`);
    console.log('암호화 키는 웹 화면에서 입력합니다. 종료: Ctrl+C');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    console.error(error.message);
    if (app) await app.close();
    process.exitCode = 1;
  }
}
