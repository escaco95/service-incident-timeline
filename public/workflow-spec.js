// Shared by the editor, validator and generated file schema.
export const LIMITS = Object.freeze({ nodes: 100, edges: 200, bytes: 1048576, attempts: 100 });
export const TRIGGERS = ['start', 'end', 'cron', 'service-state'];
export const CONTEXT_LIMITS = Object.freeze({ entries: 50, key: 64, value: 4000 });
export const DATETIME_FORMATS = ['iso', 'local', 'date', 'time', 'unix-ms', 'custom'];
export const DATETIME_LIMITS = Object.freeze({ pattern: 128, output: 256 });
export const DEFAULT_DATE_PATTERN = 'yyyy/MM/dd HH:mm:ss';
const DATE_TOKENS = Object.freeze({ yyyy: 'year', MM: 'month', dd: 'day', HH: 'hour', mm: 'minute', ss: 'second', SSS: 'millisecond', XXX: 'offset' });
export function parseDatePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > DATETIME_LIMITS.pattern || /[\u0000-\u001f\u007f]/.test(pattern)) throw new Error('날짜 형식은 줄바꿈 없이 1~128자로 입력해 주세요.');
  const parts = []; let index = 0, tokens = 0, length = 0;
  while (index < pattern.length) {
    if (pattern[index] === "'") {
      index++; let literal = '', closed = false;
      if (pattern[index] === "'") { literal = "'"; index++; closed = true; }
      else while (index < pattern.length) {
        if (pattern[index] === "'") {
          index++;
          if (pattern[index] === "'") { literal += "'"; index++; }
          else { closed = true; break; }
        } else literal += pattern[index++];
      }
      if (!closed) throw new Error('날짜 형식의 작은따옴표를 닫아 주세요.');
      parts.push({ literal }); length += literal.length;
    } else if (/[A-Za-z]/.test(pattern[index])) {
      const token = /^([A-Za-z])\1*/.exec(pattern.slice(index))[0];
      if (!Object.hasOwn(DATE_TOKENS, token)) throw new Error('날짜 형식 토큰은 yyyy, MM, dd, HH, mm, ss, SSS, XXX만 지원합니다. 영문 고정 문구는 작은따옴표로 감싸 주세요.');
      parts.push({ key: DATE_TOKENS[token] }); tokens++; index += token.length; length += token === 'XXX' ? 6 : token.length;
    } else { parts.push({ literal: pattern[index++] }); length++; }
  }
  if (!tokens) throw new Error('날짜 형식에 날짜·시각 토큰을 하나 이상 포함해 주세요.');
  if (length > DATETIME_LIMITS.output) throw new Error('날짜 형식 출력은 최대 256자까지 지원합니다.');
  return parts;
}
export const SWITCH_LIMITS = Object.freeze({ cases: 20, value: 2000 });
export function validPath(path, relative = false) {
  return typeof path === 'string' && path.length <= 200 && (relative || /^(event|trigger|response|nodes|run|secrets|context)\./.test(path)) && path.split('.').every(key => /^[\w-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key));
}
export function validateSwitchCases(cases) {
  if (!Array.isArray(cases) || cases.length > SWITCH_LIMITS.cases) throw new Error('switch 분기는 최대 20개까지 입력해 주세요.');
  const ids = new Set(), values = new Set();
  return cases.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'value'].includes(key))) throw new Error('switch 분기 형식을 확인해 주세요.');
    const { id, value } = entry;
    if (typeof id !== 'string' || !/^case-[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('switch 분기 ID는 중복되지 않는 case-로 시작하는 영문·숫자·밑줄·하이픈이어야 합니다.');
    if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= SWITCH_LIMITS.value)) throw new Error('분기 값은 2,000자 이내 문자열, 유한한 숫자, true/false 또는 null이어야 합니다.');
    const key = JSON.stringify(value);
    if (values.has(key)) throw new Error('같은 자료형의 중복된 분기 값은 사용할 수 없습니다.');
    ids.add(id); values.add(key);
    return { id, value };
  });
}
export const switchLabel = (node, port) => port === 'default' ? '기본' : JSON.stringify(node.config.cases.find(entry => entry.id === port)?.value) ?? port;
export function validateContextEntries(entries) {
  if (!Array.isArray(entries) || entries.length > CONTEXT_LIMITS.entries) throw new Error('컨텍스트 값은 최대 50개까지 입력해 주세요.');
  const keys = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['key', 'value'].includes(key))) throw new Error('컨텍스트 값의 키·값 형식을 확인해 주세요.');
    const { key, value } = entry;
    if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('키는 영문자로 시작하는 영문·숫자·밑줄·하이픈 64자 이내로 입력해 주세요.');
    if (keys.has(key)) throw new Error(`중복된 키입니다: ${key}`);
    if (typeof value !== 'string' || value.length > CONTEXT_LIMITS.value) throw new Error('값은 4,000자 이내의 문자열로 입력해 주세요.');
    keys.add(key);
    return { key, value };
  });
}
export const CONFIG_FIELDS = {
  start: { service: [100, ''], executionService: [100, ''] }, end: { service: [100, ''], executionService: [100, ''] },
  cron: { executionService: [100, ''], expression: [100, ''], timezone: [100, 'Asia/Seoul'] },
  'service-state': { service: [100, ''] },
  condition: { field: [200, ''], operator: [30, 'equals'], value: [2000, ''], valueSource: [10, 'literal'], rules: [16000, ''] },
  switch: { field: [200, 'trigger.service'] },
  find: { source: [200, 'response.body'], field: [200, 'id'], value: [2000, ''], valueSource: [10, 'literal'] },
  datetime: { source: [200, 'now'], timezone: [100, 'Asia/Seoul'], format: [20, 'iso'], pattern: [DATETIME_LIMITS.pattern, ''] },
  context: {},
  http: { method: [10, 'GET'], url: [2000, ''], headers: [16000, '{}'], body: [64000, ''], onError: [20, 'stop'], intent: [10, 'auto'], outputMode: [10, 'summary'], outputPaths: [2000, ''], idempotency: [10, 'none'] },
  finish: { result: [20, 'success'], message: [2000, ''] }
};
export const NODE_TYPES = Object.keys(CONFIG_FIELDS);
export const ports = node => node.type === 'finish' ? [] : node.type === 'switch' ? [...node.config.cases.map(entry => entry.id), 'default'] : node.type === 'condition' ? ['true', 'false'] : node.type === 'find' ? ['zero', 'one', 'many'] : node.type === 'http' && node.config.onError === 'branch' ? ['next', 'error'] : ['next'];
export const isChange = node => node.type === 'http' && (node.config.intent === 'change' || (!node.config.intent || node.config.intent === 'auto') && !['GET', 'HEAD'].includes(node.config.method));
