import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';
import { GRAPH_LIMITS, queryStructured, type StructuredContext } from './structured.js';
import { dependencyDeclarations, dependencyGroup } from './structured-aggregation.js';

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
  const query = (request: CodeGraphRequest = {}) => queryStructured(ctx, 'graph', { mode: 'dependencies', ...request });
  const close = () => { for (const [path, lines] of content) { const text = lines.join('\n'); mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)').run(path, createHash('sha256').update(text).digest('hex')); } db.close(); };
  return { ctx, db, node, edge, unresolved, query, close, content };
}
function allPages(query: (q: CodeGraphRequest) => CodeGraphResponse, initial: CodeGraphRequest = {}) {
  const pages: CodeGraphResponse[] = []; let cursor: string | undefined;
  do {
    const response = query({ ...initial, ...(cursor ? { cursor } : {}) }); pages.push(response);
    expect(response.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
    expect(pages.length).toBeLessThan(50); cursor = response.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}
describe('bounded dependency aggregation', () => {
  it('finds actual static declaration anchors through comments, strings, multiline clauses, ASI and quote escapes', () => {
    const source = [
      '// import { fake } from "fake"',
      'const text = "import x from \\\"fake\\\"";',
      '/* export * from "fake" */',
      '  import {',
      '    one, /* from "fake" */ two',
      '  } from "./real"',
      'export { one } from "./real"; export { two } from "./real"',
      "import './it\\'s-real'",
      'const later = import("./dynamic"); const cjs = require("./cjs");',
      'const template = `import x from "fake"`',
    ].join('\n');
    const declarations = dependencyDeclarations(source);
    expect(declarations.map(d => [d.line, d.column, d.specifier])).toEqual([[4, 2, './real'], [7, 0, './real'], [7, 30, './real'], [8, 0, "./it's-real"]]);
    expect(dependencyDeclarations('const x = require("x"); import x = require("x")')).toEqual([]);
  });
  it('deduplicates import bindings/reexports, counts internal edges separately and proves SCC cycles', () => {
    const f = fixture();
    f.node('a', 'a/main.ts'); f.node('al', 'a/local.ts'); f.node('b', 'b/main.ts'); f.node('bs', 'b/main.ts', 'function'); f.node('c', 'c/main.ts'); f.node('r', 'index.ts');
    f.edge(1, 'a', 'b'); f.edge(2, 'a', 'bs', 1, 9); f.edge(3, 'b', 'a'); f.edge(4, 'b', 'c', 2); f.edge(5, 'a', 'al', 3); f.edge(6, 'r', 'bs', 1, 9); f.edge(7, 'r', 'b', 1, 15); f.edge(8, 'a', 'b', 9, 3, 'calls'); f.edge(9, 'a', 'bs', 10, 0, 'contains'); f.close();
    const r = f.query(); expect(r.aggregation?.complete).toBe(true); expect(r.aggregation?.countMetric).toBe('unique_import_site_target_file');
    expect(r.nodes.map(n => n.name).sort()).toEqual(['.', 'a', 'b', 'c']); expect(r.edges).toHaveLength(4);
    expect(r.edges.every(e => e.kind === 'imports' && e.count === 1 && e.source !== e.target)).toBe(true);
    expect(r.nodes.find(n => n.name === 'a')?.aggregate).toMatchObject({ fileCount: 2, symbolCount: 0, internalCount: 1, complete: true });
    expect(r.nodes.find(n => n.name === 'b')?.aggregate).toMatchObject({ fileCount: 1, symbolCount: 1 });
    expect(r.cycles).toHaveLength(1); expect(r.cycles![0].nodeIds).toHaveLength(2); expect(r.cycles![0].edgeIds).toHaveLength(2);
    expect(r.warnings).not.toContain('unverified_language:aggregate');
    expect(f.query().nodes.map(n => n.id)).toEqual(r.nodes.map(n => n.id));
    const calls = f.query({ edgeKinds: ['calls'] }); expect(calls.edges).toHaveLength(1); expect(calls.aggregation?.countMetric).toBe('unique_call_site_target_file');
    expect(f.query({ edgeKinds: ['calls', 'imports'] }).state).toBe('unsupported'); expect(f.query({ groupBy: 'symbol' }).state).toBe('unsupported');
  });
  it('fixes root ownership, directory depth, same-name file distinction and drill-down counts', () => {
    expect(dependencyGroup('index.ts', 'directory', 3)).toBe('.'); expect(dependencyGroup('src/a/main.ts', 'directory', 1)).toBe('src'); expect(dependencyGroup('src/a/main.ts', 'directory', 2)).toBe('src/a');
    const f = fixture(); f.node('a', 'src/a/main.ts'); f.node('b', 'src/b/main.ts'); f.node('s', 'src/a/main.ts', 'function'); f.edge(1, 'a', 'b'); f.close();
    const broad = f.query(); expect(broad.nodes).toHaveLength(1); expect(broad.nodes[0].aggregate?.internalCount).toBe(1); expect(broad.edges).toHaveLength(0);
    const deeper = f.query({ moduleDepth: 2 }); expect(deeper.nodes).toHaveLength(2); expect(deeper.edges[0].count).toBe(1);
    const files = f.query({ groupBy: 'file', scopePath: 'src/a' }); expect(files.nodes.map(n => n.filePath).sort()).toEqual(['src/a/main.ts', 'src/b/main.ts']); expect(files.edges[0].count).toBe(deeper.edges[0].count);
    const symbols = queryStructured(f.ctx, 'graph-search', { scopePath: 'src/a/main.ts' }); expect(symbols.nodes.some(n => n.kind === 'function')).toBe(true);
    expect(queryStructured(f.ctx, 'graph-node', { nodeId: deeper.nodes[0].id, indexVersion: deeper.indexVersion! }).state).toBe('not_found');
  });
  it('keeps external specifiers and unresolved targets separate from indexed modules', () => {
    const f = fixture(); f.node('a', 'a/main.ts'); f.unresolved(1, 'a', 'node:fs', 2); f.unresolved(2, 'a', 'readFile', 2, 9); f.unresolved(3, 'a', './missing', 3); f.unresolved(4, 'a', 'UnresolvedName', 4, 9); f.close();
    const r = f.query(); expect(r.nodes.map(n => n.aggregate?.resolution)).toEqual(expect.arrayContaining(['internal', 'external', 'unresolved']));
    expect(r.nodes.some(n => n.name === 'readFile')).toBe(false); expect(r.edges).toHaveLength(3); expect(r.cycles).toEqual([]);
    const edge = r.edges.find(e => e.resolution === 'external')!;
    const proof = f.query({ evidenceFor: edge.id, indexVersion: r.indexVersion! });
    expect(proof.state).toBe('ready'); expect(proof.dependencyEvidence).toHaveLength(1); expect(proof.dependencyEvidence![0]).toMatchObject({ targetFile: 'node:fs', resolution: 'external' }); expect(proof.dependencyEvidence![0].targetId).toBeUndefined();
  });
  it('does not count an unresolved named binding as a second dependency when its module resolved', () => {
    const f = fixture(); f.node('a', 'a/main.ts'); f.node('b', 'b/main.ts'); f.edge(1, 'a', 'b'); f.unresolved(1, 'a', 'missingNamedBinding', 1, 9); f.close();
    const result = f.query(); expect(result.edges).toHaveLength(1); expect(result.edges[0].count).toBe(1); expect(result.nodes).toHaveLength(2);
    expect(result.warnings).toContain('unresolved_binding_in_resolved_import'); expect(result.unresolved![0].name).toBe('missingNamedBinding');
  });
  it('paginates independent exact evidence with real source/target node IDs and stable retries', () => {
    const f = fixture(); f.node('a', 'a/main.ts'); f.node('b', 'b/main.ts'); f.node('bs', 'b/main.ts', 'function');
    for (let i = 1; i <= 6; i++) { f.edge(i * 2 - 1, 'a', 'b', i); f.edge(i * 2, 'a', 'bs', i, 9); } f.close();
    const summary = f.query(); expect(summary.edges[0].count).toBe(6); expect(summary.edges[0].evidence).toHaveLength(5);
    const q = { evidenceFor: summary.edges[0].id, indexVersion: summary.indexVersion!, edgeLimit: 2 };
    const pages = allPages(f.query, q); const proof = pages.flatMap(p => p.dependencyEvidence ?? []);
    expect(proof).toHaveLength(6); expect(new Set(proof.map(p => p.id)).size).toBe(6); expect(pages.every(p => (p.dependencyEvidence?.length ?? 0) <= 2)).toBe(true);
    const retry = f.query({ ...q, cursor: pages[0].nextCursor! }); expect(retry.dependencyEvidence).toEqual(pages[1].dependencyEvidence);
    const source = queryStructured(f.ctx, 'graph-node', { nodeId: proof[0].sourceId, indexVersion: summary.indexVersion! }); expect(source.nodes[0].filePath).toBe('a/main.ts');
    expect(queryStructured(f.ctx, 'graph-node', { nodeId: proof[0].targetId!, indexVersion: summary.indexVersion! }).nodes[0].filePath).toBe('b/main.ts');
  });
  it('continues sparse scans with cumulative replace counts and <=2000 rows per request', () => {
    const f = fixture();
    f.db.transaction(() => { f.node('a', 'a/main.ts'); f.node('b', 'b/main.ts'); for (let i = 0; i < 4200; i++) f.node(`s${i}`, 'a/main.ts', 'function'); for (let i = 1; i <= 2500; i++) f.edge(i, 'a', 'b', i); })(); f.close();
    const pages = allPages(f.query); expect(pages.length).toBeGreaterThan(4); expect(pages[0].aggregation?.complete).toBe(false); expect(pages[0].warnings).toContain('cycles_only_in_observed_graph');
    const last = pages.at(-1)!; expect(last.aggregation?.complete).toBe(true); expect(last.edges[0].count).toBe(2500); expect(last.nodes.find(n => n.name === 'a')!.aggregate!.symbolCount).toBe(4200);
    expect(pages.filter(p => p.edges.length).every(p => p.edges[0].id === last.edges[0].id)).toBe(true); expect(last.aggregation?.merge).toBe('replace');
    const replay1 = f.query({ cursor: pages[0].nextCursor! }), replay2 = f.query({ cursor: pages[0].nextCursor! }); expect(replay1.nodes).toEqual(replay2.nodes); expect(replay1.edges).toEqual(replay2.edges);
    expect(f.query({ cursor: pages[0].nextCursor!, moduleDepth: 2 }).state).toBe('version_expired');
    expect(queryStructured({ ...f.ctx, version: 2 }, 'graph', { mode: 'dependencies', cursor: pages[0].nextCursor! }).state).toBe('version_expired');
  });
  it('honors scope path boundaries while retaining outgoing targets beyond the source scope', () => {
    const f = fixture(); f.node('a', 'src/main.ts'); f.node('b', 'src2/main.ts'); f.node('c', 'other/main.ts'); f.edge(1, 'a', 'c'); f.edge(2, 'b', 'c'); f.close();
    const r = f.query({ scopePath: 'src' }); expect(r.nodes.map(n => n.name).sort()).toEqual(['other', 'src']); expect(r.edges).toHaveLength(1); expect(r.edges[0].count).toBe(1);
    expect(r.nodes.find(n => n.name === 'other')?.aggregate?.complete).toBe(false);
    const foreign = queryStructured({ ...f.ctx, assetId: 'other-asset' }, 'graph', { mode: 'dependencies', evidenceFor: r.edges[0].id }); expect(foreign.state).toBe('not_found');
  });
  it('stops at explicit node and edge caps without claiming complete counts or no cycles', () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) f.node(id, `${id}/main.ts`); f.edge(1, 'a', 'b'); f.edge(2, 'b', 'c'); f.close();
    const nodes = f.query({ limit: 2 }); expect(nodes.nodes.length).toBeLessThanOrEqual(2); expect(nodes.truncated).toBe(true); expect(nodes.nextCursor).toBeNull(); expect(nodes.aggregation?.complete).toBe(false);
    const edges = f.query({ edgeLimit: 1 }); expect(edges.edges).toHaveLength(1); expect(edges.truncationReasons).toContain('edge_budget'); expect(edges.aggregation?.complete).toBe(false);
  });
  it('bounds SQL scan plans to primary-key keysets without a group-by or temporary sort', () => {
    const f = fixture();
    for (const query of ['SELECT rowid,* FROM nodes WHERE rowid > ? ORDER BY rowid LIMIT ?', 'SELECT * FROM edges WHERE id > ? ORDER BY id LIMIT ?', 'SELECT * FROM unresolved_refs WHERE id > ? ORDER BY id LIMIT ?']) {
      const detail = (f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(0, 100) as { detail: string }[]).map(r => r.detail).join(' ');
      expect(detail).toContain('INTEGER PRIMARY KEY'); expect(detail).not.toContain('TEMP B-TREE');
    }
    f.close();
  });
  it('marks missing or unsupported declaration sources incomplete and expires changed source', () => {
    const f = fixture(); f.node('a', 'a/main.ts'); f.node('b', 'b/main.ts'); f.edge(1, 'a', 'b'); f.content.set('a/main.ts', ['const x = require("../b/main")']); f.close();
    const unsupported = f.query(); expect(unsupported.aggregation?.complete).toBe(false); expect(unsupported.truncationReasons).toContain('unverified_import_sites'); expect(unsupported.edges).toEqual([]);
    writeFileSync(join(f.ctx.projectRoot, 'a/main.ts'), '// modified'); expect(f.query().state).toBe('version_expired');
    rmSync(join(f.ctx.projectRoot, 'a/main.ts')); const unavailable = f.query(); expect(unavailable.aggregation?.complete).toBe(false); expect(unavailable.warnings).toContain('import_declaration_source_unavailable');
  });
  it('refuses source symlink escape and does not turn unverified languages into a successful empty graph', () => {
    const f = fixture(); f.node('a', 'a/main.ts'); f.node('b', 'b/main.ts'); f.edge(1, 'a', 'b'); f.close();
    const outside = mkdtempSync(join(tmpdir(), 'dependency-outside-')); temps.push(outside); writeFileSync(join(outside, 'main.ts'), "import { target } from './b/main.ts';");
    rmSync(join(f.ctx.projectRoot, 'a'), { recursive: true }); symlinkSync(outside, join(f.ctx.projectRoot, 'a'));
    const r = f.query(); expect(r.aggregation?.complete).toBe(false); expect(r.edges).toEqual([]); expect(r.warnings).toContain('import_declaration_source_unavailable'); expect(JSON.stringify(r)).not.toContain(outside);
    const other = fixture(); other.node('a', 'a.rs'); other.db.prepare("UPDATE nodes SET language='rust'").run(); other.close();
    expect(other.query().state).toBe('unsupported');
  });
  it('continues after a cumulative two-MiB source read budget instead of reading every file in one request', () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) f.node(id, `${id}/main.ts`); f.edge(1, 'a', 'c'); f.edge(2, 'b', 'c');
    for (const path of ['a/main.ts', 'b/main.ts']) f.content.get(path)!.push(`/*${'x'.repeat(1100 * 1024)}*/`);
    f.close(); const pages = allPages(f.query); expect(pages[0].truncationReasons).toContain('source_scan_budget'); expect(pages[0].aggregation?.complete).toBe(false);
    expect(pages.at(-1)!.aggregation?.complete).toBe(true); expect(pages.at(-1)!.edges).toHaveLength(2);
  });
});
