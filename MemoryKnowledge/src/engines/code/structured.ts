/** Bounded, read-only adapter for the verified CodeGraph 1.6.2 SQLite schema. */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { StructuredModeContext, NodeRow, EdgeRow, UnresolvedRow } from './structured-mode-context.js';
import { queryAggregation, queryClusters } from './structured-aggregation.js';
import { queryNeighborhood } from './structured-neighborhood.js';
import type { CodeGraphAction, CodeGraphCapabilities, CodeGraphEdge, CodeGraphNode, CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';

export const GRAPH_LIMITS = { nodes: 100, edges: 300, maxNodes: 500, maxEdges: 1500, depth: 5, rows: 2000, sourceBytes: 2 * 1024 * 1024, sourceLines: 300 } as const;
export interface StructuredContext { assetId: string; projectRoot: string; databasePath: string; sdkVersion: string; version: number; commit: string | null; indexedAt: string | null; branch: string; indexVersion?: string }
interface QueueItem { id: string; depth: number; side: number; after: number }
interface Walk { queue: QueueItem[]; seenNodes: string[]; seenEdges: number[] }
interface Cursor { asset: string; version: string; fingerprint: string; expires: number; after?: number; walk?: Walk; modeState?: unknown }
const cursors = new Map<string, Cursor>();
const MAX_CURSORS = 128;
const CURSOR_TTL = 10 * 60 * 1000;

export function capabilities(version: string): CodeGraphCapabilities {
  const verified = version === '1.6.2';
  return { sdkVersion: version, modes: {
    calls: { supported: verified, ...(!verified ? { reason: 'unverified_sdk_version' } : {}) },
    impact: { supported: verified, ...(!verified ? { reason: 'unverified_sdk_version' } : {}) }, dependencies: { supported: verified, ...(!verified ? { reason: 'unverified_sdk_version' } : {}) },
    clusters: { supported: verified, ...(verified ? { limitations: ['directory_grouping_not_semantic_communities', 'static_import_extraction_incomplete'] } : { reason: 'unverified_sdk_version' }) }, hierarchy: { supported: verified, ...(verified ? { limitations: ['typescript_interface_extends_not_extracted'] } : { reason: 'unverified_sdk_version' }) },
  }, languages: verified ? ['typescript', 'javascript'] : [], edgeKinds: verified ? ['calls', 'imports', 'extends', 'implements', 'references', 'contains'] : [] };
}
export function emptyResponse(context: Pick<StructuredContext, 'assetId' | 'sdkVersion' | 'commit' | 'indexedAt' | 'branch'>, state: CodeGraphResponse['state'], warning?: string): CodeGraphResponse {
  return { state, assetId: context.assetId, indexVersion: null, commit: context.commit, indexedAt: context.indexedAt, branch: context.branch,
    capabilities: capabilities(context.sdkVersion), nodes: [], edges: [], focusId: null, truncated: false, truncationReasons: [], nextCursor: null, warnings: warning ? [warning] : [] };
}
export function validateStructuredRequest(action: CodeGraphAction, raw: Record<string, unknown>): CodeGraphRequest {
  const allowed = new Set(['mode', 'nodeId', 'indexVersion', 'direction', 'depth', 'scopePath', 'query', 'nodeKinds', 'edgeKinds', 'limit', 'edgeLimit', 'cursor', 'groupBy', 'moduleDepth', 'evidenceFor', 'sourceLine']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`unexpected field: ${key}`);
  for (const key of ['nodeId', 'indexVersion', 'scopePath', 'query', 'cursor', 'evidenceFor'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || (raw[key] as string).length > 1024)) throw new Error(`invalid ${key}`);
  }
  if (raw.mode !== undefined && (typeof raw.mode !== 'string' || !['calls', 'impact', 'dependencies', 'clusters', 'hierarchy'].includes(raw.mode))) throw new Error('invalid mode');
  if (raw.direction !== undefined && (typeof raw.direction !== 'string' || !['in', 'out', 'both'].includes(raw.direction))) throw new Error('invalid direction');
  for (const [key, max] of [['limit', GRAPH_LIMITS.maxNodes], ['edgeLimit', GRAPH_LIMITS.maxEdges], ['depth', GRAPH_LIMITS.depth], ['moduleDepth', 10]] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isInteger(raw[key]) || (raw[key] as number) < 1 || (raw[key] as number) > max)) throw new Error(`invalid ${key}: 1..${max}`);
  }
  if (raw.groupBy !== undefined && (typeof raw.groupBy !== 'string' || !['directory', 'file', 'symbol'].includes(raw.groupBy))) throw new Error('invalid groupBy');
  if (raw.sourceLine !== undefined && (action !== 'graph-source' || typeof raw.sourceLine !== 'number' || !Number.isSafeInteger(raw.sourceLine) || raw.sourceLine < 1 || raw.sourceLine > GRAPH_LIMITS.sourceBytes + 1)) throw new Error('invalid sourceLine');
  if (raw.mode === 'impact' && raw.direction !== undefined && raw.direction !== 'in') throw new Error('impact direction must be in');
  if (action === 'graph' && raw.limit === 1) throw new Error('graph limit must be at least 2');
  for (const key of ['nodeKinds', 'edgeKinds'] as const) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length > 20 || !raw[key].every(v => typeof v === 'string' && /^[a-z_]+$/.test(v)))) throw new Error(`invalid ${key}`);
  }
  const scope = raw.scopePath as string | undefined;
  if (scope && (isAbsolute(scope) || scope.includes('\\') || scope.split('/').includes('..') || scope.includes('\0'))) throw new Error('invalid scopePath');
  if (((action === 'graph-node' || action === 'graph-source') && (!raw.nodeId || !raw.indexVersion)) || ((raw.nodeId || raw.evidenceFor) && !raw.indexVersion)) throw new Error('nodeId and indexVersion are required');
  return raw as CodeGraphRequest;
}
function wireId(asset: string, raw: string): string { return `${asset}:${raw}`; }
function rawId(asset: string, id: string): string | null { return id.startsWith(`${asset}:`) ? id.slice(asset.length + 1) : null; }
function node(context: StructuredContext, row: NodeRow): CodeGraphNode {
  return { id: wireId(`${context.assetId}@${context.indexVersion}`, row.id), name: row.name, qualifiedName: row.qualified_name, kind: row.kind,
    filePath: row.file_path, language: row.language, startLine: row.start_line, endLine: row.end_line,
    ...(typeof row.signature === 'string' && row.signature ? { signature: row.signature } : {}) };
}
function issueCursor(value: Cursor): string {
  const now = Date.now();
  for (const [key, cursor] of cursors) if (cursor.expires < now) cursors.delete(key);
  while (cursors.size >= MAX_CURSORS) cursors.delete(cursors.keys().next().value!);
  const token = randomUUID(); cursors.set(token, structuredClone(value)); return token;
}
function snapshot(ctx: StructuredContext): string {
  // Include WAL/file state as well as store generation: even out-of-band SDK writes expire cursors.
  const identity = (path: string) => {
    try { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.birthtimeNs}`; }
    catch (error) { if (path.endsWith('-wal') && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'; throw error; }
  };
  return createHash('sha256').update(`${ctx.assetId}:${ctx.version}:${ctx.indexedAt}:${identity(ctx.databasePath)}:${identity(ctx.databasePath + '-wal')}`).digest('hex').slice(0, 32);
}
function indexedColumns(db: Database.Database, name: string, expected: string[]): boolean {
  const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as { seqno: number; name: string }[]).sort((a,b) => a.seqno-b.seqno).map(row => row.name);
  return expected.every((column,i) => columns[i] === column);
}
function validateSchema(db: Database.Database): boolean {
  const columns: Record<string, string[]> = {
    nodes: ['id', 'kind', 'name', 'qualified_name', 'file_path', 'language', 'start_line', 'end_line'],
    edges: ['id', 'source', 'target', 'kind', 'line', 'col'], files: ['path', 'content_hash'],
  };
  for (const [table, required] of Object.entries(columns)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number; type: string }[];
    const found = new Set(info.map(row => row.name));
    if (!required.every(name => found.has(name))) return false;
    const primary = table === 'files' ? 'path' : 'id';
    if (info.filter(row => row.pk > 0).length !== 1 || !info.some(row => row.name === primary && row.pk === 1)) return false;
    if (table === 'edges' && !info.some(row => row.name === 'id' && row.type.toUpperCase() === 'INTEGER')) return false;
  }
  // Force only verified composite adjacency indexes, avoiding a full-edge scan fallback.
  const indices = new Set((db.prepare('PRAGMA index_list(edges)').all() as { name: string }[]).map(row => row.name));
  return indices.has('idx_edges_source_kind') && indices.has('idx_edges_target_kind')
    && indexedColumns(db, 'idx_edges_source_kind', ['source', 'kind']) && indexedColumns(db, 'idx_edges_target_kind', ['target', 'kind']);
}

export function queryStructured(ctx: StructuredContext, action: CodeGraphAction, request: CodeGraphRequest): CodeGraphResponse {
  const result = emptyResponse(ctx, 'ready');
  if (!result.capabilities.modes.calls.supported) return { ...result, state: 'unsupported', warnings: ['unverified_sdk_version'] };
  const indexVersion = snapshot(ctx); result.indexVersion = indexVersion;
  ctx = { ...ctx, indexVersion };
  const idNamespace = `${ctx.assetId}@${indexVersion}`;
  if (request.indexVersion && request.indexVersion !== indexVersion) return { ...result, state: 'version_expired', warnings: ['index_version_changed'] };
  const mode = request.mode ?? 'calls';
  if (action === 'graph' && !result.capabilities.modes[mode].supported) return { ...result, state: 'unsupported', warnings: ['mode_not_implemented'] };
  const { cursor: _cursor, ...query } = request;
  const aggregateMode = mode === 'dependencies' || mode === 'clusters';
  const defaultKinds = mode === 'impact' ? ['calls', 'imports', 'extends', 'implements', 'references'] : mode === 'hierarchy' ? ['extends', 'implements'] : aggregateMode ? ['imports'] : ['calls'];
  const canonical = { action, mode, edgeKinds: defaultKinds, ...(aggregateMode ? { groupBy: 'directory', moduleDepth: 1 } : {}), direction: mode === 'impact' ? 'in' : 'both', depth: mode === 'impact' ? 2 : 1, limit: GRAPH_LIMITS.nodes, edgeLimit: GRAPH_LIMITS.edges, ...query, indexVersion };
  const fingerprint = JSON.stringify(Object.fromEntries(Object.entries(canonical).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])));
  let continuation: Cursor | undefined;
  if (request.cursor) {
    continuation = cursors.get(request.cursor);
    if (!continuation || continuation.expires < Date.now() || continuation.asset !== ctx.assetId || continuation.version !== indexVersion || continuation.fingerprint !== fingerprint) {
      return { ...result, state: 'version_expired', warnings: ['cursor_expired_or_query_changed'] };
    }
  }
  const db = new Database(ctx.databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!validateSchema(db)) return { ...result, state: 'unsupported', capabilities: { ...result.capabilities, modes: Object.fromEntries(Object.keys(result.capabilities.modes).map(key => [key, { supported: false, reason: 'unsupported_index_schema' }])) as CodeGraphCapabilities['modes'] }, warnings: ['unsupported_index_schema'] };
    return db.transaction((): CodeGraphResponse => {
      let rowsRead = 0;
      const getNode = (id: string): NodeRow | undefined => { rowsRead++; return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined; };
      const limit = request.limit ?? GRAPH_LIMITS.nodes;
      const next = (data: Partial<Cursor>) => issueCursor({ asset: ctx.assetId, version: indexVersion, fingerprint, expires: Date.now() + CURSOR_TTL, ...data });
      const finish = (): CodeGraphResponse => {
        result.work = { rowsRead, maxRows: GRAPH_LIMITS.rows };
        if (snapshot(ctx) !== indexVersion) return { ...result, state: 'version_expired', nodes: [], edges: [], source: undefined, impactPaths: undefined, unresolved: undefined, aggregation: undefined, clustering: undefined, cycles: undefined, dependencyEvidence: undefined, nextCursor: null, warnings: ['index_changed_during_query'] };
        const unverified = [...new Set(result.nodes.filter(n => !n.aggregate).map(n => n.language).filter(language => !result.capabilities.languages.includes(language)))];
        if (unverified.length) result.warnings.push(...unverified.map(language => `unverified_language:${language}`));
        if (result.state === 'ready' && result.nodes.length === 0 && !result.dependencyEvidence?.length) result.state = 'empty';
        return result;
      };
      if (action === 'graph-search' || action === 'graph-tree') {
        let after = continuation?.after ?? 0;
        const matches: CodeGraphNode[] = [];
        const scope = request.scopePath?.replace(/\/$/, '') ?? '';
        const needle = (request.query ?? '').toLocaleLowerCase();
        let exhausted = false;
        while (matches.length < limit && rowsRead < GRAPH_LIMITS.rows - 1) {
          // Keyset scan windows bound work even on a nonselective search; no unbounded LIKE/ORDER scan.
          const take = Math.min(100, GRAPH_LIMITS.rows - 1 - rowsRead);
          const batch = db.prepare('SELECT rowid, * FROM nodes WHERE rowid > ? ORDER BY rowid LIMIT ?').all(after, take) as NodeRow[];
          rowsRead += batch.length;
          if (!batch.length) { exhausted = true; break; }
          for (const row of batch) {
            after = row.rowid!;
            if (action === 'graph-tree' && row.kind !== 'file') continue;
            if (scope && row.file_path !== scope && !row.file_path.startsWith(`${scope}/`)) continue;
            if (request.nodeKinds?.length && !request.nodeKinds.includes(row.kind)) continue;
            if (needle && !`${row.name} ${row.qualified_name} ${row.file_path}`.toLocaleLowerCase().includes(needle)) continue;
            matches.push(node(ctx, row));
            if (matches.length === limit) break;
          }
          if (batch.length < take && after === batch.at(-1)?.rowid) { exhausted = true; break; }
        }
        result.nodes = matches;
        if (!exhausted) {
          rowsRead++;
          const more = db.prepare('SELECT rowid FROM nodes WHERE rowid > ? LIMIT 1').get(after);
          if (more) { result.truncated = true; result.truncationReasons = [matches.length >= limit ? 'node_budget' : 'scan_budget']; result.nextCursor = next({ after }); }
        }
        return finish();
      }
      const modeContext = (modeRoot?: NodeRow): StructuredModeContext => {
        const unresolvedInfo = db.prepare('PRAGMA table_info(unresolved_refs)').all() as { name: string; pk: number; type: string }[];
        const unresolvedColumns = new Set(unresolvedInfo.map(r => r.name));
        const unresolvedIndices = new Set((db.prepare('PRAGMA index_list(unresolved_refs)').all() as { name: string }[]).map(r => r.name));
        const hasUnresolved = ['id', 'from_node_id', 'reference_name', 'reference_kind', 'file_path', 'line', 'col'].every(k => unresolvedColumns.has(k)) && unresolvedIndices.has('idx_unresolved_from_node') && indexedColumns(db, 'idx_unresolved_from_node', ['from_node_id']) && unresolvedInfo.some(row => row.name === 'id' && row.pk === 1 && row.type.toUpperCase() === 'INTEGER');
        const remaining = () => GRAPH_LIMITS.rows - rowsRead;
        const consume = (count: number) => { if (count < 0 || count > remaining()) throw new Error('structured_work_budget_exceeded'); rowsRead += count; };
        const take = (wanted: number) => Math.max(0, Math.min(wanted, remaining()));
        const env: StructuredModeContext = {
          db, ctx, request, result, root: modeRoot, state: continuation?.modeState, limits: GRAPH_LIMITS, remaining, consume, hasUnresolved,
          lookup(id) { if (!remaining()) throw new Error('structured_work_budget_exceeded'); return getNode(id); },
          readNodes(after, wanted) { const count = take(wanted); if (!count) return []; const rows = db.prepare('SELECT rowid,* FROM nodes WHERE rowid > ? ORDER BY rowid LIMIT ?').all(after, count) as NodeRow[]; consume(rows.length || 1); return rows; },
          readEdges(after, wanted) { const count = take(wanted); if (!count) return []; const rows = db.prepare('SELECT * FROM edges WHERE id > ? ORDER BY id LIMIT ?').all(after, count) as EdgeRow[]; consume(rows.length || 1); return rows; },
          readUnresolved(after, wanted) { const count = take(wanted); if (!count || !hasUnresolved) return []; const rows = db.prepare('SELECT * FROM unresolved_refs WHERE id > ? ORDER BY id LIMIT ?').all(after, count) as UnresolvedRow[]; consume(rows.length || 1); return rows; },
          adjacent(id, side, kind, after) { if (!remaining()) return undefined; consume(1); return db.prepare(`SELECT * FROM edges INDEXED BY idx_edges_${side}_kind WHERE ${side} = ? AND kind = ? AND id > ? ORDER BY id LIMIT 1`).get(id, kind, after) as EdgeRow | undefined; },
          unresolvedFrom(id, after, wanted) { const count = take(wanted); if (!count || !hasUnresolved) return []; const rows = db.prepare('SELECT * FROM unresolved_refs INDEXED BY idx_unresolved_from_node WHERE from_node_id = ? AND id > ? ORDER BY id LIMIT ?').all(id, after, count) as UnresolvedRow[]; consume(rows.length || 1); return rows; },
          toNode: row => node(ctx, row),
          toEdge: (edge, source): CodeGraphEdge => ({ id: `${idNamespace}:edge:${edge.id}`, source: wireId(idNamespace, edge.source), target: wireId(idNamespace, edge.target), kind: edge.kind, evidence: [{ filePath: source.file_path, line: edge.line ?? source.start_line, ...(edge.col !== null ? { column: edge.col } : {}) }] }),
          id: raw => wireId(idNamespace, raw), rawId: id => rawId(idNamespace, id),
          setContinuation: modeState => { result.nextCursor = next({ modeState }); },
        };
        return env;
      };
      if (action === 'graph' && aggregateMode) {
        let selected: NodeRow | undefined;
        if (request.nodeId) {
          const id = rawId(idNamespace, request.nodeId);
          selected = id ? getNode(id) : undefined;
          if (!selected) return { ...finish(), state: 'not_found', warnings: ['node_not_in_asset'] };
        }
        (mode === 'clusters' ? queryClusters : queryAggregation)(modeContext(selected));
        return finish();
      }
      const rootId = request.nodeId ? rawId(idNamespace, request.nodeId) : null;
      if (!rootId) return { ...finish(), state: request.nodeId ? 'not_found' : 'empty', warnings: [request.nodeId ? 'node_not_in_asset' : 'select_a_node'] };
      const root = getNode(rootId);
      if (!root) return { ...finish(), state: 'not_found', warnings: ['node_not_found'] };
      result.focusId = wireId(idNamespace, rootId); result.nodes = [node(ctx, root)];
      if (action === 'graph-node') return finish();
      if (action === 'graph-source') {
        const file = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(root.file_path) as { content_hash: string } | undefined; rowsRead++;
        if (!file) return { ...finish(), state: 'source_unavailable', warnings: ['source_hash_missing'] };
        try {
          const base = realpathSync(ctx.projectRoot);
          if (isAbsolute(root.file_path) || root.file_path.includes('\0')) throw new Error('unsafe_source_path');
          const path = resolve(base, root.file_path);
          const real = realpathSync(path); const rel = relative(base, real);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('unsafe_source_path');
          const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > GRAPH_LIMITS.sourceBytes) throw new Error('source_size_limit');
            const checkedReal = realpathSync(real);
            const checkedRel = relative(base, checkedReal);
            const checkedStat = statSync(checkedReal);
            if (checkedRel === '..' || checkedRel.startsWith(`..${sep}`) || isAbsolute(checkedRel) || checkedStat.dev !== stat.dev || checkedStat.ino !== stat.ino) throw new Error('unsafe_source_path');
            const buffer = Buffer.alloc(GRAPH_LIMITS.sourceBytes + 1);
            let length = 0, count = 0;
            do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
            if (length > GRAPH_LIMITS.sourceBytes) throw new Error('source_size_limit');
            const bytes = buffer.subarray(0, length);
            if (createHash('sha256').update(bytes).digest('hex') !== file.content_hash) return { ...finish(), state: 'version_expired', warnings: ['source_changed_since_index'] };
            const lines = bytes.toString('utf8').split('\n');
            if (request.sourceLine !== undefined && (!Number.isSafeInteger(request.sourceLine) || request.sourceLine < 1 || request.sourceLine > lines.length)) throw new Error('source_line_out_of_range');
            const startLine = request.sourceLine === undefined ? Math.max(1, root.start_line) : Math.max(1, request.sourceLine - 50);
            const requestedEnd = request.sourceLine === undefined ? root.end_line : lines.length;
            const endLine = Math.min(lines.length, requestedEnd, startLine + GRAPH_LIMITS.sourceLines - 1);
            result.source = { nodeId: result.focusId!, filePath: root.file_path, startLine, endLine, content: lines.slice(startLine - 1, endLine).join('\n'), contentHash: file.content_hash };
            if (endLine < requestedEnd || (request.sourceLine !== undefined && startLine > 1)) { result.truncated = true; result.truncationReasons.push('source_line_budget'); }
          } finally { closeSync(fd); }
        } catch (error) { result.state = 'source_unavailable'; result.warnings.push(error instanceof Error && ['unsafe_source_path', 'source_size_limit', 'source_line_out_of_range'].includes(error.message) ? error.message : 'source_read_failed'); }
        return finish();
      }
      if (!result.capabilities.languages.includes(root.language)) return { ...finish(), state: 'unsupported', warnings: ['unverified_language:' + root.language] };
      if (mode === 'impact' || mode === 'hierarchy') {
        queryNeighborhood(modeContext(root), mode);
        return finish();
      }
      if (request.edgeKinds?.length && !request.edgeKinds.includes('calls')) { result.state = 'empty'; return finish(); }
      const direction = request.direction ?? 'both';
      const sides = direction === 'both' ? ['source', 'target'] : [direction === 'out' ? 'source' : 'target'];
      const depth = request.depth ?? 1;
      const edgeLimit = request.edgeLimit ?? GRAPH_LIMITS.edges;
      const walk: Walk = structuredClone(continuation?.walk ?? { queue: [{ id: rootId, depth: 0, side: 0, after: 0 }], seenNodes: [rootId], seenEdges: [] });
      const visited = new Set(walk.seenNodes), emitted = new Set(walk.seenEdges);
      const pageNodes = new Map((continuation ? [] : result.nodes).map(n => [n.id, n]));
      const cache = new Map<string, NodeRow | undefined>([[rootId, root]]);
      const lookup = (id: string) => { if (!cache.has(id)) cache.set(id, getNode(id)); return cache.get(id); };
      let hardLimit = false;
      while (walk.queue.length && result.edges.length < edgeLimit && rowsRead < GRAPH_LIMITS.rows - 3) {
        const item = walk.queue[0];
        if (item.depth >= depth || item.side >= sides.length) { walk.queue.shift(); continue; }
        const side = sides[item.side];
        // Composite (source|target, kind, rowid) order supports bounded keyset access.
        const edge = db.prepare(`SELECT * FROM edges INDEXED BY idx_edges_${side}_kind WHERE ${side} = ? AND kind = 'calls' AND id > ? ORDER BY id LIMIT 1`).get(item.id, item.after) as EdgeRow | undefined;
        rowsRead++;
        if (!edge) { item.side++; item.after = 0; continue; }
        if (emitted.has(edge.id)) { item.after = edge.id; continue; }
        const source = lookup(edge.source), target = lookup(edge.target);
        if (!source || !target) { item.after = edge.id; result.warnings.push('dangling_edge_omitted'); continue; }
        const neighbor = side === 'source' ? target : source;
        if ((request.scopePath && !neighbor.file_path.startsWith(request.scopePath.replace(/\/$/, '') + '/') && neighbor.file_path !== request.scopePath) || (request.nodeKinds?.length && !request.nodeKinds.includes(neighbor.kind))) { item.after = edge.id; continue; }
        const additions = [source, target].filter((n, i, all) => all.findIndex(x => x.id === n.id) === i && !pageNodes.has(wireId(idNamespace, n.id)));
        if (pageNodes.size + additions.length > limit) break;
        if ((!visited.has(neighbor.id) && visited.size >= GRAPH_LIMITS.maxNodes) || emitted.size >= GRAPH_LIMITS.maxEdges) { hardLimit = true; break; }
        for (const row of additions) pageNodes.set(wireId(idNamespace, row.id), node(ctx, row));
        result.edges.push({ id: `${idNamespace}:edge:${edge.id}`, source: wireId(idNamespace, source.id), target: wireId(idNamespace, target.id), kind: edge.kind,
          evidence: [{ filePath: source.file_path, line: edge.line ?? source.start_line, ...(edge.col !== null ? { column: edge.col } : {}) }] });
        emitted.add(edge.id); item.after = edge.id;
        if (!visited.has(neighbor.id)) { visited.add(neighbor.id); walk.queue.push({ id: neighbor.id, depth: item.depth + 1, side: 0, after: 0 }); }
      }
      result.nodes = [...pageNodes.values()];
      while (walk.queue.length && (walk.queue[0].depth >= depth || walk.queue[0].side >= sides.length)) walk.queue.shift();
      if (walk.queue.length) {
        result.truncated = true;
        result.truncationReasons = [hardLimit ? 'traversal_budget' : rowsRead >= GRAPH_LIMITS.rows - 3 ? 'scan_budget' : result.edges.length >= edgeLimit ? 'edge_budget' : 'node_budget'];
        if (!hardLimit) result.nextCursor = next({ walk: { ...walk, seenNodes: [...visited], seenEdges: [...emitted] } });
      }
      return finish();
    })();
  } finally { db.close(); }
}
