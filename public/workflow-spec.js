// Shared by the editor, validator and generated file schema.
export const LIMITS = Object.freeze({ nodes: 100, edges: 200, bytes: 1048576, attempts: 100 });
export const TRIGGERS = ['start', 'end', 'cron', 'service-state'];
export const CONFIG_FIELDS = {
  start: { service: [100, ''], executionService: [100, ''] }, end: { service: [100, ''], executionService: [100, ''] },
  cron: { executionService: [100, ''], expression: [100, ''], timezone: [100, 'Asia/Seoul'] },
  'service-state': { service: [100, ''] },
  condition: { field: [200, ''], operator: [30, 'equals'], value: [2000, ''], valueSource: [10, 'literal'], rules: [16000, ''] },
  find: { source: [200, 'response.body'], field: [200, 'id'], value: [2000, ''], valueSource: [10, 'literal'] },
  datetime: { source: [200, 'now'], timezone: [100, 'Asia/Seoul'], format: [20, 'iso'] },
  http: { method: [10, 'GET'], url: [2000, ''], headers: [16000, '{}'], body: [64000, ''], onError: [20, 'stop'], intent: [10, 'auto'], outputMode: [10, 'summary'], outputPaths: [2000, ''], idempotency: [10, 'none'] },
  finish: { result: [20, 'success'], message: [2000, ''] }
};
export const NODE_TYPES = Object.keys(CONFIG_FIELDS);
export const ports = node => node.type === 'finish' ? [] : node.type === 'condition' ? ['true', 'false'] : node.type === 'find' ? ['zero', 'one', 'many'] : node.type === 'http' && node.config.onError === 'branch' ? ['next', 'error'] : ['next'];
export const isChange = node => node.type === 'http' && (node.config.intent === 'change' || (!node.config.intent || node.config.intent === 'auto') && !['GET', 'HEAD'].includes(node.config.method));
