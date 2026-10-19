import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';
import { GRAPH_LIMITS, queryStructured, type StructuredContext } from './structured.js';

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dependency-query-')); temps.push(root);
  const db = new Database(join(root, 'index.db'));
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);
    CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,file_path TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_unresolved_from_node ON unresolved_refs(from_node_id);`);
  const ctx: StructuredContext = { assetId: 'cg-deps', projectRoot: root, databasePath: join(root, 'index.db'), sdkVersion: '1.6.2', version: 1, commit: 'abc', indexedAt: 'fixture', branch: 'main' };
  const paths = new Map<string, string>();
  const content = new Map<string, string[]>();
  const node = (id: string, path: string, kind = 'file') => { paths.set(id, path); if (!content.has(path)) content.set(path, []); db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)').run(id, kind, path.split('/').at(-1), path, path, 'typescript', 1, 200); };
  const edge = (id: number, source: string, target: string, line = 1, col = 0, kind = 'imports') => { if (kind === 'imports') { const lines = content.get(paths.get(source)!)!; lines[line - 1] ??= `import { target } from './${paths.get(target)}';`; } db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?)').run(id, source, target, kind, line, col); };
  const unresolved = (id: number, source: string, name: string, line: number, col = 0) => { const lines = content.get(paths.get(source)!)!; lines[line - 1] ??= `import { target } from '${name}';`; db.prepare('INSERT INTO unresolved_refs VALUES (?,?,?,?,?,?,?)').run(id, source, name, 'imports', 'a/main.ts', line, col); };
  const query = (request: CodeGraphRequest = {}) => queryStructured(ctx, 'graph', { mode: 'clusters', ...request });
  const close = () => { for (const [path, lines] of content) { const text = lines.join('\n'); mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)').run(path, createHash('sha256').update(text).digest('hex')); } db.close(); };
  return { ctx, db, node, edge, unresolved, query, close, content };
}
function allPages(query: (q: CodeGraphRequest) => CodeGraphResponse, initial: CodeGraphRequest = {}) {
  const pages: CodeGraphResponse[] = []; let cursor: string | undefined;
  do {
    const response = query({ ...initial, ...(cursor ? { cursor } : {}) }); pages.push(response);
    expect(response.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
    expect(response.nodes.length).toBeLessThanOrEqual(initial.limit ?? GRAPH_LIMITS.nodes); expect(response.edges.length).toBeLessThanOrEqual(initial.edgeLimit ?? GRAPH_LIMITS.edges);
    expect(pages.length).toBeLessThan(50); cursor = response.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}
describe('bounded hierarchical clusters', () => {
  it('keeps incoming and outgoing boundaries through directory/file/symbol drill and stable collapse IDs', () => {
    const f = fixture(); for (const id of ['a','b','c']) f.node(id, `${id}/main.ts`); f.node('as','a/main.ts','function');
    f.edge(1,'b','a'); f.edge(2,'a','c'); f.close();
    const top=f.query(), files=f.query({groupBy:'file',scopePath:'a'}), symbols=f.query({groupBy:'symbol',scopePath:'a/main.ts'});
    for (const r of [top,files,symbols]) { expect(r.edges).toHaveLength(2); expect(r.aggregation?.distinctSiteCount).toBe(2); expect(r.clustering?.boundaryPolicy).toBe('both'); expect(new Set(r.nodes.map(n=>n.id)).size).toBe(r.nodes.length); }
    expect(files.nodes.find(n=>n.name==='b')?.aggregate?.boundary).toBe(true);
    expect(symbols.nodes.filter(n=>!n.aggregate)).toHaveLength(2);
    expect(symbols.nodes.find(n=>n.name==='b')?.id).toBe(top.nodes.find(n=>n.name==='b')?.id);
    expect(f.query().nodes.map(n=>n.id)).toEqual(top.nodes.map(n=>n.id));
    expect(symbols.clustering?.breadcrumbs.at(-1)).toEqual({path:'a/main.ts',groupBy:'symbol',label:'main.ts'});
    const real=symbols.nodes.find(n=>!n.aggregate)!; expect(queryStructured(f.ctx,'graph-node',{nodeId:real.id,indexVersion:symbols.indexVersion!}).nodes[0].id).toBe(real.id);
    const dependencies=queryStructured(f.ctx,'graph',{mode:'dependencies',scopePath:'a'}); expect(dependencies.edges).toHaveLength(1);
    for (const edge of symbols.edges) { const proof=f.query({groupBy:'symbol',scopePath:'a/main.ts',evidenceFor:edge.id,indexVersion:symbols.indexVersion!}); expect(proof.dependencyEvidence).toHaveLength(1); expect(proof.dependencyEvidence![0].sourceId).toBeTruthy(); }
  });
  it('preserves distinct symbol endpoints at one import/call site while reconciling unique declarations', () => {
    const f=fixture(); f.node('a','a/main.ts'); f.node('b','b/main.ts','function'); f.node('b2','b/main.ts','function');
    f.edge(1,'a','b'); f.edge(2,'a','b2',1,9); f.edge(3,'a','b',1,12); f.edge(4,'b','b2',10,2,'calls'); f.edge(5,'b','b',10,2,'calls'); f.edge(6,'b2','b',11,2,'calls'); f.close();
    const symbols=f.query({groupBy:'symbol',scopePath:'b/main.ts'}); expect(symbols.edges).toHaveLength(2); expect(symbols.edges.map(e=>e.count)).toEqual([1,1]); expect(symbols.aggregation?.distinctSiteCount).toBe(1);
    expect(f.query({groupBy:'file',scopePath:'b/main.ts'}).aggregation?.distinctSiteCount).toBe(1);
    const calls=f.query({groupBy:'symbol',scopePath:'b/main.ts',edgeKinds:['calls']}); expect(calls.edges).toHaveLength(3); expect(calls.aggregation?.distinctSiteCount).toBe(2); expect(calls.cycles).toHaveLength(1); expect(calls.cycles![0].nodeIds).toHaveLength(2); expect(calls.cycles![0].edgeIds).toHaveLength(3);
    const one=f.query({groupBy:'symbol',scopePath:'b/main.ts',edgeKinds:['calls'],edgeLimit:1}); expect(one.edges).toHaveLength(1); expect(one.aggregation?.complete).toBe(false);
  });
  it('reports an actual symbol self-cycle and never a collapsed bucket cycle', () => {
    const f=fixture(); f.node('a','a.ts','function'); f.edge(1,'a','a',2,0,'calls'); f.close();
    const r=f.query({groupBy:'symbol',scopePath:'a.ts',edgeKinds:['calls']}); expect(r.cycles).toHaveLength(1); expect(r.cycles![0].nodeIds).toHaveLength(1);
    const folded=f.query({groupBy:'symbol',scopePath:'a.ts',edgeKinds:['calls'],limit:1}); expect(folded.cycles).toEqual([]); expect(folded.nodes[0].aggregate?.collapsed).toBe(true);
  });
  it('has honest empty/root-direct scopes and no dangling selected focus outside explicit scope', () => {
    const empty=fixture(); empty.close(); expect(empty.query().state).toBe('empty');
    const f=fixture(); f.node('a','index.ts'); f.node('b','src/b.ts'); f.edge(1,'b','a'); f.close();
    const r=f.query({groupBy:'file',scopePath:'.'}); expect(r.nodes.find(n=>n.name==='index.ts')?.aggregate?.boundary).toBe(false); expect(r.edges).toHaveLength(1);
    expect(f.query({scopePath:'empty'}).state).toBe('empty'); expect(f.query({groupBy:'symbol'}).state).toBe('unsupported');
    const node=queryStructured(f.ctx,'graph-search',{scopePath:'src/b.ts'}).nodes[0];
    const focus=f.query({groupBy:'symbol',scopePath:'index.ts',nodeId:node.id,indexVersion:r.indexVersion!}); expect(focus.focusId).toBeNull();
  });
  it('folds bounded remaining members, prioritizes late searched symbols and replays immutable scope cursors', () => {
    const f=fixture(); f.db.transaction(()=>{ f.node('f','a/main.ts'); for(let i=0;i<5000;i++)f.node(`s${i}`,'a/main.ts','function'); f.node('b','b/main.ts'); for(let i=1;i<=15000;i++)f.edge(i,'s4999','b',2,0,'calls'); })(); f.close();
    // Locate the late symbol through its snapshot-bound opaque ID from an indexed search.
    const db=new Database(f.ctx.databasePath); db.prepare("UPDATE nodes SET name='lateSymbol', qualified_name='lateSymbol' WHERE id='s4999'").run(); db.close();
    const searchPages=allPages(q=>queryStructured(f.ctx,'graph-search',q),{query:'lateSymbol',scopePath:'a/main.ts'}); const late=searchPages.flatMap(page=>page.nodes)[0];
    const q:CodeGraphRequest={groupBy:'symbol',scopePath:'a/main.ts',edgeKinds:['calls'],limit:10,nodeId:late.id,indexVersion:searchPages[0].indexVersion!};
    const pages=allPages(f.query,q), last=pages.at(-1)!; expect(pages.length).toBeGreaterThan(10); expect(last.aggregation?.complete).toBe(true); expect(last.nodes.some(n=>n.id===late.id)).toBe(true); expect(last.focusId).toBe(late.id); expect(last.nodes.length).toBeLessThanOrEqual(10); expect(last.edges).toHaveLength(1); expect(last.edges[0].count).toBe(1); expect(last.truncationReasons).toContain('collapsed_node_budget');
    expect(last.nodes.filter(n=>!n.aggregate&&n.kind!=='file').length+last.nodes.reduce((sum,n)=>sum+(n.aggregate?.symbolCount??0),0)).toBe(5000);
    const replay=f.query({...q,cursor:pages[0].nextCursor!}); expect(replay.nodes).toEqual(pages[1].nodes); expect(f.query({...q,scopePath:'b/main.ts',cursor:pages[0].nextCursor!}).state).toBe('version_expired'); expect(f.query({...q,moduleDepth:2,cursor:pages[0].nextCursor!}).state).toBe('version_expired');
    expect(queryStructured({...f.ctx,version:2},'graph',{mode:'clusters',...q,cursor:pages[0].nextCursor!}).state).toBe('version_expired');
  });
  it('retains diagnostic pages cumulatively and explicitly reports a diagnostic cap', () => {
    const f=fixture(); f.node('a','a/main.ts'); f.node('b','b/main.ts'); f.edge(1,'a','b'); for(let i=1;i<=1100;i++) f.unresolved(i,'a',`missing${i}`,1,9); f.close();
    const full=allPages(f.query,{edgeLimit:1500}); expect(full.length).toBeGreaterThan(1); expect(full.at(-1)!.unresolved).toHaveLength(1100); expect(full.at(-1)!.aggregation?.complete).toBe(true); expect(full.at(-1)!.edges[0].count).toBe(1);
    for(let i=1;i<full.length;i++) expect(full[i].unresolved?.length??0).toBeGreaterThanOrEqual(full[i-1].unresolved?.length??0);
    const retry=f.query({edgeLimit:1500,cursor:full[0].nextCursor!}); expect(retry.unresolved).toEqual(full[1].unresolved);
    const capped=allPages(f.query); expect(capped.at(-1)!.unresolved).toHaveLength(300); expect(capped.at(-1)!.warnings).toContain('unresolved_diagnostic_budget'); expect(capped.at(-1)!.aggregation?.complete).toBe(false); expect(capped.at(-1)!.nextCursor).toBeNull(); expect(capped.at(-1)!.edges[0].count).toBe(1);
    const deps=queryStructured(f.ctx,'graph',{mode:'dependencies'}); expect(deps.edges[0].count).toBe(1); expect(deps.warnings).toContain('unresolved_diagnostic_budget');
  });
});
