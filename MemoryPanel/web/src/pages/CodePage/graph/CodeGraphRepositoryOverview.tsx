import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, StatusTip } from 'tea-component';
import type { CodeGraphDetail } from '@/lib/api/knowledge-api';
import type { CodeGraphEdge, CodeGraphNode, CodeGraphResponse } from '@/lib/api/code-graph-contract';

export function CodeGraphRepositoryOverview({
  asset,
  graph,
  selected,
  loading,
  onSelectModule,
  onInspectEdge,
  onChooseSymbol,
}: {
  asset: CodeGraphDetail;
  graph: CodeGraphResponse;
  selected: CodeGraphNode | null;
  loading: boolean;
  onSelectModule: (node: CodeGraphNode) => void;
  onInspectEdge: (edge: CodeGraphEdge) => void;
  onChooseSymbol: () => void;
}) {
  const { t } = useTranslation();
  const lookup = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const selectedModule = selected?.aggregate ? selected : null;
  const modules = useMemo(() => {
    const directoryNodes = graph.nodes.filter(
      (node) => node.aggregate?.level === 'directory' && !node.aggregate.boundary,
    );
    const ordered = [...directoryNodes].sort(
      (left, right) =>
        (right.aggregate?.fileCount ?? 0) - (left.aggregate?.fileCount ?? 0) ||
        left.name.localeCompare(right.name),
    );
    if (!selectedModule || ordered.some((node) => node.id === selectedModule.id)) return ordered;
    return [selectedModule, ...ordered];
  }, [graph.nodes, selectedModule]);

  const edges = useMemo(() => {
    const candidates = selectedModule
      ? graph.edges.filter((edge) => edge.source === selectedModule.id || edge.target === selectedModule.id)
      : graph.edges.filter((edge) => edge.source !== edge.target);
    return [...candidates]
      .sort(
        (left, right) =>
          (right.count ?? right.evidence.length) - (left.count ?? left.evidence.length) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 10);
  }, [graph.edges, selectedModule]);

  return (
    <section
      className="_codegraph-repository-overview"
      data-testid="code-graph-repository-overview"
      aria-label={t('code.graph.repositoryOverview')}
    >
      <div className="_codegraph-overview-header">
        <div>
          <h3>{t('code.graph.repositoryOverview')}</h3>
          <p>
            {t('code.graph.overviewSummary', {
              nodes: graph.nodes.length,
              edges: graph.edges.length,
              files: asset.stats?.files ?? graph.aggregation?.scannedNodes ?? 0,
            })}
          </p>
          <p className="_codegraph-note">
            {t('code.graph.overviewIndex', {
              branch: graph.branch,
              index: graph.indexVersion ?? '-',
              commit: graph.commit ? graph.commit.slice(0, 10) : '-',
            })}
          </p>
        </div>
        <Button type="primary" onClick={onChooseSymbol}>
          {t('code.graph.symbol')}
        </Button>
      </div>
      <p className="_codegraph-note">{t('code.graph.moduleMapHint')}</p>
      <div className="_codegraph-module-grid" data-testid="code-graph-module-clusters">
        {loading && <StatusTip status="loading" />}
        {modules.slice(0, 12).map((node) => (
          <article
            key={node.id}
            className={node.id === selectedModule?.id ? '_codegraph-module-card is-selected' : '_codegraph-module-card'}
          >
            <button type="button" onClick={() => onSelectModule(node)} aria-pressed={node.id === selectedModule?.id}>
              <strong>{node.name}</strong>
              <span>{node.aggregate?.path || node.filePath}</span>
              {node.aggregate && (
                <small>
                  {t('code.graph.groupCounts', {
                    files: node.aggregate.fileCount,
                    symbols: node.aggregate.symbolCount,
                  })}
                </small>
              )}
            </button>
          </article>
        ))}
      </div>
      <div className="_codegraph-overview-edges">
        <h4>{selectedModule ? t('code.graph.moduleEdges') : t('code.graph.topModuleEdges')}</h4>
        {edges.length ? (
          <ul>
            {edges.map((edge) => (
              <li key={edge.id}>
                <button type="button" onClick={() => lookup.get(edge.source) && onSelectModule(lookup.get(edge.source)!)}>
                  {lookup.get(edge.source)?.name ?? edge.source}
                </button>
                <span>→</span>
                <button type="button" onClick={() => lookup.get(edge.target) && onSelectModule(lookup.get(edge.target)!)}>
                  {lookup.get(edge.target)?.name ?? edge.target}
                </button>
                <span className="_codegraph-edge-count">
                  {edge.kind} · ×{edge.count ?? edge.evidence.length}
                </span>
                <Button onClick={() => onInspectEdge(edge)}>{t('code.graph.evidence')}</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('code.graph.emptyRelations')}</p>
        )}
      </div>
    </section>
  );
}
