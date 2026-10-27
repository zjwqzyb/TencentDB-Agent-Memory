/**
 * Manual Knowledge Service re-sync for the managed model binding.
 *
 *   POST /api/v1/meta/instance-upstream/extraction/resync-knowledge
 *
 * Why this exists: `enable` returns 502 when the KS push fails, but Core has
 * already committed the new snapshot, so retrying `enable` returns 409. Before
 * this endpoint the only recovery was restarting Panel (startup reconcile).
 * This lets a system_admin retry the KS push in place.
 *
 * Read-only with respect to Core: it re-reads the Bearer-only active snapshot
 * and reconciles KS. It never writes Core config and never exposes the key.
 */

import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import { syncKnowledgeBindingFromCore } from '../knowledge/model-binding-sync.js';
import { toMetaContext, verifyAdminCaller } from './model-config-test.js';

export async function handleModelConfigResync(c: Context, deps: PanelDeps): Promise<Response> {
  const ctx = toMetaContext(c);

  const caller = await verifyAdminCaller(deps, ctx);
  if (!caller) return respondControlError(c, 403, 'PERMISSION_DENIED');

  const result = await syncKnowledgeBindingFromCore(deps, ctx);
  if (!result.ok) {
    deps.logger.error('knowledge binding re-sync failed', {
      instanceId: ctx.instanceId,
      outcome: result.outcome ?? 'error',
    });
    return respondControlError(c, 502, `KNOWLEDGE_SYNC_FAILED: ${result.message}`);
  }

  deps.logger.info('knowledge binding re-synced', {
    instanceId: ctx.instanceId,
    status: result.message,
    configId: result.configId ?? null,
    configVersion: result.configVersion ?? null,
    outcome: result.outcome ?? null,
  });

  return respondEnvelope(c, {
    code: 0,
    message: 'ok',
    request_id: ctx.reqId ?? '',
    data: {
      status: result.message,
      config_id: result.configId ?? null,
      config_version: result.configVersion ?? null,
      outcome: result.outcome ?? null,
    },
  });
}
