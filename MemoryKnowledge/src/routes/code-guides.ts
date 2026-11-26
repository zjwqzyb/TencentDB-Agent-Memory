import { Hono } from 'hono';
import pilotObservations from '../engines/code/pilot-observations.json' with { type: 'json' };
import { isValidIdSegment, wrapError, wrapOk } from '../api-helpers.js';
import type { CodeGraphService } from '../store/code-graph-service.js';
import {
  CodeGuideStore,
  GuideConflict,
  guideInput,
  type GuideDocument,
  type GuideEdition,
} from '../store/code-guides.js';
import { structuredSdkInfo } from '../engines/code/bridge.js';
import { queryStructured, type StructuredContext } from '../engines/code/structured.js';
import { buildQueueGuide } from '../engines/code/build-queue-guide.js';
import { buildL1PilotGuide } from '../engines/code/l1-pilot-guide.js';

export function codeGuideRoutes(graphs: CodeGraphService, store: CodeGuideStore) {
  const app = new Hono();
  app.post('/:action', async (c) => {
    const service = c.req.header('x-tdai-service-id');
    const body = await c.req.json().catch(() => null);
    const asset = body?.code_graph_id;
    if (!isValidIdSegment(service) || !isValidIdSegment(asset))
      return c.json(wrapError(400, 'invalid asset'), 400);
    const row = graphs.getById(service, asset);
    if (!row) return c.json(wrapError(404, 'asset unavailable'), 404);
    const action = c.req.param('action');
    if (action === 'sources') {
      return c.json(wrapOk({ items: store.sourceAssets(service, asset) }));
    }
    const visible = new Set(Array.isArray(body.allowedSources) ? body.allowedSources : []);
    if (!visible.has(asset)) return c.json(wrapError(403, 'source unavailable'), 403);
    const canRead = (g: GuideEdition) =>
      g.sourceAssets.every((id) => visible.has(id) && graphs.getById(service, id));
    const contexts = new Map<string, StructuredContext>();
    async function context(id: string) {
      if (!visible.has(id)) return;
      const cached = contexts.get(id);
      if (cached) return cached;
      const source = graphs.getById(service!, id);
      if (!source || source.status !== 'ready') return;
      const root = graphs.dirFor(service!, source.team_id, id);
      const sdk = await structuredSdkInfo(root);
      const after = graphs.getById(service!, id);
      if (
        !after ||
        after.status !== 'ready' ||
        after.version !== source.version ||
        after.last_sync_at !== source.last_sync_at
      )
        return;
      const ctx = {
        assetId: id,
        projectRoot: root,
        databasePath: sdk.databasePath,
        sdkVersion: sdk.version,
        commit: source.commit_hash,
        version: source.version,
        indexedAt: source.last_sync_at,
        branch: source.branch,
      };
      contexts.set(id, ctx);
      return ctx;
    }
    async function staleReferences(doc: GuideDocument) {
      const invalid: { stepId: string; anchor: number }[] = [];
      const checks = new Map<string, boolean>();
      for (const step of doc.steps) {
        for (const [anchor, ref] of step.anchors.entries()) {
          const id = ref.assetId ?? asset;
          const version = ref.indexVersion ?? doc.indexVersion;
          const commit = ref.commit ?? doc.commit;
          const key = JSON.stringify([
            id,
            commit,
            version,
            ref.nodeId,
            ref.filePath,
            ref.line,
            ref.contentHash,
            ref.edgeId,
          ]);
          let valid = checks.get(key);
          if (valid === undefined) {
            try {
              const ctx = await context(id);
              const source =
                ctx?.commit === commit
                  ? queryStructured(ctx, 'graph-source', {
                      nodeId: ref.nodeId,
                      indexVersion: version,
                      sourceLine: ref.line,
                    })
                  : undefined;
              const symbol = source?.nodes.find((node) => node.id === ref.nodeId);
              valid =
                source?.state === 'ready' &&
                source.source?.filePath === ref.filePath &&
                source.source.contentHash === ref.contentHash &&
                !!symbol &&
                ref.line >= symbol.startLine &&
                ref.line <= symbol.endLine;
              if (valid && ctx && ref.edgeId) {
                const request = {
                  nodeId: ref.nodeId,
                  indexVersion: version,
                  direction: 'out' as const,
                  mode: 'calls' as const,
                };
                let page = queryStructured(ctx, 'graph', request);
                while (
                  !page.edges.some(
                    (e) =>
                      e.id === ref.edgeId &&
                      e.evidence.some(
                        (site) => site.filePath === ref.filePath && site.line === ref.line,
                      ),
                  )
                ) {
                  if (!page.nextCursor) {
                    valid = false;
                    break;
                  }
                  page = queryStructured(ctx, 'graph', { ...request, cursor: page.nextCursor });
                }
              }
            } catch {
              // A missing index or unreadable SDK database invalidates only this citation.
              valid = false;
            }
            checks.set(key, valid);
          }
          if (!valid) invalid.push({ stepId: step.id, anchor });
        }
      }
      return invalid;
    }
    async function current(doc: GuideDocument) {
      try {
        const ctx = await context(asset);
        if (!ctx || ctx.commit !== doc.commit) return false;
        const check = queryStructured(ctx, 'graph', { indexVersion: doc.indexVersion });
        return (
          check.indexVersion === doc.indexVersion &&
          (check.state === 'empty' || check.state === 'ready')
        );
      } catch {
        return false;
      }
    }
    if (['list', 'get', 'search', 'editor'].includes(action)) {
      if (action === 'get' && !isValidIdSegment(body.id))
        return c.json(wrapError(400, 'guide ID required'), 400);
      if (
        action === 'search' &&
        (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 240)
      )
        return c.json(wrapError(400, 'invalid search query'), 400);
      const items = [];
      for (const guide of store.list(service, asset, action === 'editor').filter(canRead)) {
        if (action === 'get' && guide.id !== body.id) continue;
        if (action === 'search') {
          const content = [
            guide.title,
            guide.topic,
            ...guide.steps.map((s) => s.title + ' ' + s.description),
          ]
            .join(' ')
            .toLowerCase();
          if (!content.includes(body.query.trim().toLowerCase())) continue;
        }
        const invalid = await staleReferences(guide);
        const stale = invalid.length > 0 || !(await current(guide));
        if (!stale || action === 'editor') {
          const record = guide.id === 'memhub-l1-search' || guide.id === 'memhub-build-queue'
            ? pilotObservations[guide.id] : undefined;
          items.push({
            ...guide,
            stale,
            ...(record && guide.origin === 'curated_template' && record.commit.startsWith(guide.commit)
              ? { observation:record } : {}),
            ...(action === 'editor' ? { staleReferences: invalid } : {}),
          });
        }
      }
      if (action === 'get')
        return items.length
          ? c.json(wrapOk(items[0]))
          : c.json(wrapError(404, 'guide unavailable'), 404);
      return c.json(wrapOk({ items }));
    }
    if (!isValidIdSegment(body.id)) return c.json(wrapError(400, 'guide ID required'), 400);
    const history = store.history(service, asset, body.id);
    const latest = history[0];
    if (latest && !canRead(latest)) return c.json(wrapError(404, 'guide unavailable'), 404);
    if (action === 'history')
      return c.json(
        wrapOk({
          items: history.filter(canRead),
          feedback: store.feedbackHistory(service, asset, body.id),
        }),
      );
    if (
      typeof body.actor !== 'string' ||
      !body.actor.trim() ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0
    )
      return c.json(wrapError(400, 'actor and revision required'), 400);
    if (action === 'feedback') {
      const edition = history.find(
        (g) => g.revision === body.revision && g.status === 'published' && canRead(g),
      );
      if (
        !edition?.steps.some((s) => s.id === body.stepId) ||
        typeof body.message !== 'string' ||
        !body.message.trim() ||
        body.message.length > 2000
      )
        return c.json(wrapError(400, 'invalid feedback'), 400);
      store.feedback(service, asset, edition, body.stepId, body.actor, body.message.trim());
      return c.json(wrapOk({ recorded: true }));
    }
    if ((latest?.revision ?? 0) !== body.revision)
      return c.json(wrapError(409, 'guide revision changed'), 409);
    let input: unknown;
    let status: GuideEdition['status'] = 'candidate';
    if (action === 'generate') {
      const ctx = await context(asset);
      if (!ctx) return c.json(wrapError(409, 'index unavailable'), 409);
      if (body.id === 'memhub-l1-search') input = buildL1PilotGuide(ctx);
      else if (body.id === 'memhub-build-queue') input = buildQueueGuide(ctx);
      else if (typeof body.query === 'string' && body.query.trim() && body.query.length <= 240) {
        const hits = queryStructured(ctx, 'graph-search', { query: body.query, limit: 8 });
        const steps = [];
        for (const node of hits.nodes) {
          if (!hits.indexVersion) break;
          const src = queryStructured(ctx, 'graph-source', {
            nodeId: node.id,
            indexVersion: hits.indexVersion,
          }).source;
          if (src)
            steps.push({
              id: 'symbol-' + steps.length,
              kind: 'reading',
              title: node.qualifiedName || node.name,
              description: node.filePath,
              anchors: [
                {
                  nodeId: node.id,
                  filePath: node.filePath,
                  line: node.startLine,
                  label: node.name,
                  contentHash: src.contentHash,
                },
              ],
            });
        }
        input = {
          id: body.id,
          topic: body.query,
          title: body.query,
          commit: ctx.commit,
          indexVersion: hits.indexVersion,
          steps,
        };
      }
      if (!input || !guideInput.safeParse(input).success)
        return c.json(wrapError(409, 'no verifiable candidate'), 409);
    } else if (action === 'save') input = body.document;
    else if (latest && (action === 'publish' || action === 'withdraw')) {
      const {
        sourceAssets,
        actor,
        updatedAt,
        status: previous,
        revision,
        origin,
        operation,
        ...document
      } = latest;
      input = document;
      status = action === 'publish' ? 'published' : 'withdrawn';
    } else return c.json(wrapError(400, 'unknown action or missing guide'), 400);
    const parsed = guideInput.safeParse(input);
    if (!parsed.success || parsed.data.id !== body.id)
      return c.json(wrapError(400, 'invalid guide'), 400);
    if (
      parsed.data.steps.some((step) => step.anchors.some((a) => !visible.has(a.assetId ?? asset)))
    )
      return c.json(wrapError(403, 'source unavailable'), 403);
    if (
      status !== 'withdrawn' &&
      (!(await current(parsed.data)) || (await staleReferences(parsed.data)).length > 0)
    )
      return c.json(wrapError(409, 'source changed or unavailable'), 409);
    try {
      return c.json(
        wrapOk(store.save(service, asset, parsed.data, body.revision, status, body.actor, action)),
      );
    } catch (error) {
      if (error instanceof GuideConflict)
        return c.json(wrapError(409, 'guide revision changed'), 409);
      throw error;
    }
  });
  return app;
}
