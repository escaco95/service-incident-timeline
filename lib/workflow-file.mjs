import { AppError } from './errors.mjs';
import { validateDefinition, LIMITS, TRIGGERS } from './workflow-definition.mjs';
import { CONFIG_FIELDS, NODE_TYPES, CONTEXT_LIMITS, SWITCH_LIMITS, DATETIME_FORMATS } from '../public/workflow-spec.js';
import { validPath, parseRules } from './workflow-values.mjs';
export const FORMAT = 'service-incident-timeline/workflow';
const fail = (path, message) => { throw new AppError(400, `${path}: ${message}`); };
function keys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체가 필요합니다.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, '지원하지 않는 필드입니다.');
}
function nodeReferences(node) {
    // Injected strings are literal values, even when they contain template syntax.
    if (node.type === 'context') return [];
    // Date pattern literals are not workflow templates.
    if (node.type === 'datetime') return node.config.source === 'now' ? [] : [node.config.source];
    // Case values are literals, including text that looks like a template.
    if (node.type === 'switch') return [node.config.field];
    const paths = [...JSON.stringify(node.config).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
    const c = node.config;
    if (node.type === 'condition') {
      const walk = rule => rule.all ? rule.all.forEach(walk) : rule.any ? rule.any.forEach(walk) : (paths.push(rule.field), rule.valueSource === 'path' && paths.push(rule.value));
      if (c.rules) { try { walk(parseRules(c.rules)); } catch {} } else walk(c);
    }
    if (node.type === 'find') { paths.push(c.source); if (c.valueSource === 'path') paths.push(c.value); }
    if (node.type === 'http') {
      let body; try { body = JSON.parse(c.body); } catch {}
      const walk = value => { if (value && typeof value === 'object') { if (typeof value.$path === 'string') paths.push(value.$path); else Object.values(value).forEach(walk); } };
      walk(body);
    }
    return paths;
}
export function secretNames(definition) {
  return [...new Set(definition.nodes.flatMap(nodeReferences).filter(path => typeof path === 'string' && path.startsWith('secrets.')).map(path => path.split('.')[1]))].sort();
}
export function validateReferences(definition, { report = fail } = {}) {
  const { nodes, edges } = definition, root = nodes.find(node => TRIGGERS.includes(node.type));
  if (!root) return;
  const cache = new Map();
  const before = id => {
    if (cache.has(id)) return cache.get(id);
    const incoming = edges.filter(edge => edge.to === id).map(edge => {
      const set = new Set(before(edge.from)); set.add(edge.from);
      const previous = nodes.find(node => node.id === edge.from);
      if (previous.type === 'http') set.add('$response');
      if (previous.type === 'context') for (const entry of previous.config.entries) set.add('$context.' + entry.key);
      return set;
    });
    const set = incoming.length ? new Set([...incoming[0]].filter(key => incoming.every(set => set.has(key)))) : new Set();
    cache.set(id, set); return set;
  };
  for (const node of nodes) {
    const paths = nodeReferences(node);
    for (const path of paths) {
      if (!validPath(path)) { report(`nodes.${node.id}`, '지원하지 않는 값 경로입니다.'); continue; }
      if (path.startsWith('nodes.') && !before(node.id).has(path.split('.')[1])) report(`nodes.${node.id}`, `모든 진입 경로에서 먼저 실행되지 않는 노드 참조: ${path}`);
      if (path.startsWith('response.') && !before(node.id).has('$response')) report(`nodes.${node.id}`, 'HTTP 응답이 없는 경로입니다.');
      if (path.startsWith('context.') && !before(node.id).has('$context.' + path.split('.')[1])) report(`nodes.${node.id}`, `모든 진입 경로에서 먼저 주입되지 않는 컨텍스트 값: ${path}`);
      if (path.startsWith('event.') && ['cron', 'service-state'].includes(root.type)) report(`nodes.${node.id}`, '이 트리거는 단일 이벤트 원문을 제공하지 않습니다.');
    }
  }
}
function portableSecrets(definition) {
  for (const node of definition.nodes.filter(node => node.type === 'http')) {
    let headers; try { headers = JSON.parse(node.config.headers || '{}'); } catch { continue; }
    for (const [key, value] of Object.entries(headers)) if (/authorization|cookie|token|api[-_]?key/i.test(key) && value && !/\{\{\s*(?:secrets|context)\.[\w-]+\s*\}\}/.test(value)) fail(`nodes.${node.id}.config.headers`, '인증 값은 context 참조(기존 값은 secrets 참조)로 옮긴 뒤 파일로 교환해 주세요.');
  }
}
export function importWorkflow(file, { executable = false } = {}) {
  if (Buffer.byteLength(JSON.stringify(file)) > LIMITS.bytes) fail('$', '파일은 1MiB까지 지원합니다.');
  keys(file, ['format', 'formatVersion', 'definition', 'requiredSecrets'], '$');
  if (file.format !== FORMAT || file.formatVersion !== 1) fail('formatVersion', '지원하지 않는 파일 형식입니다.');
  keys(file.definition, ['name', 'nodes', 'edges'], 'definition');
  if (!Array.isArray(file.definition.nodes) || !Array.isArray(file.definition.edges)) fail('definition', 'nodes와 edges 배열이 필요합니다.');
  const raw = structuredClone(file.definition);
  raw.nodes.forEach((node, index) => {
    keys(node, ['id', 'name', 'type', 'config', 'x', 'y'], `definition.nodes[${index}]`);
    if (!NODE_TYPES.includes(node.type)) fail(`definition.nodes[${index}].type`, '지원하지 않는 노드입니다.');
    node.name ??= node.id; node.x ??= 36 + index % 4 * 306; node.y ??= 36 + Math.floor(index / 4) * 198;
  });
  raw.edges.forEach((edge, index) => keys(edge, ['id', 'from', 'to', 'port'], `definition.edges[${index}]`));
  const definition = validateDefinition(raw, { executable });
  portableSecrets(definition);
  if (executable) validateReferences(definition);
  const requiredSecrets = secretNames(definition);
  const declaredSecrets = Object.hasOwn(file, 'requiredSecrets') ? file.requiredSecrets : [];
  if (!Array.isArray(declaredSecrets) || JSON.stringify([...new Set(declaredSecrets)].sort()) !== JSON.stringify(requiredSecrets) || declaredSecrets.length !== requiredSecrets.length) fail('requiredSecrets', '정의에 사용한 비밀 변수 이름과 일치해야 합니다.');
  let executableError = null;
  try { validateDefinition(definition, { executable: true }); validateReferences(definition); } catch (error) { executableError = error.message; }
  return { definition, requiredSecrets, executable: executableError === null, executableError };
}
export function exportWorkflow(flow) {
  const definition = validateDefinition({ name: flow.name, nodes: flow.nodes, edges: flow.edges });
  portableSecrets(definition);
  const requiredSecrets = secretNames(definition);
  return { format: FORMAT, formatVersion: 1, definition, ...(requiredSecrets.length ? { requiredSecrets } : {}) };
}

export function fileSchema() {
  const str = maxLength => ({ type: 'string', maxLength });
  const switchPort = { type: 'string', pattern: '^case-[a-zA-Z0-9_-]{1,64}$' };
  const contextFields = { entries: { type: 'array', maxItems: CONTEXT_LIMITS.entries, default: [], items: {
    type: 'object', additionalProperties: false, required: ['key', 'value'], properties: {
      key: { ...str(CONTEXT_LIMITS.key), pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$', not: { enum: ['constructor', 'prototype', '__proto__'] } }, value: str(CONTEXT_LIMITS.value)
    }
  } } };
  const switchFields = { cases: { type: 'array', maxItems: SWITCH_LIMITS.cases, default: [], items: {
    type: 'object', additionalProperties: false, required: ['id', 'value'], properties: {
      id: switchPort, value: { oneOf: [str(SWITCH_LIMITS.value), { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
    }
  } } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Workflow exchange v1', type: 'object', additionalProperties: false,
    required: ['format', 'formatVersion', 'definition'], properties: {
      format: { const: FORMAT }, formatVersion: { const: 1 },
      requiredSecrets: { type: 'array', default: [], maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' } },
      definition: { type: 'object', additionalProperties: false, required: ['name', 'nodes', 'edges'], properties: {
        name: { ...str(80), minLength: 1 },
        nodes: { type: 'array', maxItems: LIMITS.nodes, items: { oneOf: NODE_TYPES.map(type => ({
          type: 'object', additionalProperties: false, required: ['id', 'type', 'config'], properties: {
            id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, type: { const: type }, name: str(80), x: { type: 'number', minimum: 0, maximum: 30000 }, y: { type: 'number', minimum: 0, maximum: 30000 },
            config: { type: 'object', additionalProperties: false,
              ...(type === 'datetime' ? { allOf: [{ if: { required: ['format'], properties: { format: { const: 'custom' } } }, then: { required: ['pattern'], properties: { pattern: { minLength: 1 } } } }] } : {}), properties: {
              ...Object.fromEntries(Object.entries(CONFIG_FIELDS[type]).map(([key, [max, fallback]]) => [key, { ...str(max), default: fallback }])),
              ...(type === 'context' ? contextFields : {}), ...(type === 'switch' ? switchFields : {}),
              ...(type === 'datetime' ? { format: { type: 'string', enum: DATETIME_FORMATS, default: 'iso' } } : {}),
              ...(type === 'http' ? { timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 10000 }, retries: { type: 'integer', minimum: 0, maximum: 3, default: 0 } } : {})
            } }
          }
        })) } },
        edges: { type: 'array', maxItems: LIMITS.edges, items: { type: 'object', additionalProperties: false, required: ['id', 'from', 'to', 'port'], properties: {
          id: str(80), from: str(80), to: str(80), port: { anyOf: [{ enum: ['next', 'true', 'false', 'error', 'zero', 'one', 'many', 'default'] }, switchPort] }
        } } }
      } }
    }
  };
}
