/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * system_admin 可在「权限管理」和「模型配置」之间切换；普通成员只看到
 * 自己的资源开关，模型配置的权限仍以 Core 管理接口为准。
 *
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Modal,
  Switch,
  TabPanel,
  Tabs,
  Text,
  Tag,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { useAuthStore } from '@/stores/auth';
import { ModelConfigPanel } from './model-config/ModelConfigPanel';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  labelKey: string;
  descKey: string;
  icon: JSX.Element;
}

const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    labelKey: 'settings.module.wiki',
    descKey: 'settings.module.wiki.desc',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    labelKey: 'settings.module.code',
    descKey: 'settings.module.code.desc',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    labelKey: 'settings.module.skill',
    descKey: 'settings.module.skill.desc',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    labelKey: 'settings.module.chatMemory',
    descKey: 'settings.module.chatMemory.desc',
    icon: <ChatIcon size={16} />,
  },
];

type SettingsTab = 'permissions' | 'model';

export function SettingsDialog({
  onClose,
  instanceName,
}: {
  onClose: () => void;
  instanceName?: string;
}) {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const isSystemAdmin = auth?.isAdmin === true;
  const [activeTab, setActiveTab] = useState<SettingsTab>('permissions');
  const [modelDirty, setModelDirty] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<'close' | 'permissions' | null>(null);

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(t(next ? 'settings.notify.enabled' : 'settings.notify.disabled', { label: t(mod.labelKey) }));
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(t('settings.notify.saveFailed', { msg }));
    } finally {
      setSavingKey(null);
    }
  }

  function requestClose() {
    if (modelBusy) return;
    if (activeTab === 'model' && modelDirty) {
      setPendingNavigation('close');
      return;
    }
    onClose();
  }

  function handleTabChange(tab: { id: string }) {
    const next = tab.id as SettingsTab;
    if (next === activeTab) return;
    if (activeTab === 'model' && modelDirty) {
      setPendingNavigation('permissions');
      return;
    }
    setActiveTab(next);
  }

  function confirmDiscard() {
    if (pendingNavigation === 'close') {
      setPendingNavigation(null);
      onClose();
      return;
    }
    if (pendingNavigation === 'permissions') {
      setActiveTab('permissions');
      setModelDirty(false);
      setResetToken((value) => value + 1);
    }
    setPendingNavigation(null);
  }

  const tabs = isSystemAdmin
    ? [
        { id: 'permissions', label: t('settings.tab.permissions') },
        { id: 'model', label: t('settings.tab.model') },
      ]
    : [{ id: 'permissions', label: t('settings.tab.permissions') }];

  return (
    <Modal
      visible
      caption={t('settings.caption')}
      size="l"
      className="settings-dialog"
      onClose={requestClose}
      disableEscape={modelBusy}
    >
      <Modal.Body>
      <Tabs tabs={tabs} activeId={activeTab} onActive={handleTabChange}>
      <TabPanel id="permissions">
        <div>
          <div style={{ paddingTop: 4 }}>
            <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.title')}
            </Text>
            <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
              {t('settings.desc')}
            </Text>
            {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
            {loading && <Alert type="info" style={{ marginBottom: 12 }}>{t('settings.loadingConfig')}</Alert>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {RESOURCE_MODULES.map((mod) => (
                <div
                  key={mod.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    border: '1px solid var(--tea-color-border-primary-default)',
                    borderRadius: 6,
                    background: enabled[mod.id]
                      ? 'var(--tea-color-bg-brand-lighten-default)'
                      : 'var(--tea-color-bg-primary-default)',
                    transition: 'background-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                      {mod.icon}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: 500 }}>
                          {t(mod.labelKey)}
                        </Text>
                        {savingKey === mod.paramKey ? (
                          <Tag theme="warning" variant="soft" size="sm">{t('settings.tag.saving')}</Tag>
                        ) : enabled[mod.id] ? (
                          <Tag theme="success" variant="soft" size="sm">{t('settings.tag.enabled')}</Tag>
                        ) : (
                          <Tag theme="default" variant="soft" size="sm">{t('settings.tag.disabled')}</Tag>
                        )}
                      </div>
                      <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                        {t(mod.descKey)}
                      </Text>
                    </div>
                  </div>
                  <Switch
                    value={enabled[mod.id]}
                    disabled={loading || savingKey === mod.paramKey}
                    onChange={(v) => void handleToggle(mod, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </TabPanel>
      {isSystemAdmin && (
        <TabPanel id="model">
          <ModelConfigPanel
            instanceName={instanceName}
            resetToken={resetToken}
            onDirtyChange={setModelDirty}
            onBusyChange={setModelBusy}
            notifySaved={() => tea.notify.success(t('modelConfig.notify.saved'))}
          />
        </TabPanel>
      )}
      </Tabs>
      </Modal.Body>
      {pendingNavigation && (
        <Modal visible caption={t('settings.discard.title')} size="s" onClose={() => setPendingNavigation(null)}>
          <Modal.Body>{t('settings.discard.body')}</Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={confirmDiscard}>{t('settings.discard.confirm')}</Button>
            <Button onClick={() => setPendingNavigation(null)}>{t('common.cancel')}</Button>
          </Modal.Footer>
        </Modal>
      )}
    </Modal>
  );
}
