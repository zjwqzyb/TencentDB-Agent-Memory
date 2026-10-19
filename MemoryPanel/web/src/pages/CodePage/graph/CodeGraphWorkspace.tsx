import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Copy, Drawer, StatusTip } from 'tea-component';
import type { CodeGraphDetail } from '@/lib/api/knowledge-api';
import type { CodeGraphMode, CodeGraphNode } from '@/lib/api/code-graph-contract';
import { canReadNodeSource, isAggregateMode, useCodeGraphWorkspace } from './useCodeGraphWorkspace';
import { CodeGraphModeControls } from './CodeGraphModeControls';
import { CodeGraphAnalysis } from './CodeGraphAnalysis';
import { CodeGraphCanvas } from './CodeGraphCanvas';
import {
  coverageNoticeKeys,
  findRelationPath,
  graphLanguageLabel,
  graphRecoveryNotice,
  nodeLocation,
  sourceLink,
} from './graph-model';
import './code-graph.css';

export function CodeGraphWorkspace({
  asset,
  mode: initialMode = 'calls',
  onTextQuery,
}: {
  asset: CodeGraphDetail;
  mode?: CodeGraphMode;
  onTextQuery?: () => void;
}) {
  const { t } = useTranslation();
  const state = useCodeGraphWorkspace(asset.code_graph_id, initialMode);
  const mode = state.mode;
  const [query, setQuery] = useState(''),
    [scope, setScope] = useState(''),
    [kind, setKind] = useState('');
  const [listView, setListView] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  const [drawer, setDrawer] = useState<'search' | 'source' | null>(null),
    [narrow, setNarrow] = useState(false);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [showPath, setShowPath] = useState(false);
  const [pathOnly, setPathOnly] = useState(false);
  const [distance, setDistance] = useState('all');
  const [cycleId, setCycleId] = useState<string | null>(null);
  const [drawerElement, setDrawerElement] = useState<HTMLDivElement | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  function openDrawer(panel: 'search' | 'source') {
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer(panel);
  }
  // Tea's non-modal drawer has no dialog semantics or Escape handling itself.
  // Preserve background interaction, while naming it and returning keyboard focus.
  useEffect(() => {
    if (!drawerElement || !drawer || !narrow) return;
    drawerElement.setAttribute('role', 'dialog');
    drawerElement.setAttribute('aria-modal', 'false');
    drawerElement.setAttribute(
      'aria-label',
      t(drawer === 'search' ? 'code.graph.search' : 'code.graph.details'),
    );
    const frame = requestAnimationFrame(() => {
      if (drawer === 'search') searchInput.current?.focus();
      else
        drawerElement.querySelector<HTMLElement>('input, button, a[href], [tabindex="0"]')?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDrawer(null);
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown, true);
      if (drawerTrigger.current?.isConnected) drawerTrigger.current.focus({ preventScroll: true });
    };
  }, [drawerElement, drawer, narrow, t]);
  useEffect(() => {
    setEdgeId(null);
    setShowPath(false);
    setPathOnly(false);
    setCycleId(null);
  }, [state.options]);
  const meta = state.graph ?? state.catalog;
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const lookup = new Map(state.graph?.nodes.map((node) => [node.id, node]) ?? []);
  const path = useMemo(() => {
    if (!state.graph?.focusId || !state.selected) return [];
    if (mode === 'impact')
      return (
        state.graph.impactPaths?.find((item) => item.nodeId === state.selected?.id)?.edgeIds ?? []
      );
    const forward = findRelationPath(state.graph.edges, state.graph.focusId, state.selected.id);
    return forward.length
      ? forward
      : findRelationPath(state.graph.edges, state.selected.id, state.graph.focusId);
  }, [mode, state.graph, state.selected]);
  const pathNodes = useMemo(
    () =>
      new Set(
        state.graph?.edges
          .filter((edge) => path.includes(edge.id))
          .flatMap((edge) => [edge.source, edge.target]) ?? [],
      ),
    [state.graph, path],
  );
  const nodes = useMemo(
    () =>
      state.graph?.nodes.filter(
        (node) =>
          (!kind || node.kind === kind) &&
          (!pathOnly || pathNodes.has(node.id)) &&
          (mode !== 'impact' ||
            node.depth === 0 ||
            distance === 'all' ||
            (distance === 'direct' ? node.depth === 1 : (node.depth ?? 0) > 1)),
      ) ?? [],
    [state.graph, kind, pathOnly, pathNodes, mode, distance],
  );
  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const edges = useMemo(
    () =>
      state.graph?.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) ??
      [],
    [state.graph, nodeIds],
  );
  const data = useMemo(() => ({ nodes, edges }), [nodes, edges]);
  const kinds = [...new Set(state.graph?.nodes.map((node) => node.kind) ?? [])].sort();
  const selectedEdge = state.graph?.edges.find((edge) => edge.id === edgeId);
  const cycle = state.graph?.cycles?.find((item) => item.id === cycleId);
  const highlightedEdges = useMemo(
    () =>
      cycle
        ? new Set(cycle.edgeIds)
        : showPath
          ? new Set(path)
          : edgeId
            ? new Set([edgeId])
            : undefined,
    [cycle, showPath, path, edgeId],
  );
  function clearHighlights() {
    setEdgeId(null);
    setShowPath(false);
    setPathOnly(false);
    setCycleId(null);
  }
  function selectEdge(id: string) {
    setEdgeId(id);
    setShowPath(false);
    setPathOnly(false);
    setCycleId(null);
    if (isAggregateMode(mode)) void state.loadEvidence(id);
    if (narrow) openDrawer('source');
  }
  const select = (node: CodeGraphNode) => {
    state.setSelected(node);
    clearHighlights();
    if (narrow) openDrawer('source');
  };
  const focus = (node: CodeGraphNode) => {
    setKind('');
    clearHighlights();
    if (mode === 'clusters')
      state.configure({ groupBy: 'symbol', scopePath: node.filePath }, true, node);
    else if (mode === 'dependencies') state.setSelected(node);
    else void state.load(node);
    setDrawer(null);
  };
  const message = (status: string) => t(`code.graph.state.${status}`, { defaultValue: status });
  const sourceNode =
    state.selected && state.sourceLine
      ? { ...state.selected, startLine: state.sourceLine, endLine: state.sourceLine }
      : state.selected;
  const sourceUrl =
    canReadNodeSource(state.selected) && state.selected
      ? sourceLink(asset.repo_url, meta?.commit ?? null, sourceNode!)
      : null;
  const statusResponse = state.graph ?? state.catalog;
  const recovery =
    !state.error && !(!state.graph && state.catalogError)
      ? graphRecoveryNotice(statusResponse, mode)
      : null;
  const status =
    state.error ||
    (!state.graph ? state.catalogError : '') ||
    (state.graph && !['ready', 'empty'].includes(state.graph.state)
      ? state.graph.state
      : !state.graph && state.catalog && !['ready', 'empty'].includes(state.catalog.state)
        ? state.catalog.state
        : '');
  const canReload = ['network', 'version_expired', 'building'].includes(status);
  const chooseSymbol = () => {
    if (narrow) openDrawer('search');
    else searchInput.current?.focus();
  };

  const searchPanel = (
    <section className="_codegraph-search" aria-label={t('code.graph.search')}>
      <h3>{t('code.graph.search')}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void state.browse(query, scope);
        }}
      >
        <label htmlFor="code-graph-query">{t('code.graph.symbol')}</label>
        <input
          id="code-graph-query"
          ref={searchInput}
          data-testid="code-graph-search"
          value={query}
          onChange={(event) => {
            state.cancelBrowse(true);
            setQuery(event.target.value);
          }}
          placeholder={t('code.graph.searchHint')}
        />
        <label htmlFor="code-graph-scope">{t('code.graph.scope')}</label>
        <input
          id="code-graph-scope"
          value={scope}
          onChange={(event) => {
            state.cancelBrowse(true);
            setScope(event.target.value);
          }}
          placeholder={t('code.graph.scopeHint')}
          aria-describedby="code-graph-scope-hint"
        />
        <small id="code-graph-scope-hint">{t('code.graph.scopeHint')}</small>
        <div className="_codegraph-actions">
          <button type="submit" disabled={state.searching}>
            {t('code.graph.searchButton')}
          </button>
          <button
            type="button"
            disabled={state.searching}
            onClick={() => void state.browse('', scope, false, true)}
          >
            {t('code.graph.files')}
          </button>
        </div>
      </form>
      {state.searching && (
        <div className="_codegraph-search-status" role="status" aria-live="polite">
          <StatusTip status="loading" />
          <span>{t('code.graph.searchProgress', { count: state.catalog?.nodes.length ?? 0 })}</span>
          <Button onClick={() => state.cancelBrowse(false)}>{t('code.graph.cancelSearch')}</Button>
        </div>
      )}
      {!state.searching && state.searchPaused && (
        <p className="_codegraph-note" role="status">
          {t(state.catalog?.nextCursor ? 'code.graph.searchPaused' : 'code.graph.searchTimedOut')}
        </p>
      )}
      {state.catalogError && <Alert type="error">{message(state.catalogError)}</Alert>}
      {state.catalog?.state === 'empty' && !state.searchPaused && (
        <p>
          {state.catalog.truncated || state.catalog.nextCursor
            ? t('code.graph.partialSearch')
            : t('code.graph.noResults')}
        </p>
      )}
      <ul className="_codegraph-results">
        {state.catalog?.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => {
                if (node.kind === 'file') {
                  setScope(node.filePath);
                  setQuery('');
                  void state.browse('', node.filePath);
                } else focus(node);
              }}
            >
              <strong>{node.name}</strong>
              <span>{node.kind}</span>
              <small>{nodeLocation(node)}</small>
            </button>
          </li>
        ))}
      </ul>
      {!!state.catalog?.nodes.length && state.catalog.truncated && !state.searchPaused && (
        <p className="_codegraph-note">{t('code.graph.partialSearch')}</p>
      )}
      {state.catalog?.nextCursor && (
        <Button
          disabled={state.searching || state.catalog.nodes.length >= 500}
          onClick={() => void state.browse('', '', true)}
        >
          {t(
            state.searchPaused || state.catalog.truncationReasons.includes('scan_budget')
              ? 'code.graph.moreResults'
              : 'code.graph.loadMoreResults',
          )}
        </Button>
      )}
    </section>
  );

  function drill(node: CodeGraphNode) {
    if (!node.aggregate || node.aggregate.level === 'external' || node.aggregate.collapsed) return;
    if (node.aggregate.level === 'directory') {
      state.configure({ groupBy: 'file', scopePath: node.aggregate.path }, true);
      clearHighlights();
    } else if (mode === 'clusters') {
      state.configure({ groupBy: 'symbol', scopePath: node.aggregate.path }, true);
      clearHighlights();
    } else {
      setScope(node.aggregate.path);
      setQuery('');
      void state.browse('', node.aggregate.path);
      if (narrow) openDrawer('search');
    }
  }
  const sourcePanel = (
    <section
      className="_codegraph-source"
      data-testid="code-graph-source"
      aria-label={t('code.graph.details')}
    >
      <h3>{t('code.graph.details')}</h3>
      {!state.selected ? (
        <p>{t('code.graph.selectHint')}</p>
      ) : state.selected.aggregate ? (
        <div data-testid="code-graph-aggregate-details">
          <h4>{state.selected.name}</h4>
          <p className="_codegraph-location">{state.selected.aggregate.path}</p>
          <p>{t(`code.graph.resolution.${state.selected.aggregate.resolution ?? 'internal'}`)}</p>
          <p>
            {t('code.graph.aggregateCounts', {
              files: state.selected.aggregate.fileCount,
              symbols: state.selected.aggregate.symbolCount,
              internal: state.selected.aggregate.internalCount ?? 0,
            })}
          </p>
          <p>
            {t(
              state.selected.aggregate.complete
                ? 'code.graph.aggregateComplete'
                : 'code.graph.aggregatePartial',
            )}
          </p>
          {state.selected.aggregate.boundary && <p>{t('code.graph.boundaryGroup')}</p>}
          {state.selected.aggregate.collapsed && <p>{t('code.graph.collapsedBudget')}</p>}
          <p>{t('code.graph.aggregateNoSource')}</p>
          {state.selected.aggregate.level !== 'external' && !state.selected.aggregate.collapsed && (
            <Button disabled={state.loading} onClick={() => drill(state.selected!)}>
              {t(
                state.selected.aggregate.level === 'directory'
                  ? 'code.graph.drillFiles'
                  : 'code.graph.drillSymbols',
              )}
            </Button>
          )}
        </div>
      ) : (
        <>
          <h4>{state.selected.qualifiedName || state.selected.name}</h4>
          <p>
            {state.selected.kind} · {state.selected.language}
          </p>
          {state.selected.signature && (
            <pre className="_codegraph-code">{state.selected.signature}</pre>
          )}
          <p className="_codegraph-location">
            {nodeLocation(sourceNode!)}
            {!state.sourceLine && `–${state.selected.endLine}`}
          </p>
          <div className="_codegraph-actions">
            <Copy text={nodeLocation(sourceNode!)}>
              <Button>{t('code.graph.copy')}</Button>
            </Copy>
            {!isAggregateMode(mode) && (
              <Button disabled={state.loading} onClick={() => focus(state.selected!)}>
                {t('code.graph.focus')}
              </Button>
            )}
            {state.graph?.focusId !== state.selected.id && (
              <Button disabled={!path.length} onClick={() => setShowPath(!showPath)}>
                {t(showPath ? 'code.graph.clearPath' : 'code.graph.highlightPath')}
              </Button>
            )}
            {sourceUrl && (
              <a href={sourceUrl} target="_blank" rel="noreferrer">
                {t('code.graph.openSource')}
              </a>
            )}
          </div>
          <p className="_codegraph-note">
            {t('code.graph.version')}: {meta?.indexVersion}
          </p>
          {state.sourceLoading && <StatusTip status="loading" />}
          {state.sourceError && <Alert type="error">{message(state.sourceError)}</Alert>}
          {state.source && !state.source.source && (
            <p role="status">{message(state.source.state)}</p>
          )}
          {state.source?.source && (
            <>
              {state.source.truncated && <p>{t('code.graph.sourceTruncated')}</p>}
              <pre className="_codegraph-code" tabIndex={0} aria-label={t('code.graph.source')}>
                <code>
                  {state.source.source.content.split('\n').map((line, index) => (
                    <span key={index}>
                      <span className="_codegraph-line" aria-hidden="true">
                        {state.source!.source!.startLine + index}
                      </span>
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </code>
              </pre>
            </>
          )}
        </>
      )}
      {showPath && path.length > 0 && (
        <div className="_codegraph-evidence" data-testid="code-graph-path">
          <h4>{t('code.graph.evidencePath')}</h4>
          <label>
            <input
              type="checkbox"
              checked={pathOnly}
              onChange={(event) => setPathOnly(event.target.checked)}
            />
            {t('code.graph.onlyPath')}
          </label>
          <ol>
            {path.map((id) => {
              const edge = state.graph?.edges.find((item) => item.id === id);
              return (
                edge && (
                  <li key={id}>
                    {lookup.get(edge.source)?.name} → {lookup.get(edge.target)?.name} ({edge.kind})
                    <ul>
                      {edge.evidence.map((item, index) => (
                        <li key={index}>
                          {item.filePath}:{item.line}
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              );
            })}
          </ol>
        </div>
      )}
      {cycle && (
        <div className="_codegraph-evidence">
          <h4>{t('code.graph.cycleEvidence')}</h4>
          <ul>
            {cycle.edgeIds.map((id) => {
              const edge = state.graph?.edges.find((item) => item.id === id);
              return (
                edge && (
                  <li key={id}>
                    <Button onClick={() => selectEdge(id)}>
                      {lookup.get(edge.source)?.name} → {lookup.get(edge.target)?.name} ({edge.kind}{' '}
                      ×{edge.count ?? 0})
                    </Button>
                  </li>
                )
              );
            })}
          </ul>
        </div>
      )}
      {selectedEdge && (
        <div className="_codegraph-evidence">
          <h4>{t('code.graph.evidence')}</h4>
          <p>
            {lookup.get(selectedEdge.source)?.name} → {lookup.get(selectedEdge.target)?.name} (
            {selectedEdge.kind})
          </p>
          <ul>
            {selectedEdge.evidence.map((item, index) => (
              <li key={index}>
                {item.filePath}:{item.line}
                {item.column ? `:${item.column}` : ''}
              </li>
            ))}
          </ul>
          {isAggregateMode(mode) && (
            <>
              <p>
                {t('code.graph.edgeCount', { count: selectedEdge.count ?? 0 })} ·{' '}
                {t(selectedEdge.complete ? 'code.graph.complete' : 'code.graph.partial')} ·{' '}
                {t(`code.graph.resolution.${selectedEdge.resolution ?? 'internal'}`)}
              </p>
              {state.evidenceLoading && <StatusTip status="loading" />}
              {state.evidenceError && <Alert type="error">{message(state.evidenceError)}</Alert>}
              <ul data-testid="code-graph-dependency-evidence">
                {state.evidence?.dependencyEvidence?.map((item) => (
                  <li key={item.id}>
                    {item.sourceFile}:{item.line} → {item.targetFile} ({item.kind}) ·{' '}
                    {t(`code.graph.resolution.${item.resolution}`)}
                    <Button onClick={() => void state.inspectNode(item.sourceId, item.line)}>
                      {t('code.graph.inspectImportSource')}
                    </Button>
                  </li>
                ))}
              </ul>
              {state.evidence &&
                coverageNoticeKeys(state.evidence).map((key) => <p key={key}>{t(key)}</p>)}
              {state.evidence && !['ready', 'empty'].includes(state.evidence.state) && (
                <p role="status">{message(state.evidence.state)}</p>
              )}
              {state.evidence?.nextCursor && (
                <Button
                  disabled={
                    state.evidenceLoading || (state.evidence.dependencyEvidence?.length ?? 0) >= 500
                  }
                  onClick={() => void state.loadEvidence(selectedEdge.id, true)}
                >
                  {t('code.graph.moreEvidence')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div className="_codegraph-root" data-testid="code-graph-workspace">
      <h2 className="_codegraph-visually-hidden">{t(`code.graph.mode.${mode}`)}</h2>
      <div className="_codegraph-control-row">
        {meta && (
          <details className="_codegraph-capabilities" data-testid="code-graph-capabilities">
            <summary>{t('code.graph.viewDescription')}</summary>
            <p>
              {t('code.graph.verifiedLanguages', {
                languages:
                  meta.capabilities.languages.map(graphLanguageLabel).join(', ') ||
                  t('code.graph.noVerifiedLanguages'),
              })}
            </p>
            <p>
              {t(mode === 'calls' ? 'code.graph.directionHint' : `code.graph.direction.${mode}`)}
            </p>
            <p className="_codegraph-note">{t('code.graph.analysisCoverage')}</p>
          </details>
        )}
        <CodeGraphModeControls
          state={state}
          onMode={(next) => {
            clearHighlights();
            setKind('');
            setDistance('all');
            state.changeMode(next);
          }}
        />
        {mode === 'clusters' && (
          <nav className="_codegraph-breadcrumbs" aria-label={t('code.graph.breadcrumbs')}>
            {(
              state.graph?.clustering?.breadcrumbs ?? [
                { path: '', groupBy: 'directory' as const, label: '/' },
              ]
            ).map((crumb, index, crumbs) => (
              <span key={`${crumb.path}:${crumb.groupBy}`}>
                {index > 0 && <span aria-hidden="true"> / </span>}
                <button
                  type="button"
                  disabled={state.loading || index === crumbs.length - 1}
                  aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                  onClick={() =>
                    state.configure({ scopePath: crumb.path, groupBy: crumb.groupBy }, true)
                  }
                >
                  {crumb.label === '/' ? t('code.graph.repositoryRoot') : crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}
        <div className="_codegraph-toolbar">
          {narrow && <Button onClick={() => openDrawer('search')}>{t('code.graph.search')}</Button>}
          <Button disabled={!state.canBack || state.loading} onClick={state.back}>
            {t('code.graph.back')}
          </Button>
          <Button
            disabled={(mode === 'clusters' ? !state.canBack : !state.canCollapse) || state.loading}
            onClick={mode === 'clusters' ? state.back : state.collapse}
          >
            {t(mode === 'clusters' ? 'code.graph.collapseGroup' : 'code.graph.collapse')}
          </Button>
          <Button
            onClick={() => {
              state.reset();
              setKind('');
              clearHighlights();
              setDistance('all');
            }}
          >
            {t('code.graph.reset')}
          </Button>
          <label>
            {t('code.graph.kind')}
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">{t('code.graph.allKinds')}</option>
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {mode === 'impact' && (
            <label>
              {t('code.graph.distanceFilter')}
              <select
                aria-label={t('code.graph.distanceFilter')}
                value={distance}
                onChange={(event) => {
                  setDistance(event.target.value);
                  setPathOnly(false);
                }}
              >
                <option value="all">{t('code.graph.allDistances')}</option>
                <option value="direct">{t('code.graph.direct')}</option>
                <option value="indirect">{t('code.graph.indirect')}</option>
              </select>
            </label>
          )}
          <Button disabled={unavailable} onClick={() => setListView(!listView)}>
            {listView || unavailable ? t('code.graph.showCanvas') : t('code.graph.showList')}
          </Button>
          {narrow && (
            <Button onClick={() => openDrawer('source')}>{t('code.graph.details')}</Button>
          )}
        </div>
      </div>
      {(status || recovery) && (
        <div role="status" aria-live="polite" aria-atomic="true" data-testid="code-graph-state">
          <Alert type="warning">
            <span>{recovery ? t(recovery.key, recovery.values) : message(status)}</span>{' '}
            {canReload && (
              <Button type="link" onClick={state.reset}>
                {t('code.graph.retry')}
              </Button>
            )}
            {(recovery?.action === 'chooseSymbol' || status === 'not_found') && (
              <Button type="link" onClick={chooseSymbol}>
                {t('code.graph.chooseSymbol')}
              </Button>
            )}
            {recovery?.action === 'directory' && (
              <Button type="link" onClick={() => state.configure({ groupBy: 'directory' })}>
                {t('code.graph.useDirectory')}
              </Button>
            )}
            {recovery?.action === 'imports' && (
              <Button type="link" onClick={() => state.configure({ edgeKinds: ['imports'] })}>
                {t('code.graph.useImports')}
              </Button>
            )}
            {recovery?.action === 'textQuery' && onTextQuery && (
              <Button type="link" onClick={onTextQuery}>
                {t('code.graph.openTextQuery')}
              </Button>
            )}
          </Alert>
        </div>
      )}
      {unavailable && <Alert>{t('code.graph.noWebGL')}</Alert>}
      <div className="_codegraph-layout">
        {!narrow && searchPanel}
        <section className="_codegraph-main" aria-label={t('code.graph.relations')}>
          <div className="_codegraph-actions _codegraph-expand">
            {!isAggregateMode(mode) &&
              (['in', 'out', 'both'] as const)
                .filter((direction) => mode !== 'impact' || direction === 'in')
                .map((direction) => (
                  <Button
                    key={direction}
                    disabled={
                      !state.selected ||
                      state.loading ||
                      state.atBudget ||
                      (mode === 'impact' && (state.options.depth ?? 2) >= 5)
                    }
                    onClick={() => {
                      if (mode === 'impact')
                        state.configure({ depth: Math.min(5, (state.options.depth ?? 2) + 1) });
                      else void state.load(state.selected!, direction, true);
                    }}
                  >
                    {t(
                      mode === 'hierarchy'
                        ? `code.graph.hierarchyExpand.${direction}`
                        : mode === 'impact'
                          ? 'code.graph.impactExpand'
                          : `code.graph.expand.${direction}`,
                    )}
                  </Button>
                ))}
            <span role="status">
              {t('code.graph.count', { nodes: nodes.length, edges: edges.length })}
            </span>
          </div>
          {state.loading && <StatusTip status="loading" />}
          {!state.graph && !state.loading && (
            <div className="_codegraph-empty">{t('code.graph.selectHint')}</div>
          )}
          {!recovery &&
            ((state.graph?.state === 'empty' && !state.graph.truncated) ||
              (state.graph?.state === 'ready' &&
                state.graph.edges.length === 0 &&
                !state.graph.truncated)) && <p>{t('code.graph.emptyRelations')}</p>}
          {state.graph && nodes.length === 0 && state.graph.nodes.length > 0 && (
            <p>{t('code.graph.filteredEmpty')}</p>
          )}
          {nodes.length > 0 && !listView && !unavailable && (
            <CodeGraphCanvas
              data={data}
              selectedId={state.selected?.id}
              highlightedEdges={highlightedEdges}
              onSelect={select}
              onUnavailable={() => {
                setUnavailable(true);
                setListView(true);
              }}
            />
          )}
          {(listView || unavailable) && (
            <div data-testid="code-graph-relations" className="_codegraph-table-wrap">
              <table>
                <caption>{t('code.graph.nodes')}</caption>
                <thead>
                  <tr>
                    <th>{t('code.graph.symbol')}</th>
                    <th>{t('code.graph.kind')}</th>
                    <th>{t('code.graph.location')}</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <tr key={node.id} aria-selected={node.id === state.selected?.id}>
                      <td>
                        <button type="button" onClick={() => select(node)}>
                          {node.name}
                        </button>
                      </td>
                      <td>
                        {node.kind}
                        {node.aggregate?.boundary && ` · ${t('code.graph.boundary')}`}
                        {node.aggregate && (
                          <small className="_codegraph-group-count">
                            {t('code.graph.groupCounts', {
                              files: node.aggregate.fileCount,
                              symbols: node.aggregate.symbolCount,
                            })}
                          </small>
                        )}
                      </td>
                      <td>{nodeLocation(node)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table>
                <caption>{t('code.graph.relations')}</caption>
                <thead>
                  <tr>
                    <th>{t(mode === 'calls' ? 'code.graph.caller' : 'code.graph.sourceNode')}</th>
                    <th>{t('code.graph.relation')}</th>
                    <th>{t(mode === 'calls' ? 'code.graph.callee' : 'code.graph.targetNode')}</th>
                    <th>{t('code.graph.evidence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((edge) => (
                    <tr key={edge.id}>
                      <td>
                        <button type="button" onClick={() => select(lookup.get(edge.source)!)}>
                          {lookup.get(edge.source)?.name}
                        </button>
                      </td>
                      <td>
                        {edge.kind}
                        {isAggregateMode(mode) && ` ×${edge.count ?? 0}`}
                        {edge.source === edge.target && ` (${t('code.graph.recursive')})`}
                      </td>
                      <td>
                        <button type="button" onClick={() => select(lookup.get(edge.target)!)}>
                          {lookup.get(edge.target)?.name}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            selectEdge(edge.id);
                          }}
                        >
                          {edge.evidence[0]
                            ? `${edge.evidence[0].filePath}:${edge.evidence[0].line}`
                            : t('code.graph.details')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <CodeGraphAnalysis
            state={state}
            nodes={nodes}
            onSelect={select}
            onPath={(node) => {
              setKind('');
              setDistance('all');
              state.setSelected(node);
              setShowPath(true);
              setCycleId(null);
              if (narrow) openDrawer('source');
            }}
            onCycle={(id) => {
              clearHighlights();
              setCycleId(id);
              if (narrow) openDrawer('source');
            }}
          />
          {state.atBudget && <Alert>{t('code.graph.budget')}</Alert>}
          {state.graph?.nextCursor && (
            <Button disabled={state.loading || state.atBudget} onClick={() => void state.more()}>
              {t('code.graph.moreRelations')}
            </Button>
          )}
          {state.graph?.warnings.length && !isAggregateMode(mode) ? (
            <p className="_codegraph-note">
              {t('code.graph.warning')}: {t('code.graph.analysisCoverage')}
            </p>
          ) : null}
        </section>
        {!narrow && sourcePanel}
      </div>
      <Drawer
        ref={setDrawerElement}
        visible={narrow && drawer !== null}
        onClose={() => setDrawer(null)}
        title={t(drawer === 'search' ? 'code.graph.search' : 'code.graph.details')}
        destroyOnClose
      >
        {drawer === 'search' ? searchPanel : sourcePanel}
      </Drawer>
    </div>
  );
}
