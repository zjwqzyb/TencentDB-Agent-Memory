import { afterEach, describe, expect, it, vi } from 'vitest';

// API 基础层会静态引用 i18n；vitest 配置未声明 `@` alias（只在 web/vite.config.ts 里），
// 这里用虚拟模块替身提供同样的最小接口，保证纯逻辑测试可以加载 NDJSON 客户端。
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
    language: 'zh-CN',
    on: () => undefined,
    off: () => undefined,
  },
}));

import { ApiError } from '../web/src/lib/api/base';
import {
  instanceUpstreamApi,
  type ModelTestEvent,
  type TestConfigBody,
} from '../web/src/lib/api/instance-upstream';
import {
  buildTestBody,
  canEnableConfig,
  canRunTest,
  enableBlockedReason,
  formFromConfig,
  type ExtractionConfig,
  type ModelConfigForm,
} from '../web/src/components/model-config/model';

const configured: ExtractionConfig = {
  configured: true,
  managed: true,
  source: 'panel',
  config_id: 'ext-1',
  provider: 'deepseek',
  protocol: 'openai-chat',
  base_url: 'https://api.deepseek.com',
  api_key_configured: true,
  api_key_masked: '••••••••',
  model_id: 'deepseek-chat',
  description: 'primary',
  enabled: false,
  version: 3,
  updated_at: '2026-10-26T00:00:00.000Z',
  draft: null,
};

const form = (over: Partial<ModelConfigForm> = {}): ModelConfigForm => ({
  ...formFromConfig(configured),
  ...over,
});

/** node 环境没有 localStorage，用固定会话替身让 meta Header 注入可断言。 */
function stubPanelSession(): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === 'tdai-panel.session'
        ? JSON.stringify({ instanceId: 'inst-1', userKey: 'user-key-1' })
        : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
}

const started: ModelTestEvent = {
  type: 'started',
  test_id: 'test-1',
  fingerprint: 'abcdef1234567890abcdef',
  source: 'panel',
  instance_id: 'inst-1',
  capabilities: ['basic', 'json', 'tools'],
};
const basicResult: ModelTestEvent = {
  type: 'result',
  test_id: 'test-1',
  capability: 'basic',
  status: 'passed',
  duration_ms: 120,
};
const jsonResult: ModelTestEvent = {
  type: 'result',
  test_id: 'test-1',
  capability: 'json',
  status: 'failed',
  duration_ms: 240,
  error: { code: 'json_output_invalid', message: '模型未返回合法 JSON', http_status: 200 },
};
const toolsResult: ModelTestEvent = {
  type: 'result',
  test_id: 'test-1',
  capability: 'tools',
  status: 'passed',
  duration_ms: 310,
};
const done: ModelTestEvent = {
  type: 'done',
  test_id: 'test-1',
  status: 'failed',
  duration_ms: 670,
};

const payload: TestConfigBody = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model_id: 'deepseek-chat',
  base_version: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model configuration test body', () => {
  it('omits a blank key, keeps a new key and always sends the base version', () => {
    const blankKey = buildTestBody(form({ apiKey: '' }), configured);
    expect(blankKey).toEqual({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      model_id: 'deepseek-chat',
      base_version: 3,
    });
    expect('api_key' in blankKey).toBe(false);

    const withKey = buildTestBody(form({ apiKey: '  sk-new-secret  ' }), configured);
    expect(withKey.api_key).toBe('sk-new-secret');
    expect(withKey.base_version).toBe(3);

    expect(buildTestBody(form({ baseUrl: ' https://api.deepseek.com/ ' }), configured).base_url)
      .toBe('https://api.deepseek.com');
    expect(buildTestBody(form(), undefined).base_version).toBeUndefined();
  });

  it('only allows a test with a model id, a usable base url and an available key', () => {
    expect(canRunTest(formFromConfig(undefined), undefined)).toBe(false);
    expect(canRunTest(form({ modelId: '   ' }), configured)).toBe(false);
    expect(canRunTest(form({ baseUrl: 'not-a-url' }), configured)).toBe(false);
    expect(canRunTest(form({ baseUrl: 'ftp://example.com' }), configured)).toBe(false);
    expect(canRunTest(form({ baseUrl: 'https://user:pass@example.com' }), configured)).toBe(false);
    expect(canRunTest(form({ baseUrl: 'https://api.deepseek.com?x=1' }), configured)).toBe(false);

    const noSavedKey: ExtractionConfig = { ...configured, api_key_configured: false };
    expect(canRunTest(formFromConfig(noSavedKey), noSavedKey)).toBe(false);
    expect(canRunTest({ ...formFromConfig(noSavedKey), apiKey: 'sk-new' }, noSavedKey)).toBe(true);

    expect(canRunTest(form(), configured)).toBe(true);
  });
});

describe('model configuration NDJSON test stream', () => {
  it('parses events split across chunk boundaries and sends one meta POST', async () => {
    stubPanelSession();
    const encoder = new TextEncoder();
    const text = `${[started, basicResult, jsonResult, toolsResult, done]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`;
    const cuts = [5, 41, 97, 183, 260, 355];
    const chunks: string[] = [];
    let cursor = 0;
    for (const cut of cuts) {
      chunks.push(text.slice(cursor, cut));
      cursor = cut;
    }
    chunks.push(text.slice(cursor));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const events: ModelTestEvent[] = [];
    await instanceUpstreamApi.testConfig(payload, { onEvent: (event) => events.push(event) });

    expect(events.map((event) => event.type)).toEqual(['started', 'result', 'result', 'result', 'done']);
    expect(events[0]).toEqual(started);
    expect(events[2]).toEqual(jsonResult);
    expect(events[4]).toEqual(done);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/meta/instance-upstream/extraction/test');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Tdai-Service-Id')).toBe('inst-1');
    expect(headers.get('X-Tdai-User-Key')).toBe('user-key-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it('turns a pre-stream envelope into ApiError with the server message', async () => {
    stubPanelSession();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'TEST_ALREADY_RUNNING', message: '已有测试正在运行，请稍后再试', request_id: 'req-9' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    let caught: unknown;
    try {
      await instanceUpstreamApi.testConfig(payload);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('TEST_ALREADY_RUNNING');
    expect(apiError.message).toBe('已有测试正在运行，请稍后再试');
  });

  it('surfaces abort as AbortError so the caller can converge cancelled capabilities', async () => {
    stubPanelSession();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(started)}\n`));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })));

    const abort = new AbortController();
    const events: ModelTestEvent[] = [];
    const pending = instanceUpstreamApi.testConfig(payload, {
      signal: abort.signal,
      onEvent: (event) => events.push(event),
    });
    for (let attempt = 0; attempt < 50 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events).toHaveLength(1);

    abort.abort();
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(events).toHaveLength(1);
  });
});


describe('enable gating', () => {
  const evidence = {
    test_id: 'mct_evidence',
    fingerprint: 'sha256:0f4a34ca2735badd',
    passed: true,
    tested_at: '2026-10-26T00:00:00.000Z',
    expires_at: '2026-10-26T00:15:00.000Z',
    matches_current: true,
  };
  const withDraft = (over: Partial<ExtractionConfig> = {}): ExtractionConfig => ({
    ...configured,
    draft: {
      configured: true,
      provider: 'deepseek',
      protocol: 'openai-chat',
      base_url: 'https://api.deepseek.com',
      api_key_configured: true,
      model_id: 'deepseek-chat',
      description: '',
      updated_at: '2026-10-26T00:00:00.000Z',
    },
    paused: false,
    active_snapshot: null,
    test: null,
    ...over,
  } as ExtractionConfig);

  it('requires connection-test evidence before enabling', () => {
    expect(enableBlockedReason(withDraft())).toBe('test-required');
    expect(canEnableConfig(withDraft())).toBe(false);
  });

  it('rejects failed, mismatched or stale evidence', () => {
    expect(enableBlockedReason(withDraft({ test: { ...evidence, passed: false } }))).toBe('test-stale');
    expect(enableBlockedReason(withDraft({ test: { ...evidence, matches_current: false } }))).toBe('test-stale');
    expect(canEnableConfig(withDraft({ test: { ...evidence, passed: false } }))).toBe(false);
  });

  it('blocks enabling while the form has unsaved changes', () => {
    const config = withDraft({ test: evidence });
    expect(canEnableConfig(config)).toBe(true);
    expect(enableBlockedReason(config, { dirty: true })).toBe('form-dirty');
    expect(canEnableConfig(config, { dirty: true })).toBe(false);
  });

  it('reports no-draft when there is nothing to enable', () => {
    expect(enableBlockedReason(withDraft({ draft: null }))).toBe('no-draft');
    expect(canEnableConfig(undefined)).toBe(false);
  });
});
