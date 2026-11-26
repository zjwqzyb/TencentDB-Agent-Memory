import { ApiError, request } from '@/lib/api/base';
import { getPanelSession } from '@/lib/panelSession';
import type { CodeGraphResponse } from '@/lib/api/code-graph-contract';

const KNOWLEDGE_BASE = '/api/v1/knowledge';

interface Envelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data: T;
}

function knowledgeHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tdai-Service-Id': session.instanceId,
  };
  if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  return headers;
}

async function postKnowledge<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const envelope = await request<Envelope<T>>(
    'POST',
    `${KNOWLEDGE_BASE}${path}`,
    body,
    knowledgeHeaders(),
    { signal },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message || 'Knowledge request failed', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new ApiError(200, envelope.message || 'Empty knowledge response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data;
}

export type CodeGraphReviewChangeKind =
  'added' | 'modified' | 'deleted' | 'renamed' | 'uncertain' | 'unchanged';

export interface CodeGraphReviewVersionSummary {
  commit: string;
  indexedAt: string;
  branch: string;
  version: number;
}

export interface CodeGraphReviewFileChange {
  kind: CodeGraphReviewChangeKind;
  oldPath?: string;
  newPath?: string;
  evidence: string;
}

export interface CodeGraphReviewSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  nodeId: string;
  indexVersion: string;
  commit: string;
}

export interface CodeGraphReviewSymbolChange {
  kind: CodeGraphReviewChangeKind;
  evidence: string;
  old?: CodeGraphReviewSymbol;
  new?: CodeGraphReviewSymbol;
}

export interface CodeGraphReviewAvailableSides {
  before: CodeGraphReviewVersionSummary | null;
  after: CodeGraphReviewVersionSummary | null;
}

export type CodeGraphReviewCompareResult =
  | {
      state: 'ready';
      before: CodeGraphReviewVersionSummary;
      after: CodeGraphReviewVersionSummary;
      files: CodeGraphReviewFileChange[];
      total: number;
      nextOffset: number | null;
    }
  | {
      state: 'ready';
      file: CodeGraphReviewFileChange;
      changes: CodeGraphReviewSymbolChange[];
      truncated: boolean;
    }
  | {
      state: 'unavailable';
      reason?: string;
      before?: string;
      after?: string;
      available?: CodeGraphReviewAvailableSides;
    };

export async function listCodeGraphReviewVersions(
  codeGraphId: string,
  signal?: AbortSignal,
): Promise<CodeGraphReviewVersionSummary[]> {
  const data = await postKnowledge<{ items: CodeGraphReviewVersionSummary[] }>(
    '/code-graph/reviews/list',
    { code_graph_id: codeGraphId },
    signal,
  );
  return data.items ?? [];
}

export async function compareCodeGraphReviewFiles(
  codeGraphId: string,
  before: string,
  after: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<CodeGraphReviewCompareResult> {
  return postKnowledge<CodeGraphReviewCompareResult>(
    '/code-graph/reviews/compare',
    { code_graph_id: codeGraphId, before, after, offset },
    signal,
  );
}

export async function compareCodeGraphReviewFile(
  codeGraphId: string,
  before: string,
  after: string,
  file: CodeGraphReviewFileChange,
  signal?: AbortSignal,
): Promise<CodeGraphReviewCompareResult> {
  return postKnowledge<CodeGraphReviewCompareResult>(
    '/code-graph/reviews/compare',
    {
      code_graph_id: codeGraphId,
      before,
      after,
      oldPath: file.oldPath,
      newPath: file.newPath,
    },
    signal,
  );
}

export async function searchCodeGraphReviewSymbols(
  codeGraphId: string,
  commit: string,
  query: string,
  signal?: AbortSignal,
): Promise<CodeGraphResponse> {
  return postKnowledge<CodeGraphResponse>(
    '/code-graph/graph-search',
    {
      code_graph_id: codeGraphId,
      commit,
      query,
      limit: 20,
    },
    signal,
  );
}

export async function loadCodeGraphReviewSource(
  codeGraphId: string,
  symbol: {
    nodeId: string;
    indexVersion: string;
    commit: string;
    line: number;
  },
  signal?: AbortSignal,
): Promise<CodeGraphResponse> {
  return postKnowledge<CodeGraphResponse>(
    '/code-graph/graph-source',
    {
      code_graph_id: codeGraphId,
      nodeId: symbol.nodeId,
      indexVersion: symbol.indexVersion,
      commit: symbol.commit,
      sourceLine: symbol.line,
    },
    signal,
  );
}

export async function loadCodeGraphReviewImpact(
  codeGraphId: string,
  symbol: {
    nodeId: string;
    indexVersion: string;
    commit: string;
  },
  signal?: AbortSignal,
): Promise<CodeGraphResponse> {
  return postKnowledge<CodeGraphResponse>(
    '/code-graph/graph',
    {
      code_graph_id: codeGraphId,
      mode: 'impact',
      nodeId: symbol.nodeId,
      indexVersion: symbol.indexVersion,
      commit: symbol.commit,
      direction: 'in',
      depth: 2,
      limit: 200,
      edgeLimit: 300,
    },
    signal,
  );
}
