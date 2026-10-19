import { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeApi, KnowledgeApiError } from '@/lib/api/knowledge-api';
import type {
  CodeGraphMode,
  CodeGraphNode,
  CodeGraphRequest,
  CodeGraphResponse,
} from '@/lib/api/code-graph-contract';
import { mergeGraph, VISIBLE_EDGE_LIMIT, VISIBLE_NODE_LIMIT } from './graph-model';

export function graphError(error: unknown): string {
  if (error instanceof KnowledgeApiError) {
    if (error.code === 401 || error.code === 403) return 'forbidden';
    if (error.code === 404) return 'not_found';
  }
  return error instanceof Error && error.message === 'version_expired'
    ? 'version_expired'
    : 'network';
}

export function canReadNodeSource(node: CodeGraphNode | null): boolean {
  return (
    !!node && !node.aggregate && !['module', 'directory', 'external', 'unknown'].includes(node.kind)
  );
}

export const isAggregateMode = (mode: CodeGraphMode) =>
  mode === 'dependencies' || mode === 'clusters';

export function defaultGraphOptions(mode: CodeGraphMode): CodeGraphRequest {
  return {
    mode,
    depth: mode === 'impact' ? 2 : 1,
    direction: mode === 'impact' ? 'in' : 'both',
    edgeKinds:
      mode === 'hierarchy'
        ? ['extends', 'implements']
        : mode === 'impact'
          ? ['calls', 'imports', 'extends', 'implements', 'references']
          : isAggregateMode(mode)
            ? ['imports']
            : ['calls'],
    ...(isAggregateMode(mode)
      ? { groupBy: 'directory' as const, moduleDepth: 1, scopePath: '' }
      : {}),
  };
}

type GraphSnapshot = { data: CodeGraphResponse; request: CodeGraphRequest };
type FocusSnapshot = { node: CodeGraphNode | null; options: CodeGraphRequest };

export function useCodeGraphWorkspace(assetId: string, initialMode: CodeGraphMode = 'calls') {
  const [mode, setMode] = useState(initialMode);
  const [options, setOptions] = useState<CodeGraphRequest>(() => defaultGraphOptions(initialMode));
  const optionsRef = useRef(options);
  const [catalog, setCatalog] = useState<CodeGraphResponse | null>(null);
  const [graph, setGraph] = useState<CodeGraphResponse | null>(null);
  const [source, setSource] = useState<CodeGraphResponse | null>(null);
  const [evidence, setEvidence] = useState<CodeGraphResponse | null>(null);
  const [selected, setSelectedState] = useState<CodeGraphNode | null>(null);
  const [sourceLine, setSourceLine] = useState<number>();
  const realSymbol = useRef<CodeGraphNode | null>(null);
  const setSelected = useCallback((node: CodeGraphNode | null) => {
    nodeController.current?.abort();
    setSourceLine(undefined);
    if (canReadNodeSource(node) && node?.kind !== 'file') realSymbol.current = node;
    setSelectedState(node);
  }, []);
  const [loading, setLoading] = useState(false),
    [searching, setSearching] = useState(false),
    [searchPaused, setSearchPaused] = useState(false),
    [sourceLoading, setSourceLoading] = useState(false),
    [evidenceLoading, setEvidenceLoading] = useState(false);
  const [error, setError] = useState(''),
    [catalogError, setCatalogError] = useState(''),
    [sourceError, setSourceError] = useState(''),
    [evidenceError, setEvidenceError] = useState('');
  const [history, setHistory] = useState<FocusSnapshot[]>([]),
    [expansions, setExpansions] = useState<GraphSnapshot[]>([]);
  const graphController = useRef<AbortController>(),
    catalogController = useRef<AbortController>(),
    sourceController = useRef<AbortController>(),
    evidenceController = useRef<AbortController>(),
    nodeController = useRef<AbortController>();
  const graphSequence = useRef(0),
    catalogSequence = useRef(0),
    evidenceSequence = useRef(0);
  const graphRequest = useRef<CodeGraphRequest>({}),
    catalogRequest = useRef<CodeGraphRequest>({}),
    evidenceRequest = useRef<CodeGraphRequest>({});
  const catalogAction = useRef<'graphTree' | 'graphSearch'>('graphTree');
  const version = graph?.indexVersion ?? catalog?.indexVersion;
  const selectedId = canReadNodeSource(selected) ? selected?.id : undefined;

  const abortAll = useCallback(() => {
    graphSequence.current++;
    catalogSequence.current++;
    evidenceSequence.current++;
    graphController.current?.abort();
    catalogController.current?.abort();
    sourceController.current?.abort();
    evidenceController.current?.abort();
    nodeController.current?.abort();
    setLoading(false);
    setSearching(false);
    setSearchPaused(false);
    setSourceLoading(false);
    setEvidenceLoading(false);
  }, []);
  const expire = useCallback(() => {
    abortAll();
    setGraph(null);
    setCatalog(null);
    setSource(null);
    setEvidence(null);
    setSelectedState(null);
    realSymbol.current = null;
    setHistory([]);
    setExpansions([]);
    setError('version_expired');
  }, [abortAll]);

  const browse = useCallback(
    async (query = '', scopePath = '', more = false, tree = false) => {
      catalogController.current?.abort();
      const controller = new AbortController();
      catalogController.current = controller;
      const sequence = ++catalogSequence.current;
      setSearching(true);
      setCatalogError('');
      const action = more ? catalogAction.current : tree ? 'graphTree' : 'graphSearch';
      const request: CodeGraphRequest = more
        ? { ...catalogRequest.current, cursor: catalog?.nextCursor ?? undefined }
        : { query, scopePath, limit: 100, ...(version ? { indexVersion: version } : {}) };
      catalogAction.current = action;
      const previousCatalog = catalog;
      const effectiveQuery = more ? catalogRequest.current.query : query;
      const autoContinue = action === 'graphSearch' && !!effectiveQuery;
      const deadline = Date.now() + 12_000;
      const maxContinuationPages = 200;
      const visitedCursors = new Set<string>();
      if (request.cursor) visitedCursors.add(request.cursor);
      let continuationPages = 0;
      let pageRequest = request;
      let lastPage: CodeGraphResponse | null = null;
      let lastStopsAutomaticScan = false;
      let accumulated = more ? previousCatalog : null;
      const scanTarget = Math.min((accumulated?.nodes.length ?? 0) + 100, 500);
      let budgetExpired = false;
      const budgetTimer = autoContinue
        ? setTimeout(() => {
            budgetExpired = true;
            controller.abort();
          }, 12_000)
        : undefined;
      let shouldRequest = true;
      setSearchPaused(false);
      if (!more) setCatalog(null);
      try {
        while (shouldRequest) {
          catalogRequest.current = pageRequest;
          const result = await knowledgeApi.code[action](assetId, pageRequest, controller.signal);
          if (sequence !== catalogSequence.current || controller.signal.aborted) return;
          if (
            result.state === 'version_expired' ||
            (version && result.indexVersion && version !== result.indexVersion)
          ) {
            expire();
            return;
          }
          lastPage = result;
          const isPageState = ['ready', 'empty'].includes(result.state);
          accumulated =
            isPageState && accumulated && ['ready', 'empty'].includes(accumulated.state)
              ? mergeGraph(accumulated, result)
              : result;
          setCatalog(accumulated);
          if (!isPageState) break;
          const nextCursor = result.nextCursor;
          const reasonStopsAutomaticScan = result.truncationReasons.some((reason) =>
            ['node_budget', 'result_budget', 'limit_reached', 'global_budget'].includes(reason),
          );
          lastStopsAutomaticScan = reasonStopsAutomaticScan;
          const reachedPageTarget = accumulated.nodes.length >= scanTarget;
          const reachedGlobalLimit = accumulated.nodes.length >= 500;
          const canContinue =
            autoContinue &&
            !reasonStopsAutomaticScan &&
            !reachedPageTarget &&
            !reachedGlobalLimit &&
            !!nextCursor &&
            !visitedCursors.has(nextCursor) &&
            continuationPages < maxContinuationPages - 1 &&
            Date.now() < deadline;
          if (!canContinue) {
            shouldRequest = false;
            break;
          }

          visitedCursors.add(nextCursor);
          continuationPages++;
          pageRequest = { ...request, cursor: nextCursor };
        }
        const result = lastPage;
        if (!result || sequence !== catalogSequence.current || controller.signal.aborted) return;
        if (accumulated) setCatalog(accumulated);
        const stoppedWithCursor = !!result.nextCursor && accumulated!.nodes.length < 500;
        const stoppedBeforeTarget = accumulated!.nodes.length < scanTarget;
        setSearchPaused(
          stoppedWithCursor && autoContinue && stoppedBeforeTarget && !lastStopsAutomaticScan,
        );
      } catch (e) {
        if (budgetExpired && sequence === catalogSequence.current) {
          setCatalog(accumulated);
          setSearchPaused(true);
        } else if (!controller.signal.aborted && sequence === catalogSequence.current) {
          setCatalogError(graphError(e));
        } else if (sequence === catalogSequence.current && lastPage) {
          setCatalog(accumulated ?? lastPage);
        }
      } finally {
        if (budgetTimer) clearTimeout(budgetTimer);
        if (sequence === catalogSequence.current) setSearching(false);
      }
    },
    [assetId, catalog, version, expire],
  );

  const cancelBrowse = useCallback(
    (clearResults = true) => {
      catalogSequence.current++;
      catalogController.current?.abort();
      setSearching(false);
      setSearchPaused(!clearResults && (!!catalog?.nextCursor || !!catalogRequest.current.query));
      if (clearResults) {
        setCatalog(null);
        setCatalogError('');
      }
    },
    [catalog],
  );

  useEffect(() => {
    void browse('', '', false, true);
    return () => {
      graphController.current?.abort();
      catalogController.current?.abort();
      sourceController.current?.abort();
      evidenceController.current?.abort();
      nodeController.current?.abort();
    };
    // Initial tree is loaded once; later version changes are explicit reset/expiry transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const runGraph = useCallback(
    async (
      node: CodeGraphNode | null,
      queryOptions: CodeGraphRequest,
      append = false,
      more = false,
      remember = true,
    ) => {
      if (!version) return;
      graphController.current?.abort();
      const controller = new AbortController();
      graphController.current = controller;
      const sequence = ++graphSequence.current;
      setLoading(true);
      setError('');
      if (!append) {
        nodeController.current?.abort();
        const previousFocus = graph?.nodes.find((item) => item.id === graph.focusId) ?? selected;
        if (remember && graph && previousFocus?.id !== node?.id)
          setHistory((old) => [
            ...old.slice(-19),
            { node: previousFocus, options: optionsRef.current },
          ]);
        setSelected(node);
        if (queryOptions.mode !== 'clusters') setGraph(null);
        setExpansions([]);
        setEvidence(null);
        setEvidenceError('');
        evidenceSequence.current++;
        evidenceController.current?.abort();
        setEvidenceLoading(false);
      }
      const request: CodeGraphRequest = more
        ? { ...graphRequest.current, cursor: graph?.nextCursor ?? undefined }
        : {
            ...queryOptions,
            ...(node &&
            !node.aggregate &&
            (queryOptions.mode === 'clusters' || !isAggregateMode(queryOptions.mode ?? mode))
              ? { nodeId: node.id }
              : {}),
            indexVersion: version,
            limit: 100,
            edgeLimit: 300,
          };
      const previousRequest = graphRequest.current;
      graphRequest.current = request;
      try {
        const result = await knowledgeApi.code.graph(assetId, request, controller.signal);
        if (sequence !== graphSequence.current || controller.signal.aborted) return;
        if (
          result.state === 'version_expired' ||
          (result.indexVersion && version !== result.indexVersion)
        ) {
          expire();
          return;
        }
        if (append && graph && ['ready', 'empty'].includes(result.state)) {
          const next = result.aggregation?.merge === 'replace' ? result : mergeGraph(graph, result);
          setExpansions((old) => [...old, { data: graph, request: previousRequest }]);
          setGraph(next);
          if (selected?.aggregate)
            setSelectedState(next.nodes.find((item) => item.id === selected.id) ?? selected);
        } else setGraph(result);
      } catch (e) {
        if (!controller.signal.aborted && sequence === graphSequence.current)
          setError(graphError(e));
      } finally {
        if (sequence === graphSequence.current) setLoading(false);
      }
    },
    [assetId, graph, selected, version, expire, setSelected, mode],
  );

  const load = useCallback(
    (
      node: CodeGraphNode,
      direction: 'in' | 'out' | 'both' = 'both',
      append = false,
      more = false,
      remember = true,
    ) => {
      const next = {
        ...optionsRef.current,
        direction: optionsRef.current.mode === 'impact' ? ('in' as const) : direction,
      };
      return runGraph(node, next, append, more, remember);
    },
    [runGraph],
  );

  useEffect(() => {
    if (isAggregateMode(mode) && catalog?.indexVersion && !graph && !loading && !error) {
      void runGraph(null, optionsRef.current, false, false, false);
    }
  }, [mode, catalog?.indexVersion, graph, loading, error, runGraph]);

  function changeMode(nextMode: CodeGraphMode) {
    if (nextMode === mode) return;
    const node =
      canReadNodeSource(selected) && selected?.kind !== 'file' ? selected : realSymbol.current;
    abortAll();
    setSource(null);
    setEvidence(null);
    setEvidenceError('');
    setCatalogError('');
    setSourceError('');
    setHistory([]);
    setExpansions([]);
    setGraph(null);
    setError('');
    const next = defaultGraphOptions(nextMode);
    optionsRef.current = next;
    setOptions(next);
    setMode(nextMode);
    setSourceLine(undefined);
    setSelectedState(isAggregateMode(nextMode) ? null : node);
    if (!version) {
      void browse('', '', false, true);
      return;
    }
    if (isAggregateMode(nextMode) || node)
      void runGraph(isAggregateMode(nextMode) ? null : node, next, false, false, false);
  }

  function configure(
    patch: Partial<CodeGraphRequest>,
    remember = false,
    locatedNode?: CodeGraphNode,
  ) {
    const previous = optionsRef.current;
    const next = { ...previous, ...patch };
    delete next.cursor;
    delete next.evidenceFor;
    if (
      mode === 'clusters' &&
      !error &&
      (loading || graph) &&
      JSON.stringify(next) === JSON.stringify(previous) &&
      (!locatedNode || selected?.id === locatedNode.id)
    )
      return;
    const focus =
      graph?.nodes.find((node) => node.id === graph.focusId) ?? selected ?? realSymbol.current;
    // Capture the prior scope before updating options, so Back restores aggregation accurately.
    if (remember && graph)
      setHistory((old) => [...old.slice(-19), { node: focus, options: previous }]);
    optionsRef.current = next;
    setOptions(next);
    if (isAggregateMode(mode) || focus)
      void runGraph(
        isAggregateMode(mode) ? (locatedNode ?? null) : focus,
        next,
        false,
        false,
        false,
      );
  }

  useEffect(() => {
    setSource(null);
    setSourceError('');
    if (!selectedId || !version) {
      setSourceLoading(false);
      return;
    }
    const controller = new AbortController();
    sourceController.current = controller;
    setSourceLoading(true);
    knowledgeApi.code
      .graphSource(
        assetId,
        { nodeId: selectedId, indexVersion: version, ...(sourceLine ? { sourceLine } : {}) },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.state === 'version_expired' ||
          (result.indexVersion && version !== result.indexVersion)
        ) {
          expire();
          return;
        }
        setSource(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setSourceError(graphError(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [assetId, selectedId, version, mode, sourceLine, expire]);

  async function loadEvidence(edgeId: string, more = false) {
    if (!version) return;
    evidenceController.current?.abort();
    const controller = new AbortController();
    evidenceController.current = controller;
    const sequence = ++evidenceSequence.current;
    setEvidenceLoading(true);
    setEvidenceError('');
    const request = more
      ? { ...evidenceRequest.current, cursor: evidence?.nextCursor ?? undefined }
      : { ...optionsRef.current, evidenceFor: edgeId, indexVersion: version, limit: 100 };
    evidenceRequest.current = request;
    if (!more) setEvidence(null);
    try {
      const result = await knowledgeApi.code.graph(assetId, request, controller.signal);
      if (controller.signal.aborted || sequence !== evidenceSequence.current) return;
      if (
        result.state === 'version_expired' ||
        (result.indexVersion && result.indexVersion !== version)
      ) {
        expire();
        return;
      }
      if (more && evidence) {
        const rows = new Map(evidence.dependencyEvidence?.map((item) => [item.id, item]));
        result.dependencyEvidence?.forEach((item) => {
          if (rows.size < 500 || rows.has(item.id)) rows.set(item.id, item);
        });
        setEvidence({ ...result, dependencyEvidence: [...rows.values()] });
      } else setEvidence(result);
    } catch (e) {
      if (!controller.signal.aborted && sequence === evidenceSequence.current)
        setEvidenceError(graphError(e));
    } finally {
      if (sequence === evidenceSequence.current) setEvidenceLoading(false);
    }
  }

  async function inspectNode(nodeId: string, line?: number) {
    if (!version) return;
    nodeController.current?.abort();
    const controller = new AbortController();
    nodeController.current = controller;
    setSourceError('');
    try {
      const result = await knowledgeApi.code.graphNode(
        assetId,
        { nodeId, indexVersion: version },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        result.state === 'version_expired' ||
        (result.indexVersion && result.indexVersion !== version)
      ) {
        expire();
        return;
      }
      const node = result.nodes.find((item) => item.id === nodeId);
      if (node && canReadNodeSource(node)) {
        setSelected(node);
        setSourceLine(line);
      } else setSourceError(result.state === 'ready' ? 'source_unavailable' : result.state);
    } catch (e) {
      if (!controller.signal.aborted) setSourceError(graphError(e));
    }
  }

  function reset() {
    abortAll();
    setGraph(null);
    setCatalog(null);
    setCatalogError('');
    setSourceError('');
    setEvidenceError('');
    setEvidence(null);
    setSource(null);
    setSelectedState(null);
    realSymbol.current = null;
    setHistory([]);
    setExpansions([]);
    setError('');
    const controller = new AbortController();
    catalogController.current = controller;
    const sequence = ++catalogSequence.current;
    setSearching(true);
    catalogAction.current = 'graphTree';
    catalogRequest.current = { limit: 100 };
    knowledgeApi.code
      .graphTree(assetId, { limit: 100 }, controller.signal)
      .then((result) => {
        if (sequence === catalogSequence.current && !controller.signal.aborted) setCatalog(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(graphError(e));
      })
      .finally(() => {
        if (sequence === catalogSequence.current) setSearching(false);
      });
  }
  function back() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((old) => old.slice(0, -1));
    optionsRef.current = previous.options;
    setOptions(previous.options);
    void runGraph(
      mode === 'dependencies' ? null : previous.node,
      previous.options,
      false,
      false,
      false,
    );
  }
  function collapse() {
    graphSequence.current++;
    graphController.current?.abort();
    setLoading(false);
    const previous = expansions.at(-1);
    if (!previous) return;
    setGraph(previous.data);
    graphRequest.current = previous.request;
    if (selected && !previous.data.nodes.some((node) => node.id === selected.id))
      setSelected(previous.data.nodes.find((node) => node.id === previous.data.focusId) ?? null);
    setExpansions((old) => old.slice(0, -1));
  }
  return {
    mode,
    options,
    changeMode,
    configure,
    catalog,
    graph,
    source,
    evidence,
    evidenceLoading,
    evidenceError,
    loadEvidence,
    inspectNode,
    selected,
    setSelected,
    loading,
    searching,
    searchPaused,
    sourceLoading,
    sourceLine,
    error,
    catalogError,
    sourceError,
    browse,
    cancelBrowse,
    load,
    reset,
    back,
    collapse,
    more: () => runGraph(null, optionsRef.current, true, true, false),
    canBack: history.length > 0,
    canCollapse: expansions.length > 0,
    atBudget:
      !!graph &&
      (graph.nodes.length >= VISIBLE_NODE_LIMIT || graph.edges.length >= VISIBLE_EDGE_LIMIT),
  };
}
