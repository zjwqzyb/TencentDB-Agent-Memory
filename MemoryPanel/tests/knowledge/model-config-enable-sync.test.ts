import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerMetaProxyRoutes } from '../../src/panel/http/routes/meta/proxy.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

interface SnapshotState {
  status: 'ready' | 'paused' | 'invalid' | 'config_unavailable';
  reason?: string;
  snapshot?: {
    snapshot_id: string;
    version: number;
    provider: string;
    base_url: string;
    api_key: string;
    model_id: string;
    description: string;
    activated_at: string;
  };
}

interface CoreFixture {
  url: string;
  state: SnapshotState;
  paths: string[];
  close: () => Promise<void>;
}

async function startCore(): Promise<CoreFixture> {
  const state: SnapshotState = { status: 'ready' };
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '');
    await readBody(req);
    if (req.url === '/v3/internal/meta/instance-upstream/extraction/snapshot') {
      return json(res, 200, { code: 0, message: 'ok', request_id: 'core', data: state });
    }
    return json(res, 404, { code: 404, message: 'not_found', request_id: 'core', data: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get state() {
      return state;
    },
    set state(value: SnapshotState) {
      Object.assign(state, value);
    },
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface KsFixture {
  url: string;
  listItems: unknown[];
  sets: Array<Record<string, unknown>>;
  failSet: boolean;
  paths: string[];
  close: () => Promise<void>;
}

async function startKs(): Promise<KsFixture> {
  const sets: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const fixture: Partial<KsFixture> = { sets, paths, failSet: false, listItems: [] };
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '');
    const raw = await readBody(req);
    if (req.url === '/v3/internal/llm-binding/list') {
      return json(res, 200, { code: 0, message: 'ok', data: { items: fixture.listItems } });
    }
    if (req.url === '/v3/internal/llm-binding/set') {
      if (fixture.failSet) {
        return json(res, 500, { code: 500, message: 'ks_down', data: null });
      }
      sets.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      return json(res, 200, { code: 0, message: 'ok', data: { ok: true } });
    }
    return json(res, 404, { code: 404, message: 'not_found', data: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(fixture, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as KsFixture;
}

const proxyBaseUrl = 'http://127.0.0.1:8096';
const activeSnapshot = {
  snapshot_id: 'snap-5',
  version: 5,
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  api_key: 'sk-provider-secret',
  model_id: 'deepseek-chat',
  description: 'primary',
  activated_at: '2026-10-26T00:00:00.000Z',
};

const enableData = {
  config_id: 'cfg-extraction-1',
  version: 5,
  paused: false,
  active_snapshot: {
    snapshot_id: 'snap-5',
    version: 5,
    provider: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    api_key_configured: true,
    api_key_masked: 'sk-p••••••',
    model_id: 'deepseek-chat',
    description: 'primary',
    activated_at: '2026-10-26T00:00:00.000Z',
  },
};

let app: Hono;
let invoke: ReturnType<typeof vi.fn>;
let core: CoreFixture;
let ks: KsFixture;
let enableResponse: { code: number; data: unknown };
let logs: string[];

beforeEach(async () => {
  core = await startCore();
  ks = await startKs();
  core.state = { status: 'ready', snapshot: activeSnapshot };
  ks.listItems = [
    {
      service_id: 'instance-a',
      mode: 'proxy',
      proxy_base_url: proxyBaseUrl,
      base_url: null,
      has_api_key: true,
      enabled: true,
      config_source: 'deployment',
    },
  ];
  enableResponse = { code: 0, data: enableData };
  logs = [];
  invoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') {
      return {
        code: 0,
        message: 'ok',
        request_id: 'req',
        data: { valid: true, user: { user_id: 'user-admin', user_type: 'system_admin' } },
      };
    }
    if (action === 'instance-upstream/extraction/enable') {
      return { code: enableResponse.code, message: 'ok', request_id: 'req', data: enableResponse.data };
    }
    if (action === 'instance-upstream/extraction/disable') {
      return {
        code: 0,
        message: 'ok',
        request_id: 'req',
        data: { ...enableData, paused: true, enabled: false },
      };
    }
    return { code: 0, message: 'ok', request_id: 'req', data: {} };
  });
  const logger = {
    info: (msg: string, data?: unknown) => logs.push(`INFO ${msg} ${JSON.stringify(data ?? {})}`),
    warn: (msg: string, data?: unknown) => logs.push(`WARN ${msg} ${JSON.stringify(data ?? {})}`),
    error: (msg: string, data?: unknown) => logs.push(`ERROR ${msg} ${JSON.stringify(data ?? {})}`),
    debug: () => {},
  };
  const deps = {
    instanceRegistry: {
      resolve: (instanceId: string) => ({
        instance_id: instanceId,
        gateway_endpoint: core.url,
        api_key: 'gateway-service-key',
      }),
    },
    metaKernel: { invoke },
    logger,
    auth: { resolveSession: () => null },
    config: {
      metadataRemoteTimeoutMs: 2_000,
      knowledge: { baseUrl: ks.url, authToken: 'ks-token', timeoutMs: 2_000 },
      knowledgeLlmBinding: { sync: true, proxyBaseUrl },
      auth: { sessionCookieName: 'tdai_idp_session' },
      modelTest: { timeoutMs: 800, allowLoopback: true },
    },
  } as unknown as PanelDeps;
  app = new Hono();
  registerMetaProxyRoutes(app, deps);
});

afterEach(async () => {
  await core.close();
  await ks.close();
});

const enable = () =>
  app.request('/meta/instance-upstream/extraction/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': 'instance-a',
      'X-Tdai-User-Key': 'admin-key',
    },
    body: JSON.stringify({ expected_version: 4, test_id: 'test-1' }),
  });

describe('Panel enable → Knowledge Service binding sync', () => {
  it('pushes the active snapshot provenance to KS after a successful enable', async () => {
    const response = await enable();
    expect(response.status).toBe(200);
    expect(ks.sets).toHaveLength(1);
    const body = ks.sets[0]!;
    expect(body).toMatchObject({
      mode: 'proxy',
      config_source: 'managed',
      enabled: true,
      provider: 'deepseek',
      protocol: 'openai',
      model: 'deepseek-chat',
      base_url: 'https://api.deepseek.com/v1',
      config_id: 'cfg-extraction-1',
      config_version: 5,
      snapshot_id: 'snap-5',
      proxy_base_url: proxyBaseUrl,
    });
    expect(typeof body.fingerprint).toBe('string');
    expect(String(body.fingerprint)).toMatch(/^sha256:[0-9a-f]{16}$/);
    // Existing proxy key is retained; the provider key never leaves Core.
    expect(body).not.toHaveProperty('api_key');
    expect(JSON.stringify(body)).not.toContain('sk-provider-secret');
    expect(logs.join('\n')).not.toContain('sk-provider-secret');
    expect(logs.join('\n')).toContain('snap-5');
  });

  it('returns 502 KNOWLEDGE_SYNC_FAILED when KS rejects the binding', async () => {
    ks.failSet = true;
    const response = await enable();
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: number; message: string };
    expect(body.code).toBe(502);
    expect(body.message).toContain('KNOWLEDGE_SYNC_FAILED');
    expect(body.message).toContain('ks_down');
    expect(body.message).toContain('core config snap-5@5 is active');
  });

  it('returns 502 when the active snapshot is paused', async () => {
    core.state = { status: 'paused' };
    const response = await enable();
    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('KNOWLEDGE_SYNC_FAILED');
    expect(body.message).toContain('paused');
    expect(ks.sets).toHaveLength(0);
  });

  it('returns 502 when a concurrent enable changed the snapshot', async () => {
    core.state = {
      status: 'ready',
      snapshot: { ...activeSnapshot, snapshot_id: 'snap-6', version: 6 },
    };
    const response = await enable();
    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('KNOWLEDGE_SYNC_FAILED');
    expect(body.message).toContain('changed during enable');
    expect(ks.sets).toHaveLength(0);
  });
});


const disable = () =>
  app.request('/meta/instance-upstream/extraction/disable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': 'instance-a',
      'X-Tdai-User-Key': 'admin-key',
    },
    body: JSON.stringify({ expected_version: 5 }),
  });

describe('Panel disable → Knowledge Service binding sync', () => {
  it('marks the KS binding disabled immediately after a pause', async () => {
    core.state = { status: 'paused' };
    ks.listItems = [
      {
        service_id: 'instance-a',
        mode: 'proxy',
        proxy_base_url: proxyBaseUrl,
        base_url: null,
        has_api_key: true,
        enabled: true,
        config_source: 'managed',
        config_id: 'cfg-extraction-1',
        config_version: 5,
      },
    ];
    const res = await disable();
    const body = (await res.json()) as { code: number; data?: { paused?: boolean } };
    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data?.paused).toBe(true);
    expect(ks.sets.at(-1)).toMatchObject({
      enabled: false,
      config_source: 'managed',
      unavailable_reason: 'paused',
    });
  });

  it('still reports the pause when KS is unreachable, and logs the sync failure', async () => {
    core.state = { status: 'paused' };
    ks.failSet = true;
    const res = await disable();
    const body = (await res.json()) as { code: number };
    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(logs.some((line) => line.startsWith('ERROR') && line.includes('after disable'))).toBe(true);
  });
});

const resync = () =>
  app.request('/meta/instance-upstream/extraction/resync-knowledge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': 'instance-a',
      'X-Tdai-User-Key': 'admin-key',
    },
    body: JSON.stringify({}),
  });

describe('manual knowledge binding re-sync', () => {
  it('re-pushes the current snapshot without writing Core config', async () => {
    core.state = { status: 'ready', snapshot: activeSnapshot };
    const res = await resync();
    const body = (await res.json()) as { code: number; data?: { config_version?: number; status?: string } };
    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data?.config_version).toBe(5);
    expect(body.data?.status).toBe('ready');
    expect(ks.sets.at(-1)).toMatchObject({
      config_source: 'managed',
      config_version: 5,
      provider: 'deepseek',
      model: 'deepseek-chat',
      snapshot_id: 'snap-5',
    });
    const coreWrites = (invoke.mock.calls as unknown[][])
      .map((call) => String(call[0]))
      .filter((action) => action.startsWith('instance-upstream/extraction/'));
    expect(coreWrites).toHaveLength(0);
  });

  it('rejects non-admins', async () => {
    invoke.mockImplementation(async (action: string) => {
      if (action === 'auth/verify') {
        return { code: 0, message: 'ok', request_id: 'req', data: { valid: true, user: { user_id: 'u1', user_type: 'member' } } };
      }
      return { code: 0, message: 'ok', request_id: 'req', data: {} };
    });
    const res = await resync();
    expect(res.status).toBe(403);
    expect(ks.sets.at(-1)).toBeUndefined();
  });

  it('returns 502 KNOWLEDGE_SYNC_FAILED when KS rejects the push', async () => {
    ks.failSet = true;
    const res = await resync();
    const body = (await res.json()) as { code: number; message: string };
    expect(res.status).toBe(502);
    expect(body.code).toBe(502);
    expect(body.message).toContain('KNOWLEDGE_SYNC_FAILED');
  });

  it('marks the binding unavailable when Core is paused', async () => {
    core.state = { status: 'paused' };
    const res = await resync();
    const body = (await res.json()) as { code: number; data?: { status?: string } };
    expect(res.status).toBe(200);
    expect(body.data?.status).toBe('paused');
    expect(ks.sets.at(-1)).toMatchObject({ enabled: false, unavailable_reason: 'paused' });
  });
});
