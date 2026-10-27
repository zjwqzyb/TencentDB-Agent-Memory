/**
 * LlmBindingStore — per-instance (service_id) LLM routing binding.
 *
 * Decoupled from IKnowledgeStore: a single small table keyed by service_id that
 * tells wiki ingest/summary which LLM endpoint to use for that instance.
 *   - mode='proxy' → route through context_proxy with a dedicated knowledge-service
 *     user_key so LLM usage is billed per instance.
 *   - mode='byo'   → user-supplied OpenAI-compatible endpoint.
 *
 * Two provenance classes live in the same table:
 *
 *   - `config_source='deployment'` (legacy): the binding only overrides
 *     endpoint/key; the model always comes from the global `LLM_MODEL` env.
 *     No binding → behaviour depends on the global LLM_MODE:
 *       * LLM_MODE=custom → fall back to the global LLM_* (direct BYO) config.
 *       * LLM_MODE=proxy (default) → NO silent direct fallback; an "unconfigured"
 *         config is returned so wiki ingest fails loudly.
 *
 *   - `config_source='managed'`: the row is a mirror of the Core instance
 *     upstream **active snapshot** (provider/model/protocol/config id/version/
 *     fingerprint). There is NO fallback to global env or to an older row:
 *     paused, incomplete, fingerprint mismatch or snapshot read failure is a
 *     hard failure for the job (fail-closed).
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmBinding } from "../db/schema.js";
import type { LlmConfig } from "../config.js";
import { isModelConfigFingerprint, modelConfigFingerprint } from "./model-config-fingerprint.js";

export type LlmBindingMode = "proxy" | "byo";
export type LlmBindingConfigSource = "deployment" | "managed";
export type LlmBindingProtocol = "openai" | "anthropic";

export interface LlmBindingRow {
  service_id: string;
  mode: LlmBindingMode;
  proxy_base_url: string | null;
  api_key: string | null;
  /** Direct upstream endpoint (provider base URL) — always recorded for managed rows. */
  base_url: string | null;
  /** Active model id. Null on legacy rows (model comes from global env). */
  model: string | null;
  provider: string | null;
  protocol: LlmBindingProtocol | null;
  config_source: LlmBindingConfigSource;
  config_id: string | null;
  config_version: number | null;
  fingerprint: string | null;
  snapshot_id: string | null;
  unavailable_reason: string | null;
  enabled: boolean;
  updated_at: string;
}

/** Upsert payload (service_id comes from the header, not the body).
 *  `undefined` 表示保留原值（用于只更新部分字段的场景）；
 *  `null` 表示清空；具体值表示更新。
 *  `api_key` 的保留语义与此一致：只刷新地址时不要传 api_key。 */
export interface LlmBindingInput {
  mode: LlmBindingMode;
  proxy_base_url?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  model?: string | null;
  provider?: string | null;
  protocol?: LlmBindingProtocol | null;
  config_source?: LlmBindingConfigSource;
  config_id?: string | null;
  config_version?: number | null;
  fingerprint?: string | null;
  snapshot_id?: string | null;
  unavailable_reason?: string | null;
  enabled?: boolean;
}

/** Read-side status (never exposes api_key). */
export interface LlmBindingStatus {
  bound: boolean;
  mode: LlmBindingMode | null;
  enabled: boolean;
  config_source: LlmBindingConfigSource | null;
  config_id: string | null;
  config_version: number | null;
  model: string | null;
  provider: string | null;
  unavailable_reason: string | null;
}

/** Raised when a managed snapshot would move backwards. Never auto-retried. */
export class StaleLlmBindingError extends Error {
  constructor(
    readonly serviceId: string,
    readonly storedVersion: number,
    readonly incomingVersion: number,
  ) {
    super(
      `stale managed llm binding for ${serviceId}: stored version ${storedVersion} is newer than ${incomingVersion}`,
    );
    this.name = "StaleLlmBindingError";
  }
}

export interface ILlmBindingStore {
  get(serviceId: string): LlmBindingRow | null;
  listAll(): LlmBindingRow[];
  upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow;
  status(serviceId: string): LlmBindingStatus;
}

export function createLlmBindingStore(db: Db): ILlmBindingStore {
  return {
    get(serviceId: string): LlmBindingRow | null {
      const rows = db.select().from(llmBinding).where(eq(llmBinding.serviceId, serviceId)).all();
      const row = rows[0];
      return row ? toRow(row) : null;
    },

    listAll(): LlmBindingRow[] {
      const rows = db.select().from(llmBinding).all();
      return rows.map(toRow);
    },

    upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow {
      const now = new Date().toISOString();
      const existing = this.get(serviceId);
      const keep = <T>(value: T | undefined, fallback: T): T =>
        value !== undefined ? value : fallback;

      // api_key: undefined → 保留原值（仅 upsert 已存在记录时）；null → 清空；string → 更新
      const apiKey = keep(input.api_key, existing?.api_key ?? null);
      const configSource = input.config_source ?? existing?.config_source ?? "deployment";
      const incomingVersion = keep(input.config_version, existing?.config_version ?? null);

      // A managed snapshot must never be overwritten by an older version: a slow
      // Panel reconcile racing a fresh enable would otherwise silently roll the
      // knowledge service back to a stale model. Callers see 409 and reconcile.
      if (
        configSource === "managed" &&
        existing?.config_source === "managed" &&
        typeof existing.config_version === "number" &&
        typeof incomingVersion === "number" &&
        incomingVersion < existing.config_version
      ) {
        throw new StaleLlmBindingError(serviceId, existing.config_version, incomingVersion);
      }

      const values = {
        serviceId,
        mode: input.mode,
        proxyBaseUrl: keep(input.proxy_base_url, existing?.proxy_base_url ?? null),
        apiKey,
        baseUrl: keep(input.base_url, existing?.base_url ?? null),
        model: keep(input.model, existing?.model ?? null),
        provider: keep(input.provider, existing?.provider ?? null),
        protocol: keep(input.protocol, existing?.protocol ?? null),
        configSource,
        configId: keep(input.config_id, existing?.config_id ?? null),
        configVersion: incomingVersion,
        fingerprint: keep(input.fingerprint, existing?.fingerprint ?? null),
        snapshotId: keep(input.snapshot_id, existing?.snapshot_id ?? null),
        unavailableReason: keep(input.unavailable_reason, existing?.unavailable_reason ?? null),
        enabled: input.enabled === false ? 0 : input.enabled === true ? 1 : existing ? (existing.enabled ? 1 : 0) : 1,
        updatedAt: now,
      };
      db.insert(llmBinding)
        .values(values)
        .onConflictDoUpdate({
          target: llmBinding.serviceId,
          set: {
            mode: values.mode,
            proxyBaseUrl: values.proxyBaseUrl,
            apiKey: values.apiKey,
            baseUrl: values.baseUrl,
            model: values.model,
            provider: values.provider,
            protocol: values.protocol,
            configSource: values.configSource,
            configId: values.configId,
            configVersion: values.configVersion,
            fingerprint: values.fingerprint,
            snapshotId: values.snapshotId,
            unavailableReason: values.unavailableReason,
            enabled: values.enabled,
            updatedAt: values.updatedAt,
          },
        })
        .run();
      return this.get(serviceId)!;
    },

    status(serviceId: string): LlmBindingStatus {
      const row = this.get(serviceId);
      if (!row) {
        return {
          bound: false,
          mode: null,
          enabled: false,
          config_source: null,
          config_id: null,
          config_version: null,
          model: null,
          provider: null,
          unavailable_reason: null,
        };
      }
      return {
        bound: true,
        mode: row.mode,
        enabled: row.enabled,
        config_source: row.config_source,
        config_id: row.config_id,
        config_version: row.config_version,
        model: row.model,
        provider: row.provider,
        unavailable_reason: row.unavailable_reason,
      };
    },
  };
}

function toRow(r: typeof llmBinding.$inferSelect): LlmBindingRow {
  return {
    service_id: r.serviceId,
    mode: (r.mode === "byo" ? "byo" : "proxy") as LlmBindingMode,
    proxy_base_url: r.proxyBaseUrl ?? null,
    api_key: r.apiKey ?? null,
    base_url: r.baseUrl ?? null,
    model: r.model ?? null,
    provider: r.provider ?? null,
    protocol:
      r.protocol === "anthropic" ? "anthropic" : r.protocol === "openai" ? "openai" : null,
    config_source: r.configSource === "managed" ? "managed" : "deployment",
    config_id: r.configId ?? null,
    config_version: typeof r.configVersion === "number" ? r.configVersion : null,
    fingerprint: r.fingerprint ?? null,
    snapshot_id: r.snapshotId ?? null,
    unavailable_reason: r.unavailableReason ?? null,
    enabled: r.enabled !== 0,
    updated_at: r.updatedAt,
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Loggable endpoint: origin + path prefix only. Drops query/fragment and any
 * credentials a deployment may have embedded in the URL.
 */
export function sanitizeEndpointForLog(raw: string | null | undefined): string {
  if (!raw) return "(none)";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "(invalid)";
  }
}

/**
 * Pure legacy resolver: turn a deployment binding (or its absence) into an
 * effective LlmConfig. maxTokens/timeoutMs/provider/mode always inherit from
 * the fallback; the binding only overrides endpoint/key, and the model always
 * comes from `fallback.model` (= global `LLM_MODEL` env).
 *
 * proxy mode → baseUrl = {proxy_base_url}/proxy/{service_id}/v1 (so context_proxy
 * uses service_id as x-tdai-service-id for auth/verify + per-instance billing).
 */
export function resolveLlmConfig(
  serviceId: string,
  binding: LlmBindingRow | null,
  fallback: LlmConfig,
): LlmConfig {
  // Global default when no per-instance binding is usable.
  const globalDefault = (): LlmConfig =>
    fallback.mode === "custom"
      ? fallback
      : { ...fallback, baseUrl: "", apiKey: "" };

  if (!binding || !binding.enabled) return globalDefault();

  if (binding.mode === "proxy") {
    if (!binding.proxy_base_url || !binding.api_key) return globalDefault();
    return {
      mode: fallback.mode,
      protocol: fallback.protocol,
      provider: fallback.provider,
      apiKey: binding.api_key,
      model: fallback.model,
      baseUrl: `${trimTrailingSlash(binding.proxy_base_url)}/proxy/${serviceId}/v1`,
      maxTokens: fallback.maxTokens,
      timeoutMs: fallback.timeoutMs,
      stream: fallback.stream,
    };
  }

  // byo
  if (!binding.base_url || !binding.api_key) return globalDefault();
  return {
    mode: fallback.mode,
    protocol: fallback.protocol,
    provider: fallback.provider,
    apiKey: binding.api_key,
    model: fallback.model,
    baseUrl: binding.base_url,
    maxTokens: fallback.maxTokens,
    timeoutMs: fallback.timeoutMs,
    stream: fallback.stream,
  };
}

/** Provenance recorded on the config and emitted in every job log line. */
export interface ModelSnapshotMeta {
  source: LlmBindingConfigSource;
  config_id: string | null;
  version: number | null;
  fingerprint: string | null;
  snapshot_id: string | null;
  provider: string;
  protocol: LlmBindingProtocol;
  model: string;
  /** Direct provider endpoint, sanitized for logs. */
  endpoint: string;
}

export type LlmBindingResolution =
  | { ok: true; config: LlmConfig; meta: ModelSnapshotMeta; managed: true }
  | { ok: true; config: LlmConfig; meta: ModelSnapshotMeta; managed: false }
  | { ok: false; reason: string; message: string; meta: Partial<ModelSnapshotMeta> };

function snapshotMeta(
  binding: LlmBindingRow,
  provider: string,
  protocol: LlmBindingProtocol,
  model: string,
  endpoint: string,
): ModelSnapshotMeta {
  return {
    source: "managed",
    config_id: binding.config_id,
    version: binding.config_version,
    fingerprint: binding.fingerprint,
    snapshot_id: binding.snapshot_id,
    provider,
    protocol,
    model,
    endpoint,
  };
}

/**
 * Job-start resolver. Callers must resolve **once** per wiki job and reuse the
 * returned config for body generation, merge, summary and tool calls.
 *
 * Managed rows fail closed: paused, incomplete, malformed fingerprint, or (byo)
 * a fingerprint that does not match the stored credential/endpoint. Legacy
 * deployment rows keep their previous env-fallback behaviour.
 */
export function resolveLlmBinding(
  serviceId: string,
  binding: LlmBindingRow | null,
  fallback: LlmConfig,
): LlmBindingResolution {
  if (binding?.config_source === "managed") {
    const provider = binding.provider ?? "";
    const protocol: LlmBindingProtocol =
      binding.protocol ?? (fallback.protocol === "anthropic" ? "anthropic" : "openai");
    const model = binding.model ?? "";
    const endpoint = sanitizeEndpointForLog(binding.base_url ?? binding.proxy_base_url);
    const meta = snapshotMeta(binding, provider, protocol, model, endpoint);

    if (!binding.enabled) {
      return {
        ok: false,
        reason: binding.unavailable_reason || "disabled",
        message:
          `managed model configuration is not active (${binding.unavailable_reason || "disabled"}) ` +
          `[config=${binding.config_id ?? "?"} version=${binding.config_version ?? "?"}]`,
        meta,
      };
    }

    const missing: string[] = [];
    if (!provider) missing.push("provider");
    if (!model) missing.push("model");
    if (!binding.protocol) missing.push("protocol");
    if (!binding.config_id) missing.push("config_id");
    if (typeof binding.config_version !== "number" || binding.config_version <= 0) {
      missing.push("config_version");
    }
    if (!binding.fingerprint) missing.push("fingerprint");
    if (!binding.api_key) missing.push("api_key");
    if (binding.mode === "proxy" ? !binding.proxy_base_url : !binding.base_url) {
      missing.push(binding.mode === "proxy" ? "proxy_base_url" : "base_url");
    }
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "incomplete",
        message:
          `managed model configuration is incomplete (missing ${missing.join(", ")}) ` +
          `[config=${binding.config_id ?? "?"} version=${binding.config_version ?? "?"}]`,
        meta,
      };
    }

    if (!isModelConfigFingerprint(binding.fingerprint!)) {
      return {
        ok: false,
        reason: "fingerprint_invalid",
        message:
          `managed model configuration fingerprint is malformed ` +
          `[config=${binding.config_id} version=${binding.config_version}]`,
        meta,
      };
    }

    // In byo mode we can re-derive the fingerprint end-to-end. In proxy mode the
    // stored credential is the knowledge-service user key, not the provider key,
    // so the fingerprint is provenance recorded from Core and only shape-checked.
    if (binding.mode === "byo" && binding.base_url) {
      const expected = modelConfigFingerprint({
        provider,
        baseUrl: binding.base_url,
        modelId: model,
        apiKey: binding.api_key!,
      });
      if (expected !== binding.fingerprint) {
        return {
          ok: false,
          reason: "fingerprint_mismatch",
          message:
            `managed model configuration fingerprint does not match the stored endpoint/model/credential ` +
            `[config=${binding.config_id} version=${binding.config_version}]`,
          meta,
        };
      }
    }

    const config: LlmConfig = {
      mode: fallback.mode,
      protocol,
      provider,
      apiKey: binding.api_key!,
      model,
      baseUrl:
        binding.mode === "proxy"
          ? `${trimTrailingSlash(binding.proxy_base_url!)}/proxy/${serviceId}/v1`
          : binding.base_url!,
      maxTokens: fallback.maxTokens,
      timeoutMs: fallback.timeoutMs,
      stream: fallback.stream,
      modelConfig: {
        source: "managed",
        configId: binding.config_id,
        version: binding.config_version,
        fingerprint: binding.fingerprint,
        snapshotId: binding.snapshot_id,
      },
    };
    return { ok: true, config, meta, managed: true };
  }

  const config = resolveLlmConfig(serviceId, binding, fallback);
  return {
    ok: true,
    config: { ...config, modelConfig: { source: "deployment", configId: null, version: null, fingerprint: null, snapshotId: null } },
    meta: {
      source: "deployment",
      config_id: null,
      version: null,
      fingerprint: null,
      snapshot_id: null,
      provider: config.provider,
      protocol: config.protocol,
      model: config.model,
      endpoint: sanitizeEndpointForLog(config.baseUrl),
    },
    managed: false,
  };
}
