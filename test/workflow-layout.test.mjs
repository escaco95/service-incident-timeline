import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID, CANVAS_SIZE, NODE_WIDTH, NODE_HEIGHT, NODE_BOUNDS, nodePosition, arrangeNodes, newNodePosition, fitNodesToCanvas, capCameraPan } from '../public/workflow-layout.js';

test('camera center stays within the canvas at every zoom and viewport size, without snapping', () => {
  for (const zoom of [.35, .85, 1, 1.5]) for (const [width, height] of [[300, 600], [920, 800], [6000, 4000]]) {
    for (const [x, y] of [[-20000, -20000], [-1, 5005], [6000, -30], [2502.125, 4096.375], [20000, 20000]]) {
      const original = { panX: width / 2 - x * zoom, panY: height / 2 - y * zoom };
      const capped = capCameraPan(original.panX, original.panY, zoom, width, height);
      assert.ok(Math.abs((width / 2 - capped.panX) / zoom - Math.max(0, Math.min(CANVAS_SIZE, x))) < 1e-9);
      assert.ok(Math.abs((height / 2 - capped.panY) / zoom - Math.max(0, Math.min(CANVAS_SIZE, y))) < 1e-9);
      if (x >= 0 && x <= CANVAS_SIZE && y >= 0 && y <= CANVAS_SIZE) assert.deepEqual(capped, original);
    }
  }
});

function check(nodes) {
  for (const node of nodes) {
    assert.equal(node.x % GRID, 0); assert.equal(node.y % GRID, 0);
    assert.ok(node.x >= NODE_BOUNDS.minX && node.x <= NODE_BOUNDS.maxX);
    assert.ok(node.y >= NODE_BOUNDS.minY && node.y <= NODE_BOUNDS.maxY);
    assert.ok(node.x + NODE_WIDTH < CANVAS_SIZE && node.y + NODE_HEIGHT + 32 < CANVAS_SIZE);
    for (const other of nodes) if (other !== node) assert.ok(node.x + NODE_WIDTH <= other.x || other.x + NODE_WIDTH <= node.x || node.y + NODE_HEIGHT + 32 <= other.y || other.y + NODE_HEIGHT + 32 <= node.y, `Overlapping nodes ${node.id}, ${other.id}`);
  }
}
test('canvas ends at the nearest dot to 5000 and keeps entire nodes inside all four edges', () => {
  assert.equal(CANVAS_SIZE, 5004); assert.equal(CANVAS_SIZE % GRID, 0);
  assert.deepEqual(nodePosition(-100000, -100000), { x: 18, y: 36 });
  assert.deepEqual(nodePosition(100000, 100000), { x: NODE_BOUNDS.maxX, y: NODE_BOUNDS.maxY });
  check([nodePosition(5000, 5000)]);
});
test('100 sequential additions and additions after dragging to the bottom do not overlap', () => {
  const nodes = [];
  for (let i = 0; i < 100; i++) nodes.push({ id: `n${i}`, ...newNodePosition(nodes) });
  check(nodes);
  const moved = [{ id: 'bottom', ...nodePosition(5000, 5000) }];
  for (let i = 0; i < 99; i++) moved.push({ id: `n${i}`, ...newNodePosition(moved) });
  check(moved);
});
test('arrangement wraps long chains and wide branches within the canvas, including legacy coordinates', () => {
  for (const shape of ['chain', 'wide', 'disconnected']) {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, x: 30000, y: i * 216 }));
    const edges = shape === 'disconnected' ? [] : nodes.slice(1).map((node, i) => ({ from: shape === 'chain' ? `n${i}` : 'n0', to: node.id }));
    arrangeNodes(nodes, edges); check(nodes);
    nodes[0].x = 30000; fitNodesToCanvas(nodes, edges); check(nodes);
  }
  const nodes = [{ id: 'root', x: 72, y: 36 }, { id: 'child', x: 468, y: 252 }], original = structuredClone(nodes);
  fitNodesToCanvas(nodes, [{ from: 'root', to: 'child' }]); assert.deepEqual(nodes, original);
});
