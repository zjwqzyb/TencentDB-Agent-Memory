/** Real SDK -> Knowledge HTTP -> Panel HTTP client/routes integration.
 * Only metadata identity/ACL and the asset catalog are fixtures. Graph results,
 * text tools, source validation, and the indexed database are production code.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { CodeGraphResponse } from '../../src/panel/kernel/contracts/code-graph.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';

describe('CodeGraph real SDK / Knowledge HTTP / Panel chain', () => {
  it('indexes TS/JS and carries real modes, evidence and version boundaries through both services', async () => {
    // These cross-package imports are test-only; application build boundaries
    // remain independent. Vite resolves each module's own package dependencies.
    const { indexProject, closeIndex } = await import('../../../MemoryKnowledge/src/engines/code/bridge.js');
    const { createCodeGraphRoutes } = await import('../../../MemoryKnowledge/src/routes/code-graph.js');
    const root = mkdtempSync(join(tmpdir(), 'codegraph-live-chain-'));
    let instance: Awaited<ReturnType<typeof indexProject>> | undefined;
    let server: Server | undefined;
    try {
      const files = {
        'package.json': '{"name":"codegraph-live-fixture","type":"module"}',
        'base.ts': 'export function leaf() { return 42; }\nexport class Base {}\nexport interface I {}\n',
        'main.ts': 'import { leaf, Base, I } from "./base";\nexport function entry() { return leaf(); }\nexport function top() { return entry(); }\nexport class Child extends Base implements I {}\n',
        'other.ts': 'export function entry() { return 7; }\n',
        'javascript.js': 'export function jsLeaf() { return 3; }\nexport function jsEntry() { return jsLeaf(); }\n',
        'late.ts': Array.from({ length: 999 }, (_, i) => `// line ${i + 1}`).join('\n') + '\nimport { leaf } from "./base";\nexport function late() { return leaf(); }\n',
      };
      for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=CodeGraph Test', '-c', 'user.email=codegraph-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'deterministic TS and JS fixture'], { cwd: root });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      instance = await indexProject(root);

      const asset = { code_graph_id: 'cg-live', team_id: 'team-live', status: 'ready', version: 1, commit_hash: commit, branch: 'main', last_sync_at: '2026-10-19T00:00:00Z' };
      const knowledgeRequests: Array<{ path: string; service: string | undefined }> = [];
      const knowledge = new Hono();
      knowledge.use('*', async (c, next) => {
        knowledgeRequests.push({ path: c.req.path, service: c.req.header('x-tdai-service-id') });
        await next();
      });
      knowledge.route('/v3/code-graph', createCodeGraphRoutes({
        cgService: {
          getById: (service: string, id: string) => service === 'service-live' && id === asset.code_graph_id ? { ...asset } : undefined,
          dirFor: (service: string, team: string, id: string) => {
            expect([service, team, id]).toEqual(['service-live', 'team-live', 'cg-live']);
            return root;
          },
        },
        instancePool: { get: (id: string) => id === asset.code_graph_id ? instance : undefined },
        publicBaseUrl: '',
      } as unknown as Parameters<typeof createCodeGraphRoutes>[0]));
      server = await new Promise<Server>((resolve, reject) => {
        const listener = serve({ fetch: knowledge.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(listener as Server));
        listener.once('error', reject);
      });
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const routes = new Hono();
      registerKnowledgeCodeGraphRoutes(routes, {
        instanceRegistry: new InstanceRegistry([{ instance_id: 'service-live', name: 'Fixture', gateway_endpoint: 'http://unused.invalid', api_key: 'test-only' }]),
        metaKernel: { invoke: async (action: string, body: Record<string, unknown>, ctx: MetaCallContext) => {
          expect(ctx.instanceId).toBe('service-live');
          if (action === 'auth/verify') return { code: 0, data: { valid: ctx.userKey === 'fixture-reader', user: { user_id: 'user-live' } } };
          if (action === 'asset/get') return { code: 0, data: body.asset_id === asset.code_graph_id ? { asset_id: asset.code_graph_id, team_id: asset.team_id, asset_type: 'code_graph' } : null };
          if (action === 'acl/check') return { code: 0, data: { allowed: body.user_id === 'user-live' && body.asset_id === asset.code_graph_id && body.action === 'read' } };
          if (action === 'team-member/get') return { code: 0, data: body.team_id === asset.team_id && body.user_id === 'user-live' ? { user_id: 'user-live', status: 'active' } : null };
          throw new Error(`Unexpected Meta action ${action}`);
        } },
        knowledgeClientFactory: (serviceId: string) => new HttpKnowledgeClient({ baseUrl, serviceId, authToken: '', timeoutMs: 10_000 }),
      } as unknown as PanelDeps);
      const panel = new Hono();
      panel.route('/api/v1', routes);
      async function post<T>(action: string, params: Record<string, unknown>): Promise<T> {
        const response = await panel.request(`/api/v1/knowledge/code-graph/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tdai-Service-Id': 'service-live', 'X-Tdai-User-Key': 'fixture-reader' },
          body: JSON.stringify({ code_graph_id: asset.code_graph_id, ...params }),
        });
        const envelope = await response.json() as { code: number; message?: string; data: T };
        expect(response.status, JSON.stringify(envelope)).toBe(200);
        expect(envelope.code, envelope.message).toBe(0);
        return envelope.data;
      }

      const tree = await post<CodeGraphResponse>('graph-tree', {});
      expect(tree.state).toBe('ready');
      expect(tree.capabilities.sdkVersion).toBe('1.6.2');
      expect(tree.nodes.map(node => node.filePath)).toEqual(expect.arrayContaining(['base.ts', 'main.ts', 'other.ts', 'javascript.js']));
      const duplicates = await post<CodeGraphResponse>('graph-search', { query: 'entry', nodeKinds: ['function'] });
      const tsEntries = duplicates.nodes.filter(node => node.name === 'entry');
      expect(tsEntries).toHaveLength(2);
      expect(new Set(tsEntries.map(node => node.id)).size).toBe(2);
      expect(tsEntries.map(node => node.filePath).sort()).toEqual(['main.ts', 'other.ts']);

      for (const sample of [
        { query: 'entry', file: 'main.ts', name: 'entry', target: 'leaf', language: 'typescript' },
        { query: 'jsEntry', file: 'javascript.js', name: 'jsEntry', target: 'jsLeaf', language: 'javascript' },
      ]) {
        const found = await post<CodeGraphResponse>('graph-search', { query: sample.query, nodeKinds: ['function'] });
        const focus = found.nodes.find(node => node.filePath === sample.file && node.name === sample.name);
        expect(focus).toBeDefined();
        expect(focus!.language).toBe(sample.language);
        const request = { nodeId: focus!.id, indexVersion: found.indexVersion };
        const graph = await post<CodeGraphResponse>('graph', { ...request, mode: 'calls', direction: 'out', depth: 1 });
        expect(graph.state).toBe('ready');
        const callee = graph.nodes.find(node => node.name === sample.target);
        expect(callee).toBeDefined();
        expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: focus!.id, target: callee!.id, kind: 'calls' })]));
        expect(graph.edges.every(edge => edge.kind === 'calls')).toBe(true);
        expect(graph.edges.some(edge => edge.evidence.some(location => location.filePath === sample.file && location.line > 0))).toBe(true);

        const detail = await post<CodeGraphResponse>('graph-node', request);
        expect(detail.nodes).toEqual([focus]);
        const source = await post<CodeGraphResponse>('graph-source', request);
        expect(source.state).toBe('ready');
        expect(source.source).toMatchObject({ nodeId: focus!.id, filePath: sample.file, startLine: focus!.startLine, endLine: focus!.endLine });
        const expectedLines = files[sample.file as keyof typeof files].split('\n').slice(focus!.startLine - 1, focus!.endLine).join('\n');
        expect(source.source!.content).toBe(expectedLines);
        expect(source.source!.contentHash).toMatch(/^[a-f0-9]{64}$/);
        for (const response of [graph, detail, source]) {
          expect(response.assetId).toBe(asset.code_graph_id);
          expect(response.indexVersion).toBe(found.indexVersion);
          expect(response.commit).toBe(commit);
          expect(response.indexedAt).toBe(asset.last_sync_at);
        }
      }

      const leafSearch = await post<CodeGraphResponse>('graph-search', { query: 'leaf', nodeKinds: ['function'] });
      const leaf = leafSearch.nodes.find(node => node.name === 'leaf')!;
      const impact = await post<CodeGraphResponse>('graph', { mode: 'impact', nodeId: leaf.id, indexVersion: leafSearch.indexVersion, edgeKinds: ['calls'] });
      expect(impact.nodes.find(node => node.name === 'entry')?.depth).toBe(1);
      expect(impact.nodes.find(node => node.name === 'top')?.depth).toBe(2);
      const top = impact.nodes.find(node => node.name === 'top')!;
      const path = impact.impactPaths!.find(path => path.nodeId === top.id)!;
      expect(path.edgeIds).toHaveLength(2);
      for (let i = 0; i < path.edgeIds.length; i++) expect(impact.edges.find(edge => edge.id === path.edgeIds[i])).toMatchObject({ source: path.nodeIds[i], target: path.nodeIds[i + 1] });
      expect((await post<CodeGraphResponse>('graph-source', { nodeId: top.id, indexVersion: impact.indexVersion })).source?.content).toContain('function top');
      const typeSearch = await post<CodeGraphResponse>('graph-search', { query: 'Child', nodeKinds: ['class'] });
      const hierarchy = await post<CodeGraphResponse>('graph', { mode: 'hierarchy', nodeId: typeSearch.nodes[0].id, indexVersion: typeSearch.indexVersion, direction: 'out' });
      expect(hierarchy.edges.map(edge => edge.kind).sort()).toEqual(['extends', 'implements']);
      expect(hierarchy.warnings).toContain('typescript_interface_extends_not_extracted');
      const intf = hierarchy.nodes.find(node => node.name === 'I')!;
      const unsupported = await post<CodeGraphResponse>('graph', { mode: 'hierarchy', nodeId: intf.id, indexVersion: hierarchy.indexVersion, direction: 'out' });
      expect(unsupported.state).toBe('unsupported');

      const lateFile = tree.nodes.find(node => node.filePath === 'late.ts' && node.kind === 'file')!;
      expect(lateFile).toBeDefined();
      const lateSource = await post<CodeGraphResponse>('graph-source', { nodeId: lateFile.id, indexVersion: tree.indexVersion, sourceLine: 1000 });
      expect(lateSource.source!.startLine).toBe(950);
      expect(lateSource.source!.content.split('\n')[1000 - lateSource.source!.startLine]).toBe('import { leaf } from "./base";');
      expect(lateSource.source!.endLine - lateSource.source!.startLine + 1).toBeLessThanOrEqual(300);
      expect((await post<CodeGraphResponse>('graph-source', { nodeId: lateFile.id, indexVersion: tree.indexVersion, sourceLine: 2000 })).state).toBe('source_unavailable');

      const dependencies = await post<CodeGraphResponse>('graph', { mode: 'dependencies', groupBy: 'file' });
      expect(dependencies.state).toBe('ready'); expect(dependencies.aggregation?.complete).toBe(true);
      const moduleNames = new Map(dependencies.nodes.map(node => [node.id, node.filePath]));
      expect(dependencies.edges.map(edge => [moduleNames.get(edge.source), moduleNames.get(edge.target), edge.kind, edge.count])).toEqual(expect.arrayContaining([
        ['main.ts', 'base.ts', 'imports', 1], ['late.ts', 'base.ts', 'imports', 1],
      ]));
      const lateDependency = dependencies.edges.find(edge => moduleNames.get(edge.source) === 'late.ts')!;
      const evidence = await post<CodeGraphResponse>('graph', { mode: 'dependencies', groupBy: 'file', evidenceFor: lateDependency.id, indexVersion: dependencies.indexVersion });
      expect(evidence.dependencyEvidence).toHaveLength(1);
      const lateEvidence = evidence.dependencyEvidence![0]; expect(lateEvidence.line).toBe(1000);
      const evidenceSource = await post<CodeGraphResponse>('graph-source', { nodeId: lateEvidence.sourceId, indexVersion: evidence.indexVersion, sourceLine: lateEvidence.line });
      expect(evidenceSource.source!.content.split('\n')[lateEvidence.line - evidenceSource.source!.startLine]).toBe('import { leaf } from "./base";');

      const overview = await post<CodeGraphResponse>('graph', { mode: 'clusters' });
      expect(overview.state).toBe('ready'); expect(overview.capabilities.modes.clusters.supported).toBe(true);
      expect(overview.clustering).toMatchObject({ groupBy: 'directory', boundaryPolicy: 'both', scopePath: '' });
      expect(overview.nodes).toHaveLength(1); expect(overview.nodes[0].aggregate).toMatchObject({ path: '.', fileCount: 5, internalCount: 2 });
      const clusterFiles = await post<CodeGraphResponse>('graph', { mode: 'clusters', groupBy: 'file', scopePath: '.' });
      expect(clusterFiles.edges.reduce((sum, edge) => sum + (edge.count ?? 0), 0)).toBe(overview.nodes[0].aggregate!.internalCount);
      const incomingBoundary = await post<CodeGraphResponse>('graph', { mode: 'clusters', groupBy: 'file', scopePath: 'base.ts' });
      expect(incomingBoundary.edges.reduce((sum, edge) => sum + (edge.count ?? 0), 0)).toBe(2);
      expect(incomingBoundary.nodes.some(node => node.aggregate?.boundary)).toBe(true);
      const symbols = await post<CodeGraphResponse>('graph', { mode: 'clusters', groupBy: 'symbol', scopePath: 'late.ts' });
      expect(symbols.nodes.some(node => node.id === lateEvidence.sourceId && !node.aggregate)).toBe(true);
      expect(symbols.nodes.some(node => node.aggregate?.boundary)).toBe(true);
      expect(symbols.edges.reduce((sum, edge) => sum + (edge.count ?? 0), 0)).toBe(1);
      const symbolProof = await post<CodeGraphResponse>('graph', { mode: 'clusters', groupBy: 'symbol', scopePath: 'late.ts', evidenceFor: symbols.edges[0].id, indexVersion: symbols.indexVersion });
      expect(symbolProof.dependencyEvidence![0]).toMatchObject({ sourceId: lateEvidence.sourceId, targetFile: 'base.ts', line: 1000 });
      const collapse = await post<CodeGraphResponse>('graph', { mode: 'clusters' });
      expect(collapse.nodes).toEqual(overview.nodes); expect(collapse.edges).toEqual(overview.edges);
      const partial = await post<CodeGraphResponse>('graph', { mode: 'impact', nodeId: leaf.id, indexVersion: tree.indexVersion, limit: 2, edgeLimit: 1 });
      expect(partial.nextCursor).toBeTruthy();
      expect((await post<CodeGraphResponse>('graph', { mode: 'clusters', nodeId: leaf.id, indexVersion: tree.indexVersion, limit: 2, edgeLimit: 1, cursor: partial.nextCursor })).state).toBe('version_expired');

      for (const action of ['search', 'explore']) {
        const text = await post<{ text: string; isError: boolean }>(action, { query: 'entry' });
        expect(text.isError).toBe(false);
        expect(text.text).toContain('entry');
      }
      expect(new Set(knowledgeRequests.map(request => request.path))).toEqual(new Set(['graph', 'graph-search', 'graph-tree', 'graph-node', 'graph-source', 'search', 'explore'].map(action => `/v3/code-graph/${action}`)));
      expect(knowledgeRequests.every(request => request.service === 'service-live')).toBe(true);
      // The asset generation changes independently of its stable on-disk fixture.
      // All modes and source must reject IDs/results from the earlier generation.
      asset.version++;
      for (const mode of ['calls', 'impact', 'dependencies', 'clusters', 'hierarchy']) {
        const stale = await post<CodeGraphResponse>('graph', { mode, nodeId: leaf.id, indexVersion: tree.indexVersion });
        expect(stale.state).toBe('version_expired'); expect(stale.nodes).toEqual([]); expect(stale.edges).toEqual([]);
      }
      expect((await post<CodeGraphResponse>('graph-source', { nodeId: lateEvidence.sourceId, indexVersion: tree.indexVersion, sourceLine: 1000 })).state).toBe('version_expired');
    } finally {
      try {
        if (server) await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); server!.closeAllConnections(); });
      } finally {
        try { if (instance) closeIndex(instance); }
        finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }, 120_000);
});
