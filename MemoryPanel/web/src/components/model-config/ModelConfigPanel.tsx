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
  buildTestBody,
  buildUpdateDraftBody,
  canEnableConfig,
  canRunTest,
  enableBlockedReason,
  formFromConfig,
  isFormDirty,
  requiresKeyReuseConfirmation,
  savedModelConfig,
  selectProvider,
  testFormErrors,
  validateModelForm,
  type ModelConfigForm,
  type ModelTestCapability,
  type UpstreamProvider,
} from './model';
import './model-config.css';

type CapabilityStatus = 'idle' | 'running' | 'passed' | 'failed' | 'cancelled';

interface CapabilityState {
  status: CapabilityStatus;
  durationMs?: number;
  error?: { code: string; message: string; http_status?: number };
}

/** 展示顺序固定，不依赖服务端事件到达顺序。 */
const TEST_CAPABILITIES: readonly ModelTestCapability[] = ['basic', 'json', 'tools'];

const TEST_STATUS_THEME: Record<CapabilityStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  idle: 'default',
  running: 'primary',
  passed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

function initialTestResults(): Record<ModelTestCapability, CapabilityState> {
  return {
    basic: { status: 'idle' },
    json: { status: 'idle' },
    tools: { status: 'idle' },
  };
}

/**
 * 收敛未完成的能力：
 * - 已进入 running 但没拿到 result 的按失败/取消落定，避免一直停在"运行中"；
 * - 取消时连尚未开始的能力也标为"已取消"（用户看到的是整次测试被取消）；
 * - 请求在流开始前就失败时，保持"未运行"，由顶部错误说明原因。
 */
function settleUnfinished(
  results: Record<ModelTestCapability, CapabilityState>,
  status: 'failed' | 'cancelled',
): Record<ModelTestCapability, CapabilityState> {
  const next = { ...results };
  for (const capability of TEST_CAPABILITIES) {
    const current = next[capability].status;
    if (current === 'running' || (current === 'idle' && status === 'cancelled')) {
      next[capability] = { status };
    }
  }
  return next;
}

/** 指纹按 4 位分组展示前 12 位，便于人工比对又不占满一行。 */
export function shortFingerprint(fingerprint: string): string {
  // 指纹形如 `sha256:<hex>`：算法前缀对排障无价值，只展示摘要前 12 位并分组。
  const digest = fingerprint.includes(':')
    ? fingerprint.slice(fingerprint.indexOf(':') + 1)
    : fingerprint;
  return digest.slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');
}

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
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState(initialTestResults);
  const [testMeta, setTestMeta] = useState<{ testId: string; fingerprint: string; source: 'deployment' | 'panel' } | null>(null);
  const [testError, setTestError] = useState('');
  const [activating, setActivating] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncNotice, setResyncNotice] = useState('');
  const testAbort = useRef<AbortController | null>(null);
  // 同步闸门：同一 tick 内的两次点击都看到尚未刷新的 `testing`，必须靠 ref 拦住。
  const testInFlight = useRef(false);

  const dirty = useMemo(
    () => isFormDirty(form, config),
    [config, form],
  );
  const confirmKeyReuse = requiresKeyReuseConfirmation(form, config);
  const busy = saving || testing || activating;
  const managedDraft = Boolean(config?.draft);
  const disabledManaged = config?.configured === true && config.enabled !== true && !managedDraft;
  const activeManaged = config?.configured === true && config.enabled === true;
  const saved = savedModelConfig(config);

  const resetTestResults = useCallback(() => {
    setTestResults(initialTestResults());
    setTestMeta(null);
    setTestError('');
  }, []);

  // 离开面板时中止未完成的测试流，避免把事件写进已卸载组件的状态。
  useEffect(() => () => { testAbort.current?.abort(); }, []);

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
      resetTestResults();
    } catch (err) {
      if (requestSeq.current !== seq || signal?.aborted) return;
      setError(errorMessage(err));
    } finally {
      if (requestSeq.current === seq && !signal?.aborted) setLoading(false);
    }
  }, [resetTestResults]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig, resetToken]);

  function updateForm(patch: Partial<ModelConfigForm>) {
    resetTestResults();
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
    resetTestResults();
    setForm((prev) => selectProvider(prev, provider, savedModelConfig(config)?.base_url));
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
      resetTestResults();
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

  function testErrorMessageInternal(err: unknown): string {
    if (err instanceof ApiError) {
      const code = typeof err.code === 'string' ? err.code : undefined;
      if (code === 'TEST_ALREADY_RUNNING') return t('modelConfig.test.error.alreadyRunning');
      if (code === 'INVALID_TEST_CONFIG') return err.message || t('modelConfig.test.errorFallback');
      if (err.status === 403) return err.message || t('modelConfig.test.error.permission');
    }
    const message = errorMessage(err);
    return message || t('modelConfig.test.errorFallback');
  }

  async function runTest() {
    if (testing || testInFlight.current) return;
    const errors = testFormErrors(form, config);
    setFieldErrors(errors);
    setError('');
    setConflict(false);
    setConflictVersions(null);
    setTestError('');
    if (errors.length > 0 || !canRunTest(form, config)) return;

    const controller = new AbortController();
    testAbort.current = controller;
    testInFlight.current = true;
    setTesting(true);
    setTestResults(initialTestResults());
    setTestMeta(null);
    let outcome: 'completed' | 'failed' | 'cancelled' | null = null;
    const reported = new Set<ModelTestCapability>();
    try {
      await instanceUpstreamApi.testConfig(buildTestBody(form, config), {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'started') {
            setTestMeta({
              testId: event.test_id,
              fingerprint: event.fingerprint,
              source: event.source,
            });
            setTestResults((prev) => {
              const next = { ...prev };
              for (const capability of event.capabilities) {
                if (capability in next) next[capability] = { status: 'running' };
              }
              return next;
            });
            return;
          }
          if (event.type === 'result') {
            reported.add(event.capability);
            setTestResults((prev) => ({
              ...prev,
              [event.capability]: {
                status: event.status,
                durationMs: event.duration_ms,
                error: event.error,
              },
            }));
            return;
          }
          outcome = event.status;
        },
      });
      if (controller.signal.aborted) {
        setTestResults((prev) => settleUnfinished(prev, 'cancelled'));
        return;
      }
      // 服务端可能不发 done（例如取消）：自行收敛，不允许能力一直停在"运行中"。
      if (outcome === 'cancelled') {
        setTestResults((prev) => settleUnfinished(prev, 'cancelled'));
      } else {
        setTestResults((prev) => settleUnfinished(prev, 'failed'));
        const allReported = TEST_CAPABILITIES.every((capability) => reported.has(capability));
        if (outcome === null && !allReported) setTestError(t('modelConfig.test.error.incomplete'));
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        setTestResults((prev) => settleUnfinished(prev, 'cancelled'));
      } else {
        setTestResults((prev) => settleUnfinished(prev, 'failed'));
        setTestError(testErrorMessageInternal(err));
      }
    } finally {
      if (testAbort.current === controller) {
        testAbort.current = null;
        testInFlight.current = false;
        setTesting(false);
        // 服务端在测试结束后把证据写回配置行；只刷新 config（不动表单），
        // 这样"启用"门禁能立刻读到 test_id / matches_current，且不会丢用户未保存的输入。
        if (!controller.signal.aborted) {
          try {
            setConfig(await instanceUpstreamApi.get());
          } catch {
            /* 证据刷新失败不阻塞：用户可重试或先保存草稿 */
          }
        }
      }
    }
  }

  function cancelTest() {
    const controller = testAbort.current;
    testAbort.current = null;
    testInFlight.current = false;
    if (controller && !controller.signal.aborted) controller.abort();
    // UI 立即收敛，不等服务端补齐事件。
    setTestResults((prev) => settleUnfinished(prev, 'cancelled'));
    setTesting(false);
  }

  async function activateDraft() {
    if (!config?.draft || !config.test || activating || saving || testing) return;
    setActivating(true);
    setError('');
    setFieldErrors([]);
    try {
      const next = await instanceUpstreamApi.enable({
        expected_version: config.version,
        test_id: config.test.test_id,
      });
      setConfig(next);
      setForm(formFromConfig(next));
      setTestResults(initialTestResults());
      setTestMeta(null);
      notifySaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data && typeof err.data === 'object') {
        const detail = err.data as { expected?: unknown; actual?: unknown };
        setConflictVersions({
          expected: typeof detail.expected === 'number' ? detail.expected : undefined,
          actual: typeof detail.actual === 'number' ? detail.actual : undefined,
        });
      }
      setError(errorMessage(err));
    } finally {
      setActivating(false);
    }
  }

  async function resyncKnowledgeBinding() {
    if (resyncing || busy) return;
    setResyncing(true);
    setResyncNotice('');
    setError('');
    try {
      const result = await instanceUpstreamApi.resyncKnowledge();
      setResyncNotice(t('modelConfig.resync.ok', { status: result.status }));
    } catch (err) {
      setError(errorMessage(err) || t('modelConfig.resync.failed'));
    } finally {
      setResyncing(false);
    }
  }

  async function pauseActiveConfig() {
    if (!config?.config_id || activating || saving || testing) return;
    setActivating(true);
    setError('');
    try {
      const next = await instanceUpstreamApi.disable({ expected_version: config.version });
      setConfig(next);
      setForm(formFromConfig(next));
      notifySaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setActivating(false);
    }
  }

  const paused = config?.paused === true;
  const hasSnapshot = Boolean(config?.active_snapshot);
  const enableHint = enableBlockedReason(config, { dirty });
  const canEnable = canEnableConfig(config, { dirty });
  // 启用后草稿按设计仍保留（供继续编辑），因此"已启用"必须优先于"草稿"判断。
  const statusLabel = paused
    ? t('modelConfig.status.paused')
    : activeManaged
      ? t('modelConfig.status.active')
      : managedDraft
        ? t('modelConfig.status.draft')
        : disabledManaged
          ? t('modelConfig.status.disabled')
            : t('modelConfig.status.deployment');
  const statusTheme = paused
    ? 'error'
    : activeManaged
      ? 'success'
      : managedDraft
        ? 'warning'
        : 'default';
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
          {paused && <Alert type="error">{t('modelConfig.pausedNotice')}</Alert>}
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
                disabled={busy}
                boxSizeSync
              />
            </Form.Item>
            <Form.Item label={t('modelConfig.field.modelId')} required>
              <Input
                size="full"
                value={form.modelId}
                placeholder={t('modelConfig.placeholder.modelId')}
                onChange={(value) => updateForm({ modelId: value })}
                disabled={busy}
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
              disabled={busy}
            />
          </Form.Item>

          <Form.Item label={t('modelConfig.field.apiKey')} required={!saved?.api_key_configured || form.replaceKey}>
            {saved?.api_key_configured && !form.replaceKey ? (
              <div className="model-config-key-row">
                <Tag theme="success" variant="soft" size="sm">{t('modelConfig.key.configured')}</Tag>
                <Text theme="weak">{t('modelConfig.key.keepHint')}</Text>
                <Button type="link" disabled={busy} onClick={() => updateForm({ replaceKey: true })}>
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
                  disabled={busy}
                  autoComplete="new-password"
                />
                {saved?.api_key_configured && (
                  <Button type="link" disabled={busy} onClick={() => updateForm({ replaceKey: false, apiKey: '' })}>
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
                disabled={busy}
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
              disabled={busy}
            />
          </Form.Item>

          <section
            className="model-config-test"
            aria-live="polite"
            aria-label={t('modelConfig.test.title')}
            data-testid="model-config-test"
          >
            <div className="model-config-test-head">
              <Text theme="label">{t('modelConfig.test.title')}</Text>
              {testing && <Tag theme="primary" variant="soft" size="sm">{t('modelConfig.test.running')}</Tag>}
            </div>
            <Text theme="weak">{t('modelConfig.test.description')}</Text>
            {testError && <Alert type="error">{testError}</Alert>}
            {testMeta && (
              <dl className="model-config-test-meta">
                <div>
                  <dt>{t('modelConfig.test.testId')}</dt>
                  <dd><code>{testMeta.testId}</code></dd>
                </div>
                <div>
                  <dt>{t('modelConfig.test.fingerprint')}</dt>
                  <dd><code>{shortFingerprint(testMeta.fingerprint)}</code></dd>
                </div>
                <div>
                  <dt>{t('modelConfig.test.source')}</dt>
                  <dd>{t(`modelConfig.test.source.${testMeta.source}`)}</dd>
                </div>
              </dl>
            )}
            <ul className="model-config-test-capabilities">
              {TEST_CAPABILITIES.map((capability) => {
                const result = testResults[capability];
                return (
                  <li key={capability} className="model-config-test-capability">
                    <span className="model-config-test-capability-name">
                      {t(`modelConfig.test.capability.${capability}`)}
                    </span>
                    <Tag theme={TEST_STATUS_THEME[result.status]} variant="soft" size="sm">
                      {t(`modelConfig.test.status.${result.status}`)}
                    </Tag>
                    {typeof result.durationMs === 'number' && (
                      <Text theme="weak">{t('modelConfig.test.duration', { ms: result.durationMs })}</Text>
                    )}
                    {result.error && (
                      <span className="model-config-test-error">
                        {result.error.code}
                        {typeof result.error.http_status === 'number' ? ` (HTTP ${result.error.http_status})` : ''}
                        {' · '}
                        {result.error.message}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="model-config-actions">
            <div className="model-config-dirty-state">
              {dirty && <Tag theme="warning" variant="soft" size="sm">{t('modelConfig.dirty')}</Tag>}
            </div>
            {testing ? (
              <Button onClick={cancelTest}>{t('modelConfig.test.cancel')}</Button>
            ) : (
              <Button disabled={loading || saving} onClick={() => void runTest()}>
                {t('modelConfig.test.action')}
              </Button>
            )}
            {activeManaged && hasSnapshot && (
              <Button loading={activating} disabled={loading || busy} onClick={() => void pauseActiveConfig()}>
                {t('modelConfig.disable')}
              </Button>
            )}
            {managedDraft && (
              <Button
                type="primary"
                loading={activating}
                disabled={loading || busy || !canEnable}
                title={enableHint ? t(`modelConfig.enableHint.${enableHint}`) : undefined}
                onClick={() => void activateDraft()}
              >
                {t('modelConfig.enable')}
              </Button>
            )}
            <Button type="primary" loading={saving} disabled={loading || busy} onClick={() => void saveDraft()}>
              {config?.config_id ? t('modelConfig.saveDraft') : t('modelConfig.createDraft')}
            </Button>
          </div>
          {managedDraft && enableHint && (
            <Text theme="weak" parent="div">
              {t(`modelConfig.enableHint.${enableHint}`)}
            </Text>
          )}
          {hasSnapshot && (
            <div className="model-config-resync">
              <Button
                type="link"
                loading={resyncing}
                disabled={busy || loading}
                onClick={() => void resyncKnowledgeBinding()}
              >
                {t('modelConfig.resync.action')}
              </Button>
              {resyncNotice && <Text theme="weak">{resyncNotice}</Text>}
            </div>
          )}
        </Form>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
