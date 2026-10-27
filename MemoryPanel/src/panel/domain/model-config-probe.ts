/**
 * 未保存模型配置的连通性探针（Panel 服务端执行）。
 *
 * 设计要点（对应 task-sgus3hqpxx）：
 *   1. 三条能力互相独立：basic / json / tools，各自返回状态、耗时与关联 test_id；
 *      tools 是**真实的两轮续接**（assistant.tool_calls → role=tool 结果 → 最终文本）。
 *   2. 只读：探针不写 store、不启用配置、不触发知识生成。
 *   3. 不跟随重定向（`redirect: "manual"`），因此跨源重定向一律被拒绝，
 *      不会把鉴权头转发到别的 origin。
 *   4. 错误脱敏：上游错误正文只取一条消息、截断、剔除 Key/Bearer 片段，
 *      响应体有硬上限，绝不把无界正文或请求头写回前端/日志。
 *   5. 取消：调用方传入的 AbortSignal 会直接中止 fetch，服务端请求随之终止。
 */

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

export const MODEL_PROBE_CAPABILITIES = ['basic', 'json', 'tools'] as const;

export type ModelProbeCapability = (typeof MODEL_PROBE_CAPABILITIES)[number];

export type ModelProbeStatus = 'passed' | 'failed' | 'cancelled';

export type ModelProbeErrorCode =
  | 'ENDPOINT_INVALID'
  | 'ENDPOINT_NOT_ALLOWED'
  | 'REDIRECT_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'JSON_INVALID'
  | 'TOOL_CALL_UNSUPPORTED'
  | 'TOOL_CONTINUATION_FAILED'
  | 'RESPONSE_TOO_LARGE';

export interface ModelProbeError {
  code: ModelProbeErrorCode;
  message: string;
  http_status?: number;
}

export interface ModelProbeCapabilityResult {
  capability: ModelProbeCapability;
  status: ModelProbeStatus;
  duration_ms: number;
  error?: ModelProbeError;
}

export type ModelProbeEvent =
  | {
      type: 'started';
      test_id: string;
      capabilities: readonly ModelProbeCapability[];
    }
  | ({ type: 'result'; test_id: string } & ModelProbeCapabilityResult)
  | {
      type: 'done';
      test_id: string;
      status: 'completed' | 'failed' | 'cancelled';
      duration_ms: number;
    };

export interface ModelProbeRunOutcome {
  testId: string;
  status: 'completed' | 'failed' | 'cancelled';
  durationMs: number;
  results: ModelProbeCapabilityResult[];
}

/** 上游响应体硬上限：超出即中止读取并返回 RESPONSE_TOO_LARGE。 */
export const MAX_UPSTREAM_BODY_BYTES = 128 * 1024;

/** 单个能力允许回传给前端的最长上游错误消息。 */
const MAX_ERROR_MESSAGE_CHARS = 200;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class ModelProbeFailure extends Error {
  constructor(readonly detail: ModelProbeError) {
    super(detail.message);
    this.name = 'ModelProbeFailure';
  }
}

export function isModelProbeFailure(value: unknown): value is ModelProbeFailure {
  return value instanceof ModelProbeFailure;
}

/**
 * 把用户填写的 Base URL 规范成 Chat Completions 端点。
 *
 * 只允许 https；http 仅限**显式开启的 loopback**（本地确定性 fixture）。
 * 拒绝 URL 内嵌凭据、查询串与片段，避免 Key 出现在日志/错误里。
 */
export function resolveChatCompletionsUrl(
  rawBaseUrl: string,
  opts: { allowLoopback: boolean },
): URL {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new ModelProbeFailure({ code: 'ENDPOINT_INVALID', message: 'Base URL is empty.' });
  }
  const withPath = /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`;
  let url: URL;
  try {
    url = new URL(withPath);
  } catch {
    throw new ModelProbeFailure({
      code: 'ENDPOINT_INVALID',
      message: 'Base URL must be an absolute URL.',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ModelProbeFailure({
      code: 'ENDPOINT_NOT_ALLOWED',
      message: 'Only http(s) endpoints are supported.',
    });
  }
  if (url.username || url.password) {
    throw new ModelProbeFailure({
      code: 'ENDPOINT_NOT_ALLOWED',
      message: 'Credentials embedded in the URL are not allowed.',
    });
  }
  if (url.search || url.hash) {
    throw new ModelProbeFailure({
      code: 'ENDPOINT_NOT_ALLOWED',
      message: 'Query strings and fragments are not allowed in the base URL.',
    });
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    if (!opts.allowLoopback || !LOOPBACK_HOSTS.has(host)) {
      throw new ModelProbeFailure({
        code: 'ENDPOINT_NOT_ALLOWED',
        message: 'Plain http endpoints are only allowed for loopback test fixtures.',
      });
    }
  }
  return url;
}

/** 上游错误消息脱敏：剔除密钥片段、折叠空白、截断长度。 */
export function sanitizeUpstreamMessage(
  raw: unknown,
  secrets: readonly string[] = [],
  limit = MAX_ERROR_MESSAGE_CHARS,
): string {
  if (typeof raw !== 'string' || !raw) return '';
  let out = raw;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > limit) out = `${out.slice(0, limit)}…`;
  return out;
}

interface ChatCallOptions {
  url: URL;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetchImpl: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface ChatPayload {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: string;
}

async function readBoundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ModelProbeFailure({
        code: 'RESPONSE_TOO_LARGE',
        message: `Upstream response exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes.`,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractUpstreamMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const rec = payload as Record<string, unknown>;
  const error = rec.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  return typeof rec.message === 'string' ? rec.message : '';
}

function classifyHttpError(
  status: number,
  payload: unknown,
  apiKey: string,
): ModelProbeFailure {
  const detail = sanitizeUpstreamMessage(extractUpstreamMessage(payload), [apiKey]);
  const suffix = detail ? ` ${detail}` : '';
  if (status === 401 || status === 403) {
    return new ModelProbeFailure({
      code: 'AUTH_FAILED',
      message: `Upstream rejected the API key (HTTP ${status}).${suffix}`,
      http_status: status,
    });
  }
  if (status === 404) {
    return new ModelProbeFailure({
      code: 'MODEL_NOT_FOUND',
      message: `Model or endpoint not found (HTTP 404).${suffix}`,
      http_status: status,
    });
  }
  if (status === 429) {
    return new ModelProbeFailure({
      code: 'RATE_LIMITED',
      message: `Upstream rate limited the request (HTTP 429).${suffix}`,
      http_status: status,
    });
  }
  if (status === 408 || status === 504) {
    return new ModelProbeFailure({
      code: 'TIMEOUT',
      message: `Upstream timed out (HTTP ${status}).${suffix}`,
      http_status: status,
    });
  }
  if (status === 400 || status === 422) {
    return new ModelProbeFailure({
      code: 'CAPABILITY_UNSUPPORTED',
      message: `Upstream rejected this request shape (HTTP ${status}).${suffix}`,
      http_status: status,
    });
  }
  return new ModelProbeFailure({
    code: 'UPSTREAM_ERROR',
    message: `Upstream returned HTTP ${status}.${suffix}`,
    http_status: status,
  });
}

async function callChatCompletions(
  opts: ChatCallOptions,
  payload: ChatPayload,
): Promise<Record<string, unknown>> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, opts.timeoutMs);
  const combinedSignal = opts.signal
    ? AbortSignal.any([timeoutController.signal, opts.signal])
    : timeoutController.signal;

  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
      redirect: 'manual',
      signal: combinedSignal,
    });
  } catch (err) {
    if (timedOut) {
      throw new ModelProbeFailure({
        code: 'TIMEOUT',
        message: `Upstream did not respond within ${opts.timeoutMs} ms.`,
      });
    }
    if (opts.signal?.aborted) {
      throw new ModelProbeFailure({ code: 'CANCELLED', message: 'Test cancelled.' });
    }
    const raw = err instanceof Error ? err.message : String(err);
    throw new ModelProbeFailure({
      code: 'NETWORK_ERROR',
      message: `Network request failed. ${sanitizeUpstreamMessage(raw, [opts.apiKey])}`.trim(),
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ModelProbeFailure({
      code: 'REDIRECT_NOT_ALLOWED',
      message: `Upstream tried to redirect (HTTP ${res.status}); redirects are not followed.`,
      http_status: res.status,
    });
  }

  const text = await readBoundedText(res);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw classifyHttpError(res.status, parsed, opts.apiKey);
  if (!parsed || typeof parsed !== 'object') {
    throw new ModelProbeFailure({
      code: 'INVALID_RESPONSE',
      message: 'Upstream did not return a JSON object.',
      http_status: res.status,
    });
  }
  return parsed as Record<string, unknown>;
}

interface AssistantMessage {
  content: string;
  toolCalls: Array<{ id: string; name: string }>;
  rawToolCalls: unknown;
}

function readAssistantMessage(payload: Record<string, unknown>): AssistantMessage {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelProbeFailure({
      code: 'INVALID_RESPONSE',
      message: 'Upstream response has no choices.',
    });
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message;
  if (!message || typeof message !== 'object') {
    throw new ModelProbeFailure({
      code: 'INVALID_RESPONSE',
      message: 'Upstream response has no assistant message.',
    });
  }
  const rec = message as Record<string, unknown>;
  const toolCallsRaw = rec.tool_calls;
  const toolCalls: Array<{ id: string; name: string }> = [];
  if (Array.isArray(toolCallsRaw)) {
    for (const item of toolCallsRaw) {
      if (!item || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      const fn = call.function;
      const name = fn && typeof fn === 'object'
        ? (fn as Record<string, unknown>).name
        : undefined;
      const id = call.id;
      if (typeof name === 'string' && typeof id === 'string') {
        toolCalls.push({ id, name });
      }
    }
  }
  const content = typeof rec.content === 'string' ? rec.content : '';
  return { content, toolCalls, rawToolCalls: toolCallsRaw };
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

async function runBasicProbe(opts: ChatCallOptions, modelId: string): Promise<void> {
  const payload = await callChatCompletions(opts, {
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
    max_tokens: 16,
    temperature: 0,
  });
  const message = readAssistantMessage(payload);
  if (!message.content.trim()) {
    throw new ModelProbeFailure({
      code: 'INVALID_RESPONSE',
      message: 'Model returned no assistant text.',
    });
  }
}

async function runJsonProbe(opts: ChatCallOptions, modelId: string): Promise<void> {
  const payload = await callChatCompletions(opts, {
    model: modelId,
    messages: [
      {
        role: 'system',
        content: 'You respond with a single JSON object and nothing else.',
      },
      {
        role: 'user',
        content: 'Return exactly this JSON object: {"probe":"ok","value":42}',
      },
    ],
    max_tokens: 64,
    temperature: 0,
  });
  const message = readAssistantMessage(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(message.content));
  } catch {
    throw new ModelProbeFailure({
      code: 'JSON_INVALID',
      message: 'Model output was not parseable JSON.',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelProbeFailure({
      code: 'JSON_INVALID',
      message: 'Model output was not a JSON object.',
    });
  }
  if ((parsed as Record<string, unknown>).probe !== 'ok') {
    throw new ModelProbeFailure({
      code: 'JSON_INVALID',
      message: 'Model did not echo the requested JSON payload.',
    });
  }
}

const PROBE_TOOL_NAME = 'get_probe_nonce';

function probeTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: PROBE_TOOL_NAME,
      description: 'Return the current probe nonce.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

async function runToolsProbe(opts: ChatCallOptions, modelId: string): Promise<void> {
  const nonce = createHash('sha256')
    .update(`${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
  const tools = [probeTool()];
  const userTurn: ChatMessage = {
    role: 'user',
    content: 'Call the get_probe_nonce tool, then reply with the nonce it returns.',
  };

  const first = await callChatCompletions(opts, {
    model: modelId,
    messages: [userTurn],
    tools,
    tool_choice: 'auto',
    max_tokens: 128,
    temperature: 0,
  });
  const firstMessage = readAssistantMessage(first);
  const call = firstMessage.toolCalls.find((item) => item.name === PROBE_TOOL_NAME);
  if (!call) {
    throw new ModelProbeFailure({
      code: 'TOOL_CALL_UNSUPPORTED',
      message: 'Model did not emit the requested tool call.',
    });
  }

  const second = await callChatCompletions(opts, {
    model: modelId,
    messages: [
      userTurn,
      {
        role: 'assistant',
        content: firstMessage.content || null,
        tool_calls: firstMessage.rawToolCalls,
      },
      {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ nonce }),
      },
    ],
    tools,
    tool_choice: 'auto',
    max_tokens: 128,
    temperature: 0,
  });
  const finalMessage = readAssistantMessage(second);
  if (!finalMessage.content.includes(nonce)) {
    throw new ModelProbeFailure({
      code: 'TOOL_CONTINUATION_FAILED',
      message: 'Model did not use the tool result in the follow-up turn.',
    });
  }
}

async function runCapability(
  capability: ModelProbeCapability,
  opts: ChatCallOptions,
  modelId: string,
): Promise<void> {
  if (capability === 'basic') return runBasicProbe(opts, modelId);
  if (capability === 'json') return runJsonProbe(opts, modelId);
  return runToolsProbe(opts, modelId);
}

export interface ModelProbeRunOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  allowLoopback: boolean;
  signal?: AbortSignal | undefined;
  testId?: string;
  fetchImpl?: typeof fetch;
  onEvent?: (event: ModelProbeEvent) => void;
}

function cancelledResult(capability: ModelProbeCapability): ModelProbeCapabilityResult {
  return {
    capability,
    status: 'cancelled',
    duration_ms: 0,
    error: { code: 'CANCELLED', message: 'Test cancelled.' },
  };
}

/**
 * 顺序执行三条能力探针。任何一条失败都不会影响其余两条（"三项独立结果"）。
 *
 * 取消语义：一旦收到取消信号，当前能力标记 cancelled，剩余能力直接标记 cancelled
 * 并停止发起新请求 —— 保证不会出现"取消后仍在探测"的窗口。
 */
export async function runModelConfigProbes(
  opts: ModelProbeRunOptions,
): Promise<ModelProbeRunOutcome> {
  const testId = opts.testId ?? `mct_${ulid()}`;
  const startedAt = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const results: ModelProbeCapabilityResult[] = [];
  const emit = (event: ModelProbeEvent): void => {
    opts.onEvent?.(event);
  };

  emit({ type: 'started', test_id: testId, capabilities: MODEL_PROBE_CAPABILITIES });

  let url: URL;
  try {
    url = resolveChatCompletionsUrl(opts.baseUrl, { allowLoopback: opts.allowLoopback });
  } catch (err) {
    const detail = isModelProbeFailure(err)
      ? err.detail
      : { code: 'ENDPOINT_INVALID' as const, message: 'Base URL is not usable.' };
    for (const capability of MODEL_PROBE_CAPABILITIES) {
      const result: ModelProbeCapabilityResult = {
        capability,
        status: 'failed',
        duration_ms: 0,
        error: detail,
      };
      results.push(result);
      emit({ type: 'result', test_id: testId, ...result });
    }
    const durationMs = Date.now() - startedAt;
    emit({ type: 'done', test_id: testId, status: 'failed', duration_ms: durationMs });
    return { testId, status: 'failed', durationMs, results };
  }

  const callOptions: ChatCallOptions = {
    url,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    fetchImpl,
  };

  let cancelled = opts.signal?.aborted === true;
  for (const capability of MODEL_PROBE_CAPABILITIES) {
    if (cancelled) {
      const result = cancelledResult(capability);
      results.push(result);
      emit({ type: 'result', test_id: testId, ...result });
      continue;
    }
    const capabilityStartedAt = Date.now();
    let result: ModelProbeCapabilityResult;
    try {
      await runCapability(capability, callOptions, opts.modelId);
      result = {
        capability,
        status: 'passed',
        duration_ms: Date.now() - capabilityStartedAt,
      };
    } catch (err) {
      const detail: ModelProbeError = isModelProbeFailure(err)
        ? err.detail
        : {
            code: 'UPSTREAM_ERROR',
            message: sanitizeUpstreamMessage(
              err instanceof Error ? err.message : String(err),
              [opts.apiKey],
            ) || 'Probe failed unexpectedly.',
          };
      if (detail.code === 'CANCELLED') cancelled = true;
      result = {
        capability,
        status: detail.code === 'CANCELLED' ? 'cancelled' : 'failed',
        duration_ms: Date.now() - capabilityStartedAt,
        error: detail,
      };
    }
    results.push(result);
    emit({ type: 'result', test_id: testId, ...result });
  }

  const status: 'completed' | 'failed' | 'cancelled' = cancelled
    ? 'cancelled'
    : results.some((item) => item.status === 'failed')
      ? 'failed'
      : 'completed';
  const durationMs = Date.now() - startedAt;
  emit({ type: 'done', test_id: testId, status, duration_ms: durationMs });
  return { testId, status, durationMs, results };
}

// ── 配置指纹与并发去重 ──

export interface FingerprintInput {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

/**
 * 连接配置指纹（**必须与 Core 的 modelConfigFingerprint 逐位一致**）。
 *
 * 只覆盖连接相关字段：provider / base_url / model_id / Key 摘要。
 * 刻意**不包含** version、description、instance：
 *   - 改备注只动 version，不应让已通过的测试失效；
 *   - 任何连接字段变化都会改变指纹，从而立即作废旧测试。
 * 实例绑定由"测试证据存放在该实例的 extraction 行"保证，不需要进指纹。
 */
export function configFingerprint(input: FingerprintInput): string {
  const keyDigest = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
  const material = [
    input.provider,
    input.baseUrl.replace(/\/+$/, ''),
    input.modelId,
    keyDigest,
  ].join('\n');
  return `sha256:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

const activeRuns = new Map<string, string>();

/** 同一 key 只允许一个进行中的探针；返回 null 表示已有进行中的测试。 */
export function beginModelProbeRun(key: string): string | null {
  if (activeRuns.has(key)) return null;
  const token = ulid();
  activeRuns.set(key, token);
  return token;
}

export function endModelProbeRun(key: string, token: string): void {
  if (activeRuns.get(key) === token) activeRuns.delete(key);
}

/** 仅供测试：清空进行中登记。 */
export function resetModelProbeRunsForTests(): void {
  activeRuns.clear();
}
