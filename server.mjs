import http from 'node:http';
import https from 'node:https';
import { importWorkflow, exportWorkflow, fileSchema } from './lib/workflow-file.mjs';
import { LIMITS } from './public/workflow-spec.js';
import { Workflows } from './lib/workflows.mjs';
import { WorkflowEngine } from './lib/workflow-engine.mjs';
import { LogMaintenance } from './lib/log-maintenance.mjs';
import { RESET_TARGETS, resetData, hasPendingSystemReset, beginSystemReset, finishSystemReset } from './lib/reset.mjs';
import { enrollSetupMarker, operatorResetRequested } from './lib/setup-marker.mjs';
import { DataTransfers } from './lib/data-transfers.mjs';
import { hasPendingRestore, completeRestore, publishRestore } from './lib/restore-journal.mjs';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, AppError, checkPassword, recordChange } from './lib/vault.mjs';
import { BrandingStore, brandingTitle, escapeHtml, validateBranding } from './lib/branding.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/random-id.js', ['random-id.js', 'text/javascript; charset=utf-8']],
  ['/services-ui.js', ['services-ui.js', 'text/javascript; charset=utf-8']],
  ['/log-policy-ui.js', ['log-policy-ui.js', 'text/javascript; charset=utf-8']],
  ['/danger-zone-ui.js', ['danger-zone-ui.js', 'text/javascript; charset=utf-8']],
  ['/data-transfer-ui.js', ['data-transfer-ui.js', 'text/javascript; charset=utf-8']],
  ['/audit-ui.js', ['audit-ui.js', 'text/javascript; charset=utf-8']],
  ['/event-loader.js', ['event-loader.js', 'text/javascript; charset=utf-8']],
  ['/audit.css', ['audit.css', 'text/css; charset=utf-8']],
  ['/workflow-spec.js', ['workflow-spec.js', 'text/javascript; charset=utf-8']],
  ['/workflow-file-ui.js', ['workflow-file-ui.js', 'text/javascript; charset=utf-8']],
  ['/workflow-ui.js', ['workflow-ui.js', 'text/javascript; charset=utf-8']],
  ['/workflow.css', ['workflow.css', 'text/css; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/date-utils.js', ['date-utils.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const SESSION_AGE = 8 * 60 * 60 * 1000;

export async function createApp(options = {}) {
  const brandingStore = new BrandingStore(options.brandingFile ?? path.join(ROOT, 'branding.json'));
  const vault = await new Vault(options.dataDir ?? path.join(ROOT, 'data')).open();
  try {
    if (await hasPendingSystemReset(vault)) await finishSystemReset(vault, brandingStore);
    else {
      await enrollSetupMarker(vault);
      if (await operatorResetRequested(vault)) { await beginSystemReset(vault); await finishSystemReset(vault, brandingStore); }
      else if (await hasPendingRestore(vault)) await completeRestore(vault, brandingStore);
    }
    await brandingStore.open();
  }
  catch (error) { await vault.close(); throw error; }
  const workflows = new Workflows(vault, options.workflows);
  const workflowEngine = new WorkflowEngine(vault, options.workflows);
  const logMaintenance = new LogMaintenance(vault, { ...options.logMaintenance, timezone: () => brandingStore.branding.timezone });
  let transfers;
  try { transfers = await new DataTransfers(vault, brandingStore).open(); }
  catch (error) { await logMaintenance.close(); await workflowEngine.close(); await vault.close(); throw error; }
  const sessions = new Map();
  const attempts = new Map();
  const cookieSecure = options.cookieSecure ?? Boolean(options.tls);
  const cookieName = 'timeline_session';
  let authBusy = false;
  let closing = false;
  let resetBusy = false, resetIncomplete = false, restoreIncomplete = false;
  const resetAttempts = new Map(), activeRequests = new Set();
  let markerCheck = null;
  function checkSetupMarker() {
    if (markerCheck) return markerCheck;
    if (closing || resetBusy || authBusy || resetIncomplete || restoreIncomplete) return Promise.resolve();
    markerCheck = (async () => {
      const requested = await operatorResetRequested(vault);
      if (!requested || closing || resetBusy || authBusy) return;
      resetBusy = true;
      try {
        await beginSystemReset(vault);
        await transfers.clear();
        await Promise.all([Promise.all([...activeRequests]), workflowEngine.pause(true), logMaintenance.pause()]);
        await transfers.clear();
        await finishSystemReset(vault, brandingStore);
        sessions.clear(); attempts.clear(); resetAttempts.clear(); resetIncomplete = false;
        workflowEngine.resume(true); logMaintenance.resume(true);
      } catch {
        resetIncomplete = await hasPendingSystemReset(vault);
        throw new AppError(503, '설정 완료 파일 삭제에 따른 초기화를 완료하지 못했습니다. 파일 권한을 확인한 뒤 서버를 재시작해 주세요.');
      } finally { resetBusy = false; }
    })().finally(() => { markerCheck = null; });
    return markerCheck;
  }

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

  async function json(req, limit = 256 * 1024) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'JSON 형식으로 요청해 주세요.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new AppError(413, '요청 내용이 너무 큽니다.');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError(400, '잘못된 JSON 요청입니다.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '잘못된 요청입니다.');
    return body;
  }

  const handler = async (req, res) => {
    let releaseRequest;
    req.setTimeout(30000);
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
      const transferMatch = /^\/api\/settings\/transfers\/([0-9a-f-]{36})(?:\/(upload|download|restore))?$/.exec(pathname);
      const transferStatus = req.method === 'GET' && (pathname === '/api/settings/transfers' || transferMatch && !transferMatch[2]);
      if (pathname === '/' || pathname.startsWith('/api/')) await checkSetupMarker();
      if (resetIncomplete && ['/api/status', '/api/branding'].includes(pathname)) throw new AppError(503, '시스템 초기화를 완료하지 못했습니다. 파일 권한을 확인하고 서버를 재시작해 주세요.');
      if (restoreIncomplete && !transferStatus) throw new AppError(503, '데이터 복원 적용이 중단되었습니다. 파일 권한과 남은 공간을 확인하고 서버를 재시작하면 복원을 완료합니다.');
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
      if (resetBusy && !transferStatus || (resetIncomplete && pathname !== '/api/settings/reset')) throw new AppError(503, '데이터 초기화 또는 복원 처리 중입니다. 잠시 후 다시 시도해 주세요.');
      if (pathname !== '/api/settings/reset' && !(transferMatch?.[2] === 'restore' && req.method === 'POST')) {
        const pending = new Promise(resolve => { releaseRequest = () => { activeRequests.delete(pending); resolve(); }; });
        activeRequests.add(pending);
      }
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
          if (pathname === '/api/setup') {
            if (vault.initialized) throw new AppError(409, '이미 설정된 서비스입니다. 로그인해 주세요.');
            checkPassword(body.password);
            if (body.passwordNotice !== undefined) {
              const current = await brandingStore.read();
              const branding = validateBranding({ ...current.branding, passwordNotice: body.passwordNotice });
              // Save the optional public notice before initialization so a settings write
              // failure leaves the setup form retryable. Omitted/unchanged notices need no write.
              if (branding.passwordNotice !== current.branding.passwordNotice) {
                await brandingStore.save({ branding, version: current.version });
              }
            }
            await vault.setup(body.password);
          } else await vault.unlock(body.password);
          await workflowEngine.unlock().catch(() => { workflowEngine.fault = '이전 실행 상태를 저장하지 못했습니다. 일정은 사용할 수 있으며 자동 실행은 저장소 확인 후 서버를 재시작해 주세요.'; });
          sessions.delete(session(req));
          const token = randomBytes(32).toString('base64url');
          sessions.set(token, Date.now() + SESSION_AGE);
          setCookie(res, token);
          attempts.delete(peer);
          return send(res, 200, { ok: true, publicBranding: brandingStore.branding });
        } finally { body.password = null; authBusy = false; }
      }
      const token = session(req);
      if (!token) throw new AppError(401, '로그인이 필요합니다.');
      if (pathname === '/api/settings/transfers' && req.method === 'GET') return send(res, 200, transfers.list(token));
      if (req.method === 'POST' && ['/api/settings/transfers/export', '/api/settings/transfers/import'].includes(pathname)) {
        const job = await transfers.create(pathname.endsWith('/export') ? 'export' : 'import', token, await json(req));
        return send(res, 202, transfers.view(job));
      }
      if (transferMatch) {
        const job = transfers.get(transferMatch[1], token), action = transferMatch[2];
        if (!action && req.method === 'GET') return send(res, 200, transfers.view(job));
        if (!action && req.method === 'DELETE') { await transfers.remove(job); return send(res, 200, { ok: true }); }
        if (action === 'upload' && req.method === 'PUT') return send(res, 202, await transfers.upload(job, req));
        if (action === 'download' && req.method === 'GET') { await transfers.download(job, res); return; }
        if (action === 'restore' && req.method === 'POST') {
          const body = await json(req), peer = req.socket.remoteAddress, now = Date.now();
          transfers.canRestore(job);
          if (job.status === 'completed' || job.status === 'restoring') return send(res, 202, transfers.view(job));
          if (resetBusy || body.confirmed !== true) throw new AppError(409, '복원 확인 여부와 진행 중인 작업을 확인해 주세요.');
          let attempt = resetAttempts.get(peer);
          if (!attempt || attempt.until <= now) { attempt = { count: 0, until: now + 300000 }; resetAttempts.set(peer, attempt); }
          if (attempt.count >= 5) throw new AppError(429, '비밀번호 확인 시도가 많습니다. 5분 후 다시 시도해 주세요.');
          resetBusy = true;
          try {
            attempt.count++; await vault.verifyPassword(body.password); body.password = null; resetAttempts.delete(peer);
            if (!session(req)) throw new AppError(401, '로그인이 필요합니다.');
            const result = transfers.restore(job, async () => {
              try {
                await transfers.clearExcept(job.id);
                await Promise.all([...activeRequests]);
                if (!session(req)) throw new AppError(401, '로그인이 만료되어 복원을 적용하지 않았습니다. 다시 로그인해 주세요.');
                await Promise.all([workflowEngine.pause(true), logMaintenance.pause()]);
                const publicBranding = await vault.serialize(() => publishRestore(vault, brandingStore, path.join(job.directory, 'prepared')));
                sessions.clear(); sessions.set(token, Date.now() + SESSION_AGE); attempts.clear(); resetAttempts.clear();
                workflowEngine.resume(true); logMaintenance.resume(true);
                let warning;
                try {
                  await workflowEngine.unlock();
                  await vault.mutate(state => recordChange(state, 'data-restored', null, { archiveCreatedAt: job.result.createdAt, counts: job.result.counts }), { scope: {} });
                } catch { warning = '데이터를 복원했지만 실행 상태 또는 복원 감사 기록을 마무리하지 못했습니다. 서버를 재시작해 확인해 주세요.'; workflowEngine.fault = warning; }
                return { target: 'restore', publicBranding, warning };
              } catch (error) {
                restoreIncomplete = await hasPendingRestore(vault);
                if (restoreIncomplete) throw new AppError(503, '복원 적용이 중단되었습니다. 파일 권한과 남은 공간을 확인하고 서버를 재시작하면 완료합니다.');
                throw error;
              } finally { if (!restoreIncomplete) { workflowEngine.resume(); logMaintenance.resume(); } resetBusy = false; }
            });
            return send(res, 202, result);
          } catch (error) { resetBusy = false; throw error; }
          finally { body.password = null; }
        }
      }
      if (pathname === '/api/settings/reset' && req.method === 'POST') {
        const body = await json(req), peer = req.socket.remoteAddress, now = Date.now();
        if (resetBusy) throw new AppError(409, '다른 초기화를 처리 중입니다.');
        if (!RESET_TARGETS.includes(body.target) || body.confirmed !== true || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw new AppError(400, '초기화 대상과 확인 여부를 확인해 주세요.');
        let attempt = resetAttempts.get(peer);
        if (!attempt || attempt.until <= now) { attempt = { count: 0, until: now + 300000 }; resetAttempts.set(peer, attempt); }
        if (attempt.count >= 5) { res.setHeader('Retry-After', String(Math.ceil((attempt.until - now) / 1000))); throw new AppError(429, '비밀번호 확인 시도가 많습니다. 5분 후 다시 시도해 주세요.'); }
        resetBusy = true;
        try {
          attempt.count++;
          await vault.verifyPassword(body.password); body.password = null; resetAttempts.delete(peer);
          await transfers.clear();
          await Promise.all([...activeRequests]);
          await transfers.clear();
          if (!session(req)) throw new AppError(401, '로그인이 필요합니다.');
          let result;
          if (resetIncomplete) {
            if (body.target !== 'system') throw new AppError(409, '미완료 시스템 초기화를 먼저 완료해 주세요.');
            await finishSystemReset(vault, brandingStore); workflowEngine.resume(true); logMaintenance.resume(true);
            result = { ok: true, target: 'system', initialized: false, publicBranding: brandingStore.branding };
          } else result = await resetData({ vault, branding: brandingStore, engine: workflowEngine, maintenance: logMaintenance }, body.target, body.requestId);
          if (body.target === 'system') { resetIncomplete = false; sessions.clear(); attempts.clear(); setCookie(res, '', 0); }
          return send(res, 200, result);
        } catch (error) {
          if (await hasPendingSystemReset(vault)) { resetIncomplete = true; throw new AppError(503, '시스템 초기화가 아직 완료되지 않았습니다. 같은 비밀번호로 다시 시도해 주세요. 서버 재시작 시에도 정리를 이어서 처리합니다.'); }
          throw error;
        } finally { body.password = null; resetBusy = false; }
      }
      if (pathname === '/api/workflows/validate' && req.method === 'POST') return send(res, 200, importWorkflow(await json(req, LIMITS.bytes)));
      if (pathname === '/api/workflow-schema' && req.method === 'GET') return send(res, 200, fileSchema());
      if (pathname === '/api/workflow-services' && req.method === 'GET') return send(res, 200, { services: workflows.serviceStates() });
      if (pathname === '/api/workflow-services/resolve' && req.method === 'POST') return send(res, 200, await workflows.resolveService(await json(req)));
      if (pathname === '/api/workflows') {
        if (req.method === 'GET') return send(res, 200, { ...workflows.list(), engine: workflowEngine.status() });
        if (req.method === 'POST') return send(res, 201, await workflows.create(await json(req, LIMITS.bytes + 256 * 1024)));
      }
      const workflow = /^\/api\/workflows\/([0-9a-f-]{36})(?:\/(enabled|run|export))?$/.exec(pathname);
      if (workflow) {
        const id = workflow[1], action = workflow[2];
        if (action === 'export' && req.method === 'GET') { const file = exportWorkflow(workflows.read(id)); res.setHeader('Content-Disposition', 'attachment; filename=workflow-' + id + '.json'); return send(res, 200, file); }
        if (!action && req.method === 'GET') return send(res, 200, workflows.read(id));
        if (!action && req.method === 'PUT') return send(res, 200, await workflows.save(id, await json(req, LIMITS.bytes + 256 * 1024)));
        if (!action && req.method === 'DELETE') { const result = await workflows.remove(id, await json(req)); workflowEngine.stopWorkflow(id); return send(res, 200, result); }
        if (action === 'enabled' && req.method === 'PUT') return send(res, 200, await workflows.enable(id, await json(req)));
        if (action === 'run' && req.method === 'POST') {
          if (workflowEngine.fault) throw new AppError(503, workflowEngine.fault);
          const run = await workflows.run(id, await json(req)); workflowEngine.wake(); return send(res, 202, run);
        }
      }
      const workflowRun = /^\/api\/workflow-runs\/([0-9a-f-]{36})(?:\/(rerun|cancel|reevaluate))?$/.exec(pathname);
      if (workflowRun) {
        const id = workflowRun[1], action = workflowRun[2];
        if (!action && req.method === 'GET') return send(res, 200, await workflows.readRun(id));
        if (action === 'reevaluate' && req.method === 'POST') { if (workflowEngine.fault) throw new AppError(503, workflowEngine.fault); const run = await workflows.reevaluate(id, await json(req)); workflowEngine.wake(); return send(res, 202, run); }
        if (action === 'rerun' && req.method === 'POST') {
          if (workflowEngine.fault) throw new AppError(503, workflowEngine.fault);
          const run = await workflows.rerun(id, await json(req)); workflowEngine.wake(); return send(res, 202, run);
        }
        if (action === 'cancel' && req.method === 'POST') { const run = await workflows.cancel(id); workflowEngine.stop(id); return send(res, 200, run); }
      }
      if (req.method === 'GET' && pathname === '/api/audit') return send(res, 200, await vault.audit(new URL(req.url, 'http://localhost').searchParams));
      if (pathname === '/api/settings/branding') {
        if (req.method === 'GET') return send(res, 200, await brandingStore.read());
        if (req.method === 'PUT') return send(res, 200, await brandingStore.save(await json(req)));
      }
      if (pathname === '/api/settings/log-policy') {
        if (req.method === 'GET') return send(res, 200, logMaintenance.read());
        if (req.method === 'PUT') return send(res, 200, await logMaintenance.save(await json(req)));
      }
      if (pathname === '/api/services') {
        if (req.method === 'GET') return send(res, 200, vault.readServices());
        if (req.method === 'PUT') return send(res, 200, await vault.saveServices(await json(req)));
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        await transfers.clearOwner(token);
        sessions.delete(token);
        setCookie(res, '', 0);
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/events') {
        if (req.method === 'GET') return send(res, 200, await vault.read(new URL(req.url, 'http://localhost').searchParams));
        if (req.method === 'POST') return send(res, 201, await vault.add(await json(req)));
      }
      const match = /^\/api\/events\/([0-9a-f-]{36})$/.exec(pathname);
      if (match) {
        if (req.method === 'GET') return send(res, 200, { event: await vault.getRecord('events', match[1]), revision: vault.state.revision });
        const body = await json(req);
        if (req.method === 'PUT') return send(res, 200, await vault.update(match[1], body));
        if (req.method === 'DELETE') return send(res, 200, await vault.remove(match[1], body.version));
      }
      throw new AppError(404, '요청을 찾을 수 없습니다.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Do not log request bodies, event data, passwords, keys or crypto errors.
      send(res, error.status ?? 500, { error: error.status ? error.message : '저장 또는 처리에 실패했습니다. 원본 데이터는 초기화하지 않았습니다.' });
    } finally { releaseRequest?.(); }
  };

  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  // ZIP uploads stream to disk and may take much longer than ordinary JSON requests.
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
    for (const [peer, attempt] of attempts) if (attempt.until <= now) attempts.delete(peer);
    for (const [peer, attempt] of resetAttempts) if (attempt.until <= now) resetAttempts.delete(peer);
  }, 60_000);
  maintenance.unref();
  const markerTimer = setInterval(() => { checkSetupMarker().catch(() => {}); }, 1000);
  markerTimer.unref();

  return {
    server, vault, workflows, workflowEngine, logMaintenance, transfers, get branding() { return brandingStore.branding; },
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(maintenance);
      clearInterval(markerTimer);
      sessions.clear();
      await transfers.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await markerCheck?.catch(() => {});
      await brandingStore.queue;
      await logMaintenance.close();
      await workflowEngine.close();
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
