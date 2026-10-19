import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { EdgeRow, NodeRow } from './structured-mode-context.js';
import { maskJavaNonCode, parseJavaImports } from './java-import-declarations.js';

interface Header { packageName: string; imports: ReturnType<typeof parseJavaImports>; unicodeEscapes: boolean; sourceLines: string[]; code: string; lineStarts: number[] }
interface Options {
  db: Database.Database;
  projectRoot: string;
  sourceBytes: number;
  takeRow(): boolean;
  warn(warning: string): void;
  expire(): void;
}
export type JavaValidationBudget = 'source_byte_budget' | 'scan_budget';
type Validator = ((edge: EdgeRow, source: NodeRow, target: NodeRow) => boolean) & { deferred(): JavaValidationBudget | null };

/** Each request verifies at most sourceBytes bytes, with one source-hash lookup per file.
 * No Java source or package configuration outside the indexed root is consulted.
 */
export function javaEdgeValidator(options: Options): Validator {
  const headers = new Map<string, Header | null>();
  const owners = new Map<string, NodeRow | null>();
  const ancestry = new Map<string, boolean>();
  const fileSizes = new Map<string, number>();
  let edgeFiles = new Set<string>(), edgeRows = 0;
  let deferred: JavaValidationBudget | null = null;
  let bytesRead = 0;
  const takeRow = () => {
    // An edge that cannot be proved within a fresh page's work allowance must
    // fail permanently, rather than issue the same deferred cursor forever.
    if (edgeRows >= 256) { options.warn('java_relation_source_unverified'); return false; }
    if (!options.takeRow()) { deferred = 'scan_budget'; options.warn('java_relation_source_budget'); return false; }
    edgeRows++; return true;
  };
  const unavailable = () => { options.warn('java_relation_source_unverified'); return null; };
  function header(path: string): Header | null {
    edgeFiles.add(path);
    if (headers.has(path)) return headers.get(path)!;
    // Cache failures as well; dense adjacency must not repeatedly open a bad path.
    headers.set(path, null);
    if (!takeRow()) return null;
    const file = options.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(path) as { content_hash: string } | undefined;
    if (!file?.content_hash || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) return unavailable();
    let fd: number | undefined;
    try {
      const base = realpathSync(options.projectRoot), real = realpathSync(resolve(base, path));
      const rel = relative(base, real);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return unavailable();
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd), checked = realpathSync(real), checkedRel = relative(base, checked), mapped = statSync(checked);
      if (isAbsolute(checkedRel) || checkedRel === '..' || checkedRel.startsWith(`..${sep}`) || !before.isFile() || before.ino !== mapped.ino || before.dev !== mapped.dev) return unavailable();
      const available = options.sourceBytes - bytesRead;
      fileSizes.set(path, before.size + 1);
      const edgeBytes = [...edgeFiles].reduce((sum, file) => sum + (fileSizes.get(file) ?? 0), 0);
      if (edgeBytes > options.sourceBytes) return unavailable();
      // One extra byte detects concurrent growth and is included in the budget.
      if (before.size + 1 > available) { deferred = 'source_byte_budget'; options.warn('java_relation_source_budget'); return null; }
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0, count = 0;
      do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
      bytesRead += length;
      const after = fstatSync(fd), content = buffer.subarray(0, length);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || createHash('sha256').update(content).digest('hex') !== file.content_hash) {
        options.expire(); return null;
      }
      const source = content.toString('utf8');
      const code = maskJavaNonCode(source);
      const declaration = /\bpackage\s+([\p{L}\p{N}_$.\s]+)\s*;/u.exec(code);
      const sourceLines = source.split('\n'), lineStarts: number[] = [];
      let offset = 0;
      for (const line of sourceLines) { lineStarts.push(offset); offset += line.length + 1; }
      const value: Header = { packageName: declaration?.[1].replace(/\s/g, '') ?? '', imports: parseJavaImports(source), unicodeEscapes: /\\u+[0-9a-fA-F]{4}/.test(source), sourceLines, code, lineStarts };
      headers.set(path, value); return value;
    } catch { return unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function owner(node: NodeRow): NodeRow | null {
    if (owners.has(node.id)) return owners.get(node.id)!;
    let current: NodeRow | undefined = node;
    // A method/field can sit inside a nested class; all work is through verified
    // adjacency/primary-key indexes, with bounded containment and inheritance.
    for (let depth = 0; current && depth < 8; depth++) {
      if (['class', 'interface', 'enum'].includes(current.kind)) { owners.set(node.id, current); return current; }
      if (!takeRow()) break;
      const parent = options.db.prepare("SELECT source FROM edges INDEXED BY idx_edges_target_kind WHERE target=? AND kind='contains' ORDER BY id LIMIT 1").get(current.id) as { source: string } | undefined;
      if (!parent || !takeRow()) break;
      current = options.db.prepare('SELECT * FROM nodes WHERE id=?').get(parent.source) as NodeRow | undefined;
    }
    owners.set(node.id, null); return null;
  }
  function inherited(source: NodeRow, target: NodeRow, strict = false): boolean {
    const key = `${source.id}\0${target.id}\0${strict}`;
    if (ancestry.has(key)) return ancestry.get(key)!;
    const from = owner(source), to = owner(target);
    if (!from || !to) { ancestry.set(key, false); return false; }
    if (strict && from.id === to.id) { ancestry.set(key, false); return false; }
    const queue = [{ id: from.id, depth: 0 }], seen = new Set<string>();
    while (queue.length && seen.size < 32) {
      const current = queue.shift()!;
      if (current.id === to.id) { ancestry.set(key, true); return true; }
      if (seen.has(current.id) || current.depth >= 5) continue;
      seen.add(current.id);
      for (const kind of ['extends', 'implements']) {
        let after = 0;
        while (queue.length < 32) {
          if (!takeRow()) { ancestry.set(key, false); return false; }
          const edge = options.db.prepare('SELECT id,target FROM edges INDEXED BY idx_edges_source_kind WHERE source=? AND kind=? AND id>? ORDER BY id LIMIT 1').get(current.id, kind, after) as { id: number; target: string } | undefined;
          if (!edge) break;
          if (edge.target === to.id) { ancestry.set(key, true); return true; }
          after = edge.id; queue.push({ id: edge.target, depth: current.depth + 1 });
        }
      }
    }
    ancestry.set(key, false); return false;
  }
  function callReceiver(from: Header, edge: EdgeRow, target: NodeRow): string | null {
    const line = from.sourceLines[edge.line! - 1];
    if (line === undefined || !Number.isSafeInteger(edge.line) || !Number.isSafeInteger(edge.col) || edge.col! < 0 || edge.col! > Buffer.byteLength(line)) return null;
    const column = from.lineStarts[edge.line! - 1] + Buffer.from(line).subarray(0, edge.col!).toString('utf8').length;
    const identifier = '[\\p{ID_Start}_$][\\p{ID_Continue}$]*';
    const match = new RegExp(`^\\s*(${identifier}(?:\\s*\\.\\s*${identifier})*)\\s*\\(`, 'u').exec(from.code.slice(column, column + 512));
    if (!match) return null;
    let reference = match[1].replace(/\s/g, '');
    // Some SDK locations point at the method token instead of `this.`. Recover
    // only a syntactically adjacent qualifier, never a guessed receiver type.
    const prefix = new RegExp(`((?:${identifier}\\s*\\.\\s*)+)$`, 'u').exec(from.code.slice(Math.max(0, column - 512), column));
    if (prefix) reference = prefix[1].replace(/\s/g, '') + reference;
    const segments = reference.split('.');
    if (segments.pop() !== target.name) return null;
    return segments.join('.');
  }
  const accept = (edge: EdgeRow, source: NodeRow, target: NodeRow): boolean => {
    edgeFiles = new Set(); edgeRows = 0;
    if (source.language !== 'java' && target.language !== 'java') return true;
    let metadata: Record<string, unknown> = {};
    if (edge.metadata) {
      try { const parsed: unknown = JSON.parse(edge.metadata); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>; }
      catch { options.warn('java_relation_source_unverified'); return false; }
    }
    // SDK interface dispatch has the same kind as syntax calls, but points from an
    // abstract declaration to an implementation. Never present it as a call site.
    if (edge.provenance === 'heuristic' || typeof metadata.synthesizedBy === 'string') {
      options.warn('java_heuristic_relations_omitted'); return false;
    }
    if (edge.kind !== 'calls' || source.language !== 'java') return true;
    const from = header(source.file_path);
    if (!from || from.unicodeEscapes || edge.line === null || edge.col === null || typeof metadata.refName !== 'string') {
      if (from) options.warn('java_relation_source_unverified');
      return false;
    }
    const receiver = callReceiver(from, edge, target);
    if (receiver === null) { options.warn('java_relation_source_unverified'); return false; }
    if (receiver === 'this' || receiver === 'super' || receiver === '') {
      if (inherited(source, target, receiver === 'super')) return true;
      if (deferred) return false;
      // An unqualified invocation may instead be an explicitly imported static
      // method. Its owner is checked below rather than accepted by name alone.
      if (receiver) { options.warn('java_ambiguous_relations_omitted'); return false; }
    } else if (typeof metadata.confidence !== 'number' || metadata.confidence < 0.8 || metadata.resolvedBy === 'fuzzy') {
      options.warn('java_ambiguous_relations_omitted'); return false;
    }
    const to = header(target.file_path);
    if (!to || to.unicodeEscapes) { if (to) options.warn('java_relation_source_unverified'); return false; }
    const qualified = target.qualified_name.split('::');
    if (to.packageName && qualified[0] === to.packageName) qualified.shift();
    // SDK's qualified name ends with the method/field; the preceding segments
    // describe the owner type, including nested classes.
    qualified.pop();
    const owner = [to.packageName, ...qualified].filter(Boolean).join('.');
    if (!receiver && from.imports.some(item => item.static && !item.wildcard && item.specifier === `${owner}.${target.name}`)) return true;
    // Type-qualified calls must agree with explicit imports. The SDK can select
    // an unrelated same-named type even when an explicit import exists (#fixture).
    const receiverParts = receiver.split('.'), first = receiverParts[0];
    const imported = from.imports.filter(item => !item.static && !item.wildcard && item.specifier.split('.').at(-1) === first);
    if (imported.length) {
      if (imported.some(item => [item.specifier, ...receiverParts.slice(1)].join('.') === owner)) return true;
      options.warn('java_ambiguous_relations_omitted'); return false;
    }
    const typeQualified = /\p{Lu}/u.test(first?.[0] ?? '') || receiver === owner;
    if (typeQualified) {
      if (receiver === owner || [from.packageName, receiver].filter(Boolean).join('.') === owner || (source.file_path === target.file_path && owner.endsWith(`.${receiver}`))) return true;
      options.warn(from.imports.some(item => item.wildcard) ? 'java_wildcard_relations_omitted' : 'java_ambiguous_relations_omitted'); return false;
    }
    // High-confidence typed instance resolution is retained, except when a
    // wildcard leaves a cross-package target without an explicit type import.
    if (receiver && (!from.imports.some(item => item.wildcard) || from.packageName === to.packageName || from.imports.some(item => !item.static && !item.wildcard && item.specifier === owner))) return true;
    options.warn(from.imports.some(item => item.wildcard) ? 'java_wildcard_relations_omitted' : 'java_ambiguous_relations_omitted'); return false;
  };
  return Object.assign(accept, { deferred: () => deferred });
}
