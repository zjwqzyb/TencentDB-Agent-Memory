/** Bounded dependency summaries over the verified SDK index; never traverses calls implicitly. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { CodeGraphEdge, CodeGraphNode, CodeGraphResponse } from '../../contracts/code-graph.js';
import type { StructuredModeContext, NodeRow, EdgeRow, UnresolvedRow } from './structured-mode-context.js';
import { parseJavaImports } from './java-import-declarations.js';

type Resolution = 'internal' | 'external' | 'unresolved';
type Evidence = NonNullable<CodeGraphResponse['dependencyEvidence']>[number];
interface Group { key: string; node: CodeGraphNode; outsideScope: boolean }
interface AggregateEdge { edge: CodeGraphEdge; sourceKey: string; targetKey: string }
interface State {
  phase: 'nodes' | 'edges' | 'unresolved' | 'done'; after: number;
  groups: Group[]; edges: AggregateEdge[]; sites: string[]; distinctSites: string[]; resolvedImportAnchors: string[];
  diagnostics: NonNullable<CodeGraphResponse['unresolved']>; diagnosticIds: number[];
  scannedNodes: number; scannedEdges: number; stopped?: string; incomplete?: boolean; warnings: string[];
}
// Bounds both exact dedup memory and the immutable cursor state. This is deliberately
// not a cache of the entire repository graph. A hard cap requires a narrower query.
const MAX_SITES = 8192;
const MAX_CURSOR_BYTES = 1024 * 1024;
const SAMPLE_EVIDENCE = 5;
const SOURCE_BYTES = 2 * 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const within = (path: string, scope: string) => !scope || (scope === '.' ? !path.includes('/') : path === scope || path.startsWith(`${scope}/`));
const safePath = (path: string) => Boolean(path) && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..') && !path.includes('\0');

interface Declaration { line: number; column: number; endLine: number; endColumn: number; specifier: string }
/** Lexical declaration anchors only; SDK remains responsible for semantic resolution.
 * Handles static ES imports/named or star reexports, multiline braces, ASI,
 * comments and quoted escapes. Dynamic imports/CommonJS are explicitly not guessed.
 */
export function dependencyDeclarations(source: string): Declaration[] {
  interface Token { value: string; quoted?: boolean; line: number; col: number; endLine: number; endCol: number }
  const tokens: Token[] = []; let offset = 0, line = 1, col = 0;
  const advance = () => { const char = String.fromCodePoint(source.codePointAt(offset)!); offset += char.length; if (char === '\n') { line++; col = 0; } else col += Buffer.byteLength(char); return char; };
  while (offset < source.length) {
    const char = source[offset];
    if (/\s/.test(char)) { advance(); continue; }
    if (source.startsWith('//', offset)) { while (offset < source.length && source[offset] !== '\n') advance(); continue; }
    if (source.startsWith('/*', offset)) { advance(); advance(); while (offset < source.length && !source.startsWith('*/', offset)) advance(); if (offset < source.length) { advance(); advance(); } continue; }
    const startLine = line, startCol = col, start = offset;
    if (char === '"' || char === "'" || char === '`') {
      advance(); while (offset < source.length) { const next = advance(); if (next === '\\') { if (offset < source.length) advance(); } else if (next === char) break; }
      // Template literals cannot be static module specifiers; skip their entire
      // contents rather than interpreting embedded words as declarations.
      const raw = source.slice(start + 1, offset - 1);
      const value = raw.replace(/\\([\\'"`])/g, '$1');
      tokens.push({ value, quoted: char !== '`', line: startLine, col: startCol, endLine: line, endCol: col }); continue;
    }
    if (/[\w$]/.test(char)) { while (offset < source.length && /[\w$]/.test(source[offset])) advance(); }
    else advance();
    tokens.push({ value: source.slice(start, offset), line: startLine, col: startCol, endLine: line, endCol: col });
  }
  const declarations: Declaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1];
    if (token.quoted !== undefined || !['import', 'export'].includes(token.value) || !next) continue;
    if (token.value === 'export' && !['{', '*', 'type'].includes(next.value)) continue;
    if (token.value === 'import' && ['(', '.', '='].includes(next.value)) continue;
    let module: Token | undefined;
    if (token.value === 'import' && next.quoted) module = next;
    else {
      for (let j = i + 1; j < tokens.length; j++) {
        const candidate = tokens[j];
        if (candidate.value === ';' || (j > i + 1 && !candidate.quoted && ['import', 'export'].includes(candidate.value))) break;
        if (!candidate.quoted && candidate.value === 'from' && tokens[j + 1]?.quoted) { module = tokens[j + 1]; break; }
        // An import-equals declaration is outside this verified grammar.
        if (candidate.value === '=') break;
      }
    }
    if (module) declarations.push({ line: token.line, column: token.col, endLine: module.endLine, endColumn: module.endCol, specifier: module.value });
  }
  return declarations;
}

/** Directory depth is absolute from the repository root. Root files belong to '.'. */
export function dependencyGroup(path: string, groupBy: 'directory' | 'file', depth: number): string {
  if (groupBy === 'file') return path;
  const directory = posix.dirname(path);
  return directory === '.' ? '.' : directory.split('/').slice(0, depth).join('/');
}

/** All cycles returned are proven in the observed graph, even when completeness is false. */
function cycles(groups: Group[], edges: AggregateEdge[], complete: boolean, id: (raw: string) => string): NonNullable<CodeGraphResponse['cycles']> {
  const nodes = groups.filter(group => !group.node.aggregate || (group.node.aggregate.resolution === 'internal' && !group.node.aggregate.collapsed)).map(group => group.node.id);
  const adjacency = new Map(nodes.map(node => [node, [] as string[]]));
  for (const { edge } of edges) if (edge.resolution === 'internal') adjacency.get(edge.source)?.push(edge.target);
  let sequence = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>();
  const components: string[][] = [];
  function visit(node: string) {
    indices.set(node, sequence); low.set(node, sequence++); stack.push(node); active.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!adjacency.has(next)) continue;
      if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (active.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!));
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []; let item: string;
      do { item = stack.pop()!; active.delete(item); component.push(item); } while (item !== node);
      if (component.length > 1 || adjacency.get(node)?.includes(node)) components.push(component.sort());
    }
  }
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components.map(nodeIds => {
    const members = new Set(nodeIds);
    return { id: id(`dependency-cycle:${hash(nodeIds.join('\0'))}`), nodeIds,
      edgeIds: edges.filter(({ edge }) => edge.resolution === 'internal' && members.has(edge.source) && members.has(edge.target)).map(({ edge }) => edge.id).sort(), complete };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function queryAggregation(env: StructuredModeContext): void { queryGrouped(env, false); }
export function queryClusters(env: StructuredModeContext): void { queryGrouped(env, true); }

function queryGrouped(env: StructuredModeContext, clusters: boolean): void {
  const { request, result } = env;
  const groupBy = request.groupBy ?? 'directory';
  if (!clusters && groupBy === 'symbol') { result.state = 'unsupported'; result.warnings.push('unsupported_grouping'); return; }
  const kinds = request.edgeKinds ?? ['imports'];
  if (kinds.length !== 1 || !['imports', 'calls'].includes(kinds[0])) {
    result.state = 'unsupported'; result.warnings.push('select_one_dependency_kind_imports_or_calls'); return;
  }
  const kind = kinds[0];
  if (kind === 'imports') result.warnings.push('sdk_import_extraction_incomplete');
  const moduleDepth = request.moduleDepth ?? 1;
  const scope = (request.scopePath ?? env.root?.file_path ?? '').replace(/\/$/, '');
  if (clusters && groupBy === 'symbol' && !scope) { result.state = 'unsupported'; result.warnings.push('symbol_scope_required'); return; }
  const prefix = clusters ? 'cluster' : 'dependency';
  const relationInScope = (sourcePath: string, targetPath: string, resolution: Resolution) => within(sourcePath, scope) || (clusters && resolution === 'internal' && within(targetPath, scope));
  const nodeLimit = request.limit ?? env.limits.nodes, edgeLimit = request.edgeLimit ?? env.limits.edges;
  const evidenceOnly = Boolean(request.evidenceFor);
  if (evidenceOnly && !env.rawId(request.evidenceFor!)?.startsWith(`${prefix}-edge:`)) {
    result.state = 'not_found'; result.warnings.push('dependency_edge_not_in_asset'); return;
  }
  const state: State = structuredClone((env.state as State | undefined) ?? { phase: evidenceOnly && !clusters ? 'edges' : 'nodes', after: 0, groups: [], edges: [], sites: [], distinctSites: [], resolvedImportAnchors: [], diagnostics: [], diagnosticIds: [], scannedNodes: 0, scannedEdges: 0, warnings: [] });
  const groups = new Map(state.groups.map(group => [group.key, group]));
  const edges = new Map(state.edges.map(edge => [edge.edge.id, edge]));
  const sites = new Set(state.sites);
  const distinctSites = new Set(state.distinctSites);
  const resolvedImportAnchors = new Set(state.resolvedImportAnchors);
  const evidence: Evidence[] = [];
  let pageFull = false, sourceBytes = 0, sourceBudget = false, changedSource = false;
  let validationBudget: ReturnType<StructuredModeContext['edgeValidationDeferred']> = null;
  const declarations = new Map<string, Declaration[] | null>();
  const warn = (message: string) => { if (!state.warnings.includes(message)) state.warnings.push(message); };
  const supportedLanguage = (language: string) => {
    if (result.capabilities.languages.includes(language)) return true;
    state.incomplete = true; warn(`unverified_language:${language}`); return false;
  };
  function declaration(path: string, line: number, column: number | null, language: string): Declaration | undefined {
    if (!declarations.has(path)) {
      env.consume(1);
      const indexed = env.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(path) as { content_hash: string } | undefined;
      if (!indexed) { declarations.set(path, null); state.incomplete = true; warn('import_declaration_source_unavailable'); return; }
      let fd: number | undefined;
      try {
        const base = realpathSync(env.ctx.projectRoot), real = realpathSync(resolve(base, path));
        const rel = relative(base, real);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('unsafe');
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd), checkedReal = realpathSync(real), checkedRel = relative(base, checkedReal);
        if (isAbsolute(checkedRel) || checkedRel === '..' || checkedRel.startsWith(`..${sep}`)) throw new Error('unsafe');
        const current = statSync(checkedReal);
        if (!stat.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('unsafe');
        if (stat.size > SOURCE_BYTES) throw new Error('oversize');
        if (stat.size > SOURCE_BYTES - sourceBytes) { sourceBudget = true; return; }
        // The extra byte detects concurrent growth; it is charged to the same
        // cumulative read budget, never read past the request's remaining bytes.
        const buffer = Buffer.alloc(Math.min(stat.size + 1, SOURCE_BYTES - sourceBytes));
        let length = 0, count = 0;
        do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
        sourceBytes += length;
        const content = buffer.subarray(0, length);
        const afterRead = fstatSync(fd);
        if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || createHash('sha256').update(content).digest('hex') !== indexed.content_hash) { changedSource = true; return; }
        const source = content.toString('utf8');
        declarations.set(path, language === 'java' ? parseJavaImports(source).map(item => {
          const startOfLine = source.lastIndexOf('\n', item.start - 1) + 1;
          const endOfLine = source.lastIndexOf('\n', item.end - 1) + 1;
          return { line: item.line, column: Buffer.byteLength(source.slice(startOfLine, item.start)),
            endLine: item.line + (source.slice(item.start, item.end).match(/\n/g)?.length ?? 0),
            endColumn: Buffer.byteLength(source.slice(endOfLine, item.end)), specifier: item.specifier };
        }) : dependencyDeclarations(source));
      } catch {
        declarations.set(path, null); state.incomplete = true; warn('import_declaration_source_unavailable'); return;
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    const matches = declarations.get(path);
    // SDK locations are UTF-8 byte columns; multiline binding positions map to
    // their enclosing declaration, not the declaration's line alone.
    const found = matches && [...matches].reverse().find(item => (line > item.line || (line === item.line && (column ?? 0) >= item.column)) && (line < item.endLine || (line === item.endLine && (column ?? 0) <= item.endColumn)));
    if (!found) { state.incomplete = true; warn('import_declaration_anchor_unverified'); }
    return found ?? undefined;
  }
  const levelFor = (path: string) => clusters && !within(path, scope) ? 'directory' : groupBy;
  const keyFor = (path: string, resolution: Resolution = 'internal', nodeId?: string) => {
    if (!clusters) return `${resolution}:${groupBy}:${moduleDepth}:${resolution === 'internal' ? dependencyGroup(path, groupBy as 'directory' | 'file', moduleDepth) : path}`;
    const level = levelFor(path);
    return resolution !== 'internal' ? `${resolution}:${path}` : level === 'symbol' ? `internal:symbol:${nodeId}` : `internal:${level}:${dependencyGroup(path, level, moduleDepth)}`;
  };
  const groupId = (key: string) => env.id(`${prefix}-group:${hash(key)}`);
  const edgeId = (sourceKey: string, targetKey: string) => env.id(`${prefix}-edge:${kind}:${hash(`${sourceKey}\0${targetKey}`)}`);
  const group = (path: string, resolution: Resolution = 'internal', row?: NodeRow, priority = false): Group | undefined => {
    const key = keyFor(path, resolution, row && env.id(row.id));
    if (groups.has(key)) return groups.get(key);
    if (clusters && !priority && groups.size >= Math.max(0, nodeLimit - 2)) {
      const boundary = resolution !== 'internal' || !within(path, scope);
      const foldedKey = `collapsed:${boundary ? 'boundary' : 'members'}:${groupBy}:${scope}`;
      if (groups.has(foldedKey)) return groups.get(foldedKey);
      if (groups.size >= nodeLimit) {
        // At a tiny requested limit even the two overflow buckets may not fit
        // beside a priority symbol. Preserve a single explicitly mixed bucket.
        const existing = [...groups.values()].find(item => item.node.aggregate?.collapsed)!;
        if (existing) { existing.node.aggregate!.boundary = true; existing.node.aggregate!.resolution = 'unresolved'; warn('cluster_boundary_collapsed'); return existing; }
        state.stopped = 'node_budget'; return;
      }
      warn('cluster_members_collapsed');
      const item: Group = { key: foldedKey, outsideScope: boundary, node: {
        id: groupId(foldedKey), name: scope || '.', qualifiedName: scope || '.', kind: 'collapsed', filePath: scope,
        language: 'aggregate', startLine: 0, endLine: 0,
        aggregate: { path: scope, level: groupBy === 'symbol' ? 'file' : 'directory', fileCount: 0, symbolCount: 0, internalCount: 0, resolution: boundary ? 'unresolved' : 'internal', complete: false, boundary, collapsed: true },
      } };
      groups.set(foldedKey, item); return item;
    }
    if (groups.size >= nodeLimit) { state.stopped = 'node_budget'; return; }
    if (clusters && resolution === 'internal' && levelFor(path) === 'symbol' && row) {
      const item = { key, outsideScope: false, node: env.toNode(row) }; groups.set(key, item); return item;
    }
    const level = levelFor(path) as 'directory' | 'file';
    const mapped = resolution === 'internal' ? dependencyGroup(path, level, moduleDepth) : path;
    const item: Group = { key, outsideScope: resolution === 'internal' && !within(path, scope), node: {
      id: groupId(key), name: mapped === '.' ? '.' : mapped, qualifiedName: mapped,
      kind: resolution === 'internal' ? (level === 'directory' ? 'module' : 'file') : resolution,
      filePath: resolution === 'internal' ? mapped : '', language: 'aggregate', startLine: 0, endLine: 0,
      aggregate: { path: mapped, level: resolution === 'internal' ? level : 'external', fileCount: 0, symbolCount: 0, internalCount: 0, resolution, complete: false, ...(clusters ? { boundary: resolution !== 'internal' || !within(path, scope) } : {}) },
    } };
    groups.set(key, item); return item;
  };
  function accept(item: Evidence, sourcePath: string, targetPath: string, sourceRow: NodeRow, targetRow?: NodeRow): boolean {
    if (!relationInScope(sourcePath, targetPath, item.resolution)) return true;
    // Cluster overflow membership is fixed by the deterministic node scan, then
    // edge scan. The evidence scan follows the same order to recover exact IDs.
    const clusterSource = clusters ? group(sourcePath, 'internal', sourceRow) : undefined;
    const clusterTarget = clusters ? group(targetPath, item.resolution, targetRow) : undefined;
    if (clusters && (!clusterSource || !clusterTarget)) return false;
    const sourceKey = clusterSource?.key ?? keyFor(sourcePath, 'internal', item.sourceId), targetKey = clusterTarget?.key ?? keyFor(targetPath, item.resolution, item.targetId);
    const aggregateId = edgeId(sourceKey, targetKey);
    if (evidenceOnly && aggregateId !== request.evidenceFor) return true;
    // Import evidence has already been normalized to its verified declaration
    // start. Two imports on one line retain different declaration columns.
    const site = hash(JSON.stringify([kind, sourcePath, item.line, item.column ?? null, targetPath, item.resolution]));
    // A declaration can resolve several real symbols in the same target file.
    // Preserve visible endpoint relations; keep a separate cross-level site total.
    const dedup = clusters && groupBy === 'symbol' ? hash(`${site}\0${sourceKey}\0${targetKey}`) : site;
    if (sites.has(dedup)) return true;
    if (sites.size >= MAX_SITES) { state.stopped = 'aggregation_site_budget'; return false; }
    if (evidenceOnly) { sites.add(dedup); distinctSites.add(site); evidence.push(item); if (evidence.length >= edgeLimit) pageFull = true; return true; }
    // Preflight both budgets so an uncounted dependency never leaves a dangling edge.
    const additions = new Set([sourceKey, targetKey].filter(key => !groups.has(key)));
    if (groups.size + additions.size > nodeLimit) { state.stopped = 'node_budget'; return false; }
    if ((sourceKey !== targetKey || (clusters && !clusterSource?.node.aggregate)) && !edges.has(aggregateId) && edges.size >= edgeLimit) { state.stopped = 'edge_budget'; return false; }
    const source = clusterSource ?? group(sourcePath, 'internal', sourceRow)!, target = clusterTarget ?? group(targetPath, item.resolution, targetRow)!;
    sites.add(dedup); distinctSites.add(site);
    if (sourceKey === targetKey && source.node.aggregate) { source.node.aggregate.internalCount!++; return true; }
    let aggregated = edges.get(aggregateId);
    if (!aggregated) {
      aggregated = { sourceKey, targetKey, edge: { id: aggregateId, source: source.node.id, target: target.node.id, kind, evidence: [], count: 0, complete: false, resolution: item.resolution } };
      edges.set(aggregateId, aggregated);
    }
    aggregated.edge.count!++;
    if (aggregated.edge.evidence.length < SAMPLE_EVIDENCE) aggregated.edge.evidence.push({ filePath: sourcePath, line: item.line, ...(item.column !== undefined ? { column: item.column } : {}) });
    return true;
  }
  function resolved(row: EdgeRow): boolean {
    if (row.kind !== kind) return true;
    const source = env.lookup(row.source), target = env.lookup(row.target);
    if (!source || !target) { state.incomplete = true; warn('dangling_dependency_omitted'); return true; }
    if (!safePath(source.file_path) || !safePath(target.file_path)) { state.incomplete = true; warn('unsafe_index_path_omitted'); return true; }
    if (!relationInScope(source.file_path, target.file_path, 'internal')) return true;
    if (!supportedLanguage(source.language) || !supportedLanguage(target.language)) return true;
    if (!env.acceptEdge(row, source, target)) {
      validationBudget = env.edgeValidationDeferred();
      // A request's validation allowance can end after reading this edge. Its
      // cursor must stay before the edge so a fresh page can verify it in full.
      if (validationBudget) return false;
      state.incomplete = true;
      // Rejections may precede the last scan page. Keep their explanation with
      // the cumulative counts, rather than losing it when the request ends.
      for (const warning of result.warnings) warn(warning);
      return true;
    }
    const anchor = kind === 'imports' ? declaration(source.file_path, row.line ?? source.start_line, row.col, source.language) : undefined;
    if (changedSource || sourceBudget) return false;
    if (kind === 'imports' && !anchor) return true;
    if (anchor) {
      const anchorId = hash(`${source.file_path}\0${anchor.line}\0${anchor.column}`);
      if (!resolvedImportAnchors.has(anchorId) && resolvedImportAnchors.size >= MAX_SITES) { state.stopped = 'aggregation_site_budget'; return false; }
      resolvedImportAnchors.add(anchorId);
    }
    return accept({ id: env.id(`edge:${row.id}`), sourceId: env.id(source.id), targetId: env.id(target.id), sourceFile: source.file_path, targetFile: target.file_path,
      line: anchor?.line ?? row.line ?? source.start_line, ...(anchor ? { column: anchor.column } : row.col !== null ? { column: row.col } : {}), kind, resolution: 'internal' }, source.file_path, target.file_path, source, target);
  }
  function unresolved(row: UnresolvedRow): boolean {
    if (row.reference_kind !== kind) return true;
    const source = env.lookup(row.from_node_id);
    if (!source || !safePath(source.file_path)) { state.incomplete = true; warn('unresolved_source_unavailable'); return true; }
    if (!within(source.file_path, scope)) return true;
    if (!supportedLanguage(source.language)) return true;
    const anchor = kind === 'imports' ? declaration(source.file_path, row.line, row.col, source.language) : undefined;
    if (changedSource || sourceBudget) return false;
    if (kind === 'imports' && !anchor) return true;
    if (anchor && resolvedImportAnchors.has(hash(`${source.file_path}\0${anchor.line}\0${anchor.column}`))) {
      // The module is already resolved; an unresolved named binding is not an
      // additional dependency on a fictitious external module.
      warn('unresolved_binding_in_resolved_import');
      if (!state.diagnosticIds.includes(row.id)) {
        if (state.diagnostics.length < edgeLimit) { state.diagnosticIds.push(row.id); state.diagnostics.push({ sourceId: env.id(source.id), name: row.reference_name, kind, filePath: source.file_path, line: row.line, ...(row.col !== null ? { column: row.col } : {}) }); }
        else { state.incomplete = true; warn('unresolved_diagnostic_budget'); }
      }
      return true;
    }
    const target = anchor?.specifier ?? row.reference_name;
    // Bare specifiers may be package aliases; only a known Node builtin is
    // provably external without consulting unversioned package configuration.
    // Java has no verified classpath/JDK resolution here. A dotted package name
    // alone cannot prove whether it is external, absent or a missed local type.
    const resolution = kind === 'imports' && source.language !== 'java' && isBuiltin(target) ? 'external' : 'unresolved';
    return accept({ id: env.id(`unresolved:${row.id}`), sourceId: env.id(source.id), sourceFile: source.file_path, targetFile: target,
      line: anchor?.line ?? row.line, ...(anchor ? { column: anchor.column } : row.col !== null ? { column: row.col } : {}), kind, resolution }, source.file_path, target, source);
  }
  if (clusters && groupBy === 'symbol' && env.root && within(env.root.file_path, scope)) group(env.root.file_path, 'internal', env.root, true);
  while (state.phase !== 'done' && !state.stopped && !pageFull && !sourceBudget && !validationBudget && !changedSource && env.remaining() >= 5) {
    if (state.phase === 'nodes') {
      const batch = env.readNodes(state.after, Math.min(100, env.remaining() - 3));
      if (!batch.length) { state.phase = 'edges'; state.after = 0; continue; }
      for (const row of batch) {
        state.scannedNodes++; state.after = row.rowid!;
        if (!safePath(row.file_path) || !within(row.file_path, scope)) continue;
        if (!supportedLanguage(row.language)) continue;
        const member = group(row.file_path, 'internal', row);
        if (!member) break;
        if (member.node.aggregate) {
          if (row.kind === 'file') member.node.aggregate.fileCount++;
          else member.node.aggregate.symbolCount++;
        }
      }
    } else if (state.phase === 'edges') {
      const batch = env.readEdges(state.after, 1);
      if (!batch.length) { state.phase = env.hasUnresolved ? 'unresolved' : 'done'; state.after = 0; continue; }
      state.scannedEdges++;
      if (!resolved(batch[0])) break;
      state.after = batch[0].id;
    } else {
      const batch = env.readUnresolved(state.after, 1);
      if (!batch.length) { state.phase = 'done'; break; }
      state.scannedEdges++;
      if (!unresolved(batch[0])) break;
      state.after = batch[0].id;
    }
  }
  if (changedSource) { result.state = 'version_expired'; result.nodes = []; result.edges = []; result.focusId = null; result.nextCursor = null; result.warnings = ['source_changed_since_index']; return; }
  if (!env.hasUnresolved) { state.incomplete = true; warn('unresolved_reference_index_unavailable'); }
  const scanComplete = state.phase === 'done', complete = scanComplete && !state.incomplete;
  state.groups = [...groups.values()]; state.edges = [...edges.values()]; state.sites = [...sites]; state.distinctSites = [...distinctSites]; state.resolvedImportAnchors = [...resolvedImportAnchors];
  if (!scanComplete && !state.stopped && Buffer.byteLength(JSON.stringify(state)) > MAX_CURSOR_BYTES) state.stopped = 'aggregation_memory_budget';
  result.nodes = evidenceOnly ? [] : state.groups.map(({ node, outsideScope }) => node.aggregate ? ({ ...node, count: node.aggregate.symbolCount, aggregate: { ...node.aggregate, complete: complete && !outsideScope && !node.aggregate.collapsed } }) : node);
  result.edges = evidenceOnly ? [] : state.edges.map(({ edge }) => ({ ...edge, complete }));
  result.focusId = clusters && groupBy === 'symbol' && env.root && result.nodes.some(node => node.id === env.id(env.root!.id)) ? env.id(env.root.id) : null;
  result.aggregation = { groupBy, moduleDepth, complete, countMetric: kind === 'imports' ? 'unique_import_site_target_file' : 'unique_call_site_target_file', merge: 'replace', distinctSiteCount: distinctSites.size, scannedNodes: state.scannedNodes, scannedEdges: state.scannedEdges };
  result.cycles = evidenceOnly ? [] : cycles(state.groups, state.edges, complete, env.id);
  if (evidenceOnly) result.dependencyEvidence = evidence;
  if (state.diagnostics.length) result.unresolved = state.diagnostics;
  if (clusters) {
    const breadcrumbs: NonNullable<CodeGraphResponse['clustering']>['breadcrumbs'] = [{ path: '', groupBy: 'directory', label: '/' }];
    if (scope === '.') breadcrumbs.push({ path: '.', groupBy: 'file', label: '.' });
    else if (scope) {
      const parts = scope.split('/');
      for (let i = 0; i < parts.length; i++) breadcrumbs.push({ path: parts.slice(0, i + 1).join('/'), groupBy: groupBy === 'symbol' && i === parts.length - 1 ? 'symbol' : 'file', label: parts[i] });
    }
    result.clustering = { groupBy, scopePath: scope, moduleDepth, boundaryPolicy: 'both', breadcrumbs };
  }
  result.warnings.push(...state.warnings);
  if (!complete) {
    result.truncated = true;
    result.truncationReasons = [state.stopped ?? (scanComplete ? 'unverified_import_sites' : validationBudget ?? (sourceBudget ? 'source_scan_budget' : pageFull ? 'evidence_budget' : 'scan_budget'))];
    result.warnings.push('partial_dependency_counts', 'cycles_only_in_observed_graph');
    if (!state.stopped && !scanComplete) env.setContinuation(state);
  }
  if (clusters && state.groups.some(item => item.node.aggregate?.collapsed)) {
    result.truncated = true;
    result.truncationReasons.push('collapsed_node_budget');
  }
  // Evidence-only pages intentionally contain no graph nodes, but are not empty when evidence exists.
  if (evidenceOnly && evidence.length) result.state = 'ready';
  if (!evidenceOnly && !result.nodes.length && state.warnings.some(value => value.startsWith('unverified_language:'))) result.state = 'unsupported';
}
