import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { indexProject, closeIndex, structuredSdkInfo, type CodeGraphInstance } from './bridge.js';
import { queryStructured, type StructuredContext } from './structured.js';
import type { CodeGraphRequest } from '../../contracts/code-graph.js';
const root = mkdtempSync(join(tmpdir(), 'real-neighborhood-sdk-'));
let instance: CodeGraphInstance, ctx: StructuredContext;
beforeAll(async()=>{
  const files = {
    'package.json':'{"name":"neighborhood-fixture","type":"module"}',
    'base.ts':'export class Base {}\nexport interface Top {}\nexport interface Left extends Top {}\nexport interface Right extends Top {}\nexport interface Diamond extends Left, Right {}\nexport const DATASET = 1;\nexport function readDataset() { return DATASET; }\nexport function leaf() { return 1; }\n',
    'main.ts':'import { Base, Left, Right, leaf } from "./base";\nexport class Child extends Base implements Left, Right {}\nexport function middle() { return leaf(); }\nexport function entry() { return middle(); }\nexport class Outside extends MissingExternal {}\n',
    'other.ts':'export class Base {}\n',
    'javascript.js':'export class JSBase {}\nexport class JSChild extends JSBase {}\nexport function jsLeaf() { return 1; }\nexport function jsCaller() { return jsLeaf(); }\n',
  };
  for(const [name,content] of Object.entries(files)) writeFileSync(join(root,name),content);
  instance=await indexProject(root); const sdk=await structuredSdkInfo(root);
  ctx={assetId:'cg-sdk-mode',projectRoot:root,databasePath:sdk.databasePath,sdkVersion:sdk.version,version:1,commit:null,indexedAt:'fixture',branch:'main'};
},120_000);
afterAll(()=>{ if(instance)closeIndex(instance);rmSync(root,{force:true,recursive:true}); });
function query(name:string, request:CodeGraphRequest, file?:string){
  const s=queryStructured(ctx,'graph-search',{query:name}); const n=s.nodes.find(n=>n.name===name&&(!file||n.filePath===file))!;
  expect(n).toBeDefined(); return queryStructured(ctx,'graph',{...request,nodeId:n.id,indexVersion:s.indexVersion!});
}
describe('real SDK mode semantics',()=>{
  it('verifies direction of all five impact relation kinds from actual indexed edges',()=>{
    const db=new Database(ctx.databasePath,{readonly:true});
    try {
      for(const kind of ['calls','imports','extends','implements','references']){
        const edge=db.prepare('SELECT source,target FROM edges WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as {source:string;target:string}|undefined;
        expect(edge,kind).toBeDefined();
        const s=queryStructured(ctx,'graph-search',{}); const target=s.nodes.find(n=>n.id.endsWith(':'+edge!.target))!;
        const r=queryStructured(ctx,'graph',{mode:'impact',edgeKinds:[kind],nodeId:target.id,indexVersion:s.indexVersion!});
        expect(r.nodes.some(n=>n.id.endsWith(':'+edge!.source)),kind).toBe(true);
        expect(r.edges.some(e=>e.kind===kind&&e.source.endsWith(':'+edge!.source)&&e.target===target.id),kind).toBe(true);
      }
    } finally {db.close();}
  });
  it('returns two-hop chain evidence and same-version source for impacted symbols',()=>{
    const r=query('leaf',{mode:'impact',edgeKinds:['calls']});
    expect(r.nodes.find(n=>n.name==='middle')?.depth).toBe(1);expect(r.nodes.find(n=>n.name==='entry')?.depth).toBe(2);
    const path=r.impactPaths?.find(p=>p.nodeId===r.nodes.find(n=>n.name==='entry')!.id)!;
    expect(path.edgeIds).toHaveLength(2);
    for(const id of path.edgeIds)expect(r.edges.some(e=>e.id===id)).toBe(true);
    for(const n of r.nodes){const source=queryStructured(ctx,'graph-source',{nodeId:n.id,indexVersion:r.indexVersion!});expect(source.source?.filePath).toBe(n.filePath);}
  });
  it('preserves verified TS/JS class inheritance and explicitly reports the interface-extends extraction gap',()=>{
    const child=query('Child',{mode:'hierarchy',direction:'out'});expect(child.edges.filter(e=>e.kind==='implements')).toHaveLength(2);expect(child.edges.filter(e=>e.kind==='extends')).toHaveLength(1);
    expect(child.nodes.filter(n=>n.name==='Base').map(n=>n.filePath)).toEqual(['base.ts']);
    const diamond=query('Diamond',{mode:'hierarchy',direction:'out',depth:2});
    expect(diamond.state).toBe('unsupported');expect(diamond.edges).toHaveLength(0);
    expect(diamond.warnings).toContain('typescript_interface_extends_not_extracted');
    expect(diamond.capabilities.modes.hierarchy.limitations).toContain('typescript_interface_extends_not_extracted');
    const inbound=query('Left',{mode:'hierarchy',direction:'in'});expect(inbound.edges.some(e=>e.kind==='implements')).toBe(true);
    const both=query('Left',{mode:'hierarchy',direction:'both'});expect(both.warnings).toContain('typescript_interface_extends_not_extracted');
    const js=query('JSChild',{mode:'hierarchy',direction:'out'});expect(js.edges).toHaveLength(1);expect(js.nodes.every(n=>n.language==='javascript')).toBe(true);
  });
  it('reports an actual unresolved external base without inventing a relationship',()=>{
    const r=query('Outside',{mode:'hierarchy'});expect(r.state).toBe('empty');expect(r.edges).toEqual([]);
    expect(r.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({name:'MissingExternal',kind:'extends',filePath:'main.ts'})]));
  });
});
