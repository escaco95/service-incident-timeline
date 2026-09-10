import { CANVAS_SIZE, NODE_WIDTH, nodeHeight, outputPosition } from './workflow-layout.js';

const point = (x, y) => ({ x, y });
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function simplify(points) {
  const result = [];
  for (const p of points) {
    if (result.length && !distance(result.at(-1), p)) continue;
    while (result.length > 1 && ((result.at(-2).x === result.at(-1).x && result.at(-1).x === p.x) || (result.at(-2).y === result.at(-1).y && result.at(-1).y === p.y))) result.pop();
    result.push(p);
  }
  return result;
}
const pathData = points => points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
function clearSegment(a, b, rectangles) {
  if (a.x !== b.x && a.y !== b.y) return false;
  return rectangles.every(r => a.x === b.x
    ? a.x <= r.left || a.x >= r.right || Math.max(a.y, b.y) <= r.top || Math.min(a.y, b.y) >= r.bottom
    : a.y <= r.top || a.y >= r.bottom || Math.max(a.x, b.x) <= r.left || Math.min(a.x, b.x) >= r.right);
}

class Heap {
  items = [];
  push(state, score) {
    const item = { state, score }; let i = this.items.length; this.items.push(item);
    while (i) { const parent = (i - 1) >> 1; if (this.items[parent].score <= score) break; this.items[i] = this.items[parent]; i = parent; }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let next = i * 2 + 1;
        if (next + 1 < this.items.length && this.items[next + 1].score < this.items[next].score) next++;
        if (this.items[next].score >= last.score) break;
        this.items[i] = this.items[next]; i = next;
      }
      this.items[i] = last;
    }
    return first;
  }
}

// Coordinate-compressed orthogonal visibility grid: obstacle boundaries and port
// escape points, rather than every pixel of the canvas. Shared by all edge searches.
function visibilityGrid(rectangles, endpoints) {
  const xs = [...new Set([6, CANVAS_SIZE - 6, ...rectangles.flatMap(r => [r.left, r.right]), ...endpoints.map(p => p.x)])].sort((a, b) => a - b);
  const ys = [...new Set([6, CANVAS_SIZE - 6, ...rectangles.flatMap(r => [r.top, r.bottom]), ...endpoints.map(p => p.y)])].sort((a, b) => a - b);
  const nx = xs.length, ny = ys.length, xIndex = new Map(xs.map((v, i) => [v, i])), yIndex = new Map(ys.map((v, i) => [v, i]));
  const horizontal = new Uint8Array(nx * ny), vertical = new Uint8Array(nx * ny);
  for (const r of rectangles) {
    const left = xIndex.get(r.left), right = xIndex.get(r.right), top = yIndex.get(r.top), bottom = yIndex.get(r.bottom);
    for (let y = top + 1; y < bottom; y++) horizontal.fill(1, y * nx + left, y * nx + right);
    for (let y = top; y < bottom; y++) vertical.fill(1, y * nx + left + 1, y * nx + right);
  }
  return (start, end, initialDirection) => {
    const startIndex = yIndex.get(start.y) * nx + xIndex.get(start.x), endIndex = yIndex.get(end.y) * nx + xIndex.get(end.x);
    const costs = new Float64Array(nx * ny * 2); costs.fill(Infinity);
    const previous = new Int32Array(costs.length); previous.fill(-1);
    const heap = new Heap(), initial = startIndex * 2 + initialDirection;
    costs[initial] = 0; heap.push(initial, distance(start, end));
    while (heap.items.length) {
      const { state, score } = heap.pop(), index = state >> 1, x = index % nx, y = Math.floor(index / nx);
      if (score > costs[state] + distance(point(xs[x], ys[y]), end)) continue;
      if (index === endIndex) {
        const result = [];
        for (let step = state; step !== -1; step = previous[step]) { const at = step >> 1; result.push(point(xs[at % nx], ys[Math.floor(at / nx)])); }
        return result.reverse();
      }
      for (const [next, direction, blocked, length] of [
        [index - 1, 0, !x || horizontal[index - 1], xs[x] - xs[x - 1]],
        [index + 1, 0, x === nx - 1 || horizontal[index], xs[x + 1] - xs[x]],
        [index - nx, 1, !y || vertical[index - nx], ys[y] - ys[y - 1]],
        [index + nx, 1, y === ny - 1 || vertical[index], ys[y + 1] - ys[y]]
      ]) {
        if (blocked) continue;
        const nextState = next * 2 + direction, cost = costs[state] + length + ((state & 1) === direction ? 0 : 24);
        if (cost >= costs[nextState]) continue;
        costs[nextState] = cost; previous[nextState] = state;
        heap.push(nextState, cost + distance(point(xs[next % nx], ys[Math.floor(next / nx)]), end));
      }
    }
    return null;
  };
}

export function directEdgePath(from, to, port) {
  const outlet = outputPosition(from, port), sx = from.x + outlet.x, sy = from.y + outlet.y;
  const tx = to.x + NODE_WIDTH / 2, ty = to.y, bend = Math.max(50, Math.abs(ty - sy) * .5);
  return `M ${sx} ${sy} C ${outlet.side === 'right' ? sx + bend : sx} ${outlet.side === 'right' ? sy : sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`;
}

export function routeEdges(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  // Bottom labels need more clearance than the other three sides.
  const rectangles = nodes.map(node => ({ left:node.x - 12, right:node.x + NODE_WIDTH + 12, top:node.y - 12, bottom:node.y + nodeHeight(node) + 30 }));
  const links = edges.flatMap(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) return [];
    const outlet = outputPosition(from, edge.port), start = point(from.x + outlet.x, from.y + outlet.y), end = point(to.x + NODE_WIDTH / 2, to.y);
    return [{ edge, from, to, start, end, exit:point(start.x + (outlet.side === 'right' ? 18 : 0), start.y + (outlet.side === 'right' ? 0 : 36)), entry:point(end.x, end.y - 18), direction:outlet.side === 'right' ? 0 : 1 }];
  });
  let search;
  const result = new Map();
  for (const link of links) {
    const { start, end, exit, entry, direction } = link;
    const candidates = [[exit, entry], [exit, point(entry.x, exit.y), entry], [exit, point(exit.x, entry.y), entry],
      [exit, point(exit.x, (exit.y + entry.y) / 2), point(entry.x, (exit.y + entry.y) / 2), entry]]
      .map(simplify).filter(points => points.slice(1).every((p, i) => clearSegment(points[i], p, rectangles)))
      .sort((a, b) => a.reduce((sum, p, i) => sum + (i ? distance(a[i - 1], p) : 0), a.length * 24) - b.reduce((sum, p, i) => sum + (i ? distance(b[i - 1], p) : 0), b.length * 24));
    search ??= candidates.length ? null : visibilityGrid(rectangles, links.flatMap(item => [item.exit, item.entry]));
    const middle = candidates[0] ?? search(exit, entry, direction);
    // Overlapping manually positioned nodes may have no free escape corridor.
    const points = middle ? simplify([start, ...middle, end]) : null;
    result.set(link.edge.id, { points, path:points ? pathData(points) : directEdgePath(link.from, link.to, link.edge.port), routed:!!points });
  }
  return result;
}

export function createEdgeRouter() {
  let key, paths;
  return (nodes, edges) => {
    const next = JSON.stringify([nodes.map(node => [node.id, node.x, node.y, nodeHeight(node), node.type, node.config?.cases?.map(entry => entry.id)]), edges]);
    if (key !== next) { paths = routeEdges(nodes, edges); key = next; }
    return paths;
  };
}
