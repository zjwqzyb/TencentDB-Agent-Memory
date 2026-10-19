import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { indexProject, closeIndex, structuredSdkInfo, executeTool, type CodeGraphInstance } from './bridge.js';
import { queryStructured } from './structured.js';

const root = mkdtempSync(join(tmpdir(), 'real-codegraph-sdk-'));
let instance: CodeGraphInstance;
afterAll(() => { if (instance) closeIndex(instance); rmSync(root, { recursive: true, force: true }); });
describe('actual installed CodeGraph SDK fixture', () => {
  it('extracts TS/JS calls, imports, extends, implements, duplicate names and same-snapshot source', async () => {
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}');
    writeFileSync(join(root, 'base.ts'), 'export interface Runner { run(): void; }\nexport class Base { run() {} }\nexport function duplicate() { return 1; }\n');
    writeFileSync(join(root, 'main.ts'), 'import { Base, Runner, duplicate } from "./base";\nexport class Child extends Base implements Runner { run() { duplicate(); } }\nexport function entry() { return duplicate(); }\n');
    writeFileSync(join(root, 'other.ts'), 'export function duplicate() { return 2; }\n');
    writeFileSync(join(root, 'javascript.js'), 'export function leaf() { return 1; }\nexport function caller() { return leaf(); }\n');
    instance = await indexProject(root);
    const sdk = await structuredSdkInfo(root); expect(sdk.version).toBe('1.6.2');
    const db = new Database(sdk.databasePath, { readonly: true });
    try {
      const kinds = (db.prepare('SELECT DISTINCT kind FROM edges').all() as { kind: string }[]).map(r => r.kind);
      for (const kind of ['calls', 'imports', 'extends', 'implements']) expect(kinds).toContain(kind);
      const hierarchy = db.prepare("SELECT a.name AS source,b.name AS target,e.kind FROM edges e JOIN nodes a ON a.id=e.source JOIN nodes b ON b.id=e.target WHERE e.kind IN ('extends','implements')").all();
      expect(hierarchy).toEqual(expect.arrayContaining([{ source: 'Child', target: 'Base', kind: 'extends' }, { source: 'Child', target: 'Runner', kind: 'implements' }]));
      const ctx = { assetId: 'cg-fixture', projectRoot: root, databasePath: sdk.databasePath, sdkVersion: sdk.version, version: 1, commit: null, indexedAt: 'fixture', branch: 'main' };
      const found = queryStructured(ctx, 'graph-search', { query: 'duplicate', nodeKinds: ['function'] });
      expect(found.nodes).toHaveLength(2); expect(new Set(found.nodes.map(n => n.filePath)).size).toBe(2);
      const entry = queryStructured(ctx, 'graph-search', { query: 'entry', nodeKinds: ['function'] });
      expect(entry.nodes).toHaveLength(1);
      expect(entry.nodes[0].signature).toEqual(expect.any(String));
      expect(entry.nodes[0].signature!.length).toBeGreaterThan(0);
      const detail = queryStructured(ctx, 'graph-node', { nodeId: entry.nodes[0].id, indexVersion: entry.indexVersion! });
      expect(detail.nodes[0].signature).toBe(entry.nodes[0].signature);
      const calls = queryStructured(ctx, 'graph', { nodeId: entry.nodes[0].id, indexVersion: entry.indexVersion!, direction: 'out' });
      expect(calls.edges.some(e => e.kind === 'calls')).toBe(true);
      expect(calls.edges.every(e => e.source === entry.nodes[0].id)).toBe(true);
      const source = queryStructured(ctx, 'graph-source', { nodeId: entry.nodes[0].id, indexVersion: entry.indexVersion! });
      expect(source.source?.content).toContain('function entry');
      const js = queryStructured(ctx, 'graph-search', { query: 'caller', nodeKinds: ['function'] });
      expect(js.nodes[0].language).toBe('javascript');
      expect(queryStructured(ctx, 'graph', { nodeId: js.nodes[0].id, indexVersion: js.indexVersion!, direction: 'out' }).edges.length).toBeGreaterThan(0);
      const legacy = await executeTool(instance, 'codegraph_search', { query: 'entry' });
      expect(typeof legacy.text).toBe('string'); expect(legacy.isError).toBe(false);
    } finally { db.close(); }
  }, 120_000);
});
