import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Select,
  Tag,
  Text,
} from 'tea-component';
import { ApiError, instanceUpstreamApi, type ExtractionConfig } from '@/lib/teamApi';
import {
  MODEL_PROVIDER_PRESETS,
  buildCreateDraftBody,
  buildUpdateDraftBody,
  formFromConfig,
  isFormDirty,
  requiresKeyReuseConfirmation,
  savedModelConfig,
  selectProvider,
  validateModelForm,
  type ModelConfigForm,
  type UpstreamProvider,
} from './model';
import './model-config.css';

export interface ModelConfigPanelProps {
  instanceName?: string;
  resetToken: number;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  notifySaved: () => void;
}

export function ModelConfigPanel({
  instanceName,
  resetToken,
  onDirtyChange,
  onBusyChange,
  notifySaved,
}: ModelConfigPanelProps) {
  const { t } = useTranslation();
  const requestSeq = useRef(0);
  const [config, setConfig] = useState<ExtractionConfig>();
  const [form, setForm] = useState<ModelConfigForm>(() => formFromConfig(undefined));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [conflictVersions, setConflictVersions] = useState<{ expected?: number; actual?: number } | null>(null);

  const dirty = useMemo(
    () => isFormDirty(form, config),
    [config, form],
  );
  const confirmKeyReuse = requiresKeyReuseConfirmation(form, config);
  const managedDraft = Boolean(config?.draft);
  const disabledManaged = config?.configured === true && config.enabled !== true && !managedDraft;
  const activeManaged = config?.configured === true && config.enabled === true;
  const saved = savedModelConfig(config);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onBusyChange(saving);
  }, [onBusyChange, saving]);

  useEffect(() => {
    if (!confirmKeyReuse && form.confirmReuseKey) {
      setForm((prev) => ({ ...prev, confirmReuseKey: false }));
    }
  }, [confirmKeyReuse, form.confirmReuseKey]);

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    setConflict(false);
    setConflictVersions(null);
    setFieldErrors([]);
    try {
      const next = await instanceUpstreamApi.get(signal);
      if (requestSeq.current !== seq || signal?.aborted) return;
      setConfig(next);
      setForm(formFromConfig(next));
    } catch (err) {
      if (requestSeq.current !== seq || signal?.aborted) return;
      setError(errorMessage(err));
    } finally {
      if (requestSeq.current === seq && !signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig, resetToken]);

  function updateForm(patch: Partial<ModelConfigForm>) {
    setForm((prev) => ({
      ...prev,
      ...patch,
      ...(
        'baseUrl' in patch || 'apiKey' in patch || 'replaceKey' in patch
          ? { confirmReuseKey: false }
          : {}
      ),
    }));
    setFieldErrors([]);
    setError('');
    setConflict(false);
    setConflictVersions(null);
  }

  function handleProviderChange(provider: UpstreamProvider) {
    setForm((prev) => selectProvider(prev, provider));
    setFieldErrors([]);
    setError('');
    setConflict(false);
    setConflictVersions(null);
  }

  async function saveDraft() {
    if (saving) return;
    const errors = validateModelForm(form, config?.config_id ? config : undefined);
    setFieldErrors(errors);
    setError('');
    setConflict(false);
    setConflictVersions(null);
    if (errors.length > 0) return;

    setSaving(true);
    try {
      const next = config?.config_id
        ? await instanceUpstreamApi.updateDraft(buildUpdateDraftBody(form, config))
        : await instanceUpstreamApi.createDraft(buildCreateDraftBody(form));
      setConfig(next);
      setForm(formFromConfig(next));
      notifySaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      if (err instanceof ApiError && err.status === 409 && err.data && typeof err.data === 'object') {
        const detail = err.data as { expected?: unknown; actual?: unknown };
        setConflictVersions({
          expected: typeof detail.expected === 'number' ? detail.expected : undefined,
          actual: typeof detail.actual === 'number' ? detail.actual : undefined,
        });
      }
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const statusLabel = managedDraft
    ? t('modelConfig.status.draft')
    : activeManaged
      ? t('modelConfig.status.active')
      : disabledManaged
        ? t('modelConfig.status.disabled')
          : t('modelConfig.status.deployment');
  const statusTheme = activeManaged ? 'success' : managedDraft ? 'warning' : 'default';
  const currentProvider = saved
    ? t(`modelConfig.provider.${saved.provider}`)
    : t('modelConfig.value.unknown');

  return (
    <div className="model-config-panel" data-testid="model-config-panel">
      <section className="model-config-context" aria-label={t('modelConfig.context.label')}>
        <div className="model-config-context-title">
          <Text theme="label">{t('modelConfig.context.instance')}</Text>
          <strong>{instanceName || t('modelConfig.value.unknown')}</strong>
          <Tag theme={statusTheme} variant="soft" size="sm">{statusLabel}</Tag>
          {activeManaged && managedDraft && (
            <Tag theme="success" variant="soft" size="sm">{t('modelConfig.status.active')}</Tag>
          )}
        </div>
        <Text theme="weak">{t('modelConfig.context.scope')}</Text>
        {activeManaged && managedDraft && (
          <Text theme="weak" parent="div" className="model-config-active-note">
            {t('modelConfig.activeStill', {
              provider: config.provider
                ? t(`modelConfig.provider.${config.provider}`)
                : t('modelConfig.value.unknown'),
              model: config.model_id || t('modelConfig.value.unknown'),
              endpoint: config.base_url || t('modelConfig.value.unknown'),
              key: config.api_key_configured
                ? t('modelConfig.key.configured')
                : t('modelConfig.key.notConfigured'),
            })}
          </Text>
        )}
        <dl className="model-config-summary">
          <div>
            <dt>{t('modelConfig.summary.source')}</dt>
            <dd>{config?.source === 'panel' ? t('modelConfig.source.panel') : t('modelConfig.source.deployment')}</dd>
          </div>
          <div>
            <dt>{t(config?.draft ? 'modelConfig.summary.draftProvider' : 'modelConfig.summary.provider')}</dt>
            <dd>{currentProvider}</dd>
          </div>
          <div>
            <dt>{t(config?.draft ? 'modelConfig.summary.draftModel' : 'modelConfig.summary.model')}</dt>
            <dd>{saved?.model_id || t('modelConfig.value.unknown')}</dd>
          </div>
          <div>
            <dt>{t(config?.draft ? 'modelConfig.summary.draftVersion' : 'modelConfig.summary.version')}</dt>
            <dd>{config?.config_id ? `v${config.version}` : t('modelConfig.value.notManaged')}</dd>
          </div>
          <div>
            <dt>{t('modelConfig.summary.key')}</dt>
            <dd>{saved?.api_key_configured ? t('modelConfig.key.configured') : t('modelConfig.key.notConfigured')}</dd>
          </div>
        </dl>
      </section>

      {loading ? (
        <Alert type="info">{t('modelConfig.loading')}</Alert>
      ) : (
        <Form layout="vertical" className="model-config-form">
          {error && (
            <Alert type="error">
              <div className="model-config-alert-row">
                <span>{error}</span>
                {conflict && (
                  <Button type="link" onClick={() => void loadConfig()}>
                    {t('modelConfig.conflict.reload')}
                  </Button>
                )}
              </div>
              {conflict && conflictVersions && (
                <Text theme="weak" parent="div">
                  {t('modelConfig.conflict.versions', {
                    expected: conflictVersions.expected ?? '—',
                    actual: conflictVersions.actual ?? '—',
                  })}
                </Text>
              )}
            </Alert>
          )}
          {fieldErrors.length > 0 && (
            <Alert type="warning">
              <ul className="model-config-error-list">
                {fieldErrors.map((key) => <li key={key}>{t(key)}</li>)}
              </ul>
            </Alert>
          )}
          <Alert type="info">{t('modelConfig.draftNotice')}</Alert>

          <div className="model-config-grid">
            <Form.Item label={t('modelConfig.field.provider')} required>
              <Select
                appearance="button"
                size="full"
                value={form.provider}
                options={MODEL_PROVIDER_PRESETS.map((preset) => ({
                  value: preset.value,
                  text: t(`modelConfig.provider.${preset.value}`),
                }))}
                onChange={(value) => handleProviderChange(value as UpstreamProvider)}
                disabled={saving}
                boxSizeSync
              />
            </Form.Item>
            <Form.Item label={t('modelConfig.field.modelId')} required>
              <Input
                size="full"
                value={form.modelId}
                placeholder={t('modelConfig.placeholder.modelId')}
                onChange={(value) => updateForm({ modelId: value })}
                disabled={saving}
              />
            </Form.Item>
          </div>

          <Form.Item
            label={t('modelConfig.field.baseUrl')}
            required
            extra={t('modelConfig.field.baseUrl.extra')}
          >
            <Input
              size="full"
              value={form.baseUrl}
              placeholder={t('modelConfig.placeholder.baseUrl')}
              onChange={(value) => updateForm({ baseUrl: value })}
              disabled={saving}
            />
          </Form.Item>

          <Form.Item label={t('modelConfig.field.apiKey')} required={!saved?.api_key_configured || form.replaceKey}>
            {saved?.api_key_configured && !form.replaceKey ? (
              <div className="model-config-key-row">
                <Tag theme="success" variant="soft" size="sm">{t('modelConfig.key.configured')}</Tag>
                <Text theme="weak">{t('modelConfig.key.keepHint')}</Text>
                <Button type="link" disabled={saving} onClick={() => updateForm({ replaceKey: true })}>
                  {t('modelConfig.key.replace')}
                </Button>
              </div>
            ) : (
              <div className="model-config-key-row">
                <Input.Password
                  size="full"
                  value={form.apiKey}
                  placeholder={t('modelConfig.placeholder.apiKey')}
                  onChange={(value) => updateForm({ apiKey: value })}
                  disabled={saving}
                  autoComplete="new-password"
                />
                {saved?.api_key_configured && (
                  <Button type="link" disabled={saving} onClick={() => updateForm({ replaceKey: false, apiKey: '' })}>
                    {t('modelConfig.key.cancelReplace')}
                  </Button>
                )}
              </div>
            )}
          </Form.Item>

          {confirmKeyReuse && (
            <Form.Item>
              <Checkbox
                value={form.confirmReuseKey}
                disabled={saving}
                onChange={(checked) => updateForm({ confirmReuseKey: checked })}
              >
                {t('modelConfig.key.confirmReuse')}
              </Checkbox>
            </Form.Item>
          )}

          <Form.Item label={t('modelConfig.field.description')}>
            <Input.TextArea
              size="full"
              rows={3}
              value={form.description}
              placeholder={t('modelConfig.placeholder.description')}
              onChange={(value) => updateForm({ description: value })}
              disabled={saving}
            />
          </Form.Item>

          <div className="model-config-actions">
            <div className="model-config-dirty-state">
              {dirty && <Tag theme="warning" variant="soft" size="sm">{t('modelConfig.dirty')}</Tag>}
            </div>
            <Button type="primary" loading={saving} disabled={loading || saving} onClick={() => void saveDraft()}>
              {config?.config_id ? t('modelConfig.saveDraft') : t('modelConfig.createDraft')}
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
