import { AppError } from './errors.mjs';

import { NODE_TYPES, TRIGGERS, CONFIG_FIELDS, LIMITS, ports, isChange } from '../public/workflow-spec.js';
import { readPath, validPath, condition, validateComparison, parseRules } from './workflow-values.mjs';
export { NODE_TYPES, TRIGGERS, LIMITS, ports, readPath, condition };
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new AppError(400, message); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const text = (value, max, label) => { if (typeof value !== 'string' || value.length > max) fail(`${label} 형식 또는 길이를 확인해 주세요.`); return value; };

export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 100) fail('크론은 분 시 일 월 요일의 다섯 필드로 입력해 주세요.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) fail('크론은 분 시 일 월 요일의 다섯 필드로 입력해 주세요.');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.map((field, index) => {
    const [min, max] = ranges[index], values = new Set();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) fail('크론에는 숫자, *, 범위(-), 목록(,), 간격(/)을 사용할 수 있습니다.');
      const step = Number(match[2] ?? 1);
      const [start, end] = match[1] === '*' ? [min, max] : match[1].includes('-') ? match[1].split('-').map(Number) : [Number(match[1]), match[2] ? max : Number(match[1])];
      if (start < min || end > max || start > end || step < 1 || step > max + 1) fail('크론 숫자 범위를 확인해 주세요.');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field.startsWith('*') };
  });
}

export function cronSlot(config, instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  const values = [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)];
  const fields = parseCron(config.expression), matches = fields.map((field, index) => field.values.has(values[index]));
  const day = !fields[2].wildcard && !fields[4].wildcard ? matches[2] || matches[4] : matches[2] && matches[4];
  return matches[0] && matches[1] && matches[3] && day ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : null;
}

export function validateDefinition(input, { executable = false } = {}) {
  if (!plain(input)) fail('워크플로우 형식을 확인해 주세요.');
  const name = text(input.name, 80, '워크플로우 이름').trim();
  if (!name) fail('워크플로우 이름을 입력해 주세요.');
  if (!Array.isArray(input.nodes) || input.nodes.length > LIMITS.nodes || !Array.isArray(input.edges) || input.edges.length > LIMITS.edges) fail('워크플로우는 최대 100개 노드와 200개 연결을 지원합니다.');
  if (Buffer.byteLength(JSON.stringify({ name, nodes: input.nodes, edges: input.edges })) > LIMITS.bytes) fail('워크플로우 정의는 1MiB까지 지원합니다.');
  const seen = new Set();
  const nodes = input.nodes.map(node => {
    if (!plain(node) || !id(node.id) || seen.has(node.id) || !NODE_TYPES.includes(node.type) || !plain(node.config)) fail('노드 ID·종류·설정을 확인해 주세요.');
    seen.add(node.id);
    const c = node.config, config = {};
    const fields = CONFIG_FIELDS[node.type];
    for (const [key, [max, fallback]] of Object.entries(fields)) config[key] = text(c[key] ?? fallback, max, node.id + '.config.' + key);
    if (Object.keys(c).some(key => !Object.hasOwn(fields, key) && !(node.type === 'http' && ['timeoutMs', 'retries'].includes(key)))) fail(node.id + ': 지원하지 않는 설정 필드입니다.');
    if (node.type === 'http') {
      if (['timeoutMs', 'retries'].some(key => c[key] !== undefined && typeof c[key] !== 'number')) fail(node.id + ': 제한 시간과 재시도 횟수는 JSON 숫자여야 합니다.');
      config.timeoutMs = Number(c.timeoutMs ?? 10000); config.retries = Number(c.retries ?? 0);
      if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000 || !Number.isInteger(config.retries) || config.retries < 0 || config.retries > 3) fail('HTTP 제한 시간은 100~30000ms, 재시도는 0~3회입니다.');
    }
    const position = key => { if (!Number.isFinite(node[key]) || node[key] < 0 || node[key] > 30000) fail('노드 위치를 확인해 주세요.'); return Math.round(node[key] / 18) * 18; };
    return { id: node.id, type: node.type, name: text(node.name, 80, '노드 이름').trim() || node.type, x: position('x'), y: position('y'), config };
  });
  const edgeIds = new Set(), outlets = new Set();
  const edges = input.edges.map(edge => {
    if (!plain(edge)) fail('연결 형식을 확인해 주세요.');
    const from = nodes.find(node => node.id === edge.from), to = nodes.find(node => node.id === edge.to);
    if (!id(edge.id) || edgeIds.has(edge.id) || !from || !to || TRIGGERS.includes(to.type) || from === to || !ports(from).includes(edge.port) || outlets.has(`${edge.from}:${edge.port}`)) fail('연결 대상과 연결점의 중복을 확인해 주세요.');
    edgeIds.add(edge.id); outlets.add(`${edge.from}:${edge.port}`);
    return { id: edge.id, from: edge.from, to: edge.to, port: edge.port };
  });
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    if (visiting.has(key)) fail('순환하는 연결은 저장할 수 없습니다.');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const edge of edges.filter(edge => edge.from === key)) visit(edge.to);
    visiting.delete(key); visited.add(key);
  }
  for (const node of nodes) visit(node.id);
  if (executable) {
    const triggers = nodes.filter(node => TRIGGERS.includes(node.type));
    if (triggers.length !== 1) fail('실행하려면 시작 이벤트 노드를 정확히 하나 배치해 주세요.');
    const reachable = new Set(), pending = [triggers[0].id];
    while (pending.length) { const key = pending.pop(); if (reachable.has(key)) continue; reachable.add(key); pending.push(...edges.filter(edge => edge.from === key).map(edge => edge.to)); }
    if (reachable.size !== nodes.length) fail('시작 이벤트에서 연결되지 않은 노드가 있습니다.');
    for (const node of nodes) {
      const c = node.config;
      if (node.type === 'cron') { parseCron(c.expression); try { new Intl.DateTimeFormat('en', { timeZone: c.timezone }).format(); } catch { fail('크론 시간대를 확인해 주세요.'); } }
      if (node.type === 'condition') { if (c.rules) parseRules(c.rules); else validateComparison(c); }
      if (node.type === 'find') { if (!validPath(c.source)) fail(node.id + ': 값 경로와 형식을 확인해 주세요.'); validateComparison({ field: c.field, operator: 'equals', value: c.value, valueSource: c.valueSource }, true); }
      if (node.type === 'datetime') { if (c.source !== 'now' && !validPath(c.source)) fail(node.id + ': 값 경로와 형식을 확인해 주세요.'); if (!['iso', 'local', 'date', 'time', 'unix-ms'].includes(c.format)) fail(node.id + ': 값 경로와 형식을 확인해 주세요.'); try { new Intl.DateTimeFormat('en', { timeZone: c.timezone }).format(); } catch { fail(node.id + ': 시간대를 확인해 주세요.'); } }
      if (node.type === 'http') {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(c.method) || !['stop', 'continue', 'branch'].includes(c.onError)) fail('HTTP 메서드와 오류 처리 방식을 확인해 주세요.');
        if (!['auto', 'read', 'change'].includes(c.intent) || !['summary', 'none', 'allowlist'].includes(c.outputMode) || !['none', 'verified'].includes(c.idempotency)) fail(node.id + ': HTTP 실행·기록 정책을 확인해 주세요.');
        if (isChange(node) && c.retries && c.idempotency !== 'verified') fail(node.id + ': 변경 요청 재시도에는 검증된 외부 중복 방지가 필요합니다.');
        if (c.outputPaths && c.outputPaths.split(',').some(path => !validPath(path.trim(), true))) fail(node.id + ': 기록 허용 경로를 확인해 주세요.');
        validateUrl(c.url.replace(/\{\{[^}]+\}\}/g, 'value'));
        let headers;
        try { headers = JSON.parse(c.headers || '{}'); } catch { fail('헤더는 JSON 객체로 입력해 주세요.'); }
        if (!plain(headers) || Object.keys(headers).length > 50 || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value) || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase()))) fail('HTTP 헤더 이름과 문자열 값을 확인해 주세요.');
        if (c.onError === 'branch' && !edges.some(edge => edge.from === node.id && edge.port === 'error')) fail('HTTP 오류 분기를 연결해 주세요.');
      }
      if (node.type === 'finish' && !['success', 'failure', 'review', 'skipped'].includes(c.result)) fail('종료 결과를 선택해 주세요.');
    }
  }
  const costs = new Map();
  const cost = key => {
    if (costs.has(key)) return costs.get(key);
    const node = nodes.find(node => node.id === key);
    const value = (node.type === 'http' ? 1 + node.config.retries : 0) + Math.max(0, ...edges.filter(edge => edge.from === key).map(edge => cost(edge.to)));
    costs.set(key, value); return value;
  };
  if (nodes.some(node => cost(node.id) > LIMITS.attempts)) fail('한 실행 경로의 HTTP 시도는 재시도를 포함해 100회까지 지원합니다.');
  return { name, nodes, edges };
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('HTTP URL을 확인해 주세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('인증 정보와 fragment가 없는 http/https URL을 입력해 주세요.');
  if (['169.254.169.254', '169.254.170.2', 'metadata.google.internal', '[fd00:ec2::254]'].includes(url.hostname)) fail('클라우드 메타데이터 주소는 호출할 수 없습니다.');
  return url;
}

export function template(value, context, encode = false) {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
    const result = readPath(context, path);
    if (result === undefined) throw new Error(`변수를 찾을 수 없습니다: ${path}`);
    const text = typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
    return encode ? encodeURIComponent(text) : text;
  });
}

export function bodyTemplate(value, context) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return template(value, context); }
  const walk = item => plain(item) && Object.keys(item).length === 1 && typeof item.$path === 'string' ? (() => { const value = readPath(context, item.$path); if (value === undefined) throw new Error('JSON 값 경로를 찾을 수 없습니다.'); return value; })() : typeof item === 'string' ? template(item, context) : Array.isArray(item) ? item.map(walk) : plain(item) ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, walk(value)])) : item;
  return JSON.stringify(walk(parsed));
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') { for (const secret of secrets.filter(value => typeof value === 'string' && value)) value = value.split(secret).join('[가림]'); return value; }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|cookie|password|secret|token|api[-_]?key/i.test(key) ? '[가림]' : redact(item, secrets)]));
  return value;
}
