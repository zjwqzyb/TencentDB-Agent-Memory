import type {
  CreateExtractionDraft,
  ExtractionConfig,
  TestConfigBody,
  UpdateExtractionDraft,
  UpstreamProvider,
} from '@/lib/api/instance-upstream';

export type {
  ExtractionConfig,
  ModelTestCapability,
  ModelTestEvent,
  TestConfigBody,
  UpstreamProvider,
} from '@/lib/api/instance-upstream';

export interface ModelConfigForm {
  provider: UpstreamProvider;
  baseUrl: string;
  modelId: string;
  description: string;
  apiKey: string;
  replaceKey: boolean;
  confirmReuseKey: boolean;
}

export type CreateDraftBody = CreateExtractionDraft;
export type UpdateDraftBody = UpdateExtractionDraft;

export const MODEL_PROVIDER_PRESETS = [
  { value: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  { value: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'openai-compatible', baseUrl: '' },
] as const satisfies ReadonlyArray<{ value: UpstreamProvider; baseUrl: string }>;

const DEFAULT_PROVIDER: UpstreamProvider = 'deepseek';

export function presetBaseUrl(provider: UpstreamProvider): string {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.value === provider)?.baseUrl ?? '';
}

export function normalizeBaseUrlInput(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

interface SavedModelConfig {
  provider: UpstreamProvider;
  base_url: string;
  api_key_configured: boolean;
  model_id: string;
  description: string;
}

/** Draft is the editable source when present; otherwise edit the active managed config. */
export function savedModelConfig(config: ExtractionConfig | undefined): SavedModelConfig | undefined {
  if (config?.draft) {
    return {
      provider: config.draft.provider,
      base_url: config.draft.base_url,
      api_key_configured: config.draft.api_key_configured,
      model_id: config.draft.model_id,
      description: config.draft.description,
    };
  }
  if (config?.configured) {
    return {
      provider: config.provider ?? DEFAULT_PROVIDER,
      base_url: config.base_url,
      api_key_configured: config.api_key_configured,
      model_id: config.model_id ?? '',
      description: config.description,
    };
  }
  return undefined;
}

export function formFromConfig(config: ExtractionConfig | undefined): ModelConfigForm {
  const saved = savedModelConfig(config);
  const provider = saved?.provider ?? DEFAULT_PROVIDER;
  return {
    provider,
    baseUrl: saved?.base_url || presetBaseUrl(provider),
    modelId: saved?.model_id ?? '',
    description: saved?.description ?? '',
    apiKey: '',
    replaceKey: false,
    confirmReuseKey: false,
  };
}

/**
 * 切换供应商时的 Base URL 策略。
 *
 * `savedBaseUrl` 是加载表单时服务端回显的地址。只有「用户本次手动改写过的地址」
 * 才需要保留；地址为空、仍等于上一家预设、或仍等于加载时的地址，都视为未改写，
 * 跟随新供应商的预设。否则会出现「切换供应商后 Base URL 不动」的困惑。
 */
export function selectProvider(
  form: ModelConfigForm,
  provider: UpstreamProvider,
  savedBaseUrl?: string,
): ModelConfigForm {
  const previousPreset = normalizeBaseUrlInput(presetBaseUrl(form.provider));
  const nextPreset = presetBaseUrl(provider);
  const currentUrl = normalizeBaseUrlInput(form.baseUrl);
  const initialUrl = normalizeBaseUrlInput(savedBaseUrl ?? '');
  const untouched =
    currentUrl === ''
    || (previousPreset !== '' && currentUrl === previousPreset)
    || (initialUrl !== '' && currentUrl === initialUrl);
  return {
    ...form,
    provider,
    // 未改写 → 跟随新预设（第三方兼容预设为空，等价于要求重新填写）；
    // 已改写 → 保留用户输入。
    baseUrl: untouched ? nextPreset : form.baseUrl,
    confirmReuseKey: false,
  };
}

export function requiresKeyReuseConfirmation(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): boolean {
  const saved = savedModelConfig(config);
  if (!saved?.api_key_configured || form.apiKey.trim()) return false;
  const providerChanged = form.provider !== saved.provider;
  const baseUrlChanged = normalizeBaseUrlInput(form.baseUrl) !== normalizeBaseUrlInput(saved.base_url);
  return providerChanged || baseUrlChanged;
}

function comparableForm(form: ModelConfigForm): Record<string, string | boolean> {
  return {
    provider: form.provider,
    baseUrl: normalizeBaseUrlInput(form.baseUrl),
    modelId: form.modelId.trim(),
    description: form.description.trim(),
    apiKey: form.apiKey,
    replaceKey: form.replaceKey,
    confirmReuseKey: form.confirmReuseKey,
  };
}

export function isFormDirty(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): boolean {
  return JSON.stringify(comparableForm(form)) !== JSON.stringify(comparableForm(formFromConfig(config)));
}

/**
 * Base URL 校验的唯一实现：保存校验与测试按钮共用，避免两处规则漂移。
 * 返回 i18n key；合法时返回 null。
 */
export function baseUrlErrorKey(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'modelConfig.error.baseUrlProtocol';
    }
    if (url.username || url.password || url.search || url.hash) {
      return 'modelConfig.error.baseUrlCredentials';
    }
  } catch {
    return 'modelConfig.error.baseUrlInvalid';
  }
  return null;
}

export function validateModelForm(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): string[] {
  const errors: string[] = [];
  if (!form.modelId.trim()) errors.push('modelConfig.error.modelRequired');
  const urlError = baseUrlErrorKey(form.baseUrl);
  if (urlError) errors.push(urlError);
  const saved = savedModelConfig(config);
  const needsKey = !saved?.api_key_configured || form.replaceKey;
  if (needsKey && !form.apiKey.trim()) errors.push('modelConfig.error.keyRequired');
  if (requiresKeyReuseConfirmation(form, config) && !form.confirmReuseKey) {
    errors.push('modelConfig.error.confirmKeyReuse');
  }
  return errors;
}

export type EnableBlockedReason = 'no-draft' | 'test-required' | 'test-stale' | 'form-dirty' | null;

/**
 * 启用门禁：只有"已保存草稿 + 通过且与当前草稿完全匹配、未过期"的测试证据、
 * 且表单没有未保存改动时才允许启用（启用写入的是服务端草稿，不是表单）。
 */
export function enableBlockedReason(
  config: ExtractionConfig | undefined,
  options: { dirty?: boolean } = {},
): EnableBlockedReason {
  if (!config?.draft) return 'no-draft';
  const test = config.test;
  if (!test) return 'test-required';
  if (!test.passed || !test.matches_current) return 'test-stale';
  if (options.dirty) return 'form-dirty';
  return null;
}

export function canEnableConfig(
  config: ExtractionConfig | undefined,
  options: { dirty?: boolean } = {},
): boolean {
  return Boolean(config?.draft) && enableBlockedReason(config, options) === null;
}

export function buildCreateDraftBody(form: ModelConfigForm): CreateDraftBody {
  return {
    provider: form.provider,
    base_url: normalizeBaseUrlInput(form.baseUrl),
    model_id: form.modelId.trim(),
    description: form.description.trim(),
    api_key: form.apiKey.trim(),
  };
}

export function buildUpdateDraftBody(
  form: ModelConfigForm,
  config: ExtractionConfig,
): UpdateDraftBody {
  const body: UpdateDraftBody = {
    expected_version: config.version,
    provider: form.provider,
    base_url: normalizeBaseUrlInput(form.baseUrl),
    model_id: form.modelId.trim(),
    description: form.description.trim(),
  };
  if (form.replaceKey && form.apiKey.trim()) body.api_key = form.apiKey.trim();
  if (requiresKeyReuseConfirmation(form, config) && form.confirmReuseKey) {
    body.confirm_reuse_api_key = true;
  }
  return body;
}

function hasTestKey(form: ModelConfigForm, config: ExtractionConfig | undefined): boolean {
  const saved = savedModelConfig(config);
  return Boolean(form.apiKey.trim()) || saved?.api_key_configured === true;
}

/**
 * 「测试连接」的表单前置校验：只关心测试能否发起，不要求保存侧的
 * `confirmReuseKey`（测试不落库、不改变密钥归属）。
 */
export function testFormErrors(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): string[] {
  const errors: string[] = [];
  if (!form.modelId.trim()) errors.push('modelConfig.error.modelRequired');
  const urlError = baseUrlErrorKey(form.baseUrl);
  if (urlError) errors.push(urlError);
  if (!hasTestKey(form, config)) errors.push('modelConfig.error.keyRequired');
  return errors;
}

/** 用当前未保存表单发起测试的必要条件；模型 ID、Base URL 与可用密钥缺一不可。 */
export function canRunTest(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): boolean {
  return testFormErrors(form, config).length === 0;
}

/**
 * 构造测试请求体。表单留空 Key 时省略 `api_key`，服务端复用已保存密钥（草稿优先）；
 * `base_version` 始终携带，便于服务端把结果绑定到用户看到的配置版本。
 */
export function buildTestBody(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): TestConfigBody {
  const body: TestConfigBody = {
    provider: form.provider,
    base_url: normalizeBaseUrlInput(form.baseUrl),
    model_id: form.modelId.trim(),
    base_version: config?.version,
  };
  const apiKey = form.apiKey.trim();
  if (apiKey) body.api_key = apiKey;
  return body;
}
