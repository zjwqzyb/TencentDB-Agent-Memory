import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import { buildCtx, readJson, str, requireKnowledgeRead, runKs } from './common.js';

export function registerCodeGuideRoutes(api: Hono, deps: PanelDeps) {
  const mw = validatePanelMetaHeaders(deps);
  for (const action of ['list', 'compare']) {
    api.post('/knowledge/code-graph/reviews/' + action, mw, async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const asset = str(body, 'code_graph_id');
      if (!asset) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
      const gate = await requireKnowledgeRead(deps, c, ctx, asset);
      if ('error' in gate) return gate.error;
      return runKs(c, () =>
        deps.knowledgeClientFactory(ctx.instanceId).codeReview(asset, action, body),
      );
    });
  }
  for (const action of [
    'list',
    'get',
    'search',
    'editor',
    'history',
    'generate',
    'save',
    'publish',
    'withdraw',
    'feedback',
  ]) {
    api.post('/knowledge/code-graph/guides/' + action, mw, async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const asset = str(body, 'code_graph_id');
      if (!asset) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
      const permission = ['list', 'get', 'search', 'feedback'].includes(action) ? 'read' : 'write';
      const gate = await requireKnowledgeRead(deps, c, ctx, asset, { action: permission });
      if ('error' in gate) return gate.error;
      const client = deps.knowledgeClientFactory(ctx.instanceId);
      return runKs(c, async () => {
        const refs = (await client.codeGuide(asset, 'sources', {})) as { items: string[] };
        const sourceIds = new Set(refs.items);
        if (action === 'save') {
          const doc = body.document as
            { steps?: { anchors?: { assetId?: string }[] }[] } | undefined;
          if (Array.isArray(doc?.steps) && doc.steps.length <= 64) {
            for (const step of doc.steps)
              if (Array.isArray(step?.anchors) && step.anchors.length <= 16) {
                for (const ref of step.anchors)
                  if (typeof ref?.assetId === 'string') sourceIds.add(ref.assetId);
              }
          }
        }
        const allowedSources = [asset];
        for (const id of sourceIds) {
          if (id === asset) continue;
          const result = await requireKnowledgeRead(deps, c, ctx, id);
          if (!('error' in result)) allowedSources.push(id);
        }
        return client.codeGuide(asset, action, { ...body, actor: gate.userId, allowedSources });
      });
    });
  }
}
