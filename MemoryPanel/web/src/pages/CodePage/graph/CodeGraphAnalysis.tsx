import { useTranslation } from 'react-i18next';
import { Alert, Button } from 'tea-component';
import type { CodeGraphNode, CodeGraphResponse } from '@/lib/api/code-graph-contract';
import { coverageNoticeKeys } from './graph-model';
import { isAggregateMode } from './useCodeGraphWorkspace';
import type { useCodeGraphWorkspace } from './useCodeGraphWorkspace';

type State = ReturnType<typeof useCodeGraphWorkspace>;
type UnresolvedItem = NonNullable<CodeGraphResponse['unresolved']>[number];
type UnresolvedCallGroup = {
  sourceId: string;
  callerName: string;
  filePath: string;
  expressions: { name: string; sites: UnresolvedItem[] }[];
};

function compareUnresolvedSites(a: UnresolvedItem, b: UnresolvedItem): number {
  return a.line - b.line || (a.column ?? 0) - (b.column ?? 0);
}

function formatUnresolvedSiteLocation(site: UnresolvedItem): string {
  return site.column === undefined ? `${site.line}` : `${site.line}:${site.column}`;
}

function groupUnresolvedCalls(
  items: UnresolvedItem[],
  lookup: Map<string, CodeGraphNode>,
): UnresolvedCallGroup[] {
  const groups = new Map<string, UnresolvedCallGroup>();
  for (const item of items) {
    const groupKey = `${item.sourceId}\0${item.filePath}`;
    const group = groups.get(groupKey) ?? {
      sourceId: item.sourceId,
      callerName: lookup.get(item.sourceId)?.name ?? item.sourceId,
      filePath: item.filePath,
      expressions: [],
    };
    groups.set(groupKey, group);

    let expression = group.expressions.find((row) => row.name === item.name);
    if (!expression) {
      expression = { name: item.name, sites: [] };
      group.expressions.push(expression);
    }
    expression.sites.push(item);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      expressions: group.expressions
        .map((expression) => ({
          ...expression,
          sites: [...expression.sites].sort(compareUnresolvedSites),
        }))
        .sort(
          (a, b) => compareUnresolvedSites(a.sites[0], b.sites[0]) || a.name.localeCompare(b.name),
        ),
    }))
    .sort(
      (a, b) => a.callerName.localeCompare(b.callerName) || a.filePath.localeCompare(b.filePath),
    );
}

export function CodeGraphAnalysis({
  state,
  nodes,
  onSelect,
  onPath,
  onCycle,
  onInspectUnresolved,
}: {
  state: State;
  nodes: CodeGraphNode[];
  onSelect: (node: CodeGraphNode) => void;
  onPath: (node: CodeGraphNode) => void;
  onCycle: (id: string) => void;
  onInspectUnresolved: (sourceId: string, line: number) => void;
}) {
  const { t } = useTranslation();
  const graph = state.graph;
  const affected = nodes
    .filter((node) => (node.depth ?? 0) > 0)
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.filePath.localeCompare(b.filePath));
  const files = [...new Set(affected.map((node) => node.filePath))].sort();
  const lookup = new Map(graph?.nodes.map((node) => [node.id, node]));
  const unresolvedTitle =
    state.mode === 'calls' ? 'code.graph.unresolvedCalls' : 'code.graph.unresolved';
  const unresolvedHint =
    state.mode === 'calls' ? 'code.graph.unresolvedCallsHint' : 'code.graph.unresolvedHint';
  const unresolvedCallGroups =
    state.mode === 'calls' && graph?.unresolved?.length
      ? groupUnresolvedCalls(graph.unresolved, lookup)
      : [];
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
      {graph?.state !== 'unsupported' &&
        graph?.warnings.includes('typescript_interface_extends_not_extracted') && (
          <Alert>{t('code.graph.interfaceExtendsLimit')}</Alert>
        )}
      {(state.mode === 'hierarchy' || state.mode === 'impact') && (
        <p className="_codegraph-note">{t('code.graph.analysisCoverage')}</p>
      )}
      {!!graph?.unresolved?.length && (
        <details open={state.mode !== 'calls'} data-testid="code-graph-unresolved">
          <summary>{t(unresolvedTitle, { count: graph.unresolved.length })}</summary>
          <p>{t(unresolvedHint)}</p>
          {state.mode === 'calls' ? (
            <ul className="_codegraph-unresolved-groups">
              {unresolvedCallGroups.map((group) => (
                <li
                  key={`${group.sourceId}:${group.filePath}`}
                  className="_codegraph-unresolved-group"
                  data-source-id={group.sourceId}
                >
                  <div className="_codegraph-unresolved-heading">
                    <strong className="_codegraph-unresolved-caller">{group.callerName}</strong>
                    <small className="_codegraph-unresolved-file">{group.filePath}</small>
                  </div>
                  <ul className="_codegraph-unresolved-expressions">
                    {group.expressions.map((expression) => (
                      <li
                        key={`${group.sourceId}:${group.filePath}:${expression.name}`}
                        className="_codegraph-unresolved-expression"
                      >
                        <code>{expression.name}</code>
                        <span className="_codegraph-unresolved-sites">
                          {expression.sites.map((site, index) => {
                            const location = formatUnresolvedSiteLocation(site);
                            const showColumn = expression.sites.some(
                              (other) => other !== site && other.line === site.line,
                            );
                            const accessibleLabel = `${t(
                              'code.graph.inspectUnresolvedSource',
                            )}: ${group.callerName} ${group.filePath}:${location} ${expression.name}`;
                            return (
                              <button
                                key={`${site.sourceId}:${site.name}:${site.line}:${site.column ?? ''}:${index}`}
                                type="button"
                                title={accessibleLabel}
                                aria-label={accessibleLabel}
                                onClick={() => onInspectUnresolved(site.sourceId, site.line)}
                              >
                                {showColumn ? location : site.line}
                              </button>
                            );
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              {graph.unresolved.map((item, index) => (
                <li key={`${item.sourceId}:${item.name}:${index}`}>
                  <strong>{item.name}</strong> · {item.kind} · {item.filePath}:{item.line}
                  <Button
                    onClick={() => onInspectUnresolved(item.sourceId, item.line)}
                    aria-label={`${t('code.graph.inspectUnresolvedSource')}: ${lookup.get(item.sourceId)?.name ?? item.sourceId} ${item.filePath}:${item.line}`}
                  >
                    {t('code.graph.inspectUnresolvedSource')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
