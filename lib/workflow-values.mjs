import { AppError } from './errors.mjs';
const fail = message => { throw new AppError(400, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validPath(path, relative = false) {
  return typeof path === 'string' && path.length <= 200 && (relative || /^(event|trigger|response|nodes|run|secrets)\./.test(path)) && path.split('.').every(key => /^[\w-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key));
}
export function readPath(context, path) {
  if (!validPath(path, true)) throw new Error('지원하지 않는 변수 경로입니다.');
  let value = context;
  for (const key of path.split('.')) { if (value === null || value === undefined || !Object.hasOwn(Object(value), key)) return undefined; value = value[key]; }
  return value;
}
const literal = value => { try { return JSON.parse(value); } catch { return value; } };
export const expectedValue = (config, context) => config.valueSource === 'path' ? readPath(context, config.value) : literal(config.value);
export const OPERATORS = ['equals', 'notEquals', 'contains', 'exists', 'isPresent', 'isMissing', 'isNull', 'gt', 'gte', 'lt', 'lte'];
export function validateComparison(config, relative = false) {
  if (!plain(config) || Object.keys(config).some(key => !['field', 'operator', 'value', 'valueSource', 'rules'].includes(key)) || !validPath(config.field, relative) || !OPERATORS.includes(config.operator) || !['literal', 'path', undefined].includes(config.valueSource)) fail('조건의 값 경로와 연산자를 확인해 주세요.');
  if (config.valueSource === 'path' && !validPath(config.value)) fail('비교 대상 경로를 확인해 주세요.');
}
export function parseRules(raw) {
  let rules; try { rules = JSON.parse(raw); } catch { fail('복합 조건은 JSON 객체로 입력해 주세요.'); }
  let count = 0;
  const walk = (rule, depth) => {
    if (++count > 64 || depth > 8 || !plain(rule)) fail('복합 조건은 깊이 8, 항목 64개까지 지원합니다.');
    const key = Object.hasOwn(rule, 'all') ? 'all' : Object.hasOwn(rule, 'any') ? 'any' : null;
    if (key) { if (Object.keys(rule).length !== 1 || !Array.isArray(rule[key]) || !rule[key].length) fail('all/any에는 조건 배열을 입력해 주세요.'); rule[key].forEach(child => walk(child, depth + 1)); }
    else { if (rule.rules) fail('복합 조건 안에 rules를 중첩하지 마세요.'); validateComparison(rule); }
  };
  walk(rules, 0); return rules;
}
export function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function condition(config, context) {
  if (config.rules) {
    const walk = rule => rule.all ? rule.all.every(walk) : rule.any ? rule.any.some(walk) : condition(rule, context);
    return walk(parseRules(config.rules));
  }
  const actual = readPath(context, config.field), expected = expectedValue(config, context);
  if (config.valueSource === 'path' && expected === undefined && !['exists', 'isPresent', 'isMissing', 'isNull'].includes(config.operator)) return false;
  switch (config.operator) {
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'isPresent': return actual !== undefined;
    case 'isMissing': return actual === undefined;
    case 'isNull': return actual === null;
    case 'equals': return actual !== undefined && expected !== undefined && equal(actual, expected);
    case 'notEquals': return actual !== undefined && expected !== undefined && !equal(actual, expected);
    case 'contains': return typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some(item => equal(item, expected));
    case 'gt': case 'gte': case 'lt': case 'lte': return typeof actual === 'number' && typeof expected === 'number' && ({ gt: actual > expected, gte: actual >= expected, lt: actual < expected, lte: actual <= expected })[config.operator];
    default: throw new Error('지원하지 않는 조건입니다.');
  }
}
export function findItems(config, context) {
  const source = readPath(context, config.source), expected = expectedValue(config, context);
  if (!Array.isArray(source) || source.length > 1000) throw new Error('목록 검색에는 최대 1,000개 항목의 배열이 필요합니다.');
  if (expected === undefined) throw new Error('목록 검색의 비교 대상이 없습니다.');
  const matches = source.filter(item => equal(readPath(item, config.field), expected));
  return { count: matches.length, item: matches.length === 1 ? matches[0] : null };
}
export function dateValue(config, context, now) {
  const input = config.source === 'now' ? now : readPath(context, config.source);
  if (typeof input !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input) || !Number.isFinite(Date.parse(input))) throw new Error('시각은 시간대가 있는 ISO 문자열이어야 합니다.');
  const date = new Date(input), iso = date.toISOString();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}:${parts.second}`;
  const offset = Math.round((Date.parse(`${day}T${time}Z`) - Math.floor(+date / 1000) * 1000) / 60000);
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return { value: ({ iso, local: `${day}T${time}${zone}`, date: day, time, 'unix-ms': +date })[config.format], iso, timezone: config.timezone, evaluatedAt: now };
}
