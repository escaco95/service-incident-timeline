import { LIMITS } from './workflow-spec.js';
import { GRID, selectionDelta, nodePosition, newNodePosition } from './workflow-layout.js';

function remapConfig(node, ids) {
  const config = structuredClone(node.config);
  const path = value => typeof value === 'string' ? value.replace(/^nodes\.([\w-]+)(?=\.|$)/, (whole, id) => ids.has(id) ? 'nodes.' + ids.get(id) : whole) : value;
  const template = value => typeof value === 'string' ? value.replace(/(\{\{\s*)nodes\.([\w-]+)(?=\.|\s*\}\})/g, (whole, prefix, id) => ids.has(id) ? prefix + 'nodes.' + ids.get(id) : whole) : value;
  const comparison = rule => {
    if (!rule || typeof rule !== 'object') return;
    rule.field = path(rule.field);
    if (rule.valueSource === 'path') rule.value = path(rule.value);
    for (const group of ['all','any']) if (Array.isArray(rule[group])) rule[group].forEach(comparison);
  };
  if (node.type === 'switch') config.field = path(config.field);
  if (node.type === 'datetime') config.source = path(config.source);
  if (node.type === 'condition' || node.type === 'find') {
    comparison(config);
    if (node.type === 'find') { config.source = path(config.source); config.field = node.config.field; }
    if (config.rules) {
      try { const rules = JSON.parse(config.rules); comparison(rules); config.rules = JSON.stringify(rules); } catch { /* Keep incomplete drafts editable. */ }
    }
  }
  if (node.type === 'http') {
    for (const key of ['url','headers','body']) config[key] = template(config[key]);
    try {
      const body = JSON.parse(config.body); let changed = false;
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (Object.keys(value).length === 1 && typeof value.$path === 'string') { const next = path(value.$path); changed ||= next !== value.$path; value.$path = next; }
        else Object.values(value).forEach(walk);
      };
      walk(body); if (changed) config.body = JSON.stringify(body, null, 2);
    } catch { /* Non-JSON bodies still use string templates. */ }
  }
  if (node.type === 'finish') config.message = template(config.message);
  return config;
}

export function duplicateSelection(nodes, edges, selectedIds, newId) {
  const selected = new Set(selectedIds), sources = nodes.filter(node => selected.has(node.id));
  const internal = sources.length > 1 ? edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)) : [];
  if (nodes.length + sources.length > LIMITS.nodes) throw new Error('선택한 노드를 모두 복제하면 최대 100개를 초과합니다.');
  if (edges.length + internal.length > LIMITS.edges) throw new Error('선택한 연결을 함께 복제하면 최대 200개를 초과합니다.');
  const ids = new Map(sources.map(node => [node.id, newId('node')]));
  let delta = selectionDelta(sources, 2 * GRID, 2 * GRID);
  if (!delta.dx && !delta.dy) delta = selectionDelta(sources, -2 * GRID, -2 * GRID);
  const copies = sources.map(source => ({ ...structuredClone(source), id:ids.get(source.id), name:`${source.name.slice(0,76)} 복사본`, config:sources.length > 1 ? remapConfig(source, ids) : structuredClone(source.config), x:source.x + delta.dx, y:source.y + delta.dy }));
  if (copies.length === 1) {
    Object.assign(copies[0], nodePosition(sources[0].x + 2 * GRID, sources[0].y + 2 * GRID, copies[0]));
    if (nodes.some(node => node.x === copies[0].x && node.y === copies[0].y)) Object.assign(copies[0], newNodePosition(nodes,copies[0]));
  }
  return { nodes:copies, edges:internal.map(edge => ({...edge,id:newId('edge'),from:ids.get(edge.from),to:ids.get(edge.to)})) };
}
