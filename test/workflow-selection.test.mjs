import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID, CANVAS_SIZE, nodeHeight, nodeBounds, selectionDelta, nodesInSelection } from '../public/workflow-layout.js';
import { duplicateSelection } from '../public/workflow-selection.js';
import { validateDefinition } from '../lib/workflow-definition.mjs';
import { validateReferences } from '../lib/workflow-file.mjs';

const node = (id,type,config={},x=36,y=36) => ({id,name:id,type,config,x,y});
const edge = (from,to,port='next') => ({id:from+'-'+to,from,to,port});
const tall = node('tall','switch',{field:'trigger.service',cases:Array.from({length:20},(_,i)=>({id:'case-'+i,value:i}))},396,252);

test('selection moves as one snapped rectangle at every boundary, including tall switch nodes', () => {
  const nodes = [node('short','context',{},72,72),tall];
  for(const [dx,dy] of [[20000,20000],[-20000,-20000],[-20000,20000],[20000,-20000],[27,44],[4,7]]) {
    const delta = selectionDelta(nodes,dx,dy);
    for(const source of nodes) {
      const moved = {...source,x:source.x+delta.dx,y:source.y+delta.dy}, bounds = nodeBounds(moved);
      assert.equal(moved.x%GRID,0); assert.equal(moved.y%GRID,0);
      assert.ok(moved.x>=bounds.minX&&moved.x<=bounds.maxX&&moved.y>=bounds.minY&&moved.y<=bounds.maxY);
      assert.ok(moved.y+nodeHeight(moved)<CANVAS_SIZE);
      assert.equal(moved.x-nodes[0].x-delta.dx,source.x-nodes[0].x);
      assert.equal(moved.y-nodes[0].y-delta.dy,source.y-nodes[0].y);
    }
    if(dx>10000)assert.ok(nodes.some(n=>n.x+delta.dx===nodeBounds(n).maxX));
    if(dy>10000)assert.ok(nodes.some(n=>n.y+delta.dy===nodeBounds(n).maxY));
  }
  const capped = selectionDelta(nodes,20000,20000), moved = nodes.map(n=>({...n,x:n.x+capped.dx,y:n.y+capped.dy}));
  assert.deepEqual(selectionDelta(moved,-18,-18),{dx:-18,dy:-18});
  assert.deepEqual(selectionDelta([],20,20),{dx:0,dy:0});
});

test('marquee selects intersecting nodes in both directions using each node full height', () => {
  const nodes = [node('first','context',{},72,72),tall,node('outside','finish',{},1404,252)];
  for(const [a,b] of [[{x:100,y:100},{x:600,y:1100}],[{x:600,y:1100},{x:100,y:100}]])assert.deepEqual(nodesInSelection(nodes,a,b),['first','tall']);
  assert.deepEqual(nodesInSelection(nodes,{x:410,y:900},{x:450,y:950}),['tall']);
  assert.deepEqual(nodesInSelection(nodes,{x:800,y:20},{x:900,y:120}),[]);
});

test('bulk duplication preserves relative positions, internal connections, typed cases and internal value references', () => {
  const nodes = [node('root','start'),node('values','context',{entries:[{key:'token',value:'{{nodes.http.status}}'}]},396,72),node('http','http',{url:'https://example.invalid',method:'POST',headers:'{}',body:'{}'},396,288),node('route','switch',{field:'nodes.http.status',cases:[{id:'case-ok',value:200},{id:'case-literal',value:'{{nodes.http.status}}'}]},720,504),node('done','finish',{message:'{{nodes.http.status}}'},1044,504)];
  const edges = [edge('root','values'),edge('values','http'),edge('http','route'),edge('route','done','case-ok')];
  const original = structuredClone({nodes,edges}); let count=0;
  const result = duplicateSelection(nodes,edges,['values','http','route'],type=>type+'-copy-'+(++count));
  assert.deepEqual({nodes,edges},original);
  assert.equal(result.nodes.length,3); assert.equal(result.edges.length,2);
  assert.equal(result.nodes[0].config.entries[0].value,'{{nodes.http.status}}','injected values stay literal');
  assert.equal(result.nodes[2].config.field,'nodes.'+result.nodes[1].id+'.status');
  assert.deepEqual(result.nodes[2].config.cases,nodes[3].config.cases,'case values and IDs remain literal');
  for(let i=0;i<result.nodes.length;i++){assert.equal(result.nodes[i].x-nodes[i+1].x,36);assert.equal(result.nodes[i].y-nodes[i+1].y,36);}
  assert.deepEqual(result.edges.map(e=>[e.from,e.to]),[[result.nodes[0].id,result.nodes[1].id],[result.nodes[1].id,result.nodes[2].id]]);
  const def = validateDefinition({name:'Cloned flow',nodes:[nodes[0],...result.nodes],edges:[edge('root',result.nodes[0].id),...result.edges]},{executable:true});
  validateReferences(def);
  const single = duplicateSelection(nodes,edges,['route'],()=> 'route-copy');
  assert.deepEqual(single.nodes[0].config,nodes[3].config); assert.deepEqual(single.edges,[]);
});

test('bulk duplication rewrites only interpreted references, including compound rules and JSON $path', () => {
  const sources = [node('http','http',{url:'https://example.invalid/{{ nodes.provider.id }}',headers:'{"X-ID":"{{nodes.provider.id}}"}',body:JSON.stringify({data:{$path:'nodes.provider.body'},literal:'nodes.provider.body',text:'{{nodes.external.value}}'})}),node('condition','condition',{field:'nodes.provider.ok',valueSource:'path',value:'nodes.provider.other',rules:JSON.stringify({all:[{field:'nodes.provider.ok',value:'"nodes.provider.literal"'},{field:'trigger.service',valueSource:'path',value:'nodes.provider.service'}]})}),node('find','find',{source:'nodes.provider.items',field:'nodes.provider.key',valueSource:'path',value:'nodes.provider.id'}),node('clock','datetime',{source:'nodes.provider.time',pattern:"yyyy 'nodes.provider.time'"}),node('finish','finish',{message:'{{ nodes.provider.name }} / {{nodes.external.value}}'}),node('provider','http',{url:'https://example.invalid'})];
  let index=0;const result=duplicateSelection(sources,[],sources.map(n=>n.id),()=> 'copy-'+(++index)), provider=result.nodes.at(-1).id;
  assert.equal(result.nodes[0].config.url,'https://example.invalid/{{ nodes.'+provider+'.id }}');
  assert.deepEqual(JSON.parse(result.nodes[0].config.body),{data:{$path:'nodes.'+provider+'.body'},literal:'nodes.provider.body',text:'{{nodes.external.value}}'});
  const rules=JSON.parse(result.nodes[1].config.rules);
  assert.equal(rules.all[0].field,'nodes.'+provider+'.ok');assert.equal(rules.all[0].value,'"nodes.provider.literal"');
  assert.equal(rules.all[1].value,'nodes.'+provider+'.service');
  assert.equal(result.nodes[2].config.source,'nodes.'+provider+'.items');assert.equal(result.nodes[2].config.field,'nodes.provider.key');
  assert.equal(result.nodes[3].config.source,'nodes.'+provider+'.time');assert.equal(result.nodes[3].config.pattern,sources[3].config.pattern);
  assert.equal(result.nodes[4].config.message,'{{ nodes.'+provider+'.name }} / {{nodes.external.value}}');
});

test('bulk duplicate limits reject the entire operation and boundary placement never distorts a group', () => {
  const nodes=Array.from({length:99},(_,i)=>node('n'+i,'context'));
  const never=()=>{throw Error('IDs must not be allocated on failure');};
  assert.throws(()=>duplicateSelection(nodes,[],['n0','n1'],never),/100/);
  assert.throws(()=>duplicateSelection(nodes.slice(0,2),Array.from({length:200},()=>edge('n0','n1')),['n0','n1'],never),/200/);
  const initial=[node('a','context',{},72,72),tall], delta=selectionDelta(initial,20000,20000), atEdge=initial.map(n=>({...n,x:n.x+delta.dx,y:n.y+delta.dy}));
  let i=0;const copied=duplicateSelection(atEdge,[],['a','tall'],()=> 'copy-'+(++i));
  assert.equal(copied.nodes[0].x-atEdge[0].x,copied.nodes[1].x-atEdge[1].x);
  assert.equal(copied.nodes[0].y-atEdge[0].y,copied.nodes[1].y-atEdge[1].y);
  for(const n of copied.nodes)assert.ok(n.x<=nodeBounds(n).maxX&&n.y<=nodeBounds(n).maxY);
});

test('bulk duplication also remaps references to a whole node output without matching similar IDs', () => {
  const nodes=[node('provider','context',{entries:[]}),node('http','http',{url:'https://example.invalid',body:'{"whole":{"$path":"nodes.provider"},"text":"{{ nodes.provider }} / {{nodes.provider-other}}"}'}),node('route','switch',{field:'nodes.provider',cases:[]})];
  let i=0;const copied=duplicateSelection(nodes,[],nodes.map(n=>n.id),()=> 'copy-'+(++i));
  assert.deepEqual(JSON.parse(copied.nodes[1].config.body),{whole:{$path:'nodes.copy-1'},text:'{{ nodes.copy-1 }} / {{nodes.provider-other}}'});
  assert.equal(copied.nodes[2].config.field,'nodes.copy-1');
});
