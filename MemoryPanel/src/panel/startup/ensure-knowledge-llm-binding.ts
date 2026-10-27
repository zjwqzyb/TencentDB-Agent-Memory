/**
 * Startup hook: reconcile each instance's knowledge-service LLM binding with the
 * Core instance-upstream **active snapshot**.
 *
 * Two provenance classes (see MemoryKnowledge/src/store/llm-binding-store.ts):
 *
 *   - legacy `deployment` bindings keep the 2026-07-07-009 (方案 A') behaviour:
 *     refresh the proxy endpoint, or mint the hidden `knowledge-service` user key
 *     when KS has none. The model still comes from KS's global `LLM_MODEL` env.
 *
 *   - `managed` bindings mirror the Core active snapshot (provider/model/
 *     protocol/config id/version/fingerprint). They are **reconciled**, never
 *     blindly enabled: paused / invalid / unreadable / version mismatch all end
 *     in `enabled:false` with an explicit reason, and never fall back to the
 *     global model or an older binding.
 *
 * Best-effort at startup: per-instance failures are logged and skipped (never
 * blocks startup).
 */

import type { Logger } from '../infra/logger.js';
import type { InstanceEntry } from '../config/instance-registry.js';
import { executeMetaFetch } from '../kernel/transport-fetch.js';
import type { MetaEnvelope } from '../kernel/envelope.js';
import { createHash } from 'node:crypto';

/** Fixed username of the per-instance hidden billing user for wiki LLM usage. */
export const KNOWLEDGE_SERVICE_USERNAME = 'knowledge-service';

const CORE_SNAPSHOT_PATH = '/v3/internal/meta/instance-upstream/extraction/snapshot';

export type KnowledgeBindingMode = 'proxy' | 'byo';

export interface KnowledgeLlmBindingOptions {
  /** KS base URL (no /v3 suffix), e.g. http://127.0.0.1:8421. */
  knowledgeBaseUrl: string;
  /** KS Bearer token (may be empty when KS trusts the internal network). */
  knowledgeAuthToken: string;
  /** Context proxy root, e.g. http://127.0.0.1:8096. */
  proxyBaseUrl: string;
  /** Kernel call timeout (ms). */
  timeoutMs: number;
  /**
   * How Knowledge Service reaches the model.
   *   - 'proxy' (default): KS → context_proxy with the hidden knowledge-service
   *     user key; the proxy resolves the same Core active snapshot per instance.
   *   - 'byo': KS → provider endpoint directly with the snapshot credential.
   * Both resolve the same provider/model/version; only the transport differs.
   */
  mode?: KnowledgeBindingMode;
  /** Managed Core extraction providers are OpenAI-chat compatible. */
  protocol?: 'openai' | 'anthropic';
}

export type EnsureOutcome = 'skipped' | 'bound' | 'unavailable' | 'error';

/** KS /llm-binding/list 返回的单条 binding 快照（不含 api_key 明文）。 */
export interface KsBindingSnapshot {
  service_id: string;
  mode: string;
  proxy_base_url: string | null;
  base_url: string | null;
  has_api_key: boolean;
  enabled: boolean;
  config_source?: string | null;
  config_id?: string | null;
  config_version?: number | null;
  provider?: string | null;
  protocol?: string | null;
  model?: string | null;
  fingerprint?: string | null;
  snapshot_id?: string | null;
  unavailable_reason?: string | null;
}

interface KsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

/** Core internal snapshot resolver payload. */
export interface KnowledgeSnapshot {
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

export interface KnowledgeSyncMetaConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  timeoutMs: number;
  logger: Logger;
}

/** Connection-only fingerprint; mirrors MemoryCore's enable gate. */
function modelConfigFingerprint(input: {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): string {
  const keyDigest = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
  const material = [
    input.provider,
    input.baseUrl.replace(/\/+$/, ''),
    input.modelId,
    keyDigest,
  ].join('\n');
  return `sha256:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

/** Loggable endpoint: origin + path prefix only. */
export function sanitizeEndpointForLog(raw: string | null | undefined): string {
  if (!raw) return '(none)';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '(invalid)';
  }
}

async function ksPost<T>(
  opts: KnowledgeLlmBindingOptions,
  path: string,
  serviceId: string,
  body: unknown,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // /list 不需要 service-id 头；其他路径需要
    if (serviceId) headers['x-tdai-service-id'] = serviceId;
    if (opts.knowledgeAuthToken) headers.Authorization = `Bearer ${opts.knowledgeAuthToken}`;
    const resp = await fetch(`${opts.knowledgeBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const json = (await resp.json().catch(() => null)) as KsEnvelope<T> | null;
    if (!json || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`KS ${path} failed (http ${resp.status}, code ${json?.code}): ${json?.message ?? ''}`);
    }
    return (json.data ?? {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all KS bindings once (startup) — never fails hard. */
export async function fetchKsBindings(
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
): Promise<Map<string, KsBindingSnapshot>> {
  try {
    const resp = await ksPost<{ items: KsBindingSnapshot[] }>(
      opts, '/v3/internal/llm-binding/list', '', {},
    );
    const map = new Map((resp.items ?? []).map((b) => [b.service_id, b]));
    logger.info('fetched KS llm-binding list', {
      count: map.size,
      managed: (resp.items ?? []).filter((b) => b.config_source === 'managed').length,
    });
    return map;
  } catch (err) {
    logger.warn('failed to fetch KS llm-binding list, will mint per-instance', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * Read the Core active snapshot. Returns `null` when Core is unreachable so the
 * caller can distinguish "no managed config" (`config_unavailable`) from
 * "cannot verify" (fail closed for managed bindings, legacy path otherwise).
 */
export async function fetchKnowledgeSnapshot(
  meta: KnowledgeSyncMetaConfig,
): Promise<KnowledgeSnapshot | null> {
  try {
    const env = await executeMetaFetch<MetaEnvelope<KnowledgeSnapshot>>(
      {
        endpoint: meta.endpoint,
        apiKey: meta.apiKey,
        serviceId: meta.serviceId,
        timeoutMs: meta.timeoutMs,
        logger: meta.logger,
      },
      CORE_SNAPSHOT_PATH,
      {},
      'envelope',
    );
    if (env.code !== 0 || !env.data) {
      meta.logger.warn('core model snapshot returned an error envelope', {
        instanceId: meta.serviceId,
        code: env.code,
        message: env.message,
      });
      return null;
    }
    return env.data;
  } catch (err) {
    meta.logger.warn('core model snapshot fetch failed', {
      instanceId: meta.serviceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Mint (or reuse) the hidden per-instance knowledge-service user key. */
async function resolveProxyCredential(
  serviceId: string,
  cached: KsBindingSnapshot | undefined,
  opts: KnowledgeLlmBindingOptions,
  meta: KnowledgeSyncMetaConfig,
  logger: Logger,
): Promise<string | undefined> {
  if (
    cached?.has_api_key &&
    cached.mode === 'proxy' &&
    cached.proxy_base_url === opts.proxyBaseUrl
  ) {
    return undefined; // KS keeps the existing key
  }

  const metaCfg = {
    endpoint: meta.endpoint,
    apiKey: meta.apiKey,
    serviceId,
    userKey: meta.apiKey,
    timeoutMs: opts.timeoutMs,
    logger,
  };

  const listEnv = await executeMetaFetch<MetaEnvelope<{ items?: Array<{ user_id: string; username: string }> }>>(
    metaCfg, '/v3/meta/user/list', { username: KNOWLEDGE_SERVICE_USERNAME, limit: 10, offset: 0 }, 'envelope',
  );
  const existing = listEnv.code === 0
    ? (listEnv.data as { items?: Array<{ user_id: string; username: string }> })?.items?.find(
        (u) => u.username === KNOWLEDGE_SERVICE_USERNAME,
      )
    : undefined;

  if (!existing) {
    const createEnv = await executeMetaFetch<MetaEnvelope<{ user_id: string; default_user_key: string }>>(
      // 传确定性 user_id = username，让 proxy systemUsers 白名单能按稳定 user_id 命中
      // （一条 config 通吃所有实例，无需知道随机 usr-xxx）。
      metaCfg, '/v3/meta/user/create', { username: KNOWLEDGE_SERVICE_USERNAME, user_id: KNOWLEDGE_SERVICE_USERNAME }, 'envelope',
    );
    if (createEnv.code !== 0) throw new Error(`user/create failed: ${createEnv.message}`);
    const data = createEnv.data as { user_id: string; default_user_key: string };
    logger.info('created knowledge-service user', { instanceId: serviceId, userId: data.user_id });
    return data.default_user_key;
  }

  const mintEnv = await executeMetaFetch<MetaEnvelope<{ key_value: string }>>(
    metaCfg, '/v3/meta/user-key/create', { user_id: existing.user_id, name: 'ks-llm-binding' }, 'envelope',
  );
  if (mintEnv.code !== 0) throw new Error(`user-key/create failed: ${mintEnv.message}`);
  logger.info('minted new key for existing knowledge-service user', {
    instanceId: serviceId,
    userId: existing.user_id,
  });
  return (mintEnv.data as { key_value: string }).key_value;
}

/** Legacy (deployment) behaviour: ensure proxy endpoint + key, model from env. */
async function ensureLegacyBinding(
  serviceId: string,
  cached: KsBindingSnapshot | undefined,
  opts: KnowledgeLlmBindingOptions,
  meta: KnowledgeSyncMetaConfig,
  logger: Logger,
): Promise<EnsureOutcome> {
  if (cached?.has_api_key) {
    await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
      mode: 'proxy',
      proxy_base_url: opts.proxyBaseUrl,
      enabled: true,
      // 不传 api_key → KS 保留原值
    });
    logger.info('knowledge llm-binding refreshed (key retained)', {
      instanceId: serviceId,
      configSource: 'deployment',
      endpoint: sanitizeEndpointForLog(opts.proxyBaseUrl),
      outcome: 'bound',
    });
    return 'bound';
  }

  const userKey = await resolveProxyCredential(serviceId, cached, opts, meta, logger);
  if (!userKey) throw new Error('proxy credential was not minted');
  await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
    mode: 'proxy',
    proxy_base_url: opts.proxyBaseUrl,
    api_key: userKey,
    enabled: true,
  });
  logger.info('pushed knowledge llm-binding to KS (new key)', {
    instanceId: serviceId,
    configSource: 'deployment',
    endpoint: sanitizeEndpointForLog(opts.proxyBaseUrl),
    outcome: 'bound',
  });
  return 'bound';
}

/** Record an explicit fail-closed state; never erases the stored snapshot. */
async function markUnavailable(
  serviceId: string,
  reason: string,
  cached: KsBindingSnapshot | undefined,
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
): Promise<EnsureOutcome> {
  const mode = cached?.mode === 'byo' || cached?.mode === 'proxy'
    ? cached.mode
    : (opts.mode ?? 'proxy');
  await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, {
    mode,
    config_source: 'managed',
    enabled: false,
    unavailable_reason: reason,
  });
  logger.warn('knowledge model binding marked unavailable (fail closed)', {
    instanceId: serviceId,
    configSource: 'managed',
    configId: cached?.config_id ?? null,
    configVersion: cached?.config_version ?? null,
    provider: cached?.provider ?? null,
    model: cached?.model ?? null,
    endpoint: sanitizeEndpointForLog(cached?.base_url ?? cached?.proxy_base_url),
    reason,
    outcome: 'unavailable',
  });
  return 'unavailable';
}

/** Push the active snapshot into KS as a managed binding. */
async function pushManagedSnapshot(
  serviceId: string,
  snapshot: NonNullable<KnowledgeSnapshot['snapshot']>,
  cached: KsBindingSnapshot | undefined,
  opts: KnowledgeLlmBindingOptions,
  meta: KnowledgeSyncMetaConfig,
  logger: Logger,
  sourceConfigId?: string | null,
): Promise<EnsureOutcome> {
  const mode = opts.mode ?? 'proxy';
  const protocol = opts.protocol ?? 'openai';
  const fingerprint = modelConfigFingerprint({
    provider: snapshot.provider,
    baseUrl: snapshot.base_url,
    modelId: snapshot.model_id,
    apiKey: snapshot.api_key,
  });
  const body: Record<string, unknown> = {
    mode,
    config_source: 'managed',
    enabled: true,
    unavailable_reason: null,
    provider: snapshot.provider,
    protocol,
    model: snapshot.model_id,
    base_url: snapshot.base_url,
    // Source extraction config id (stable across versions). The internal
    // snapshot route does not expose it, so reconcile preserves the stored id
    // and falls back to the immutable snapshot id for brand-new rows.
    config_id: sourceConfigId ?? cached?.config_id ?? snapshot.snapshot_id,
    config_version: snapshot.version,
    fingerprint,
    snapshot_id: snapshot.snapshot_id,
  };
  if (mode === 'proxy') {
    body.proxy_base_url = opts.proxyBaseUrl;
    const userKey = await resolveProxyCredential(serviceId, cached, opts, meta, logger);
    if (userKey) body.api_key = userKey;
  } else {
    body.api_key = snapshot.api_key;
  }

  await ksPost(opts, '/v3/internal/llm-binding/set', serviceId, body);
  logger.info('knowledge model binding synced from active snapshot', {
    instanceId: serviceId,
    configSource: 'managed',
    configId: snapshot.snapshot_id,
    configVersion: snapshot.version,
    provider: snapshot.provider,
    protocol,
    model: snapshot.model_id,
    endpoint: sanitizeEndpointForLog(snapshot.base_url),
    transportMode: mode,
    outcome: 'bound',
  });
  return 'bound';
}

/**
 * Reconcile one instance with the Core snapshot.
 *
 * `snapshot === null` means the snapshot could not be read: managed bindings
 * fail closed (`snapshot_unavailable`), legacy deployments keep working.
 */
export async function applyKnowledgeModelSnapshot(params: {
  serviceId: string;
  snapshot: KnowledgeSnapshot | null;
  cached: KsBindingSnapshot | undefined;
  opts: KnowledgeLlmBindingOptions;
  meta: KnowledgeSyncMetaConfig;
  logger: Logger;
  /** Core extraction config id when the caller has it (post-enable hook). */
  sourceConfigId?: string | null;
}): Promise<EnsureOutcome> {
  const { serviceId, snapshot, cached, opts, meta, logger, sourceConfigId } = params;
  const managed = cached?.config_source === 'managed';

  if (!snapshot) {
    if (managed) return markUnavailable(serviceId, 'snapshot_unavailable', cached, opts, logger);
    return ensureLegacyBinding(serviceId, cached, opts, meta, logger);
  }

  if (snapshot.status === 'ready' && snapshot.snapshot) {
    const active = snapshot.snapshot;
    if (
      managed &&
      typeof cached?.config_version === 'number' &&
      active.version < cached.config_version
    ) {
      // KS holds a newer managed snapshot than Core: never roll it back silently.
      logger.error('knowledge model snapshot version mismatch (core older than KS)', {
        instanceId: serviceId,
        configId: active.snapshot_id,
        configVersion: active.version,
        storedConfigVersion: cached.config_version,
        outcome: 'fail_closed',
      });
      return markUnavailable(serviceId, 'version_mismatch', cached, opts, logger);
    }
    return pushManagedSnapshot(serviceId, active, cached, opts, meta, logger, sourceConfigId);
  }

  if (snapshot.status === 'paused') {
    return markUnavailable(serviceId, 'paused', cached, opts, logger);
  }

  if (snapshot.status === 'invalid') {
    return markUnavailable(serviceId, `invalid:${snapshot.reason ?? 'unknown'}`, cached, opts, logger);
  }

  // config_unavailable = this instance has no managed extraction config.
  if (managed) return markUnavailable(serviceId, 'config_unavailable', cached, opts, logger);
  return ensureLegacyBinding(serviceId, cached, opts, meta, logger);
}

/** One instance: ensure the binding exists (create/mint/push as needed). */
export async function ensureKnowledgeLlmBinding(
  instance: InstanceEntry,
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
  ksBindings: Map<string, KsBindingSnapshot>,
): Promise<EnsureOutcome> {
  const serviceId = instance.instance_id;
  const cached = ksBindings.get(serviceId);
  const meta: KnowledgeSyncMetaConfig = {
    endpoint: instance.gateway_endpoint,
    apiKey: instance.api_key,
    serviceId,
    timeoutMs: opts.timeoutMs,
    logger,
  };
  const snapshot = await fetchKnowledgeSnapshot(meta);
  return applyKnowledgeModelSnapshot({ serviceId, snapshot, cached, opts, meta, logger });
}

/** All instances, best-effort. Never throws. */
export async function ensureKnowledgeLlmBindings(
  instances: InstanceEntry[],
  opts: KnowledgeLlmBindingOptions,
  logger: Logger,
): Promise<void> {
  // 1. 一次性查 KS /llm-binding/list 拿到当前状态缓存
  const ksBindings = await fetchKsBindings(opts, logger);

  // 2. 以 TMC instances 列表为准逐个处理
  for (const instance of instances) {
    try {
      await ensureKnowledgeLlmBinding(instance, opts, logger, ksBindings);
    } catch (err) {
      logger.warn('knowledge llm-binding ensure failed (will rely on manual recovery)', {
        instanceId: instance.instance_id,
        error: err instanceof Error ? err.message : String(err),
        outcome: 'error',
      });
    }
  }
}
