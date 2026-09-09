import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identifier, validInstant } from './operations.mjs';

export const CONTRACT_VERSION = 1;
export const STAGES = Object.freeze(['preflight', 'apply', 'verify', 'query']);
export const RESULT_CODES = Object.freeze(['ready', 'applied', 'already-applied', 'accepted', 'verified', 'mismatch', 'rejected', 'unavailable', 'not-found', 'timeout', 'connector-exception', 'invalid-result', 'stale-sequence']);
const RESULT_RULES = {
  ready: { stages: ['preflight'], processing: ['succeeded'], verification: ['not-performed'] },
  applied: { stages: ['apply', 'query'], processing: ['succeeded'], verification: ['not-performed'] },
  'already-applied': { stages: ['apply', 'query'], processing: ['succeeded'], verification: ['not-performed'] },
  accepted: { stages: ['apply', 'query'], processing: ['pending'], verification: ['not-performed'] },
  verified: { stages: ['verify'], processing: ['succeeded'], verification: ['confirmed'] },
  mismatch: { stages: ['verify'], processing: ['failed'], verification: ['mismatch'] },
  rejected: { stages: STAGES, processing: ['failed'], verification: ['not-performed'] },
  unavailable: { stages: STAGES, processing: ['failed', 'unknown'], verification: ['not-performed', 'unknown'] },
  'not-found': { stages: ['query'], processing: ['unknown'], verification: ['unknown'] },
  timeout: { stages: STAGES, processing: ['unknown'], verification: ['unknown'] },
  'connector-exception': { stages: STAGES, processing: ['unknown'], verification: ['unknown'] },
  'invalid-result': { stages: STAGES, processing: ['unknown'], verification: ['unknown'] },
  'stale-sequence': { stages: ['apply'], processing: ['failed'], verification: ['not-performed'] }
};
const oneOf = (value, values) => values.includes(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new TypeError('Invalid connector contract'); };

/** Pick only public contract fields; never forward event titles, secrets or raw payloads. */
export function transitionContext(input) {
  if (!object(input) || input.contractVersion !== 1 || !id(input.transitionId) || !id(input.attemptId) || !identifier(input.targetId) || !Number.isSafeInteger(input.targetSequence) || input.targetSequence < 1 || !identifier(input.targetState) || (input.previousState !== null && !identifier(input.previousState)) || !validInstant(input.evaluatedAt) || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isSafeInteger(input.mappingVersion) || input.mappingVersion < 1 || !Array.isArray(input.evidence) || input.evidence.length > 1000) invalid();
  const evidence = input.evidence.map(entry => {
    if (!object(entry) || !id(entry.eventId) || !Number.isSafeInteger(entry.version) || entry.version < 1) invalid();
    return { eventId: entry.eventId, version: entry.version };
  });
  return { contractVersion: 1, transitionId: input.transitionId, attemptId: input.attemptId, targetId: input.targetId, targetSequence: input.targetSequence, previousState: input.previousState, targetState: input.targetState, evaluatedAt: input.evaluatedAt, policyVersion: input.policyVersion, mappingVersion: input.mappingVersion, evidence };
}

export function validateCapabilities(input) {
  if (!object(input) || input.contractVersion !== 1 || !oneOf(input.idempotency, ['transition', 'none']) || typeof input.query !== 'boolean') invalid();
  return { contractVersion: 1, idempotency: input.idempotency, query: input.query };
}

export function normalizeResult(input, stage) {
  if (!object(input) || input.contractVersion !== 1 || input.stage !== stage || !STAGES.includes(stage) || !oneOf(input.processing, ['succeeded', 'failed', 'pending', 'unknown']) || !oneOf(input.verification, ['confirmed', 'mismatch', 'not-performed', 'unknown']) || !RESULT_CODES.includes(input.code) || (input.httpStatus !== null && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) || !object(input.retry) || !oneOf(input.retry.action, ['none', 'retry', 'query', 'manual'])) invalid();
  const rule = RESULT_RULES[input.code];
  if (!rule.stages.includes(stage) || !rule.processing.includes(input.processing) || !rule.verification.includes(input.verification)) invalid();
  if (['unknown', 'pending'].includes(input.processing) && !['query', 'manual'].includes(input.retry.action)) invalid();
  if (input.processing === 'unknown' && input.verification !== 'unknown') invalid();
  if (input.processing === 'succeeded' && input.retry.action !== 'none') invalid();
  if (input.verification === 'confirmed' && !identifier(input.observedState)) invalid();
  if (input.retry.afterMs !== undefined && (!Number.isSafeInteger(input.retry.afterMs) || input.retry.afterMs < 0 || input.retry.afterMs > 86400000)) invalid();
  if (input.observedState !== undefined && input.observedState !== null && !identifier(input.observedState)) invalid();
  const result = { contractVersion: 1, stage, processing: input.processing, httpStatus: input.httpStatus, verification: input.verification, code: input.code, retry: { action: input.retry.action, ...(input.retry.afterMs === undefined ? {} : { afterMs: input.retry.afterMs }) } };
  if (input.observedState !== undefined) result.observedState = input.observedState;
  // Optional connector-as-HTTP-service transport is not the target API's status.
  if (input.transportStatus !== undefined) {
    if (input.transportStatus !== null && (!Number.isInteger(input.transportStatus) || input.transportStatus < 100 || input.transportStatus > 599)) invalid();
    result.transportStatus = input.transportStatus;
  }
  if (input.calls !== undefined) {
    if (!Array.isArray(input.calls) || input.calls.length > 20) invalid();
    result.calls = input.calls.map((call, index) => {
      if (!object(call) || call.ordinal !== index + 1 || (call.httpStatus !== null && (!Number.isInteger(call.httpStatus) || call.httpStatus < 100 || call.httpStatus > 599)) || !oneOf(call.processing, ['succeeded', 'failed', 'pending', 'unknown']) || !RESULT_CODES.includes(call.code) || !RESULT_RULES[call.code].processing.includes(call.processing)) invalid();
      return { ordinal: call.ordinal, httpStatus: call.httpStatus, processing: call.processing, code: call.code };
    });
  }
  return result;
}

function unknown(stage, code, canQuery) {
  return { contractVersion: 1, stage, processing: 'unknown', httpStatus: null, verification: 'unknown', code, retry: { action: canQuery ? 'query' : 'manual' } };
}

/**
 * One attempt only. The caller supplies durable recording and owns scheduling/serialization.
 * No retry is performed here, including when abort cannot cancel an external request.
 */
export async function invokeStage(connector, stage, input, { record, timeoutMs = 10000, allowedStates } = {}) {
  const context = transitionContext(input);
  const states = allowedStates ?? [context.targetState, context.previousState].filter(Boolean);
  if (!Array.isArray(states) || states.length > 32 || !states.every(identifier) || !states.includes(context.targetState)) invalid();
  const capabilities = validateCapabilities(connector.capabilities);
  if (!STAGES.includes(stage) || typeof connector[stage] !== 'function' || (stage === 'query' && !capabilities.query) || typeof record !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) invalid();
  const startedAt = new Date().toISOString();
  await record({ type: 'attempt-started', stage, context: structuredClone(context), startedAt });
  const controller = new AbortController();
  let timer;
  let result;
  let timedOut = false;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => connector[stage](structuredClone(context), { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); controller.abort(); }, timeoutMs); })
    ]);
    try {
      result = normalizeResult(raw, stage);
      if (result.retry.action === 'query' && !capabilities.query) invalid();
      if (result.observedState !== undefined && result.observedState !== null && !states.includes(result.observedState)) invalid();
      if (result.verification === 'confirmed' && result.observedState !== context.targetState) invalid();
    }
    catch { result = unknown(stage, 'invalid-result', capabilities.query); }
  } catch { result = unknown(stage, timedOut ? 'timeout' : 'connector-exception', capabilities.query); }
  finally { clearTimeout(timer); }
  const finishedAt = new Date().toISOString();
  // A failed final write propagates: the caller must recover the unfinished attempt.
  await record({ type: 'attempt-finished', stage, transitionId: context.transitionId, attemptId: context.attemptId, targetId: context.targetId, startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), result: structuredClone(result) });
  return result;
}

export async function loadConnector(modulePath, configuration = {}) {
  const module = await import(pathToFileURL(path.resolve(modulePath)).href);
  if (typeof module.createConnector !== 'function') invalid();
  const connector = await module.createConnector(configuration);
  const capabilities = validateCapabilities(connector?.capabilities);
  for (const stage of ['preflight', 'apply', 'verify', ...(capabilities.query ? ['query'] : [])]) if (typeof connector[stage] !== 'function') invalid();
  return connector;
}
