import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryStructured, validateStructuredRequest, type StructuredContext } from './structured.js';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cg-neighborhood-')); roots.push(root);
  const db = new Database(join(root, 'index.db'));
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);
    CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,file_path TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_unresolved_from_node ON unresolved_refs(from_node_id);`);
  const ctx: StructuredContext = { assetId: 'cg-mode', projectRoot: root, databasePath: join(root, 'index.db'), sdkVersion: '1.6.2', version: 1, commit: 'abc', indexedAt: 'today', branch: 'main' };
  const n = (id: string, kind = 'function', language = 'typescript') => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,1,5)').run(id, kind, id, id, `${id}.ts`, language);
  let serial = 1;
  const e = (source: string, target: string, kind = 'calls') => db.prepare('INSERT INTO edges VALUES (?,?,?,?,2,0)').run(serial++, source, target, kind);
  const u = (source: string, name: string, kind = 'extends') => db.prepare('INSERT INTO unresolved_refs VALUES (?,?,?,?,?,2,0)').run(serial++, source, name, kind, `${source}.ts`);
  const start = (name: string, request: CodeGraphRequest) => {
    const found = queryStructured(ctx, 'graph-search', { query: name }); const node = found.nodes.find(n => n.name === name)!;
    const q = { ...request, nodeId: node.id, indexVersion: found.indexVersion! }; return { q, r: queryStructured(ctx, 'graph', q) };
  };
  return { db, ctx, n, e, u, start };
}
function verifyPaths(results: CodeGraphResponse[]) {
  const nodes = new Set(results.flatMap(r => r.nodes.map(n => n.id)));
  const edges = new Map(results.flatMap(r => r.edges.map(e => [e.id, e] as const)));
  for (const r of results) for (const path of r.impactPaths ?? []) {
    expect(path.nodeIds[0]).toBe(path.nodeId); expect(path.nodeIds.at(-1)).toBe(r.focusId);
    expect(path.edgeIds.length).toBe(path.nodeIds.length - 1);
    for (let i = 0; i < path.edgeIds.length; i++) {
      expect(nodes.has(path.nodeIds[i])).toBe(true); const edge = edges.get(path.edgeIds[i]); expect(edge).toBeDefined();
      expect(edge!.source).toBe(path.nodeIds[i]); expect(edge!.target).toBe(path.nodeIds[i + 1]);
    }
  }
}
describe('impact and hierarchy bounded neighborhoods', () => {
  it('uses two-hop reverse impact while retaining actual edge direction and shortest paths', () => {
    const f = fixture(); ['a','b','c','d','x'].forEach(x => f.n(x)); f.e('a','b'); f.e('b','c'); f.e('d','a'); f.e('x','c','contains'); f.e('c','c'); f.db.close();
    const { r } = f.start('c', { mode: 'impact' });
    expect(r.nodes.map(n => [n.name,n.depth])).toEqual(expect.arrayContaining([['c',0],['b',1],['a',2]]));
    expect(r.nodes.map(n => n.name)).not.toContain('d'); expect(r.nodes.map(n => n.name)).not.toContain('x');
    expect(r.warnings).toContain('static_analysis_potential_impact'); verifyPaths([r]);
  });
  it('keeps BFS shortest paths through a diamond, multiple relation types, and cycles', () => {
    const f = fixture(); ['a','b','c','root'].forEach(x => f.n(x)); f.e('a','b'); f.e('a','c','references'); f.e('b','root','imports'); f.e('c','root','extends'); f.e('root','a','implements'); f.db.close();
    const { r } = f.start('root', { mode: 'impact', depth: 5 });
    expect(r.nodes).toHaveLength(4); expect(r.nodes.find(n => n.name === 'a')?.depth).toBe(2); verifyPaths([r]);
    const filtered = f.start('root', { mode: 'impact', edgeKinds: ['imports'] }).r;
    expect(filtered.edges.map(e => e.kind)).toEqual(['imports']); expect(filtered.nodes.map(n => n.name)).toEqual(['root','b']);
  });
  it('keeps paths complete after paginated merges, and cursor retries deterministic', () => {
    const f = fixture(); ['a','b','c','d'].forEach(x => f.n(x)); f.e('a','b'); f.e('b','c'); f.e('d','a'); f.db.close();
    const { q, r } = f.start('c', { mode: 'impact', depth: 5, limit: 2, edgeLimit: 1 });
    const pages = [r]; let next = r.nextCursor;
    while (next) {
      const current = queryStructured(f.ctx, 'graph', { ...q, cursor: next });
      expect(queryStructured(f.ctx, 'graph', { cursor: next, ...q }).nodes).toEqual(current.nodes);
      pages.push(current); expect(pages.length).toBeLessThan(10); next = current.nextCursor;
    }
    expect(pages.flatMap(p => p.edges)).toHaveLength(3); verifyPaths(pages);
    expect(queryStructured(f.ctx, 'graph', { ...q, mode: 'hierarchy', cursor: r.nextCursor! }).state).toBe('version_expired');
    expect(queryStructured({ ...f.ctx, version: 2 }, 'graph', q).state).toBe('version_expired');
  });
  it('bounds a large fan-in and a dense unknown-clause list without duplicate continuation output', () => {
    const f = fixture(); f.n('root'); f.db.transaction(() => { for(let i=0;i<600;i++) { f.n(`n${i}`); f.e(`n${i}`,'root'); } })(); f.u('root','dynamic_unknown','calls'); f.db.close();
    const { q, r } = f.start('root', { mode: 'impact', limit: 30, edgeLimit: 20 });
    const edges = new Set<string>(); let current = r, pages = 0;
    while(true) {
      expect(current.work!.rowsRead).toBeLessThanOrEqual(2000); expect(current.nodes.length).toBeLessThanOrEqual(30); expect(current.edges.length).toBeLessThanOrEqual(20);
      for(const e of current.edges) { expect(edges.has(e.id)).toBe(false); edges.add(e.id); }
      expect(++pages).toBeLessThan(100); if (!current.nextCursor) break; current = queryStructured(f.ctx,'graph',{...q,cursor:current.nextCursor});
    }
    expect(edges.size).toBe(499); expect(current.truncationReasons).toContain('traversal_budget');
  });
  it.each(['impact', 'hierarchy'] as const)('normalizes explicit %s defaults in cursor identity', mode => {
    const f=fixture(); ['root','a','b'].forEach(id=>f.n(id,'class'));
    if(mode==='impact'){f.e('a','root');f.e('b','root');}else{f.e('root','a','extends');f.e('root','b','implements');} f.db.close();
    const {q,r}=f.start('root',{mode,edgeLimit:1}); expect(r.nextCursor).toBeTruthy();
    const defaults = {depth:mode==='impact'?2:1,direction:mode==='impact'?'in' as const:'both' as const,edgeKinds:mode==='impact'?['references','implements','extends','imports','calls']:['implements','extends']};
    const implicit=queryStructured(f.ctx,'graph',{...q,cursor:r.nextCursor!});
    const explicit=queryStructured(f.ctx,'graph',{...defaults,...q,cursor:r.nextCursor!});
    expect(explicit.state).not.toBe('version_expired'); expect(explicit.edges).toEqual(implicit.edges);
    expect(queryStructured(f.ctx,'graph',{...q,depth:5,cursor:r.nextCursor!}).state).toBe('version_expired');
  });
  it('preserves synthetic multi-interface and diamond topology without claiming SDK extraction coverage', () => {
    const f = fixture(); ['child','left','right','top'].forEach(x=>f.n(x,'class')); f.n('other-top','interface');
    f.e('child','left','extends'); f.e('child','right','extends'); f.e('left','top','extends'); f.e('right','top','extends'); f.e('child','other-top','implements'); f.db.close();
    const { r } = f.start('child',{mode:'hierarchy',direction:'out',depth:2});
    expect(r.nodes).toHaveLength(5); expect(r.edges).toHaveLength(5); expect(new Set(r.nodes.map(n=>n.id)).size).toBe(5);
    expect(f.start('top',{mode:'hierarchy',direction:'in'}).r.nodes.map(n=>n.name)).toEqual(expect.arrayContaining(['top','left','right']));
    expect(f.start('child',{mode:'hierarchy',direction:'out',edgeKinds:['implements']}).r.edges).toHaveLength(1);
  });
  it('separates unknown external supertypes, no relation, non-type focus and unsupported languages', () => {
    const f = fixture(); f.n('outside','class'); f.n('empty','class'); f.n('function'); f.n('rust','class','rust'); f.u('outside','ExternalBase'); f.db.close();
    const external=f.start('outside',{mode:'hierarchy'}).r;
    expect(external.state).toBe('empty'); expect(external.edges).toEqual([]); expect(external.nodes).toHaveLength(1);
    expect(external.unresolved?.[0]).toMatchObject({name:'ExternalBase',kind:'extends',filePath:'outside.ts'});
    expect(f.start('empty',{mode:'hierarchy'}).r.unresolved).toEqual([]);
    expect(f.start('function',{mode:'hierarchy'}).r.warnings).toContain('select_a_type');
    expect(f.start('rust',{mode:'hierarchy'}).r.state).toBe('unsupported');
  });
  it('bounds unresolved-reference pagination and never creates phantom edges', () => {
    const f=fixture(); f.n('root','class'); for(let i=0;i<9;i++) f.u('root',`Missing${i}`); f.db.close();
    const {q,r}=f.start('root',{mode:'hierarchy',edgeLimit:2}); let current=r; const names:string[]=[];
    while(true) { names.push(...current.unresolved!.map(u=>u.name)); expect(current.edges).toEqual([]); if(!current.nextCursor)break; current=queryStructured(f.ctx,'graph',{...q,cursor:current.nextCursor}); }
    expect(names).toHaveLength(9); expect(new Set(names).size).toBe(9);
  });
  it('does not use a misleading unresolved index with the wrong leading column', () => {
    const f=fixture(); f.n('root','class'); f.u('root','External'); f.db.exec('DROP INDEX idx_unresolved_from_node; CREATE INDEX idx_unresolved_from_node ON unresolved_refs(reference_name)'); f.db.close();
    expect(f.start('root',{mode:'hierarchy'}).r.warnings).toContain('unresolved_coverage_unavailable');
  });
  it('rejects impact outgoing direction and gates every mode when the schema is unsupported', () => {
    expect(()=>validateStructuredRequest('graph',{mode:'impact',direction:'out'})).toThrow();
    const f=fixture(); f.n('root'); f.db.exec('DROP INDEX idx_edges_source_kind'); f.db.close();
    const s=queryStructured(f.ctx,'graph-search',{}); expect(Object.values(s.capabilities.modes).every(c=>!c.supported)).toBe(true);
    const db=new Database(f.ctx.databasePath); db.exec('CREATE INDEX idx_edges_source_kind ON edges(target,kind)'); db.close();
    expect(queryStructured(f.ctx,'graph-search',{}).state).toBe('unsupported');
  });
});
