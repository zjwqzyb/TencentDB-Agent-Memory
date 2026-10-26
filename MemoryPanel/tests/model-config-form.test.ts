import { describe, expect, it } from 'vitest';
import { ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions';
import {
  MODEL_PROVIDER_PRESETS,
  buildCreateDraftBody,
  buildUpdateDraftBody,
  formFromConfig,
  isFormDirty,
  requiresKeyReuseConfirmation,
  selectProvider,
  validateModelForm,
  type ExtractionConfig,
  type ModelConfigForm,
} from '../web/src/components/model-config/model';

const configured: ExtractionConfig = {
  configured: true,
  managed: true,
  source: 'panel',
  config_id: 'ext-1',
  provider: 'deepseek',
  protocol: 'openai-chat',
  base_url: 'https://api.deepseek.com',
  api_key_configured: true,
  api_key_masked: '••••••••',
  model_id: 'deepseek-chat',
  description: 'primary',
  enabled: false,
  version: 3,
  updated_at: '2026-10-26T00:00:00.000Z',
  draft: null,
};

const form = (over: Partial<ModelConfigForm> = {}): ModelConfigForm => ({
  ...formFromConfig(configured),
  ...over,
});

describe('model configuration form model', () => {
  it('publishes the server-supported provider presets', () => {
    expect(MODEL_PROVIDER_PRESETS).toEqual([
      { value: 'deepseek', baseUrl: 'https://api.deepseek.com' },
      { value: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { value: 'openai-compatible', baseUrl: '' },
    ]);
  });

  it('fills a preset only while the current URL is empty or still the previous preset', () => {
    const deepseek = formFromConfig(undefined);
    expect(selectProvider(deepseek, 'glm').baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(selectProvider({ ...deepseek, baseUrl: 'https://custom.example/v1' }, 'glm').baseUrl)
      .toBe('https://custom.example/v1');
    expect(selectProvider({ ...deepseek, baseUrl: 'https://api.deepseek.com' }, 'openai-compatible').baseUrl)
      .toBe('');
  });

  it('requires explicit confirmation before reusing a key across provider or endpoint changes', () => {
    expect(requiresKeyReuseConfirmation(form({ provider: 'glm' }), configured)).toBe(true);
    expect(requiresKeyReuseConfirmation(form({ baseUrl: 'https://proxy.example/v1' }), configured)).toBe(true);
    expect(requiresKeyReuseConfirmation(form({ provider: 'glm', apiKey: 'new-key', replaceKey: true }), configured))
      .toBe(false);
    expect(requiresKeyReuseConfirmation(form({ description: 'notes only' }), configured)).toBe(false);
  });

  it('validates new configs, replacement keys and required reuse confirmation', () => {
    expect(validateModelForm(formFromConfig(undefined), undefined)).toEqual([
      'modelConfig.error.modelRequired',
      'modelConfig.error.keyRequired',
    ]);
    expect(validateModelForm(form({ replaceKey: true, apiKey: '' }), configured)).toContain(
      'modelConfig.error.keyRequired',
    );
    expect(validateModelForm(form({ provider: 'glm', confirmReuseKey: false }), configured)).toContain(
      'modelConfig.error.confirmKeyReuse',
    );
    expect(validateModelForm(form(), configured)).toEqual([]);
  });

  it('builds create and update payloads without leaking a blank key or sending an activation flag', () => {
    const next = form({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      modelId: 'glm-4-plus',
      description: 'draft',
      confirmReuseKey: true,
    });
    expect(buildCreateDraftBody({ ...next, apiKey: 'new-secret', replaceKey: true })).toEqual({
      provider: 'glm',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model_id: 'glm-4-plus',
      description: 'draft',
      api_key: 'new-secret',
    });
    expect(buildUpdateDraftBody(next, configured)).toEqual({
      expected_version: 3,
      provider: 'glm',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model_id: 'glm-4-plus',
      description: 'draft',
      confirm_reuse_api_key: true,
    });
  });

  it('loads and updates a draft-only row without treating deployment as the config identity', () => {
    const draftOnly: ExtractionConfig = {
      ...configured,
      configured: false,
      managed: true,
      source: 'deployment',
      provider: null,
      base_url: '',
      api_key_configured: false,
      api_key_masked: '',
      model_id: null,
      description: '',
      enabled: false,
      draft: {
        configured: true,
        provider: 'glm',
        protocol: 'openai-chat',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        api_key_configured: true,
        model_id: 'glm-4-plus',
        description: 'saved draft',
        updated_at: '2026-10-26T01:00:00.000Z',
      },
    };
    expect(formFromConfig(draftOnly)).toMatchObject({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-4-plus',
      description: 'saved draft',
      apiKey: '',
    });
    expect(validateModelForm(formFromConfig(draftOnly), draftOnly)).toEqual([]);
  });

  it('tracks user edits without treating the masked key as an input value', () => {
    const baseline = formFromConfig(configured);
    expect(baseline.apiKey).toBe('');
    expect(isFormDirty(baseline, configured)).toBe(false);
    expect(isFormDirty(form({ description: 'changed' }), configured)).toBe(true);
    expect(isFormDirty(form({ replaceKey: true }), configured)).toBe(true);
  });

  it('whitelists only the model-config actions required by this ticket', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/extraction/get')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/extraction/create')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/extraction/update')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/extraction/toggle')).toBe(false);
  });
});
