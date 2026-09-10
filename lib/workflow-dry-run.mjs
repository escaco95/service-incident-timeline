import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { validateDefinition, plain, redact, TRIGGERS } from './workflow-definition.mjs';
import { validateReferences } from './workflow-file.mjs';
import { evaluateStep, prepareRequest } from './workflow-step.mjs';
import { parseDateInstant } from './workflow-values.mjs';
import { isChange, LIMITS } from '../public/workflow-spec.js';
import { DRY_RUN_LIMITS } from '../public/workflow-dry-run-spec.js';

const fail = message => { throw new AppError(400, message); };
const fields = {
  start: { event: DRY_RUN_LIMITS.json, trigger: DRY_RUN_LIMITS.json },
  end: { event: DRY_RUN_LIMITS.json, trigger: DRY_RUN_LIMITS.json },
  cron: { trigger: DRY_RUN_LIMITS.json },
  'service-state': { trigger: DRY_RUN_LIMITS.json, scenario: 4000 },
  http: { outcome: 20, status: 3, headers: DRY_RUN_LIMITS.headers, body: DRY_RUN_LIMITS.json, error: 2000 }
};
export function validateDryRunSetup(input) {
  if (!plain(input) || Object.keys(input).some(key => !['now', 'nodes'].includes(key)) || typeof input.now !== 'string' || input.now.length > 100 || !plain(input.nodes) || Object.keys(input.nodes).length > LIMITS.nodes) fail('Dry-Run 설정 형식을 확인해 주세요.');
  if (Buffer.byteLength(JSON.stringify(input)) > DRY_RUN_LIMITS.bytes) fail('Dry-Run 입력값은 합계 512KiB까지 저장할 수 있습니다.');
  for (const [id, values] of Object.entries(input.nodes)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !plain(values) || !Object.hasOwn(fields, values.type)) fail('Dry-Run 노드 설정을 확인해 주세요.');
    for (const [key, value] of Object.entries(values)) {
      if (key === 'type') continue;
      if (!Object.hasOwn(fields[values.type], key) || typeof value !== 'string' || value.length > fields[values.type][key]) fail(`${id}: Dry-Run 입력 필드와 길이를 확인해 주세요.`);
    }
  }
  // Keep unfinished JSON text too, so closing the setup never discards an edit.
  return structuredClone(input);
}
const parse = (text, label, object = false) => {
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label}: 올바른 JSON을 입력해 주세요.`); }
  if (object && !plain(value)) fail(`${label}: JSON 객체를 입력해 주세요.`);
  return value;
};
const instant = value => { try { parseDateInstant(value); return true; } catch { return false; } };
const preview = (value, secrets) => {
  const safe = redact(value, secrets), text = JSON.stringify(safe);
  return text?.length > 16000 ? { truncated: true, preview: text.slice(0, 16000) } : safe;
};

// This evaluator has no network, vault, scheduler or audit dependencies.
export function dryRunWorkflow(input, rawSetup, legacySecrets = {}) {
  const definition = validateDefinition(input, { executable: true });
  validateReferences(definition);
  const setup = validateDryRunSetup(rawSetup);
  if (!instant(setup.now)) fail('테스트 기준 시각은 시간대가 있는 ISO 시각으로 입력해 주세요.');
  const root = definition.nodes.find(node => TRIGGERS.includes(node.type));
  const fixture = setup.nodes[root.id];
  if (fixture?.type !== root.type) fail(`${root.name}: 트리거 초기값을 입력해 주세요.`);
  const trigger = { scheduledAt: setup.now, ...parse(fixture.trigger, `${root.name} 트리거`, true), type: root.type };
  if (!instant(trigger.scheduledAt)) fail('트리거 scheduledAt은 시간대가 있는 ISO 시각이어야 합니다.');
  if (root.config.executionService) trigger.service = root.config.executionService;
  const event = ['start', 'end'].includes(root.type) ? parse(fixture.event, `${root.name} 이벤트`, true) : null;
  const context = { event, trigger, context: {}, nodes: {}, response: null, secrets: structuredClone(legacySecrets), run: { id: 'dry-run-' + randomUUID(), startedAt: setup.now, kind: 'dry-run' } };
  const secrets = Object.values(legacySecrets), steps = [], followedEdges = [];
  let node = root, status = 'success', message = '';
  const scenario = root.type === 'service-state' && fixture.scenario ? parse(fixture.scenario, `${root.name} 일정 재현 정보`, true) : null;
  if (scenario?.kind === 'service-event' && scenario.service === trigger.service && scenario.scheduledAt === trigger.scheduledAt && scenario.previous === trigger.previous && scenario.severity === trigger.severity && trigger.previous === trigger.severity) {
    status = 'skipped'; message = '일정 시작·종료 전후의 서비스 상태가 같아 자동 실행이 발생하지 않습니다.';
    context.nodes[root.id] = trigger;
    steps.push({ nodeId: root.id, name: root.name, type: root.type, status, port: '', output: preview(trigger, secrets) });
    node = null;
  }
  while (node) {
    const step = { nodeId: node.id, name: node.name, type: node.type, status: 'success', port: 'next' };
    steps.push(step);
    let output;
    try {
      if (node.type === 'http') {
        const mock = setup.nodes[node.id], c = node.config;
        if (mock?.type !== 'http') throw new Error('이 API 호출의 Dry-Run 결과를 입력해 주세요.');
        step.request = preview(prepareRequest(node, context), secrets);
        if (!['response', 'error'].includes(mock.outcome)) throw new Error('API 테스트 결과 유형을 선택해 주세요.');
        step.attempts = mock.outcome === 'error' ? c.retries + 1 : 1;
        if (mock.outcome === 'error') {
          const error = mock.error || '테스트 통신 오류';
          if (isChange(node)) { step.status = 'review'; status = 'review'; message = '변경 요청의 적용 여부를 확인해야 합니다.'; step.error = preview(error, secrets); break; }
          if (c.onError === 'stop') throw new Error(error);
          output = { status: null, headers: {}, body: null, error: { message: error } };
          step.status = 'handled-error'; if (c.onError === 'branch') step.port = 'error';
        } else {
          const statusCode = Number(mock.status);
          if (!/^\d{3}$/.test(mock.status) || statusCode < 200 || statusCode > 599) throw new Error('HTTP 상태 코드는 200~599로 입력해 주세요.');
          const headers = parse(mock.headers, `${node.name} 응답 헤더`, true);
          if (Object.values(headers).some(value => typeof value !== 'string')) throw new Error('응답 헤더 값은 문자열이어야 합니다.');
          const body = parse(mock.body, `${node.name} 응답 본문`);
          if (Buffer.byteLength(JSON.stringify(body)) > DRY_RUN_LIMITS.json) throw new Error('응답 본문은 128KiB까지 입력해 주세요.');
          output = { status: statusCode, headers: Object.fromEntries(new Headers(headers)), body, error: null };
        }
        context.response = output;
      } else {
        const result = evaluateStep(node, context, setup.now);
        output = result.output; step.status = result.status; step.port = result.port;
        secrets.push(...result.secretValues);
        if (result.stop) { status = result.status; message = result.message; }
      }
      context.nodes[node.id] = output;
      step.output = preview(output, secrets);
    } catch (error) {
      step.status = 'failure'; step.error = preview(error.message, secrets);
      status = 'failure'; message = error.message; break;
    }
    if (node.type === 'finish') break;
    const edge = definition.edges.find(edge => edge.from === node.id && edge.port === step.port);
    if (edge) followedEdges.push(edge.id);
    node = edge ? definition.nodes.find(node => node.id === edge.to) : null;
  }
  return { dryRun: true, status, message: preview(message, secrets), steps, followedEdges, skipped: definition.nodes.filter(node => !steps.some(step => step.nodeId === node.id)).map(node => ({ nodeId: node.id, name: node.name })), context: preview(context, secrets) };
}
