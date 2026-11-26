import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { changedFiles } from './commit-comparison.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareSymbols } from './commit-comparison.js';
import type { StructuredContext } from './structured.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('code review evidence', () => {
  it('pairs only unique identical Git blobs; duplicate candidates remain ambiguous', () => {
    const left = new Map([
      ['old', 'v1'],
      ['copy-a', 'v2'],
      ['copy-b', 'v2'],
    ]);
    const right = new Map([
      ['new', 'v1'],
      ['target', 'v2'],
    ]);
    const changes = changedFiles(left, right);
    expect(changes.filter((c) => c.kind === 'renamed')).toEqual([
      { kind: 'renamed', oldPath: 'old', newPath: 'new', evidence: 'unique_identical_git_blob' },
    ]);
    expect(changes.filter((c) => c.evidence.includes('ambiguous'))).toHaveLength(3);
  });
  it('keeps an unmatched indexed method unresolved when the new source still contains it', () => {
    function index(withMethod: boolean): StructuredContext {
      const root = mkdtempSync(join(tmpdir(), 'commit-review-test-'));
      roots.push(root);
      const databasePath = join(root, 'graph.db');
      const db = new Database(databasePath);
      db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INT,end_line INT);
        CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INT,col INT);
        CREATE INDEX idx_edges_source_kind ON edges(source,kind);
        CREATE INDEX idx_edges_target_kind ON edges(target,kind);
        CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
      if (withMethod)
        db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)').run(
          'f',
          'function',
          'f',
          'f',
          'example.ts',
          'typescript',
          1,
          1,
        );
      db.close();
      writeFileSync(join(root, 'example.ts'), 'export function f() {}\n');
      return {
        assetId: 'review',
        projectRoot: root,
        databasePath,
        sdkVersion: '1.6.2',
        version: 1,
        indexedAt: 'test',
        commit: withMethod ? 'old' : 'new',
        branch: 'main',
      };
    }
    const result = compareSymbols(index(true), index(false), {
      kind: 'modified',
      oldPath: 'example.ts',
      newPath: 'example.ts',
      evidence: 'same_path',
    });
    expect(result.changes.map((s) => [s.kind, s.evidence])).toEqual([
      ['uncertain', 'no_unique_index_match'],
    ]);
  });
});
