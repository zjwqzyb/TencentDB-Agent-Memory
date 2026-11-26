import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Segment, Select, Tag } from 'tea-component';
import {
  AppIcon,
  FileIcon,
  HistoryIcon,
  LayersIcon,
  PlayIcon,
  RefreshIcon,
  RollbackIcon,
} from 'tea-icons-react';
import {
  prototypeApi,
  type PrototypePageHistoryItem,
  type PrototypePageSummary,
  type PrototypePageVersion,
  type PrototypeProjectAccess,
} from '@/lib/api/prototypes';
import type { Asset } from '@/lib/api/types';
import { getErrorMessage } from '@/lib/error-message';
import { tea } from '@/lib/tea-bridge';
import { UserBadge } from '@/components/asset/UserBadge';
import { ContractDialog } from './ContractDialog';
import { RestoreVersionDialog } from './RestoreVersionDialog';
import {
  buildPrototypeEditorUrl,
  DEFAULT_PAGE_KEY,
  defaultPrototypeView,
  formatPrototypeTime,
  mergePrototypePages,
} from '../utils';

function pageLabel(pageKey: string, t: (key: string) => string): string {
  if (pageKey === 'claim-list') return t('prototypes.page.claimList');
  if (pageKey === 'claim-form') return t('prototypes.page.claimForm');
  return pageKey;
}

function viewLabel(view: string, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    list: 'prototypes.view.list',
    create: 'prototypes.view.create',
    edit: 'prototypes.view.edit',
    view: 'prototypes.view.view',
  };
  return keys[view] ? t(keys[view]) : view;
}

export function ProjectDetail({
  teamId,
  asset,
  currentUserId,
}: {
  teamId: string;
  asset: Asset;
  currentUserId: string;
}) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<PrototypeProjectAccess | null>(null);
  const [pages, setPages] = useState<PrototypePageSummary[]>([]);
  const [selectedPageKey, setSelectedPageKey] = useState(DEFAULT_PAGE_KEY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const refreshProject = useCallback(
    async (signal?: AbortSignal): Promise<PrototypePageSummary[]> => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const [nextAccess, pageResponse] = await Promise.all([
          prototypeApi.getProject(teamId, asset.asset_id, { signal }),
          prototypeApi.listPages(teamId, asset.asset_id, { signal }),
        ]);
        if (sequence !== requestSequence.current) return [];
        if (
          nextAccess.asset.asset_id !== asset.asset_id ||
          nextAccess.asset.team_id !== teamId ||
          nextAccess.user_id !== currentUserId ||
          pageResponse.items.some(
            (page) => page.asset_id !== asset.asset_id || !page.page_key,
          )
        ) {
          throw new Error(t('prototypes.error.mismatchedResponse'));
        }
        const nextPages = mergePrototypePages(pageResponse.items);
        setAccess(nextAccess);
        setPages(nextPages);
        return nextPages;
      } catch (cause) {
        if (sequence === requestSequence.current && !signal?.aborted) {
          setAccess(null);
          setPages([]);
          setError(getErrorMessage(cause));
        }
        throw cause;
      } finally {
        if (sequence === requestSequence.current && !signal?.aborted) setLoading(false);
      }
    },
    [teamId, asset.asset_id, currentUserId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshProject(controller.signal).catch(() => undefined);
    return () => {
      requestSequence.current += 1;
      controller.abort();
    };
  }, [refreshProject]);

  const selectedPage = pages.find((page) => page.page_key === selectedPageKey);

  useEffect(() => {
    if (pages.length > 0 && !selectedPage) setSelectedPageKey(pages[0].page_key);
  }, [pages, selectedPage]);

  if (loading && !access) {
    return (
      <div className="_prototype-detail-state" data-testid="prototype-project-loading">
        <LayersIcon size={24} aria-hidden="true" />
        <span>{t('prototypes.project.loading')}</span>
      </div>
    );
  }

  if (error || !access) {
    return (
      <div className="_prototype-detail-state _prototype-detail-error">
        <Alert type="error">{error ?? t('prototypes.project.unavailable')}</Alert>
        <Button onClick={() => void refreshProject().catch(() => undefined)}>
          <RefreshIcon size={14} aria-hidden="true" />
          {t('prototypes.action.retry')}
        </Button>
      </div>
    );
  }

  return (
    <section className="_prototype-project" data-testid="prototype-project-detail">
      <header className="_prototype-project-header">
        <div className="_prototype-project-heading">
          <AppIcon size={20} aria-hidden="true" />
          <div>
            <div className="_prototype-project-title-row">
              <h3>{access.asset.name}</h3>
              <Tag theme={access.can_write ? 'success' : 'default'} size="sm">
                {access.can_write ? t('prototypes.permission.write') : t('prototypes.permission.read')}
              </Tag>
            </div>
            <div className="_prototype-project-id">{access.asset.asset_id}</div>
          </div>
        </div>
        <Button
          type="text"
          tooltip={t('prototypes.action.refreshProject')}
          aria-label={t('prototypes.action.refreshProject')}
          loading={loading}
          onClick={() => void refreshProject().catch(() => undefined)}
        >
          <RefreshIcon size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className="_prototype-project-context">
        <span>{t('prototypes.project.team', { teamId })}</span>
        <span>{t(`prototypes.visibility.${access.asset.visibility}`)}</span>
        <span>{t('prototypes.project.owner', { owner: access.asset.owner_user_id })}</span>
      </div>

      {!access.can_write && <Alert type="info">{t('prototypes.permission.readHint')}</Alert>}

      <div className="_prototype-project-workspace">
        <nav className="_prototype-pages" aria-label={t('prototypes.page.navigation')} data-testid="prototype-page-list">
          <div className="_prototype-pages-title">
            <span>{t('prototypes.page.units')}</span>
            <span>{pages.length}</span>
          </div>
          {pages.map((page) => {
            const selected = page.page_key === selectedPage?.page_key;
            return (
              <button
                type="button"
                key={page.page_key}
                className={`_prototype-page-button${selected ? ' is-selected' : ''}`}
                aria-current={selected ? 'page' : undefined}
                onClick={() => setSelectedPageKey(page.page_key)}
                data-testid={`prototype-page-${page.page_key}`}
              >
                <span className="_prototype-page-name">{pageLabel(page.page_key, t)}</span>
                <span className="_prototype-page-key">{page.page_key}</span>
                <span className={`_prototype-page-version${page.version === null ? ' is-empty' : ''}`}>
                  {page.version === null ? t('prototypes.page.uninitialized') : `V${page.version}`}
                </span>
              </button>
            );
          })}
        </nav>

        {selectedPage && (
          <PageWorkspace
            key={`${teamId}:${asset.asset_id}:${selectedPage.page_key}`}
            teamId={teamId}
            assetId={asset.asset_id}
            projectName={access.asset.name}
            currentUserId={currentUserId}
            page={selectedPage}
            canWrite={access.can_write}
            refreshPages={refreshProject}
          />
        )}
      </div>
    </section>
  );
}

function PageWorkspace({
  teamId,
  assetId,
  projectName,
  currentUserId,
  page,
  canWrite,
  refreshPages,
}: {
  teamId: string;
  assetId: string;
  projectName: string;
  currentUserId: string;
  page: PrototypePageSummary;
  canWrite: boolean;
  refreshPages: (signal?: AbortSignal) => Promise<PrototypePageSummary[]>;
}) {
  const { t } = useTranslation();
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [view, setView] = useState(() => defaultPrototypeView(page));
  const [snapshot, setSnapshot] = useState<PrototypePageVersion | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(page.version !== null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotReload, setSnapshotReload] = useState(0);
  const [history, setHistory] = useState<PrototypePageHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [contractTarget, setContractTarget] = useState<{
    componentType: string;
    contractVersion: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const exactVersion = selectedVersion ?? page.version;

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setSnapshotError(null);
    setContractTarget(null);
    if (exactVersion === null) {
      setSnapshotLoading(false);
      return () => controller.abort();
    }
    setSnapshotLoading(true);
    prototypeApi
      .getPage(teamId, assetId, page.page_key, exactVersion, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.team_id !== teamId ||
          result.asset_id !== assetId ||
          result.page_key !== page.page_key ||
          result.version !== exactVersion
        ) {
          throw new Error(t('prototypes.error.mismatchedResponse'));
        }
        setSnapshot(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setSnapshotError(getErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSnapshotLoading(false);
      });
    return () => controller.abort();
  }, [teamId, assetId, page.page_key, exactVersion, snapshotReload, t]);

  useEffect(() => {
    const controller = new AbortController();
    setHistory([]);
    setHistoryError(null);
    setHistoryLoading(true);
    prototypeApi
      .history(teamId, assetId, page.page_key, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.items.some(
            (item) => item.asset_id !== assetId || item.page_key !== page.page_key,
          )
        ) {
          throw new Error(t('prototypes.error.mismatchedResponse'));
        }
        setHistory([...result.items].sort((left, right) => right.version - left.version));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setHistoryError(getErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [teamId, assetId, page.page_key, page.version, historyReload, t]);

  const availableViews = useMemo(
    () =>
      snapshot?.snapshot.views.length
        ? snapshot.snapshot.views
        : page.views.length
          ? page.views
          : [defaultPrototypeView(page)],
    [snapshot, page],
  );

  useEffect(() => {
    if (!availableViews.includes(view)) setView(availableViews[0]);
  }, [availableViews, view]);

  const canOpenEditor = page.page_key === 'claim-list' || page.page_key === 'claim-form';
  const editorUrl = canOpenEditor
    ? buildPrototypeEditorUrl({
        teamId,
        assetId,
        pageKey: page.page_key,
        view,
        version: selectedVersion ?? undefined,
      })
    : null;

  const refreshCurrentVersion = useCallback(async (): Promise<number> => {
    const nextPages = await refreshPages();
    const latest = nextPages.find((item) => item.page_key === page.page_key)?.version;
    if (latest === null || latest === undefined) {
      throw new Error(t('prototypes.restore.noCurrent'));
    }
    return latest;
  }, [refreshPages, page.page_key, t]);

  const componentReferences = useMemo(() => {
    const references = new Map<string, { type: string; version: number }>();
    for (const component of snapshot?.snapshot.components ?? []) {
      references.set(`${component.type}@${component.contract_version}`, {
        type: component.type,
        version: component.contract_version,
      });
    }
    return [...references.values()];
  }, [snapshot]);

  function openEditor() {
    if (editorUrl) window.open(editorUrl, '_blank', 'noopener,noreferrer');
  }

  function restored(result: PrototypePageVersion) {
    const message = t('prototypes.restore.success', {
      version: result.version,
      source: result.restore_version,
    });
    setNotice(message);
    tea.notify.success(message);
    setSelectedVersion(null);
    setRestoreVersion(null);
    void refreshPages().catch(() => undefined);
  }

  return (
    <section className="_prototype-page-workspace" data-testid="prototype-page-workspace">
      <div className="_prototype-page-toolbar">
        <div>
          <h4>{pageLabel(page.page_key, t)}</h4>
          <span className="_prototype-page-identity">{page.page_key}</span>
        </div>
        {canOpenEditor && (
          <Button type="primary" onClick={openEditor} data-testid="prototype-open-editor">
            <PlayIcon size={14} aria-hidden="true" />
            {t('prototypes.action.openView', { view: viewLabel(view, t) })}
          </Button>
        )}
      </div>

      <div className="_prototype-view-controls">
        <label>
          <span>{t('prototypes.view.label')}</span>
          <Segment
            value={view}
            onChange={setView}
            options={availableViews.map((item) => ({ value: item, text: viewLabel(item, t) }))}
          />
        </label>
        <label>
          <span>{t('prototypes.version.label')}</span>
          <Select
            value={selectedVersion === null ? 'current' : String(selectedVersion)}
            onChange={(value) => setSelectedVersion(value === 'current' ? null : Number(value))}
            options={[
              {
                value: 'current',
                text: page.version === null
                  ? t('prototypes.version.currentEmpty')
                  : t('prototypes.version.current', { version: page.version }),
              },
              ...history
                .filter((item) => item.version !== page.version)
                .map((item) => ({ value: String(item.version), text: `V${item.version}` })),
            ]}
          />
        </label>
      </div>

      {selectedVersion !== null && (
        <Alert type="warning">{t('prototypes.version.historyReadonly', { version: selectedVersion })}</Alert>
      )}
      {exactVersion === null && <Alert type="info">{t('prototypes.page.emptyHint')}</Alert>}
      {notice && <Alert type="success">{notice}</Alert>}

      <section className="_prototype-snapshot-section" aria-label={t('prototypes.snapshot.label')}>
        <div className="_prototype-section-heading">
          <div>
            <FileIcon size={16} aria-hidden="true" />
            <h5>{t('prototypes.snapshot.label')}</h5>
          </div>
          {snapshot && (
            <div className="_prototype-snapshot-stats">
              <span>format V{snapshot.snapshot.format_version}</span>
              <span>{t('prototypes.snapshot.components', { count: snapshot.snapshot.components.length })}</span>
              {snapshot.snapshot.components.length === 0 && (
                <Tag size="sm">{t('prototypes.snapshot.zeroFields')}</Tag>
              )}
            </div>
          )}
        </div>

        <div data-testid="prototype-snapshot">
          {snapshotLoading && (
            <div className="_prototype-content-loading">{t('prototypes.snapshot.loading')}</div>
          )}
          {snapshotError && (
            <div className="_prototype-inline-error">
              <Alert type="error">{snapshotError}</Alert>
              <Button onClick={() => setSnapshotReload((value) => value + 1)}>
                <RefreshIcon size={14} aria-hidden="true" />
                {t('prototypes.action.retry')}
              </Button>
            </div>
          )}
          {!snapshotLoading && !snapshotError && exactVersion === null && (
            <div className="_prototype-uninitialized">
              <FileIcon size={22} aria-hidden="true" />
              <strong>{t('prototypes.page.uninitialized')}</strong>
              <span>{t('prototypes.page.noSnapshot')}</span>
            </div>
          )}
          {snapshot && (
            <pre className="_prototype-code">{JSON.stringify(snapshot.snapshot, null, 2)}</pre>
          )}
        </div>

        {componentReferences.length > 0 && (
          <div className="_prototype-contracts">
            <span>{t('prototypes.contract.references')}</span>
            <div>
              {componentReferences.map((reference) => (
                <Button
                  key={`${reference.type}@${reference.version}`}
                  onClick={() =>
                    setContractTarget({
                      componentType: reference.type,
                      contractVersion: reference.version,
                    })
                  }
                  data-testid={`prototype-contract-${reference.type}-${reference.version}`}
                >
                  {reference.type}@V{reference.version}
                </Button>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="_prototype-history-section" aria-label={t('prototypes.history.label')}>
        <div className="_prototype-section-heading">
          <div>
            <HistoryIcon size={16} aria-hidden="true" />
            <h5>{t('prototypes.history.label')}</h5>
          </div>
          <Button
            type="text"
            tooltip={t('prototypes.history.refresh')}
            aria-label={t('prototypes.history.refresh')}
            loading={historyLoading}
            onClick={() => setHistoryReload((value) => value + 1)}
          >
            <RefreshIcon size={14} aria-hidden="true" />
          </Button>
        </div>

        {historyError && (
          <div className="_prototype-inline-error">
            <Alert type="error">{historyError}</Alert>
            <Button onClick={() => setHistoryReload((value) => value + 1)}>
              {t('prototypes.action.retry')}
            </Button>
          </div>
        )}
        {!historyError && (
          <div className="_prototype-history-scroll" data-testid="prototype-history-list">
            <table>
              <thead>
                <tr>
                  <th>{t('prototypes.history.version')}</th>
                  <th>{t('prototypes.history.author')}</th>
                  <th>{t('prototypes.history.change')}</th>
                  <th>{t('prototypes.history.time')}</th>
                  <th><span className="_prototype-visually-hidden">{t('prototypes.history.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => {
                  const isCurrent = item.version === page.version;
                  const isSelected = item.version === exactVersion;
                  const authorId = item.author_id ?? item.author_user_id ?? '';
                  return (
                    <tr key={item.version} className={isSelected ? 'is-selected' : undefined}>
                      <td>
                        <button
                          type="button"
                          className="_prototype-version-link"
                          onClick={() => setSelectedVersion(isCurrent ? null : item.version)}
                          data-testid={`prototype-history-v${item.version}`}
                        >
                          V{item.version}
                        </button>
                        {isCurrent && <Tag theme="success" size="sm">{t('prototypes.version.currentShort')}</Tag>}
                      </td>
                      <td>
                        {authorId && (
                          <UserBadge
                            userId={authorId}
                            isCurrentUser={authorId === currentUserId}
                            youText={t('prototypes.history.you')}
                          />
                        )}
                      </td>
                      <td>
                        <span>
                          {item.restore_version !== null
                            ? t('prototypes.history.restoredFrom', { version: item.restore_version })
                            : item.base_version
                              ? t('prototypes.history.basedOn', { version: item.base_version })
                              : t('prototypes.history.initialSave')}
                        </span>
                        <small>{item.views.map((itemView) => viewLabel(itemView, t)).join(' · ')}</small>
                      </td>
                      <td>{formatPrototypeTime(item.created_at)}</td>
                      <td>
                        <Button
                          disabled={!canWrite || isCurrent || page.version === null}
                          tooltip={
                            !canWrite
                              ? t('prototypes.restore.readonlyTooltip')
                              : isCurrent
                                ? t('prototypes.restore.currentTooltip')
                                : undefined
                          }
                          onClick={() => setRestoreVersion(item.version)}
                          data-testid={`prototype-restore-v${item.version}`}
                        >
                          <RollbackIcon size={13} aria-hidden="true" />
                          {t('prototypes.action.restore')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!historyLoading && history.length === 0 && (
              <div className="_prototype-history-empty">{t('prototypes.history.empty')}</div>
            )}
            {historyLoading && (
              <div className="_prototype-content-loading">{t('prototypes.history.loading')}</div>
            )}
          </div>
        )}
      </section>

      {restoreVersion !== null && page.version !== null && (
        <RestoreVersionDialog
          teamId={teamId}
          assetId={assetId}
          projectName={projectName}
          pageKey={page.page_key}
          restoreVersion={restoreVersion}
          initialBaseVersion={page.version}
          onRefresh={refreshCurrentVersion}
          onRestored={restored}
          onClose={() => setRestoreVersion(null)}
        />
      )}

      {contractTarget && (
        <ContractDialog
          teamId={teamId}
          assetId={assetId}
          componentType={contractTarget.componentType}
          contractVersion={contractTarget.contractVersion}
          onClose={() => setContractTarget(null)}
        />
      )}
    </section>
  );
}
