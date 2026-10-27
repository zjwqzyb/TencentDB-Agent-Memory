/**
 * LLM Binding Routes — internal, per-instance LLM routing config.
 *
 * Mounted under /v3/internal/llm-binding (prefix applied at server.ts).
 * service_id is REQUIRED via the `x-tdai-service-id` header (unified KS convention),
 * never in the body.
 *
 *   POST /set     upsert binding (proxy|byo). Idempotent — re-posting overwrites,
 *                 which is how a lost binding is re-bound (TMC startup / manual curl).
 *                 `api_key` 可选：不传时保留原值（仅对已存在的记录生效）；首次创建必填。
 *                 Managed payloads (config_source='managed') also carry the Core
 *                 active snapshot provenance: provider/protocol/model/config id/
 *                 version/fingerprint/snapshot id. A managed snapshot can never
 *                 move backwards (409 STALE_BINDING) — the caller reconciles.
 *                 `enabled:false` may omit URLs to record a fail-closed state
 *                 (paused/invalid/mismatch) without erasing the snapshot fields.
 *   POST /status  read-side binding status (never returns api_key).
 *   POST /list    列出所有 binding（不要求 service-id 头）。返回 has_api_key 标志与
 *                 managed 快照元数据（不含 api_key 明文）。供 Panel 启动时对账用。
 *
 * These endpoints are internal (TMC control plane / operator curl). KS trusts the
 * internal network like its other routes; no extra auth layer is added here.
 */

import { Hono } from "hono";

import type {
  ILlmBindingStore,
  LlmBindingConfigSource,
  LlmBindingMode,
  LlmBindingProtocol,
} from "../store/index.js";
import { StaleLlmBindingError, isModelConfigFingerprint } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface LlmBindingRouteDeps {
  llmBindingStore: ILlmBindingStore;
}

function isMode(v: unknown): v is LlmBindingMode {
  return v === "proxy" || v === "byo";
}

function isProtocol(v: unknown): v is LlmBindingProtocol {
  return v === "openai" || v === "anthropic";
}

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asOptInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function createLlmBindingRoutes(deps: LlmBindingRouteDeps): Hono {
  const app = new Hono();
  const { llmBindingStore } = deps;

  app.post("/set", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    const existing = llmBindingStore.get(serviceId);

    const rawSource = body.config_source ?? (body.managed === true ? "managed" : undefined);
    if (rawSource !== undefined && rawSource !== "managed" && rawSource !== "deployment") {
      return c.json(wrapError(400, "config_source must be 'managed' or 'deployment'"), 400);
    }
    const configSource: LlmBindingConfigSource =
      (rawSource as LlmBindingConfigSource | undefined) ?? existing?.config_source ?? "deployment";

    const mode = isMode(body.mode) ? body.mode : existing?.mode;
    if (!mode) {
      return c.json(wrapError(400, "mode must be 'proxy' or 'byo'"), 400);
    }

    const enabled = body.enabled === undefined ? undefined : body.enabled !== false;
    const disabling = enabled === false;

    const protocolRaw = body.protocol;
    if (protocolRaw !== undefined && protocolRaw !== null && !isProtocol(protocolRaw)) {
      return c.json(wrapError(400, "protocol must be 'openai' or 'anthropic'"), 400);
    }
    const protocol = isProtocol(protocolRaw) ? protocolRaw : undefined;
    const configVersionRaw = asOptInt(body.config_version);
    if (body.config_version !== undefined && configVersionRaw === undefined) {
      return c.json(wrapError(400, "config_version must be a number"), 400);
    }
    const fingerprint = asOptString(body.fingerprint);
    if (fingerprint && !isModelConfigFingerprint(fingerprint)) {
      return c.json(wrapError(400, "fingerprint must look like sha256:<16 hex>"), 400);
    }

    const apiKey = asOptString(body.api_key);
    const proxyBaseUrl = asOptString(body.proxy_base_url);
    const baseUrl = asOptString(body.base_url);
    const effectiveProxyUrl = proxyBaseUrl ?? existing?.proxy_base_url ?? null;
    const effectiveBaseUrl = baseUrl ?? existing?.base_url ?? null;
    const effectiveApiKey = apiKey ?? existing?.api_key ?? null;
    const effectiveProvider = asOptString(body.provider) ?? existing?.provider ?? null;
    const effectiveModel = asOptString(body.model) ?? existing?.model ?? null;
    const effectiveProtocol = protocol ?? existing?.protocol ?? null;
    const effectiveConfigId = asOptString(body.config_id) ?? existing?.config_id ?? null;
    const effectiveConfigVersion = configVersionRaw ?? existing?.config_version ?? null;
    const effectiveFingerprint = fingerprint ?? existing?.fingerprint ?? null;

    // ── enabled payload validation ──
    if (!disabling) {
      // proxy_base_url / base_url 始终必填（KS 调 LLM 需要地址）
      if (mode === "proxy" && !effectiveProxyUrl) {
        return c.json(wrapError(400, "proxy mode requires proxy_base_url"), 400);
      }
      if (mode === "byo" && !effectiveBaseUrl) {
        return c.json(wrapError(400, "byo mode requires base_url"), 400);
      }
      // api_key 校验：首次创建（KS 无此 service_id 记录）时必填；已存在记录时不传则保留原值。
      if (!effectiveApiKey) {
        return c.json(wrapError(400, `${mode} mode requires api_key on first set`), 400);
      }
      if (configSource === "managed") {
        const missing: string[] = [];
        if (!effectiveProvider) missing.push("provider");
        if (!effectiveProtocol) missing.push("protocol");
        if (!effectiveModel) missing.push("model");
        if (!effectiveConfigId) missing.push("config_id");
        if (!effectiveConfigVersion || effectiveConfigVersion <= 0) missing.push("config_version");
        if (!effectiveFingerprint) missing.push("fingerprint");
        if (!effectiveBaseUrl) missing.push("base_url");
        if (missing.length > 0) {
          return c.json(
            wrapError(400, `managed binding requires: ${missing.join(", ")}`),
            400,
          );
        }
      }
    } else if (!existing && configSource !== "managed") {
      // Disabling a binding that never existed is only meaningful as a managed
      // fail-closed marker (paused/invalid before first successful sync).
      return c.json(wrapError(404, "llm binding does not exist"), 404);
    }

    try {
      const row = llmBindingStore.upsert(serviceId, {
        mode,
        proxy_base_url: proxyBaseUrl ?? undefined,
        // asOptString 返回 string | undefined；upsert 层把 undefined 解释为"保留原值"
        api_key: apiKey,
        base_url: baseUrl ?? undefined,
        model: asOptString(body.model) ?? undefined,
        provider: asOptString(body.provider) ?? undefined,
        protocol,
        config_source: configSource,
        config_id: asOptString(body.config_id) ?? undefined,
        config_version: configVersionRaw,
        fingerprint,
        snapshot_id: asOptString(body.snapshot_id) ?? undefined,
        unavailable_reason:
          body.unavailable_reason === null
            ? null
            : typeof body.unavailable_reason === "string"
              ? body.unavailable_reason
              : undefined,
        enabled,
      });

      // Never echo api_key back.
      return c.json(
        wrapOk({
          service_id: row.service_id,
          mode: row.mode,
          enabled: row.enabled,
          config_source: row.config_source,
          config_id: row.config_id,
          config_version: row.config_version,
          provider: row.provider,
          protocol: row.protocol,
          model: row.model,
          snapshot_id: row.snapshot_id,
          fingerprint: row.fingerprint,
          unavailable_reason: row.unavailable_reason,
          updated_at: row.updated_at,
        }),
      );
    } catch (err) {
      if (err instanceof StaleLlmBindingError) {
        return c.json(
          wrapError(
            409,
            `STALE_BINDING: stored version ${err.storedVersion} is newer than ${err.incomingVersion}`,
          ),
          409,
        );
      }
      throw err;
    }
  });

  app.post("/status", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(wrapOk(llmBindingStore.status(serviceId)));
  });

  app.post("/list", async (c) => {
    // 不要求 x-tdai-service-id 头：返回所有 binding，供 Panel 启动时缓存全局状态。
    const items = llmBindingStore.listAll().map((r) => ({
      service_id: r.service_id,
      mode: r.mode,
      proxy_base_url: r.proxy_base_url,
      base_url: r.base_url,
      has_api_key: !!r.api_key && r.api_key.length > 0,
      enabled: r.enabled,
      config_source: r.config_source,
      config_id: r.config_id,
      config_version: r.config_version,
      provider: r.provider,
      protocol: r.protocol,
      model: r.model,
      fingerprint: r.fingerprint,
      snapshot_id: r.snapshot_id,
      unavailable_reason: r.unavailable_reason,
      updated_at: r.updated_at,
    }));
    return c.json(wrapOk({ items }));
  });

  return app;
}
