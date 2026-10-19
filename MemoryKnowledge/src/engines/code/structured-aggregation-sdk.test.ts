import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { indexProject, closeIndex, structuredSdkInfo, type CodeGraphInstance } from './bridge.js';
import { queryStructured } from './structured.js';

describe('actual SDK dependency extraction', () => {
  it('indexes imports, reexports, cycles and external references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-sdk-'));
    let instance: CodeGraphInstance | undefined;
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"dependency-fixture","type":"module"}');
      for (const dir of ['a', 'b', 'c']) mkdirSync(join(root, dir));
      writeFileSync(join(root, 'a/main.ts'), 'import { bee, second } from "../b/main"; import { bee as again } from "../b/main";\n   import { readFile } from "node:fs";\nimport missing from "missing-package";\nimport {\n bee as multi\n} from "../b/main"\nexport function aye() { return bee() + second() + again() + multi(); }\n');
      writeFileSync(join(root, 'b/main.ts'), 'import { aye } from "../a/main";\nimport { cee } from "../c/main";\nexport function bee() { return aye() + cee(); }\nexport function second() { return 2; }\n');
      writeFileSync(join(root, 'c/main.ts'), 'export function cee() { return 3; }\n');
      writeFileSync(join(root, 'index.ts'), 'export { bee, second } from "./b/main"; export { bee as other } from "./b/main";\nexport * from "./c/main";\n');
      instance = await indexProject(root);
      const info = await structuredSdkInfo(root);
      const db = new Database(info.databasePath, { readonly: true });
      try {
        expect(info.version).toBe('1.6.2');
        const rawImports = db.prepare("SELECT e.*,a.file_path AS sf,b.file_path AS tf FROM edges e JOIN nodes a ON e.source=a.id JOIN nodes b ON e.target=b.id WHERE e.kind='imports'").all() as { id: number; sf: string; tf: string; line: number; col: number }[];
        expect(rawImports.filter(e => e.sf === 'a/main.ts' && e.tf === 'b/main.ts').length).toBeGreaterThan(3);
        const ctx = { assetId: 'cg-sdk-deps', projectRoot: root, databasePath: info.databasePath, sdkVersion: info.version, version: 1, commit: 'fixture', indexedAt: 'fixture', branch: 'main' };
        const result = queryStructured(ctx, 'graph', { mode: 'dependencies' });
        expect(result.aggregation?.complete).toBe(true); expect(result.work!.rowsRead).toBeLessThanOrEqual(2000);
        const nodes = new Map(result.nodes.map(n => [n.id, n.name]));
        const ab = result.edges.find(e => nodes.get(e.source) === 'a' && nodes.get(e.target) === 'b')!;
        expect(ab.count).toBe(3); // two declarations on one line + one multiline declaration
        expect(result.edges.find(e => nodes.get(e.source) === '.' && nodes.get(e.target) === 'b')!.count).toBe(2);
        expect(result.cycles).toHaveLength(1); expect(result.cycles![0].nodeIds.map(id => nodes.get(id)).sort()).toEqual(['a', 'b']);
        expect(result.nodes.find(n => n.name === 'node:fs')?.aggregate?.resolution).toBe('external');
        expect(result.nodes.find(n => n.name === 'missing-package')?.aggregate?.resolution).toBe('unresolved');
        expect(result.nodes.some(n => n.name === 'readFile' || n.name === 'missing')).toBe(false);
        const proofs = queryStructured(ctx, 'graph', { mode: 'dependencies', evidenceFor: ab.id, indexVersion: result.indexVersion! });
        expect(proofs.dependencyEvidence).toHaveLength(3);
        expect(proofs.dependencyEvidence!.filter(e => e.line === 1).map(e => e.column)).toEqual([0, 41]);
        expect(proofs.dependencyEvidence!.some(e => e.line === 4 && e.column === 0)).toBe(true);
        const external = result.edges.find(e => e.resolution === 'external')!;
        const externalProof = queryStructured(ctx, 'graph', { mode: 'dependencies', evidenceFor: external.id, indexVersion: result.indexVersion! });
        expect(externalProof.dependencyEvidence).toHaveLength(1); expect(externalProof.dependencyEvidence![0]).toMatchObject({ line: 2, column: 3, targetFile: 'node:fs' });
        const rootFiles = queryStructured(ctx, 'graph', { mode: 'dependencies', groupBy: 'file', scopePath: '.' });
        expect(rootFiles.edges.every(edge => rootFiles.nodes.find(n => n.id === edge.source)?.filePath === 'index.ts')).toBe(true);
        const source = queryStructured(ctx, 'graph-source', { nodeId: proofs.dependencyEvidence![0].sourceId, indexVersion: result.indexVersion! });
        expect(source.source?.content).toContain('bee as again');
        // Actual installed SDK 1.6.2 did not produce an imports edge for this star
        // reexport. The adapter must not synthesize one from the source text.
        expect(rawImports.some(e => e.sf === 'index.ts' && e.tf === 'c/main.ts')).toBe(false);
        expect(result.edges.some(e => nodes.get(e.source) === '.' && nodes.get(e.target) === 'c')).toBe(false);
        // Real SDK symbols from the same declaration remain distinct at the
        // symbol layer, while cross-layer declaration counts remain comparable.
        const clusterFiles = queryStructured(ctx, 'graph', { mode: 'clusters', groupBy: 'file', scopePath: 'b/main.ts' });
        const clusterSymbols = queryStructured(ctx, 'graph', { mode: 'clusters', groupBy: 'symbol', scopePath: 'b/main.ts' });
        expect(clusterSymbols.aggregation?.complete).toBe(true);
        expect(clusterSymbols.aggregation?.distinctSiteCount).toBe(clusterFiles.aggregation?.distinctSiteCount);
        const symbolNodes = new Map(clusterSymbols.nodes.map(node => [node.id, node]));
        const fromA = clusterSymbols.edges.filter(edge => symbolNodes.get(edge.source)?.aggregate?.path === 'a');
        expect(fromA.some(edge => symbolNodes.get(edge.target)?.name === 'bee')).toBe(true);
        expect(fromA.some(edge => symbolNodes.get(edge.target)?.name === 'second')).toBe(true);
        expect(clusterSymbols.edges.some(edge => symbolNodes.get(edge.source)?.filePath === 'b/main.ts' && symbolNodes.get(edge.target)?.aggregate?.boundary)).toBe(true);
        expect(clusterSymbols.nodes.filter(node => !node.aggregate).every(node => queryStructured(ctx, 'graph-node', { nodeId: node.id, indexVersion: clusterSymbols.indexVersion! }).nodes[0]?.id === node.id)).toBe(true);
        for (const edge of fromA) {
          const evidence = queryStructured(ctx, 'graph', { mode: 'clusters', groupBy: 'symbol', scopePath: 'b/main.ts', evidenceFor: edge.id, indexVersion: clusterSymbols.indexVersion! });
          expect(evidence.dependencyEvidence!.every(proof => proof.targetId === edge.target)).toBe(true);
        }
        const repeated = queryStructured(ctx, 'graph', { mode: 'clusters', groupBy: 'file', scopePath: 'b/main.ts' });
        expect(repeated.nodes).toEqual(clusterFiles.nodes); expect(repeated.edges).toEqual(clusterFiles.edges);
        writeFileSync(join(root, 'a/main.ts'), '// changed since index');
        expect(queryStructured(ctx, 'graph', { mode: 'dependencies' }).state).toBe('version_expired');
      } finally { db.close(); }
    } finally { if (instance) closeIndex(instance); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});
