import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_LIMITS, queryStructured, type StructuredContext } from './structured.js';
import { querySearch, type SearchState } from './structured-search.js';
import type { CodeGraphRequest } from '../../contracts/code-graph.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture(indexes = true) {
  const root = mkdtempSync(join(tmpdir(), 'indexed-cg-search-')); roots.push(root);
  const path = join(root, 'index.db'), db = new Database(path);
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
  if (indexes) db.exec(`CREATE INDEX idx_nodes_lower_name ON nodes(lower(name)); CREATE INDEX idx_nodes_name ON nodes(name); CREATE INDEX idx_nodes_file_path ON nodes(file_path);`);
  const insert = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)');
  const add = (id: string, name: string, path = `${id}.ts`, kind = 'class', qualified = `${path}:${name}`) => insert.run(id, kind, name, qualified, path, 'typescript', 1, 2);
  const ctx: StructuredContext = { assetId: 'cg-indexed', projectRoot: root, databasePath: path, sdkVersion: '1.6.2', version: 1, indexedAt: 'fixture', commit: 'head', branch: 'main' };
  return { db, ctx, add };
}
function all(db: Database.Database, request: CodeGraphRequest, budget = GRAPH_LIMITS.rows) {
  const rows: string[] = [], pages: ReturnType<typeof querySearch>[] = [];
  let state: SearchState | undefined;
  do {
    const result = querySearch(db, 'graph-search', request, state, budget);
    rows.push(...result.rows.map(r => r.id)); pages.push(result); state = result.continuation;
    expect(result.rowsRead).toBeLessThanOrEqual(budget); expect(pages.length).toBeLessThan(2000);
  } while (state);
  return { rows, pages };
}

describe('indexed bounded symbol search', () => {
  it('returns both late exact classes before their earlier prefix family on the first response', () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let i = 0; i < 8500; i++) f.add(`noise-${i}`, 'Other');
      for (let i = 0; i < 140; i++) f.add(`prefix-${i}`, 'SvcClaimFault');
      f.add('exact-app', 'SvcClaim', 'biz/app/SvcClaim.java');
      for (let i = 0; i < 5000; i++) f.add(`later-${i}`, 'Other');
      f.add('exact-svc', 'SvcClaim', 'biz/svc/SvcClaim.java');
      f.add('lower-prefix', 'svcClaimCode');
    })(); f.db.close();
    const result = queryStructured(f.ctx, 'graph-search', { query: 'SvCcLaIm' });
    expect(result.nodes).toHaveLength(100);
    expect(result.nodes.slice(0, 2).map(n => n.filePath)).toEqual(['biz/app/SvcClaim.java', 'biz/svc/SvcClaim.java']);
    expect(result.work!.rowsRead).toBeLessThan(200);
    expect(result.truncationReasons).toEqual(['node_budget']);
  });

  it('keeps same-name and prefix keyset positions stable across windows, pages and tiny budgets', () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let i = 0; i < 125; i++) f.add(`same-${i}`, 'Match');
      for (let i = 0; i < 255; i++) f.add(`alpha-${i}`, 'MatchAlpha');
      for (let i = 0; i < 60; i++) f.add(`beta-${i}`, 'matchBeta');
      f.add('substring', 'xMatch'); f.add('path', 'Other', 'dir/Match.java'); f.add('qualified', 'Other', 'elsewhere.java', 'class', 'pkg::Match');
    })();
    const expected = f.db.prepare("SELECT id FROM nodes WHERE lower(name) = 'match' ORDER BY rowid").all() as { id: string }[];
    const result = all(f.db, { query: 'MATCH', limit: 7 }, 31);
    expect(result.rows.slice(0, 125)).toEqual(expected.map(r => r.id));
    expect(result.rows).toHaveLength(443); expect(new Set(result.rows).size).toBe(443);
    expect(result.rows.slice(-3)).toEqual(['substring', 'path', 'qualified']);
    const one = all(f.db, { query: 'match', limit: 1 }, 7);
    expect(new Set(one.rows)).toEqual(new Set(result.rows)); expect(one.rows).toHaveLength(result.rows.length);
    const first = querySearch(f.db, 'graph-search', { query: 'MATCH', limit: 7 }, undefined, 31);
    const repeatedA = querySearch(f.db, 'graph-search', { query: 'MATCH', limit: 7 }, first.continuation, 31);
    const repeatedB = querySearch(f.db, 'graph-search', { query: 'MATCH', limit: 7 }, first.continuation, 31);
    expect(repeatedA).toEqual(repeatedB); f.db.close();
  });

  it('treats percent, underscore, quotes and high Unicode as literal prefix text', () => {
    const f = fixture();
    const queries = ['name%', 'name_', "a'b", '𐀀', '\ud7ff', '\uffff', String.fromCodePoint(0x10ffff), 'literal '];
    for (const query of queries) {
      f.add(`exact-${query}`, query); f.add(`prefix-${query}`, `${query}suffix`); f.add(`substring-${query}`, `x${query}`);
    }
    f.add('decoy', 'nameANY');
    for (const query of queries) {
      const found = all(f.db, { query, limit: 1 }, 9);
      expect(found.rows).toEqual([`exact-${query}`, `prefix-${query}`, `substring-${query}`]);
    }
    expect(all(f.db, { query: ' literal ', limit: 2 }, 9).rows).toEqual([]); f.db.close();
  });

  it('preserves Unicode case folding and substring matching across name, qualified name and path', () => {
    const f = fixture();
    f.add('upper', 'Äpfel'); f.add('lower', 'äpfel'); f.add('inside', 'xÄpFeL');
    f.add('path', 'Other', 'dir/ÄPFEL.ts'); f.add('qualified', 'Other', 'else.ts', 'class', 'pkg::äpfel');
    const result = all(f.db, { query: 'ÄPFEL', limit: 2 }, 9);
    expect(new Set(result.rows)).toEqual(new Set(['upper', 'lower', 'inside', 'path', 'qualified']));
    expect(result.rows).toHaveLength(5); f.db.close();
  });

  it('seeks scoped paths directly for fallback and distinguishes exact paths, descendants and siblings', () => {
    const f = fixture();
    f.db.transaction(() => { for (let i = 0; i < 10000; i++) f.add(`outside-${i}`, 'Other', `outside/${i}.ts`); })();
    f.add('scope-file', 'root', 'target'); f.add('descendant', 'wanted', 'target/deep/file.ts');
    f.add('file', 'file', 'target/deep/tree.ts', 'file'); f.add('sibling', 'wanted', 'target-other/file.ts');
    f.add('punctuation', 'wanted', 'target.file.ts'); f.add('case', 'wanted', 'Target/deep/file.ts');
    const result = all(f.db, { scopePath: 'target/', query: 'target', limit: 1 });
    expect(result.rows).toEqual(['scope-file', 'descendant', 'file']);
    expect(result.pages.reduce((n, r) => n + r.rowsRead, 0)).toBeLessThan(30);
    expect(all(f.db, { scopePath: 'target/deep/file.ts', limit: 1 }).rows).toEqual(['descendant']);
    const tree = querySearch(f.db, 'graph-tree', { scopePath: 'target' }, undefined, 2000);
    expect(tree.rows.map(r => r.id)).toEqual(['file']); expect(tree.rowsRead).toBeLessThan(10);
    expect(all(f.db, { query: 'wanted', scopePath: 'target', nodeKinds: ['function'] }).rows).toEqual([]); f.db.close();
  });

  it('bounds rejected indexed candidates before applying selective SQL scope/kind filters', () => {
    const f = fixture();
    f.db.transaction(() => { for (let i = 0; i < 6000; i++) f.add(`outside-${i}`, 'same', 'outside.ts'); })();
    f.add('inside', 'same', 'target/inside.ts', 'function');
    const first = querySearch(f.db, 'graph-search', { query: 'same', scopePath: 'target', nodeKinds: ['function'] }, undefined, 2000);
    expect(first.rows).toEqual([]); expect(first.reason).toBe('scan_budget'); expect(first.rowsRead).toBe(2000);
    const result = all(f.db, { query: 'same', scopePath: 'target', nodeKinds: ['function'] });
    expect(result.rows).toEqual(['inside']); f.db.close();
  });

  it('falls back safely when search indexes are missing or have unverified expressions/collations', () => {
    for (const change of ['none', 'wrong-expression', 'partial', 'nocase']) {
      const f = fixture(false);
      if (change === 'wrong-expression') f.db.exec('CREATE INDEX idx_nodes_lower_name ON nodes(upper(name))');
      if (change === 'partial') f.db.exec("CREATE INDEX idx_nodes_lower_name ON nodes(lower(name)) WHERE kind = 'file'");
      if (change === 'nocase') f.db.exec('CREATE INDEX idx_nodes_name ON nodes(name COLLATE NOCASE)');
      f.add('first', 'xTarget'); f.add('second', 'TARGET');
      expect(all(f.db, { query: 'target', limit: 1 }, 3).rows).toEqual(['first', 'second']); f.db.close();
    }
  });

  it('uses verified index seeks before only bounded materialized candidate sorts', () => {
    const f = fixture(); f.add('a', 'Find'); f.add('b', 'FindMore'); f.add('c', 'other', 'scope/file.ts');
    const prepare = f.db.prepare.bind(f.db), plans: string[] = [], statements: { sql: string; params: BindForTest[] }[] = [];
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith('WITH candidates')) return statement;
      return { all(...params: BindForTest[]) { statements.push({ sql, params }); return statement.all(...params); } } as typeof statement;
    });
    all(f.db, { query: 'find', limit: 1 }, 9); all(f.db, { scopePath: 'scope', query: 'file' }, 9);
    vi.restoreAllMocks();
    for (const { sql, params } of statements) {
      const details = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
      const nodesPlan = details.filter(p => /\bnodes\b/.test(p.detail)).map(p => p.detail).join(' ');
      expect(nodesPlan).not.toContain('SCAN nodes'); plans.push(nodesPlan);
      expect(sql).toContain('AS MATERIALIZED'); expect(sql).not.toContain('LIKE');
    }
    expect(plans.some(p => p.includes('idx_nodes_lower_name'))).toBe(true);
    expect(plans.some(p => p.includes('idx_nodes_file_path'))).toBe(true); f.db.close();
  });

  it('retains snapshot, asset and every query-input binding for the staged continuation', () => {
    const f = fixture(); for (let i = 0; i < 5; i++) f.add(`n${i}`, 'Find'); f.db.close();
    const first = queryStructured(f.ctx, 'graph-search', { query: 'find', limit: 1 });
    const request = { query: 'find', limit: 1, cursor: first.nextCursor! };
    expect(queryStructured(f.ctx, 'graph-search', request).nodes).toHaveLength(1);
    for (const patch of [{ query: 'changed' }, { scopePath: 'x' }, { nodeKinds: ['class'] }, { limit: 2 }]) {
      expect(queryStructured(f.ctx, 'graph-search', { ...request, ...patch }).state).toBe('version_expired');
    }
    expect(queryStructured({ ...f.ctx, assetId: 'other' }, 'graph-search', request).state).toBe('version_expired');
    const changed = new Database(f.ctx.databasePath); changed.prepare("UPDATE nodes SET name = 'New' WHERE id = 'n0'").run(); changed.close();
    expect(queryStructured(f.ctx, 'graph-search', request).state).toBe('version_expired');
  });
});
type BindForTest = string | number;
