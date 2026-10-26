import type {
  CreateExtractionDraft,
  ExtractionConfig,
  UpdateExtractionDraft,
  UpstreamProvider,
} from '@/lib/api/instance-upstream';

export type { ExtractionConfig, UpstreamProvider } from '@/lib/api/instance-upstream';

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

export function selectProvider(form: ModelConfigForm, provider: UpstreamProvider): ModelConfigForm {
  const previousPreset = presetBaseUrl(form.provider);
  const nextPreset = presetBaseUrl(provider);
  const currentUrl = normalizeBaseUrlInput(form.baseUrl);
  const shouldApplyPreset = currentUrl === '' || currentUrl === normalizeBaseUrlInput(previousPreset);
  return {
    ...form,
    provider,
    baseUrl: shouldApplyPreset ? nextPreset : form.baseUrl,
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

export function validateModelForm(
  form: ModelConfigForm,
  config: ExtractionConfig | undefined,
): string[] {
  const errors: string[] = [];
  if (!form.modelId.trim()) errors.push('modelConfig.error.modelRequired');
  try {
    const url = new URL(form.baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('modelConfig.error.baseUrlProtocol');
    }
    if (url.username || url.password || url.search || url.hash) {
      errors.push('modelConfig.error.baseUrlCredentials');
    }
  } catch {
    errors.push('modelConfig.error.baseUrlInvalid');
  }
  const saved = savedModelConfig(config);
  const needsKey = !saved?.api_key_configured || form.replaceKey;
  if (needsKey && !form.apiKey.trim()) errors.push('modelConfig.error.keyRequired');
  if (requiresKeyReuseConfirmation(form, config) && !form.confirmReuseKey) {
    errors.push('modelConfig.error.confirmKeyReuse');
  }
  return errors;
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
