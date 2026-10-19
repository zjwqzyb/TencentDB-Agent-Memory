import { describe, expect, it } from 'vitest';
import { coverageNoticeKeys, graphRecoveryNotice, findRelationPath, mergeGraph, sourceLink, stablePositions } from '../web/src/pages/CodePage/graph/graph-model';
import type { CodeGraphNode, CodeGraphResponse } from '../../contracts/code-graph';

const node = (id: string): CodeGraphNode => ({ id, name: id, qualifiedName: id, kind: 'function', filePath: 'src/a.ts', language: 'typescript', startLine: 1, endLine: 2 });
const response = (nodes: CodeGraphNode[], edges: CodeGraphResponse['edges'] = []): CodeGraphResponse => ({ state: 'ready', assetId: 'a', indexVersion: 'v1', commit: 'abc1234', indexedAt: null, branch: 'main', capabilities: { sdkVersion: '1.6.2', modes: { calls: { supported: true }, impact: { supported: false }, dependencies: { supported: false }, clusters: { supported: false }, hierarchy: { supported: false } }, languages: ['typescript'], edgeKinds: ['calls'] }, nodes, edges, focusId: nodes[0]?.id ?? null, truncated: false, truncationReasons: [], nextCursor: null, warnings: [] });
const edge = (id: string, source: string, target: string) => ({ id, source, target, kind: 'calls', evidence: [] });

describe('CodeGraph browser model', () => {
  it('retains recursive, reverse and parallel edge identities and idempotently merges pages', () => {
    const graph = response([node('a'), node('b')], [edge('self', 'a', 'a'), edge('ab1', 'a', 'b'), edge('ab2', 'a', 'b'), edge('ba', 'b', 'a')]);
    const merged = mergeGraph(graph, graph);
    expect(merged.edges.map((item) => item.id)).toEqual(['self', 'ab1', 'ab2', 'ba']);
    expect(merged.nodes).toHaveLength(2);
  });
  it('rejects mixed assets and snapshots', () => {
    const graph = response([node('a')]);
    expect(() => mergeGraph(graph, { ...graph, assetId: 'other' })).toThrow('version_expired');
    expect(() => mergeGraph(graph, { ...graph, indexVersion: 'v2' })).toThrow('version_expired');
  });
  it('preserves accumulated graph on an empty continuation and enforces visible budgets', () => {
    const graph = response(Array.from({ length: 500 }, (_, index) => node(String(index))));
    expect(mergeGraph(graph, { ...response([]), state: 'empty' }).state).toBe('ready');
    const merged = mergeGraph(graph, response([node('501')], [edge('dangling', '0', '501')]));
    expect(merged.nodes).toHaveLength(500); expect(merged.edges).toHaveLength(0);
    expect(merged.truncationReasons).toContain('visible_budget');
    const many = response([node('0')], Array.from({ length: 1600 }, (_, index) => edge(String(index), '0', '0')));
    expect(mergeGraph(response([node('0')]), many).edges).toHaveLength(1500);
  });
  it('merges reverse impact evidence across pages with shortest distances and no reversed paths', () => {
    const first = { ...response([{ ...node('a'), depth: 0 }, { ...node('b'), depth: 1 }], [edge('ba', 'b', 'a')]), impactPaths: [{ nodeId: 'b', nodeIds: ['b', 'a'], edgeIds: ['ba'] }] };
    const unresolved = { sourceId: 'b', name: 'dynamic', kind: 'calls', filePath: 'src/b.ts', line: 4 };
    const second = { ...response([{ ...node('b'), depth: 3 }, { ...node('c'), depth: 2 }], [edge('cb', 'c', 'b')]), impactPaths: [{ nodeId: 'c', nodeIds: ['c', 'b', 'a'], edgeIds: ['cb', 'ba'] }], unresolved: [unresolved, unresolved] };
    const merged = mergeGraph(first, second);
    expect(merged.nodes.find(n => n.id === 'b')?.depth).toBe(1);
    expect(merged.impactPaths).toHaveLength(2);
    expect(merged.impactPaths?.find(p => p.nodeId === 'c')?.edgeIds).toEqual(['cb', 'ba']);
    expect(merged.unresolved).toHaveLength(1);
    const malformed = mergeGraph(first, { ...second, impactPaths: [{ nodeId: 'c', nodeIds: ['c', 'a'], edgeIds: ['ba'] }, { nodeId: 'b', nodeIds: ['b'], edgeIds: [] }] });
    expect(malformed.impactPaths?.some(p => p.nodeId === 'c')).toBe(false);
    const budget = response(Array.from({length: 500}, (_, i) => node(String(i))));
    const clipped = mergeGraph(budget, { ...response([node('extra')], [edge('extra0', 'extra', '0')]), impactPaths: [{ nodeId: 'extra', nodeIds: ['extra', '0'], edgeIds: ['extra0'] }] });
    expect(clipped.impactPaths).toEqual([]);
  });
  it('explains incomplete counts, unknown coverage and terminal budgets without raw codes', () => {
    const graph = { ...response([]), truncated: true, warnings: ['import_declaration_source_unavailable', 'unresolved_reference_index_unavailable'], truncationReasons: ['aggregation_site_budget'] };
    expect(coverageNoticeKeys(graph)).toEqual(['code.graph.importUnverified', 'code.graph.unknownCoverage', 'code.graph.hardLimit']);
    expect(coverageNoticeKeys({ ...graph, warnings: [], nextCursor: 'next', truncationReasons: ['source_scan_budget'] })).toEqual(['code.graph.continueScan']);
    expect(coverageNoticeKeys({ ...graph, warnings: [], truncationReasons: [] })).toEqual(['code.graph.incompleteNoCursor']);
    expect(coverageNoticeKeys({ ...graph, warnings: ['unresolved_diagnostic_budget'], truncationReasons: ['unverified_import_sites'] })).toEqual(['code.graph.diagnosticBudget']);
  });
  it('maps unsupported reasons to honest recovery actions, using the current response only', () => {
    const graph = { ...response([]), state: 'unsupported' as const };
    const cases = [
      ['unverified_sdk_version', 'unverifiedSdk', 'textQuery'],
      ['unsupported_index_schema', 'unsupportedSchema', 'textQuery'],
      ['unsupported_grouping', 'unsupportedGrouping', 'directory'],
      ['select_one_dependency_kind_imports_or_calls', 'selectDependencyKind', 'imports'],
      ['symbol_scope_required', 'selectSymbolScope', 'chooseSymbol'],
      ['future_reason', 'unsupportedView', 'textQuery'],
    ];
    for (const [warning, key, action] of cases)
      expect(graphRecoveryNotice({ ...graph, warnings: [warning] }, 'calls'))
        .toMatchObject({ key: `code.graph.${key}`, action });
    expect(graphRecoveryNotice({ ...graph, warnings: ['unverified_language:java'] }, 'calls'))
      .toEqual({ key: 'code.graph.unverifiedLanguage', values: { language: 'Java' }, action: 'textQuery' });
    expect(graphRecoveryNotice({ ...graph, capabilities: { ...graph.capabilities, modes: { ...graph.capabilities.modes, calls: { supported: false, reason: 'unsupported_index_schema' } } } }, 'calls')?.key)
      .toBe('code.graph.unsupportedSchema');
    expect(graphRecoveryNotice({ ...graph, warnings: ['typescript_interface_extends_not_extracted'] }, 'hierarchy')?.key)
      .toBe('code.graph.interfaceExtendsLimit');
    expect(graphRecoveryNotice({ ...graph, warnings: ['unsupported_index_schema', 'unverified_language:java', 'select_a_callable'] }, 'calls')?.key)
      .toBe('code.graph.unsupportedSchema');
  });
  it('distinguishes non-applicable focus, empty relations, and partial language coverage', () => {
    const graph = { ...response([node('a')]), state: 'empty' as const };
    expect(graphRecoveryNotice({ ...graph, warnings: ['select_a_callable'] }, 'calls')?.key).toBe('code.graph.selectCallable');
    expect(graphRecoveryNotice({ ...graph, warnings: ['select_a_type'] }, 'hierarchy')?.key).toBe('code.graph.selectType');
    expect(graphRecoveryNotice(graph, 'calls')).toBeNull();
    expect(coverageNoticeKeys({ ...graph, state: 'unsupported', truncated: true, warnings: ['unverified_language:java'] })).toEqual([]);
    expect(graphRecoveryNotice({ ...graph, state: 'ready', warnings: ['unverified_language:java', 'typescript_interface_extends_not_extracted'] }, 'hierarchy')).toBeNull();
    const java = { ...graph, state: 'ready' as const, warnings: ['java_heuristic_relations_omitted', 'java_wildcard_relations_omitted', 'java_ambiguous_relations_omitted', 'java_relation_source_unverified', 'java_relation_source_budget', 'java_static_analysis_incomplete'] };
    expect(graphRecoveryNotice(java, 'calls')).toBeNull();
    expect(coverageNoticeKeys({ ...java, truncated: true, nextCursor: 'next' })).toContain('code.graph.javaSourceBudgetContinue');
    expect(coverageNoticeKeys(java)).toEqual(['code.graph.javaHeuristicLimit', 'code.graph.javaWildcardLimit', 'code.graph.javaAmbiguousLimit', 'code.graph.javaSourceUnverified', 'code.graph.javaStaticLimit', 'code.graph.javaSourceBudget']);
  });
  it('lays out a 500 node chain and a 500 node SCC without recursion loops', () => {
    const nodes = Array.from({ length: 500 }, (_, index) => node(String(index)));
    const edges = nodes.slice(1).map((item, index) => edge(`e${index}`, String(index), item.id));
    const chain = stablePositions({ nodes, edges });
    expect(chain.size).toBe(500); expect(chain.get('499')!.x).toBeGreaterThan(chain.get('0')!.x);
    const loop = stablePositions({ nodes, edges: [...edges, edge('cycle', '499', '0')] });
    expect(loop.size).toBe(500); expect(new Set([...loop.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(500);
  });
  it('preserves existing coordinates on expansion and avoids collisions', () => {
    const initial = response([node('b'), node('c')], [edge('bc', 'b', 'c')]);
    const before = stablePositions(initial);
    const expanded = stablePositions(response([node('a'), ...initial.nodes, node('d')], [edge('ab', 'a', 'b'), ...initial.edges, edge('cd', 'c', 'd')]), before);
    expect(expanded.get('b')).toEqual(before.get('b')); expect(expanded.get('c')).toEqual(before.get('c'));
    expect(new Set([...expanded.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(4);
  });
  it('finds an actual directed path through cycles and keeps disconnected nodes separate', () => {
    const edges = [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('bc', 'b', 'c'), edge('self', 'c', 'c')];
    expect(findRelationPath(edges, 'a', 'c')).toEqual(['ab', 'bc']);
    expect(findRelationPath(edges, 'c', 'a')).toEqual([]);
    expect(findRelationPath(edges, 'a', 'missing')).toEqual([]);
  });
  it('only creates immutable supported source links and rejects invalid commit/path', () => {
    expect(sourceLink('git@github.com:owner/repo.git', 'abc1234', node('a'))).toBe('https://github.com/owner/repo/blob/abc1234/src/a.ts#L1-L2');
    expect(sourceLink('https://gitlab.example.com/o/r', 'abc1234', node('a'))).toBeNull();
    expect(sourceLink('https://github.com/o/r', 'main', node('a'))).toBeNull();
    expect(sourceLink('https://github.com/o/r', 'abc1234', { ...node('a'), filePath: '../secret' })).toBeNull();
  });
});
