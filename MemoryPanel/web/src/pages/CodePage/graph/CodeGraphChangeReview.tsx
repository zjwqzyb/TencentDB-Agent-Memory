import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip } from 'tea-component';
import type { CodeGraphDetail } from '@/lib/api/knowledge-api';
import type { CodeGraphNode, CodeGraphResponse } from '@/lib/api/code-graph-contract';
import {
  compareCodeGraphReviewFile,
  compareCodeGraphReviewFiles,
  listCodeGraphReviewVersions,
  loadCodeGraphReviewImpact,
  loadCodeGraphReviewSource,
  searchCodeGraphReviewSymbols,
  type CodeGraphReviewAvailableSides,
  type CodeGraphReviewChangeKind,
  type CodeGraphReviewFileChange,
  type CodeGraphReviewSymbol,
  type CodeGraphReviewSymbolChange,
  type CodeGraphReviewVersionSummary,
} from './CodeGraphChangeReview.api';
import './CodeGraphChangeReview.css';

type SideKey = 'before' | 'after';

interface SideSymbol {
  key: SideKey;
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  indexVersion: string;
  commit: string;
}

interface SelectedSymbolPair {
  title: string;
  before?: SideSymbol;
  after?: SideSymbol;
}

interface SideDetails {
  source: CodeGraphResponse | null;
  impact: CodeGraphResponse | null;
  sourceError: string | null;
  impactError: string | null;
}

interface ImpactPathRow {
  nodeId: string;
  nodeIds: string[];
  edgeIds: string[];
  names: string[];
  depth?: number;
  relation: 'direct' | 'indirect' | 'unknown';
}

interface InitialCommitIssue {
  side: SideKey;
  requested: string;
  status: 'unavailable' | 'ambiguous';
  matchCount: number;
}

interface InitialCommitResolution {
  status: 'unspecified' | 'ready' | 'unavailable' | 'ambiguous';
  commit?: string;
  matchCount: number;
}

interface EvidenceSelection {
  sideKey: SideKey;
  edgeId: string;
  evidenceIndex: number;
  filePath: string;
  line: number;
}

interface PageCompareResult {
  state: 'ready';
  before: CodeGraphReviewVersionSummary;
  after: CodeGraphReviewVersionSummary;
  files: CodeGraphReviewFileChange[];
  total: number;
  nextOffset: number | null;
}

interface FileCompareResult {
  state: 'ready';
  file: CodeGraphReviewFileChange;
  changes: CodeGraphReviewSymbolChange[];
  truncated: boolean;
}

interface UnavailableCompareResult {
  state: 'unavailable';
  reason?: string;
  before?: string;
  after?: string;
  available?: CodeGraphReviewAvailableSides;
}

const TEXT = {
  'zh-CN': {
    title: '历史双版本变更审查',
    subtitle: '选择两个固定提交，比较文件与符号，并查看两侧同版本源码和潜在影响。',
    before: '基准提交',
    after: '目标提交',
    compare: '比较版本',
    backToFiles: '返回文件列表',
    versionsLoading: '正在加载历史快照…',
    versionsError: '历史快照加载失败，请重试。',
    initialUnavailable: '指定的{{side}}提交不在历史快照中：{{value}}。请从列表中选择可用提交。',
    initialAmbiguous:
      '指定的{{side}}提交前缀有歧义：{{value}}。匹配到 {{count}} 个快照，请使用完整 40 位 SHA。',
    invalidCommitOption: '指定提交不可用',
    compareLoading: '正在比较双版本…',
    compareError: '双版本比较失败，请重试。',
    noVersions: '当前仓库暂无可用的历史快照。',
    needTwoVersions: '请选择两个不同的提交。',
    unavailable: '双版本比较暂不可用',
    availableSide: '可读一侧',
    missingSide: '此侧快照不可用',
    singleSearch: '单侧符号搜索',
    singleSearchHint: '在可读一侧按固定提交搜索符号，并独立查看源码与影响。',
    search: '搜索符号',
    searchPlaceholder: '函数名或类名',
    searchLoading: '正在搜索符号…',
    searchError: '符号搜索失败，请重试。',
    noSearchResults: '当前提交内没有匹配符号。',
    files: '变更文件',
    symbols: '文件内符号变更',
    change: '变更',
    path: '路径',
    evidence: '证据',
    action: '操作',
    selectFile: '查看符号',
    selectSymbol: '查看源码与影响',
    all: '全部',
    added: '新增',
    modified: '修改',
    deleted: '删除',
    renamed: '重命名',
    uncertain: '不确定',
    unchanged: '未变',
    noFiles: '当前筛选条件下没有变更文件。',
    noSymbols: '当前筛选条件下没有符号变更。',
    truncated: '结果已截断，仅显示索引返回的部分内容。',
    page: '第 {{page}} 页 · 共 {{total}} 个文件',
    previous: '上一页',
    next: '下一页',
    source: '同版本源码',
    impact: '潜在影响',
    sourceUnavailable: '源码暂不可用',
    impactUnavailable: '影响分析暂不可用',
    impactUnsupported: '影响分析不支持此符号或语言',
    impactEmpty: '未找到影响路径',
    impactPartial: '部分结果',
    impactTruncated: '结果已截断',
    impactDirect: '直接',
    impactIndirect: '间接',
    impactUnknown: '距离未知',
    impactDirection: '路径方向：影响节点 → 当前符号',
    impactWarnings: '范围提示',
    edgeEvidence: '边证据',
    evidenceSource: '证据源码',
    viewEvidenceSource: '查看源码',
    evidenceMissing: '此边缺少源码位置',
    impactSummary: '{{symbols}} 个潜在影响符号 · {{edges}} 条关系',
    impactPath: '证据路径',
    missingSymbol: '此侧没有匹配符号',
    detailsLoading: '正在加载源码与影响…',
    detailsError: '源码或影响加载失败。',
    commit: '提交',
    branch: '分支',
    index: '索引',
    indexedAt: '索引时间',
    location: '位置',
    symbol: '符号',
    kind: '类型',
    depth: '距离',
    emptySource: '此侧源码为空。',
    beforeSide: '基准',
    afterSide: '目标',
  },
  'en-US': {
    title: 'Historical two-commit change review',
    subtitle:
      'Choose two fixed commits, compare files and symbols, then inspect same-version source and impact on both sides.',
    before: 'Base commit',
    after: 'Target commit',
    compare: 'Compare commits',
    backToFiles: 'Back to files',
    versionsLoading: 'Loading historical snapshots…',
    versionsError: 'Failed to load historical snapshots. Please retry.',
    initialUnavailable:
      'The specified {{side}} commit is not in the historical snapshots: {{value}}. Select an available commit.',
    initialAmbiguous:
      'The specified {{side}} commit prefix is ambiguous: {{value}}. It matches {{count}} snapshots. Use the full 40-character SHA.',
    invalidCommitOption: 'Specified commit unavailable',
    compareLoading: 'Comparing commits…',
    compareError: 'Failed to compare commits. Please retry.',
    noVersions: 'No historical snapshots are available for this repository.',
    needTwoVersions: 'Select two different commits.',
    unavailable: 'Two-commit comparison is unavailable',
    availableSide: 'Readable side',
    missingSide: 'Snapshot unavailable on this side',
    singleSearch: 'Single-side symbol search',
    singleSearchHint:
      'Search symbols on the readable side at its fixed commit, then inspect source and impact independently.',
    search: 'Search symbols',
    searchPlaceholder: 'Function or class name',
    searchLoading: 'Searching symbols…',
    searchError: 'Symbol search failed. Please retry.',
    noSearchResults: 'No matching symbols in this commit.',
    files: 'Changed files',
    symbols: 'Symbol changes in file',
    change: 'Change',
    path: 'Path',
    evidence: 'Evidence',
    action: 'Action',
    selectFile: 'Inspect symbols',
    selectSymbol: 'Inspect source and impact',
    all: 'All',
    added: 'Added',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed',
    uncertain: 'Uncertain',
    unchanged: 'Unchanged',
    noFiles: 'No changed files match the current filter.',
    noSymbols: 'No symbol changes match the current filter.',
    truncated: 'Results are truncated to the portion returned by the index.',
    page: 'Page {{page}} · {{total}} files',
    previous: 'Previous',
    next: 'Next',
    source: 'Same-version source',
    impact: 'Potential impact',
    sourceUnavailable: 'Source unavailable',
    impactUnavailable: 'Impact unavailable',
    impactUnsupported: 'Impact analysis does not support this symbol or language',
    impactEmpty: 'No impact paths found',
    impactPartial: 'Partial results',
    impactTruncated: 'Results truncated',
    impactDirect: 'Direct',
    impactIndirect: 'Indirect',
    impactUnknown: 'Unknown distance',
    impactDirection: 'Path direction: impacted node → selected symbol',
    impactWarnings: 'Scope notes',
    edgeEvidence: 'Edge evidence',
    evidenceSource: 'Evidence source',
    viewEvidenceSource: 'View source',
    evidenceMissing: 'This edge has no source location',
    impactSummary: '{{symbols}} potentially impacted symbols · {{edges}} relations',
    impactPath: 'Evidence path',
    missingSymbol: 'No matching symbol on this side',
    detailsLoading: 'Loading source and impact…',
    detailsError: 'Failed to load source or impact.',
    commit: 'Commit',
    branch: 'Branch',
    index: 'Index',
    indexedAt: 'Indexed at',
    location: 'Location',
    symbol: 'Symbol',
    kind: 'Kind',
    depth: 'Depth',
    emptySource: 'Source is empty on this side.',
    beforeSide: 'Base',
    afterSide: 'Target',
  },
} as const;

const PAGE_SIZE = 100;

function shortCommit(commit: string | undefined | null): string {
  return commit ? commit.slice(0, 10) : '-';
}

function formatTime(value: string | undefined | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function symbolLocation(symbol: SideSymbol): string {
  return `${symbol.filePath}:${symbol.line}-${symbol.endLine}`;
}

function toSideSymbol(symbol: CodeGraphReviewSymbol, key: SideKey): SideSymbol {
  return {
    key,
    nodeId: symbol.nodeId,
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    line: symbol.line,
    endLine: symbol.endLine,
    indexVersion: symbol.indexVersion,
    commit: symbol.commit,
  };
}

function nodeToSideSymbol(
  node: CodeGraphNode,
  key: SideKey,
  commit: string,
  indexVersion: string,
): SideSymbol {
  return {
    key,
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    filePath: node.filePath,
    line: node.startLine,
    endLine: node.endLine,
    indexVersion,
    commit,
  };
}

function impactRows(data: CodeGraphResponse): ImpactPathRow[] {
  const lookup = new Map(data.nodes.map((node) => [node.id, node]));
  return (data.impactPaths ?? []).map((path) => {
    const depth = lookup.get(path.nodeId)?.depth ?? path.edgeIds.length;
    return {
      nodeId: path.nodeId,
      nodeIds: path.nodeIds,
      edgeIds: path.edgeIds,
      names: path.nodeIds.map((id) => lookup.get(id)?.name ?? id),
      depth,
      relation:
        depth === 1
          ? ('direct' as const)
          : depth > 1
            ? ('indirect' as const)
            : ('unknown' as const),
    };
  });
}

function resolveInitialCommit(
  versions: CodeGraphReviewVersionSummary[],
  requested: string | null | undefined,
): InitialCommitResolution {
  const value = requested?.trim().toLowerCase() ?? '';
  if (!value) return { status: 'unspecified', matchCount: 0 };
  const exact = versions.find((version) => version.commit === value);
  if (exact) return { status: 'ready', commit: exact.commit, matchCount: 1 };
  const prefixMatches = versions.filter((version) => version.commit.startsWith(value));
  if (prefixMatches.length === 1)
    return { status: 'ready', commit: prefixMatches[0].commit, matchCount: 1 };
  return {
    status: prefixMatches.length > 1 ? 'ambiguous' : 'unavailable',
    matchCount: prefixMatches.length,
  };
}

export function CodeGraphChangeReview({
  asset,
  initialBefore,
  initialAfter,
  className,
}: {
  asset: CodeGraphDetail;
  initialBefore?: string | null;
  initialAfter?: string | null;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const L = TEXT[language];

  const [versions, setVersions] = useState<CodeGraphReviewVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsError, setVersionsError] = useState('');
  const [beforeCommit, setBeforeCommit] = useState('');
  const [afterCommit, setAfterCommit] = useState('');
  const [initialIssues, setInitialIssues] = useState<InitialCommitIssue[]>([]);
  const [pageResult, setPageResult] = useState<PageCompareResult | null>(null);
  const [fileResult, setFileResult] = useState<FileCompareResult | null>(null);
  const [unavailableResult, setUnavailableResult] = useState<UnavailableCompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [pageOffset, setPageOffset] = useState(0);
  const [fileFilter, setFileFilter] = useState<CodeGraphReviewChangeKind | 'all'>('all');
  const [symbolFilter, setSymbolFilter] = useState<CodeGraphReviewChangeKind | 'all'>('all');
  const [selectedSymbol, setSelectedSymbol] = useState<SelectedSymbolPair | null>(null);
  const [sideResults, setSideResults] = useState<Partial<Record<SideKey, SideDetails>>>({});
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CodeGraphResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchSideKey, setSearchSideKey] = useState<SideKey>('before');
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection | null>(null);
  const [evidenceSource, setEvidenceSource] = useState<CodeGraphResponse | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');

  const versionsController = useRef<AbortController | null>(null);
  const compareController = useRef<AbortController | null>(null);
  const detailsController = useRef<AbortController | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const evidenceController = useRef<AbortController | null>(null);
  const autoCompared = useRef(false);

  const availableSides = useMemo(() => {
    const available = unavailableResult?.available;
    if (available) {
      return (['before', 'after'] as const).flatMap((key) =>
        available[key] ? [{ key, version: available[key]! }] : [],
      );
    }
    if (initialIssues.length > 0) {
      return (['before', 'after'] as const).flatMap((key) => {
        const commit = key === 'before' ? beforeCommit : afterCommit;
        const version = versions.find((item) => item.commit === commit);
        return version ? [{ key, version }] : [];
      });
    }
    if (versions.length === 1) return [{ key: 'before' as const, version: versions[0] }];
    return [];
  }, [afterCommit, beforeCommit, initialIssues, unavailableResult, versions]);

  const singleSide = useMemo(
    () => availableSides.find((side) => side.key === searchSideKey) ?? availableSides[0] ?? null,
    [availableSides, searchSideKey],
  );

  const resetEvidence = useCallback(() => {
    evidenceController.current?.abort();
    setEvidenceSelection(null);
    setEvidenceSource(null);
    setEvidenceLoading(false);
    setEvidenceError('');
  }, []);

  const resetSelection = useCallback(() => {
    detailsController.current?.abort();
    setSelectedSymbol(null);
    setSideResults({});
    setDetailsLoading(false);
    setDetailsError('');
    resetEvidence();
  }, [resetEvidence]);

  const resetSearch = useCallback(() => {
    searchController.current?.abort();
    setSearchLoading(false);
    setSearchQuery('');
    setSearchResults(null);
    setSearchError('');
  }, []);

  const resetReviewData = useCallback(() => {
    compareController.current?.abort();
    setCompareLoading(false);
    setPageResult(null);
    setFileResult(null);
    setUnavailableResult(null);
    setCompareError('');
    setPageOffset(0);
    setFileFilter('all');
    setSymbolFilter('all');
    resetSelection();
    resetSearch();
  }, [resetSearch, resetSelection]);

  const loadVersions = useCallback(async () => {
    versionsController.current?.abort();
    const controller = new AbortController();
    versionsController.current = controller;
    setVersionsLoading(true);
    setVersionsError('');
    setInitialIssues([]);
    try {
      const items = await listCodeGraphReviewVersions(asset.code_graph_id, controller.signal);
      if (controller.signal.aborted) return;
      setVersions(items);
      const before = resolveInitialCommit(items, initialBefore);
      const after = resolveInitialCommit(items, initialAfter);
      const issues: InitialCommitIssue[] = [];
      if (before.status === 'unavailable' || before.status === 'ambiguous') {
        issues.push({
          side: 'before',
          requested: initialBefore?.trim() ?? '',
          status: before.status,
          matchCount: before.matchCount,
        });
      }
      if (after.status === 'unavailable' || after.status === 'ambiguous') {
        issues.push({
          side: 'after',
          requested: initialAfter?.trim() ?? '',
          status: after.status,
          matchCount: after.matchCount,
        });
      }
      setInitialIssues(issues);
      const preferredAfter =
        after.status === 'ready'
          ? after.commit!
          : after.status === 'unspecified'
            ? (items[0]?.commit ?? '')
            : '';
      const preferredBefore =
        before.status === 'ready'
          ? before.commit!
          : before.status === 'unspecified'
            ? (items.find((version) => version.commit !== preferredAfter)?.commit ??
              items[0]?.commit ??
              '')
            : '';
      const nextBefore =
        before.status === 'ready'
          ? before.commit!
          : before.status === 'unspecified'
            ? preferredBefore
            : '';
      const nextAfter =
        after.status === 'ready'
          ? after.commit!
          : after.status === 'unspecified'
            ? (items.find((version) => version.commit !== nextBefore)?.commit ?? preferredAfter)
            : '';
      setBeforeCommit(nextBefore);
      setAfterCommit(nextAfter);
    } catch (error) {
      if (controller.signal.aborted) return;
      setVersionsError(
        error instanceof Error ? error.message : 'Failed to load historical snapshots.',
      );
    } finally {
      if (!controller.signal.aborted) setVersionsLoading(false);
    }
  }, [asset.code_graph_id, initialAfter, initialBefore]);

  useEffect(() => {
    autoCompared.current = false;
    setInitialIssues([]);
    setSearchSideKey('before');
    resetReviewData();
    void loadVersions();
    return () => {
      versionsController.current?.abort();
      compareController.current?.abort();
      detailsController.current?.abort();
      searchController.current?.abort();
      evidenceController.current?.abort();
    };
  }, [asset.code_graph_id, loadVersions, resetReviewData]);

  const loadCompare = useCallback(
    async (offset: number) => {
      if (!beforeCommit || !afterCommit || beforeCommit === afterCommit) {
        setCompareError(L.needTwoVersions);
        return;
      }
      compareController.current?.abort();
      const controller = new AbortController();
      compareController.current = controller;
      setCompareLoading(true);
      setCompareError('');
      setFileResult(null);
      setUnavailableResult(null);
      setPageResult(null);
      resetSearch();
      resetSelection();
      try {
        const result = await compareCodeGraphReviewFiles(
          asset.code_graph_id,
          beforeCommit,
          afterCommit,
          offset,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.state === 'ready' && 'files' in result) {
          setPageResult(result);
          setPageOffset(offset);
        } else if (result.state === 'ready' && 'file' in result) {
          setFileResult(result);
        } else {
          setUnavailableResult(result);
          setPageResult(null);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setCompareError(error instanceof Error ? error.message : L.compareError);
      } finally {
        if (!controller.signal.aborted) setCompareLoading(false);
      }
    },
    [
      afterCommit,
      asset.code_graph_id,
      beforeCommit,
      L.compareError,
      L.needTwoVersions,
      resetSelection,
      resetSearch,
    ],
  );

  useEffect(() => {
    if (autoCompared.current || versionsLoading || !versions.length) return;
    if (!beforeCommit || !afterCommit || beforeCommit === afterCommit) return;
    autoCompared.current = true;
    void loadCompare(0);
  }, [afterCommit, beforeCommit, loadCompare, versions, versionsLoading]);

  const loadFile = useCallback(
    async (file: CodeGraphReviewFileChange) => {
      if (!beforeCommit || !afterCommit) return;
      compareController.current?.abort();
      const controller = new AbortController();
      compareController.current = controller;
      setCompareLoading(true);
      setCompareError('');
      resetSelection();
      try {
        const result = await compareCodeGraphReviewFile(
          asset.code_graph_id,
          beforeCommit,
          afterCommit,
          file,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.state === 'ready' && 'file' in result) {
          setFileResult(result);
          setUnavailableResult(null);
        } else if (result.state === 'ready' && 'files' in result) {
          setPageResult(result);
          setFileResult(null);
        } else {
          setUnavailableResult(result);
          setFileResult(null);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setCompareError(error instanceof Error ? error.message : L.compareError);
      } finally {
        if (!controller.signal.aborted) setCompareLoading(false);
      }
    },
    [afterCommit, asset.code_graph_id, beforeCommit, L.compareError, resetSelection],
  );

  const loadSymbolDetails = useCallback(
    async (symbol: SelectedSymbolPair) => {
      detailsController.current?.abort();
      const controller = new AbortController();
      detailsController.current = controller;
      setDetailsLoading(true);
      setDetailsError('');
      setSideResults({});
      resetEvidence();
      const sides = (['before', 'after'] as const).filter((key) => symbol[key]);
      try {
        const results = await Promise.all(
          sides.map(async (key) => {
            const target = symbol[key]!;
            const [sourceResult, impactResult] = await Promise.allSettled([
              loadCodeGraphReviewSource(asset.code_graph_id, target, controller.signal),
              loadCodeGraphReviewImpact(asset.code_graph_id, target, controller.signal),
            ]);
            const details: SideDetails = {
              source: sourceResult.status === 'fulfilled' ? sourceResult.value : null,
              impact: impactResult.status === 'fulfilled' ? impactResult.value : null,
              sourceError:
                sourceResult.status === 'rejected'
                  ? sourceResult.reason instanceof Error
                    ? sourceResult.reason.message
                    : L.sourceUnavailable
                  : null,
              impactError:
                impactResult.status === 'rejected'
                  ? impactResult.reason instanceof Error
                    ? impactResult.reason.message
                    : L.impactUnavailable
                  : null,
            };
            return [key, details] as const;
          }),
        );
        if (controller.signal.aborted) return;
        const next: Partial<Record<SideKey, SideDetails>> = {};
        for (const [key, details] of results) next[key] = details;
        setSideResults(next);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDetailsError(error instanceof Error ? error.message : L.detailsError);
      } finally {
        if (!controller.signal.aborted) setDetailsLoading(false);
      }
    },
    [asset.code_graph_id, L.detailsError, L.impactUnavailable, L.sourceUnavailable, resetEvidence],
  );

  const loadEvidenceSource = useCallback(
    async (
      sideKey: SideKey,
      symbol: SideSymbol,
      impact: CodeGraphResponse,
      edgeId: string,
      evidenceIndex: number,
    ) => {
      const edge = impact.edges.find((item) => item.id === edgeId);
      const evidence = edge?.evidence[evidenceIndex];
      if (!edge || !evidence) {
        setEvidenceError(L.evidenceMissing);
        return;
      }
      evidenceController.current?.abort();
      const controller = new AbortController();
      evidenceController.current = controller;
      setEvidenceSelection({
        sideKey,
        edgeId,
        evidenceIndex,
        filePath: evidence.filePath,
        line: evidence.line,
      });
      setEvidenceLoading(true);
      setEvidenceError('');
      setEvidenceSource(null);
      try {
        const result = await loadCodeGraphReviewSource(
          asset.code_graph_id,
          {
            nodeId: edge.source,
            indexVersion: impact.indexVersion ?? symbol.indexVersion,
            commit: impact.commit ?? symbol.commit,
            line: evidence.line,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setEvidenceSource(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        setEvidenceError(error instanceof Error ? error.message : L.sourceUnavailable);
      } finally {
        if (!controller.signal.aborted) setEvidenceLoading(false);
      }
    },
    [asset.code_graph_id, L.evidenceMissing, L.sourceUnavailable],
  );

  const selectSymbolChange = useCallback(
    (change: CodeGraphReviewSymbolChange) => {
      const pair: SelectedSymbolPair = {
        title: change.old?.name ?? change.new?.name ?? '',
      };
      if (change.old) pair.before = toSideSymbol(change.old, 'before');
      if (change.new) pair.after = toSideSymbol(change.new, 'after');
      if (!pair.before && !pair.after) return;
      setSelectedSymbol(pair);
      void loadSymbolDetails(pair);
    },
    [loadSymbolDetails],
  );

  const submitSearch = useCallback(async () => {
    if (!singleSide || !searchQuery.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchLoading(true);
    setSearchError('');
    setSearchResults(null);
    resetSelection();
    try {
      const result = await searchCodeGraphReviewSymbols(
        asset.code_graph_id,
        singleSide.version.commit,
        searchQuery.trim(),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSearchResults(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSearchError(error instanceof Error ? error.message : L.searchError);
    } finally {
      if (!controller.signal.aborted) setSearchLoading(false);
    }
  }, [asset.code_graph_id, L.searchError, resetSelection, searchQuery, singleSide]);

  const selectSearchSymbol = useCallback(
    (node: CodeGraphNode) => {
      if (!singleSide || !searchResults?.indexVersion) return;
      const symbol = nodeToSideSymbol(
        node,
        singleSide.key,
        singleSide.version.commit,
        searchResults.indexVersion,
      );
      const pair: SelectedSymbolPair = { title: node.name };
      if (singleSide.key === 'before') pair.before = symbol;
      else pair.after = symbol;
      setSelectedSymbol(pair);
      void loadSymbolDetails(pair);
    },
    [loadSymbolDetails, searchResults, singleSide],
  );

  const changeSearchSide = useCallback(
    (key: SideKey) => {
      if (singleSide?.key === key) return;
      resetSearch();
      setSearchSideKey(key);
    },
    [resetSearch, singleSide?.key],
  );

  const filteredFiles = useMemo(
    () =>
      pageResult?.files.filter((file) => fileFilter === 'all' || file.kind === fileFilter) ?? [],
    [fileFilter, pageResult],
  );
  const filteredSymbols = useMemo(
    () =>
      fileResult?.changes.filter(
        (change) => symbolFilter === 'all' || change.kind === symbolFilter,
      ) ?? [],
    [fileResult, symbolFilter],
  );

  const page = Math.floor(pageOffset / PAGE_SIZE) + 1;
  const canPrevious = pageOffset > 0;
  const canNext = !!pageResult?.nextOffset;

  const changeLabel = (kind: CodeGraphReviewChangeKind | 'all') =>
    kind === 'all' ? L.all : L[kind];

  const evidenceDescription = (evidence: string) => {
    if (evidence.startsWith('git_similarity_')) {
      const score = Number(evidence.slice('git_similarity_'.length));
      return language === 'zh-CN'
        ? `Git 判断两份内容相似度为 ${score}%，可能是一次重命名，请核对两侧路径。`
        : `Git considers the two files ${score}% similar. This may be a rename. Check both paths.`;
    }
    const descriptions: Record<string, [string, string]> = {
      path_absent_from_old_git_tree: [
        '路径不在基准 Git 树中，目标提交新增了该文件。',
        'The path is absent from the base Git tree. The target commit adds the file.',
      ],
      path_absent_from_new_git_tree: [
        '路径不在目标 Git 树中，基准提交之后删除了该文件。',
        'The path is absent from the target Git tree. The file was deleted after the base commit.',
      ],
      same_path_different_git_blob: [
        '同一路径在两个 Git 树中指向不同内容，文件被修改。',
        'The same path points to different Git blobs in the two trees. The file was modified.',
      ],
      unique_identical_git_blob: [
        '两侧各只有一个内容完全相同的 Git blob，支持重命名判断。',
        'Each side has exactly one identical Git blob. This supports a rename match.',
      ],
      path_removed_ambiguous_identical_blobs: [
        '删除路径的内容在目标侧有多个相同 blob，无法唯一确定去向。',
        'The deleted path has multiple identical blobs on the target side. Its destination is not unique.',
      ],
      path_added_ambiguous_identical_blobs: [
        '新增路径的内容在基准侧有多个相同 blob，无法唯一确定来源。',
        'The added path has multiple identical blobs on the base side. Its source is not unique.',
      ],
      unique_qualified_symbol_and_both_source_ranges: [
        '两侧文件的符号类型与全限定名唯一一致，并且两侧源码范围都可读取。',
        'The symbol kind and qualified name match uniquely on both sides, and both source ranges are readable.',
      ],
      matching_name_partial_or_ambiguous_index: [
        '符号名称匹配，但索引不完整或同名候选不唯一，只能作为不确定匹配。',
        'The symbol name matches, but the index is partial or the name is not unique. Treat this as uncertain.',
      ],
      no_unique_index_match: [
        '索引中没有唯一的同名或同全限定名候选。',
        'The index has no unique match by name or qualified name.',
      ],
      partial_or_unavailable_source: [
        '至少一侧源码范围缺失或不可读取，无法确认内容是否相同。',
        'At least one source range is missing or unreadable, so content equality cannot be confirmed.',
      ],
    };
    const match = descriptions[evidence];
    if (match) return language === 'zh-CN' ? match[0] : match[1];
    return language === 'zh-CN'
      ? `后端返回了未说明的匹配依据：${evidence}`
      : `The backend returned an undocumented matching basis: ${evidence}`;
  };

  const warningDescription = (warning: string) => {
    if (warning.startsWith('unverified_language:')) {
      const target = warning.slice('unverified_language:'.length);
      return language === 'zh-CN'
        ? `影响分析未验证语言 ${target}`
        : `Impact analysis has not verified language ${target}`;
    }
    const descriptions: Record<string, [string, string]> = {
      static_analysis_potential_impact: [
        '这是静态分析推导的潜在影响，不代表实际运行结果。',
        'This is potential impact derived from static analysis, not observed runtime behavior.',
      ],
      unresolved_or_dynamic_relations_not_complete: [
        '未解析或动态关系不完整，列表可能缺少部分影响。',
        'Unresolved or dynamic relations are incomplete. Some impact may be missing.',
      ],
    };
    const match = descriptions[warning];
    return match ? (language === 'zh-CN' ? match[0] : match[1]) : warning;
  };

  const pathLocations = (oldPath?: string, newPath?: string) => {
    const locations: string[] = [];
    if (oldPath) locations.push(`${L.beforeSide}: ${oldPath}`);
    if (newPath) locations.push(`${L.afterSide}: ${newPath}`);
    return locations.length ? locations : ['-'];
  };

  const impactStatusLabels = (impact: CodeGraphResponse) => {
    const labels: string[] = [];
    if (impact.state === 'unsupported') labels.push(L.impactUnsupported);
    if (impact.state === 'empty') labels.push(L.impactEmpty);
    if (impact.state !== 'ready' && impact.state !== 'unsupported' && impact.state !== 'empty') {
      labels.push(impact.state);
    }
    if (
      impact.state === 'ready' &&
      (impact.truncated || impact.truncationReasons.length || impact.warnings.length)
    ) {
      labels.push(L.impactPartial);
    }
    if (impact.truncated) labels.push(L.impactTruncated);
    if (impact.state === 'ready' && !impact.impactPaths?.length) labels.push(L.impactEmpty);
    return labels;
  };

  const sideHeader = (key: SideKey, symbol?: SideSymbol) => {
    const details = sideResults[key];
    const impact = details?.impact ?? null;
    const rows = impact ? impactRows(impact) : [];
    const title = key === 'before' ? L.before : L.after;
    if (!symbol) {
      return (
        <section className="_codegraph-change-review-side" aria-label={title}>
          <div className="_codegraph-change-review-side-header">
            <strong>{title}</strong>
            <span className="_codegraph-change-review-side-meta">{L.missingSide}</span>
          </div>
          <div className="_codegraph-change-review-missing">{L.missingSymbol}</div>
        </section>
      );
    }
    return (
      <section className="_codegraph-change-review-side" aria-label={title}>
        <div className="_codegraph-change-review-side-header">
          <strong>{title}</strong>
          <span className="_codegraph-change-review-side-meta">
            {L.commit} {shortCommit(symbol.commit)} · {L.branch}{' '}
            {versions.find((item) => item.commit === symbol.commit)?.branch ?? '-'} · {L.index}{' '}
            {symbol.indexVersion}
          </span>
        </div>
        <p className="_codegraph-change-review-location">{symbolLocation(symbol)}</p>
        {detailsLoading && <StatusTip status="loading" />}
        {details?.sourceError && <Alert type="error">{details.sourceError}</Alert>}
        {details?.source && details.source.source ? (
          <article>
            <h4>{L.source}</h4>
            <pre className="_codegraph-change-review-code" tabIndex={0} aria-label={L.source}>
              {details.source.source.content}
            </pre>
          </article>
        ) : (
          <p role="status">{details?.source ? L.sourceUnavailable : L.emptySource}</p>
        )}
        {details?.impactError && <Alert type="error">{details.impactError}</Alert>}
        {impact && (
          <article>
            <h4>{L.impact}</h4>
            <p>
              {L.impactSummary
                .replace('{{symbols}}', String(impact.impactPaths?.length ?? 0))
                .replace('{{edges}}', String(impact.edges.length))}
            </p>
            {(() => {
              const statusLabels = impactStatusLabels(impact);
              return statusLabels.length ? (
                <div className="_codegraph-change-review-statuses" aria-label={L.impactWarnings}>
                  {statusLabels.map((label) => (
                    <span
                      key={label}
                      className="_codegraph-change-review-status-badge"
                      data-state={impact.state}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              ) : null;
            })()}
            {(impact.warnings.length > 0 || impact.truncationReasons.length > 0) && (
              <div className="_codegraph-change-review-warning-list">
                <strong>{L.impactWarnings}</strong>
                <ul>
                  {impact.warnings.map((warning) => (
                    <li key={warning}>{warningDescription(warning)}</li>
                  ))}
                  {impact.truncationReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {rows.length ? (
              <ul className="_codegraph-change-review-impact-list">
                <li className="_codegraph-change-review-impact-direction">{L.impactDirection}</li>
                {rows.map((row) => (
                  <li key={row.nodeId}>
                    <div className="_codegraph-change-review-impact-heading">
                      <strong>{row.names[0]}</strong>
                      <span
                        className="_codegraph-change-review-relation"
                        data-relation={row.relation}
                      >
                        {row.relation === 'direct'
                          ? L.impactDirect
                          : row.relation === 'indirect'
                            ? L.impactIndirect
                            : L.impactUnknown}
                      </span>
                    </div>
                    <span className="_codegraph-change-review-impact-path">
                      {L.impactPath}: {row.names.join(' → ')}
                    </span>
                    {row.depth !== undefined && (
                      <span className="_codegraph-change-review-side-meta">
                        {L.depth}: {row.depth}
                      </span>
                    )}
                    <div
                      className="_codegraph-change-review-evidence-list"
                      aria-label={L.edgeEvidence}
                    >
                      {row.edgeIds.map((edgeId) => {
                        const edge = impact.edges.find((item) => item.id === edgeId);
                        if (!edge) {
                          return (
                            <span
                              key={`${row.nodeId}:${edgeId}:missing`}
                              className="_codegraph-change-review-evidence-missing"
                            >
                              {L.evidenceMissing}
                            </span>
                          );
                        }
                        if (!edge.evidence.length) {
                          return (
                            <span
                              key={`${row.nodeId}:${edgeId}:empty`}
                              className="_codegraph-change-review-evidence-missing"
                            >
                              {L.evidenceMissing}
                            </span>
                          );
                        }
                        const sourceName =
                          impact.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
                        const targetName =
                          impact.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
                        return edge.evidence.map((evidence, evidenceIndex) => {
                          const selected =
                            evidenceSelection?.sideKey === key &&
                            evidenceSelection.edgeId === edge.id &&
                            evidenceSelection.evidenceIndex === evidenceIndex;
                          return (
                            <button
                              key={`${row.nodeId}:${edge.id}:${evidenceIndex}`}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => {
                                void loadEvidenceSource(
                                  key,
                                  symbol,
                                  impact,
                                  edge.id,
                                  evidenceIndex,
                                );
                              }}
                            >
                              {sourceName} → {targetName} · {evidence.filePath}:{evidence.line}
                            </button>
                          );
                        });
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{L.impactEmpty}</p>
            )}
          </article>
        )}
        {evidenceSelection?.sideKey === key && (
          <article className="_codegraph-change-review-evidence-source">
            <h4>{L.evidenceSource}</h4>
            <p className="_codegraph-change-review-location">
              {evidenceSelection.filePath}:{evidenceSelection.line}
            </p>
            {evidenceLoading && <StatusTip status="loading" />}
            {evidenceError && <Alert type="error">{evidenceError}</Alert>}
            {evidenceSource?.source ? (
              <pre
                className="_codegraph-change-review-code"
                tabIndex={0}
                aria-label={L.evidenceSource}
              >
                {evidenceSource.source.content}
              </pre>
            ) : (
              !evidenceLoading && !evidenceError && <p role="status">{L.sourceUnavailable}</p>
            )}
          </article>
        )}
      </section>
    );
  };

  return (
    <section
      className={`_codegraph-change-review${className ? ` ${className}` : ''}`}
      data-testid="code-graph-change-review"
      aria-label={L.title}
    >
      <header>
        <h3>{L.title}</h3>
        <p>{L.subtitle}</p>
      </header>
      <div className="_codegraph-change-review-toolbar">
        <label className="_codegraph-change-review-field" htmlFor="code-graph-review-before">
          <span>{L.before}</span>
          <select
            id="code-graph-review-before"
            className="_codegraph-change-review-select"
            value={beforeCommit}
            disabled={versionsLoading || versions.length < 2}
            onChange={(event) => {
              setBeforeCommit(event.target.value);
              resetReviewData();
            }}
          >
            {!beforeCommit && initialIssues.some((issue) => issue.side === 'before') && (
              <option value="">{L.invalidCommitOption}</option>
            )}
            {versions.map((version) => (
              <option key={version.commit} value={version.commit}>
                {shortCommit(version.commit)} · {formatTime(version.indexedAt)}
              </option>
            ))}
          </select>
        </label>
        <label className="_codegraph-change-review-field" htmlFor="code-graph-review-after">
          <span>{L.after}</span>
          <select
            id="code-graph-review-after"
            className="_codegraph-change-review-select"
            value={afterCommit}
            disabled={versionsLoading || versions.length < 2}
            onChange={(event) => {
              setAfterCommit(event.target.value);
              resetReviewData();
            }}
          >
            {!afterCommit && initialIssues.some((issue) => issue.side === 'after') && (
              <option value="">{L.invalidCommitOption}</option>
            )}
            {versions.map((version) => (
              <option key={version.commit} value={version.commit}>
                {shortCommit(version.commit)} · {formatTime(version.indexedAt)}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="primary"
          disabled={
            versionsLoading || !beforeCommit || !afterCommit || beforeCommit === afterCommit
          }
          onClick={() => void loadCompare(0)}
        >
          {L.compare}
        </Button>
      </div>
      {versionsLoading && (
        <div className="_codegraph-change-review-status" role="status" aria-live="polite">
          <StatusTip status="loading" />
          <span>{L.versionsLoading}</span>
        </div>
      )}
      {versionsError && <Alert type="error">{versionsError}</Alert>}
      {initialIssues.map((issue) => (
        <Alert key={`${issue.side}:${issue.requested}`} type="warning">
          {(issue.status === 'unavailable' ? L.initialUnavailable : L.initialAmbiguous)
            .replace('{{side}}', issue.side === 'before' ? L.before : L.after)
            .replace('{{value}}', issue.requested)
            .replace('{{count}}', String(issue.matchCount))}
        </Alert>
      ))}
      {!versionsLoading && !versionsError && !versions.length && <p>{L.noVersions}</p>}
      {compareLoading && (
        <div className="_codegraph-change-review-status" role="status" aria-live="polite">
          <StatusTip status="loading" />
          <span>{L.compareLoading}</span>
        </div>
      )}
      {compareError && <Alert type="error">{compareError}</Alert>}
      {unavailableResult && (
        <section className="_codegraph-change-review-section">
          <h4>{L.unavailable}</h4>
          {unavailableResult.reason && (
            <p className="_codegraph-change-review-evidence">{unavailableResult.reason}</p>
          )}
          <p>
            {L.before}: {unavailableResult.before ?? '-'} · {L.after}:{' '}
            {unavailableResult.after ?? '-'}
          </p>
        </section>
      )}
      {singleSide && (unavailableResult || initialIssues.length > 0 || versions.length === 1) && (
        <section className="_codegraph-change-review-section">
          <h4>{L.singleSearch}</h4>
          <p className="_codegraph-change-review-note">{L.singleSearchHint}</p>
          {availableSides.length > 1 && (
            <div
              className="_codegraph-change-review-side-selector"
              role="group"
              aria-label={L.availableSide}
            >
              {availableSides.map((side) => (
                <button
                  key={side.key}
                  type="button"
                  aria-pressed={singleSide?.key === side.key}
                  onClick={() => changeSearchSide(side.key)}
                >
                  {side.key === 'before' ? L.before : L.after} · {shortCommit(side.version.commit)}
                </button>
              ))}
            </div>
          )}
          <div className="_codegraph-change-review-filter-row">
            <label className="_codegraph-change-review-field" htmlFor="code-graph-review-search">
              <span>{L.symbol}</span>
              <input
                id="code-graph-review-search"
                className="_codegraph-change-review-input"
                value={searchQuery}
                placeholder={L.searchPlaceholder}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitSearch();
                  }
                }}
              />
            </label>
            <Button
              type="primary"
              disabled={searchLoading || !searchQuery.trim()}
              onClick={() => void submitSearch()}
            >
              {L.search}
            </Button>
          </div>
          {searchLoading && (
            <div className="_codegraph-change-review-status" role="status" aria-live="polite">
              <StatusTip status="loading" />
              <span>{L.searchLoading}</span>
            </div>
          )}
          {searchError && <Alert type="error">{searchError}</Alert>}
          {searchResults?.nodes.length ? (
            <div className="_codegraph-change-review-table-wrap">
              <table className="_codegraph-change-review-table">
                <caption>{L.singleSearch}</caption>
                <thead>
                  <tr>
                    <th>{L.symbol}</th>
                    <th>{L.kind}</th>
                    <th>{L.location}</th>
                    <th>{L.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.nodes.map((node) => (
                    <tr key={node.id}>
                      <td>{node.name}</td>
                      <td>{node.kind}</td>
                      <td>
                        {node.filePath}:{node.startLine}-{node.endLine}
                      </td>
                      <td>
                        <button type="button" onClick={() => selectSearchSymbol(node)}>
                          {L.selectSymbol}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !searchLoading && searchResults && <p>{L.noSearchResults}</p>
          )}
        </section>
      )}
      {pageResult && !fileResult && (
        <section className="_codegraph-change-review-section">
          <div className="_codegraph-change-review-pagination">
            <strong>{L.files}</strong>
            <span>
              {L.page
                .replace('{{page}}', String(page))
                .replace('{{total}}', String(pageResult.total))}
            </span>
            <div className="_codegraph-change-review-actions">
              <Button
                disabled={!canPrevious || compareLoading}
                onClick={() => void loadCompare(Math.max(0, pageOffset - PAGE_SIZE))}
              >
                {L.previous}
              </Button>
              <Button
                disabled={!canNext || compareLoading}
                onClick={() => void loadCompare(pageResult.nextOffset ?? pageOffset)}
              >
                {L.next}
              </Button>
            </div>
          </div>
          <div className="_codegraph-change-review-filter-row">
            <label
              className="_codegraph-change-review-field"
              htmlFor="code-graph-review-file-filter"
            >
              <span>{L.change}</span>
              <select
                id="code-graph-review-file-filter"
                value={fileFilter}
                onChange={(event) =>
                  setFileFilter(event.target.value as CodeGraphReviewChangeKind | 'all')
                }
              >
                <option value="all">{L.all}</option>
                {(
                  ['added', 'modified', 'deleted', 'renamed', 'uncertain', 'unchanged'] as const
                ).map((kind) => (
                  <option key={kind} value={kind}>
                    {changeLabel(kind)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {filteredFiles.length ? (
            <div className="_codegraph-change-review-table-wrap">
              <table className="_codegraph-change-review-table">
                <caption>{L.files}</caption>
                <thead>
                  <tr>
                    <th>{L.change}</th>
                    <th>{L.path}</th>
                    <th>{L.evidence}</th>
                    <th>{L.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map((file) => (
                    <tr key={`${file.oldPath ?? ''}:${file.newPath ?? ''}:${file.kind}`}>
                      <td>
                        <span className="_codegraph-change-review-change" data-kind={file.kind}>
                          {changeLabel(file.kind)}
                        </span>
                      </td>
                      <td>
                        <div className="_codegraph-change-review-locations">
                          {pathLocations(file.oldPath, file.newPath).map((location, index) => (
                            <span key={`${location}:${index}`}>{location}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="_codegraph-change-review-evidence-stack">
                          <span>{evidenceDescription(file.evidence)}</span>
                          <span className="_codegraph-change-review-evidence">{file.evidence}</span>
                        </div>
                      </td>
                      <td>
                        <button type="button" onClick={() => void loadFile(file)}>
                          {L.selectFile}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{L.noFiles}</p>
          )}
        </section>
      )}
      {fileResult && (
        <section className="_codegraph-change-review-section">
          <div className="_codegraph-change-review-pagination">
            <strong>{L.symbols}</strong>
            <Button onClick={() => setFileResult(null)}>{L.backToFiles}</Button>
          </div>
          <p className="_codegraph-change-review-location">
            {pathLocations(fileResult.file.oldPath, fileResult.file.newPath).join(' · ')}
          </p>
          {fileResult.truncated && <p className="_codegraph-change-review-note">{L.truncated}</p>}
          <div className="_codegraph-change-review-filter-row">
            <label
              className="_codegraph-change-review-field"
              htmlFor="code-graph-review-symbol-filter"
            >
              <span>{L.change}</span>
              <select
                id="code-graph-review-symbol-filter"
                value={symbolFilter}
                onChange={(event) =>
                  setSymbolFilter(event.target.value as CodeGraphReviewChangeKind | 'all')
                }
              >
                <option value="all">{L.all}</option>
                {(
                  ['added', 'modified', 'deleted', 'renamed', 'uncertain', 'unchanged'] as const
                ).map((kind) => (
                  <option key={kind} value={kind}>
                    {changeLabel(kind)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {filteredSymbols.length ? (
            <div className="_codegraph-change-review-table-wrap">
              <table className="_codegraph-change-review-table">
                <caption>{L.symbols}</caption>
                <thead>
                  <tr>
                    <th>{L.change}</th>
                    <th>{L.symbol}</th>
                    <th>{L.kind}</th>
                    <th>{L.location}</th>
                    <th>{L.evidence}</th>
                    <th>{L.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSymbols.map((change) => (
                    <tr
                      key={`${change.old?.nodeId ?? ''}:${change.new?.nodeId ?? ''}:${change.kind}`}
                    >
                      <td>
                        <span className="_codegraph-change-review-change" data-kind={change.kind}>
                          {changeLabel(change.kind)}
                        </span>
                      </td>
                      <td>{change.old?.name ?? change.new?.name ?? '-'}</td>
                      <td>{change.old?.kind ?? change.new?.kind ?? '-'}</td>
                      <td>
                        <div className="_codegraph-change-review-locations">
                          {pathLocations(
                            change.old
                              ? `${change.old.filePath}:${change.old.line}-${change.old.endLine}`
                              : undefined,
                            change.new
                              ? `${change.new.filePath}:${change.new.line}-${change.new.endLine}`
                              : undefined,
                          ).map((location, index) => (
                            <span key={`${location}:${index}`}>{location}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="_codegraph-change-review-evidence-stack">
                          <span>{evidenceDescription(change.evidence)}</span>
                          <span className="_codegraph-change-review-evidence">
                            {change.evidence}
                          </span>
                        </div>
                      </td>
                      <td>
                        <button type="button" onClick={() => selectSymbolChange(change)}>
                          {L.selectSymbol}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{L.noSymbols}</p>
          )}
        </section>
      )}
      {selectedSymbol && (
        <section className="_codegraph-change-review-section">
          <h4>{selectedSymbol.title || L.symbol}</h4>
          {detailsError && <Alert type="error">{detailsError}</Alert>}
          {detailsLoading && (
            <div className="_codegraph-change-review-status" role="status" aria-live="polite">
              <StatusTip status="loading" />
              <span>{L.detailsLoading}</span>
            </div>
          )}
          <div className="_codegraph-change-review-sides">
            {sideHeader('before', selectedSymbol.before)}
            {sideHeader('after', selectedSymbol.after)}
          </div>
        </section>
      )}
    </section>
  );
}
