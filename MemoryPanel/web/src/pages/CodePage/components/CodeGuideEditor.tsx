import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip } from 'tea-component';
import {
  CodeGuideApiError,
  codeGuideApi,
  isCodeGuidePermissionError,
  type GuideEdition,
  type GuideFeedback,
  type CodeGuideStepKind,
} from './CodeGuideEditor.api';
import './CodeGuideEditor.css';

const TEMPLATE_IDS = ['memhub-l1-search', 'memhub-build-queue'] as const;
const OPTIONAL_ANCHOR_FIELDS = new Set(['assetId', 'indexVersion', 'commit', 'edgeId']);
const STEP_KINDS: CodeGuideStepKind[] = [
  'source',
  'branch',
  'async',
  'parallel',
  'unknown',
  'reading',
];

const TEXT = {
  'zh-CN': {
    title: 'Code 资产导览编辑',
    subtitle: '生成候选、人工修订、发布版本，并核对逐步骤反馈。',
    loading: '正在加载导览…',
    loadError: '导览加载失败，请重试。',
    noPermission: '当前账号没有该 Code 资产的编辑权限，以下仅显示可读的已发布导览。',
    noGuides: '当前 Code 资产暂无导览。',
    refresh: '刷新',
    listTitle: '导览版本',
    candidates: '候选',
    published: '已发布',
    withdrawn: '已撤下',
    stale: '引用过期',
    revision: '修订',
    origin: '来源',
    operation: '操作',
    actor: '审核人',
    updatedAt: '更新时间',
    commit: '提交',
    indexVersion: '索引版本',
    sourceAssets: '关联资产',
    topic: '业务主题',
    titleField: '导览标题',
    steps: '步骤',
    stepTitle: '步骤标题',
    description: '步骤说明',
    kind: '类型',
    anchors: '引文锚点',
    anchorLabel: '锚点名称',
    nodeId: '符号 ID',
    filePath: '文件路径',
    line: '行号',
    contentHash: '内容哈希',
    assetId: '资产 ID',
    anchorIndexVersion: '锚点索引',
    anchorCommit: '锚点提交',
    edgeId: '关系 ID',
    unsaved: '有未保存的人工修订，请先保存再发布或撤下。',
    save: '保存修订',
    saving: '正在保存…',
    saveError: '保存失败，请核对内容或刷新修订后重试。',
    saved: '修订已保存。',
    publish: '发布',
    withdraw: '撤下',
    publishError: '发布状态更新失败。',
    staleTitle: '以下引文与当前索引不一致',
    staleReference: '第 {{step}} 步「{{title}}」第 {{anchor}} 个锚点',
    generate: '生成与更新候选',
    generateHint: '模板按固定流程生成；通用查询按符号检索生成候选。',
    template: '模板',
    templateL1: 'L1 记忆检索',
    templateQueue: '构建队列',
    genericQuery: '通用查询',
    queryLabel: '查询内容',
    queryPlaceholder: '例如 executeMemorySearch',
    generateButton: '生成候选',
    generating: '正在生成…',
    generateError: '候选生成失败，请稍后重试。',
    regenerate: '按当前索引生成新版候选',
    readOnly: '只读',
    history: '历史修订与反馈',
    historyLoading: '正在加载历史…',
    historyError: '历史加载失败，请重试。',
    compareWith: '对比修订',
    feedback: '逐步骤反馈',
    noHistory: '暂无历史修订。',
    noFeedback: '暂无反馈。',
    field: '字段',
    before: '旧值',
    after: '新值',
    noChanges: '所选修订与当前版本内容一致。',
    stepAdded: '新增步骤',
    stepRemoved: '删除步骤',
    stepChanged: '步骤内容变更',
    anchorsChanged: '引文锚点变更',
    relationsChanged: '步骤关系变更',
    feedbackStep: '步骤',
    feedbackMessage: '反馈',
    feedbackFormTitle: '报告当前步骤问题',
    feedbackHint: '反馈会记录到指定修订，服务端会校验步骤与读取权限。',
    feedbackPlaceholder: '请描述定位错误、说明不准确或缺失的证据。',
    submitFeedback: '提交反馈',
    feedbackSending: '正在提交…',
    feedbackError: '反馈提交失败，请稍后重试。',
    feedbackSent: '反馈已记录，感谢协助修正导览。',
    invalidFeedback: '请先填写反馈内容。',
  },
  'en-US': {
    title: 'Code asset guide editor',
    subtitle:
      'Generate candidates, revise them manually, publish versions, and review step feedback.',
    loading: 'Loading guides…',
    loadError: 'Failed to load guides. Please retry.',
    noPermission:
      'Your account cannot edit this Code asset. Only readable published guides are shown below.',
    noGuides: 'No guides are available for this Code asset yet.',
    refresh: 'Refresh',
    listTitle: 'Guide versions',
    candidates: 'Candidate',
    published: 'Published',
    withdrawn: 'Withdrawn',
    stale: 'Stale references',
    revision: 'Revision',
    origin: 'Origin',
    operation: 'Operation',
    actor: 'Actor',
    updatedAt: 'Updated at',
    commit: 'Commit',
    indexVersion: 'Index version',
    sourceAssets: 'Linked assets',
    topic: 'Business topic',
    titleField: 'Guide title',
    steps: 'Steps',
    stepTitle: 'Step title',
    description: 'Step description',
    kind: 'Kind',
    anchors: 'Citation anchors',
    anchorLabel: 'Anchor label',
    nodeId: 'Symbol ID',
    filePath: 'File path',
    line: 'Line',
    contentHash: 'Content hash',
    assetId: 'Asset ID',
    anchorIndexVersion: 'Anchor index',
    anchorCommit: 'Anchor commit',
    edgeId: 'Relation ID',
    unsaved: 'Save the manual revision before publishing or withdrawing this guide.',
    save: 'Save revision',
    saving: 'Saving…',
    saveError: 'Failed to save. Check the content or refresh the revision, then retry.',
    saved: 'Revision saved.',
    publish: 'Publish',
    withdraw: 'Withdraw',
    publishError: 'Failed to update publication status.',
    staleTitle: 'These citations do not match the current index',
    staleReference: 'Step {{step}} "{{title}}" anchor {{anchor}}',
    generate: 'Generate and update candidates',
    generateHint:
      'Templates build fixed walkthroughs; generic queries build candidates from symbol search.',
    template: 'Template',
    templateL1: 'L1 memory search',
    templateQueue: 'Build queue',
    genericQuery: 'Generic query',
    queryLabel: 'Query',
    queryPlaceholder: 'For example, executeMemorySearch',
    generateButton: 'Generate candidate',
    generating: 'Generating…',
    generateError: 'Failed to generate a candidate. Please retry.',
    regenerate: 'Generate a new candidate for the current index',
    readOnly: 'Read only',
    history: 'History and feedback',
    historyLoading: 'Loading history…',
    historyError: 'Failed to load history. Please retry.',
    compareWith: 'Compare revision',
    feedback: 'Step feedback',
    noHistory: 'No historical revisions.',
    noFeedback: 'No feedback yet.',
    field: 'Field',
    before: 'Before',
    after: 'After',
    noChanges: 'The selected revision has the same content as the current version.',
    stepAdded: 'Step added',
    stepRemoved: 'Step removed',
    stepChanged: 'Step content changed',
    anchorsChanged: 'Citation anchors changed',
    relationsChanged: 'Step relations changed',
    feedbackStep: 'Step',
    feedbackMessage: 'Feedback',
    feedbackFormTitle: 'Report an issue with this step',
    feedbackHint:
      'Feedback is recorded against the specified revision. The service validates the step and read permission.',
    feedbackPlaceholder: 'Describe a wrong location, inaccurate wording, or missing evidence.',
    submitFeedback: 'Submit feedback',
    feedbackSending: 'Submitting…',
    feedbackError: 'Failed to submit feedback. Please retry.',
    feedbackSent: 'Feedback recorded. Thank you for helping improve the guide.',
    invalidFeedback: 'Enter feedback before submitting.',
  },
} as const;

type Language = keyof typeof TEXT;
type Dictionary = (typeof TEXT)[Language];

function useGuideText(): Dictionary {
  const { i18n } = useTranslation();
  const language: Language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  return TEXT[language];
}

function formatTime(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function shortCommit(value: string): string {
  return value.slice(0, 10);
}

function isPermissionError(error: unknown): boolean {
  return isCodeGuidePermissionError(error);
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof CodeGuideApiError && error.rawMessage) return error.rawMessage;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function queryGuideId(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (slug) return `guide-${slug}`;

  let hash = 0;
  for (const character of query) {
    hash = (hash * 31 + character.codePointAt(0)!) | 0;
  }
  return `guide-${Math.abs(hash).toString(36)}`;
}

function replaceGuide(items: GuideEdition[], guide: GuideEdition): GuideEdition[] {
  const next = [...items];
  const index = next.findIndex((item) => item.id === guide.id);
  if (index >= 0) next[index] = guide;
  else next.push(guide);
  return next;
}

function documentChanged(guide: GuideEdition | null, draft: GuideEdition | null): boolean {
  if (!guide || !draft) return false;
  return (
    guide.title !== draft.title ||
    guide.topic !== draft.topic ||
    JSON.stringify(guide.steps) !== JSON.stringify(draft.steps) ||
    JSON.stringify(guide.relations ?? null) !== JSON.stringify(draft.relations ?? null)
  );
}

export function CodeGuideEditor({ assetId }: { assetId: string }) {
  const L = useGuideText();
  const [items, setItems] = useState<GuideEdition[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<GuideEdition | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [generateMode, setGenerateMode] = useState<'template' | 'query'>('template');
  const [templateId, setTemplateId] = useState<string>(TEMPLATE_IDS[0]);
  const [query, setQuery] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const loadController = useRef<AbortController | null>(null);

  const selectedGuide = useMemo(
    () => items.find((guide) => guide.id === selectedId) ?? null,
    [items, selectedId],
  );
  const dirty = documentChanged(selectedGuide, draft);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError('');
    setSaved(false);
    setSaveError('');
    setStatusError('');
    try {
      try {
        const guides = await codeGuideApi.listEditor(assetId, controller.signal);
        if (controller.signal.aborted) return;
        setItems(guides);
        setReadOnly(false);
        const first = guides.find((guide) => guide.status === 'candidate') ?? guides[0] ?? null;
        setSelectedId(first?.id ?? '');
        setDraft(first);
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isPermissionError(error)) throw error;
      }

      const guides = await codeGuideApi.listPublished(assetId, controller.signal);
      if (controller.signal.aborted) return;
      setItems(guides);
      setReadOnly(true);
      setSelectedId(guides[0]?.id ?? '');
      setDraft(guides[0] ?? null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    setSelectedId('');
    setDraft(null);
    setReadOnly(false);
    void load().catch((error: unknown) => {
      setLoadError(messageFor(error, L.loadError));
    });
    return () => {
      loadController.current?.abort();
    };
  }, [L.loadError, load]);

  function selectGuide(guide: GuideEdition) {
    setSelectedId(guide.id);
    setDraft(guide);
    setSaved(false);
    setSaveError('');
    setStatusError('');
  }

  function updateGuideField(field: 'title' | 'topic', value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    setSaved(false);
    setSaveError('');
  }

  function updateStep(stepId: string, field: 'title' | 'description', value: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) =>
              step.id === stepId ? { ...step, [field]: value } : step,
            ),
          }
        : current,
    );
    setSaved(false);
    setSaveError('');
  }

  function updateStepKind(stepId: string, kind: CodeGuideStepKind) {
    setDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) => (step.id === stepId ? { ...step, kind } : step)),
          }
        : current,
    );
    setSaved(false);
  }

  function updateAnchor(
    stepId: string,
    anchorIndex: number,
    field: keyof GuideEdition['steps'][number]['anchors'][number],
    value: string | number,
  ) {
    const normalized =
      typeof value === 'string' && !value.trim() && OPTIONAL_ANCHOR_FIELDS.has(field)
        ? undefined
        : value;
    setDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) =>
              step.id === stepId
                ? {
                    ...step,
                    anchors: step.anchors.map((anchor, index) =>
                      index === anchorIndex ? { ...anchor, [field]: normalized } : anchor,
                    ),
                  }
                : step,
            ),
          }
        : current,
    );
    setSaved(false);
    setSaveError('');
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      const result = await codeGuideApi.save(assetId, draft, draft.revision);
      setItems((current) => replaceGuide(current, result));
      setDraft(result);
      setSaved(true);
    } catch (error) {
      setSaveError(messageFor(error, L.saveError));
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(action: 'publish' | 'withdraw') {
    if (!selectedGuide || dirty) return;
    setStatusUpdating(true);
    setStatusError('');
    try {
      const result =
        action === 'publish'
          ? await codeGuideApi.publish(assetId, selectedGuide.id, selectedGuide.revision)
          : await codeGuideApi.withdraw(assetId, selectedGuide.id, selectedGuide.revision);
      setItems((current) => replaceGuide(current, result));
      setDraft(result);
    } catch (error) {
      setStatusError(messageFor(error, L.publishError));
    } finally {
      setStatusUpdating(false);
    }
  }

  async function generateCandidate(guideId: string, revision: number, query?: string) {
    setGenerating(true);
    setGenerateError('');
    try {
      const result = await codeGuideApi.generate(assetId, guideId, revision, query);
      setItems((current) => replaceGuide(current, result));
      setSelectedId(result.id);
      setDraft(result);
    } catch (error) {
      setGenerateError(messageFor(error, L.generateError));
    } finally {
      setGenerating(false);
    }
  }

  function submitGenerate() {
    if (generateMode === 'template') {
      const revision = items.find((guide) => guide.id === templateId)?.revision ?? 0;
      void generateCandidate(templateId, revision);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) return;
    const guideId = queryGuideId(trimmed);
    const revision = items.find((guide) => guide.id === guideId)?.revision ?? 0;
    void generateCandidate(guideId, revision, trimmed);
  }

  const staleRows = (guide: GuideEdition) =>
    (guide.staleReferences ?? []).map((reference) => {
      const step = guide.steps.find((item) => item.id === reference.stepId);
      const stepIndex = guide.steps.findIndex((item) => item.id === reference.stepId) + 1;
      return L.staleReference
        .replace('{{step}}', String(stepIndex))
        .replace('{{title}}', step?.title ?? reference.stepId)
        .replace('{{anchor}}', String(reference.anchor + 1));
    });

  return (
    <section className="_code-guide-editor" data-testid="code-guide-editor" aria-label={L.title}>
      <header className="_code-guide-editor-header">
        <div>
          <h3>{L.title}</h3>
          <p>{L.subtitle}</p>
        </div>
        <Button onClick={() => void load()} disabled={loading}>
          {L.refresh}
        </Button>
      </header>

      {loading && (
        <div className="_code-guide-editor-status" role="status" aria-live="polite">
          <StatusTip status="loading" />
          <span>{L.loading}</span>
        </div>
      )}
      {loadError && <Alert type="error">{loadError}</Alert>}
      {readOnly && !loadError && <Alert type="warning">{L.noPermission}</Alert>}
      {!loading && !loadError && !items.length && <p>{L.noGuides}</p>}

      {!loading && items.length > 0 && (
        <div className="_code-guide-editor-layout">
          <aside className="_code-guide-editor-list" aria-label={L.listTitle}>
            <h4>{L.listTitle}</h4>
            <ul>
              {items.map((guide) => (
                <li key={guide.id}>
                  <button
                    type="button"
                    aria-pressed={guide.id === selectedId}
                    onClick={() => selectGuide(guide)}
                  >
                    <strong>{guide.title}</strong>
                    <span>
                      {guide.status === 'candidate'
                        ? L.candidates
                        : guide.status === 'published'
                          ? L.published
                          : L.withdrawn}{' '}
                      · {L.revision} {guide.revision}
                    </span>
                    {(guide.stale || guide.staleReferences?.length) && <em>{L.stale}</em>}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {draft && (
            <div className="_code-guide-editor-main">
              <section className="_code-guide-editor-section">
                <div className="_code-guide-editor-section-header">
                  <h4>{draft.title}</h4>
                  <span className="_code-guide-editor-status-pill" data-status={draft.status}>
                    {draft.status === 'candidate'
                      ? L.candidates
                      : draft.status === 'published'
                        ? L.published
                        : L.withdrawn}
                  </span>
                </div>
                <dl className="_code-guide-editor-meta">
                  <div>
                    <dt>{L.revision}</dt>
                    <dd>{draft.revision}</dd>
                  </div>
                  <div>
                    <dt>{L.origin}</dt>
                    <dd>{draft.origin ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>{L.operation}</dt>
                    <dd>{draft.operation ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>{L.actor}</dt>
                    <dd>{draft.actor ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>{L.updatedAt}</dt>
                    <dd>{formatTime(draft.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>{L.commit}</dt>
                    <dd>{shortCommit(draft.commit)}</dd>
                  </div>
                  <div>
                    <dt>{L.indexVersion}</dt>
                    <dd>{draft.indexVersion}</dd>
                  </div>
                  <div>
                    <dt>{L.sourceAssets}</dt>
                    <dd>{draft.sourceAssets?.join(', ') || assetId}</dd>
                  </div>
                </dl>
                {!!draft.staleReferences?.length && (
                  <Alert type="warning">
                    <strong>{L.staleTitle}</strong>
                    <ul className="_code-guide-editor-stale-list">
                      {staleRows(draft).map((row) => (
                        <li key={row}>{row}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
              </section>

              <section className="_code-guide-editor-section" aria-label={L.titleField}>
                <h4>{L.titleField}</h4>
                <div className="_code-guide-editor-form-grid">
                  <label htmlFor="code-guide-topic">
                    <span>{L.topic}</span>
                    <input
                      id="code-guide-topic"
                      value={draft.topic}
                      maxLength={240}
                      readOnly={readOnly}
                      onChange={(event) => updateGuideField('topic', event.target.value)}
                    />
                  </label>
                  <label htmlFor="code-guide-title">
                    <span>{L.titleField}</span>
                    <input
                      id="code-guide-title"
                      value={draft.title}
                      maxLength={240}
                      readOnly={readOnly}
                      onChange={(event) => updateGuideField('title', event.target.value)}
                    />
                  </label>
                </div>
              </section>

              <section className="_code-guide-editor-section" aria-label={L.steps}>
                <h4>{L.steps}</h4>
                {draft.steps.map((step, index) => (
                  <details
                    className="_code-guide-editor-step"
                    key={`${draft.id}:${draft.revision}:${step.id}`}
                    open={index === 0}
                  >
                    <summary>
                      <span>
                        {index + 1}. {step.title}
                      </span>
                      <small>
                        {step.kind} · {step.anchors.length}
                      </small>
                    </summary>
                    <div className="_code-guide-editor-form-grid">
                      <label htmlFor={`code-guide-step-title-${step.id}`}>
                        <span>{L.stepTitle}</span>
                        <input
                          id={`code-guide-step-title-${step.id}`}
                          value={step.title}
                          maxLength={240}
                          readOnly={readOnly}
                          onChange={(event) => updateStep(step.id, 'title', event.target.value)}
                        />
                      </label>
                      <label htmlFor={`code-guide-step-kind-${step.id}`}>
                        <span>{L.kind}</span>
                        <select
                          id={`code-guide-step-kind-${step.id}`}
                          value={step.kind}
                          disabled={readOnly}
                          onChange={(event) =>
                            updateStepKind(step.id, event.target.value as CodeGuideStepKind)
                          }
                        >
                          {STEP_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label
                      className="_code-guide-editor-wide-field"
                      htmlFor={`code-guide-description-${step.id}`}
                    >
                      <span>{L.description}</span>
                      <textarea
                        id={`code-guide-description-${step.id}`}
                        value={step.description}
                        maxLength={4000}
                        readOnly={readOnly}
                        rows={4}
                        onChange={(event) => updateStep(step.id, 'description', event.target.value)}
                      />
                    </label>
                    <div className="_code-guide-editor-anchors">
                      <h5>{L.anchors}</h5>
                      {step.anchors.map((anchor, anchorIndex) => (
                        <details
                          className="_code-guide-editor-anchor"
                          key={`${step.id}:${anchorIndex}:${anchor.nodeId}`}
                        >
                          <summary>
                            <span>{anchor.label || anchor.nodeId}</span>
                            <small>
                              {anchor.filePath}:{anchor.line}
                            </small>
                          </summary>
                          <div className="_code-guide-editor-anchor-grid">
                            <label htmlFor={`anchor-label-${step.id}-${anchorIndex}`}>
                              <span>{L.anchorLabel}</span>
                              <input
                                id={`anchor-label-${step.id}-${anchorIndex}`}
                                value={anchor.label}
                                maxLength={240}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'label', event.target.value)
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-node-${step.id}-${anchorIndex}`}>
                              <span>{L.nodeId}</span>
                              <input
                                id={`anchor-node-${step.id}-${anchorIndex}`}
                                value={anchor.nodeId}
                                maxLength={1024}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'nodeId', event.target.value)
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-file-${step.id}-${anchorIndex}`}>
                              <span>{L.filePath}</span>
                              <input
                                id={`anchor-file-${step.id}-${anchorIndex}`}
                                value={anchor.filePath}
                                maxLength={1024}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'filePath', event.target.value)
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-line-${step.id}-${anchorIndex}`}>
                              <span>{L.line}</span>
                              <input
                                id={`anchor-line-${step.id}-${anchorIndex}`}
                                type="number"
                                min={1}
                                step={1}
                                value={anchor.line}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(
                                    step.id,
                                    anchorIndex,
                                    'line',
                                    Math.max(1, Number(event.target.value) || 1),
                                  )
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-hash-${step.id}-${anchorIndex}`}>
                              <span>{L.contentHash}</span>
                              <input
                                id={`anchor-hash-${step.id}-${anchorIndex}`}
                                value={anchor.contentHash}
                                maxLength={64}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(
                                    step.id,
                                    anchorIndex,
                                    'contentHash',
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-asset-${step.id}-${anchorIndex}`}>
                              <span>{L.assetId}</span>
                              <input
                                id={`anchor-asset-${step.id}-${anchorIndex}`}
                                value={anchor.assetId ?? ''}
                                maxLength={128}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'assetId', event.target.value)
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-version-${step.id}-${anchorIndex}`}>
                              <span>{L.anchorIndexVersion}</span>
                              <input
                                id={`anchor-version-${step.id}-${anchorIndex}`}
                                value={anchor.indexVersion ?? ''}
                                maxLength={128}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(
                                    step.id,
                                    anchorIndex,
                                    'indexVersion',
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-commit-${step.id}-${anchorIndex}`}>
                              <span>{L.anchorCommit}</span>
                              <input
                                id={`anchor-commit-${step.id}-${anchorIndex}`}
                                value={anchor.commit ?? ''}
                                maxLength={64}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'commit', event.target.value)
                                }
                              />
                            </label>
                            <label htmlFor={`anchor-edge-${step.id}-${anchorIndex}`}>
                              <span>{L.edgeId}</span>
                              <input
                                id={`anchor-edge-${step.id}-${anchorIndex}`}
                                value={anchor.edgeId ?? ''}
                                maxLength={1024}
                                readOnly={readOnly}
                                onChange={(event) =>
                                  updateAnchor(step.id, anchorIndex, 'edgeId', event.target.value)
                                }
                              />
                            </label>
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </section>

              {readOnly ? (
                <Alert type="info">{L.readOnly}</Alert>
              ) : (
                <section className="_code-guide-editor-actions" aria-live="polite">
                  {dirty && <p className="_code-guide-editor-hint">{L.unsaved}</p>}
                  {saveError && <Alert type="error">{saveError}</Alert>}
                  {saved && <Alert type="success">{L.saved}</Alert>}
                  {statusError && <Alert type="error">{statusError}</Alert>}
                  <div className="_code-guide-editor-button-row">
                    <Button
                      type="primary"
                      disabled={!dirty || saving || generating}
                      onClick={() => void saveDraft()}
                    >
                      {saving ? L.saving : L.save}
                    </Button>
                    <Button
                      disabled={dirty || statusUpdating || draft.status === 'published'}
                      onClick={() => void updateStatus('publish')}
                    >
                      {L.publish}
                    </Button>
                    <Button
                      disabled={dirty || statusUpdating || draft.status === 'withdrawn'}
                      onClick={() => void updateStatus('withdraw')}
                    >
                      {L.withdraw}
                    </Button>
                  </div>
                </section>
              )}

              {!readOnly && (
                <details className="_code-guide-editor-section _code-guide-editor-generator">
                  <summary>
                    <span>{L.generate}</span>
                    <small>{L.generateHint}</small>
                  </summary>
                  <div className="_code-guide-editor-generate-modes" role="radiogroup">
                    <label>
                      <input
                        type="radio"
                        name="code-guide-generate-mode"
                        checked={generateMode === 'template'}
                        onChange={() => setGenerateMode('template')}
                      />
                      <span>{L.template}</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="code-guide-generate-mode"
                        checked={generateMode === 'query'}
                        onChange={() => setGenerateMode('query')}
                      />
                      <span>{L.genericQuery}</span>
                    </label>
                  </div>
                  {generateMode === 'template' ? (
                    <label className="_code-guide-editor-wide-field" htmlFor="code-guide-template">
                      <span>{L.template}</span>
                      <select
                        id="code-guide-template"
                        value={templateId}
                        onChange={(event) => setTemplateId(event.target.value)}
                      >
                        <option value={TEMPLATE_IDS[0]}>{L.templateL1}</option>
                        <option value={TEMPLATE_IDS[1]}>{L.templateQueue}</option>
                      </select>
                    </label>
                  ) : (
                    <label className="_code-guide-editor-wide-field" htmlFor="code-guide-query">
                      <span>{L.queryLabel}</span>
                      <input
                        id="code-guide-query"
                        value={query}
                        maxLength={240}
                        placeholder={L.queryPlaceholder}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                  )}
                  {generateError && <Alert type="error">{generateError}</Alert>}
                  <div className="_code-guide-editor-button-row">
                    <Button
                      type="primary"
                      disabled={generating || (generateMode === 'query' && !query.trim())}
                      onClick={submitGenerate}
                    >
                      {generating ? L.generating : L.generateButton}
                    </Button>
                    {!!selectedGuide?.staleReferences?.length && (
                      <Button
                        disabled={generating}
                        onClick={() =>
                          void generateCandidate(
                            selectedGuide.id,
                            selectedGuide.revision,
                            TEMPLATE_IDS.includes(selectedGuide.id as (typeof TEMPLATE_IDS)[number])
                              ? undefined
                              : selectedGuide.topic || selectedGuide.title,
                          )
                        }
                      >
                        {L.regenerate}
                      </Button>
                    )}
                  </div>
                </details>
              )}

              {!readOnly && (
                <GuideHistory
                  key={`${draft.id}:${draft.revision}`}
                  assetId={assetId}
                  guide={draft}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface GuideChange {
  field: string;
  before: string;
  after: string;
}

function guideChanges(current: GuideEdition, previous: GuideEdition, L: Dictionary): GuideChange[] {
  const changes: GuideChange[] = [];
  if (current.title !== previous.title) {
    changes.push({
      field: L.titleField,
      before: previous.title,
      after: current.title,
    });
  }
  if (current.topic !== previous.topic) {
    changes.push({ field: L.topic, before: previous.topic, after: current.topic });
  }
  if (current.commit !== previous.commit) {
    changes.push({ field: L.commit, before: previous.commit, after: current.commit });
  }
  if (current.indexVersion !== previous.indexVersion) {
    changes.push({
      field: L.indexVersion,
      before: previous.indexVersion,
      after: current.indexVersion,
    });
  }

  const currentSteps = new Map(current.steps.map((step) => [step.id, step]));
  const previousSteps = new Map(previous.steps.map((step) => [step.id, step]));
  for (const [id, step] of currentSteps) {
    const old = previousSteps.get(id);
    if (!old) {
      changes.push({
        field: `${L.stepAdded}: ${id}`,
        before: '-',
        after: L_stepLabel(step),
      });
      continue;
    }
    if (
      old.title !== step.title ||
      old.description !== step.description ||
      old.kind !== step.kind
    ) {
      changes.push({
        field: `${L.stepChanged}: ${id}`,
        before: L_stepLabel(old),
        after: L_stepLabel(step),
      });
    }
    if (JSON.stringify(old.anchors) !== JSON.stringify(step.anchors)) {
      changes.push({
        field: `${L.anchorsChanged}: ${id}`,
        before: `${old.anchors.length}`,
        after: `${step.anchors.length}`,
      });
    }
  }
  for (const [id, step] of previousSteps) {
    if (!currentSteps.has(id)) {
      changes.push({
        field: `${L.stepRemoved}: ${id}`,
        before: L_stepLabel(step),
        after: '-',
      });
    }
  }
  if (JSON.stringify(current.relations ?? null) !== JSON.stringify(previous.relations ?? null)) {
    changes.push({
      field: L.relationsChanged,
      before: `${previous.relations?.length ?? 0}`,
      after: `${current.relations?.length ?? 0}`,
    });
  }
  return changes;
}

function L_stepLabel(step: GuideEdition['steps'][number]): string {
  return `${step.kind} · ${step.title} · ${step.description}`;
}

function GuideHistory({ assetId, guide }: { assetId: string; guide: GuideEdition }) {
  const L = useGuideText();
  const [history, setHistory] = useState<GuideEdition[]>([]);
  const [feedback, setFeedback] = useState<GuideFeedback[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [compareRevision, setCompareRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const result = await codeGuideApi.history(assetId, guide.id, request.signal);
      if (request.signal.aborted) return;
      setHistory(result.items);
      setFeedback(result.feedback);
      const previous = result.items.find((item) => item.revision !== guide.revision);
      setCompareRevision(previous?.revision ?? 0);
    } catch (loadError) {
      if (request.signal.aborted) return;
      setError(messageFor(loadError, L.historyError));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [L.historyError, assetId, guide.id, guide.revision]);

  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, []);

  const compared = history.find((item) => item.revision === compareRevision) ?? null;
  const changes = compared ? guideChanges(guide, compared, L) : [];

  return (
    <details
      className="_code-guide-editor-section _code-guide-editor-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !history.length && !loading) void loadHistory();
      }}
    >
      <summary>
        <span>{L.history}</span>
      </summary>
      {loading && (
        <div className="_code-guide-editor-status" role="status" aria-live="polite">
          <StatusTip status="loading" />
          <span>{L.historyLoading}</span>
        </div>
      )}
      {error && <Alert type="error">{error}</Alert>}
      {!loading && !error && (
        <div className="_code-guide-editor-history-layout">
          <section>
            <h4>{L.compareWith}</h4>
            <label htmlFor={`code-guide-history-${guide.id}`}>
              <span className="_code-guide-editor-visually-hidden">{L.compareWith}</span>
              <select
                id={`code-guide-history-${guide.id}`}
                value={compareRevision}
                onChange={(event) => setCompareRevision(Number(event.target.value))}
              >
                {history
                  .filter((item) => item.revision !== guide.revision)
                  .map((item) => (
                    <option key={item.revision} value={item.revision}>
                      {L.revision} {item.revision} · {formatTime(item.updatedAt)}
                    </option>
                  ))}
              </select>
            </label>
            {compared ? (
              changes.length ? (
                <table className="_code-guide-editor-table">
                  <thead>
                    <tr>
                      <th>{L.field}</th>
                      <th>{L.before}</th>
                      <th>{L.after}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((change) => (
                      <tr key={`${change.field}:${change.before}:${change.after}`}>
                        <td>{change.field}</td>
                        <td>{change.before}</td>
                        <td>{change.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p>{L.noChanges}</p>
              )
            ) : (
              <p>{L.noHistory}</p>
            )}
          </section>

          <section>
            <h4>{L.feedback}</h4>
            {feedback.length ? (
              <ul className="_code-guide-editor-feedback-list">
                {feedback.map((item, index) => (
                  <li key={`${item.revision}:${item.stepId}:${index}`}>
                    <strong>
                      {L.revision} {item.revision} · {L.feedbackStep} {item.stepId}
                    </strong>
                    <span>{item.message}</span>
                    <small>
                      {item.actor} · {formatTime(item.createdAt)}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{L.noFeedback}</p>
            )}
          </section>
        </div>
      )}
    </details>
  );
}

export function GuideStepFeedback({
  assetId,
  guideId,
  revision,
  stepId,
}: {
  assetId: string;
  guideId: string;
  revision: number;
  stepId: string;
}) {
  const L = useGuideText();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setError(L.invalidFeedback);
      return;
    }
    setSending(true);
    setError('');
    setSent(false);
    try {
      await codeGuideApi.feedback(assetId, guideId, revision, stepId, trimmed);
      setSent(true);
      setMessage('');
    } catch (submitError) {
      setError(messageFor(submitError, L.feedbackError));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="_code-guide-editor _code-guide-editor-feedback-form"
      data-testid="code-guide-step-feedback"
      aria-label={L.feedbackFormTitle}
      onSubmit={submit}
    >
      <h4>{L.feedbackFormTitle}</h4>
      <p>{L.feedbackHint}</p>
      <label htmlFor={`code-guide-feedback-${guideId}-${revision}-${stepId}`}>
        <span className="_code-guide-editor-visually-hidden">{L.feedbackMessage}</span>
        <textarea
          id={`code-guide-feedback-${guideId}-${revision}-${stepId}`}
          value={message}
          rows={3}
          maxLength={2000}
          placeholder={L.feedbackPlaceholder}
          onChange={(event) => {
            setMessage(event.target.value);
            setSent(false);
            setError('');
          }}
        />
      </label>
      {error && <Alert type="error">{error}</Alert>}
      {sent && <Alert type="success">{L.feedbackSent}</Alert>}
      <Button type="primary" htmlType="submit" disabled={sending}>
        {sending ? L.feedbackSending : L.submitFeedback}
      </Button>
    </form>
  );
}
