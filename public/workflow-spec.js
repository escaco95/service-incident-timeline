// Shared by the editor, validator and generated file schema.
export const LIMITS = Object.freeze({ nodes: 100, edges: 200, bytes: 1048576, attempts: 100 });
export const TRIGGERS = ['start', 'end', 'cron', 'service-state'];
export const CONTEXT_LIMITS = Object.freeze({ entries: 50, key: 64, value: 4000 });
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
  find: { source: [200, 'response.body'], field: [200, 'id'], value: [2000, ''], valueSource: [10, 'literal'] },
  datetime: { source: [200, 'now'], timezone: [100, 'Asia/Seoul'], format: [20, 'iso'] },
  context: {},
  http: { method: [10, 'GET'], url: [2000, ''], headers: [16000, '{}'], body: [64000, ''], onError: [20, 'stop'], intent: [10, 'auto'], outputMode: [10, 'summary'], outputPaths: [2000, ''], idempotency: [10, 'none'] },
  finish: { result: [20, 'success'], message: [2000, ''] }
};
export const NODE_TYPES = Object.keys(CONFIG_FIELDS);
export const ports = node => node.type === 'finish' ? [] : node.type === 'condition' ? ['true', 'false'] : node.type === 'find' ? ['zero', 'one', 'many'] : node.type === 'http' && node.config.onError === 'branch' ? ['next', 'error'] : ['next'];
export const isChange = node => node.type === 'http' && (node.config.intent === 'change' || (!node.config.intent || node.config.intent === 'auto') && !['GET', 'HEAD'].includes(node.config.method));
