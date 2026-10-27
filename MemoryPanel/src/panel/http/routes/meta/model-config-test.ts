/**
 * 未保存模型配置的连通性测试端点。
 *
 *   POST /api/v1/meta/instance-upstream/extraction/test
 *
 * 与其它 meta 转发不同，这里由 Panel 自己执行探针：只有 Panel 进程能在**不把
 * 明文 Key 下发给浏览器**的前提下，拿到"表单未填 Key 时复用服务端已存 Key"的能力。
 * 明文 Key 只通过 Bearer-only 的内部路由
 * `/v3/internal/meta/instance-upstream/extraction/resolve` 在服务间传递。
 *
 * 安全边界：
 *   - 只有 system_admin 可调用；实例身份来自已经校验过的 Panel Header，跨实例无从选择。
 *   - 只读：不写 store、不改 draft/active、不启用、不触发知识生成。
 *   - 结果流绑定配置指纹（含 Key 摘要），不构成任何后续写权限。
 *   - 客户端断开（取消）会 abort 服务端 fetch，上游请求随之终止。
 */

import type { Context } from 'hono';
import { ulid } from 'ulid';
import type { PanelDeps } from '../../../panel-deps.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import { executeMetaFetch } from '../../../kernel/transport-fetch.js';
import { respondControlError } from '../../envelope.js';
import {
  MODEL_PROBE_CAPABILITIES,
  beginModelProbeRun,
  configFingerprint,
  endModelProbeRun,
  runModelConfigProbes,
  type ModelProbeEvent,
} from '../../../domain/model-config-probe.js';

const RESOLVE_PATH = '/v3/internal/meta/instance-upstream/extraction/resolve';
const TEST_RESULT_PATH = '/v3/internal/meta/instance-upstream/extraction/test-result';
const SUPPORTED_PROVIDERS = new Set(['glm', 'deepseek', 'openai-compatible']);

interface ResolvedEndpointConfig {
  provider: string;
  base_url: string;
  api_key: string;
  model_id: string;
  description: string;
}

interface ResolvedExtractionConfig {
  source: 'deployment' | 'panel';
  config_id: string | null;
  version: number;
  enabled: boolean | null;
  updated_at: string | null;
  draft_present: boolean;
  active: ResolvedEndpointConfig | null;
  draft: ResolvedEndpointConfig | null;
}

export function toMetaContext(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

/**
 * 一次 auth/verify 同时拿到"是否 system_admin"和调用者 id（并发去重键的一部分）。
 * 与 knowledge/common.ts 的 isCallerSystemAdmin 同口径，只是多返回 user_id。
 */
export async function verifyAdminCaller(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<{ userId: string } | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return null;
  const data = env.data as
    | { valid?: boolean; user?: { user_type?: string; user_id?: string } }
    | null;
  if (data?.valid !== true || data.user?.user_type !== 'system_admin') return null;
  const userId = typeof data.user.user_id === 'string' ? data.user.user_id : '';
  return { userId: userId || ctx.userKey.slice(0, 12) };
}

export async function resolveStoredExtraction(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<ResolvedExtractionConfig | null> {
  const env = await executeMetaFetch<MetaEnvelope<ResolvedExtractionConfig>>(
    {
      endpoint: ctx.gatewayEndpoint,
      apiKey: ctx.gatewayApiKey,
      serviceId: ctx.instanceId,
      timeoutMs: deps.config.metadataRemoteTimeoutMs,
      requestId: ctx.reqId,
      logger: deps.logger,
    },
    RESOLVE_PATH,
    {},
    'envelope',
  );
  if (env.code !== 0 || !env.data) return null;
  return env.data;
}

async function recordTestResult(
  deps: PanelDeps,
  ctx: MetaCallContext,
  payload: {
    test_id: string;
    provider: string;
    base_url: string;
    model_id: string;
    api_key?: string | undefined;
    passed: boolean;
    capabilities: Record<string, string>;
  },
): Promise<void> {
  try {
    const env = await executeMetaFetch<MetaEnvelope<unknown>>(
      {
        endpoint: ctx.gatewayEndpoint,
        apiKey: ctx.gatewayApiKey,
        serviceId: ctx.instanceId,
        timeoutMs: deps.config.metadataRemoteTimeoutMs,
        requestId: ctx.reqId,
        logger: deps.logger,
      },
      TEST_RESULT_PATH,
      payload,
      'envelope',
    );
    if (env.code !== 0) {
      deps.logger.warn('model config test evidence was not recorded', {
        instanceId: ctx.instanceId,
        testId: payload.test_id,
        code: env.code,
      });
    }
  } catch (err) {
    // 证据写入失败不能影响用户已经看到的测试结果；启用时会被要求重新测试。
    deps.logger.warn('model config test evidence request failed', {
      instanceId: ctx.instanceId,
      testId: payload.test_id,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

interface ParsedTestRequest {
  provider: string;
  baseUrl: string;
  modelId: string;
  submittedKey: string;
  baseVersion: number | undefined;
}

function parseTestRequest(body: Record<string, unknown>): ParsedTestRequest | null {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  if (!provider || !SUPPORTED_PROVIDERS.has(provider)) return null;
  if (!baseUrl || !modelId) return null;
  const submittedKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const baseVersion =
    typeof body.base_version === 'number' && Number.isInteger(body.base_version) && body.base_version >= 0
      ? body.base_version
      : undefined;
  return { provider, baseUrl, modelId, submittedKey, baseVersion };
}

export async function handleModelConfigTest(c: Context, deps: PanelDeps): Promise<Response> {
  const ctx = toMetaContext(c);

  const caller = await verifyAdminCaller(deps, ctx);
  if (!caller) return respondControlError(c, 403, 'PERMISSION_DENIED');

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return respondControlError(c, 400, 'INVALID_TEST_CONFIG');
  }
  const parsed = parseTestRequest(raw ?? {});
  if (!parsed) return respondControlError(c, 400, 'INVALID_TEST_CONFIG');

  const resolved = await resolveStoredExtraction(deps, ctx);
  if (!resolved) return respondControlError(c, 502, 'CONFIG_RESOLVE_FAILED');

  if (parsed.baseVersion !== undefined && parsed.baseVersion !== resolved.version) {
    return c.json(
      {
        code: 409,
        message: 'CONFIG_VERSION_CONFLICT',
        request_id: ctx.reqId ?? '',
        data: { expected: parsed.baseVersion, actual: resolved.version },
      },
      409,
    );
  }

  // 表单留空 → 复用服务端已保存的 Key（草稿是编辑态的来源，优先于 active）。
  const effectiveKey = parsed.submittedKey || resolved.draft?.api_key || resolved.active?.api_key || '';
  if (!effectiveKey) return respondControlError(c, 400, 'MISSING_API_KEY');

  const source: 'deployment' | 'panel' = resolved.draft || resolved.active ? 'panel' : 'deployment';
  // 指纹只覆盖连接字段，且必须与 Core 完全一致 —— 启用时 Core 会用同一算法复核。
  const fingerprint = configFingerprint({
    provider: parsed.provider,
    baseUrl: parsed.baseUrl,
    modelId: parsed.modelId,
    apiKey: effectiveKey,
  });

  const runKey = `${ctx.instanceId}:${caller.userId}`;
  const runToken = beginModelProbeRun(runKey);
  if (!runToken) return respondControlError(c, 409, 'TEST_ALREADY_RUNNING');

  const testId = `mct_${ulid()}`;
  const encoder = new TextEncoder();
  const clientSignal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (event: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by client disconnect */
        }
      };

      void (async () => {
        try {
          const outcome = await runModelConfigProbes({
            baseUrl: parsed.baseUrl,
            apiKey: effectiveKey,
            modelId: parsed.modelId,
            timeoutMs: deps.config.modelTest.timeoutMs,
            allowLoopback: deps.config.modelTest.allowLoopback,
            signal: clientSignal,
            testId,
            onEvent: (event: ModelProbeEvent) => {
              if (event.type === 'started') {
                write({
                  ...event,
                  fingerprint,
                  source,
                  instance_id: ctx.instanceId,
                  capabilities: [...MODEL_PROBE_CAPABILITIES],
                });
                return;
              }
              write(event);
            },
          });
          // 把证据写回该实例的 extraction 行：启用时 Core 会复核 test_id + 指纹 + 过期时间。
          // 取消的测试不记录（用户主动放弃，不应覆盖上一次有效证据）。
          if (outcome.status !== 'cancelled') {
            await recordTestResult(deps, ctx, {
              test_id: outcome.testId,
              provider: parsed.provider,
              base_url: parsed.baseUrl,
              model_id: parsed.modelId,
              api_key: parsed.submittedKey || undefined,
              passed: outcome.status === 'completed',
              capabilities: Object.fromEntries(
                outcome.results.map((item) => [item.capability, item.status]),
              ),
            });
          }
          deps.logger.info('model config probe finished', {
            instanceId: ctx.instanceId,
            testId: outcome.testId,
            status: outcome.status,
            durationMs: outcome.durationMs,
            capabilities: outcome.results.map((item) => `${item.capability}:${item.status}`),
          });
        } catch (err) {
          deps.logger.warn('model config probe crashed', {
            instanceId: ctx.instanceId,
            testId,
            error: err instanceof Error ? err.name : 'unknown',
          });
          write({ type: 'error', test_id: testId, code: 'PROBE_CRASHED', message: 'Probe crashed.' });
        } finally {
          endModelProbeRun(runKey, runToken);
          finish();
        }
      })();
    },
    cancel() {
      // 客户端取消：外部 signal 已由 node-server 在连接关闭时 abort，这里只做兜底清理。
      endModelProbeRun(runKey, runToken);
    },
  });

  return c.body(stream, 200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
}
