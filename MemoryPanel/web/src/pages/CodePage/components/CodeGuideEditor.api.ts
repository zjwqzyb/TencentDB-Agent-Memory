import { getPanelSession } from '@/lib/panelSession';

const BASE = '/api/v1/knowledge/code-graph/guides';

interface GuideEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T | null;
}

export class CodeGuideApiError extends Error {
  status: number;
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(status: number, code: number, message: string, requestId = '') {
    super(message || 'Code guide request failed');
    this.name = 'CodeGuideApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

export type CodeGuideStatus = 'candidate' | 'published' | 'withdrawn';
export type CodeGuideOrigin = 'curated_template' | 'indexed_symbol_search' | 'editor';
export type CodeGuideOperation = 'generate' | 'save' | 'publish' | 'withdraw';
export type CodeGuideStepKind = 'source' | 'branch' | 'async' | 'parallel' | 'unknown' | 'reading';

export interface CodeGuideAnchor {
  nodeId: string;
  filePath: string;
  line: number;
  label: string;
  contentHash: string;
  assetId?: string;
  indexVersion?: string;
  commit?: string;
  edgeId?: string;
}

export interface CodeGuideStep {
  id: string;
  title: string;
  description: string;
  kind: CodeGuideStepKind;
  anchors: CodeGuideAnchor[];
}

export interface CodeGuideRelation {
  from: string;
  to: string;
  kind: 'sequence' | 'branch' | 'async' | 'parallel' | 'unknown';
  label: string;
  fromAnchor: number;
  toAnchor: number;
}

export interface GuideEdition {
  id: string;
  revision: number;
  status: CodeGuideStatus;
  title: string;
  topic: string;
  commit: string;
  indexVersion: string;
  steps: CodeGuideStep[];
  relations?: CodeGuideRelation[];
  sourceAssets?: string[];
  actor?: string;
  updatedAt?: string;
  origin?: CodeGuideOrigin;
  operation?: CodeGuideOperation;
  stale?: boolean;
  staleReferences?: Array<{ stepId: string; anchor: number }>;
}

export interface GuideFeedback {
  revision: number;
  stepId: string;
  actor: string;
  message: string;
  createdAt: string;
}

export interface GuideHistoryResult {
  items: GuideEdition[];
  feedback: GuideFeedback[];
}

async function postGuide<T>(
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }

  const response = await fetch(`${BASE}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let envelope: GuideEnvelope<T>;
  try {
    envelope = JSON.parse(text) as GuideEnvelope<T>;
  } catch {
    throw new CodeGuideApiError(
      response.status || 500,
      response.status || 500,
      text || response.statusText || 'Code guide request failed',
    );
  }

  if (!response.ok || envelope.code !== 0) {
    throw new CodeGuideApiError(
      response.status,
      envelope.code ?? response.status,
      envelope.message || response.statusText || 'Code guide request failed',
      envelope.request_id,
    );
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new CodeGuideApiError(
      response.status,
      envelope.code ?? 0,
      envelope.message || 'Empty code guide response',
      envelope.request_id,
    );
  }
  return envelope.data;
}

function toDocument(guide: GuideEdition) {
  return {
    id: guide.id,
    title: guide.title,
    topic: guide.topic,
    commit: guide.commit,
    indexVersion: guide.indexVersion,
    steps: guide.steps,
    ...(guide.relations ? { relations: guide.relations } : {}),
  };
}

export function isCodeGuidePermissionError(error: unknown): boolean {
  return error instanceof CodeGuideApiError && (error.status === 403 || error.code === 403);
}

export const codeGuideApi = {
  listEditor: (assetId: string, signal?: AbortSignal): Promise<GuideEdition[]> =>
    postGuide<{ items?: GuideEdition[] }>('editor', { code_graph_id: assetId }, signal).then(
      (data) => data.items ?? [],
    ),

  listPublished: (assetId: string, signal?: AbortSignal): Promise<GuideEdition[]> =>
    postGuide<{ items?: GuideEdition[] }>('list', { code_graph_id: assetId }, signal).then(
      (data) => data.items ?? [],
    ),

  get: (assetId: string, guideId: string, signal?: AbortSignal): Promise<GuideEdition> =>
    postGuide<GuideEdition>('get', { code_graph_id: assetId, id: guideId }, signal),

  history: (assetId: string, guideId: string, signal?: AbortSignal): Promise<GuideHistoryResult> =>
    postGuide<GuideHistoryResult>('history', { code_graph_id: assetId, id: guideId }, signal),

  generate: (
    assetId: string,
    guideId: string,
    revision: number,
    query?: string,
    signal?: AbortSignal,
  ): Promise<GuideEdition> =>
    postGuide<GuideEdition>(
      'generate',
      {
        code_graph_id: assetId,
        id: guideId,
        revision,
        ...(query === undefined ? {} : { query }),
      },
      signal,
    ),

  save: (
    assetId: string,
    guide: GuideEdition,
    revision: number,
    signal?: AbortSignal,
  ): Promise<GuideEdition> =>
    postGuide<GuideEdition>(
      'save',
      {
        code_graph_id: assetId,
        id: guide.id,
        revision,
        document: toDocument(guide),
      },
      signal,
    ),

  publish: (assetId: string, guideId: string, revision: number): Promise<GuideEdition> =>
    postGuide<GuideEdition>('publish', {
      code_graph_id: assetId,
      id: guideId,
      revision,
    }),

  withdraw: (assetId: string, guideId: string, revision: number): Promise<GuideEdition> =>
    postGuide<GuideEdition>('withdraw', {
      code_graph_id: assetId,
      id: guideId,
      revision,
    }),

  feedback: (
    assetId: string,
    guideId: string,
    revision: number,
    stepId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ recorded: boolean }> =>
    postGuide<{ recorded: boolean }>(
      'feedback',
      {
        code_graph_id: assetId,
        id: guideId,
        revision,
        stepId,
        message,
      },
      signal,
    ),
};
