// Review-only harness: all targets and attempt records live in this process's memory.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateServices, validatePolicy, prepareEvent, previewPlan } from '../lib/operations.mjs';
import { loadConnector, invokeStage } from '../lib/connector-contract.mjs';

const scenario = process.argv[2] ?? 'success';
if (!['success', 'response-lost', 'http-business-failure', 'accepted', 'verification-mismatch', 'exception', 'invalid-result'].includes(scenario)) throw new Error('Unknown mock scenario');
const example = JSON.parse(await readFile(new URL('../examples/operations.example.json', import.meta.url), 'utf8'));
const operations = { version: 1, services: validateServices(example.services), policy: validatePolicy(example.policy, 1) };
const makeEvent = (id, start, end, impact) => {
  const input = { title: '가상 운영 기록', service: '', description: '', category: 'maintenance', start: `2026-09-09T${start}:00.000Z`, end: `2026-09-09T${end}:00.000Z`, services: [{ kind: 'catalog', id: 'resource-a' }], execution: { enabled: true, impact, endMode: 'scheduled', confirmAuthorization: true, confirmSettingsVersion: operations.version } };
  return { id, version: 1, ...prepareEvent(input, input, operations) };
};
const events = [makeEvent('event-limited', '09:00', '11:00', 'limited'), makeEvent('event-unavailable', '09:30', '10:00', 'unavailable')];
const plan = previewPlan(events, operations, '2026-09-09T08:00:00.000Z', '2026-09-09T12:00:00.000Z');
const connector = await loadConnector(fileURLToPath(new URL('../connectors/mock.mjs', import.meta.url)), { scenario });
const records = [], sequences = new Map();
for (const change of plan.transitions.filter(item => item.applyRequired)) {
  const sequence = (sequences.get(change.targetId) ?? 0) + 1;
  sequences.set(change.targetId, sequence);
  const context = { contractVersion: 1, transitionId: randomUUID(), targetId: change.targetId, targetSequence: sequence, previousState: change.previousState, targetState: change.targetState, evaluatedAt: change.evaluatedAt, policyVersion: operations.policy.version, mappingVersion: 1, evidence: change.evidence };
  const stage = name => invokeStage(connector, name, { ...context, attemptId: randomUUID() }, { record: async item => records.push(item), timeoutMs: 25 });
  if ((await stage('preflight')).processing !== 'succeeded') break;
  let result = await stage('apply');
  if (['unknown', 'pending'].includes(result.processing) && result.retry.action === 'query') result = await stage('query');
  if (result.processing !== 'succeeded' || (await stage('verify')).verification !== 'confirmed') break;
}
console.log(JSON.stringify({ mode: 'mock-only', durable: false, scenario, plan, records }, null, 2));
