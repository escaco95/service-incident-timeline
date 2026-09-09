import { AppError } from './errors.mjs';

export const NODE_TYPES = ['start', 'end', 'cron', 'condition', 'http', 'finish'];
export const TRIGGERS = ['start', 'end', 'cron'];
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new AppError(400, message); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const text = (value, max, label) => { if (typeof value !== 'string' || value.length > max) fail(`${label} 형식 또는 길이를 확인해 주세요.`); return value; };
export const ports = node => node.type === 'finish' ? [] : node.type === 'condition' ? ['true', 'false'] : node.type === 'http' && node.config.onError === 'branch' ? ['next', 'error'] : ['next'];

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
  if (!Array.isArray(input.nodes) || input.nodes.length > 30 || !Array.isArray(input.edges) || input.edges.length > 60) fail('워크플로우는 최대 30개 노드와 60개 연결을 지원합니다.');
  const seen = new Set();
  const nodes = input.nodes.map(node => {
    if (!plain(node) || !id(node.id) || seen.has(node.id) || !NODE_TYPES.includes(node.type) || !plain(node.config)) fail('노드 ID·종류·설정을 확인해 주세요.');
    seen.add(node.id);
    const c = node.config, config = {};
    const fields = { start: [['service', 100]], end: [['service', 100]], cron: [['expression', 100], ['timezone', 100]], condition: [['field', 200], ['operator', 30], ['value', 2000]], http: [['method', 10], ['url', 2000], ['headers', 16000], ['body', 64000], ['onError', 20]], finish: [['result', 20], ['message', 2000]] };
    for (const [key, max] of fields[node.type]) config[key] = text(c[key] ?? '', max, key);
    if (node.type === 'http') {
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
      if (node.type === 'condition' && (!/^(event|trigger|response|nodes|run)\.[\w.-]+$/.test(c.field) || !['equals', 'notEquals', 'contains', 'exists', 'gt', 'gte', 'lt', 'lte'].includes(c.operator))) fail('조건의 값 경로와 연산자를 확인해 주세요.');
      if (node.type === 'http') {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(c.method) || !['stop', 'continue', 'branch'].includes(c.onError)) fail('HTTP 메서드와 오류 처리 방식을 확인해 주세요.');
        validateUrl(c.url.replace(/\{\{[^}]+\}\}/g, 'value'));
        let headers;
        try { headers = JSON.parse(c.headers || '{}'); } catch { fail('헤더는 JSON 객체로 입력해 주세요.'); }
        if (!plain(headers) || Object.keys(headers).length > 50 || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value) || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase()))) fail('HTTP 헤더 이름과 문자열 값을 확인해 주세요.');
        if (c.onError === 'branch' && !edges.some(edge => edge.from === node.id && edge.port === 'error')) fail('HTTP 오류 분기를 연결해 주세요.');
      }
      if (node.type === 'finish' && !['success', 'failure'].includes(c.result)) fail('종료 결과를 선택해 주세요.');
    }
  }
  return { name, nodes, edges };
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('HTTP URL을 확인해 주세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('인증 정보와 fragment가 없는 http/https URL을 입력해 주세요.');
  if (['169.254.169.254', '169.254.170.2', 'metadata.google.internal', '[fd00:ec2::254]'].includes(url.hostname)) fail('클라우드 메타데이터 주소는 호출할 수 없습니다.');
  return url;
}

export function readPath(context, path) {
  const keys = path.trim().split('.');
  if (keys.some(key => !/^[\w-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('지원하지 않는 변수 경로입니다.');
  let value = context;
  for (const key of keys) { if (value === null || value === undefined || !Object.hasOwn(Object(value), key)) return undefined; value = value[key]; }
  return value;
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
  const walk = item => typeof item === 'string' ? template(item, context) : Array.isArray(item) ? item.map(walk) : plain(item) ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, walk(value)])) : item;
  return JSON.stringify(walk(parsed));
}

export function condition(config, context) {
  const actual = readPath(context, config.field);
  let expected;
  try { expected = JSON.parse(config.value); } catch { expected = config.value; }
  switch (config.operator) {
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'equals': return JSON.stringify(actual) === JSON.stringify(expected);
    case 'notEquals': return JSON.stringify(actual) !== JSON.stringify(expected);
    case 'contains': return typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some(item => JSON.stringify(item) === JSON.stringify(expected));
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      return { gt: actual > expected, gte: actual >= expected, lt: actual < expected, lte: actual <= expected }[config.operator];
    }
    default: throw new Error('지원하지 않는 조건입니다.');
  }
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') { for (const secret of secrets.filter(value => typeof value === 'string' && value)) value = value.split(secret).join('[가림]'); return value; }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|cookie|password|secret|token|api[-_]?key/i.test(key) ? '[가림]' : redact(item, secrets)]));
  return value;
}
