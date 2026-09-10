import { TRIGGERS, validateContextEntries } from '../public/workflow-spec.js';
import { condition, template, bodyTemplate, validateUrl } from './workflow-definition.mjs';
import { findItems, dateValue } from './workflow-values.mjs';

// Deterministic node behavior shared by real execution and Dry-Run.
export function evaluateStep(node, context, now) {
  let output, port = 'next', status = 'success', message = '', stop = false, secretValues = [];
  if (TRIGGERS.includes(node.type)) output = context.trigger;
  else if (node.type === 'find') { output = findItems(node.config, context); port = output.count === 0 ? 'zero' : output.count === 1 ? 'one' : 'many'; }
  else if (node.type === 'datetime') output = dateValue(node.config, context, now);
  else if (node.type === 'context') {
    const entries = validateContextEntries(node.config.entries ?? []);
    Object.assign(context.context, Object.fromEntries(entries.map(({ key, value }) => [key, value])));
    secretValues = entries.filter(entry => /authorization|cookie|password|secret|token|api[-_]?key/i.test(entry.key)).map(entry => entry.value);
    output = { keys: entries.map(entry => entry.key), count: entries.length };
  } else if (node.type === 'condition') { output = { matched: condition(node.config, context) }; port = output.matched ? 'true' : 'false'; }
  else if (node.type === 'finish') { status = node.config.result; message = template(node.config.message, context); output = { result: status, message }; stop = true; }
  else throw new Error('지원하지 않는 계산 노드입니다.');
  return { output, port, status, message, stop, secretValues };
}

export function prepareRequest(node, context) {
  const c = node.config;
  const url = validateUrl(template(c.url, context, true)).href;
  const headers = Object.fromEntries(Object.entries(JSON.parse(c.headers || '{}')).map(([key, value]) => [key, template(value, context)]));
  return { url, method: c.method, headers, ...(!['GET', 'HEAD'].includes(c.method) ? { body: bodyTemplate(c.body, context) } : {}) };
}
