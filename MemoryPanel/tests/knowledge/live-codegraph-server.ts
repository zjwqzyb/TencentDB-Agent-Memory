/** Local browser acceptance fixture. SDK, Knowledge and Panel graph routes are
 * real; only metadata/ACL/catalog identity are fixtures. No production services.
 * Run with Node 22 via tsx. SIGINT/SIGTERM closes both listeners/index and removes
 * the temporary repository. No fixed service ports are used.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { registerKnowledgeCodeGraphRoutes } from '../../src/panel/http/routes/knowledge/code-graph-routes.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';

const { indexProject, closeIndex, getStats, structuredSdkInfo } = await import('../../../MemoryKnowledge/src/engines/code/bridge.js');
const { createCodeGraphRoutes } = await import('../../../MemoryKnowledge/src/routes/code-graph.js');
const root = mkdtempSync(join(tmpdir(), 'codegraph-browser-live-'));
const listeners: Server[] = [];
let instance: Awaited<ReturnType<typeof indexProject>> | undefined;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const server of listeners) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  try { if (instance) closeIndex(instance); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
process.once('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });
async function listen(app: Hono): Promise<string> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(listener as Server));
    listener.once('error', reject);
  });
  listeners.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
try {
  const files = {
    'package.json': '{"name":"codegraph-browser-live-fixture","type":"module"}',
    'base.ts': 'export function leaf() { return 42; }\nexport class Base {}\nexport interface I {}\n',
    'src/main.ts': 'import { leaf, Base, I } from "../base";\nexport function entry() { return leaf(); }\nexport function top() { return entry(); }\nexport class Child extends Base implements I {}\n',
    'other.ts': 'export function entry() { return 7; }\n',
    'javascript.js': 'export function jsLeaf() { return 3; }\nexport function jsEntry() { return jsLeaf(); }\n',
    'late.ts': Array.from({ length: 999 }, (_, i) => `// line ${i + 1}`).join('\n') + '\nimport { leaf } from "./base";\nexport function late() { return leaf(); }\n',
    'alpha/index.ts': 'import { beta } from "../beta";\nexport function alpha() { return beta(); }\n',
    'beta/index.ts': 'import { alpha } from "../alpha";\nexport function beta() { return alpha(); }\n',
  };
  for (const [file, content] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=CodeGraph Test', '-c', 'user.email=codegraph-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'local browser fixture'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  instance = await indexProject(root);
  const stats = getStats(instance);
  const sdk = await structuredSdkInfo(root);
  const stamp = new Date().toISOString();
  const serviceId = 'service-browser', userKey = 'codegraph-local-test-only';
  const user = { user_id: 'user-browser', username: 'browser-tester', display_name: 'Browser Tester', user_type: 'normal', status: 'active' };
  const team = { team_id: 'team-browser', name: 'Live CodeGraph Fixture', owner_user_id: user.user_id, status: 'active', created_at: stamp, updated_at: stamp };
  const agent = { agent_id: 'agent-browser', team_id: team.team_id, owner_user_id: user.user_id, name: 'Browser Agent', status: 'active', visibility: 'team', created_at: stamp, updated_at: stamp, metadata_json: '{}' };
  const asset = { knowledge_id: 'cg-browser-a', code_graph_id: 'cg-browser-a', asset_type: 'code_graph', name: 'Live SDK CodeGraph', repo_name: 'Live SDK CodeGraph', repo_url: 'https://github.com/fixture/codegraph-live.git', branch: 'main', commit_hash: commit, team_id: team.team_id, visibility: 'team', owner_user_id: user.user_id, meta_status: 'active', status: 'ready', version: 1, stats: { files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount }, last_sync_at: stamp, created_at: stamp, updated_at: stamp };
  const knowledge = new Hono();
  knowledge.route('/v3/code-graph', createCodeGraphRoutes({
    cgService: {
      getById: (service: string, id: string) => service === serviceId && id === asset.code_graph_id ? { ...asset } : undefined,
      dirFor: (service: string, selectedTeam: string, id: string) => {
        if (service !== serviceId || selectedTeam !== team.team_id || id !== asset.code_graph_id) throw new Error('fixture asset mismatch');
        return root;
      },
    },
    instancePool: { get: (id: string) => id === asset.code_graph_id ? instance : undefined },
    publicBaseUrl: '',
  } as unknown as Parameters<typeof createCodeGraphRoutes>[0]));
  const knowledgeBaseUrl = await listen(knowledge);
  const routes = new Hono();
  registerKnowledgeCodeGraphRoutes(routes, {
    instanceRegistry: new InstanceRegistry([{ instance_id: serviceId, name: 'Local live fixture', gateway_endpoint: 'http://unused.invalid', api_key: 'test-only' }]),
    metaKernel: { invoke: async (action: string, body: Record<string, unknown>, ctx: MetaCallContext) => {
      if (ctx.instanceId !== serviceId) return { code: 404, data: null };
      if (action === 'auth/verify') return { code: 0, data: { valid: ctx.userKey === userKey, user } };
      if (action === 'asset/get') return { code: 0, data: body.asset_id === asset.code_graph_id ? { asset_id: asset.code_graph_id, team_id: team.team_id, asset_type: 'code_graph' } : null };
      if (action === 'acl/check') return { code: 0, data: { allowed: body.user_id === user.user_id && body.asset_id === asset.code_graph_id && body.action === 'read' } };
      if (action === 'team-member/get') return { code: 0, data: body.team_id === team.team_id && body.user_id === user.user_id ? { user_id: user.user_id, status: 'active' } : null };
      throw new Error(`Unexpected fixture metadata action: ${action}`);
    } },
    knowledgeClientFactory: (selectedService: string) => new HttpKnowledgeClient({ baseUrl: knowledgeBaseUrl, serviceId: selectedService, authToken: '', timeoutMs: 10_000 }),
  } as unknown as PanelDeps);
  const panel = new Hono();
  panel.route('/api/v1', routes);
  const panelBaseUrl = await listen(panel);
  const metadata = { pid: process.pid, panelBaseUrl, knowledgeBaseUrl, projectRoot: root, headers: { 'Content-Type': 'application/json', 'X-Tdai-Service-Id': serviceId, 'X-Tdai-User-Key': userKey }, asset, user, team, agent, capabilities: { sdkVersion: sdk.version, languages: ['typescript', 'javascript'] }, note: 'Graph/source results are real. Identity/catalog/ACL are test fixtures. Loopback only; SIGTERM/SIGINT cleans all resources.' };
  panel.get('/__fixture', c => c.json(metadata));
  if (process.env.CODEGRAPH_LIVE_METADATA) writeFileSync(process.env.CODEGRAPH_LIVE_METADATA, JSON.stringify(metadata, null, 2));
  console.log('CODEGRAPH_LIVE_READY ' + JSON.stringify(metadata));
} catch (error) {
  await cleanup();
  throw error;
}
