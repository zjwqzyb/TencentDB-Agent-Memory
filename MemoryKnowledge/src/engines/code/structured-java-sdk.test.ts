import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { indexProject, closeIndex, structuredSdkInfo, type CodeGraphInstance } from './bridge.js';
import { queryStructured, type StructuredContext } from './structured.js';
import type { CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';

const root = mkdtempSync(join(tmpdir(), 'real-codegraph-java-'));
let instance: CodeGraphInstance, ctx: StructuredContext;
const files: Record<string, string> = {
  'src/api/Root.java': 'package demo.api;\npublic interface Root { void root(); }\n',
  'src/api/Left.java': 'package demo.api;\npublic interface Left extends Root {}\n',
  'src/api/Right.java': 'package demo.api;\npublic interface Right extends Root {}\n',
  'src/api/Runner.java': 'package demo.api;\npublic interface Runner extends Left, Right { void run(); }\n',
  'src/api/Tag.java': 'package demo.api;\npublic interface Tag { void tag(); }\n',
  'src/base/Base.java': 'package demo.base;\npublic class Base { public void base() {} public static void stat() {} }\n',
  'src/util/Helper.java': 'package demo.util;\npublic class Helper { public static void leaf() {} public void instance() {} }\n',
  'src/util/Utility.java': 'package demo.util;\npublic class Utility { public static void leaf() {} }\n',
  'src/other/Helper.java': 'package demo.other;\npublic class Helper { public static void leaf() {} }\n',
  'src/app/Child.java': 'package demo.app;\nimport demo.api.Runner;\nimport demo.api.Tag;\nimport demo.base.Base;\nimport demo.util.Helper;\nimport java.util.List;\nimport static demo.base.Base.stat;\nimport demo.util.Utility;\npublic class Child extends Base implements Runner, Tag {\n public void run() { Utility.leaf(); Helper.leaf(); local(); this.local(); super.base(); new Helper().instance(); stat(); }\n public void local() { local(); }\n public void root() {}\n public void tag() {}\n}\n',
  'src/app/Caller.java': 'package demo.app;\nimport demo.util.*;\npublic class Caller { public void entry() { Child c = new Child(); c.run(); Helper.leaf(); } }\n',
  'src/app/Initializers.java': 'package demo.app;\nimport demo.util.Utility;\npublic class Initializers { static { Utility.leaf(); } private final int count = initialize(); private static int initialize() { Utility.leaf(); return 1; } }\n',
};
beforeAll(async () => {
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  instance = await indexProject(root);
  const sdk = await structuredSdkInfo(root);
  expect(sdk.version).toBe('1.6.2');
  ctx = { assetId: 'cg-java', projectRoot: root, databasePath: sdk.databasePath, sdkVersion: sdk.version, version: 1, commit: null, indexedAt: 'fixture', branch: 'main' };
}, 120_000);
afterAll(() => { if (instance) closeIndex(instance); rmSync(root, { recursive: true, force: true }); });

function focus(name: string, kind: string) {
  const found = queryStructured(ctx, 'graph-search', { query: name, nodeKinds: [kind] });
  const n = found.nodes.find(node => node.qualifiedName === name)!;
  expect(n).toBeDefined(); return { nodeId: n.id, indexVersion: found.indexVersion! };
}
function query(name: string, kind: string, request: CodeGraphRequest = {}) { return queryStructured(ctx, 'graph', { ...focus(name, kind), ...request }); }
function names(result: CodeGraphResponse) { return new Map(result.nodes.map(node => [node.id, node.qualifiedName])); }
function relations(result: CodeGraphResponse) { const n = names(result); return result.edges.map(edge => `${n.get(edge.source)}>${edge.kind}>${n.get(edge.target)}`); }

describe('installed SDK Java relations, validated subset', () => {
  it('extracts explicit/static/instance/this/super calls, recursive sites, and same-index source', () => {
    const r = query('demo.app::Child::run', 'method', { direction: 'out' });
    expect(r.state).toBe('ready'); expect(r.capabilities.languages).toContain('java');
    expect(r.warnings).not.toContain('unverified_language:java');
    expect(r.warnings).toContain('java_static_analysis_incomplete');
    expect(relations(r)).toEqual(expect.arrayContaining([
      'demo.app::Child::run>calls>demo.util::Utility::leaf', 'demo.app::Child::run>calls>demo.app::Child::local',
      'demo.app::Child::run>calls>demo.base::Base::base', 'demo.app::Child::run>calls>demo.base::Base::stat',
    ]));
    expect(r.edges.filter(edge => names(r).get(edge.target) === 'demo.app::Child::local')).toHaveLength(2);
    const recursion = query('demo.app::Child::local', 'method', { direction: 'out' });
    expect(recursion.edges.some(edge => edge.source === edge.target)).toBe(true);
    const selected = focus('demo.app::Child::run', 'method');
    const source = queryStructured(ctx, 'graph-source', selected);
    expect(source.indexVersion).toBe(selected.indexVersion); expect(source.source?.content).toContain('Helper.leaf()');
  });

  it('supports Java interface extends, diamond inheritance and multiple implementations', () => {
    const r = query('demo.api::Runner', 'interface', { mode: 'hierarchy', direction: 'out', depth: 2 });
    expect(r.state).toBe('ready'); expect(r.warnings).not.toContain('typescript_interface_extends_not_extracted');
    expect(relations(r)).toEqual(expect.arrayContaining(['demo.api::Runner>extends>demo.api::Left', 'demo.api::Runner>extends>demo.api::Right', 'demo.api::Left>extends>demo.api::Root', 'demo.api::Right>extends>demo.api::Root']));
    expect(r.nodes.filter(node => node.qualifiedName === 'demo.api::Root')).toHaveLength(1);
    const child = query('demo.app::Child', 'class', { mode: 'hierarchy', direction: 'out' });
    expect(relations(child)).toEqual(expect.arrayContaining(['demo.app::Child>extends>demo.base::Base', 'demo.app::Child>implements>demo.api::Runner', 'demo.app::Child>implements>demo.api::Tag']));
    expect(query('demo.api::Root', 'interface', { mode: 'hierarchy', direction: 'out' }).state).toBe('empty');
  });

  it('omits SDK interface-dispatch heuristics and a wildcard import resolving to the wrong same-named type', () => {
    const db = new Database(ctx.databasePath, { readonly: true });
    try {
      // The fixture reproduces the upstream wrong target. Its call-site evidence
      // alone cannot prove the target, so this must never escape into product data.
      const bad = db.prepare("SELECT b.qualified_name AS target FROM edges e JOIN nodes a ON a.id=e.source JOIN nodes b ON b.id=e.target WHERE a.qualified_name='demo.app::Caller::entry' AND e.kind='calls' AND b.name='leaf'").get() as { target: string };
      expect(bad.target).toBe('demo.other::Helper::leaf');
      expect((db.prepare("SELECT count(*) AS n FROM edges WHERE provenance='heuristic'").get() as { n: number }).n).toBeGreaterThan(0);
    } finally { db.close(); }
    const r = query('demo.app::Caller::entry', 'method', { direction: 'out' });
    expect(relations(r)).toContain('demo.app::Caller::entry>calls>demo.app::Child::run');
    expect(r.nodes.some(node => node.qualifiedName === 'demo.other::Helper::leaf')).toBe(false);
    expect(r.warnings).toContain('java_wildcard_relations_omitted');
    const dispatch = query('demo.api::Runner::run', 'method', { direction: 'out' });
    expect(dispatch.edges).toHaveLength(0); expect(dispatch.warnings).toContain('java_heuristic_relations_omitted');
  });

  it('keeps namespace selection distinct from language coverage, and preserves initializer calls on classes/fields', () => {
    const namespace = query('demo.app', 'namespace');
    expect(namespace.state).toBe('empty'); expect(namespace.warnings).toContain('select_a_callable');
    const type = query('demo.app', 'namespace', { mode: 'hierarchy' });
    expect(type.warnings).toContain('select_a_type'); expect(type.state).toBe('empty');
    const db = new Database(ctx.databasePath, { readonly: true });
    try {
      const owners = db.prepare("SELECT DISTINCT a.qualified_name AS name,a.kind FROM edges e JOIN nodes a ON a.id=e.source WHERE a.language='java' AND a.kind IN ('class','field','constant') AND e.kind='calls'").all() as { name: string; kind: string }[];
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) {
        const r = query(owner.name, owner.kind, { direction: 'out' });
        expect(r.warnings).not.toContain('select_a_callable'); expect(r.edges.length).toBeGreaterThan(0);
      }
    } finally { db.close(); }
  });

  it('keeps Java impact evidence directed and filtered across deterministic small pages', () => {
    const q = { ...focus('demo.util::Utility::leaf', 'method'), mode: 'impact' as const, limit: 2, edgeLimit: 1, depth: 3 };
    let r = queryStructured(ctx, 'graph', q); const all: CodeGraphResponse[] = [];
    do {
      expect(r.work!.rowsRead).toBeLessThanOrEqual(2000); all.push(r); expect(all.length).toBeLessThan(30);
      for (const path of r.impactPaths ?? []) expect(path.nodeIds.at(-1)).toBe(q.nodeId);
      if (!r.nextCursor) break;
      const next = queryStructured(ctx, 'graph', { ...q, cursor: r.nextCursor });
      expect(queryStructured(ctx, 'graph', { ...q, cursor: r.nextCursor }).edges).toEqual(next.edges); r = next;
    } while (true);
    const edges = all.flatMap(page => page.edges);
    expect(edges.length).toBeGreaterThan(0); expect(new Set(edges.map(edge => edge.id)).size).toBe(edges.length);
    const nodes = new Map(all.flatMap(page => page.nodes.map(node => [node.id, node.qualifiedName] as const)));
    expect(edges.some(edge => nodes.get(edge.source) === 'demo.app::Child::run' && nodes.get(edge.target) === 'demo.util::Utility::leaf')).toBe(true);
  });

  it.each(['dependencies', 'clusters'] as const)('supports %s using real Java import evidence, without SDK guesses', mode => {
    const r = queryStructured(ctx, 'graph', { mode, groupBy: 'file' });
    expect(r.state).toBe('ready'); expect(r.edges.some(edge => edge.kind === 'imports')).toBe(true);
    expect(r.warnings).not.toContain('unverified_language:java');
    expect(r.warnings).not.toContain('import_declaration_anchor_unverified');
    expect(r.edges.flatMap(edge => edge.evidence).some(evidence => evidence.filePath === 'src/app/Child.java' && evidence.line === 5)).toBe(true);
  });

  it('invalidates Java validation results when call-site source no longer matches the indexed hash', () => {
    const path = join(root, 'src/app/Child.java'), original = readFileSync(path, 'utf8');
    const q = { ...focus('demo.app::Child::run', 'method'), direction: 'out' as const };
    try {
      writeFileSync(path, original.replace('Helper.leaf()', 'Helper.other()'));
      const r = queryStructured(ctx, 'graph', q);
      expect(r.state).toBe('version_expired'); expect(r.warnings).toContain('source_changed_since_index'); expect(r.edges).toEqual([]); expect(r.nodes).toEqual([]); expect(r.nextCursor).toBeNull();
    } finally { writeFileSync(path, original); }
  });
});
