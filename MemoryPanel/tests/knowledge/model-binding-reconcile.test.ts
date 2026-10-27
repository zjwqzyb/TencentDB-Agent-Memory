import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureKnowledgeLlmBindings,
  type KsBindingSnapshot,
  type KnowledgeLlmBindingOptions,
  type KnowledgeSnapshot,
} from '../../src/panel/startup/ensure-knowledge-llm-binding.js';
import type { InstanceEntry } from '../../src/panel/config/instance-registry.js';
import type { Logger } from '../../src/panel/infra/logger.js';

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

const proxyBaseUrl = 'http://127.0.0.1:8096';
const gateway = 'http://core.invalid';

interface Harness {
  ksUrl: string;
  snapshot: KnowledgeSnapshot;
  snapshotDown: boolean;
  cached: KsBindingSnapshot[];
  sets: Array<Record<string, unknown>>;
  metaPaths: string[];
  corePaths: string[];
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const h: Partial<Harness> = {};
  const ksServer = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === '/v3/internal/llm-binding/list') {
      return json(res, 200, { code: 0, message: 'ok', data: { items: h.cached ?? [] } });
    }
    if (req.url === '/v3/internal/llm-binding/set') {
      h.sets!.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      return json(res, 200, { code: 0, message: 'ok', data: { ok: true } });
    }
    if (req.url === '/v3/meta/user/list') {
      h.metaPaths!.push(req.url);
      return json(res, 200, { code: 0, message: 'ok', data: { items: [] } });
    }
    return json(res, 404, { code: 404, message: 'not_found', data: null });
  });
  await new Promise<void>((resolve) => ksServer.listen(0, '127.0.0.1', resolve));
  h.ksUrl = `http://127.0.0.1:${(ksServer.address() as AddressInfo).port}`;
  h.sets = [];
  h.metaPaths = [];
  h.corePaths = [];
  h.snapshot = { status: 'config_unavailable' };
  h.snapshotDown = false;
  h.cached = [];
  h.close = () =>
    new Promise<void>((resolve) => {
      ksServer.closeAllConnections();
      ksServer.close(() => resolve());
    });
  return h as Harness;
}

const instance: InstanceEntry = {
  instance_id: 'instance-a',
  name: 'A',
  gateway_endpoint: gateway,
  api_key: 'gateway-key',
};

let harness: Harness;
let fetchMock: ReturnType<typeof vi.fn>;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  harness = await startHarness();
  realFetch = globalThis.fetch.bind(globalThis);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://core.invalid')) {
      const path = new URL(url).pathname;
      harness.corePaths.push(path);
      if (harness.snapshotDown) throw new Error('core unreachable');
      const respond = (data: unknown) =>
        new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'core', data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/v3/internal/meta/instance-upstream/extraction/snapshot') {
        return respond(harness.snapshot);
      }
      if (path === '/v3/meta/user/list') {
        return respond({ items: [{ user_id: 'knowledge-service', username: 'knowledge-service' }] });
      }
      if (path === '/v3/meta/user-key/create') {
        return respond({ key_value: 'ks-user-key' });
      }
      return new Response(JSON.stringify({ code: 404, message: 'not_found', data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.close();
});

function options(overrides: Partial<KnowledgeLlmBindingOptions> = {}): KnowledgeLlmBindingOptions {
  return {
    knowledgeBaseUrl: harness.ksUrl,
    knowledgeAuthToken: 'ks-token',
    proxyBaseUrl,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const active: KnowledgeSnapshot = {
  status: 'ready',
  snapshot: {
    snapshot_id: 'snap-9',
    version: 9,
    provider: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    api_key: 'sk-core-key',
    model_id: 'deepseek-chat',
    description: '',
    activated_at: '2026-10-26T00:00:00.000Z',
  },
};

const managedCached: KsBindingSnapshot = {
  service_id: 'instance-a',
  mode: 'proxy',
  proxy_base_url: proxyBaseUrl,
  base_url: 'https://api.deepseek.com/v1',
  has_api_key: true,
  enabled: true,
  config_source: 'managed',
  config_id: 'snap-5',
  config_version: 5,
  provider: 'glm',
  model: 'glm-4-plus',
};

const legacyCached: KsBindingSnapshot = {
  service_id: 'instance-a',
  mode: 'proxy',
  proxy_base_url: 'http://old-proxy:8096',
  base_url: null,
  has_api_key: true,
  enabled: true,
  config_source: 'deployment',
};

describe('Knowledge binding startup reconcile', () => {
  it('syncs a ready active snapshot as managed and re-mints when the proxy endpoint changed', async () => {
    harness.snapshot = active;
    harness.cached = [legacyCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets).toHaveLength(1);
    expect(harness.sets[0]).toMatchObject({
      mode: 'proxy',
      config_source: 'managed',
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      config_id: 'snap-9',
      config_version: 9,
      proxy_base_url: proxyBaseUrl,
      base_url: 'https://api.deepseek.com/v1',
    });
    // Proxy endpoint changed → KS user key is re-minted; provider key never leaves Core.
    expect(harness.sets[0]).toMatchObject({ api_key: 'ks-user-key' });
    expect(JSON.stringify(harness.sets[0])).not.toContain('sk-core-key');
  });

  it('retains the existing KS proxy key when the proxy endpoint is unchanged', async () => {
    harness.snapshot = active;
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets).toHaveLength(1);
    expect(harness.sets[0]).not.toHaveProperty('api_key');
    expect(harness.corePaths).not.toContain('/v3/meta/user-key/create');
  });

  it('uses the snapshot credential directly in byo mode', async () => {
    harness.snapshot = active;
    harness.cached = [];
    await ensureKnowledgeLlmBindings([instance], options({ mode: 'byo' }), logger());
    expect(harness.sets[0]).toMatchObject({
      mode: 'byo',
      config_source: 'managed',
      enabled: true,
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-core-key',
      model: 'deepseek-chat',
    });
  });

  it('disables a managed binding when Core is paused (never enables it)', async () => {
    harness.snapshot = { status: 'paused' };
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets).toEqual([
      { mode: 'proxy', config_source: 'managed', enabled: false, unavailable_reason: 'paused' },
    ]);
    expect(harness.corePaths).not.toContain('/v3/meta/user-key/create');
  });

  it('disables a managed binding on an invalid snapshot', async () => {
    harness.snapshot = { status: 'invalid', reason: 'active_snapshot_missing_api_key' };
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets[0]).toMatchObject({
      enabled: false,
      unavailable_reason: 'invalid:active_snapshot_missing_api_key',
    });
  });

  it('does not fall back to the legacy binding when Core reports config_unavailable for a managed row', async () => {
    harness.snapshot = { status: 'config_unavailable' };
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets).toHaveLength(1);
    expect(harness.sets[0]).toMatchObject({
      config_source: 'managed',
      enabled: false,
      unavailable_reason: 'config_unavailable',
    });
    expect(harness.sets[0]).not.toHaveProperty('proxy_base_url');
    expect(harness.corePaths).not.toContain('/v3/meta/user-key/create');
  });

  it('keeps legacy deployments working when no managed config exists', async () => {
    harness.snapshot = { status: 'config_unavailable' };
    harness.cached = [legacyCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets[0]).toMatchObject({
      mode: 'proxy',
      proxy_base_url: proxyBaseUrl,
      enabled: true,
    });
    expect(harness.sets[0]).not.toHaveProperty('config_source');
  });

  it('fails closed on an unreadable snapshot for managed rows but not for legacy rows', async () => {
    harness.snapshotDown = true;
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets[0]).toMatchObject({
      config_source: 'managed',
      enabled: false,
      unavailable_reason: 'snapshot_unavailable',
    });

    harness.sets.length = 0;
    harness.cached = [legacyCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets[0]).toMatchObject({ mode: 'proxy', proxy_base_url: proxyBaseUrl });
  });

  it('never rolls a newer KS snapshot back to an older Core version', async () => {
    harness.snapshot = {
      status: 'ready',
      snapshot: { ...active.snapshot!, snapshot_id: 'snap-3', version: 3 },
    };
    harness.cached = [managedCached];
    await ensureKnowledgeLlmBindings([instance], options(), logger());
    expect(harness.sets[0]).toMatchObject({
      enabled: false,
      unavailable_reason: 'version_mismatch',
    });
  });
});
