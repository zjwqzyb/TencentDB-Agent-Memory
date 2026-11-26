import { Hono } from 'hono';
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidIdSegment, wrapError, wrapOk } from '../api-helpers.js';
import type { CodeGraphService } from '../store/code-graph-service.js';
import {
  findCodeGraphHistory,
  readHistoricalTree,
  type HistoricalCodeGraphSnapshot,
} from '../store/code-graph-history.js';
import {
  changedFiles,
  compareSymbols,
  reviewContext,
  type FileChange,
} from '../engines/code/commit-comparison.js';

const git = promisify(execFile);
const commitId = /^[a-f0-9]{40}$/;
async function renames(root: string, before: string, after: string, changes: FileChange[]) {
  // Identical-blob pairs also work when the live clone no longer contains both commits.
  const result = await git(
    'git',
    [
      '-C',
      root,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '-M',
      '--diff-filter=R',
      before,
      after,
      '--',
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 5000 },
  );
  const fields = result.stdout.split('\0');
  const old = new Map(changes.filter((c) => c.kind === 'deleted').map((c) => [c.oldPath, c]));
  const next = new Map(changes.filter((c) => c.kind === 'added').map((c) => [c.newPath, c]));
  const replaced = new Set<FileChange>();
  const pairs: FileChange[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [score, from, to] = fields.slice(i, i + 3);
    const a = old.get(from),
      b = next.get(to);
    if (!/^R\d+$/.test(score) || !a || !b) continue;
    replaced.add(a);
    replaced.add(b);
    pairs.push({
      kind: 'uncertain',
      oldPath: from,
      newPath: to,
      evidence: 'git_similarity_' + score.slice(1),
    });
  }
  return [...changes.filter((c) => !replaced.has(c)), ...pairs];
}
function summary(s: HistoricalCodeGraphSnapshot) {
  return { commit: s.commit, indexedAt: s.indexedAt, branch: s.branch, version: s.version };
}
export function codeReviewRoutes(graphs: CodeGraphService) {
  const app = new Hono();
  app.post('/:action', async (c) => {
    const service = c.req.header('x-tdai-service-id');
    const body = await c.req.json().catch(() => null);
    const asset = body?.code_graph_id;
    if (!isValidIdSegment(service) || !isValidIdSegment(asset))
      return c.json(wrapError(400, 'invalid asset'), 400);
    const row = graphs.getById(service, asset);
    if (!row) return c.json(wrapError(404, 'asset unavailable'), 404);
    const root = graphs.dirFor(service, row.team_id, asset);
    const history = graphs.historyDirFor(service, row.team_id, asset);
    const action = c.req.param('action');
    if (action === 'list') {
      let names: string[];
      try {
        names = readdirSync(history);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return c.json(wrapOk({ items: [] }));
        throw err;
      }
      const items = [];
      for (const commit of new Set(
        names.filter((n) => /^[a-f0-9]{40}-v\d+$/.test(n)).map((n) => n.slice(0, 40)),
      )) {
        const result = findCodeGraphHistory(history, commit);
        if (result.kind === 'ready') items.push(summary(result.snapshot));
      }
      return c.json(
        wrapOk({ items: items.sort((a, b) => b.indexedAt.localeCompare(a.indexedAt)) }),
      );
    }
    if (
      action !== 'compare' ||
      !commitId.test(body.before) ||
      !commitId.test(body.after) ||
      body.before === body.after
    )
      return c.json(wrapError(400, 'two different full commits required'), 400);
    const left = findCodeGraphHistory(history, body.before),
      right = findCodeGraphHistory(history, body.after);
    if (left.kind !== 'ready' || right.kind !== 'ready') {
      return c.json(
        wrapOk({
          state: 'unavailable',
          reason: 'historical_snapshot_unavailable',
          before: left.kind,
          after: right.kind,
          available: {
            before: left.kind === 'ready' ? summary(left.snapshot) : null,
            after: right.kind === 'ready' ? summary(right.snapshot) : null,
          },
        }),
      );
    }
    try {
      const oldTree = readHistoricalTree(left.snapshot),
        newTree = readHistoricalTree(right.snapshot);
      if (!oldTree || !newTree)
        return c.json(
          wrapOk({
            state: 'unavailable',
            reason: 'git_tree_unavailable',
            before: oldTree ? 'ready' : 'tree_unavailable',
            after: newTree ? 'ready' : 'tree_unavailable',
            available: { before: summary(left.snapshot), after: summary(right.snapshot) },
          }),
        );
      let changes = changedFiles(oldTree, newTree);
      try {
        changes = await renames(root, body.before, body.after, changes);
      } catch {
        /* Immutable tree evidence is sufficient for path-level comparison. */
      }
      if (!graphs.getById(service, asset)) return c.json(wrapError(404, 'asset unavailable'), 404);
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        return c.json(wrapError(400, 'invalid offset'), 400);
      if (body.oldPath !== undefined || body.newPath !== undefined) {
        const file = changes.find((f) => f.oldPath === body.oldPath && f.newPath === body.newPath);
        if (!file) return c.json(wrapError(404, 'change not found'), 404);
        return c.json(
          wrapOk({
            state: 'ready',
            file,
            ...compareSymbols(
              reviewContext(asset, left.snapshot),
              reviewContext(asset, right.snapshot),
              file,
            ),
          }),
        );
      }
      return c.json(
        wrapOk({
          state: 'ready',
          before: summary(left.snapshot),
          after: summary(right.snapshot),
          files: changes.slice(offset, offset + 100),
          total: changes.length,
          nextOffset: offset + 100 < changes.length ? offset + 100 : null,
        }),
      );
    } catch {
      return c.json(
        wrapOk({
          state: 'unavailable',
          reason: 'comparison_evidence_unavailable',
          before: 'snapshot_retained',
          after: 'snapshot_retained',
          available: { before: summary(left.snapshot), after: summary(right.snapshot) },
        }),
      );
    }
  });
  return app;
}
