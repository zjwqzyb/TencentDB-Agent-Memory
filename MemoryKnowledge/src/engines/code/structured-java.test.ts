import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { javaEdgeValidator } from './structured-java.js';
import type { NodeRow, EdgeRow } from './structured-mode-context.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(source: string, options: { sourceBytes?: number; maxRows?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cg-java-validator-'));
  const db = new Database(join(root, 'fixture.db'));
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);`);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const file = (path: string, content: string, write = true) => {
    if (write) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    db.prepare('INSERT OR REPLACE INTO files VALUES(?,?)').run(path, createHash('sha256').update(content).digest('hex'));
  };
  file('app/Caller.java', source);
  file('util/Utility.java', 'package demo.util; public class Utility { public static void leaf() {} }');
  const node = (id: string, kind: string, qualified: string, path: string): NodeRow => {
    const row = { id, kind, qualified_name: qualified, name: qualified.split('::').at(-1)!, file_path: path, language: 'java', start_line: 1, end_line: 1 };
    db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.kind, row.name, row.qualified_name, row.file_path, row.language, 1, 1); return row;
  };
  const from = node('from', 'method', 'demo.app::Caller::entry', 'app/Caller.java');
  const target = node('target', 'method', 'demo.util::Utility::leaf', 'util/Utility.java');
  const warnings: string[] = [], state = { rows: 0, expired: false };
  const accept = javaEdgeValidator({ db, projectRoot: root, sourceBytes: options.sourceBytes ?? 2 * 1024 * 1024,
    takeRow() { if (state.rows >= (options.maxRows ?? 2000)) return false; state.rows++; return true; },
    warn(warning) { warnings.push(warning); }, expire() { state.expired = true; } });
  const edge = (needle: string, overrides: Partial<EdgeRow> = {}): EdgeRow => {
    const before = source.slice(0, source.indexOf(needle)), line = before.split('\n').length, col = Buffer.byteLength(before.split('\n').at(-1)!);
    return { id: 1, source: from.id, target: target.id, kind: 'calls', line, col, metadata: JSON.stringify({ confidence: 0.9, resolvedBy: 'import', refName: needle.replace(/\(.*/, '') }), provenance: null, ...overrides };
  };
  return { root, db, file, node, from, target, warnings, state, accept, edge };
}

describe('conservative Java relation validation', () => {
  it('checks explicit receiver imports against the target, including duplicate type names', () => {
    const f = fixture('package demo.app;\nimport demo.util.Utility;\nclass Caller { void entry() { Utility.leaf(); } }');
    expect(f.accept(f.edge('Utility.leaf()'), f.from, f.target)).toBe(true);
    const wrong = { ...f.target, file_path: 'other/Utility.java', qualified_name: 'demo.other::Utility::leaf' };
    f.file(wrong.file_path, 'package demo.other; class Utility { void leaf() {} }');
    expect(f.accept(f.edge('Utility.leaf()'), f.from, wrong)).toBe(false);
    expect(f.warnings).toContain('java_ambiguous_relations_omitted');
  });

  it('omits wildcard import guesses without changing a guessed target into a new edge', () => {
    const f = fixture('package demo.app;\nimport demo.util.*;\nclass Caller { void entry() { Utility.leaf(); } }');
    expect(f.accept(f.edge('Utility.leaf()'), f.from, f.target)).toBe(false);
    expect(f.warnings).toContain('java_wildcard_relations_omitted');
  });

  it('filters SDK interface-dispatch and other synthesized relations', () => {
    const f = fixture('package demo.app; class Caller { void entry() {} }');
    expect(f.accept(f.edge('entry()', { provenance: 'heuristic' }), f.from, f.target)).toBe(false);
    expect(f.accept(f.edge('entry()', { metadata: '{"synthesizedBy":"interface-impl"}' }), f.from, f.target)).toBe(false);
    expect(f.warnings).toContain('java_heuristic_relations_omitted'); expect(f.state.rows).toBe(0);
  });

  it('omits the production log.info low-confidence wrong receiver, but preserves imported factory initializers', () => {
    const f = fixture('package demo.app;\nimport demo.util.Utility;\nclass Caller { static { log.info(); Utility.leaf(); } }');
    const log = { ...f.target, name: 'info', qualified_name: 'demo.util::Utility::info' };
    expect(f.accept(f.edge('log.info()', { metadata: '{"confidence":0.65,"resolvedBy":"instance-method","refName":"log.info"}' }), f.from, log)).toBe(false);
    expect(f.warnings).toContain('java_ambiguous_relations_omitted');
    expect(f.accept(f.edge('Utility.leaf()'), { ...f.from, kind: 'class' }, f.target)).toBe(true);
  });

  it.each(['this.before()', 'super.before()'])('keeps indexed inherited %s even when SDK metadata loses the qualifier and has confidence 0.7', call => {
    const f = fixture(`package demo.app;\nclass Caller extends Parent { void entry() { ${call}; } }`);
    f.file('app/Parent.java', 'package demo.app; class Parent { void before() {} }');
    const cls = f.node('class', 'class', 'demo.app::Caller', f.from.file_path);
    const parent = f.node('parent', 'class', 'demo.app::Parent', 'app/Parent.java');
    const method = f.node('before', 'method', 'demo.app::Parent::before', 'app/Parent.java');
    f.db.prepare("INSERT INTO edges VALUES(1,?,?, 'contains',1,0)").run(cls.id, f.from.id);
    f.db.prepare("INSERT INTO edges VALUES(2,?,?, 'contains',1,0)").run(parent.id, method.id);
    f.db.prepare("INSERT INTO edges VALUES(3,?,?, 'extends',1,0)").run(cls.id, parent.id);
    const e = f.edge(call, { metadata: '{"confidence":0.7,"resolvedBy":"exact-match","refName":"before"}' });
    expect(f.accept(e, f.from, method)).toBe(true);
    expect(f.state.rows).toBeLessThanOrEqual(12);
  });

  it('does not accept a this-call when its target owner is outside indexed inheritance', () => {
    const f = fixture('package demo.app; class Caller { void entry() { this.before(); } }');
    const cls = f.node('class', 'class', 'demo.app::Caller', f.from.file_path);
    const other = f.node('other', 'class', 'demo.util::Utility', f.target.file_path);
    f.db.prepare("INSERT INTO edges VALUES(1,?,?, 'contains',1,0)").run(cls.id, f.from.id);
    f.db.prepare("INSERT INTO edges VALUES(2,?,?, 'contains',1,0)").run(other.id, f.target.id);
    expect(f.accept(f.edge('this.before()', { metadata: '{"confidence":0.7,"refName":"before"}' }), f.from, { ...f.target, name: 'before' })).toBe(false);
  });

  it('rejects this-calls targeting an unrelated same-named member in another type in the same file', () => {
    const f = fixture('package demo.app; class Caller { void entry() { this.leaf(); } } class Other { void leaf() {} }');
    const caller = f.node('caller-class', 'class', 'demo.app::Caller', f.from.file_path);
    const other = f.node('other-class', 'class', 'demo.app::Other', f.from.file_path);
    const target = f.node('other-leaf', 'method', 'demo.app::Other::leaf', f.from.file_path);
    f.db.prepare("INSERT INTO edges VALUES(1,?,?, 'contains',1,0)").run(caller.id, f.from.id);
    f.db.prepare("INSERT INTO edges VALUES(2,?,?, 'contains',1,0)").run(other.id, target.id);
    expect(f.accept(f.edge('this.leaf()', { metadata: '{"confidence":0.7,"refName":"leaf"}' }), f.from, target)).toBe(false);
    expect(f.warnings).toContain('java_ambiguous_relations_omitted');
  });

  it('checks UTF-8 byte columns and rejects a location that does not contain the target invocation', () => {
    const f = fixture('package demo.app; import demo.util.Utility; class Caller { void entry() { /* 中文 */ Utility.leaf(); } }');
    expect(f.accept(f.edge('Utility.leaf()'), f.from, f.target)).toBe(true);
    expect(f.accept(f.edge('Utility.leaf()', { col: 0 }), f.from, f.target)).toBe(false);
    expect(f.warnings).toContain('java_relation_source_unverified');
  });

  it('fails closed on unsafe indexed paths, external symlinks and unavailable hashes', () => {
    const f = fixture('package demo.app; import demo.util.Utility; class Caller { void entry() { Utility.leaf(); } }');
    expect(f.accept(f.edge('Utility.leaf()'), { ...f.from, file_path: '../outside.java' }, f.target)).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), 'cg-java-outside-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const source = 'package demo.app; class Caller { void entry() { Utility.leaf(); } }';
    writeFileSync(join(outside, 'Other.java'), source); symlinkSync(join(outside, 'Other.java'), join(f.root, 'linked.java')); f.file('linked.java', source, false);
    expect(f.accept(f.edge('Utility.leaf()'), { ...f.from, file_path: 'linked.java' }, f.target)).toBe(false);
    expect(f.warnings).toContain('java_relation_source_unverified'); expect(f.state.expired).toBe(false);
  });

  it('bounds cumulative source bytes and SQL work, caches file checks, and expires changed sources', () => {
    const source = 'package demo.app; import demo.util.Utility; class Caller { void entry() { Utility.leaf(); } }';
    const f = fixture(source);
    for (let i = 0; i < 30; i++) expect(f.accept(f.edge('Utility.leaf()'), f.from, f.target)).toBe(true);
    expect(f.state.rows).toBe(2);
    const bytes = fixture(source, { sourceBytes: Buffer.byteLength(source) });
    expect(bytes.accept(bytes.edge('Utility.leaf()'), bytes.from, bytes.target)).toBe(false); expect(bytes.warnings).toContain('java_relation_source_unverified'); expect(bytes.accept.deferred()).toBeNull();
    const rows = fixture(source, { maxRows: 1 });
    expect(rows.accept(rows.edge('Utility.leaf()'), rows.from, rows.target)).toBe(false); expect(rows.state.rows).toBe(1);
    const changed = fixture(source); writeFileSync(join(changed.root, changed.from.file_path), source + '// changed');
    expect(changed.accept(changed.edge('Utility.leaf()'), changed.from, changed.target)).toBe(false); expect(changed.state.expired).toBe(true);
  });

  it('keeps TS/JS behavior and Java non-call syntax edges unchanged', () => {
    const f = fixture('package demo.app; class Caller {}');
    expect(f.accept(f.edge('Caller'), { ...f.from, language: 'typescript' }, { ...f.target, language: 'typescript' })).toBe(true);
    expect(f.accept(f.edge('Caller', { kind: 'extends' }), f.from, f.target)).toBe(true);
    expect(f.state.rows).toBe(0);
  });

  it('rejects super wrongly resolved back to the current overriding method', () => {
    const f = fixture('package demo.app; class Caller { void leaf() { super.leaf(); } }');
    const cls = f.node('class', 'class', 'demo.app::Caller', f.from.file_path);
    f.db.prepare("INSERT INTO edges VALUES(1,?,?, 'contains',1,0)").run(cls.id, f.from.id);
    const target = { ...f.from, name: 'leaf' };
    expect(f.accept(f.edge('super.leaf()', { metadata: '{"confidence":0.7,"refName":"leaf"}' }), f.from, target)).toBe(false);
    expect(f.warnings).toContain('java_ambiguous_relations_omitted');
  });
});
