import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODEL_PROBE_CAPABILITIES,
  beginModelProbeRun,
  configFingerprint,
  endModelProbeRun,
  resetModelProbeRunsForTests,
  resolveChatCompletionsUrl,
  runModelConfigProbes,
  sanitizeUpstreamMessage,
  type ModelProbeEvent,
} from '../src/panel/domain/model-config-probe.js';

type Scenario =
  | 'ok'
  | 'auth-401'
  | 'model-404'
  | 'rate-429'
  | 'tool-unsupported'
  | 'tool-continuation-bad'
  | 'basic-empty'
  | 'json-invalid'
  | 'slow'
  | 'redirect'
  | 'huge';

interface FixtureRequest {
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface ChatFixture {
  server: Server;
  baseUrl: string;
  requests: FixtureRequest[];
  abortedCount: () => number;
  scenario: { value: Scenario };
  close: () => Promise<void>;
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

function assistant(content: string): Record<string, unknown> {
  return { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

/** 确定性 OpenAI 兼容服务 fixture：断言 endpoint / 鉴权 / model / messages / tools。 */
async function startChatFixture(): Promise<ChatFixture> {
  const requests: FixtureRequest[] = [];
  const scenario = { value: 'ok' as Scenario };
  let aborted = 0;

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    requests.push({ url: req.url, headers: req.headers, body });

    const onAbort = () => { aborted += 1; };
    req.on('aborted', onAbort);
    res.on('close', () => {
      if (!res.writableFinished) onAbort();
    });

    if (scenario.value === 'slow') {
      // 故意不响应：由被测方的 timeout / abort 终止连接。
      return;
    }
    if (scenario.value === 'huge') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(`{"choices":"${'x'.repeat(200_000)}"}`);
      return;
    }
    if (scenario.value === 'redirect') {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/steal');
      res.end();
      return;
    }
    if (scenario.value === 'auth-401') return json(res, 401, { error: { message: 'invalid api key sk-live-SECRETVALUE' } });
    if (scenario.value === 'model-404') return json(res, 404, { error: { message: 'The model `probe-model` does not exist' } });
    if (scenario.value === 'rate-429') return json(res, 429, { error: { message: 'rate limit exceeded' } });

    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    const last = messages[messages.length - 1] ?? {};
    const hasTools = Array.isArray(body.tools);
    const lastRole = last.role;
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content ?? ''))
      .join(' ');

    if (lastRole === 'tool') {
      const toolContent = String(last.content ?? '');
      const nonce = (JSON.parse(toolContent) as { nonce?: string }).nonce ?? '';
      if (scenario.value === 'tool-continuation-bad') {
        return json(res, 200, assistant('I could not use the tool result.'));
      }
      return json(res, 200, assistant(`The nonce is ${nonce}.`));
    }

    if (hasTools) {
      if (scenario.value === 'tool-unsupported') {
        return json(res, 200, assistant('ok'));
      }
      return json(res, 200, {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_probe_1',
                  type: 'function',
                  function: { name: 'get_probe_nonce', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }

    if (systemText.toLowerCase().includes('json')) {
      if (scenario.value === 'json-invalid') return json(res, 200, assistant('not json at all'));
      return json(res, 200, assistant('{"probe":"ok","value":42}'));
    }

    if (scenario.value === 'basic-empty') return json(res, 200, assistant(''));
    return json(res, 200, assistant('ok'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    abortedCount: () => aborted,
    scenario,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let fixture: ChatFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  resetModelProbeRunsForTests();
});

function collect(events: ModelProbeEvent[]): (event: ModelProbeEvent) => void {
  return (event) => { events.push(event); };
}

async function run(scenario: Scenario, extra: Partial<Parameters<typeof runModelConfigProbes>[0]> = {}) {
  fixture = await startChatFixture();
  fixture.scenario.value = scenario;
  const events: ModelProbeEvent[] = [];
  const outcome = await runModelConfigProbes({
    baseUrl: fixture.baseUrl,
    apiKey: 'sk-test-key-value',
    modelId: 'probe-model',
    timeoutMs: 1_000,
    allowLoopback: true,
    onEvent: collect(events),
    ...extra,
  });
  return { fixture, events, outcome };
}

describe('model config probe endpoint safety', () => {
  it.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions'],
  ])('normalizes %s', (input, expected) => {
    expect(resolveChatCompletionsUrl(input, { allowLoopback: false }).toString()).toBe(expected);
  });

  it.each([
    ['file:///etc/passwd', 'ENDPOINT_NOT_ALLOWED'],
    ['gopher://example.com/x', 'ENDPOINT_NOT_ALLOWED'],
    ['https://user:pass@example.com/v1', 'ENDPOINT_NOT_ALLOWED'],
    ['https://example.com/v1?token=abc', 'ENDPOINT_NOT_ALLOWED'],
    ['https://example.com/v1#frag', 'ENDPOINT_NOT_ALLOWED'],
    ['http://10.0.0.5/v1', 'ENDPOINT_NOT_ALLOWED'],
    ['api.deepseek.com', 'ENDPOINT_INVALID'],
    ['', 'ENDPOINT_INVALID'],
  ])('rejects %s', (input, code) => {
    expect(() => resolveChatCompletionsUrl(input, { allowLoopback: false })).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ code }) }),
    );
  });

  it('allows http loopback only when explicitly enabled', () => {
    expect(() => resolveChatCompletionsUrl('http://127.0.0.1:9999/v1', { allowLoopback: false }))
      .toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: 'ENDPOINT_NOT_ALLOWED' }) }));
    expect(resolveChatCompletionsUrl('http://127.0.0.1:9999/v1', { allowLoopback: true }).toString())
      .toBe('http://127.0.0.1:9999/v1/chat/completions');
  });

  it('does not raise the loopback exemption for other private ranges', () => {
    expect(() => resolveChatCompletionsUrl('http://192.168.1.10/v1', { allowLoopback: true }))
      .toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: 'ENDPOINT_NOT_ALLOWED' }) }));
  });
});

describe('upstream message sanitization', () => {
  it('strips keys and bearer fragments and bounds length', () => {
    const raw = `bad key sk-test-key-value and Bearer abc.def.ghi\n\n${'z'.repeat(400)}`;
    const out = sanitizeUpstreamMessage(raw, ['sk-test-key-value']);
    expect(out).not.toContain('sk-test-key-value');
    expect(out).not.toContain('abc.def.ghi');
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out).not.toContain('\n');
  });
});

describe('model config probes', () => {
  it('runs basic, json and a real tool-result continuation against the fixture', async () => {
    const { fixture: fx, events, outcome } = await run('ok');

    expect(outcome.status).toBe('completed');
    expect(outcome.results.map((r) => `${r.capability}:${r.status}`)).toEqual([
      'basic:passed',
      'json:passed',
      'tools:passed',
    ]);
    expect(outcome.results.every((r) => r.duration_ms >= 0)).toBe(true);

    expect(events[0]).toMatchObject({ type: 'started', capabilities: [...MODEL_PROBE_CAPABILITIES] });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(events.filter((e) => e.type === 'result')).toHaveLength(3);
    expect(new Set(events.map((e) => 'test_id' in e ? e.test_id : '')).size).toBe(1);

    // fixture 断言：endpoint / 鉴权存在性 / model / messages / 工具续轮
    expect(fx.requests).toHaveLength(4); // basic, json, tools(1), tools(2)
    for (const req of fx.requests) {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer sk-test-key-value');
      expect(req.body.model).toBe('probe-model');
      expect(Array.isArray(req.body.messages)).toBe(true);
    }
    const toolFirst = fx.requests[2];
    expect(toolFirst?.body.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_probe_nonce' }) }),
    ]);
    const toolSecond = fx.requests[3];
    const messages = toolSecond?.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[2]?.tool_call_id).toBe('call_probe_1');
    expect(String(messages[2]?.content)).toContain('nonce');
  });

  it('reports auth failures without leaking the key', async () => {
    const { events, outcome } = await run('auth-401');
    expect(outcome.status).toBe('failed');
    expect(outcome.results.every((r) => r.error?.code === 'AUTH_FAILED')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-test-key-value');
    expect(serialized).not.toContain('SECRETVALUE');
  });

  it.each([
    ['model-404', 0, 'MODEL_NOT_FOUND'],
    ['rate-429', 0, 'RATE_LIMITED'],
    ['basic-empty', 0, 'INVALID_RESPONSE'],
    ['json-invalid', 1, 'JSON_INVALID'],
  ] as const)('classifies %s as %s', async (scenario, index, code) => {
    const { outcome } = await run(scenario);
    expect(outcome.status).toBe('failed');
    expect(outcome.results[index]?.error?.code).toBe(code);
  });

  it('keeps capabilities independent when the model cannot call tools', async () => {
    const { outcome } = await run('tool-unsupported');
    expect(outcome.results.map((r) => `${r.capability}:${r.status}`)).toEqual([
      'basic:passed',
      'json:passed',
      'tools:failed',
    ]);
    expect(outcome.results[2]?.error?.code).toBe('TOOL_CALL_UNSUPPORTED');
    expect(outcome.status).toBe('failed');
  });

  it('fails the tool capability when the follow-up turn ignores the tool result', async () => {
    const { outcome } = await run('tool-continuation-bad');
    expect(outcome.results[2]?.error?.code).toBe('TOOL_CONTINUATION_FAILED');
  });

  it('times out without hanging the run', async () => {
    const { outcome } = await run('slow', { timeoutMs: 120 });
    expect(outcome.results[0]?.error?.code).toBe('TIMEOUT');
    expect(outcome.status).toBe('failed');
  });

  it('refuses to follow redirects', async () => {
    const { outcome } = await run('redirect');
    expect(outcome.results[0]?.error?.code).toBe('REDIRECT_NOT_ALLOWED');
    expect(outcome.status).toBe('failed');
  });

  it('bounds upstream response bodies', async () => {
    const { outcome } = await run('huge');
    expect(outcome.results[0]?.error?.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('aborts the in-flight upstream request when cancelled', async () => {
    fixture = await startChatFixture();
    fixture.scenario.value = 'slow';
    const controller = new AbortController();
    const events: ModelProbeEvent[] = [];
    const promise = runModelConfigProbes({
      baseUrl: fixture.baseUrl,
      apiKey: 'sk-test-key',
      modelId: 'probe-model',
      timeoutMs: 5_000,
      allowLoopback: true,
      signal: controller.signal,
      onEvent: collect(events),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const outcome = await promise;

    expect(outcome.status).toBe('cancelled');
    expect(outcome.results.every((r) => r.status === 'cancelled')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
    expect(fixture.requests).toHaveLength(1);
    // 服务端连接关闭事件可能略晚于客户端 abort 传播，轮询一小段时间。
    for (let i = 0; i < 40 && fixture.abortedCount() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fixture.abortedCount()).toBeGreaterThan(0);
  });

  it('does not start later capabilities after cancellation', async () => {
    const { events } = await run('ok');
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(MODEL_PROBE_CAPABILITIES).toEqual(resultEvents.map((e) => (e as { capability: string }).capability));
  });
});

describe('config fingerprint and run dedupe', () => {
  const base = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    apiKey: 'sk-test',
  };

  it('matches the canonical vector shared with Core', () => {
    // 与 MemoryCore/src/metadata/service/model-config-fingerprint.test.ts 同一向量。
    expect(configFingerprint(base)).toBe('sha256:0f4a34ca2735badd');
  });

  it('binds results to connection fields only', () => {
    const one = configFingerprint(base);
    expect(one).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(configFingerprint({ ...base })).toBe(one);
    expect(configFingerprint({ ...base, baseUrl: 'https://api.deepseek.com/' })).toBe(one);
    expect(configFingerprint({ ...base, provider: 'glm' })).not.toBe(one);
    expect(configFingerprint({ ...base, modelId: 'deepseek-reasoner' })).not.toBe(one);
    expect(configFingerprint({ ...base, apiKey: 'sk-other' })).not.toBe(one);
    expect(configFingerprint(base)).not.toContain('sk-test');
  });

  it('rejects a concurrent run for the same key', () => {
    const token = beginModelProbeRun('inst-a:user-1');
    expect(token).toBeTruthy();
    expect(beginModelProbeRun('inst-a:user-1')).toBeNull();
    expect(beginModelProbeRun('inst-a:user-2')).toBeTruthy();
    endModelProbeRun('inst-a:user-1', token!);
    expect(beginModelProbeRun('inst-a:user-1')).toBeTruthy();
  });
});
