import { setTimeout as delay } from 'node:timers/promises';
import { NO_CHANGE } from './vault.mjs';
import { enqueueRun, TERMINAL } from './workflows.mjs';
import { cronSlot, TRIGGERS, condition, template, bodyTemplate, validateUrl, redact } from './workflow-definition.mjs';

const errorMessage = error => error.name === 'TimeoutError' ? 'HTTP 요청 제한 시간을 초과했습니다.' : error.name === 'AbortError' ? '요청이 중지되었습니다.' : error.message === 'response-too-large' ? '응답 본문이 128KB를 초과했습니다.' : 'HTTP 요청에 실패했습니다.';
const summary = (value, secrets) => {
  const safe = redact(value, secrets), encoded = JSON.stringify(safe);
  return encoded?.length > 16000 ? { truncated: true, preview: encoded.slice(0, 16000) } : safe;
};

export class WorkflowEngine {
  constructor(vault, { clock = () => new Date().toISOString(), fetch: send = globalThis.fetch, intervalMs = 1000, autoStart = true } = {}) {
    this.vault = vault; this.clock = clock; this.fetch = send;
    this.jobs = new Map(); this.ready = false; this.closing = false; this.ticking = false; this.fault = null;
    if (autoStart) { this.timer = setInterval(() => { this.tick().catch(() => { this.fault = '실행 기록을 저장하지 못했습니다. 저장소를 확인하고 서버를 재시작해 주세요.'; }); }, intervalMs); this.timer.unref(); }
  }
  async unlock() {
    if (this.ready || this.closing || !this.vault.unlocked) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const at = this.clock();
      await this.vault.mutate(state => {
        const pending = state.workflowRuns.filter(run => !TERMINAL.has(run.status));
        if (!pending.length) return NO_CHANGE;
        for (const run of pending) {
          run.status = 'interrupted'; run.finishedAt = at; run.durationMs = run.startedAt ? Math.max(0, Date.parse(at) - Date.parse(run.startedAt)) : 0;
          run.message = '서버 중단 후 자동 재개하지 않았습니다. 이전 호출의 적용 여부를 확인한 뒤 다시 실행할 수 있습니다.';
          for (const step of run.steps.filter(step => step.status === 'running')) {
            step.status = 'interrupted'; step.finishedAt = at;
            for (const attempt of step.attempts.filter(attempt => !attempt.finishedAt)) Object.assign(attempt, { status: 'interrupted', finishedAt: at });
          }
        }
      }, { scope: { activeRuns: true } });
      this.cursor = at; this.ready = true;
    })();
    try { await this.initializing; } finally { this.initializing = null; }
  }
  wake() { if (!this.closing) queueMicrotask(() => this.tick().catch(() => { this.fault = '실행 기록을 저장하지 못했습니다. 저장소를 확인하고 서버를 재시작해 주세요.'; })); }
  status() { return { ready: this.ready && !this.fault && !this.closing, fault: this.fault, running: this.jobs.size }; }

  candidates(state, from, until) {
    const candidates = [];
    for (const flow of state.workflows) {
      if (!flow.enabled || flow.deletedAt) continue;
      const root = flow.nodes.find(node => TRIGGERS.includes(node.type));
      if (!root) continue;
      const lower = [from, flow.activatedAt, flow.updatedAt].filter(Boolean).sort().at(-1);
      if (root.type === 'cron') {
        for (let minute = Math.floor(Date.parse(lower) / 60000) * 60000 + 60000; minute <= Date.parse(until); minute += 60000) {
          const at = new Date(minute).toISOString(), slot = cronSlot(root.config, at);
          if (slot) candidates.push({ flow, key: `cron:${flow.id}:${root.id}:${root.config.timezone}:${slot}`, input: { event: null, trigger: { type: 'cron', scheduledAt: at, timezone: root.config.timezone } } });
        }
      } else {
        for (const event of state.events) {
          const at = event[root.type];
          if (!at || at <= lower || at > until || event.createdAt > at || event.updatedAt > at) continue;
          const service = root.config.service;
          if (service && service !== '모든 서비스' && !event.services.some(item => item.id === service || item.label === service)) continue;
          candidates.push({ flow, key: `event:${flow.id}:${root.id}:${event.id}:${at}`, input: { event, trigger: { type: root.type, scheduledAt: at } } });
        }
      }
    }
    return candidates.filter(item => !state.workflowRuns.some(run => run.requestKey === item.key));
  }

  async tick() {
    if (this.ticking || this.paused || this.closing || !this.vault.unlocked || this.fault) return;
    this.ticking = true;
    try {
      await this.unlock();
      if (this.closing) return;
      const now = this.clock(), from = [this.cursor, new Date(Date.parse(now) - 60000).toISOString()].sort().at(-1);
      const scope = { activeRuns: true, eventTrigger: { from, until: new Date(Date.parse(now) + 1).toISOString() } };
      const planned = now > from ? this.candidates(await this.vault.snapshot(scope), from, now) : [];
      if (planned.length) {
        await this.vault.mutate(state => {
          const candidates = this.candidates(state, from, now);
          if (!candidates.length) return NO_CHANGE;
          for (const item of candidates) enqueueRun(state, item.flow, item.input, item.key, 'automatic', now);
        }, { scope: { ...scope, requests: planned.map(item => item.key) } });
      }
      if (now > this.cursor) this.cursor = now;
      if (this.closing) return;
      for (const run of (await this.vault.snapshot({ activeRuns: true })).workflowRuns) {
        if (this.jobs.size >= 2) break;
        if (run.status !== 'queued' || this.jobs.has(run.id) || [...this.jobs.values()].some(job => job.workflowId === run.workflowId)) continue;
        const controller = new AbortController(), job = { workflowId: run.workflowId, controller };
        this.jobs.set(run.id, job);
        job.promise = this.execute(run.id, controller).catch(() => { this.fault = '실행 기록을 저장하지 못해 후속 실행을 멈췄습니다. 저장소를 확인하고 서버를 재시작해 주세요.'; }).finally(() => { this.jobs.delete(run.id); this.wake(); });
      }
    } finally { this.ticking = false; }
  }

  stop(id) { this.jobs.get(id)?.controller.abort(); }
  stopWorkflow(id) { for (const job of this.jobs.values()) if (job.workflowId === id) job.controller.abort(); }

  async execute(id, controller) {
    const start = await this.vault.mutate(state => {
      const run = state.workflowRuns.find(run => run.id === id);
      if (!run || run.status !== 'queued') return NO_CHANGE;
      run.status = 'running'; run.startedAt = this.clock(); return structuredClone(run);
    }, { scope: { ids: { workflowRuns: [id] } } });
    if (!start.event) return;
    const run = start.event, flow = this.vault.state.workflows.find(flow => flow.id === run.workflowId);
    const secrets = Object.values(flow?.secrets ?? {});
    // Inline sensitive header values are also excluded from persisted outputs.
    for (const node of run.definition.nodes.filter(node => node.type === 'http')) {
      try { for (const [key, value] of Object.entries(JSON.parse(node.config.headers || '{}'))) if (/authorization|cookie|token|api[-_]?key/i.test(key)) secrets.push(value); } catch {}
    }
    const context = { ...structuredClone(run.input), secrets: structuredClone(flow?.secrets ?? {}), nodes: {}, response: null, run: { id, startedAt: run.startedAt, kind: run.kind } };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    let node = run.definition.nodes.find(node => TRIGGERS.includes(node.type)), status = 'success', message = '';
    const patch = async change => {
      try { return await this.vault.mutate(state => change(state.workflowRuns.find(item => item.id === id)), { scope: { ids: { workflowRuns: [id] } } }); }
      catch (error) { this.fault = '실행 기록 저장에 실패해 후속 실행을 멈췄습니다. 저장소를 확인하고 서버를 재시작해 주세요.'; throw error; }
    };
    try {
      while (node) {
        signal.throwIfAborted();
        if (this.fault) throw new Error(this.fault);
        if ((await this.vault.getRecord('workflowRuns', id)).cancelRequested) { controller.abort(); signal.throwIfAborted(); }
        const current = node, stepId = node.id, at = this.clock();
        await patch(item => { item.steps.push({ nodeId: stepId, name: current.name, type: current.type, startedAt: at, status: 'running', attempts: [] }); });
        let output, port = 'next', stepStatus = 'success';
        try {
          if (TRIGGERS.includes(node.type)) output = context.trigger;
          if (node.type === 'condition') { output = { matched: condition(node.config, context) }; port = output.matched ? 'true' : 'false'; }
          if (node.type === 'http') {
            const c = node.config;
            let failure;
            for (let attempt = 0; attempt <= c.retries; attempt++) {
              signal.throwIfAborted();
              await patch(item => { item.steps.at(-1).attempts.push({ startedAt: this.clock(), number: attempt + 1 }); });
              try {
                const url = validateUrl(template(c.url, context, true));
                const headers = Object.fromEntries(Object.entries(JSON.parse(c.headers || '{}')).map(([key, value]) => [key, template(value, context)]));
                const response = await this.fetch(url, { method: c.method, headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(c.timeoutMs)]), ...(!['GET', 'HEAD'].includes(c.method) ? { body: bodyTemplate(c.body, context) } : {}) });
                let bytes = 0, chunks = [];
                if (response.body) for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 131072) throw new Error('response-too-large'); chunks.push(Buffer.from(chunk)); }
                const raw = Buffer.concat(chunks).toString('utf8');
                let body; try { body = JSON.parse(raw); } catch { body = raw; }
                output = { status: response.status, headers: Object.fromEntries(response.headers), body, error: null };
                failure = null;
              } catch (error) {
                failure = errorMessage(error);
              }
              await patch(item => { Object.assign(item.steps.at(-1).attempts.at(-1), { finishedAt: this.clock(), ...(failure ? { status: 'error', error: failure } : { status: 'response', httpStatus: output.status }) }); });
              if (!failure) break;
              signal.throwIfAborted();
              if (attempt < c.retries) await delay(250, undefined, { signal });
            }
            if (failure) {
              output = { status: null, headers: {}, body: null, error: { message: failure } };
              if (c.onError === 'stop') throw new Error(failure);
              stepStatus = 'handled-error'; if (c.onError === 'branch') port = 'error';
            }
            context.response = output;
          }
          if (node.type === 'finish') { status = node.config.result; stepStatus = status; message = template(node.config.message, context); output = { result: status, message }; }
          context.nodes[node.id] = output;
          await patch(item => { Object.assign(item.steps.at(-1), { status: stepStatus, finishedAt: this.clock(), port, output: summary(output, secrets) }); });
        } catch (error) {
          await patch(item => { Object.assign(item.steps.at(-1), { status: this.closing ? 'interrupted' : controller.signal.aborted ? 'canceled' : 'failure', finishedAt: this.clock(), error: summary(error.message, secrets) }); });
          throw error;
        }
        const edge = run.definition.edges.find(edge => edge.from === node.id && edge.port === port);
        node = edge ? run.definition.nodes.find(node => node.id === edge.to) : null;
      }
    } catch (error) {
      status = this.closing ? 'interrupted' : controller.signal.aborted ? 'canceled' : 'failure';
      message = status === 'interrupted' ? '서버 종료로 중단되었습니다. 이미 보낸 요청의 적용 여부는 대상 API에서 확인해 주세요.' : status === 'canceled' ? '실행을 중지했습니다. 이미 보낸 요청은 취소되지 않을 수 있습니다.' : signal.aborted ? '워크플로우 실행 제한 시간(120초)을 초과했습니다.' : error.message;
    }
    await patch(item => { Object.assign(item, { status: item.cancelRequested && status !== 'interrupted' ? 'canceled' : status, message: summary(message, secrets), finishedAt: this.clock(), durationMs: Math.max(0, Date.parse(this.clock()) - Date.parse(item.startedAt)) }); });
  }

  async close() {
    this.closing = true; clearInterval(this.timer);
    while (this.ticking) await delay(5);
    for (const job of this.jobs.values()) job.controller.abort();
    await this.initializing;
    await Promise.all([...this.jobs.values()].map(job => job.promise));
  }

  async pause(abort = false) {
    this.paused = true;
    while (this.ticking) await delay(5);
    if (abort) for (const job of this.jobs.values()) job.controller.abort();
    if (abort) await Promise.all([...this.jobs.values()].map(job => job.promise));
  }
  resume(fresh = false) {
    this.cursor = this.clock(); this.paused = false;
    if (fresh) { this.ready = false; this.fault = null; }
  }
}
