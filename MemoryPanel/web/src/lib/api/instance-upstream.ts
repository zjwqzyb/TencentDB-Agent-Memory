import { metaPost } from './base';

export type UpstreamProvider = 'glm' | 'deepseek' | 'openai-compatible';
export type ConfigSource = 'deployment' | 'panel';

export interface ExtractionDraft {
  configured: true;
  provider: UpstreamProvider;
  protocol: 'openai-chat';
  base_url: string;
  api_key_configured: boolean;
  model_id: string;
  description: string;
  updated_at: string;
}

export interface ExtractionConfig {
  configured: boolean;
  managed: boolean;
  source: ConfigSource;
  config_id: string | null;
  provider: UpstreamProvider | null;
  protocol: 'openai-chat';
  base_url: string;
  api_key_configured: boolean;
  api_key_masked: string;
  model_id: string | null;
  description: string;
  enabled: boolean | null;
  version: number;
  updated_at: string | null;
  draft: ExtractionDraft | null;
}

export interface CreateExtractionDraft {
  provider: UpstreamProvider;
  base_url: string;
  model_id: string;
  description: string;
  api_key: string;
}

export interface UpdateExtractionDraft {
  expected_version: number;
  provider: UpstreamProvider;
  base_url: string;
  model_id: string;
  description: string;
  api_key?: string;
  confirm_reuse_api_key?: boolean;
}

const ACTION = 'instance-upstream/extraction';

export const instanceUpstreamApi = {
  get: (signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/get`, {}, { signal }),
  createDraft: (body: CreateExtractionDraft, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/create`, { ...body, draft: true }, { signal }),
  updateDraft: (body: UpdateExtractionDraft, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/update`, { ...body, draft: true }, { signal }),
};
