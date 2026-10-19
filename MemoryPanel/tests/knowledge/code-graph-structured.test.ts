/**
 * Panel boundary tests: real Hono routes and HttpKnowledgeClient, with a local
 * HTTP upstream fixture. This proves authorization and transport only; it does
 * not claim that fixture graph data was produced by the CodeGraph SDK.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';
import type { CodeGraphAction, CodeGraphRequest, CodeGraphResponse } from '../../src/panel/kernel/contracts/code-graph.js';

const cases: Array<{ action: CodeGraphAction; params: CodeGraphRequest }> = [
  { action: 'graph', params: { mode: 'calls', nodeId: 'node-a', indexVersion: 'v1', direction: 'both', depth: 1, scopePath: 'src', nodeKinds: ['function'], edgeKinds: ['calls'], limit: 7, edgeLimit: 9, cursor: 'opaque-cursor' } },
  { action: 'graph-search', params: { query: 'sameName', indexVersion: 'v1', scopePath: 'src', nodeKinds: ['function'], limit: 7, cursor: 'opaque-cursor' } },
  { action: 'graph-tree', params: { scopePath: 'src', indexVersion: 'v1', limit: 7, cursor: 'opaque-cursor' } },
  { action: 'graph-node', params: { nodeId: 'node-a', indexVersion: 'v1' } },
  { action: 'graph-source', params: { nodeId: 'node-a', indexVersion: 'v1', sourceLine: 1000 } },
];
const fixture: CodeGraphResponse = {
  state: 'ready', assetId: 'asset-a', indexVersion: 'v1', commit: 'commit-1', indexedAt: '2026-10-19T00:00:00Z', branch: 'main',
  capabilities: { sdkVersion: 'transport-fixture', modes: { calls: { supported: true }, impact: { supported: false }, dependencies: { supported: false }, clusters: { supported: false }, hierarchy: { supported: false } }, languages: ['typescript'], edgeKinds: ['calls'] },
  nodes: [{ id: 'node-a', name: 'sameName', qualifiedName: 'src/a.ts:sameName', kind: 'function', filePath: 'src/a.ts', language: 'typescript', startLine: 1, endLine: 2 }],
  edges: [{ id: 'self-call', source: 'node-a', target: 'node-a', kind: 'calls', evidence: [{ filePath: 'src/a.ts', line: 2 }] }],
  focusId: 'node-a', truncated: true, truncationReasons: ['node_budget'], nextCursor: 'next-opaque-cursor', warnings: ['fixture-only'],
  source: { nodeId: 'node-a', filePath: 'src/a.ts', startLine: 1, endLine: 2, content: 'function sameName() { sameName(); }', contentHash: 'fixture-hash' },
  work: { rowsRead: 3, maxRows: 100 },
};

let upstream: Server;
let baseUrl: string;
let app: Hono;
let allowed: boolean;
let isMember: boolean;
let upstreamStatus: number;
let upstreamBody: unknown;
let inFlightDetail: Record<string, unknown> | null;
const received: Array<{ path: string; method?: string; service?: string; authorization?: string; userKey?: string; body: Record<string, unknown> }> = [];
const invoke = vi.fn();
const clientFactory = vi.fn();

beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    received.push({ path: request.url ?? '', method: request.method, service: request.headers['x-tdai-service-id'] as string | undefined, authorization: request.headers.authorization, userKey: request.headers['x-tdai-user-key'] as string | undefined, body: JSON.parse(raw) });
    const metadataProbe = request.url === '/v3/code-graph/get';
    response.writeHead(metadataProbe ? (inFlightDetail ? 200 : 404) : upstreamStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(metadataProbe ? (inFlightDetail ? { code: 0, data: inFlightDetail } : { code: 404, message: 'CODE_GRAPH_NOT_FOUND', data: null }) : upstreamBody));
  });
  await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (upstream) await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); });
});

beforeEach(() => {
  allowed = true;
  isMember = true;
  upstreamStatus = 200;
  upstreamBody = { code: 0, data: fixture };
  inFlightDetail = null;
  received.length = 0;
  invoke.mockReset().mockImplementation(async (action: string, body: Record<string, unknown>, ctx: MetaCallContext) => {
    if (action === 'auth/verify') return { code: 0, data: { valid: ctx.userKey === 'test-reader', user: { user_id: 'authenticated-user' } } };
    if (action === 'asset/get') {
      // The same metadata API is independently namespaced by service instance.
      const exists = (ctx.instanceId === 'service-a' && body.asset_id === 'asset-a') || (ctx.instanceId === 'service-b' && body.asset_id === 'asset-b');
      return exists ? { code: 0, data: { asset_id: body.asset_id, team_id: `team-${ctx.instanceId}`, asset_type: 'code_graph' } } : { code: 404, data: null };
    }
    if (action === 'acl/check') return { code: 0, data: { allowed } };
    if (action === 'team-member/get') return { code: 0, data: isMember ? { user_id: body.user_id, status: 'active' } : null };
    throw new Error(`Unexpected metadata call: ${action}`);
  });
  clientFactory.mockReset().mockImplementation((serviceId: string) => new HttpKnowledgeClient({ baseUrl, serviceId, authToken: `upstream-${serviceId}`, timeoutMs: 2000 }));
  const deps = {
    instanceRegistry: new InstanceRegistry(['service-a', 'service-b'].map(instance_id => ({ instance_id, name: instance_id, gateway_endpoint: 'http://unused.invalid', api_key: 'test-gateway' }))),
    metaKernel: { invoke }, knowledgeClientFactory: clientFactory,
    auth: { resolveSession: () => null }, config: { auth: { sessionCookieName: 'test-session' } },
  } as unknown as PanelDeps;
  const routes = new Hono();
  registerKnowledgeCodeGraphRoutes(routes, deps);
  app = new Hono();
  app.route('/api/v1', routes);
});

function request(action: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request(`/api/v1/knowledge/code-graph/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tdai-Service-Id': 'service-a', 'X-Tdai-User-Key': 'test-reader', ...headers }, body: JSON.stringify(body) });
}

describe.each(cases)('CodeGraph Panel $action boundary', ({ action, params }) => {
  const body = () => ({ code_graph_id: 'asset-a', ...params });

  it('uses real client transport and preserves graph IDs, evidence, version, cursor and source', async () => {
    const response = await request(action, body());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(fixture);
    expect(received).toEqual([{ path: `/v3/code-graph/${action}`, method: 'POST', service: 'service-a', authorization: 'Bearer upstream-service-a', userKey: undefined, body: body() }]);
    expect(invoke).toHaveBeenCalledWith('acl/check', { user_id: 'authenticated-user', asset_id: 'asset-a', action: 'read' }, expect.objectContaining({ instanceId: 'service-a', userKey: 'test-reader' }));
    expect(invoke).toHaveBeenCalledWith('team-member/get', { team_id: 'team-service-a', user_id: 'authenticated-user' }, expect.anything());
  });

  it('rejects denied ACL before selecting a client or contacting upstream', async () => {
    allowed = false;
    expect((await request(action, body())).status).toBe(403);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('rejects an ACL-allowed caller outside the asset team', async () => {
    isMember = false;
    expect((await request(action, body())).status).toBe(403);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('rejects missing identity without querying metadata or upstream', async () => {
    expect((await request(action, body(), { 'X-Tdai-User-Key': '' })).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('rejects an invalid user key before looking up the asset', async () => {
    expect((await request(action, body(), { 'X-Tdai-User-Key': 'invalid' })).status).toBe(401);
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['auth/verify']);
    expect(received).toEqual([]);
  });

  it.each(['', 'unknown-service'])('rejects invalid service header %j before metadata/upstream', async service => {
    expect((await request(action, body(), { 'X-Tdai-Service-Id': service })).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('does not expose an asset in another service or fall back to the first service', async () => {
    expect((await request(action, body(), { 'X-Tdai-Service-Id': 'service-b' })).status).toBe(404);
    expect(invoke).toHaveBeenCalledWith('asset/get', { asset_id: 'asset-a' }, expect.objectContaining({ instanceId: 'service-b' }));
    expect(clientFactory).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('does not expose an unknown or deleted asset', async () => {
    expect((await request(action, { ...body(), code_graph_id: 'missing-asset' })).status).toBe(404);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it.each(['processing', 'ready'])('does not bypass missing metadata using a KS owner record (%s)', async status => {
    inFlightDetail = { code_graph_id: 'orphan-asset', status, owner_user_id: 'authenticated-user', team_id: 'build-team' };
    expect((await request(action, { ...body(), code_graph_id: 'orphan-asset' })).status).toBe(404);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('forwards another authorized service with its own credential and asset', async () => {
    expect((await request(action, { ...body(), code_graph_id: 'asset-b' }, { 'X-Tdai-Service-Id': 'service-b' })).status).toBe(200);
    expect(received[0]).toMatchObject({ service: 'service-b', authorization: 'Bearer upstream-service-b', body: { code_graph_id: 'asset-b' } });
    expect(invoke).toHaveBeenCalledWith('team-member/get', { team_id: 'team-service-b', user_id: 'authenticated-user' }, expect.anything());
  });

  it('rejects caller-supplied identity/routing fields instead of forwarding them', async () => {
    expect((await request(action, { ...body(), team_id: 'forged-team', user_id: 'forged-user', service_id: 'service-b', filePath: '/etc/passwd' })).status).toBe(400);
    expect(received).toEqual([]);
  });

  it('preserves explicit snapshot expiry and unsupported states', async () => {
    for (const state of ['version_expired', 'unsupported', 'building', 'failed', 'unindexed', 'empty']) {
      upstreamBody = { code: 0, data: { ...fixture, state, nodes: [], edges: [], source: undefined } };
      const response = await request(action, body());
      expect(response.status).toBe(200);
      expect((await response.json()).data.state).toBe(state);
    }
  });

  it('preserves an upstream permission denial instead of returning a successful empty graph', async () => {
    upstreamStatus = 403;
    upstreamBody = { code: 403, message: 'UPSTREAM_FORBIDDEN', data: null };
    const response = await request(action, body());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 403, message: 'UPSTREAM_FORBIDDEN', data: null });
  });
});

describe.each(['calls', 'impact', 'dependencies', 'clusters', 'hierarchy'] as const)('CodeGraph %s mode authorization', mode => {
  it('requires the same asset ACL for every mode', async () => {
    allowed=false;
    expect((await request('graph',{code_graph_id:'asset-a',mode})).status).toBe(403);
    expect(received).toEqual([]); expect(clientFactory).not.toHaveBeenCalled();
  });
  it('requires team membership even after an asset ACL allow', async () => {
    isMember=false;
    expect((await request('graph',{code_graph_id:'asset-a',mode})).status).toBe(403);
    expect(received).toEqual([]); expect(clientFactory).not.toHaveBeenCalled();
  });
  it('does not resolve the same asset through another service', async () => {
    expect((await request('graph',{code_graph_id:'asset-a',mode},{'X-Tdai-Service-Id':'service-b'})).status).toBe(404);
    expect(received).toEqual([]); expect(clientFactory).not.toHaveBeenCalled();
  });
  it('does not allow unauthenticated mode reads', async () => {
    expect((await request('graph',{code_graph_id:'asset-a',mode},{'X-Tdai-User-Key':'invalid'})).status).toBe(401);
    expect(received).toEqual([]); expect(clientFactory).not.toHaveBeenCalled();
  });
  it('rejects missing identity before reading metadata', async () => {
    expect((await request('graph',{code_graph_id:'asset-a',mode},{'X-Tdai-User-Key':''})).status).toBe(400);
    expect(received).toEqual([]); expect(clientFactory).not.toHaveBeenCalled();
  });
});

describe('CodeGraph source line validation', () => {
  it.each([0, -1, 1.5, '1000', 3_000_000])('rejects invalid sourceLine %s before calling upstream', async sourceLine => {
    expect((await request('graph-source', { code_graph_id: 'asset-a', nodeId: 'node-a', indexVersion: 'v1', sourceLine })).status).toBe(400);
    expect(received).toEqual([]);
  });
  it('rejects sourceLine on node requests', async () => {
    expect((await request('graph-node', { code_graph_id: 'asset-a', nodeId: 'node-a', indexVersion: 'v1', sourceLine: 1000 })).status).toBe(400);
    expect(received).toEqual([]);
  });
});

describe('CodeGraph HttpKnowledgeClient routing key ownership', () => {
  it.each(cases)('$action cannot replace its authorized asset via request fields', async ({ action, params }) => {
    const client = new HttpKnowledgeClient({ baseUrl, serviceId: 'service-a', authToken: 'test-upstream' });
    await client.codeGraphStructured('asset-a', action, { ...params, code_graph_id: 'asset-b' } as CodeGraphRequest);
    expect(received[0].body.code_graph_id).toBe('asset-a');
  });
});

describe.each([
  { action: 'search', params: { query: 'sameName', kind: 'function', limit: 4 } },
  { action: 'explore', params: { query: 'sameName', maxFiles: 4 } },
])('legacy text $action compatibility', ({ action, params }) => {
  it('preserves the text/isError envelope and existing parameter names', async () => {
    const text = { text: '**Search Results**\nfixture', isError: false };
    upstreamBody = { code: 0, data: text };
    const response = await request(action, { code_graph_id: 'asset-a', ...params });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(text);
    expect(received[0]).toMatchObject({ path: `/v3/code-graph/${action}`, service: 'service-a', body: { code_graph_id: 'asset-a', ...params } });
  });

  it('retains the asset read permission gate', async () => {
    allowed = false;
    expect((await request(action, { code_graph_id: 'asset-a', ...params })).status).toBe(403);
    expect(received).toEqual([]);
  });
});
