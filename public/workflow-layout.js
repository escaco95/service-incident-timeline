export const GRID = 18;
export const CANVAS_SIZE = Math.round(5000 / GRID) * GRID;
export const NODE_WIDTH = 230, NODE_HEIGHT = 132;
// Leave room for input ports, output labels and the boundary stroke.
export const NODE_BOUNDS = Object.freeze({ minX: GRID, minY: 2 * GRID, maxX: Math.floor((CANVAS_SIZE - NODE_WIDTH - GRID) / GRID) * GRID, maxY: Math.floor((CANVAS_SIZE - NODE_HEIGHT - 3 * GRID) / GRID) * GRID });
const snap = value => Math.round(value / GRID) * GRID;
export function capCameraPan(panX, panY, zoom, width, height) {
  // World coordinates at the viewport center are (size / 2 - pan) / zoom.
  return { panX: Math.max(width / 2 - CANVAS_SIZE * zoom, Math.min(width / 2, panX)), panY: Math.max(height / 2 - CANVAS_SIZE * zoom, Math.min(height / 2, panY)) };
}
export function nodePosition(x, y) {
  return { x: Math.max(NODE_BOUNDS.minX, Math.min(NODE_BOUNDS.maxX, snap(x))), y: Math.max(NODE_BOUNDS.minY, Math.min(NODE_BOUNDS.maxY, snap(y))) };
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
  const positions = [...rows].flatMap(([level, row]) => row.map((node, index) => ({ node, x: snap(65 + (columns - row.length) * 162 + index * 324), y: snap(36 + level * 216) })));
  if (positions.every(({ x, y }) => x <= NODE_BOUNDS.maxX && y <= NODE_BOUNDS.maxY)) {
    for (const { node, x, y } of positions) Object.assign(node, { x, y });
    return;
  }
  // Long chains and wide branches wrap into columns without stacking at the edge.
  const perColumn = Math.floor((NODE_BOUNDS.maxY - 36) / 216) + 1;
  [...nodes].sort((a, b) => levels.get(a.id) - levels.get(b.id)).forEach((node, index) => {
    const column = Math.floor(index / perColumn), offset = index % perColumn;
    Object.assign(node, nodePosition(72 + column * 324, 36 + (column % 2 ? perColumn - 1 - offset : offset) * 216));
  });
}
export function fitNodesToCanvas(nodes, edges) {
  if (nodes.some(node => node.x > NODE_BOUNDS.maxX || node.y > NODE_BOUNDS.maxY)) arrangeNodes(nodes, edges);
  else for (const node of nodes) Object.assign(node, nodePosition(node.x, node.y));
}
export function newNodePosition(nodes) {
  const available = ({ x, y }) => nodes.every(node => x + NODE_WIDTH + GRID <= node.x || node.x + NODE_WIDTH + GRID <= x || y + NODE_HEIGHT + 3 * GRID <= node.y || node.y + NODE_HEIGHT + 3 * GRID <= y);
  const y = nodes.length ? Math.max(...nodes.map(node => node.y)) + 202 : 36;
  const preferred = nodePosition(65 + (nodes.length % 2) * 360, y);
  if (y <= NODE_BOUNDS.maxY && available(preferred)) return preferred;
  for (let y = 36; y <= NODE_BOUNDS.maxY; y += 198) for (let x = 36; x <= NODE_BOUNDS.maxX; x += 270) if (available({ x, y })) return { x, y };
  return preferred;
}
