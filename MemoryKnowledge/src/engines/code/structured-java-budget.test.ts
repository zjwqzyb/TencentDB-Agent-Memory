import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryStructured, type StructuredContext } from './structured.js';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cg-java-budget-')); roots.push(root);
  const db = new Database(join(root, 'index.db'));
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
  const node = (id: string, kind: string, name: string, qualified: string, file: string) => db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,1,2)').run(id, kind, name, qualified, file, 'java');
  const file = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
    db.prepare('INSERT INTO files VALUES(?,?)').run(path, createHash('sha256').update(content).digest('hex'));
  };
  const edge = (id: number, source: string, target: string, kind: string, col = 0, metadata: Record<string, unknown> = {}, provenance: string | null = null) => db.prepare('INSERT INTO edges VALUES(?,?,?,?,1,?,?,?)').run(id, source, target, kind, col, JSON.stringify(metadata), provenance);
  const ctx: StructuredContext = { assetId: 'java-budget', projectRoot: root, databasePath: join(root, 'index.db'), sdkVersion: '1.6.2', version: 1, commit: null, indexedAt: 'fixture', branch: 'main' };
  node('leaf', 'method', 'leaf', 'demo.util::Utility::leaf', 'util/Utility.java');
  node('Utility', 'class', 'Utility', 'demo.util::Utility', 'util/Utility.java');
  file('util/Utility.java', 'package demo.util; class Utility { void leaf() {} }');
  return { db, node, file, edge, ctx };
}
function pages(ctx: StructuredContext, mode: 'calls' | 'impact', maxPages = 20) {
  const search = queryStructured(ctx, 'graph-search', { query: 'demo.util::Utility::leaf', nodeKinds: ['method'] });
  const q: CodeGraphRequest = { nodeId: search.nodes[0].id, indexVersion: search.indexVersion!, mode, direction: 'in', depth: 1, limit: 500, edgeLimit: 1500 };
  const results: CodeGraphResponse[] = [];
  let r = queryStructured(ctx, 'graph', q);
  do {
    expect(r.work!.rowsRead).toBeLessThanOrEqual(2000); expect(r.state).not.toBe('version_expired');
    results.push(r); expect(results.length).toBeLessThanOrEqual(maxPages);
    if (!r.nextCursor) break;
    const next = queryStructured(ctx, 'graph', { ...q, cursor: r.nextCursor });
    expect(queryStructured(ctx, 'graph', { ...q, cursor: r.nextCursor }).edges).toEqual(next.edges);
    r = next;
  } while (true);
  return results;
}

describe('Java validation preserves pending edges across page budgets', () => {
  it.each(['calls', 'impact'] as const)('resumes all %s across more than 2MiB of call-site files', mode => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const source = `package demo.app; import demo.util.Utility; class Caller${i} { void entry() { Utility.leaf(); } } /*${'x'.repeat(1100 * 1024)}*/`;
      const path = `app/Caller${i}.java`;
      f.node(`caller${i}`, 'method', 'entry', `demo.app::Caller${i}::entry`, path); f.file(path, source);
      f.edge(i + 1, `caller${i}`, 'leaf', 'calls', source.indexOf('Utility.leaf()'), { confidence: 0.9, resolvedBy: 'import', refName: 'Utility.leaf' });
    }
    f.db.close();
    const result = pages(f.ctx, mode, 4), edges = result.flatMap(r => r.edges);
    expect(result.length).toBe(3); expect(edges).toHaveLength(3); expect(new Set(edges.map(e => e.id)).size).toBe(3);
    expect(result[0].truncationReasons).toContain('source_byte_budget'); expect(result[0].warnings).toContain('java_relation_source_budget');
    expect(result.at(-1)!.truncated).toBe(false);
  });

  it.each(['calls', 'impact'] as const)('resumes %s when indexed owner validation exhausts the SQL row budget', mode => {
    const f = fixture();
    f.node('synthetic', 'method', 'fake', 'demo.app::Synthetic::fake', 'app/Synthetic.java');
    for (let i = 1; i <= 1800; i++) f.edge(i, 'synthetic', 'leaf', 'calls', 0, { synthesizedBy: 'interface-impl' }, 'heuristic');
    f.edge(5000, 'Utility', 'leaf', 'contains');
    for (let i = 0; i < 100; i++) {
      const source = `package demo.app; class Caller${i} extends demo.util.Utility { void entry() { this.leaf(); } }`, path = `app/Caller${i}.java`;
      f.node(`caller${i}`, 'method', 'entry', `demo.app::Caller${i}::entry`, path); f.node(`class${i}`, 'class', `Caller${i}`, `demo.app::Caller${i}`, path); f.file(path, source);
      f.edge(1801 + i, `caller${i}`, 'leaf', 'calls', source.indexOf('this.leaf()'), { confidence: 0.7, resolvedBy: 'exact-match', refName: 'leaf' });
      f.edge(5001 + i * 2, `class${i}`, `caller${i}`, 'contains'); f.edge(5002 + i * 2, `class${i}`, 'Utility', 'extends');
    }
    f.db.close();
    const result = pages(f.ctx, mode), edges = result.flatMap(r => r.edges);
    expect(result.length).toBeGreaterThan(1); expect(edges).toHaveLength(100); expect(new Set(edges.map(e => e.id)).size).toBe(100);
    expect(result.some(r => r.work!.rowsRead === 2000)).toBe(true);
    expect(result[0].truncationReasons).toContain('scan_budget'); expect(result.at(-1)!.truncated).toBe(false);
  });
});
