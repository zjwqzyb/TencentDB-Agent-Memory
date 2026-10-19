import { useTranslation } from 'react-i18next';
import { Alert, Button } from 'tea-component';
import type { CodeGraphNode } from '@/lib/api/code-graph-contract';
import { coverageNoticeKeys } from './graph-model';
import { isAggregateMode } from './useCodeGraphWorkspace';
import type { useCodeGraphWorkspace } from './useCodeGraphWorkspace';

type State = ReturnType<typeof useCodeGraphWorkspace>;
export function CodeGraphAnalysis({
  state,
  nodes,
  onSelect,
  onPath,
  onCycle,
}: {
  state: State;
  nodes: CodeGraphNode[];
  onSelect: (node: CodeGraphNode) => void;
  onPath: (node: CodeGraphNode) => void;
  onCycle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const graph = state.graph;
  const affected = nodes
    .filter((node) => (node.depth ?? 0) > 0)
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.filePath.localeCompare(b.filePath));
  const files = [...new Set(affected.map((node) => node.filePath))].sort();
  const lookup = new Map(graph?.nodes.map((node) => [node.id, node]));
  return (
    <div className="_codegraph-analysis">
      {graph && coverageNoticeKeys(graph).map((key) => <Alert key={key}>{t(key)}</Alert>)}
      {state.mode === 'impact' && (
        <>
          <Alert>{t('code.graph.staticImpact')}</Alert>
          {graph && (
            <>
              <p>
                {t('code.graph.impactSummary', {
                  symbols: affected.filter((node) => node.kind !== 'file').length,
                  files: files.length,
                  direct: affected.filter((node) => node.depth === 1).length,
                  indirect: affected.filter((node) => (node.depth ?? 0) > 1).length,
                })}
              </p>
              <div className="_codegraph-table-wrap">
                <table data-testid="code-graph-impact-list">
                  <caption>{t('code.graph.impactList')}</caption>
                  <thead>
                    <tr>
                      <th>{t('code.graph.symbol')}</th>
                      <th>{t('code.graph.distance')}</th>
                      <th>{t('code.graph.location')}</th>
                      <th>{t('code.graph.evidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {affected.map((node) => (
                      <tr key={node.id}>
                        <td>
                          <button type="button" onClick={() => onSelect(node)}>
                            {node.name}
                          </button>
                        </td>
                        <td>
                          {node.depth === 1 ? t('code.graph.direct') : t('code.graph.indirect')} ·{' '}
                          {node.depth}
                        </td>
                        <td>
                          {node.filePath}:{node.startLine}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={
                              !graph.impactPaths?.some(
                                (path) => path.nodeId === node.id && path.edgeIds.length > 0,
                              )
                            }
                            onClick={() => onPath(node)}
                          >
                            {t('code.graph.inspectPath', { name: node.name })}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>{t('code.graph.affectedFiles', { count: files.length })}</summary>
                <ul>
                  {files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </>
      )}
      {isAggregateMode(state.mode) && graph && (
        <>
          <p>
            {t(
              graph.aggregation?.countMetric === 'unique_call_site_target_file'
                ? 'code.graph.callCountMetric'
                : 'code.graph.importCountMetric',
            )}
          </p>
          <p>
            {t(
              graph.aggregation?.complete
                ? 'code.graph.aggregateComplete'
                : 'code.graph.aggregatePartial',
            )}
          </p>
          {state.mode === 'clusters' && <p>{t('code.graph.clusterHint')}</p>}
          {graph.aggregation?.distinctSiteCount !== undefined && (
            <p data-testid="code-graph-distinct-sites">
              {t('code.graph.distinctSites', { count: graph.aggregation.distinctSiteCount })}
            </p>
          )}
          <div data-testid="code-graph-cycles">
            <h3>{t('code.graph.cycles')}</h3>
            {graph.cycles?.length ? (
              <ul>
                {graph.cycles.map((cycle) => (
                  <li key={cycle.id}>
                    <Button onClick={() => onCycle(cycle.id)}>
                      {t('code.graph.cycleGroup')}:{' '}
                      {cycle.nodeIds.map((id) => lookup.get(id)?.name ?? id).join(', ')}
                      {!cycle.complete && ` · ${t('code.graph.partial')}`}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {t(
                  graph.aggregation?.complete
                    ? 'code.graph.noCycles'
                    : 'code.graph.noConfirmedCycles',
                )}
              </p>
            )}
          </div>
        </>
      )}
      {graph?.warnings.includes('typescript_interface_extends_not_extracted') && (
        <Alert>{t('code.graph.interfaceExtendsLimit')}</Alert>
      )}
      {state.mode === 'hierarchy' && graph?.warnings.includes('select_a_type') && (
        <Alert>{t('code.graph.selectType')}</Alert>
      )}
      {(state.mode === 'hierarchy' || state.mode === 'impact') && (
        <p className="_codegraph-note">{t('code.graph.analysisCoverage')}</p>
      )}
      {!!graph?.unresolved?.length && (
        <details open data-testid="code-graph-unresolved">
          <summary>{t('code.graph.unresolved', { count: graph.unresolved.length })}</summary>
          <p>{t('code.graph.unresolvedHint')}</p>
          <ul>
            {graph.unresolved.map((item, index) => (
              <li key={`${item.sourceId}:${item.name}:${index}`}>
                <strong>{item.name}</strong> · {item.kind} · {item.filePath}:{item.line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
