import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importWorkflow, exportWorkflow } from '../lib/workflow-file.mjs';
import { diagnoseWorkflow } from '../lib/workflow-diagnostics.mjs';
import { arrangeNodes, CANVAS_SIZE, NODE_WIDTH, nodeHeight, nodeBounds, outputPosition } from '../public/workflow-layout.js';
import { routeEdges, createEdgeRouter } from '../public/workflow-routing.js';

// Anonymized reproduction supplied in GitHub issue #3. Never execute its HTTP nodes.
const fixture = () => importWorkflow(JSON.parse(fs.readFileSync(new URL('./fixtures/workflow-branching-39.json', import.meta.url), 'utf8')), { executable:true }).definition;
const structure = definition => ({ name:definition.name, nodes:definition.nodes.map(({x, y, ...node}) => node), edges:definition.edges });
const positions = nodes => Object.fromEntries(nodes.slice().sort((a, b) => a.id.localeCompare(b.id)).map(node => [node.id, [node.x, node.y]]));
function checkPlacement(nodes, edges, layout) {
  const columns = new Map(layout.columns.flatMap((column, i) => column.nodeIds.map(id => [id, i]))), byId = new Map(nodes.map(node => [node.id, node]));
  for (const a of nodes) {
    const bounds = nodeBounds(a);
    assert.equal(a.x % 18, 0); assert.equal(a.y % 18, 0);
    assert.ok(a.x >= bounds.minX && a.x <= bounds.maxX && a.y >= bounds.minY && a.y <= bounds.maxY, a.id);
    for (const b of nodes) if (a !== b) assert.ok(a.x + NODE_WIDTH <= b.x || b.x + NODE_WIDTH <= a.x || a.y + nodeHeight(a) + 32 <= b.y || b.y + nodeHeight(b) + 32 <= a.y, `${a.id} overlaps ${b.id}`);
  }
  for (const edge of edges) {
    assert.ok(columns.get(edge.from) < columns.get(edge.to) || columns.get(edge.from) === columns.get(edge.to) && byId.get(edge.from).y + nodeHeight(byId.get(edge.from)) < byId.get(edge.to).y, `backwards within a column: ${edge.id}`);
  }
}
function checkRoutes(nodes, edges, routes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) {
    const route = routes.get(edge.id), from = byId.get(edge.from), to = byId.get(edge.to), port = outputPosition(from, edge.port);
    assert.equal(route.routed, true, edge.id);
    assert.deepEqual(route.points[0], {x:from.x + port.x, y:from.y + port.y});
    assert.deepEqual(route.points.at(-1), {x:to.x + NODE_WIDTH / 2, y:to.y});
    for (const p of route.points) assert.ok(p.x >= 0 && p.x <= CANVAS_SIZE && p.y >= 0 && p.y <= CANVAS_SIZE);
    route.points.slice(1).forEach((b, i) => {
      const a = route.points[i]; assert.ok(a.x === b.x || a.y === b.y);
      for (const n of nodes) {
        if (i === 0 && n.id === edge.from || i === route.points.length - 2 && n.id === edge.to) continue;
        const intersects = a.x === b.x
          ? a.x > n.x && a.x < n.x + NODE_WIDTH && Math.max(a.y,b.y) > n.y && Math.min(a.y,b.y) < n.y + nodeHeight(n) + 24
          : a.y > n.y && a.y < n.y + nodeHeight(n) + 24 && Math.max(a.x,b.x) > n.x && Math.min(a.x,b.x) < n.x + NODE_WIDTH;
        assert.equal(intersects, false, `${edge.id} crosses ${n.id}`);
      }
    });
  }
}

test('39-node shared joins keep branch order, forward layers and the existing canvas', () => {
  const definition = fixture(), before = structure(definition), layout = arrangeNodes(definition.nodes, definition.edges);
  assert.equal(definition.nodes.length, 39); assert.equal(definition.edges.length, 61);
  assert.equal(layout.folded, false); checkPlacement(definition.nodes, definition.edges, layout);
  const byId = new Map(definition.nodes.map(node => [node.id, node]));
  for (const [parent, join] of [['node-038','node-039'], ['node-039','node-017']]) {
    const children = definition.edges.filter(edge => edge.from === parent && edge.port !== 'default').sort((a, b) => a.port.localeCompare(b.port)).map(edge => byId.get(edge.to));
    assert.equal(new Set(children.map(node => node.y)).size, 1);
    children.slice(1).forEach((node, i) => assert.ok(node.x > children[i].x));
    assert.ok(children.every(node => node.y < byId.get(join).y));
    const defaultNode = byId.get(definition.edges.find(edge => edge.from === parent && edge.port === 'default').to);
    assert.ok(defaultNode.x > children.at(-1).x);
  }
  assert.deepEqual(structure(definition), before);
  const first = structuredClone(definition); arrangeNodes(definition.nodes, definition.edges); assert.deepEqual(definition, first);
  assert.deepEqual(importWorkflow(exportWorkflow(definition), { executable:true }).definition, definition);
  assert.deepEqual(diagnoseWorkflow(definition).issues, []);
  definition.nodes.reverse(); definition.edges.reverse(); arrangeNodes(definition.nodes, definition.edges);
  assert.deepEqual(positions(definition.nodes), positions(first.nodes), 'array order cannot override branch topology');
  checkRoutes(definition.nodes, definition.edges, routeEdges(definition.nodes, definition.edges));
});

function budgetGraph(seed, tall = false) {
  let state = seed;
  const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const nodes = Array.from({length:100}, (_, i) => ({ id:`n${String(i).padStart(3,'0')}`, name:`Node ${i}`, type:i === 0 ? 'start' : i === 99 ? 'finish' : 'switch', config:i === 0 ? {} : i === 99 ? {result:'success',message:''} : {field:'trigger.service',cases:Array.from({length:tall ? 20 : 1 + random(5)}, (_, c) => ({id:`case-${c}`,value:c}))}, x:36, y:36 }));
  const edges = nodes.slice(1).map((node, i) => ({id:`chain-${i}`,from:nodes[i].id,to:node.id,port:i ? 'default' : 'next'}));
  const free = nodes.slice(1,-1).flatMap((node, i) => node.config.cases.map(entry => ({from:node.id,port:entry.id,index:i + 1})));
  while (edges.length < 200) {
    const [outlet] = free.splice(random(free.length),1);
    edges.push({id:`branch-${edges.length}`,from:outlet.from,to:nodes[outlet.index + 1 + random(99 - outlet.index)].id,port:outlet.port});
  }
  return {name:'Bounded DAG',nodes,edges};
}

test('100-node / 200-edge DAGs fold in topology order without shrinking or changing nodes', t => {
  let slowest = 0;
  for (const seed of [1, 9, 42, 2026]) {
    const graph = budgetGraph(seed), before = structure(graph), start = performance.now();
    const layout = arrangeNodes(graph.nodes, graph.edges); slowest = Math.max(slowest, performance.now() - start);
    checkPlacement(graph.nodes, graph.edges, layout); assert.deepEqual(structure(graph),before);
    assert.deepEqual(diagnoseWorkflow(graph).issues, []);
    const first = positions(graph.nodes); graph.nodes.reverse(); graph.edges.reverse(); arrangeNodes(graph.nodes,graph.edges); assert.deepEqual(positions(graph.nodes),first);
    if (seed === 42) checkRoutes(graph.nodes,graph.edges,routeEdges(graph.nodes,graph.edges));
  }
  t.diagnostic(`100 nodes / 200 edges: slowest layout ${slowest.toFixed(1)}ms`);
});

test('maximum-height nodes and very wide layers remain within 5004px', () => {
  for (const wide of [false,true]) {
    const graph = budgetGraph(7,true);
    graph.nodes[0].type = 'switch'; graph.nodes[0].config = graph.nodes[1].config;
    graph.nodes[99].type = 'switch'; graph.nodes[99].config = graph.nodes[1].config;
    if (wide) graph.edges = [];
    const layout = arrangeNodes(graph.nodes,graph.edges); checkPlacement(graph.nodes,graph.edges,layout);
    assert.equal(graph.nodes.length,100); assert.ok(graph.nodes.every(node => nodeHeight(node) === 762));
  }
});

test('near-budget wide branching layers and shared joins preserve every executable port', () => {
  for (const tall of [false,true]) {
    const graph = budgetGraph(17,tall);
    graph.nodes[1].config.cases = Array.from({length:20},(_,i)=>({id:`case-${i}`,value:i}));
    const layers = [[graph.nodes[0]], [graph.nodes[1]]];
    for (let i = 2; i < 99; i += 10) layers.push(graph.nodes.slice(i,Math.min(99,i+10)));
    layers.push([graph.nodes[99]]);
    const free = new Map(graph.nodes.slice(0,-1).map(node=>[node.id,node.type==='start'?['next']:['default',...node.config.cases.map(entry=>entry.id)]]));
    graph.edges = [];
    const connect = (from,to) => graph.edges.push({id:`wide-${graph.edges.length}`,from:from.id,to:to.id,port:free.get(from.id).shift()});
    for (let r = 1; r < layers.length; r++) {
      const before = layers[r-1], after = layers[r];
      for (let i = 0; i < Math.max(before.length,after.length); i++) connect(before[i%before.length],after[i%after.length]);
    }
    for (let r = 1; r < layers.length-1 && graph.edges.length < 200; r++) for (const from of layers[r]) {
      while (free.get(from.id).length && graph.edges.length < 200) connect(from,layers[Math.min(layers.length-1,r+2)].at(-1));
    }
    assert.equal(graph.edges.length,200); assert.deepEqual(diagnoseWorkflow(graph).issues,[]);
    const before = structure(graph), layout = arrangeNodes(graph.nodes,graph.edges);
    checkPlacement(graph.nodes,graph.edges,layout); assert.deepEqual(structure(graph),before);
    checkRoutes(graph.nodes,graph.edges,routeEdges(graph.nodes,graph.edges));
  }
});

test('routing detours around unrelated nodes and caches unchanged geometry', () => {
  const nodes = [{id:'a',x:36,y:36},{id:'obstacle',x:36,y:234},{id:'b',x:36,y:630}].map(node => ({...node,type:'context',config:{entries:[]}}));
  const edges = [{id:'ab',from:'a',to:'b',port:'next'}], router = createEdgeRouter();
  const first = router(nodes,edges); checkRoutes(nodes,edges,first);
  assert.ok(first.get('ab').points.length >= 5); assert.equal(router(nodes,edges),first);
  nodes[1].x = 900;
  const second = router(nodes,edges); assert.notEqual(second,first); checkRoutes(nodes,edges,second);
  assert.equal(second.get('ab').points.length,2);
});
