import { ApiError, metaPost, metaPostNdjson } from './base';

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

export interface ExtractionSnapshot {
  snapshot_id: string;
  version: number;
  provider: UpstreamProvider;
  base_url: string;
  api_key_configured: boolean;
  api_key_masked: string;
  model_id: string;
  description: string;
  activated_at: string;
}

export interface ExtractionTestEvidence {
  test_id: string;
  fingerprint: string;
  passed: boolean;
  tested_at: string;
  expires_at: string;
  /** 当前草稿（无草稿时用 active）的连接字段是否仍与该测试完全一致且未过期。 */
  matches_current: boolean;
}

export interface ExtractionConfig {
  configured: boolean;
  managed: boolean;
  /** true = 曾启用过但当前被停用；受管配置不得静默回退部署模型。 */
  paused: boolean;
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
  active_snapshot: ExtractionSnapshot | null;
  test: ExtractionTestEvidence | null;
}

export interface EnableExtractionConfig {
  expected_version: number;
  test_id: string;
}

export interface DisableExtractionConfig {
  expected_version: number;
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

export type ModelTestCapability = 'basic' | 'json' | 'tools';
export type ModelTestResultStatus = 'passed' | 'failed' | 'cancelled';
export type ModelTestDoneStatus = 'completed' | 'failed' | 'cancelled';

export interface ModelTestError {
  code: string;
  message: string;
  http_status?: number;
}

export interface ModelTestStartedEvent {
  type: 'started';
  test_id: string;
  fingerprint: string;
  source: ConfigSource;
  instance_id: string;
  capabilities: ModelTestCapability[];
}

export interface ModelTestResultEvent {
  type: 'result';
  test_id: string;
  capability: ModelTestCapability;
  status: ModelTestResultStatus;
  duration_ms: number;
  error?: ModelTestError;
}

export interface ModelTestDoneEvent {
  type: 'done';
  test_id: string;
  status: ModelTestDoneStatus;
  duration_ms: number;
}

export type ModelTestEvent =
  | ModelTestStartedEvent
  | ModelTestResultEvent
  | ModelTestDoneEvent;

export interface TestConfigBody {
  provider: UpstreamProvider;
  base_url: string;
  model_id: string;
  /** 省略 = 复用服务端已保存的 Key（草稿优先）。 */
  api_key?: string;
  /** 当前用户看到的配置版本，服务端把测试结果绑定到该版本。 */
  base_version?: number;
}

export interface TestConfigOptions {
  signal?: AbortSignal;
  onEvent?: (event: ModelTestEvent) => void;
}

const ACTION = 'instance-upstream/extraction';

const TEST_EVENT_TYPES = new Set(['started', 'result', 'done']);

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function dispatchTestLine(line: string, onEvent?: (event: ModelTestEvent) => void): void {
  if (!onEvent) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // 半行/坏行不应中断其余能力结果；服务端已经按行交付结构化事件。
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !TEST_EVENT_TYPES.has(type)) return;
  onEvent(parsed as ModelTestEvent);
}

export const instanceUpstreamApi = {
  get: (signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/get`, {}, { signal }),
  createDraft: (body: CreateExtractionDraft, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/create`, { ...body, draft: true }, { signal }),
  updateDraft: (body: UpdateExtractionDraft, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/update`, { ...body, draft: true }, { signal }),
  /** 用已通过且未过期的 test_id 原子启用草稿（Core 会复核指纹与版本）。 */
  enable: (body: EnableExtractionConfig, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/enable`, { ...body }, { signal }),
  /** 停用但保留草稿与 active snapshot，进入 paused。 */
  disable: (body: DisableExtractionConfig, signal?: AbortSignal) =>
    metaPost<ExtractionConfig>(`${ACTION}/disable`, { ...body }, { signal }),
  /** 手动把 Core 当前快照（ready/paused/invalid）重新同步到知识服务。 */
  resyncKnowledge: (signal?: AbortSignal) =>
    metaPost<{
      status: string;
      config_id: string | null;
      config_version: number | null;
      outcome: string | null;
    }>(`${ACTION}/resync-knowledge`, {}, { signal }),
  /**
   * 用**当前未保存表单**发起连接测试，逐行回调 NDJSON 事件。
   *
   * - 流开始前的非 2xx（403/400/409）由 `metaPostNdjson` 抛 ApiError；
   * - 取消时抛 AbortError 语义，服务端可能来不及发 `done`，调用方需自行收敛；
   * - 本方法不保存、不启用配置。
   */
  async testConfig(body: TestConfigBody, options: TestConfigOptions = {}): Promise<void> {
    const { signal, onEvent } = options;
    const res = await metaPostNdjson(`${ACTION}/test`, { ...body }, { signal });
    const stream = res.body;
    if (!stream) {
      throw new ApiError(502, 'UPSTREAM_ERROR', 'empty model test stream');
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
    };
    if (signal) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw abortError();
      }
      signal.addEventListener('abort', onAbort);
    }
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) dispatchTestLine(line, onEvent);
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) dispatchTestLine(tail, onEvent);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        /* reader 已取消/已释放时忽略 */
      }
    }
    if (signal?.aborted) throw abortError();
  },
};
