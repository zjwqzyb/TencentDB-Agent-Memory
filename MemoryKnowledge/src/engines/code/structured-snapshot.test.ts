import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs, { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIndex, indexProject, structuredSdkInfo } from './bridge.js';
import { queryStructured, type StructuredContext } from './structured.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function walFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cg-wal-snapshot-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'index.db');
  const writer = new Database(databasePath);
  cleanups.push(() => { if (writer.open) writer.close(); });
  expect(writer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
  const source = 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n';
  writeFileSync(join(root, 'a.ts'), source);
  writer.prepare('INSERT INTO files VALUES (?,?)').run('a.ts', createHash('sha256').update(source).digest('hex'));
  const insert = writer.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)');
  writer.transaction(() => {
    for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) insert.run(id, 'function', id, `a.ts:${id}`, 'a.ts', 'typescript', 1, 2);
    writer.prepare("INSERT INTO edges VALUES (1,'alpha','beta','calls',1,0)").run();
  })();
  const ctx: StructuredContext = { assetId: 'cg-wal', projectRoot: root, databasePath, sdkVersion: '1.6.2', version: 1, commit: 'fixture', indexedAt: 'fixture', branch: 'main' };
  return { ctx, writer, source, walPath: databasePath + '-wal', shmPath: databasePath + '-shm' };
}

function removeEmptySidecars(f: ReturnType<typeof walFixture>) {
  // Read-only close may leave the zero-byte WAL or clean it up, depending on
  // SQLite/VFS. Only remove empty sidecars with all fixture connections closed.
  if (existsSync(f.walPath)) expect(statSync(f.walPath).size).toBe(0);
  rmSync(f.walPath, { force: true }); rmSync(f.shmPath, { force: true });
}

describe('real SQLite WAL snapshot lifecycle', () => {
  it('keeps cold read-only searches, cursor replay, graph and source stable across empty WAL recreation', () => {
    const f = walFixture(); f.writer.close();
    expect(existsSync(f.walPath)).toBe(false);
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(first.state).toBe('ready'); expect(first.nextCursor).toBeTruthy();
    const node = first.nodes[0], indexVersion = first.indexVersion!;
    for (let attempt = 0; attempt < 5; attempt++) {
      // No connections remain and the WAL has no frames. Model its removal/recreation
      // between requests, including SQLite's last-connection cleanup on other hosts.
      removeEmptySidecars(f);
      const repeat = queryStructured(f.ctx, 'graph-search', { limit: 2 });
      expect(repeat.state).toBe('ready'); expect(repeat.indexVersion).toBe(indexVersion);
      expect(repeat.nodes).toEqual(first.nodes);
      const page = queryStructured(f.ctx, 'graph-search', { limit: 2, indexVersion, cursor: first.nextCursor! });
      expect(page.state).toBe('ready'); expect(page.nodes.map(n => n.name)).toEqual(['gamma', 'delta']);
      const replay = queryStructured(f.ctx, 'graph-search', { limit: 2, indexVersion, cursor: first.nextCursor! });
      expect(replay.nodes).toEqual(page.nodes); expect(replay.indexVersion).toBe(indexVersion);
      const request = { nodeId: node.id, indexVersion };
      expect(queryStructured(f.ctx, 'graph-node', request).nodes).toEqual([node]);
      expect(queryStructured(f.ctx, 'graph', { ...request, direction: 'out' }).edges).toHaveLength(1);
      expect(queryStructured(f.ctx, 'graph-source', request).source?.content).toBe(f.source.trimEnd());
    }
  });

  it('expires old IDs, source and cursors on a committed WAL append without a main-database change', () => {
    const f = walFixture();
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(first.state).toBe('ready'); expect(first.nextCursor).toBeTruthy();
    const beforeMain = statSync(f.ctx.databasePath, { bigint: true });
    const beforeWal = statSync(f.walPath, { bigint: true });
    f.writer.prepare("UPDATE nodes SET name = 'changed' WHERE id = 'alpha'").run();
    const afterMain = statSync(f.ctx.databasePath, { bigint: true });
    expect([afterMain.ino, afterMain.size, afterMain.mtimeNs]).toEqual([beforeMain.ino, beforeMain.size, beforeMain.mtimeNs]);
    expect(statSync(f.walPath, { bigint: true }).size).toBeGreaterThan(beforeWal.size);
    const request = { nodeId: first.nodes[0].id, indexVersion: first.indexVersion! };
    for (const action of ['graph-node', 'graph-source'] as const) {
      const stale = queryStructured(f.ctx, action, request);
      expect(stale.state).toBe('version_expired'); expect(stale.nodes).toEqual([]); expect(stale.source).toBeUndefined();
    }
    expect(queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! }).state).toBe('version_expired');
    const fresh = queryStructured(f.ctx, 'graph-search', {});
    expect(fresh.state).toBe('ready'); expect(fresh.indexVersion).not.toBe(first.indexVersion);
    expect(fresh.nodes[0].name).toBe('changed');
  });

  it('keeps a nonempty WAL stable when birthtime falls back to ctime changed by a read-only open', () => {
    const f = walFixture();
    const realStat = fs.statSync, prepare = Database.prototype.prepare;
    const before = realStat(f.walPath, { bigint: true });
    expect(before.size).toBeGreaterThan(0n);
    const birthtimes: bigint[] = [];
    vi.spyOn(fs, 'statSync').mockImplementation(((path, options) => {
      const stat = realStat(path, options);
      if (String(path) === f.walPath && 'ctimeNs' in stat) {
        // Node uses ctime on filesystems without a native birthtime. Keep real
        // file identity/data timestamps while reproducing that platform fallback.
        Object.assign(stat, { birthtimeNs: stat.ctimeNs, birthtimeMs: stat.ctimeMs, birthtime: stat.ctime });
        birthtimes.push(stat.ctimeNs);
      }
      return stat;
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    let metadataChanged = false;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (this.readonly && !metadataChanged) {
        metadataChanged = true;
        // SQLite may fchown its WAL while opening it. A real chmod provides the
        // same ctime-only change on hosts where reads do not do that naturally.
        chmodSync(f.walPath, Number(before.mode & 0o777n) ^ 0o020);
      }
      return prepare.call(this, sql);
    });
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    const after = realStat(f.walPath, { bigint: true });
    expect(metadataChanged).toBe(true); expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([before.dev, before.ino, before.size, before.mtimeNs]);
    expect(new Set(birthtimes).size).toBeGreaterThan(1);
    expect(first.state).toBe('ready'); expect(first.nextCursor).toBeTruthy();
    const page = queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! });
    expect(page.state).toBe('ready'); expect(page.indexVersion).toBe(first.indexVersion);
    f.writer.prepare("UPDATE nodes SET name = 'changed' WHERE id = 'alpha'").run();
    expect(queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! }).state).toBe('version_expired');
    const fresh = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(fresh.state).toBe('ready'); expect(fresh.nodes[0].name).toBe('changed');
  });

  it('detects a committed WAL reuse even when its inode and size do not change', () => {
    const f = walFixture();
    const checkpoint = f.writer.pragma('wal_checkpoint(RESTART)') as { busy: number }[];
    expect(checkpoint[0].busy).toBe(0);
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(first.state).toBe('ready');
    const before = statSync(f.walPath, { bigint: true });
    f.writer.prepare("UPDATE nodes SET name = 'changed' WHERE id = 'alpha'").run();
    const after = statSync(f.walPath, { bigint: true });
    expect([after.ino, after.size]).toEqual([before.ino, before.size]);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! }).state).toBe('version_expired');
    expect(queryStructured(f.ctx, 'graph-source', { nodeId: first.nodes[0].id, indexVersion: first.indexVersion! }).state).toBe('version_expired');
  });

  it('conservatively expires on a checkpoint, then stays stable when the empty WAL is removed on close', () => {
    const f = walFixture();
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(first.state).toBe('ready'); expect(statSync(f.walPath).size).toBeGreaterThan(0);
    expect((f.writer.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0].busy).toBe(0);
    expect(statSync(f.walPath).size).toBe(0);
    expect(queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! }).state).toBe('version_expired');
    const checkpointed = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(checkpointed.state).toBe('ready');
    f.writer.close(); expect(existsSync(f.walPath)).toBe(false);
    const afterClose = queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: checkpointed.nextCursor! });
    expect(afterClose.state).toBe('ready'); expect(afterClose.indexVersion).toBe(checkpointed.indexVersion);
  });

  it.each(['graph-search', 'graph-source'] as const)('rejects a real writer commit during an active %s read transaction', action => {
    const f = walFixture();
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    const prepare = Database.prototype.prepare;
    let committed = false, searchReads = 0;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      // Both statements follow a node SELECT, so the reader already holds its
      // SQLite snapshot. A separate real WAL writer can still commit here.
      const boundary = action === 'graph-search'
        ? sql.startsWith('WITH candidates') && ++searchReads === 2
        : sql === 'SELECT content_hash FROM files WHERE path = ?';
      if (this.readonly && boundary && !committed) {
        committed = true;
        f.writer.prepare("UPDATE nodes SET name = 'changed' WHERE id = 'alpha'").run();
      }
      return prepare.call(this, sql);
    });
    const request = action === 'graph-search' ? { limit: 2 } : { nodeId: first.nodes[0].id, indexVersion: first.indexVersion! };
    const result = queryStructured(f.ctx, action, request);
    expect(committed).toBe(true); expect(result.state).toBe('version_expired');
    expect(result.warnings).toEqual(['index_changed_during_query']);
    expect(result.nodes).toEqual([]); expect(result.edges).toEqual([]);
    expect(result.source).toBeUndefined(); expect(result.nextCursor).toBeNull();
  });

  it('expires IDs and cursors when a closed WAL database is rebuilt at the same path', () => {
    const f = walFixture(); f.writer.close();
    const first = queryStructured(f.ctx, 'graph-search', { limit: 2 });
    expect(first.state).toBe('ready');
    const replacement = walFixture();
    replacement.writer.prepare("UPDATE nodes SET name = 'rebuilt' WHERE id = 'alpha'").run();
    replacement.writer.close();
    removeEmptySidecars(f);
    renameSync(replacement.ctx.databasePath, f.ctx.databasePath);
    expect(queryStructured(f.ctx, 'graph-search', { limit: 2, cursor: first.nextCursor! }).state).toBe('version_expired');
    expect(queryStructured(f.ctx, 'graph-source', { nodeId: first.nodes[0].id, indexVersion: first.indexVersion! }).state).toBe('version_expired');
    const fresh = queryStructured(f.ctx, 'graph-search', {});
    expect(fresh.state).toBe('ready'); expect(fresh.nodes[0].name).toBe('rebuilt');
    expect(fresh.indexVersion).not.toBe(first.indexVersion);
  });

  it('serves a closed SDK 1.6.2 WAL index through repeated search, cursor, calls and source requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-sdk-cold-snapshot-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'package.json'), '{"name":"cold-snapshot-fixture","type":"module"}');
    writeFileSync(join(root, 'main.ts'), 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
    const instance = await indexProject(root);
    cleanups.push(() => closeIndex(instance));
    const info = await structuredSdkInfo(root); expect(info.version).toBe('1.6.2');
    closeIndex(instance);
    const ctx: StructuredContext = { assetId: 'cg-sdk-cold', projectRoot: root, databasePath: info.databasePath, sdkVersion: info.version, version: 1, commit: 'fixture', indexedAt: 'fixture', branch: 'main' };
    const first = queryStructured(ctx, 'graph-search', { nodeKinds: ['function'], limit: 1 });
    expect(first.state).toBe('ready'); expect(first.nextCursor).toBeTruthy();
    const alpha = first.nodes[0]; expect(alpha.name).toBe('alpha');
    for (let attempt = 0; attempt < 3; attempt++) {
      const repeat = queryStructured(ctx, 'graph-search', { nodeKinds: ['function'], limit: 1 });
      expect(repeat.nodes).toEqual(first.nodes); expect(repeat.indexVersion).toBe(first.indexVersion);
      const page = queryStructured(ctx, 'graph-search', { nodeKinds: ['function'], limit: 1, cursor: first.nextCursor! });
      expect(page.state).toBe('ready'); expect(page.nodes[0].name).toBe('beta');
      const request = { nodeId: alpha.id, indexVersion: first.indexVersion! };
      expect(queryStructured(ctx, 'graph', { ...request, direction: 'out' }).edges).toHaveLength(1);
      expect(queryStructured(ctx, 'graph-source', request).source?.content).toContain('return beta()');
    }
  }, 120_000);
});
