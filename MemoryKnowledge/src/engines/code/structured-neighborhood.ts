import type { CodeGraphNode } from '../../contracts/code-graph.js';
import type { NodeRow, StructuredModeContext } from './structured-mode-context.js';

type Mode = 'impact' | 'hierarchy';
interface Visit { distance: number; parent?: string; edge?: number }
interface Item { id: string; distance: number; side: number; kind: number; after: number; unresolvedAfter: number; unresolvedDone: boolean }
interface State { queue: Item[]; visits: Record<string, Visit>; edges: number[] }
const KINDS: Record<Mode, string[]> = {
  impact: ['calls', 'imports', 'extends', 'implements', 'references'],
  hierarchy: ['extends', 'implements'],
};
const item = (id: string, distance: number): Item => ({ id, distance, side: 0, kind: 0, after: 0, unresolvedAfter: 0, unresolvedDone: false });

/** Indexed, budgeted BFS. No relationship is reversed or invented for display. */
export function queryNeighborhood(env: StructuredModeContext, mode: Mode): void {
  const { request, result, root, limits } = env;
  if (!root) return;
  if (mode === 'hierarchy' && !['class', 'interface'].includes(root.kind)) {
    result.state = 'empty'; result.warnings.push('select_a_type'); return;
  }
  if (mode === 'hierarchy') {
    result.warnings.push('typescript_interface_extends_not_extracted');
    if (root.kind === 'interface' && (request.direction === 'out' || (request.edgeKinds?.length && request.edgeKinds.every(kind => kind === 'extends')))) {
      result.state = 'unsupported'; return;
    }
  }
  if (mode === 'impact') result.warnings.push('static_analysis_potential_impact', 'unresolved_or_dynamic_relations_not_complete');
  if (!env.hasUnresolved) result.warnings.push('unresolved_coverage_unavailable');
  const requested = request.edgeKinds;
  const kinds = requested ? KINDS[mode].filter(k => requested.includes(k)) : KINDS[mode];
  if (requested?.some(k => !KINDS[mode].includes(k))) result.warnings.push('unsupported_relation_filter_omitted');
  if (!kinds.length) { result.state = 'empty'; return; }
  const depth = request.depth ?? (mode === 'impact' ? 2 : 1);
  const direction = mode === 'impact' ? 'in' : request.direction ?? 'both';
  const sides: ('source' | 'target')[] = direction === 'both' ? ['source', 'target'] : [direction === 'in' ? 'target' : 'source'];
  const nodeLimit = request.limit ?? limits.nodes;
  const edgeLimit = request.edgeLimit ?? limits.edges;
  const state: State = structuredClone(env.state ?? { queue: [item(root.id, 0)], visits: { [root.id]: { distance: 0 } }, edges: [] }) as State;
  const emitted = new Set(state.edges);
  const page = new Map<string, CodeGraphNode>();
  const cache = new Map<string, NodeRow | undefined>([[root.id, root]]);
  const lookup = (id: string) => { if (!cache.has(id)) cache.set(id, env.lookup(id)); return cache.get(id); };
  const add = (row: NodeRow) => { const n = env.toNode(row); if (mode === 'impact') n.depth = state.visits[row.id]?.distance; page.set(n.id, n); };
  if (!env.state) add(root);
  let hardLimit = false, stopReason = '';
  result.edges = [];
  result.unresolved = [];
  while (state.queue.length && env.remaining() >= 4) {
    const current = state.queue[0];
    // Unresolved clauses are real indexed records, not synthetic graph nodes/edges.
    if (!current.unresolvedDone && env.hasUnresolved) {
      if (result.unresolved.length >= edgeLimit) { stopReason = 'unresolved_budget'; break; }
      const refs = env.unresolvedFrom(current.id, current.unresolvedAfter, 1);
      if (!refs.length) current.unresolvedDone = true;
      else {
        const ref = refs[0];
        if (!kinds.includes(ref.reference_kind)) { current.unresolvedAfter = ref.id; continue; }
        const source = lookup(current.id);
        if (source && !page.has(env.id(source.id)) && page.size >= nodeLimit) { stopReason = 'node_budget'; break; }
        current.unresolvedAfter = ref.id;
        if (source) {
          add(source);
          result.unresolved.push({ sourceId: env.id(current.id), name: ref.reference_name, kind: ref.reference_kind, filePath: ref.file_path || source.file_path, line: ref.line, ...(ref.col !== null ? { column: ref.col } : {}) });
        }
        continue;
      }
    }
    if (current.distance >= depth || current.side >= sides.length) { state.queue.shift(); continue; }
    if (result.edges.length >= edgeLimit) { stopReason = 'edge_budget'; break; }
    if (current.kind >= kinds.length) { current.side++; current.kind = 0; current.after = 0; continue; }
    const side = sides[current.side];
    const edge = env.adjacent(current.id, side, kinds[current.kind], current.after);
    if (!edge) { current.kind++; current.after = 0; continue; }
    if (emitted.has(edge.id)) { current.after = edge.id; continue; }
    const source = lookup(edge.source), target = lookup(edge.target);
    if (!source || !target) { current.after = edge.id; result.warnings.push('dangling_edge_omitted'); continue; }
    const neighbor = side === 'source' ? target : source;
    if (mode === 'hierarchy' && !['class', 'interface'].includes(neighbor.kind)) { current.after = edge.id; result.warnings.push('non_type_relation_omitted'); continue; }
    if (!result.capabilities.languages.includes(neighbor.language)) { current.after = edge.id; result.warnings.push(`unverified_language:${neighbor.language}`); continue; }
    const scope = request.scopePath?.replace(/\/$/, '');
    if ((scope && neighbor.file_path !== scope && !neighbor.file_path.startsWith(scope + '/')) || (request.nodeKinds?.length && !request.nodeKinds.includes(neighbor.kind))) { current.after = edge.id; continue; }
    const additions = [source, target].filter((row, i, all) => all.findIndex(n => n.id === row.id) === i && !page.has(env.id(row.id)));
    if (page.size + additions.length > nodeLimit) { stopReason = 'node_budget'; break; }
    if ((!state.visits[neighbor.id] && Object.keys(state.visits).length >= limits.maxNodes) || emitted.size >= limits.maxEdges) { hardLimit = true; stopReason = 'traversal_budget'; break; }
    if (!state.visits[neighbor.id]) {
      state.visits[neighbor.id] = { distance: current.distance + 1, parent: current.id, edge: edge.id };
      state.queue.push(item(neighbor.id, current.distance + 1));
    }
    for (const row of additions) add(row);
    result.edges.push(env.toEdge(edge, source)); emitted.add(edge.id); current.after = edge.id;
  }
  // Depth-bound nodes still need their unresolved clauses checked; trim only finished work.
  while (state.queue.length && (state.queue[0].unresolvedDone || !env.hasUnresolved) && (state.queue[0].distance >= depth || state.queue[0].side >= sides.length)) state.queue.shift();
  result.nodes = [...page.values()];
  if (mode === 'impact') {
    result.impactPaths = [];
    for (const n of result.nodes) {
      const raw = env.rawId(n.id)!;
      if (!state.visits[raw]?.distance) continue;
      const nodeIds = [n.id], edgeIds: string[] = [];
      let current = raw;
      for (let i = 0; i < limits.depth; i++) {
        const visit = state.visits[current];
        if (!visit.parent || visit.edge === undefined) break;
        edgeIds.push(env.id(`edge:${visit.edge}`)); nodeIds.push(env.id(visit.parent)); current = visit.parent;
      }
      if (current === root.id) result.impactPaths.push({ nodeId: n.id, nodeIds, edgeIds });
      else result.warnings.push('incomplete_evidence_path');
    }
  }
  if (state.queue.length) {
    result.truncated = true; result.truncationReasons = [stopReason || 'scan_budget'];
    if (!hardLimit) env.setContinuation({ ...state, edges: [...emitted] });
  }
  if (!result.edges.length && !result.truncated) result.state = mode === 'hierarchy' && root.kind === 'interface' && direction === 'both' ? 'unsupported' : 'empty';
  result.warnings = [...new Set(result.warnings)];
}
