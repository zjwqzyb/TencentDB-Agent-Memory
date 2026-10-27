/**
 * 拉取供应商可用模型列表（供「模型 ID」下拉框使用）。
 *
 *   POST /api/v1/meta/instance-upstream/extraction/models
 *   body: { provider, base_url, api_key? }
 *
 * 与「连接能力测试」共用同一套出站安全约束：仅 https（或显式 loopback）、
 * 不跟随重定向、响应体上限、错误脱敏。表单留空 Key 时复用服务端已存 Key。
 * 只读：不写配置、不下发明文 Key。
 */

import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import { isModelProbeFailure, listChatModels } from '../../../domain/model-config-probe.js';
import { resolveStoredExtraction, toMetaContext, verifyAdminCaller } from './model-config-test.js';

const SUPPORTED_PROVIDERS = new Set(['glm', 'deepseek', 'openai-compatible']);

export async function handleModelConfigModels(c: Context, deps: PanelDeps): Promise<Response> {
  const ctx = toMetaContext(c);

  const caller = await verifyAdminCaller(deps, ctx);
  if (!caller) return respondControlError(c, 403, 'PERMISSION_DENIED');

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return respondControlError(c, 400, 'INVALID_REQUEST');
  }

  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  if (!provider || !SUPPORTED_PROVIDERS.has(provider) || !baseUrl) {
    return respondControlError(c, 400, 'INVALID_REQUEST');
  }

  const submittedKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const resolved = await resolveStoredExtraction(deps, ctx);
  const apiKey = submittedKey || resolved?.draft?.api_key || resolved?.active?.api_key || '';
  if (!apiKey) return respondControlError(c, 400, 'MISSING_API_KEY');

  try {
    const models = await listChatModels({
      baseUrl,
      apiKey,
      timeoutMs: deps.config.modelTest.timeoutMs,
      allowLoopback: deps.config.modelTest.allowLoopback,
      signal: c.req.raw.signal,
    });
    return respondEnvelope(c, {
      code: 0,
      message: 'ok',
      request_id: ctx.reqId ?? '',
      data: { models, count: models.length },
    });
  } catch (err) {
    if (isModelProbeFailure(err)) {
      deps.logger.warn('model list fetch failed', {
        instanceId: ctx.instanceId,
        code: err.detail.code,
        httpStatus: err.detail.http_status ?? null,
      });
      return respondControlError(
        c,
        502,
        `${err.detail.code}: ${err.detail.message}`,
      );
    }
    deps.logger.error('model list fetch crashed', {
      instanceId: ctx.instanceId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return respondControlError(c, 502, 'MODELS_FETCH_FAILED');
  }
}
