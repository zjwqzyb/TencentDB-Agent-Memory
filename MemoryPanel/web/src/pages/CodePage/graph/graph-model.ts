import type { CodeGraphNode, CodeGraphResponse } from '@/lib/api/code-graph-contract';

export const VISIBLE_NODE_LIMIT = 500;
export const VISIBLE_EDGE_LIMIT = 1500;

/** Merge pages by their opaque IDs. Never merge snapshots or create dangling edges. */
export function mergeGraph(
  previous: CodeGraphResponse,
  incoming: CodeGraphResponse,
): CodeGraphResponse {
  if (previous.assetId !== incoming.assetId || previous.indexVersion !== incoming.indexVersion) {
    throw new Error('version_expired');
  }
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]));
  let limited = false;
  for (const node of incoming.nodes) {
    if (nodes.has(node.id) || nodes.size < VISIBLE_NODE_LIMIT) {
      const old = nodes.get(node.id);
      nodes.set(
        node.id,
        old?.depth !== undefined && node.depth !== undefined
          ? { ...node, depth: Math.min(old.depth, node.depth) }
          : node,
      );
    } else limited = true;
  }
  const edges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  for (const edge of incoming.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      limited = true;
      continue;
    }
    if (edges.has(edge.id) || edges.size < VISIBLE_EDGE_LIMIT) edges.set(edge.id, edge);
    else limited = true;
  }
  const paths = new Map(previous.impactPaths?.map((path) => [path.nodeId, path]));
  for (const path of incoming.impactPaths ?? []) {
    const old = paths.get(path.nodeId);
    if (!old || path.edgeIds.length <= old.edgeIds.length) paths.set(path.nodeId, path);
  }
  const impactPaths = [...paths.values()].filter(
    (path) =>
      path.nodeIds.length === path.edgeIds.length + 1 &&
      path.nodeIds[0] === path.nodeId &&
      path.nodeIds.at(-1) === previous.focusId &&
      path.nodeIds.every((id) => nodes.has(id)) &&
      path.edgeIds.every((id, index) => {
        const edge = edges.get(id);
        return edge?.source === path.nodeIds[index] && edge.target === path.nodeIds[index + 1];
      }),
  );
  const unresolved = new Map(
    [...(previous.unresolved ?? []), ...(incoming.unresolved ?? [])].map((row) => [
      JSON.stringify([row.sourceId, row.name, row.kind, row.filePath, row.line, row.column]),
      row,
    ]),
  );
  return {
    ...incoming,
    state: nodes.size ? 'ready' : 'empty',
    focusId: previous.focusId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    ...(paths.size ? { impactPaths } : {}),
    ...(unresolved.size ? { unresolved: [...unresolved.values()] } : {}),
    truncated: incoming.truncated || limited,
    truncationReasons: [
      ...new Set([...incoming.truncationReasons, ...(limited ? ['visible_budget'] : [])]),
    ],
  };
}

/** User-facing coverage reasons, independent of internal diagnostic codes. */
export function coverageNoticeKeys(data: CodeGraphResponse): string[] {
  const warnings = new Set(data.warnings),
    reasons = new Set(data.truncationReasons);
  const keys: string[] = [];
  if (warnings.has('unresolved_diagnostic_budget')) keys.push('code.graph.diagnosticBudget');
  if (reasons.has('collapsed_node_budget')) keys.push('code.graph.collapsedBudget');
  if (warnings.has('sdk_import_extraction_incomplete'))
    keys.push('code.graph.importExtractionLimit');
  if (
    warnings.has('import_declaration_source_unavailable') ||
    warnings.has('import_declaration_anchor_unverified') ||
    (reasons.has('unverified_import_sites') && !warnings.has('unresolved_diagnostic_budget'))
  )
    keys.push('code.graph.importUnverified');
  if (
    warnings.has('unresolved_reference_index_unavailable') ||
    warnings.has('unresolved_source_unavailable')
  )
    keys.push('code.graph.unknownCoverage');
  if (data.truncated) {
    if (data.nextCursor) keys.push('code.graph.continueScan');
    else if (
      [
        'aggregation_memory_budget',
        'aggregation_site_budget',
        'node_budget',
        'edge_budget',
        'visible_budget',
      ].some((reason) => reasons.has(reason))
    )
      keys.push('code.graph.hardLimit');
    else if (!keys.length) keys.push('code.graph.incompleteNoCursor');
  }
  return keys;
}

export interface Position {
  x: number;
  y: number;
}

/** Collapse SCCs before assigning ranks; recursion and diamonds cannot create an infinite layout. */
export function stablePositions(
  data: Pick<CodeGraphResponse, 'nodes' | 'edges'>,
  previous = new Map<string, Position>(),
): Map<string, Position> {
  const ids = new Set(data.nodes.map((node) => node.id));
  const adjacency = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of data.edges)
    if (ids.has(edge.source) && ids.has(edge.target)) adjacency.get(edge.source)!.push(edge.target);
  let next = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    onStack = new Set<string>(),
    components: string[][] = [];
  function visit(id: string) {
    indices.set(id, next);
    low.set(id, next++);
    stack.push(id);
    onStack.add(id);
    for (const other of adjacency.get(id)!) {
      if (!indices.has(other)) {
        visit(other);
        low.set(id, Math.min(low.get(id)!, low.get(other)!));
      } else if (onStack.has(other)) low.set(id, Math.min(low.get(id)!, indices.get(other)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component.sort());
    }
  }
  [...ids].sort().forEach((id) => {
    if (!indices.has(id)) visit(id);
  });
  const membership = new Map<string, number>();
  components.forEach((component, index) => component.forEach((id) => membership.set(id, index)));
  const rank = new Map<number, number>();
  const parents = components.map(() => new Set<number>());
  data.edges.forEach((edge) => {
    const from = membership.get(edge.source),
      to = membership.get(edge.target);
    if (from !== undefined && to !== undefined && from !== to) parents[to].add(from);
  });
  function getRank(index: number): number {
    if (!rank.has(index))
      rank.set(index, Math.max(0, ...[...parents[index]].map((parent) => getRank(parent) + 1)));
    return rank.get(index)!;
  }
  const positions = new Map<string, Position>();
  const rows = new Map<number, number>();
  components.forEach((component, index) => {
    const column = getRank(index),
      row = rows.get(column) ?? 0;
    component.forEach((id, offset) => {
      // Keep the same coordinate system and camera on incremental expansion.
      positions.set(id, previous.get(id) ?? { x: column * 3, y: -(row + offset) * 2 });
    });
    rows.set(column, row + component.length + 0.5);
  });
  // New nodes should not overlap an existing node that retained its position.
  const occupied = new Set<string>();
  for (const node of data.nodes.filter((node) => previous.has(node.id))) {
    const p = positions.get(node.id)!;
    occupied.add(`${p.x}:${p.y}`);
  }
  for (const node of data.nodes.filter((node) => !previous.has(node.id))) {
    const p = positions.get(node.id)!;
    while (occupied.has(`${p.x}:${p.y}`)) p.y -= 2;
    occupied.add(`${p.x}:${p.y}`);
  }
  return positions;
}

export function nodeLocation(node: CodeGraphNode): string {
  return node.aggregate ? node.aggregate.path || node.name : `${node.filePath}:${node.startLine}`;
}

/** A real directed evidence chain, never an invented shortcut between two nodes. */
export function findRelationPath(
  edges: CodeGraphResponse['edges'],
  from: string,
  to: string,
): string[] {
  const queue = [from],
    visited = new Set([from]);
  const parents = new Map<string, { node: string; edge: string }>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current === to) {
      const path: string[] = [];
      for (let node = to; node !== from;) {
        const parent = parents.get(node)!;
        path.unshift(parent.edge);
        node = parent.node;
      }
      return path;
    }
    for (const edge of edges)
      if (edge.source === current && !visited.has(edge.target)) {
        visited.add(edge.target);
        parents.set(edge.target, { node: current, edge: edge.id });
        queue.push(edge.target);
      }
  }
  return [];
}

/** Only supported public GitHub URLs have a predictable immutable blob URL. */
export function sourceLink(
  repoUrl: string,
  commit: string | null,
  node: CodeGraphNode,
): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(
    repoUrl,
  );
  if (
    !match ||
    !commit ||
    !/^[a-f0-9]{7,64}$/i.test(commit) ||
    !node.filePath ||
    node.filePath.split('/').includes('..')
  )
    return null;
  return `https://github.com/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/blob/${commit}/${node.filePath.split('/').map(encodeURIComponent).join('/')}#L${node.startLine}-L${node.endLine}`;
}
