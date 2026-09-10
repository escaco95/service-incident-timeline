export const GRID = 18;
export const CANVAS_SIZE = Math.round(5000 / GRID) * GRID;
export const NODE_WIDTH = 230, NODE_HEIGHT = 132;
export const SWITCH_ROW_HEIGHT = 30;
export const nodeHeight = node => NODE_HEIGHT + (node?.type === 'switch' ? (node.config.cases.length + 1) * SWITCH_ROW_HEIGHT : 0);
export function outputPosition(node, port) {
  if (node.type === 'switch') {
    const index = port === 'default' ? node.config.cases.length : node.config.cases.findIndex(entry => entry.id === port);
    return { x:NODE_WIDTH, y:NODE_HEIGHT + (index + .5) * SWITCH_ROW_HEIGHT, side:'right' };
  }
  const ratio = port === 'true' ? .28 : ['false', 'error'].includes(port) ? .72 : node.type === 'find' ? { zero:.2, one:.5, many:.8 }[port] : .5;
  return { x:NODE_WIDTH * ratio, y:nodeHeight(node), side:'bottom' };
}
// Leave room for input ports, output labels and the boundary stroke.
export const NODE_BOUNDS = Object.freeze({ minX: GRID, minY: 2 * GRID, maxX: Math.floor((CANVAS_SIZE - NODE_WIDTH - GRID) / GRID) * GRID, maxY: Math.floor((CANVAS_SIZE - NODE_HEIGHT - 3 * GRID) / GRID) * GRID });
export const nodeBounds = node => ({ ...NODE_BOUNDS, maxY:Math.floor((CANVAS_SIZE - nodeHeight(node) - 3 * GRID) / GRID) * GRID });
const snap = value => Math.round(value / GRID) * GRID;
export function capCameraPan(panX, panY, zoom, width, height) {
  // World coordinates at the viewport center are (size / 2 - pan) / zoom.
  return { panX: Math.max(width / 2 - CANVAS_SIZE * zoom, Math.min(width / 2, panX)), panY: Math.max(height / 2 - CANVAS_SIZE * zoom, Math.min(height / 2, panY)) };
}
export function nodePosition(x, y, node) {
  const bounds = nodeBounds(node);
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, snap(x))), y: Math.max(bounds.minY, Math.min(bounds.maxY, snap(y))) };
}
export function arrangeNodes(nodes, edges) {
  const levels = new Map(nodes.map(node => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) if (levels.get(edge.to) <= levels.get(edge.from)) { levels.set(edge.to, levels.get(edge.from) + 1); changed = true; }
    if (!changed) break;
  }
  const rows = new Map();
  for (const node of nodes) { const level = levels.get(node.id); if (!rows.has(level)) rows.set(level, []); rows.get(level).push(node); }
  const columns = Math.max(2, ...[...rows.values()].map(row => row.length));
  let nextY = 36;
  const positions = [...rows].sort(([a], [b]) => a - b).flatMap(([, row]) => {
    const y = nextY;
    nextY += Math.ceil((Math.max(...row.map(nodeHeight)) + 84) / GRID) * GRID;
    return row.map((node, index) => ({ node, x:snap(65 + (columns - row.length) * 162 + index * 324), y }));
  });
  if (positions.every(({ node, x, y }) => x <= NODE_BOUNDS.maxX && y <= nodeBounds(node).maxY)) {
    for (const { node, x, y } of positions) Object.assign(node, { x, y });
    return;
  }
  // Long chains and wide branches wrap into columns without stacking at the edge.
  let x = 72, y = 36;
  [...nodes].sort((a, b) => levels.get(a.id) - levels.get(b.id)).forEach(node => {
    if (y > nodeBounds(node).maxY) { x += 270; y = 36; }
    Object.assign(node, nodePosition(x, y, node));
    y += Math.ceil((nodeHeight(node) + 3 * GRID) / GRID) * GRID;
  });
}
export function fitNodesToCanvas(nodes, edges) {
  if (nodes.some(node => node.x > NODE_BOUNDS.maxX || node.y > nodeBounds(node).maxY)) arrangeNodes(nodes, edges);
  else for (const node of nodes) Object.assign(node, nodePosition(node.x, node.y, node));
}
export function newNodePosition(nodes, added) {
  const available = ({ x, y }) => nodes.every(node => x + NODE_WIDTH + GRID <= node.x || node.x + NODE_WIDTH + GRID <= x || y + nodeHeight(added) + 3 * GRID <= node.y || node.y + nodeHeight(node) + 3 * GRID <= y);
  const y = nodes.length ? Math.max(...nodes.map(node => node.y + nodeHeight(node))) + 70 : 36;
  const preferred = nodePosition(65 + (nodes.length % 2) * 360, y, added);
  if (y <= nodeBounds(added).maxY && available(preferred)) return preferred;
  const rows = [...new Set([36, ...nodes.map(node => Math.ceil((node.y + nodeHeight(node) + 3 * GRID) / GRID) * GRID)])].sort((a, b) => a - b);
  for (const y of rows.filter(y => y <= nodeBounds(added).maxY)) for (let x = 36; x <= NODE_BOUNDS.maxX; x += 270) if (available({ x, y })) return { x, y };
  return preferred;
}
