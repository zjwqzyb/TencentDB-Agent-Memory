import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { EdgeRow, NodeRow } from './structured-mode-context.js';

interface Source {
  content: string;
  lines: string[];
  imports: Map<string, { imported: string; module: string }>;
  bindings: { name: string; type: string; line: number }[];
}
interface Options {
  db: Database.Database;
  projectRoot: string;
  sourceBytes: number;
  takeRow(): boolean;
  warn(warning: string): void;
  expire(): void;
  addUnresolved(edge: EdgeRow, source: NodeRow, expression: string): void;
}
export type TypeScriptValidationBudget = 'source_byte_budget' | 'scan_budget';
type Validator = ((edge: EdgeRow, source: NodeRow, target: NodeRow) => boolean) & { deferred(): TypeScriptValidationBudget | null };

const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';

function parseImports(source: string): Source['imports'] {
  const imports = new Map<string, { imported: string; module: string }>();
  const lines = source.split('\n');
  let statement = '';
  const add = (clause: string, module: string) => {
    const clean = clause.replace(/^type\s+/, '').trim();
    const named = /\{([^}]*)\}/.exec(clean);
    if (named) {
      for (const part of named[1].split(',')) {
        const item = part.trim().replace(/^type\s+/, '');
        if (!item) continue;
        const alias = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item);
        if (alias) imports.set(alias[2], { imported: alias[1], module });
        else if (new RegExp(`^${identifier}$`).test(item)) imports.set(item, { imported: item, module });
      }
    }
    const namespace = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clean);
    if (namespace) imports.set(namespace[1], { imported: '*', module });
    const first = clean.split(',')[0]?.trim();
    if (first && new RegExp(`^${identifier}$`).test(first) && !imports.has(first)) imports.set(first, { imported: 'default', module });
  };
  for (const line of lines) {
    if (!statement && /^\s*import\s/.test(line) && !/^\s*import\s*\(/.test(line)) statement = line;
    else if (statement) statement += ` ${line.trim()}`;
    if (!statement) continue;
    const module = /\bfrom\s*(['"])([^'"]+)\1/.exec(statement);
    if (!module) continue;
    const start = statement.indexOf('import') + 'import'.length;
    const end = statement.lastIndexOf('from');
    add(statement.slice(start, end), module[2]);
    statement = '';
  }
  return imports;
}

function parseBindings(source: string): Source['bindings'] {
  const bindings: Source['bindings'] = [];
  const lines = source.split('\n');
  const pattern = new RegExp(`(?:^|[^\\w$.])(${identifier})\\s*\\??\\s*:\\s*(${identifier})`, 'g');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      bindings.push({ name: match[1], type: match[2], line: index + 1 });
    }
  });
  return bindings;
}

function moduleMatchesTarget(module: string, sourcePath: string, targetPath: string): boolean {
  if (!module.startsWith('.')) return false;
  const normalize = (path: string) => path.replace(/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i, '');
  const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), module));
  return normalize(resolved) === normalize(targetPath);
}

/** Rejects only metadata shapes known to create false TS/JS call edges. */
export function typescriptEdgeValidator(options: Options): Validator {
  const sources = new Map<string, Source | null>();
  let deferred: TypeScriptValidationBudget | null = null;
  let bytesRead = 0;

  function loadSource(path: string): Source | null {
    if (sources.has(path)) return sources.get(path)!;
    sources.set(path, null);
    if (!options.takeRow()) {
      deferred = 'scan_budget';
      options.warn('typescript_javascript_relation_source_budget');
      return null;
    }
    const file = options.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(path) as { content_hash: string } | undefined;
    if (!file?.content_hash || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) {
      options.warn('typescript_javascript_relation_source_unverified');
      return null;
    }
    let fd: number | undefined;
    try {
      const base = realpathSync(options.projectRoot);
      const real = realpathSync(resolve(base, path));
      const rel = relative(base, real);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        options.warn('typescript_javascript_relation_source_unverified');
        return null;
      }
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      const checkedReal = realpathSync(real);
      const checkedRel = relative(base, checkedReal);
      const mapped = statSync(checkedReal);
      if (isAbsolute(checkedRel) || checkedRel === '..' || checkedRel.startsWith(`..${sep}`) || !before.isFile() || before.ino !== mapped.ino || before.dev !== mapped.dev) {
        options.warn('typescript_javascript_relation_source_unverified');
        return null;
      }
      if (before.size + 1 > options.sourceBytes) {
        options.warn('typescript_javascript_relation_source_unverified');
        return null;
      }
      if (before.size + 1 > options.sourceBytes - bytesRead) {
        deferred = 'source_byte_budget';
        options.warn('typescript_javascript_relation_source_budget');
        return null;
      }
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      let count = 0;
      do {
        count = readSync(fd, buffer, length, buffer.length - length, length);
        length += count;
      } while (count && length < buffer.length);
      bytesRead += length;
      const after = fstatSync(fd);
      const content = buffer.subarray(0, length);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || createHash('sha256').update(content).digest('hex') !== file.content_hash) {
        options.expire();
        return null;
      }
      const text = content.toString('utf8');
      const value = { content: text, lines: text.split('\n'), imports: parseImports(text), bindings: parseBindings(text) };
      sources.set(path, value);
      return value;
    } catch {
      options.warn('typescript_javascript_relation_source_unverified');
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function dynamicImportExpression(edge: EdgeRow, source: NodeRow): string {
    const from = loadSource(source.file_path);
    if (!from || edge.line === null || !Number.isSafeInteger(edge.line) || edge.line < 1) return 'import()';
    const line = from.lines[edge.line - 1];
    const dynamic = line && /import\s*\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(line);
    return dynamic ? `import(${dynamic[1]}${dynamic[2]}${dynamic[1]})` : 'import()';
  }

  function receiverBinding(edge: EdgeRow, source: NodeRow, receiver: string): { type: string; module?: string; imported?: string } | null {
    const from = loadSource(source.file_path);
    const edgeLine = edge.line;
    if (!from || edgeLine === null || !Number.isSafeInteger(edgeLine)) return null;
    const property = receiver.startsWith('this.') ? receiver.slice(5).split('.')[0] : receiver;
    const binding = [...from.bindings].reverse().find(item => item.name === property && item.line <= edgeLine);
    if (!binding) return null;
    const imported = from.imports.get(binding.type);
    return { type: binding.type, module: imported?.module, imported: imported?.imported };
  }

  const reject = (edge: EdgeRow, source: NodeRow, expression: string, warning: string) => {
    options.addUnresolved(edge, source, expression);
    options.warn(warning);
  };

  const accept = (edge: EdgeRow, source: NodeRow, target: NodeRow): boolean => {
    if (edge.kind !== 'calls' || (source.language !== 'typescript' && source.language !== 'javascript')) return true;
    if (!edge.metadata) return true;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(edge.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      options.warn('typescript_javascript_call_metadata_unavailable');
      return true;
    }
    const refName = typeof metadata.refName === 'string' ? metadata.refName : '';
    const resolvedBy = typeof metadata.resolvedBy === 'string' ? metadata.resolvedBy : '';
    const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : null;
    const lastSegment = refName.split('.').at(-1) ?? '';
    const owner = target.qualified_name.includes('::') ? target.qualified_name.split('::').slice(0, -1).join('::').split('::').at(-1)! : target.name;

    if (refName === 'import' && target.name === 'import' && confidence !== null && confidence <= 0.5) {
      reject(edge, source, dynamicImportExpression(edge, source), 'dynamic_import_unresolved');
      return false;
    }
    if (refName.includes('.') && ['constant', 'property'].includes(target.kind) && lastSegment !== target.name) {
      reject(edge, source, refName, 'receiver_substituted_method_unresolved');
      return false;
    }
    if (resolvedBy === 'exact-match' && confidence !== null && confidence <= 0.5 && refName === target.name && source.file_path !== target.file_path) {
      reject(edge, source, refName, 'weak_same_name_call_unresolved');
      return false;
    }
    if (resolvedBy !== 'instance-method' || !refName.includes('.') || confidence === null) return true;
    if (confidence <= 0.65) {
      reject(edge, source, refName, 'unconfirmed_instance_call_unresolved');
      return false;
    }
    if (source.file_path === target.file_path && confidence >= 0.7) return true;
    if (confidence < 0.8) {
      reject(edge, source, refName, 'unconfirmed_instance_call_unresolved');
      return false;
    }
    const receiver = refName.split('.').slice(0, -1).join('.');
    const binding = receiverBinding(edge, source, receiver);
    if (
      binding &&
      (binding.type === owner || binding.imported === owner) &&
      (!binding.module || moduleMatchesTarget(binding.module, source.file_path, target.file_path))
    ) return true;
    reject(edge, source, refName, 'unconfirmed_instance_call_unresolved');
    return false;
  };

  return Object.assign(accept, { deferred: () => deferred });
}
