import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';
import { closeIndex, indexProject, structuredSdkInfo, type CodeGraphInstance } from './bridge.js';
import { maskJavaNonCode, parseJavaImports } from './java-import-declarations.js';
import { GRAPH_LIMITS, queryStructured, type StructuredContext } from './structured.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'java-aggregation-')); roots.push(root); return root; };
function fixture() {
  const root = temp(), databasePath = join(root, 'index.db');
  const db = new Database(databasePath);
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);
    CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,file_path TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_unresolved_from_node ON unresolved_refs(from_node_id);`);
  const content = new Map<string, string>();
  const paths = new Map<string, string>();
  const ctx: StructuredContext = { assetId: 'cg-java-deps', projectRoot: root, databasePath, sdkVersion: '1.6.2', version: 1, commit: 'java-fixture', indexedAt: 'fixture', branch: 'main' };
  const node = (id: string, path: string, kind = 'file', qualified = id) => {
    paths.set(id, path); content.set(path, content.get(path) ?? '');
    db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)').run(id, kind, qualified.split('::').at(-1), qualified, path, 'java', 1, 200);
  };
  const edge = (id: number, source: string, target: string, line = 1, col = 0, kind = 'imports', provenance: string | null = null, metadata: Record<string, unknown> = { refName: 'run' }) =>
    db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)').run(id, source, target, kind, line, col, JSON.stringify(metadata), provenance);
  const unresolved = (id: number, source: string, name: string, line: number, col = 0) =>
    db.prepare('INSERT INTO unresolved_refs VALUES (?,?,?,?,?,?,?)').run(id, source, name, 'imports', paths.get(source), line, col);
  const query = (request: CodeGraphRequest = {}) => queryStructured(ctx, 'graph', { mode: 'dependencies', ...request });
  const close = () => {
    for (const [path, text] of content) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
      db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)').run(path, createHash('sha256').update(text).digest('hex'));
    }
    db.close();
  };
  return { ctx, db, content, node, edge, unresolved, query, close };
}
function pages(query: (request: CodeGraphRequest) => CodeGraphResponse, initial: CodeGraphRequest = {}) {
  const results: CodeGraphResponse[] = []; let cursor: string | undefined;
  do {
    const result = query({ ...initial, ...(cursor ? { cursor } : {}) }); results.push(result);
    expect(result.work!.rowsRead).toBeLessThanOrEqual(GRAPH_LIMITS.rows);
    expect(results.length).toBeLessThan(50); cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return results;
}

describe('Java dependency declaration anchors', () => {
  it('recognizes static, wildcard, multiline and comment-separated header imports with original offsets', () => {
    const source = ['/* import fake.Comment; */', 'package demo.app;', '/* 中文 */ import demo.api.Runner; import static demo.util.Helper.run;',
      'import /* gap */ demo.', ' util /* gap */ . * ;', '// import fake.Line;', 'class App { String text = "import fake.String;"; }'].join('\n');
    const imports = parseJavaImports(source);
    expect(imports.map(item => [item.specifier, item.static, item.wildcard, item.line])).toEqual([
      ['demo.api.Runner', false, false, 3], ['demo.util.Helper.run', true, false, 3], ['demo.util.*', false, true, 4],
    ]);
    for (const item of imports) { expect(source.slice(item.start, item.end)).toMatch(/^import[\s\S]*;$/); }
    const masked = maskJavaNonCode(source);
    expect(masked.length).toBe(source.length); expect(masked.split('\n').length).toBe(source.split('\n').length);
    expect(masked).not.toContain('fake'); expect(masked).toContain('demo.api.Runner');
  });

  it('never treats comments, strings, chars, text blocks, malformed declarations or Unicode preprocessing as imports', () => {
    const source = ['String s = "import fake.String;";', "char c = '\\'';", 'String text = """', 'import fake.TextBlock;', '""";',
      '/* import fake.Block; */', '// import fake.Line;', 'import "fake.Quoted";', 'import missing.Semicolon', 'class App { import fake.Body; }'].join('\n');
    expect(parseJavaImports(source)).toEqual([]);
    expect(parseJavaImports('import demo.Real; // \\u000a import fake.Escape;')).toEqual([]);
    expect(parseJavaImports('import demo.Real; /* import fake.Unclosed;')).toHaveLength(1);
  });
});

describe('bounded Java aggregation', () => {
  it('deduplicates actual targets, retains unresolved imports and reconciles symbol clusters and paged evidence', () => {
    const f = fixture();
    f.node('app', 'app/App.java', 'namespace', 'demo.app'); f.node('runner', 'api/Runner.java', 'interface', 'demo.api::Runner');
    f.node('run', 'api/Runner.java', 'method', 'demo.api::Runner::run'); f.node('helper', 'util/Helper.java', 'class', 'demo.util::Helper');
    f.content.set('app/App.java', ['package demo.app;', '/* 中文 */ import demo.api.Runner; import static demo.api.Runner.run;',
      'import demo.api.', ' Runner;', 'import demo.util.*;', 'import java.util.List;', 'import fs;', 'import demo.missing.Unobserved;', 'import demo.ghost.*;', 'class App {}'].join('\r\n'));
    f.edge(1, 'app', 'runner', 2, 13); f.edge(2, 'app', 'run', 2, 20); f.edge(3, 'app', 'runner', 4, 1); f.edge(4, 'app', 'helper', 5);
    f.unresolved(1, 'app', 'demo.api.Runner.run', 2, 44); f.unresolved(2, 'app', 'java.util.List', 6); f.unresolved(3, 'app', 'fs', 7); f.close();
    const result = f.query({ groupBy: 'file' });
    expect(result.aggregation?.complete).toBe(true); expect(result.aggregation?.distinctSiteCount).toBe(6);
    const names = new Map(result.nodes.map(node => [node.id, node.name]));
    const appRunner = result.edges.find(edge => names.get(edge.source) === 'app/App.java' && names.get(edge.target) === 'api/Runner.java')!;
    expect(appRunner.count).toBe(2); expect(appRunner.evidence.map(item => [item.line, item.column])).toEqual([[2, 13], [3, 0]]);
    expect(result.nodes.filter(node => node.aggregate?.resolution === 'unresolved').map(node => node.name).sort()).toEqual(['demo.api.Runner.run', 'fs', 'java.util.List']);
    expect(result.nodes.some(node => node.aggregate?.resolution === 'external')).toBe(false);
    expect(result.nodes.some(node => node.name === 'demo.missing.Unobserved')).toBe(false);
    expect(result.nodes.some(node => node.name === 'demo.ghost.*')).toBe(false);
    const evidenceRequest = { groupBy: 'file' as const, evidenceFor: appRunner.id, indexVersion: result.indexVersion!, edgeLimit: 1 };
    const proofPages = pages(f.query, evidenceRequest), proof = proofPages.flatMap(page => page.dependencyEvidence ?? []);
    expect(proof).toHaveLength(2); expect(proof.map(item => [item.line, item.column])).toEqual([[2, 13], [3, 0]]);
    expect(f.query({ ...evidenceRequest, cursor: proofPages[0].nextCursor! }).dependencyEvidence).toEqual(proofPages[1].dependencyEvidence);
    for (const item of proof) {
      expect(queryStructured(f.ctx, 'graph-source', { nodeId: item.sourceId, indexVersion: result.indexVersion! }).source?.content).toContain('package demo.app');
    }
    const files = f.query({ mode: 'clusters', groupBy: 'file', scopePath: 'api/Runner.java' });
    const symbols = f.query({ mode: 'clusters', groupBy: 'symbol', scopePath: 'api/Runner.java' });
    expect(symbols.aggregation?.distinctSiteCount).toBe(files.aggregation?.distinctSiteCount);
    expect(symbols.nodes.filter(node => !node.aggregate).map(node => node.qualifiedName).sort()).toEqual(['demo.api::Runner', 'demo.api::Runner::run']);
    expect(symbols.edges).toHaveLength(2);
  });

  it('applies the shared Java call validator before dependencies or clusters count heuristic relations', () => {
    const f = fixture(); f.node('a', 'api/Runner.java', 'method', 'demo.api::Runner::run'); f.node('b', 'app/App.java', 'method', 'demo.app::App::run');
    f.edge(1, 'a', 'b', 2, 0, 'calls', 'heuristic');
    // The rejected relation is seen on the first page; its warning must survive
    // later pages that only scan unrelated kinds.
    f.db.transaction(() => { for (let id = 2; id <= 2300; id++) f.edge(id, 'a', 'b', 2, 0, 'contains'); })(); f.close();
    for (const mode of ['dependencies', 'clusters'] as const) {
      const scan = pages(f.query, { mode, edgeKinds: ['calls'] }), result = scan.at(-1)!;
      expect(scan.length).toBeGreaterThan(1);
      expect(result.edges).toEqual([]); expect(result.aggregation?.distinctSiteCount).toBe(0);
      expect(result.aggregation?.complete).toBe(false); expect(result.warnings).toContain('java_heuristic_relations_omitted');
    }
  });

  it('keeps hash verification, source containment and cumulative source budgets for Java imports', () => {
    const f = fixture(); f.node('a', 'a/App.java'); f.node('b', 'b/App.java'); f.node('t', 'api/Runner.java');
    for (const path of ['a/App.java', 'b/App.java']) f.content.set(path, `package demo;\nimport demo.api.Runner;\n/*${'x'.repeat(1100 * 1024)}*/\nclass App {}`);
    f.edge(1, 'a', 't', 2); f.edge(2, 'b', 't', 2); f.close();
    const scan = pages(f.query); expect(scan[0].truncationReasons).toContain('source_scan_budget');
    expect(scan.at(-1)!.aggregation?.complete).toBe(true); expect(scan.at(-1)!.edges).toHaveLength(2);
    writeFileSync(join(f.ctx.projectRoot, 'a/App.java'), 'package changed;');
    const changed = f.query(); expect(changed.state).toBe('version_expired'); expect(changed.nodes).toEqual([]); expect(changed.edges).toEqual([]);
    const outside = temp(); writeFileSync(join(outside, 'App.java'), 'import demo.api.Runner;');
    rmSync(join(f.ctx.projectRoot, 'a'), { recursive: true }); symlinkSync(outside, join(f.ctx.projectRoot, 'a'));
    const unsafe = f.query(); expect(unsafe.aggregation?.complete).toBe(false); expect(unsafe.warnings).toContain('import_declaration_source_unavailable');
    expect(JSON.stringify(unsafe)).not.toContain(outside);
  });

  it.each(['dependencies', 'clusters'] as const)('resumes %s calls and their evidence after cumulative source validation exceeds 2MiB', mode => {
    const f = fixture(); f.node('leaf', 'util/Utility.java', 'method', 'demo.util::Utility::leaf');
    f.content.set('util/Utility.java', 'package demo.util; class Utility { void leaf() {} }');
    for (let index = 0; index < 3; index++) {
      const path = `app/Caller${index}.java`;
      const source = `package demo.app; import demo.util.Utility; class Caller${index} { void entry() { Utility.leaf(); } } /*${'x'.repeat(1100 * 1024)}*/`;
      f.node(`caller${index}`, path, 'method', `demo.app::Caller${index}::entry`); f.content.set(path, source);
      f.edge(index + 1, `caller${index}`, 'leaf', 1, source.indexOf('Utility.leaf()'), 'calls', null,
        { confidence: 0.9, resolvedBy: 'import', refName: 'Utility.leaf' });
    }
    f.close();
    const request: CodeGraphRequest = { mode, groupBy: 'file', edgeKinds: ['calls'] };
    const scan = pages(f.query, request), result = scan.at(-1)!;
    expect(scan).toHaveLength(3); expect(scan[0].truncationReasons).toContain('source_byte_budget');
    expect(scan[0].warnings).toContain('java_relation_source_budget');
    expect(scan.map(page => page.aggregation?.distinctSiteCount)).toEqual([1, 2, 3]);
    expect(result.edges).toHaveLength(3); expect(result.edges.every(edge => edge.count === 1)).toBe(true);
    expect(result.aggregation?.complete).toBe(true); expect(result.truncated).toBe(false);
    expect(result.warnings).not.toContain('java_relation_source_budget');
    expect(f.query({ ...request, cursor: scan[0].nextCursor! }).edges).toEqual(scan[1].edges);
    const proofs = pages(f.query, { ...request, evidenceFor: result.edges[2].id, indexVersion: result.indexVersion! });
    expect(proofs.flatMap(page => page.dependencyEvidence ?? [])).toHaveLength(1);
    expect(proofs.at(-1)!.aggregation?.complete).toBe(true);
  });

  it.each(['dependencies', 'clusters'] as const)('resumes %s calls when owner validation reaches the SQL row budget', mode => {
    const f = fixture();
    f.node('utility', 'util/Utility.java', 'class', 'demo.util::Utility'); f.node('leaf', 'util/Utility.java', 'method', 'demo.util::Utility::leaf');
    f.content.set('util/Utility.java', 'package demo.util; class Utility { void leaf() {} }');
    f.edge(5000, 'utility', 'leaf', 1, 0, 'contains');
    // Unrelated kinds consume the same bounded primary-key scan without making
    // the final aggregate semantically incomplete.
    const padding = 1761;
    f.db.transaction(() => {
      for (let id = 1; id <= padding; id++) f.edge(id, 'utility', 'leaf', 1, 0, 'contains');
      for (let index = 0; index < 30; index++) {
        const path = `app/Caller${index}.java`, methodId = `caller${index}`, classId = `class${index}`;
        const source = `package demo.app; class Caller${index} extends demo.util.Utility { void entry() { this.leaf(); } }`;
        f.node(methodId, path, 'method', `demo.app::Caller${index}::entry`); f.node(classId, path, 'class', `demo.app::Caller${index}`); f.content.set(path, source);
        f.edge(padding + 1 + index, methodId, 'leaf', 1, source.indexOf('this.leaf()'), 'calls', null,
          { confidence: 0.7, resolvedBy: 'exact-match', refName: 'leaf' });
        f.edge(5001 + index * 2, classId, methodId, 1, 0, 'contains'); f.edge(5002 + index * 2, classId, 'utility', 1, 0, 'extends');
      }
    })(); f.close();
    const scan = pages(f.query, { mode, groupBy: 'file', edgeKinds: ['calls'] }), result = scan.at(-1)!;
    expect(scan.length).toBeGreaterThan(1); expect(scan[0].truncationReasons).toContain('scan_budget');
    expect(scan[0].warnings).toContain('java_relation_source_budget');
    expect(scan.some(page => page.work!.rowsRead === GRAPH_LIMITS.rows)).toBe(true);
    expect(result.edges).toHaveLength(30); expect(result.edges.every(edge => edge.count === 1)).toBe(true);
    expect(result.aggregation?.distinctSiteCount).toBe(30); expect(result.aggregation?.complete).toBe(true); expect(result.truncated).toBe(false);
  });

  it('uses real SDK Java imports without inventing edges for unresolved static members', async () => {
    const root = temp(); let instance: CodeGraphInstance | undefined;
    try {
      const sources = {
        'api/Runner.java': 'package demo.api; public interface Runner { void run(); }',
        'util/Helper.java': 'package demo.util; public class Helper { public static void leaf() {} public static void run() {} }',
        'app/App.java': 'package demo.app;\nimport demo.api.Runner;\nimport demo.util.Helper;\nimport static demo.util.Helper.run;\nimport java.util.List;\npublic class App implements Runner { public void run() { Helper.leaf(); } }',
        'app/Wild.java': 'package demo.app;\nimport demo.util.*;\npublic class Wild { public void run() { Helper.leaf(); } }',
      };
      for (const [path, source] of Object.entries(sources)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); }
      instance = await indexProject(root); const info = await structuredSdkInfo(root);
      const ctx: StructuredContext = { assetId: 'java-real-deps', projectRoot: root, databasePath: info.databasePath, sdkVersion: info.version, version: 1, commit: 'fixture', indexedAt: 'fixture', branch: 'main' };
      const result = queryStructured(ctx, 'graph', { mode: 'dependencies', groupBy: 'file' });
      expect(result.state).toBe('ready'); expect(result.aggregation?.complete).toBe(true);
      expect(result.edges.filter(edge => edge.resolution === 'internal').reduce((total, edge) => total + edge.count!, 0)).toBe(3);
      expect(result.nodes.filter(node => node.aggregate?.resolution === 'unresolved').map(node => node.name).sort()).toEqual(['demo.util.Helper.run', 'java.util.List']);
      expect(result.warnings).not.toContain('import_declaration_anchor_unverified');
      for (const edge of result.edges) {
        const proof = queryStructured(ctx, 'graph', { mode: 'dependencies', groupBy: 'file', evidenceFor: edge.id, indexVersion: result.indexVersion! });
        expect(proof.dependencyEvidence?.length).toBe(edge.count);
        expect(proof.dependencyEvidence?.every(item => item.line >= 2 && item.column === 0)).toBe(true);
      }
      const symbols = queryStructured(ctx, 'graph', { mode: 'clusters', groupBy: 'symbol', scopePath: 'api/Runner.java' });
      expect(symbols.state).toBe('ready'); expect(symbols.aggregation?.complete).toBe(true);
      expect(symbols.edges).toHaveLength(1);
      expect(symbols.nodes.find(node => node.id === symbols.edges[0].target)?.qualifiedName).toBe('demo.api::Runner');
    } finally { if (instance) closeIndex(instance); }
  }, 120_000);
});
