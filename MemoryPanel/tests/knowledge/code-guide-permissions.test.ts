// Panel owns caller identity, membership and ACL. Knowledge separately validates
// source existence, commit, revision, citation hash and the allowed source set.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerCodeGuideRoutes } from '../../src/panel/http/routes/knowledge/code-guide-routes.js';

function setup() {
  const app = new Hono();
  const readers = new Set(['asset', 'source']);
  const codeGuide = vi.fn(async (_asset: string, action: string, body: Record<string, unknown>) => {
    if (action === 'sources') return { items: ['asset', 'source'] };
    return { actor: body.actor, sources: body.allowedSources };
  });
  const codeReview = vi.fn(async () => ({ items: [] }));
  registerCodeGuideRoutes(app, {
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: 'test',
        name: 'test',
        gateway_endpoint: 'http://unused.invalid',
        api_key: 'fixture',
      },
    ]),
    metaKernel: {
      invoke: async (action: string, body: Record<string, unknown>) => {
        if (action === 'auth/verify')
          return { code: 0, data: { valid: true, user: { user_id: 'reader' } } };
        if (action === 'asset/get')
          return { code: 0, data: { asset_id: body.asset_id, team_id: 'team' } };
        if (action === 'team-member/get')
          return { code: 0, data: { user_id: 'reader', status: 'active' } };
        if (action === 'acl/check')
          return {
            code: 0,
            data: { allowed: body.action === 'read' && readers.has(String(body.asset_id)) },
          };
        throw new Error('unexpected metadata request');
      },
    },
    knowledgeClientFactory: () => ({ codeGuide, codeReview }),
  } as unknown as PanelDeps);
  function request(path: string) {
    return app.request('/knowledge/code-graph/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': 'test',
        'X-Tdai-User-Key': 'fixture',
      },
      body: JSON.stringify({
        code_graph_id: 'asset',
        actor: 'editor',
        allowedSources: ['asset', 'source', 'foreign'],
      }),
    });
  }
  return { readers, request, codeGuide, codeReview };
}
describe('code guide and review permissions', () => {
  it.each(['list', 'search', 'get', 'feedback'])(
    'checks all sources again for %s',
    async (action) => {
      const { readers, request } = setup();
      expect((await (await request('guides/' + action)).json()).data).toEqual({
        actor: 'reader',
        sources: ['asset', 'source'],
      });
      readers.delete('source');
      expect((await (await request('guides/' + action)).json()).data).toEqual({
        actor: 'reader',
        sources: ['asset'],
      });
    },
  );
  it.each(['generate', 'publish', 'withdraw', 'save', 'history', 'editor'])(
    'requires asset write access for %s',
    async (action) => {
      const { request, codeGuide } = setup();
      expect((await request('guides/' + action)).status).toBe(403);
      expect(codeGuide).not.toHaveBeenCalled();
    },
  );
  it.each(['reviews/list', 'reviews/compare', 'guides/list', 'guides/get'])(
    'denies %s after revocation',
    async (path) => {
      const { readers, request, codeGuide, codeReview } = setup();
      readers.clear();
      expect((await request(path)).status).toBe(403);
      expect(codeGuide).not.toHaveBeenCalled();
      expect(codeReview).not.toHaveBeenCalled();
    },
  );
});
