import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

let app: Hono;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (action: string) => ({
    code: 0,
    message: 'ok',
    request_id: 'req-test',
    data: { action },
  }));
  const deps = {
    instanceRegistry: {
      resolve: (instanceId: string) => ({
        instance_id: instanceId,
        gateway_endpoint: 'http://kernel.invalid',
        api_key: 'gateway-test',
      }),
    },
    metaKernel: { invoke },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as PanelDeps;
  app = new Hono();
  registerMetaProxyRoutes(app, deps);
});

async function request(action: string, body: Record<string, unknown>) {
  return app.request(`/meta/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': 'instance-a',
      'X-Tdai-User-Key': 'admin-key',
    },
    body: JSON.stringify(body),
  });
}

describe('Panel extraction model actions', () => {
  it.each([
    ['instance-upstream/extraction/get', {}],
    ['instance-upstream/extraction/create', {
      draft: true,
      provider: 'glm',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key: 'secret',
      model_id: 'glm-4-plus',
    }],
    ['instance-upstream/extraction/update', {
      draft: true,
      expected_version: 3,
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      model_id: 'deepseek-chat',
    }],
  ])('forwards %s with the authenticated instance identity', async (action, body) => {
    const response = await request(action, body);
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      action,
      body,
      expect.objectContaining({
        instanceId: 'instance-a',
        userKey: 'admin-key',
      }),
    );
  });

  it('preserves 409 conflicts and KernelEnvelope data for the client', async () => {
    invoke.mockResolvedValueOnce({
      code: 409,
      message: 'WRITE_CONFLICT: version mismatch',
      request_id: 'req-conflict',
      data: { version: 5 },
    });
    const response = await request('instance-upstream/extraction/update', {
      draft: true,
      expected_version: 4,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 409,
      message: 'WRITE_CONFLICT: version mismatch',
      request_id: 'req-conflict',
      data: { version: 5 },
    });
  });

  it('does not expose activation or deletion actions from ticket 2', async () => {
    expect((await request('instance-upstream/extraction/toggle', { enabled: true })).status).toBe(404);
    expect((await request('instance-upstream/extraction/delete', {})).status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });
});
