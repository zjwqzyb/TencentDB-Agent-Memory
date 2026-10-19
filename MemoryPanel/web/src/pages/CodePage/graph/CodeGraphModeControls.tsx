import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeGraphMode } from '@/lib/api/code-graph-contract';
import { isAggregateMode } from './useCodeGraphWorkspace';
import type { useCodeGraphWorkspace } from './useCodeGraphWorkspace';

type State = ReturnType<typeof useCodeGraphWorkspace>;
export function CodeGraphModeControls({
  state,
  onMode,
}: {
  state: State;
  onMode: (mode: CodeGraphMode) => void;
}) {
  const { t } = useTranslation();
  const { mode, options, configure } = state;
  const [scope, setScope] = useState(options.scopePath ?? '');
  useEffect(() => setScope(options.scopePath ?? ''), [options.scopePath]);
  const relationKinds =
    mode === 'hierarchy'
      ? ['extends', 'implements']
      : ['calls', 'imports', 'extends', 'implements', 'references'];
  return (
    <div className="_codegraph-mode-controls">
      <label>
        {t('code.graph.view')}
        <select
          aria-label={t('code.graph.view')}
          value={mode}
          disabled={!(state.graph?.indexVersion ?? state.catalog?.indexVersion)}
          onChange={(event) => onMode(event.target.value as CodeGraphMode)}
        >
          {(['calls', 'impact', 'dependencies', 'clusters', 'hierarchy'] as const).map((value) => (
            <option value={value} key={value}>
              {t(`code.graph.mode.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {!isAggregateMode(mode) && (
        <label>
          {t('code.graph.depth')}
          <select
            aria-label={t('code.graph.depth')}
            value={options.depth ?? 1}
            disabled={state.loading}
            onChange={(event) => configure({ depth: Number(event.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((depth) => (
              <option key={depth} value={depth}>
                {depth}
              </option>
            ))}
          </select>
        </label>
      )}
      {(mode === 'impact' || mode === 'hierarchy') && (
        <fieldset>
          <legend>{t('code.graph.relationKinds')}</legend>
          {relationKinds.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={options.edgeKinds?.includes(kind) ?? true}
                disabled={
                  state.loading ||
                  (options.edgeKinds?.length === 1 && options.edgeKinds.includes(kind))
                }
                onChange={(event) =>
                  configure({
                    edgeKinds: event.target.checked
                      ? [...(options.edgeKinds ?? []), kind]
                      : options.edgeKinds?.filter((item) => item !== kind),
                  })
                }
              />
              {kind}
            </label>
          ))}
        </fieldset>
      )}
      {isAggregateMode(mode) && (
        <>
          <label>
            {t('code.graph.aggregation')}
            <select
              aria-label={t('code.graph.aggregation')}
              value={options.groupBy ?? 'directory'}
              disabled={state.loading}
              onChange={(event) =>
                configure({ groupBy: event.target.value as 'directory' | 'file' | 'symbol' })
              }
            >
              <option value="directory">{t('code.graph.directory')}</option>
              <option value="file">{t('code.graph.file')}</option>
              {mode === 'clusters' && (
                <option value="symbol" disabled={!options.scopePath}>
                  {t('code.graph.symbolLevel')}
                </option>
              )}
            </select>
          </label>
          {options.groupBy === 'directory' && (
            <label>
              {t('code.graph.moduleDepth')}
              <select
                aria-label={t('code.graph.moduleDepth')}
                value={options.moduleDepth ?? 1}
                disabled={state.loading}
                onChange={(event) => configure({ moduleDepth: Number(event.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t('code.graph.relationKinds')}
            <select
              aria-label={t('code.graph.relationKinds')}
              value={options.edgeKinds?.[0] ?? 'imports'}
              disabled={state.loading}
              onChange={(event) => configure({ edgeKinds: [event.target.value] })}
            >
              <option value="imports">imports</option>
              <option value="calls">calls</option>
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              configure({ scopePath: scope }, true);
            }}
          >
            <label>
              {t(mode === 'clusters' ? 'code.graph.clusterScope' : 'code.graph.dependencyScope')}
              <input
                aria-label={t(
                  mode === 'clusters' ? 'code.graph.clusterScope' : 'code.graph.dependencyScope',
                )}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder="src/"
              />
            </label>
            <button type="submit" disabled={state.loading}>
              {t('code.graph.applyScope')}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
