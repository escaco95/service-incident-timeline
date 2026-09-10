import { AppError } from './errors.mjs';
import { validateServiceState } from './service-state.mjs';
import { validateEvent } from './vault.mjs';
import { validateCatalogState } from './services.mjs';
import { validateBranding } from './branding.mjs';
import { validateStoredLogPolicy } from './log-policy.mjs';
import { validateDefinition, plain, NODE_TYPES } from './workflow-definition.mjs';
import { validateDryRunSetup } from './workflow-dry-run.mjs';
import { partitionRecords, RECORD_FIELDS } from './daily-index.mjs';

export const ARCHIVE_FORMAT = 'service-incident-timeline', ARCHIVE_VERSION = 1;
export const archiveDate = (at, timezone = 'UTC') => { const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)); return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('_'); };
const fail = message => { throw new AppError(400, `복원할 데이터가 올바르지 않습니다. ${message}`); };
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const version = value => Number.isSafeInteger(value) && value >= 1;
const string = (value, max) => typeof value === 'string' && value.length <= max;
const RUN_STATUSES = ['queued', 'running', 'success', 'failure', 'canceled', 'interrupted', 'review', 'skipped'];
export function exportedSettings(state, branding) {
  return { metadata: Object.fromEntries(['schemaVersion', 'revision', 'createdAt', 'updatedAt', 'catalog', 'workflows', 'logPolicy', 'serviceState'].filter(key => Object.hasOwn(state, key)).map(key => [key, structuredClone(state[key])])), branding };
}
export function validateSettings(input) {
  const state = input?.metadata;
  if (!plain(state) || state.schemaVersion !== 5 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !date(state.createdAt) || !date(state.updatedAt) || !Array.isArray(state.workflows)) fail('설정 버전을 확인해 주세요.');
  validateServiceState(state.serviceState);
  validateCatalogState({ ...state, events: [] }); validateStoredLogPolicy(state);
  const seen = new Set(); let active = 0;
  for (const flow of state.workflows) {
    if (!plain(flow) || !uuid(flow.id) || seen.has(flow.id) || !version(flow.version) || !version(flow.definitionVersion) || typeof flow.enabled !== 'boolean' || !date(flow.createdAt) || !date(flow.updatedAt) || flow.activatedAt !== null && !date(flow.activatedAt) || flow.deletedAt !== undefined && !date(flow.deletedAt) || !string(flow.createRequestId, 100)) fail('워크플로우 설정을 확인해 주세요.');
    seen.add(flow.id); if (!flow.deletedAt) active++;
    validateDefinition(flow, { executable: flow.enabled });
    if (flow.dryRunSetup !== undefined) {
      if (!plain(flow.dryRunSetup) || !version(flow.dryRunSetup.version)) fail('Dry-Run 설정 버전을 확인해 주세요.');
      validateDryRunSetup(flow.dryRunSetup.setup);
    }
    if (!plain(flow.secrets) || Object.keys(flow.secrets).length > 50) fail('비밀 변수 형식을 확인해 주세요.');
    for (const [key, value] of Object.entries(flow.secrets)) if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !string(value, 4000) || !value) fail('비밀 변수 형식을 확인해 주세요.');
  }
  if (active > 100) fail('워크플로우 개수 한도를 초과했습니다.');
  return exportedSettings(state, validateBranding(input.branding));
}
export function validateManifest(manifest, entries) {
  if (!plain(manifest) || manifest.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION || !date(manifest.createdAt) || !Array.isArray(manifest.files) || !plain(manifest.counts)) fail('이 앱에서 내보낸 ZIP 파일을 선택해 주세요.');
  const names = new Set(['manifest.json']);
  for (const file of manifest.files) {
    if (!plain(file) || typeof file.name !== 'string' || names.has(file.name) || !entries.has(file.name) || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || entries.get(file.name).length !== file.bytes || !/^(?:settings\.json|data\/(?:events|events-open|audit|audit-active)\/(?:\d{4}-\d{2}-\d{2}|undated)\.json)$/.test(file.name)) fail('파일 목록 또는 파일 무결성을 확인해 주세요.');
    names.add(file.name);
  }
  if (!names.has('settings.json') || names.size !== entries.size) fail('누락되거나 불필요한 파일이 있습니다.');
  for (const field of RECORD_FIELDS) if (!Number.isSafeInteger(manifest.counts[field]) || manifest.counts[field] < 0) fail('기록 개수를 확인해 주세요.');
  return manifest;
}
export function validateRecords(data, key, settings) {
  const fields = key.startsWith('events') ? ['events'] : ['changes', 'workflowRuns'];
  if (!plain(data) || !Object.keys(data).length || Object.keys(data).some(field => !fields.includes(field) || !Array.isArray(data[field]))) fail('날짜별 데이터 형식을 확인해 주세요.');
  for (const event of data.events ?? []) {
    validateEvent(event);
    if (!uuid(event.id) || !version(event.version) || !date(event.createdAt) || !date(event.updatedAt)) fail('이벤트 ID 또는 버전을 확인해 주세요.');
  }
  validateCatalogState({ catalog: settings.metadata.catalog, events: data.events ?? [] });
  if ((data.changes?.length ?? 0) > 50000) fail('하루 변경 기록 한도를 초과했습니다.');
  for (const row of data.changes ?? []) if (!plain(row) || !uuid(row.id) || !date(row.at) || !string(row.action, 100) || !row.action || !string(row.actor, 100) || !Object.hasOwn(row, 'before') || !Object.hasOwn(row, 'after')) fail('감사 기록 형식을 확인해 주세요.');
  for (const run of data.workflowRuns ?? []) {
    if (!plain(run) || !uuid(run.id) || !uuid(run.workflowId) || !string(run.workflowName, 120) || !version(run.definitionVersion) || !RUN_STATUSES.includes(run.status) || !date(run.createdAt) || run.startedAt !== undefined && !date(run.startedAt) || run.finishedAt !== undefined && !date(run.finishedAt) || !Array.isArray(run.steps) || run.steps.length > 200 || !plain(run.input) || typeof run.cancelRequested !== 'boolean' || !string(run.requestKey, 300) || !run.requestKey || !['manual', 'automatic', 'rerun'].includes(run.kind) || run.parentId !== null && !uuid(run.parentId)) fail('워크플로우 실행 기록을 확인해 주세요.');
    validateDefinition(run.definition, { executable: true });
    for (const step of run.steps) {
      if (!plain(step) || !run.definition.nodes.some(node => node.id === step.nodeId) || !string(step.name, 120) || !NODE_TYPES.includes(step.type) || ![...RUN_STATUSES, 'handled-error'].includes(step.status) || !date(step.startedAt) || step.finishedAt !== undefined && !date(step.finishedAt) || !Array.isArray(step.attempts) || step.attempts.length > 10) fail('노드 실행 기록을 확인해 주세요.');
      for (const attempt of step.attempts) if (!plain(attempt) || !date(attempt.startedAt) || !version(attempt.number) || attempt.finishedAt !== undefined && !date(attempt.finishedAt)) fail('API 시도 기록을 확인해 주세요.');
    }
  }
  const partitions = partitionRecords(data);
  if (partitions.size !== 1 || !partitions.has(key)) fail('기록의 날짜와 저장 위치가 일치하지 않습니다.');
}
