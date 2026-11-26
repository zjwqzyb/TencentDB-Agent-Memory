import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from 'tea-component';
import { AddIcon, AppIcon, RefreshIcon, UsergroupIcon } from 'tea-icons-react';
import { ResourcePage } from '@/pages/ResourcePage';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetItemBadges,
  AssetItemHeader,
  AssetItemId,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import { prototypeApi } from '@/lib/api/prototypes';
import type { Asset } from '@/lib/api/types';
import { getErrorMessage } from '@/lib/error-message';
import { tea } from '@/lib/tea-bridge';
import { useTeams } from '@/services';
import { useAuthStore } from '@/stores/auth';
import { CreateProjectDialog } from './components/CreateProjectDialog';
import { ProjectDetail } from './components/ProjectDetail';
import './styles/prototypes.css';

interface ProjectListState {
  scopeKey: string;
  items: Asset[];
  loading: boolean;
  error: string | null;
}

const EMPTY_PROJECTS: Asset[] = [];

export function PrototypesPage() {
  const { t } = useTranslation();
  const auth = useAuthStore((state) => state.auth);
  const { activeTeamId, activeTeam, loading: teamsLoading } = useTeams();
  const identityKey = auth ? `${auth.instance_id}:${auth.user_id}` : '';
  const teamScopeKey = identityKey && activeTeamId ? `${identityKey}:${activeTeamId}` : '';
  const currentTeamScope = useRef(teamScopeKey);
  currentTeamScope.current = teamScopeKey;

  const [projectState, setProjectState] = useState<ProjectListState | null>(null);
  const [selection, setSelection] = useState<{ scopeKey: string; assetId: string } | null>(null);
  const [createScope, setCreateScope] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadProjects = useCallback(
    async (signal?: AbortSignal) => {
      if (!teamScopeKey || !activeTeamId) {
        setProjectState(null);
        setSelection(null);
        return;
      }
      const sequence = ++requestSequence.current;
      const requestedScope = teamScopeKey;
      setProjectState({ scopeKey: requestedScope, items: [], loading: true, error: null });
      try {
        const response = await prototypeApi.listProjects(activeTeamId, { signal });
        if (sequence !== requestSequence.current || requestedScope !== currentTeamScope.current) return;
        if (response.items.some((item) => item.team_id !== activeTeamId)) {
          throw new Error(t('prototypes.error.mismatchedResponse'));
        }
        const items = [...response.items].sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.asset_id.localeCompare(right.asset_id),
        );
        setProjectState({ scopeKey: requestedScope, items, loading: false, error: null });
      } catch (cause) {
        if (
          sequence !== requestSequence.current ||
          requestedScope !== currentTeamScope.current ||
          signal?.aborted
        ) {
          return;
        }
        setProjectState({
          scopeKey: requestedScope,
          items: [],
          loading: false,
          error: getErrorMessage(cause),
        });
      }
    },
    [teamScopeKey, activeTeamId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSelection(null);
    void loadProjects(controller.signal);
    return () => {
      requestSequence.current += 1;
      controller.abort();
    };
  }, [loadProjects]);

  const currentProjects = projectState?.scopeKey === teamScopeKey ? projectState : null;
  const projects = currentProjects?.items ?? EMPTY_PROJECTS;
  const selectedAssetId = selection?.scopeKey === teamScopeKey ? selection.assetId : null;
  const selectedAsset = projects.find((item) => item.asset_id === selectedAssetId) ?? null;

  useEffect(() => {
    if (!teamScopeKey || currentProjects?.loading || currentProjects?.error) return;
    if (selectedAsset) return;
    const first = projects[0];
    setSelection(first ? { scopeKey: teamScopeKey, assetId: first.asset_id } : null);
  }, [teamScopeKey, currentProjects, selectedAsset, projects]);

  function projectCreated(asset: Asset) {
    if (currentTeamScope.current !== teamScopeKey) return;
    setProjectState((previous) => {
      if (!previous || previous.scopeKey !== teamScopeKey) return previous;
      const items = previous.items.some((item) => item.asset_id === asset.asset_id)
        ? previous.items
        : [...previous.items, asset].sort(
            (left, right) =>
              left.name.localeCompare(right.name) || left.asset_id.localeCompare(right.asset_id),
          );
      return { ...previous, items, loading: false, error: null };
    });
    setSelection({ scopeKey: teamScopeKey, assetId: asset.asset_id });
    tea.notify.success(t('prototypes.create.success', { name: asset.name }));
  }

  if (!auth) return null;

  return (
    <ResourcePage>
      <div className="_memory-prototypes-body">
        <AssetPageHeader
          title={t('prototypes.title')}
          subtitle={t('prototypes.subtitle', {
            team: activeTeam?.name ?? t('prototypes.noTeam'),
            count: projects.length,
          })}
          scope={
            <span className="_prototype-team-scope">
              <UsergroupIcon size={15} aria-hidden="true" />
              <span>{activeTeam?.name ?? t('prototypes.noTeam')}</span>
              {activeTeamId && <small>{activeTeamId}</small>}
            </span>
          }
          actions={
            <>
              <Button
                tooltip={t('prototypes.action.refreshProjects')}
                aria-label={t('prototypes.action.refreshProjects')}
                loading={currentProjects?.loading ?? teamsLoading}
                disabled={!activeTeamId}
                onClick={() => void loadProjects()}
              >
                <RefreshIcon size={15} aria-hidden="true" />
              </Button>
              <Button
                type="primary"
                disabled={!activeTeamId || teamsLoading}
                tooltip={!activeTeamId ? t('prototypes.create.noTeam') : undefined}
                onClick={() => setCreateScope(teamScopeKey)}
                data-testid="prototype-create-project"
              >
                <AddIcon size={15} aria-hidden="true" />
                {t('prototypes.create.action')}
              </Button>
            </>
          }
        />

        {currentProjects?.error && (
          <div className="_prototype-list-error">
            <Alert type="error">{currentProjects.error}</Alert>
            <Button onClick={() => void loadProjects()}>{t('prototypes.action.retry')}</Button>
          </div>
        )}

        <AssetSplitLayout
          storageKey="prototypes:assetSplitWidth"
          sidebar={
            <div data-testid="prototype-project-list" className="_prototype-project-list">
              <AssetListPanel
                title={t('prototypes.project.list')}
                count={t('prototypes.project.count', { count: projects.length })}
                loading={!currentProjects || currentProjects.loading}
                items={projects}
                selectedId={selectedAssetId}
                getItemId={(item) => item.asset_id}
                onSelect={(item) => {
                  if (teamScopeKey) {
                    setSelection({ scopeKey: teamScopeKey, assetId: item.asset_id });
                  }
                }}
                emptyText={
                  activeTeamId ? t('prototypes.project.empty') : t('prototypes.create.noTeam')
                }
                renderItem={(item) => (
                  <>
                    <AssetItemHeader>
                      <AssetItemName title={item.name}>{item.name}</AssetItemName>
                    </AssetItemHeader>
                    <AssetItemId>{item.asset_id}</AssetItemId>
                    <AssetItemBadges>
                      <span>{t(`prototypes.visibility.${item.visibility}`)}</span>
                      <UserBadge
                        userId={item.owner_user_id}
                        isCurrentUser={item.owner_user_id === auth.user_id}
                        youText={t('prototypes.history.you')}
                      />
                    </AssetItemBadges>
                    <AssetItemTime>{new Date(item.updated_at).toLocaleString()}</AssetItemTime>
                  </>
                )}
              />
            </div>
          }
          detail={
            selectedAsset && activeTeamId ? (
              <ProjectDetail
                key={`${teamScopeKey}:${selectedAsset.asset_id}`}
                teamId={activeTeamId}
                asset={selectedAsset}
                currentUserId={auth.user_id}
              />
            ) : (
              <div className="_prototype-project-placeholder" data-testid="prototype-project-placeholder">
                <AppIcon size={28} aria-hidden="true" />
                <h3>{activeTeamId ? t('prototypes.project.select') : t('prototypes.noTeam')}</h3>
                {activeTeamId && projects.length === 0 && !currentProjects?.loading && (
                  <>
                    <p>{t('prototypes.project.emptyDetail')}</p>
                    <Button
                      type="primary"
                      onClick={() => setCreateScope(teamScopeKey)}
                      data-testid="prototype-create-empty"
                    >
                      <AddIcon size={15} aria-hidden="true" />
                      {t('prototypes.create.action')}
                    </Button>
                  </>
                )}
              </div>
            )
          }
        />

        {createScope && createScope === teamScopeKey && activeTeamId && (
          <CreateProjectDialog
            key={teamScopeKey}
            teamId={activeTeamId}
            teamName={activeTeam?.name ?? activeTeamId}
            onClose={() => setCreateScope(null)}
            onCreated={projectCreated}
          />
        )}
      </div>
    </ResourcePage>
  );
}
