import Database from 'better-sqlite3';
import type { HistoricalCodeGraphSnapshot } from '../../store/code-graph-history.js';
import { queryStructured, type StructuredContext } from './structured.js';
import type { NodeRow } from './structured-mode-context.js';

export interface FileChange {
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'uncertain';
  oldPath?: string;
  newPath?: string;
  evidence: string;
}

export function changedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  const removed = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  function group(index: Map<string, string[]>, blob: string, path: string) {
    const paths = index.get(blob) ?? [];
    paths.push(path);
    index.set(blob, paths);
  }
  for (const [path, blob] of before) {
    if (!after.has(path)) group(removed, blob, path);
    else if (after.get(path) !== blob)
      changes.push({
        kind: 'modified',
        oldPath: path,
        newPath: path,
        evidence: 'same_path_different_git_blob',
      });
  }
  for (const [path, blob] of after) if (!before.has(path)) group(added, blob, path);
  for (const [blob, paths] of removed) {
    const targets = added.get(blob);
    if (paths.length === 1 && targets?.length === 1) {
      changes.push({
        kind: 'renamed',
        oldPath: paths[0],
        newPath: targets[0],
        evidence: 'unique_identical_git_blob',
      });
      added.delete(blob);
    } else {
      for (const path of paths)
        changes.push({
          kind: 'deleted',
          oldPath: path,
          evidence: targets
            ? 'path_removed_ambiguous_identical_blobs'
            : 'path_absent_from_new_git_tree',
        });
    }
  }
  for (const [blob, paths] of added)
    for (const path of paths)
      changes.push({
        kind: 'added',
        newPath: path,
        evidence: removed.has(blob)
          ? 'path_added_ambiguous_identical_blobs'
          : 'path_absent_from_old_git_tree',
      });
  return changes.sort((a, b) => (a.newPath ?? a.oldPath!).localeCompare(b.newPath ?? b.oldPath!));
}

export function reviewContext(
  assetId: string,
  snapshot: HistoricalCodeGraphSnapshot,
): StructuredContext {
  return {
    assetId,
    projectRoot: snapshot.root,
    databasePath: snapshot.databasePath,
    sdkVersion: snapshot.sdkVersion,
    version: snapshot.version,
    commit: snapshot.commit,
    indexedAt: snapshot.indexedAt,
    branch: snapshot.branch,
  };
}

function fileSymbols(ctx: StructuredContext, path: string) {
  const version = queryStructured(ctx, 'graph', {}).indexVersion;
  if (!version) throw new Error('historical_index_unavailable');
  const db = new Database(ctx.databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id,kind,name,qualified_name,file_path,start_line,end_line FROM nodes
      WHERE file_path=? AND kind NOT IN ('file','import') ORDER BY start_line,id LIMIT 101`,
      )
      .all(path) as NodeRow[];
    return {
      truncated: rows.length > 100,
      symbols: rows.slice(0, 100).map((row) => ({
        name: row.name,
        qualifiedName: row.qualified_name,
        kind: row.kind,
        filePath: path,
        line: row.start_line,
        endLine: row.end_line,
        nodeId: ctx.assetId + '@' + version + ':' + row.id,
        indexVersion: version,
        commit: ctx.commit,
      })),
    };
  } finally {
    db.close();
  }
}

export function compareSymbols(
  before: StructuredContext,
  after: StructuredContext,
  file: FileChange,
) {
  const old = file.oldPath ? fileSymbols(before, file.oldPath) : { symbols: [], truncated: false };
  const next = file.newPath ? fileSymbols(after, file.newPath) : { symbols: [], truncated: false };
  type Symbol = (typeof old.symbols)[number];
  type Change = { kind: string; evidence: string; old?: Symbol; new?: Symbol };
  const changes: Change[] = [];
  const used = new Set<string>();
  const signature = (s: Symbol) => s.kind + '\n' + s.qualifiedName;
  for (const source of old.symbols) {
    const candidates = next.symbols.filter((s) => signature(s) === signature(source));
    const unique =
      !old.truncated &&
      !next.truncated &&
      candidates.length === 1 &&
      old.symbols.filter((s) => signature(s) === signature(source)).length === 1;
    if (!unique && candidates.length === 1 && !used.has(candidates[0].nodeId)) {
      used.add(candidates[0].nodeId);
      changes.push({
        kind: 'uncertain',
        old: source,
        new: candidates[0],
        evidence: 'matching_name_partial_or_ambiguous_index',
      });
      continue;
    }
    if (!unique) {
      changes.push({
        kind: file.kind === 'deleted' ? 'deleted' : 'uncertain',
        old: source,
        evidence: file.kind === 'deleted' ? file.evidence : 'no_unique_index_match',
      });
      continue;
    }
    const target = candidates[0];
    used.add(target.nodeId);
    if (file.kind === 'uncertain') {
      changes.push({ kind: 'uncertain', old: source, new: target, evidence: file.evidence });
      continue;
    }
    const read = (ctx: StructuredContext, symbol: Symbol) => {
      const result = queryStructured(ctx, 'graph-source', {
        nodeId: symbol.nodeId,
        indexVersion: symbol.indexVersion,
      });
      const text = result.source;
      return result.state === 'ready' &&
        text &&
        text.startLine === symbol.line &&
        text.endLine >= symbol.endLine
        ? text.content
        : undefined;
    };
    const left = read(before, source),
      right = read(after, target);
    const kind =
      left === undefined || right === undefined
        ? 'uncertain'
        : left !== right
          ? 'modified'
          : file.kind === 'renamed'
            ? 'renamed'
            : 'unchanged';
    changes.push({
      kind,
      old: source,
      new: target,
      evidence:
        kind === 'uncertain'
          ? 'partial_or_unavailable_source'
          : 'unique_qualified_symbol_and_both_source_ranges',
    });
  }
  for (const target of next.symbols)
    if (!used.has(target.nodeId))
      changes.push({
        kind: file.kind === 'added' ? 'added' : 'uncertain',
        new: target,
        evidence: file.kind === 'added' ? file.evidence : 'no_unique_index_match',
      });
  return { changes, truncated: old.truncated || next.truncated };
}
