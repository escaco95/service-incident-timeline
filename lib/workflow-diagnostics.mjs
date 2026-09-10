import { validateDefinition, executionDiagnostics, TRIGGERS } from './workflow-definition.mjs';
import { validateReferences, secretNames } from './workflow-file.mjs';

export function diagnoseWorkflow(input, { enabled = false, availableSecrets = [] } = {}) {
  let definition;
  try { definition = validateDefinition(input); }
  catch (error) {
    const nodeIds = Array.isArray(input?.nodes) ? input.nodes.filter(node => typeof node?.id === 'string' && (error.nodeIds?.includes(node.id) || error.message.startsWith(node.id + ':') || error.message.startsWith(node.id + '.config.'))).map(node => node.id) : [];
    return { executable: false, saveAllowed: false, issues: [{ code: 'definition', message: error.message, nodeIds }] };
  }
  const issues = executionDiagnostics(definition);
  // A unique root is needed to determine which event values are available.
  if (definition.nodes.filter(node => TRIGGERS.includes(node.type)).length === 1) {
    validateReferences(definition, { report: (path, message) => {
      const nodeId = path.slice('nodes.'.length);
      if (!issues.some(issue => issue.code === 'reference' && issue.nodeIds[0] === nodeId && issue.message === message)) issues.push({ code: 'reference', message, nodeIds: [nodeId] });
    } });
  }
  for (const node of definition.nodes) {
    if (secretNames({ nodes: [node] }).some(name => !availableSecrets.includes(name))) issues.push({ code: 'missing-secret', message: '참조하는 기존 비밀 변수가 없습니다. 컨텍스트 값 주입 노드로 바꾸거나 참조를 제거해 주세요.', nodeIds: [node.id] });
  }
  return { executable: issues.length === 0, saveAllowed: !enabled || issues.length === 0, issues };
}
