export const GRID = 18;
export const CANVAS_SIZE = Math.round(5000 / GRID) * GRID;
export const MIN_ZOOM = .05;
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
export function selectionBounds(nodes) {
  if (!nodes.length) return null;
  return { left:Math.min(...nodes.map(node => node.x)), top:Math.min(...nodes.map(node => node.y)), right:Math.max(...nodes.map(node => node.x + NODE_WIDTH)), bottom:Math.max(...nodes.map(node => node.y + nodeHeight(node))) };
}
export function selectionDelta(nodes, dx, dy) {
  const bounds = selectionBounds(nodes);
  if (!bounds) return { dx:0, dy:0 };
  // Clamp one snapped translation for the whole selection, never individual nodes.
  return {
    dx:Math.max(Math.ceil((GRID - bounds.left) / GRID) * GRID, Math.min(Math.floor((CANVAS_SIZE - GRID - bounds.right) / GRID) * GRID, snap(dx))),
    dy:Math.max(Math.ceil((2 * GRID - bounds.top) / GRID) * GRID, Math.min(Math.floor((CANVAS_SIZE - 3 * GRID - bounds.bottom) / GRID) * GRID, snap(dy)))
  };
}
export function nodesInSelection(nodes, start, end) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x), top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  return nodes.filter(node => node.x <= right && node.x + NODE_WIDTH >= left && node.y <= bottom && node.y + nodeHeight(node) >= top).map(node => node.id);
}
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const ceilGrid = value => Math.ceil(value / GRID) * GRID;
const branchIndex = (node, port) => node.type === 'switch'
  ? port === 'default' ? node.config.cases.length : node.config.cases.findIndex(entry => entry.id === port)
  : Math.max(0, (node.type === 'find' ? ['zero', 'one', 'many'] : node.type === 'condition' ? ['true', 'false'] : ['next', 'error']).indexOf(port));

// Sugiyama-style layering and constrained barycenter sweeps. IDs break ties, never
// array order or previous coordinates. The executable graph itself is untouched.
function topology(nodes, edges) {
  const items = new Map(nodes.map(node => [node.id, { id:node.id, node, incoming:[], outgoing:[], rank:0 }]));
  for (const edge of edges) {
    const from = items.get(edge.from), to = items.get(edge.to);
    if (from && to) { const link = { from, to, port:edge.port }; from.outgoing.push(link); to.incoming.push(link); }
  }
  for (const item of items.values()) item.outgoing.sort((a, b) => branchIndex(item.node, a.port) - branchIndex(item.node, b.port) || compareId(a.to, b.to));
  const remaining = new Map([...items.values()].map(item => [item, item.incoming.length]));
  const ready = [...items.values()].filter(item => !remaining.get(item)).sort(compareId), ordered = [];
  while (ready.length) {
    const item = ready.shift(); ordered.push(item);
    for (const link of item.outgoing) {
      link.to.rank = Math.max(link.to.rank, item.rank + 1);
      remaining.set(link.to, remaining.get(link.to) - 1);
      if (!remaining.get(link.to)) { ready.push(link.to); ready.sort(compareId); }
    }
  }
  if (ordered.length !== nodes.length) throw new Error('순환하는 연결은 자동 정렬할 수 없습니다.');
  const layers = [];
  for (const item of ordered) { layers[item.rank] ??= []; layers[item.rank].push(item); }
  const position = item => (layers[item.rank].indexOf(item) + .5) / layers[item.rank].length;
  const portBias = link => {
    const siblings = link.from.outgoing;
    return siblings.length < 2 ? 0 : (siblings.indexOf(link) / (siblings.length - 1) - .5) / layers[link.from.rank].length;
  };
  const sortLayer = (row, backwards) => {
    const scores = new Map(row.map(item => {
      const links = backwards ? item.outgoing : item.incoming;
      let total = 0, weight = 0;
      for (const link of links) {
        const other = backwards ? link.to : link.from, w = 1 / (Math.abs(item.rank - other.rank) * Math.sqrt(link.to.incoming.length));
        total += (position(other) + (backwards ? -1 : 1) * portBias(link)) * w; weight += w;
      }
      return [item, weight ? total / weight : position(item)];
    }));
    // Exclusive siblings keep the source port order, including default branches.
    const predecessors = new Map(row.map(item => [item, new Set()]));
    for (const parent of items.values()) {
      const siblings = [...new Set(parent.outgoing.map(link => link.to))].filter(child => child.rank === row[0].rank && child.incoming.every(link => link.from === parent));
      siblings.slice(1).forEach((child, index) => predecessors.get(child).add(siblings[index]));
    }
    const sorted = [];
    while (sorted.length < row.length) {
      const next = row.filter(item => !sorted.includes(item) && [...predecessors.get(item)].every(parent => sorted.includes(parent)))
        .sort((a, b) => scores.get(a) - scores.get(b) || compareId(a, b))[0];
      sorted.push(next);
    }
    return sorted;
  };
  const crossingScore = () => {
    let count = 0;
    const links = ordered.flatMap(item => item.outgoing);
    for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
      const a = links[i], b = links[j];
      if (a.from.rank === b.from.rank && a.to.rank === b.to.rank && (position(a.from) + portBias(a) - position(b.from) - portBias(b)) * (position(a.to) - position(b.to)) < 0) count++;
    }
    return count;
  };
  let best, score = Infinity;
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let rank = 0; rank < layers.length; rank++) layers[rank] = sortLayer(layers[rank], false);
    for (let rank = layers.length - 1; rank >= 0; rank--) layers[rank] = sortLayer(layers[rank], true);
    const current = crossingScore();
    if (current < score) { score = current; best = layers.map(row => row.slice()); }
  }
  return best ?? layers;
}

// Try compact layers before folding. A fold keeps whole layers whenever possible;
// only a layer wider than the chosen column is split into ordered rows.
function packLayers(layers, capacity, pitch, gap) {
  const columns = [{ rows:[], width:0 }]; let column = columns[0], y = 36, splits = 0;
  for (const layer of layers) for (let start = 0; start < layer.length; start += capacity) {
    const row = layer.slice(start, start + capacity), height = Math.max(...row.map(item => nodeHeight(item.node)));
    if (start) splits++;
    if (y + height + 3 * GRID > CANVAS_SIZE) { column = { rows:[], width:0 }; columns.push(column); y = 36; }
    column.rows.push({ items:row, y }); column.width = Math.max(column.width, NODE_WIDTH + (row.length - 1) * pitch);
    y += ceilGrid(height + gap);
  }
  let x = 36;
  const membership = new Map();
  columns.forEach((col, index) => {
    col.x = x; x = ceilGrid(x + col.width + 3 * GRID);
    for (const row of col.rows) for (const item of row.items) membership.set(item, index);
  });
  if (columns.at(-1).x + columns.at(-1).width > CANVAS_SIZE - GRID) return null;
  const cuts = layers.flat().reduce((sum, item) => sum + item.outgoing.filter(link => membership.get(link.to) !== membership.get(item)).length, 0);
  return { columns, pitch, membership, score:splits * 1e6 + cuts * 10000 + (columns.length - 1) * 2000 + (90 - gap) * 10 + (324 - pitch) };
}

export function arrangeNodes(nodes, edges) {
  if (!nodes.length) return { columns:[], folded:false };
  const layers = topology(nodes, edges), widest = Math.max(...layers.map(row => row.length));
  let plan;
  for (const pitch of [324, 288]) for (const gap of [90, 72, 54]) {
    const maxCapacity = Math.min(widest, 1 + Math.floor((CANVAS_SIZE - 3 * GRID - NODE_WIDTH) / pitch));
    for (let capacity = maxCapacity; capacity >= 1; capacity--) {
      const candidate = packLayers(layers, capacity, pitch, gap);
      if (candidate && (!plan || candidate.score < plan.score)) plan = candidate;
    }
  }
  // With the supported 100 nodes and maximum 762px node height, the compact
  // candidate always fits: at least six nodes per column and seventeen columns.
  if (!plan) throw new Error('자동 정렬 영역에 배치할 수 없는 노드 구성입니다.');
  const centers = new Map();
  for (const col of plan.columns) for (const row of col.rows) row.items.forEach((item, i) => centers.set(item, col.x + col.width / 2 + (i - (row.items.length - 1) / 2) * plan.pitch));
  // Align joins with their predecessors without changing row order or spacing.
  // Pool adjacent violations to compact desired coordinates into the column.
  for (let sweep = 0; sweep < 6; sweep++) for (const col of plan.columns) {
    const rows = sweep % 2 ? col.rows.slice().reverse() : col.rows;
    for (const row of rows) {
      const blocks = [];
      row.items.forEach((item, index) => {
        let sum = centers.get(item), weight = 1;
        for (const link of [...item.incoming, ...item.outgoing]) {
          const other = link.from === item ? link.to : link.from;
          if (plan.membership.get(item) !== plan.membership.get(other)) continue;
          const siblings = link.from.outgoing, bias = (siblings.indexOf(link) - (siblings.length - 1) / 2) * plan.pitch;
          const w = 1 / (Math.abs(item.rank - other.rank) * Math.sqrt(link.to.incoming.length));
          sum += (centers.get(other) + (link.to === item ? bias : -bias)) * w; weight += w;
        }
        blocks.push({ sum:sum / weight - index * plan.pitch, count:1 });
        while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).count > blocks.at(-1).sum / blocks.at(-1).count) {
          const last = blocks.pop(); blocks.at(-1).sum += last.sum; blocks.at(-1).count += last.count;
        }
      });
      let index = 0;
      const low = col.x + NODE_WIDTH / 2, high = col.x + col.width - NODE_WIDTH / 2 - (row.items.length - 1) * plan.pitch;
      for (const block of blocks) for (let i = 0; i < block.count; i++, index++) centers.set(row.items[index], Math.max(low, Math.min(high, block.sum / block.count)) + index * plan.pitch);
    }
  }
  for (const col of plan.columns) for (const row of col.rows) for (const item of row.items) Object.assign(item.node, { x:snap(centers.get(item) - NODE_WIDTH / 2), y:row.y });
  return { folded:plan.columns.length > 1, columns:plan.columns.map(col => ({ x:col.x, width:col.width, nodeIds:col.rows.flatMap(row => row.items.map(item => item.id)) })) };
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
