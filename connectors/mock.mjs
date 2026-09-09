// Synthetic local connector. It performs no network requests and keeps its fake target in RAM.
export function createConnector({ targets = ['resource-a', 'resource-b'], scenario = 'success' } = {}) {
  const states = new Map(targets.map(id => [id, null]));
  const sequences = new Map();
  const transitions = new Map();
  const result = (stage, code, overrides = {}) => ({ contractVersion: 1, stage, processing: 'succeeded', httpStatus: null, verification: 'not-performed', code, retry: { action: 'none' }, ...overrides });
  const missing = stage => result(stage, 'rejected', { processing: 'failed', retry: { action: 'manual' } });
  return {
    capabilities: { contractVersion: 1, idempotency: 'transition', query: true },
    async preflight(context) { return states.has(context.targetId) ? result('preflight', 'ready') : missing('preflight'); },
    async apply(context, { signal } = {}) {
      if (!states.has(context.targetId)) return missing('apply');
      const known = transitions.get(context.transitionId);
      if (known) return known.targetId === context.targetId && known.targetState === context.targetState && known.targetSequence === context.targetSequence ? result('apply', 'already-applied') : missing('apply');
      if ((sequences.get(context.targetId) ?? 0) >= context.targetSequence) return result('apply', 'stale-sequence', { processing: 'failed', retry: { action: 'manual' } });
      if (scenario === 'http-business-failure') return result('apply', 'rejected', { httpStatus: 200, processing: 'failed' });
      if (scenario === 'exception') throw new Error('synthetic-secret: never retain this message');
      if (scenario === 'invalid-result') return { secret: 'synthetic-secret', rawBody: 'not part of the contract' };
      states.set(context.targetId, context.targetState);
      sequences.set(context.targetId, context.targetSequence);
      transitions.set(context.transitionId, { targetId: context.targetId, targetState: context.targetState, targetSequence: context.targetSequence });
      if (scenario === 'response-lost') await new Promise((_, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      if (scenario === 'accepted') return result('apply', 'accepted', { httpStatus: 202, processing: 'pending', retry: { action: 'query', afterMs: 1000 } });
      return result('apply', 'applied');
    },
    async verify(context) {
      if (!states.has(context.targetId)) return missing('verify');
      if (scenario === 'verification-mismatch') states.set(context.targetId, null); // Simulate external drift to an unmapped state.
      const observedState = states.get(context.targetId);
      const matches = observedState === context.targetState;
      return result('verify', matches ? 'verified' : 'mismatch', { processing: matches ? 'succeeded' : 'failed', verification: matches ? 'confirmed' : 'mismatch', observedState, retry: { action: matches ? 'none' : 'manual' } });
    },
    async query(context) {
      const known = transitions.get(context.transitionId);
      if (!known) return result('query', 'not-found', { processing: 'unknown', verification: 'unknown', retry: { action: 'manual' } });
      if (known.targetId !== context.targetId || known.targetState !== context.targetState || known.targetSequence !== context.targetSequence) return missing('query');
      return result('query', 'already-applied', { observedState: states.get(context.targetId) });
    }
  };
}
