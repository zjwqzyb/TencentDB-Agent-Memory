import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeGraphRouteDeps } from './code-graph.js';
const info = vi.hoisted(() => vi.fn());
vi.mock('../engines/code/bridge.js', async (original) => ({ ...await original<typeof import('../engines/code/bridge.js')>(), structuredSdkInfo: info }));
import { createCodeGraphRoutes } from './code-graph.js';

const roots: string[] = [];
let row: Record<string, unknown> | undefined;
let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-route-')); roots.push(root); path = join(root, 'graph.db');
  row = { code_graph_id: 'cg-1', team_id: 'team-1', status: 'ready', branch: 'main', commit_hash: 'abc', version: 1, last_sync_at: '2026-10-19' };
  info.mockReset(); info.mockResolvedValue({ databasePath: path, version: '1.6.2' });
});
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true }); });
function create() {
  const db = new Database(path); db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
  CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
  CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
  CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);
  INSERT INTO nodes VALUES ('n1','function','hello','a.hello','a.ts','typescript',1,1);`); db.close();
}
function app() {
  return createCodeGraphRoutes({ cgService: { getById: (svc: string, id: string) => svc === 'svc-1' && id === 'cg-1' ? row : undefined, dirFor: () => root }, instancePool: {}, publicBaseUrl: '' } as unknown as CodeGraphRouteDeps);
}
async function request(action: string, body: object = {}, service = 'svc-1') {
  const response = await app().request(`/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': service }, body: JSON.stringify({ code_graph_id: 'cg-1', ...body }) });
  return { status: response.status, body: await response.json() as any };
}
describe('structured Knowledge routes', () => {
  it.each(['graph', 'graph-search', 'graph-tree', 'graph-node', 'graph-source'])('rejects cross-service before SDK/filesystem access: %s', async action => {
    expect((await request(action, {}, 'other-service')).status).toBe(404); expect(info).not.toHaveBeenCalled();
    expect((await request(action, { code_graph_id: 'cg-other' })).status).toBe(404); expect(info).not.toHaveBeenCalled();
  });
  it('serves structured nodes and distinguishes building/failed/missing index', async () => {
    create(); expect((await request('graph-search')).body.data.nodes[0].name).toBe('hello');
    row!.status = 'processing'; expect((await request('graph-search')).body.data.state).toBe('building');
    row!.status = 'failed'; expect((await request('graph-search')).body.data.state).toBe('failed');
    row!.status = 'ready'; rmSync(path); expect((await request('graph-search')).body.data.state).toBe('unindexed');
  });
  it('distinguishes corrupt index failures from unsupported SDK/schema', async () => {
    writeFileSync(path, 'not a sqlite database');
    expect((await request('graph-search')).body.data.state).toBe('failed');
    expect((await request('graph-search')).body.data.warnings).toEqual(['index_query_failed']);
    info.mockResolvedValue({ databasePath: path, version: '1.2.0' });
    expect((await request('graph-search')).body.data.state).toBe('unsupported');
    expect((await request('graph-search')).body.data.capabilities.modes.calls.supported).toBe(false);
  });
  it('rejects a row deleted or rebuilt while awaiting SDK setup', async () => {
    create(); info.mockImplementation(async () => { row!.version = 2; return { databasePath: path, version: '1.6.2' }; });
    expect((await request('graph-search')).body.data.state).toBe('version_expired');
    info.mockImplementation(async () => { row = undefined; return { databasePath: path, version: '1.6.2' }; });
    expect((await request('graph-search')).status).toBe(404);
  });
  it.each(['null', '[]', '"string"', '{broken'])('rejects invalid JSON bodies with 400: %s', async body => {
    const response = await app().request('/graph-search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'svc-1' }, body });
    expect(response.status).toBe(400); expect(info).not.toHaveBeenCalled();
  });
  it('strictly rejects array enum values, unsafe path and excess budget', async () => {
    create();
    for (const body of [{ mode: ['calls'] }, { direction: ['in'] }, { depth: 6 }, { limit: 501 }, { scopePath: '../etc' }, { team_id: 'team-2' }]) expect((await request('graph', body)).status).toBe(400);
  });
});
