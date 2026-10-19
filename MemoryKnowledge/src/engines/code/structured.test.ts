import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_LIMITS, queryStructured, validateStructuredRequest, type StructuredContext } from './structured.js';

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bounded-cg-')); temps.push(root);
  const path = join(root, 'index.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
  CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
  CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
  CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
  const ctx: StructuredContext = { assetId: 'cg-test', projectRoot: root, databasePath: path, sdkVersion: '1.6.2', version: 1, commit: 'abc', indexedAt: '2026-10-19T00:00:00Z', branch: 'main' };
  const addNode = (id: string, file = `${id}.ts`, kind = 'function', name = 'duplicate') => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)').run(id, kind, name, `${file}:${name}`, file, 'typescript', 1, 2);
  const addEdge = (id: number, source: string, target: string, kind = 'calls') => db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?)').run(id, source, target, kind, 1, 0);
  const addFile = (file: string, content: string) => { writeFileSync(join(root, file), content); db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)').run(file, createHash('sha256').update(content).digest('hex')); };
  const search = () => queryStructured(ctx, 'graph-search', {});
  return { ctx, db, addNode, addEdge, addFile, search };
}
describe('bounded structured graph', () => {
  it('preserves duplicate symbols, overloads, self loops, opposite and parallel relation identity', () => {
    const f = fixture(); f.addNode('a'); f.addNode('b'); f.addNode('overload', 'a.ts');
    f.addEdge(1, 'a', 'a'); f.addEdge(2, 'a', 'b'); f.addEdge(3, 'b', 'a'); f.addEdge(4, 'a', 'b', 'imports'); f.addEdge(5, 'a', 'b'); f.db.close();
    const found = f.search(); expect(found.nodes).toHaveLength(3); expect(new Set(found.nodes.map(n => n.id)).size).toBe(3);
    const result = queryStructured(f.ctx, 'graph', { nodeId: found.nodes[0].id, indexVersion: found.indexVersion!, direction: 'both' });
    expect(result.edges).toHaveLength(4); expect(new Set(result.edges.map(e => e.id)).size).toBe(4);
    expect(result.edges.filter(e => e.source === e.target)).toHaveLength(1);
    expect(result.edges.every(e => e.kind === 'calls')).toBe(true); expect(result.edges[0].evidence[0].filePath).toBe('a.ts');
    expect(queryStructured({ ...f.ctx, sdkVersion: 'unverified' }, 'graph', { mode: 'clusters' }).state).toBe('unsupported');
  });
  it('has bounded keyset search, sparse scan continuation and stable same-query pages', () => {
    const f = fixture(); f.db.transaction(() => { for (let i = 0; i < 5000; i++) f.addNode(`n${i}`, `${i}.ts`, 'function', i === 4999 ? 'last' : 'other'); })(); f.db.close();
    let r = queryStructured(f.ctx, 'graph-search', { query: 'last', limit: 2 });
    expect(r.nodes).toHaveLength(0); expect(r.nextCursor).toBeTruthy(); expect(r.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
    const token = r.nextCursor!;
    expect(queryStructured({ ...f.ctx, version: 2 }, 'graph-search', { query: 'last', limit: 2, cursor: token }).state).toBe('version_expired');
    expect(queryStructured(f.ctx, 'graph-search', { cursor: token, limit: 2, query: 'last', indexVersion: r.indexVersion! }).state).not.toBe('version_expired');
    const repeat1 = queryStructured(f.ctx, 'graph-search', { query: 'last', limit: 2, cursor: token });
    const repeat2 = queryStructured(f.ctx, 'graph-search', { query: 'last', limit: 2, cursor: token });
    expect(repeat1.nodes).toEqual(repeat2.nodes);
    r = repeat1;
    while (r.nextCursor) r = queryStructured(f.ctx, 'graph-search', { query: 'last', limit: 2, cursor: r.nextCursor });
    expect(r.nodes[0].name).toBe('last'); expect(r.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
    expect(queryStructured(f.ctx, 'graph-search', { query: 'changed', limit: 2, cursor: token }).state).toBe('version_expired');
  });
  it('paginates a dense graph without duplicate edges or unbounded work', () => {
    const f = fixture(); f.db.transaction(() => { for (let i = 0; i < 600; i++) f.addNode(`n${i}`); for (let i = 1; i < 600; i++) f.addEdge(i, 'n0', `n${i}`); })(); f.db.close();
    const found = f.search(); const request = { nodeId: found.nodes[0].id, indexVersion: found.indexVersion!, direction: 'out' as const, depth: 5, limit: 25, edgeLimit: 30 };
    let r = queryStructured(f.ctx, 'graph', request); const seen = new Set<string>(); let pages = 0;
    do {
      expect(r.nodes.length).toBeLessThanOrEqual(25); expect(r.edges.length).toBeLessThanOrEqual(30); expect(r.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
      for (const edge of r.edges) { expect(seen.has(edge.id)).toBe(false); seen.add(edge.id); }
      pages++; expect(pages).toBeLessThan(100);
      if (!r.nextCursor) break;
      r = queryStructured(f.ctx, 'graph', { ...request, cursor: r.nextCursor });
    } while (true);
    expect(seen.size).toBe(499); expect(r.truncationReasons).toContain('traversal_budget');
  });
  it('paginates tiny 2-node responses without an empty-page loop', () => {
    const f = fixture(); for (const n of ['a', 'b', 'c', 'd']) f.addNode(n); f.addEdge(1, 'a', 'b'); f.addEdge(2, 'b', 'c'); f.addEdge(3, 'c', 'd'); f.db.close();
    const s = f.search(); const q = { nodeId: s.nodes[0].id, indexVersion: s.indexVersion!, direction: 'out' as const, depth: 5, limit: 2 };
    let r = queryStructured(f.ctx, 'graph', q); let edges = 0, pages = 0;
    while (true) { edges += r.edges.length; expect(++pages).toBeLessThan(10); if (!r.nextCursor) break; r = queryStructured(f.ctx, 'graph', { ...q, cursor: r.nextCursor }); }
    expect(edges).toBe(3);
  });
  it('rejects cross-asset and stale-snapshot IDs, cursors and source; verifies indexed content hash', () => {
    const f = fixture(); f.addNode('a'); f.addFile('a.ts', 'export function a() {}\n'); f.db.close();
    const s = f.search(); const q = { nodeId: s.nodes[0].id, indexVersion: s.indexVersion! };
    const source = queryStructured(f.ctx, 'graph-source', q); expect(source.source?.content).toContain('function a');
    expect(queryStructured({ ...f.ctx, assetId: 'cg-other' }, 'graph-node', q).state).toBe('version_expired');
    const other = queryStructured({ ...f.ctx, assetId: 'cg-other' }, 'graph-search', {});
    expect(queryStructured({ ...f.ctx, assetId: 'cg-other' }, 'graph-node', { ...q, indexVersion: other.indexVersion! }).state).toBe('not_found');
    expect(queryStructured({ ...f.ctx, version: 2 }, 'graph-source', q).state).toBe('version_expired');
    expect(queryStructured(f.ctx, 'graph-node', { ...q, nodeId: q.nodeId.slice(0, q.nodeId.lastIndexOf(':') + 1) + 'missing' }).state).toBe('not_found');
    writeFileSync(join(f.ctx.projectRoot, 'a.ts'), 'new working tree');
    expect(queryStructured(f.ctx, 'graph-source', q).warnings).toContain('source_changed_since_index');
  });
  it('refuses paths and symlinks outside the asset and limits source size', () => {
    const f = fixture(); const outside = mkdtempSync(join(tmpdir(), 'cg-outside-')); temps.push(outside);
    writeFileSync(join(outside, 'secret.ts'), 'secret'); symlinkSync(outside, join(f.ctx.projectRoot, 'escape'));
    f.addNode('evil', 'escape/secret.ts'); f.db.prepare('INSERT INTO files VALUES (?,?)').run('escape/secret.ts', createHash('sha256').update('secret').digest('hex'));
    f.addNode('large', 'large.ts'); f.addFile('large.ts', 'x'.repeat(GRAPH_LIMITS.sourceBytes + 1)); f.db.close();
    const s = f.search();
    for (const n of s.nodes) { const r = queryStructured(f.ctx, 'graph-source', { nodeId: n.id, indexVersion: s.indexVersion! }); expect(r.state).toBe('source_unavailable'); expect(r.source).toBeUndefined(); }
  });
  it('locates evidence beyond the first 300 lines in the same verified file with strict line bounds', () => {
    const f = fixture(); f.addNode('file', 'large.ts', 'file');
    const lines = Array.from({ length: 1200 }, (_, i) => i === 999 ? 'import { evidence } from "./base";' : `// line ${i + 1}`);
    f.addFile('large.ts', lines.join('\n')); f.db.prepare('UPDATE nodes SET end_line = 1200').run(); f.db.close();
    const s = f.search(), q = { nodeId: s.nodes[0].id, indexVersion: s.indexVersion! };
    expect(queryStructured(f.ctx, 'graph-source', q).source?.endLine).toBe(300);
    const r = queryStructured(f.ctx, 'graph-source', { ...q, sourceLine: 1000 });
    expect(r.source).toMatchObject({ filePath: 'large.ts', startLine: 950, endLine: 1200 });
    expect(r.source!.content.split('\n')[1000 - r.source!.startLine]).toBe(lines[999]);
    expect(r.source!.content.split('\n').length).toBeLessThanOrEqual(300);
    for (const sourceLine of [0, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER]) expect(() => validateStructuredRequest('graph-source', { ...q, sourceLine })).toThrow();
    expect(() => validateStructuredRequest('graph-node', { ...q, sourceLine: 1000 })).toThrow();
    const outside = queryStructured(f.ctx, 'graph-source', { ...q, sourceLine: 1201 });
    expect(outside.state).toBe('source_unavailable'); expect(outside.warnings).toContain('source_line_out_of_range'); expect(outside.source).toBeUndefined();
    writeFileSync(join(f.ctx.projectRoot, 'large.ts'), 'changed');
    expect(queryStructured(f.ctx, 'graph-source', { ...q, sourceLine: 1000 }).state).toBe('version_expired');
  });
  it('bounds depth, rejects undeclared routing fields, and distinguishes unsupported schema/version', () => {
    for (const body of [{ depth: 6 }, { limit: 501 }, { edgeLimit: 1501 }, { team_id: 'evil' }, { scopePath: '../secret' }, { nodeId: 'x' }, { mode: ['calls'] }, { direction: ['in'] }]) expect(() => validateStructuredRequest('graph', body)).toThrow();
    const f = fixture(); f.addNode('a'); f.db.close(); expect(queryStructured({ ...f.ctx, sdkVersion: '1.2.0' }, 'graph-search', {}).state).toBe('unsupported');
    const db = new Database(f.ctx.databasePath); db.exec('DROP INDEX idx_edges_target_kind'); db.close(); expect(f.search().warnings).toContain('unsupported_index_schema');
  });
  it('rejects a database replaced between snapshot capture and opening', () => {
    const f = fixture(); f.addNode('old'); f.db.close();
    const replacement = fixture(); replacement.addNode('new'); replacement.db.close();
    let swapped = false;
    Object.defineProperty(f.ctx, 'projectRoot', { enumerable: true, get() {
      if (!swapped) { swapped = true; renameSync(replacement.ctx.databasePath, f.ctx.databasePath); }
      return '';
    } });
    const r = queryStructured(f.ctx, 'graph-search', {});
    expect(r.state).toBe('version_expired'); expect(r.nodes).toEqual([]);
  });
  it('reports unsupported language distinctly from a supported empty graph', () => {
    const f = fixture(); f.addNode('a'); f.db.prepare("UPDATE nodes SET language = 'rust'").run(); f.db.close();
    const s = f.search(); expect(s.warnings).toContain('unverified_language:rust');
    expect(queryStructured(f.ctx, 'graph', { nodeId: s.nodes[0].id, indexVersion: s.indexVersion! }).state).toBe('unsupported');
  });
  it('uses indexed adjacency seeks rather than full-edge scans', () => {
    const f = fixture();
    for (const side of ['source', 'target']) {
      const plans = f.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM edges INDEXED BY idx_edges_${side}_kind WHERE ${side} = ? AND kind = 'calls' AND id > ? ORDER BY id LIMIT 1`).all('x', 0) as { detail: string }[];
      expect(plans.map(p => p.detail).join(' ')).toContain(`USING INDEX idx_edges_${side}_kind`);
      expect(plans.map(p => p.detail).join(' ')).not.toContain('TEMP B-TREE');
    }
    f.db.close();
  });
});
