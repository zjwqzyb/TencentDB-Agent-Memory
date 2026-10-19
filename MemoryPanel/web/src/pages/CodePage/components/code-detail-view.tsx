/**
 * CodeDetailView —— Code 资产详情视图（仓库信息 / 代码搜索 / 代码探索）。
 * 数据与回调来自 useCodeSources 返回对象；Markdown 用共享 AssetMarkdown（compact 密度）。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { CodeGraphWorkspace } from '../graph/CodeGraphWorkspace';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, MetricsBoard, SearchBox, StatusTip, Text } from 'tea-component';
import { ArrowLeftIcon, CodeIcon, RefreshIcon } from 'tea-icons-react';
import { AssetMarkdown } from '@/components/asset/AssetMarkdown';
import { formatRepoName } from '../constants/code-constants';
import { statusLabel } from './code-ui';
import type { CodeSourcesStore } from '../hooks/useCodeSources';

export function CodeDetailView({ store }: { store: CodeSourcesStore }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('overview');
  const graphPanelRef = useRef<HTMLDivElement>(null);
  const {
    setSubView,
    selected,
    handleSync,
    searchQuery,
    setSearchQuery,
    searching,
    searchResult,
    handleSearch,
    exploreQuery,
    setExploreQuery,
    exploring,
    exploreResult,
    handleExplore,
  } = store;

  useLayoutEffect(() => {
    if (tab !== 'graph') return;
    const panel = graphPanelRef.current;
    const root = panel?.closest<HTMLElement>('._codedetail-root');
    const header = root?.querySelector<HTMLElement>('.tea-card');
    const tabs = root?.querySelector<HTMLElement>('._codedetail-tabs');
    const syncError = root?.querySelector<HTMLElement>('._codedetail-error');
    const scrollport = panel?.closest<HTMLElement>('.tea-layout__content-body');
    if (!panel || !scrollport) return;
    scrollport.scrollTop = 0;

    const updateHeight = () => {
      const panelTop = panel.getBoundingClientRect().top;
      const scrollportRect = scrollport.getBoundingClientRect();
      const contentTop = panelTop - scrollportRect.top + scrollport.scrollTop;
      const remaining = Math.max(0, scrollport.clientHeight - contentTop - 16);
      panel.style.setProperty('--code-detail-graph-height', `${remaining}px`);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(scrollport);
    if (header) observer.observe(header);
    if (tabs) observer.observe(tabs);
    if (syncError) observer.observe(syncError);
    window.addEventListener('resize', updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateHeight);
      panel.style.removeProperty('--code-detail-graph-height');
    };
  }, [tab, selected?.code_graph_id, selected?.sync_error]);

  if (!selected) return null;

  const selRepo = formatRepoName(selected.repo_name, selected.repo_url);
  const selBranch = selected.branch ?? '';

  return (
    <div className={`_codedetail-root${tab === 'graph' ? ' _codedetail-root--graph' : ''}`}>
      {/* 返回面包屑 */}
      <div className="_codedetail-breadcrumb">
        <Button type="link" onClick={() => setSubView('list')}>
          <span className="_codedetail-inline-icon">
            <ArrowLeftIcon size={12} /> {t('code.detail.breadcrumb')}
          </span>
        </Button>
        <span className="_codedetail-breadcrumb-sep">/</span>
        <span className="_codedetail-breadcrumb-current _codedetail-mono">{selRepo}</span>
      </div>

      {/* 头部 */}
      <Card>
        <Card.Body className="_codedetail-header-body">
          <div className="_codedetail-header-row">
            <div className="_codedetail-header-left">
              {tab === 'graph' && (
                <Button
                  className="_codedetail-graph-back"
                  type="link"
                  onClick={() => setSubView('list')}
                >
                  <span className="_codedetail-inline-icon">
                    <ArrowLeftIcon size={12} /> {t('code.detail.breadcrumb')}
                  </span>
                </Button>
              )}
              <CodeIcon size={20} />
              <span className="_codedetail-title" title={selRepo}>
                {selRepo}
              </span>
              {selected && statusLabel(t, selected.status)}
              {tab === 'graph' && (
                <span className="_codedetail-graph-branch _codedetail-mono">
                  {selBranch} · {selected.commit_hash?.slice(0, 8) ?? '—'}
                </span>
              )}
            </div>
            <div className="_codedetail-header-actions">
              <Button type="primary" onClick={() => handleSync(selected.code_graph_id)}>
                <span className="_codedetail-inline-icon">
                  <RefreshIcon size={14} />
                  {t('code.action.sync')}
                </span>
              </Button>
            </div>
          </div>
          {tab === 'graph' && selected.last_sync_at ? (
            <details className="_codedetail-graph-info">
              <summary>{t('code.detail.repoInfo')}</summary>
              <span>{t('code.detail.branch', { branch: selBranch })}</span>
              {selected.commit_hash && (
                <span className="_codedetail-mono _codedetail-graph-commit">
                  @ {selected.commit_hash}
                </span>
              )}
              <span>{new Date(selected.last_sync_at).toLocaleString()}</span>
            </details>
          ) : (
            <div className="_detail-meta-row">
              <span>{t('code.detail.branch', { branch: selBranch })}</span>
              {selected?.commit_hash && (
                <>
                  <span className="_detail-meta-sep">·</span>
                  <span className="_codedetail-mono">@ {selected.commit_hash}</span>
                </>
              )}
              {selected?.last_sync_at && (
                <>
                  <span className="_detail-meta-sep">·</span>
                  <span>{new Date(selected.last_sync_at).toLocaleString()}</span>
                </>
              )}
            </div>
          )}
        </Card.Body>
      </Card>

      {selected?.sync_error && (
        <Alert type="error" className="_codedetail-error">
          {selected.sync_error}
        </Alert>
      )}

      <div className="_codedetail-tabs" role="tablist" aria-label={t('code.graph.tab')}>
        {(['overview', 'graph'] as const).map((id, index) => (
          <button
            key={id}
            id={`code-detail-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`code-detail-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 'overview'
                  : event.key === 'End'
                    ? 'graph'
                    : index === 0
                      ? 'graph'
                      : 'overview';
              setTab(next);
              document.getElementById(`code-detail-tab-${next}`)?.focus();
            }}
          >
            {t(id === 'overview' ? 'code.graph.overview' : 'code.graph.tab')}
          </button>
        ))}
      </div>
      <div
        ref={graphPanelRef}
        role="tabpanel"
        className="_codedetail-graph-panel"
        id="code-detail-panel-graph"
        aria-labelledby="code-detail-tab-graph"
        hidden={tab !== 'graph'}
      >
        {tab === 'graph' && (
          <CodeGraphWorkspace
            key={`${selected.code_graph_id}:${selected.version}:${selected.status}:${selected.last_sync_at}`}
            asset={selected}
            onTextQuery={() => {
              setTab('overview');
              requestAnimationFrame(() =>
                document.getElementById('code-detail-tab-overview')?.focus(),
              );
            }}
          />
        )}
      </div>
      <div
        role="tabpanel"
        id="code-detail-panel-overview"
        aria-labelledby="code-detail-tab-overview"
        hidden={tab !== 'overview'}
      >
        {/* 统计 */}
        {selected?.stats && (
          <div className="_codedetail-stats">
            <MetricsBoard
              title={t('code.detail.files')}
              value={selected.stats.files?.toLocaleString() ?? '-'}
            />
            <MetricsBoard
              title={t('code.detail.nodes')}
              value={selected.stats.nodes?.toLocaleString() ?? '-'}
            />
            <MetricsBoard
              title={t('code.detail.edges')}
              value={selected.stats.edges?.toLocaleString() ?? '-'}
            />
          </div>
        )}

        {/* 仓库信息 */}
        {selected && (
          <Card>
            <Card.Body title={t('code.detail.repoInfo')}>
              <div className="_codedetail-info-grid">
                <Text theme="label">Code Graph ID</Text>
                <Text className="_codedetail-mono">{selected.code_graph_id}</Text>
                <Text theme="label">{t('code.register.gitUrl')}</Text>
                <Text className="_codedetail-mono">{selected.repo_url || '—'}</Text>
                <Text theme="label">{t('code.detail.lastSync')}</Text>
                <Text>
                  {selected.last_sync_at ? new Date(selected.last_sync_at).toLocaleString() : '—'}
                </Text>
              </div>
            </Card.Body>
          </Card>
        )}

        {/* 代码搜索 */}
        <Card>
          <Card.Body title={t('code.detail.search')}>
            <Text theme="label" parent="div" className="_codedetail-hint">
              {t('code.detail.search.hint')}
            </Text>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={searchQuery}
                onChange={(v) => setSearchQuery(v)}
                onSearch={() => void handleSearch()}
                placeholder={t('code.detail.search.placeholder')}
              />
            </div>
            {searching && <StatusTip status="loading" />}
            {!searching && searchResult && (
              <div className="_codedetail-result-box">
                <AssetMarkdown content={searchResult} compact />
              </div>
            )}
          </Card.Body>
        </Card>

        {/* 代码探索 */}
        <Card>
          <Card.Body title={t('code.detail.explore')}>
            <Text theme="label" parent="div" className="_codedetail-hint">
              {t('code.detail.explore.hint')}
            </Text>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={exploreQuery}
                onChange={(v) => setExploreQuery(v)}
                onSearch={() => void handleExplore()}
                placeholder={t('code.detail.explore.placeholder')}
              />
            </div>
            {exploring && <StatusTip status="loading" />}
            {!exploring && exploreResult && (
              <div className="_codedetail-result-box">
                <AssetMarkdown content={exploreResult} compact />
              </div>
            )}
          </Card.Body>
        </Card>
      </div>
    </div>
  );
}
