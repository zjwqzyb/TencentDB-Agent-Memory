/**
 * Post-enable Knowledge Service binding sync.
 *
 * Core owns the active model snapshot. `instance-upstream/extraction/enable`
 * returns the public DTO (masked key only), so this hook re-reads the
 * Bearer-only internal snapshot, verifies it matches the just-enabled snapshot
 * (guards against a concurrent enable), then pushes it to KS.
 *
 * If KS cannot be updated the enable call MUST NOT report success: the caller
 * returns 502 KNOWLEDGE_SYNC_FAILED. The Core snapshot is already active at that
 * point (enable is committed), so retrying the enable is not required; the next
 * Panel startup reconcile re-pushes it.
 */

import type { Logger } from '../../../infra/logger.js';
import type { PanelDeps } from '../../../panel-deps.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import {
  applyKnowledgeModelSnapshot,
  fetchKsBindings,
  fetchKnowledgeSnapshot,
  type EnsureOutcome,
  type KnowledgeLlmBindingOptions,
  type KnowledgeSnapshot,
} from '../../../startup/ensure-knowledge-llm-binding.js';

export interface EnableDto {
  config_id?: string | null;
  version?: number;
  paused?: boolean;
  active_snapshot?: {
    snapshot_id?: string;
    version?: number;
    provider?: string;
    base_url?: string;
    model_id?: string;
    activated_at?: string;
  } | null;
}

export interface KnowledgeBindingSyncResult {
  ok: boolean;
  message: string;
  configId?: string | null;
  configVersion?: number | null;
  outcome?: EnsureOutcome;
}

export function knowledgeBindingOptionsFromDeps(deps: PanelDeps): KnowledgeLlmBindingOptions {
  return {
    knowledgeBaseUrl: deps.config.knowledge.baseUrl,
    knowledgeAuthToken: deps.config.knowledge.authToken,
    proxyBaseUrl: deps.config.knowledgeLlmBinding.proxyBaseUrl,
    timeoutMs: deps.config.knowledge.timeoutMs,
  };
}

export async function syncKnowledgeBindingAfterEnable(
  deps: PanelDeps,
  ctx: MetaCallContext,
  enabled: EnableDto | null | undefined,
): Promise<KnowledgeBindingSyncResult> {
  const logger: Logger = deps.logger;
  const opts = knowledgeBindingOptionsFromDeps(deps);
  const meta = {
    endpoint: ctx.gatewayEndpoint,
    apiKey: ctx.gatewayApiKey,
    serviceId: ctx.instanceId,
    timeoutMs: deps.config.metadataRemoteTimeoutMs,
    logger,
  };

  const snapshot: KnowledgeSnapshot | null = await fetchKnowledgeSnapshot(meta);
  if (!snapshot) {
    return { ok: false, message: 'cannot read the active model snapshot from core' };
  }
  if (snapshot.status !== 'ready' || !snapshot.snapshot) {
    return {
      ok: false,
      message: `active model snapshot is not ready (${snapshot.status}${snapshot.reason ? `: ${snapshot.reason}` : ''})`,
    };
  }

  const expected = enabled?.active_snapshot;
  if (
    expected &&
    (expected.snapshot_id !== snapshot.snapshot.snapshot_id ||
      expected.version !== snapshot.snapshot.version)
  ) {
    return {
      ok: false,
      message:
        `active model snapshot changed during enable ` +
        `(expected ${expected.snapshot_id ?? '?'}@${expected.version ?? '?'}, ` +
        `now ${snapshot.snapshot.snapshot_id}@${snapshot.snapshot.version})`,
    };
  }

  const bindings = await fetchKsBindings(opts, logger);
  let outcome: EnsureOutcome;
  try {
    outcome = await applyKnowledgeModelSnapshot({
      serviceId: ctx.instanceId,
      snapshot,
      cached: bindings.get(ctx.instanceId),
      opts,
      meta,
      logger,
      sourceConfigId: enabled?.config_id ?? null,
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      configId: snapshot.snapshot.snapshot_id,
      configVersion: snapshot.snapshot.version,
      outcome: 'error',
    };
  }
  if (outcome !== 'bound') {
    return {
      ok: false,
      message: `knowledge service binding is ${outcome}`,
      configId: snapshot.snapshot.snapshot_id,
      configVersion: snapshot.snapshot.version,
      outcome,
    };
  }
  return {
    ok: true,
    message: 'ok',
    configId: snapshot.snapshot.snapshot_id,
    configVersion: snapshot.snapshot.version,
    outcome,
  };
}

/**
 * Post-disable Knowledge Service binding sync.
 *
 * Core keeps the snapshot but flips `enabled=false`, so the internal resolver now
 * reports `paused`. Pushing that immediately closes the window where Knowledge
 * Service (byo/direct transport) would still generate with the previous binding
 * until the next Panel startup reconcile.
 *
 * Disable itself is authoritative and already committed in Core (+ Proxy fails
 * closed), so a KS failure here is logged but does not turn the pause into an
 * error response — the caller still sees the paused state.
 */
export async function syncKnowledgeBindingAfterDisable(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<KnowledgeBindingSyncResult> {
  return syncKnowledgeBindingFromCore(deps, ctx);
}

/**
 * Re-read Core's current state (ready / paused / invalid) and reconcile the KS
 * binding. Used by disable (immediate pause propagation) and by the manual
 * re-sync action that recovers from a failed enable→KS sync without a restart.
 */
export async function syncKnowledgeBindingFromCore(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<KnowledgeBindingSyncResult> {
  const logger: Logger = deps.logger;
  const opts = knowledgeBindingOptionsFromDeps(deps);
  const meta = {
    endpoint: ctx.gatewayEndpoint,
    apiKey: ctx.gatewayApiKey,
    serviceId: ctx.instanceId,
    timeoutMs: deps.config.metadataRemoteTimeoutMs,
    logger,
  };

  const snapshot: KnowledgeSnapshot | null = await fetchKnowledgeSnapshot(meta);
  if (!snapshot) {
    return { ok: false, message: 'cannot read the active model snapshot from core', outcome: 'error' };
  }

  try {
    const bindings = await fetchKsBindings(opts, logger);
    const outcome = await applyKnowledgeModelSnapshot({
      serviceId: ctx.instanceId,
      snapshot,
      cached: bindings.get(ctx.instanceId),
      opts,
      meta,
      logger,
    });
    if (outcome === 'error') {
      return { ok: false, message: `knowledge service binding sync ${outcome}`, outcome };
    }
    return {
      ok: true,
      message: snapshot.status,
      outcome,
      configId: snapshot.snapshot?.snapshot_id ?? null,
      configVersion: snapshot.snapshot?.version ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      outcome: 'error',
    };
  }
}
