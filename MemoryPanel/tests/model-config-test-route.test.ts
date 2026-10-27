import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { resetModelProbeRunsForTests } from '../src/panel/domain/model-config-probe.js';

interface ResolvedExtraction {
  source: 'deployment' | 'panel';
  config_id: string | null;
  version: number;
  enabled: boolean | null;
  updated_at: string | null;
  draft_present: boolean;
  active: { provider: string; base_url: string; api_key: string; model_id: string; description: string } | null;
  draft: { provider: string; base_url: string; api_key: string; model_id: string; description: string } | null;
}

function unresolved(over: Partial<ResolvedExtraction> = {}): ResolvedExtraction {
  return {
    source: 'deployment',
    config_id: null,
    version: 0,
    enabled: null,
    updated_at: null,
    draft_present: false,
    active: null,
    draft: null,
    ...over,
  };
}

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

interface CoreFixture {
  server: Server;
  url: string;
  resolved: ResolvedExtraction;
  paths: string[];
  bodyInstance: Array<string | undefined>;
  recorded: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startCoreFixture(): Promise<CoreFixture> {
  const resolved = { value: unresolved() };
  const paths: string[] = [];
  const bodyInstance: Array<string | undefined> = [];
  const recorded: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '');
    bodyInstance.push(req.headers['x-tdai-service-id'] as string | undefined);
    const rawBody = await readBody(req);
    if (req.url === '/v3/internal/meta/instance-upstream/extraction/resolve') {
      return json(res, 200, { code: 0, message: 'ok', request_id: 'r1', data: resolved.value });
    }
    if (req.url === '/v3/internal/meta/instance-upstream/extraction/test-result') {
      recorded.push((rawBody ? JSON.parse(rawBody) : {}) as Record<string, unknown>);
      return json(res, 200, { code: 0, message: 'ok', request_id: 'r1', data: { recorded: true } });
    }
    return json(res, 404, { code: 404, message: 'not_found', request_id: 'r1', data: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get resolved() { return resolved.value; },
    set resolved(value: ResolvedExtraction) { resolved.value = value; },
    paths,
    bodyInstance,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  } as CoreFixture;
}

interface ChatFixture {
  server: Server;
  baseUrl: string;
  requests: Array<{ url?: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }>;
  slow: { value: boolean };
  close: () => Promise<void>;
}

async function startChatFixture(): Promise<ChatFixture> {
  const requests: ChatFixture['requests'] = [];
  const slow = { value: false };
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    if (slow.value) return;
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1] ?? {};
    if (last.role === 'tool') {
      const nonce = (JSON.parse(String(last.content ?? '{}')) as { nonce?: string }).nonce ?? '';
      return json(res, 200, {
        choices: [{ index: 0, message: { role: 'assistant', content: `nonce ${nonce}` } }],
      });
    }
    if (Array.isArray(body.tools)) {
      return json(res, 200, {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_probe_nonce', arguments: '{}' } }],
          },
        }],
      });
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).join(' ');
    if (system.toLowerCase().includes('json')) {
      return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: '{"probe":"ok","value":42}' } }] });
    }
    return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    slow,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: Hono;
let invoke: ReturnType<typeof vi.fn>;
let core: CoreFixture;
let chat: ChatFixture;
let adminUserType: 'system_admin' | 'member';
let adminValid: boolean;

beforeEach(async () => {
  resetModelProbeRunsForTests();
  adminUserType = 'system_admin';
  adminValid = true;
  core = await startCoreFixture();
  chat = await startChatFixture();
  invoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') {
      return {
        code: 0,
        message: 'ok',
        request_id: 'req-test',
        data: {
          valid: adminValid,
          user: { user_id: 'user-admin', user_type: adminUserType },
        },
      };
    }
    return { code: 0, message: 'ok', request_id: 'req-test', data: { action } };
  });
  const deps = {
    instanceRegistry: {
      resolve: (instanceId: string) => ({
        instance_id: instanceId,
        gateway_endpoint: core.url,
        api_key: 'gateway-service-key',
      }),
    },
    metaKernel: { invoke },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    auth: { resolveSession: () => null },
    config: {
      metadataRemoteTimeoutMs: 2_000,
      auth: { sessionCookieName: 'tdai_idp_session' },
      modelTest: { timeoutMs: 800, allowLoopback: true },
    },
  } as unknown as PanelDeps;
  app = new Hono();
  registerMetaProxyRoutes(app, deps);
});

afterEach(async () => {
  await core.close();
  await chat.close();
});

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'deepseek',
    base_url: chat.baseUrl,
    model_id: 'probe-model',
    base_version: 0,
    ...over,
  };
}

async function post(payload: Record<string, unknown>, instanceId = 'instance-a') {
  return app.request('/meta/instance-upstream/extraction/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': instanceId,
      'X-Tdai-User-Key': 'admin-key',
    },
    body: JSON.stringify(payload),
  });
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('model config test endpoint', () => {
  it('rejects non-admins before touching any endpoint config', async () => {
    adminUserType = 'member';
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 403, message: 'PERMISSION_DENIED' });
    expect(core.paths).toHaveLength(0);
    expect(chat.requests).toHaveLength(0);
  });

  it('rejects an invalid payload', async () => {
    const bad = await post({ provider: 'nope', base_url: chat.baseUrl, model_id: 'x' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ message: 'INVALID_TEST_CONFIG' });

    const noModel = await post({ provider: 'deepseek', base_url: chat.baseUrl, model_id: '' });
    expect(noModel.status).toBe(400);
    expect(chat.requests).toHaveLength(0);
  });

  it('rejects a stale base_version with comparable numbers', async () => {
    core.resolved = unresolved({ version: 7, draft_present: true, draft: {
      provider: 'deepseek', base_url: chat.baseUrl, api_key: 'sk-draft', model_id: 'probe-model', description: '',
    } });
    const res = await post(body({ base_version: 5 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 409,
      message: 'CONFIG_VERSION_CONFLICT',
      data: { expected: 5, actual: 7 },
    });
    expect(chat.requests).toHaveLength(0);
  });

  it('requires a key from the form or the stored config', async () => {
    const res = await post(body({ base_version: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: 'MISSING_API_KEY' });
  });

  it('streams three independent capability results bound to a fingerprint', async () => {
    const res = await post(body({ api_key: 'sk-form-key' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    // 反代必须能看到这两个头才能正确关闭缓冲并禁用缓存（部署手册 §5.1）。
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const events = parseNdjson(await res.text());
    const started = events[0];
    expect(started).toMatchObject({
      type: 'started',
      instance_id: 'instance-a',
      source: 'deployment',
      capabilities: ['basic', 'json', 'tools'],
    });
    expect(String(started?.fingerprint)).toMatch(/^sha256:[0-9a-f]{16}$/);

    const results = events.filter((e) => e.type === 'result');
    expect(results.map((e) => `${e.capability}:${e.status}`)).toEqual([
      'basic:passed',
      'json:passed',
      'tools:passed',
    ]);
    expect(results.every((e) => e.test_id === started?.test_id)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });

    expect(chat.requests).toHaveLength(4);
    expect(chat.requests.every((r) => r.headers.authorization === 'Bearer sk-form-key')).toBe(true);

    // 测试证据写回 Core（启用门禁依赖它），且不携带 Key（新 Key 除外）。
    expect(core.recorded).toHaveLength(1);
    const record = core.recorded[0];
    expect(record).toMatchObject({
      test_id: 'mct_' + String(started?.test_id).replace('mct_', ''),
      provider: 'deepseek',
      base_url: chat.baseUrl,
      model_id: 'probe-model',
      passed: true,
      capabilities: { basic: 'passed', json: 'passed', tools: 'passed' },
    });
    expect(record?.api_key).toBe('sk-form-key');
    expect(JSON.stringify(record)).not.toMatch(/authorization|Bearer/i);
  });

  it('reuses the stored draft key when the form leaves it blank', async () => {
    core.resolved = unresolved({
      version: 2,
      source: 'panel',
      config_id: 'ext-1',
      draft_present: true,
      draft: { provider: 'deepseek', base_url: chat.baseUrl, api_key: 'sk-stored-draft', model_id: 'probe-model', description: '' },
    });
    const res = await post(body({ base_version: 2 }));
    const events = parseNdjson(await res.text());
    expect(events[0]).toMatchObject({ type: 'started', source: 'panel' });
    expect(events.filter((e) => e.type === 'result').every((e) => e.status === 'passed')).toBe(true);
    expect(chat.requests.length).toBeGreaterThan(0);
    expect(chat.requests.every((r) => r.headers.authorization === 'Bearer sk-stored-draft')).toBe(true);
    // 表单没填 Key：证据记录也不带 Key，由 Core 自己解析草稿 Key 计算指纹。
    expect(core.recorded).toHaveLength(1);
    expect('api_key' in (core.recorded[0] ?? {})).toBe(false);
  });

  it('never returns or logs the plaintext key', async () => {
    const res = await post(body({ api_key: 'sk-super-secret-value' }));
    const text = await res.text();
    expect(text).not.toContain('sk-super-secret-value');
    const logged = JSON.stringify((invoke.mock.calls as unknown[][]).map((call) => call[1]));
    expect(logged).not.toContain('sk-super-secret-value');
  });

  it('does not write draft, active or enabled state', async () => {
    await (await post(body({ api_key: 'sk-form-key' }))).text();
    const actions = (invoke.mock.calls as unknown[][]).map((call) => call[0]);
    expect(actions).toEqual(['auth/verify']);
    expect(actions).not.toContain('instance-upstream/extraction/update');
    expect(actions).not.toContain('instance-upstream/extraction/create');
  });

  it('records a timed-out run as failed evidence', async () => {
    chat.slow.value = true;
    const res = await post(body({ api_key: 'sk-form-key' }));
    // 客户端取消不会记录证据（取消后不写 Core），这里覆盖"失败的运行要留下 passed:false"，
    // 避免旧的有效测试证据在端点已经不可用后仍然可被用于启用。
    await res.text();
    expect(core.recorded).toHaveLength(1);
    expect(core.recorded[0]?.passed).toBe(false);
  });

  it('refuses a concurrent duplicate probe for the same admin', async () => {
    chat.slow.value = true;
    const first = await post(body({ api_key: 'sk-form-key' }));
    expect(first.status).toBe(200);

    const second = await post(body({ api_key: 'sk-form-key' }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ message: 'TEST_ALREADY_RUNNING' });

    const events = parseNdjson(await first.text());
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });

    // 上一轮结束后可以重新测试
    chat.slow.value = false;
    const third = await post(body({ api_key: 'sk-form-key' }));
    expect(third.status).toBe(200);
    await third.text();
  });

  it('rejects malicious endpoints without issuing any upstream request', async () => {
    const res = await post(body({ api_key: 'sk-form-key', base_url: 'http://169.254.169.254/latest' }));
    const events = parseNdjson(await res.text());
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(3);
    expect(results.every((e) => (e.error as { code?: string } | undefined)?.code === 'ENDPOINT_NOT_ALLOWED')).toBe(true);
    expect(chat.requests).toHaveLength(0);
  });
});
