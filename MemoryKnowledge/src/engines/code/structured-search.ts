import type Database from 'better-sqlite3';
import type { CodeGraphAction, CodeGraphRequest } from '../../contracts/code-graph.js';
import type { NodeRow } from './structured-mode-context.js';

/** All positions belong to the dispatcher-owned, immutable index snapshot. */
export interface SearchState { stage: number; after: number; key?: string; equalDone?: boolean }
interface Stage { index?: string; key: string; equal?: string; lower?: string; upper?: string; excludeLower?: boolean; fallback?: boolean }
interface WindowRow extends NodeRow { rowid: number; search_key: string; search_match: number; candidate_count: number }
type Bind = string | number;

// SQLite's built-in lower() folds ASCII only. Keep its indexed semantics here;
// the original Unicode-aware substring predicate still runs on every candidate.
const sqliteLower = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());
function prefixEnd(prefix: string): string | undefined {
  const points = Array.from(prefix, c => c.codePointAt(0)!);
  while (points.length) {
    const last = points.pop()!;
    if (last < 0x10ffff) return String.fromCodePoint(...points, last === 0xd7ff ? 0xe000 : last + 1);
  }
  return undefined;
}

/** An index name alone does not prove its expression, collation or coverage. */
function hasIndex(db: Database.Database, name: string, column: string, expression = false): boolean {
  const listed = (db.prepare('PRAGMA index_list(nodes)').all() as { name: string; partial: number }[]).find(i => i.name === name);
  if (!listed || listed.partial) return false;
  const keys = (db.prepare(`PRAGMA index_xinfo(${name})`).all() as { name: string | null; cid: number; key: number; desc: number; coll: string }[]).filter(i => i.key);
  if (keys.length !== 1 || keys[0].desc || keys[0].coll !== 'BINARY') return false;
  if (!expression) return keys[0].name === column;
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes' AND name = ?").get(name) as { sql: string } | undefined;
  return keys[0].cid === -2 && !!definition && /\bon\s+"?nodes"?\s*\(\s*lower\s*\(\s*"?name"?\s*\)\s*\)\s*;?\s*$/i.test(definition.sql);
}

export function querySearch(db: Database.Database, action: CodeGraphAction, request: CodeGraphRequest, saved: SearchState | undefined, maxRows: number): {
  rows: NodeRow[]; rowsRead: number; continuation?: SearchState; reason?: 'node_budget' | 'scan_budget';
} {
  const scope = request.scopePath?.replace(/\/$/, '') ?? '';
  const query = request.query ?? '';
  const needle = query.toLocaleLowerCase();
  const folded = sqliteLower(query);
  const nameIndex = query && (hasIndex(db, 'idx_nodes_lower_name', 'name', true) ? 'idx_nodes_lower_name' : hasIndex(db, 'idx_nodes_name', 'name') ? 'idx_nodes_name' : undefined);
  const nameKey = nameIndex === 'idx_nodes_lower_name' ? 'lower(name)' : 'name';
  const indexedNeedle = nameIndex === 'idx_nodes_lower_name' ? folded : query;
  const stages: Stage[] = [];
  if (nameIndex) {
    stages.push({ index: nameIndex, key: nameKey, equal: indexedNeedle });
    stages.push({ index: nameIndex, key: nameKey, lower: indexedNeedle, upper: prefixEnd(indexedNeedle), excludeLower: true });
  }
  if (scope && hasIndex(db, 'idx_nodes_file_path', 'file_path')) {
    stages.push({ index: 'idx_nodes_file_path', key: 'file_path', equal: scope, fallback: true });
    stages.push({ index: 'idx_nodes_file_path', key: 'file_path', lower: `${scope}/`, upper: prefixEnd(`${scope}/`), fallback: true });
  } else stages.push({ key: 'rowid', fallback: true });

  const filters: string[] = [], filterParams: Bind[] = [];
  if (scope) {
    const prefix = `${scope}/`, end = prefixEnd(prefix);
    filters.push(`(file_path = ? OR (file_path >= ?${end === undefined ? '' : ' AND file_path < ?'}))`);
    filterParams.push(scope, prefix, ...(end === undefined ? [] : [end]));
  }
  if (action === 'graph-tree') filters.push("kind = 'file'");
  if (request.nodeKinds?.length) {
    filters.push(`kind IN (${request.nodeKinds.map(() => '?').join(',')})`);
    filterParams.push(...request.nodeKinds);
  }
  const filter = filters.join(' AND ') || '1';
  const state: SearchState = saved ? { ...saved } : { stage: 0, after: 0 };
  const matches: NodeRow[] = [];
  let rowsRead = 0;
  const advance = () => { state.stage++; state.after = 0; delete state.key; delete state.equalDone; };

  /**
   * LIMIT applies before scope/kind filters. Applying them inside the indexed
   * seek would let SQLite silently inspect an unbounded number of rejected
   * rows. The last candidate is retained as a boundary even on an empty page;
   * its count records the whole bounded window, not just the matching output.
   */
  function window(stage: Stage, take: number): { rows: WindowRow[]; count: number; equalTail: boolean } {
    const equalTail = stage.equal === undefined && stage.index !== undefined && state.key !== undefined && !state.equalDone;
    const where: string[] = [], params: Bind[] = [];
    if (stage.equal !== undefined || equalTail) {
      where.push(`${stage.key} = ? AND rowid > ?`);
      params.push(stage.equal ?? state.key!, state.after);
    } else if (stage.index) {
      where.push(`${stage.key} ${state.key !== undefined || stage.excludeLower ? '>' : '>='} ?`);
      params.push(state.key ?? stage.lower!);
      if (stage.upper !== undefined) { where.push(`${stage.key} < ?`); params.push(stage.upper); }
    } else { where.push('rowid > ?'); params.push(state.after); }
    const order = stage.equal !== undefined || equalTail || !stage.index ? 'rowid' : `${stage.key}, rowid`;
    const sql = `WITH candidates AS MATERIALIZED (
      SELECT rowid, *, ${stage.key} AS search_key FROM nodes${stage.index ? ` INDEXED BY ${stage.index}` : ''}
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?
    ) SELECT *, (${filter}) AS search_match, (SELECT count(*) FROM candidates) AS candidate_count
      FROM candidates WHERE (${filter}) OR rowid = (SELECT rowid FROM candidates ORDER BY search_key DESC, rowid DESC LIMIT 1)
      ORDER BY search_key, rowid`;
    const rows = db.prepare(sql).all(...params, take, ...filterParams, ...filterParams) as WindowRow[];
    const count = rows[0]?.candidate_count ?? 0;
    rowsRead += count || 1;
    return { rows, count, equalTail };
  }

  const limit = request.limit ?? 100;
  while (state.stage < stages.length && rowsRead < maxRows && matches.length < limit) {
    const stage = stages[state.stage];
    const take = Math.min(100, maxRows - rowsRead);
    const batch = window(stage, take);
    let consumed = true;
    for (const row of batch.rows) {
      state.after = row.rowid; if (stage.index && stage.equal === undefined) state.key = row.search_key;
      if (!row.search_match) continue;
      // Indexed phases have already emitted this whole-name/prefix population.
      // Classify by the same SQL expression, so fallback never repeats them.
      if (stage.fallback && nameIndex && (nameIndex === 'idx_nodes_lower_name' ? sqliteLower(row.name) : row.name).startsWith(indexedNeedle)) continue;
      if (needle && !`${row.name} ${row.qualified_name} ${row.file_path}`.toLocaleLowerCase().includes(needle)) continue;
      matches.push(row);
      if (matches.length === limit) { consumed = row.rowid === batch.rows.at(-1)?.rowid; break; }
    }
    if (consumed && batch.count < take) {
      if (batch.equalTail) state.equalDone = true;
      else advance();
    } else if (!batch.equalTail) delete state.equalDone;
  }

  // A bounded lookahead distinguishes completion from a full response. It may
  // find a nonmatching candidate: that still correctly means search is pending.
  while (matches.length === limit && state.stage < stages.length && rowsRead < maxRows) {
    const stage = stages[state.stage], probe = window(stage, 1);
    if (probe.count) break;
    if (probe.equalTail) state.equalDone = true; else advance();
  }
  return { rows: matches, rowsRead, ...(state.stage < stages.length ? { continuation: state, reason: matches.length === limit ? 'node_budget' as const : 'scan_budget' as const } : {}) };
}
