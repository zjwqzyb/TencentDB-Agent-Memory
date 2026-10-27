import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer } from 'tea-component';
import {
  CircleDot,
  CheckCircle2,
  Plus,
  Search,
  GitBranch,
  MessageSquare,
  Circle,
  Check,
  ArrowUpRight,
  ListChecks,
  FileText,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  issuesApi,
  type Issue,
  type IssueFields,
  type IssueFilters,
  type IssueStage,
  type TriageState,
} from '@/lib/api/issues';
import { participationLogsApi, type ParticipationLogEntity } from '@/lib/api/tasks';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { useTeams } from '@/services';
import { TeamHeaderCard } from '@/components/team/TeamHeaderCard';
import { invalidateBackendCache } from '@/stores/backend';
import type { AgentOption } from '../utils/workbench-utils';
import '../styles/issue-workbench.css';
import TaskImportDialog from './TaskImportDialog';
import { taskSourceApi, type TaskSourceProvider } from '@/lib/api/taskSource';

const stages: IssueStage[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
const triages: TriageState[] = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];
function useWords() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const words = (cn: string, en: string) => (zh ? cn : en);
  const stageLabel = (s: IssueStage) =>
    zh
      ? {
          backlog: '待规划',
          todo: '待开发',
          in_progress: '开发中',
          in_review: '待验收',
          done: '已完成',
          cancelled: '已取消',
        }[s]
      : s.replaceAll('_', ' ');
  const triageLabel = (s: TriageState) =>
    zh
      ? {
          'needs-triage': '待评估',
          'needs-info': '待补充信息',
          'ready-for-agent': '可由 AI 处理',
          'ready-for-human': '需人工处理',
          wontfix: '暂不处理',
        }[s]
      : s.replaceAll('-', ' ');
  const kindLabel = (s: IssueFields['kind']) =>
    zh
      ? { spec: '需求', enhancement: '功能改进', bug: '缺陷' }[s]
      : { spec: 'Specification', enhancement: 'Enhancement', bug: 'Bug' }[s];
  return { words, stageLabel, triageLabel, kindLabel };
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const markdown = (body: string) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
);

export default function IssueWorkbench({
  teamId,
  agents,
}: {
  teamId: string;
  agents: AgentOption[];
}) {
  const { words: w, stageLabel, triageLabel, kindLabel } = useWords();
  const { activeTeam } = useTeams();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<IssueFilters>({ state: 'open' });
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<Issue[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [providers, setProviders] = useState<TaskSourceProvider[]>([]);
  const [importProvider, setImportProvider] = useState('');
  useEffect(() => {
    let alive = true;
    taskSourceApi
      .providers(teamId)
      .then((r) => {
        if (alive) setProviders(r.providers ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [teamId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => ({ ...f, query }));
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    issuesApi
      .list(teamId, filters, page * 20)
      .then((result) => {
        if (!alive) return;
        setItems(result.items);
        setTotal(result.total);
        if (page > 0 && result.items.length === 0)
          setPage(Math.max(0, Math.ceil(result.total / 20) - 1));
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [teamId, filters, page, refresh]);
  function changed() {
    setRefresh((n) => n + 1);
    invalidateBackendCache();
  }
  function filter(patch: Partial<IssueFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  }
  return (
    <div className="_memory-workbench-body issue-workbench">
      {activeTeam && <TeamHeaderCard team={activeTeam} />}
      <section className="_memory-panel-card">
        <header className="issue-header">
          <div>
            <h2>
              {w('任务', 'Tasks')} <span className="issue-count">{total}</span>
            </h2>
            <p>
              {w(
                '从需求到验收，跟踪 AI 的每一步交付。',
                'Track AI delivery from specification to verification.',
              )}
            </p>
          </div>
          <div className="issue-actions">
            {providers.length > 0 && (
              <label>
                {w('导入任务', 'Import tasks')}
                <select
                  aria-label={w('选择导入来源', 'Choose import source')}
                  value=""
                  onChange={(e) => setImportProvider(e.target.value)}
                >
                  <option value="">{w('选择来源', 'Choose source')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              type="primary"
              onClick={() => {
                setParentId(null);
                setCreating(true);
              }}
            >
              <Plus size={16} /> {w('新建任务', 'New task')}
            </Button>
          </div>
        </header>
        <div className="issue-filters">
          <label className="issue-search">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label={w('搜索任务', 'Search tasks')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={w('搜索标题、描述或 ID', 'Search title, description or ID')}
            />
          </label>
          <label>
            {w('范围', 'Scope')}
            <select
              value={filters.ready ? 'ready' : (filters.state ?? 'all')}
              onChange={(e) =>
                filter({
                  ready: e.target.value === 'ready' ? true : undefined,
                  state: ['open', 'closed'].includes(e.target.value)
                    ? (e.target.value as 'open' | 'closed')
                    : undefined,
                })
              }
            >
              <option value="open">{w('未关闭', 'Open')}</option>
              <option value="closed">{w('已关闭', 'Closed')}</option>
              <option value="all">{w('全部', 'All')}</option>
              <option value="ready">{w('AI 可领取', 'Ready for agent')}</option>
            </select>
          </label>
          <label>
            {w('阶段', 'Stage')}
            <select
              value={filters.stage ?? ''}
              onChange={(e) => filter({ stage: (e.target.value as IssueStage) || undefined })}
            >
              <option value="">{w('全部阶段', 'All stages')}</option>
              {stages.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {w('处理方式', 'Routing')}
            <select
              value={filters.triage ?? ''}
              onChange={(e) => filter({ triage: (e.target.value as TriageState) || undefined })}
            >
              <option value="">{w('全部方式', 'All routing states')}</option>
              {triages.map((s) => (
                <option key={s} value={s}>
                  {triageLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <div role="alert" className="issue-error">
            {error} <Button onClick={changed}>{w('重试', 'Retry')}</Button>
          </div>
        )}
        <div aria-busy={loading} className="issue-list">
          {loading ? (
            <p role="status" className="issue-empty">
              {w('正在加载任务…', 'Loading tasks…')}
            </p>
          ) : !error && items.length === 0 ? (
            <p className="issue-empty">
              {w(
                '没有符合条件的任务。可以调整筛选或创建新任务。',
                'No matching tasks. Adjust filters or create a task.',
              )}
            </p>
          ) : (
            !error &&
            items.map((task) => (
              <button
                className="issue-row"
                key={task.task_id}
                onClick={() => setSelectedId(task.task_id)}
              >
                <span className={`issue-state issue-state--${task.status}`}>
                  {task.status === 'completed' ? (
                    <CheckCircle2 size={20} />
                  ) : (
                    <CircleDot size={20} />
                  )}
                </span>
                <span className="issue-row-main">
                  <span className="issue-row-title">
                    {task.title}
                    <span className={`issue-badge issue-kind--${task.issue.kind}`}>
                      {kindLabel(task.issue.kind)}
                    </span>
                    {task.issue.labels.map((label) => (
                      <span key={label} className="issue-badge">
                        {label}
                      </span>
                    ))}
                  </span>
                  <span className="issue-row-meta">
                    {task.task_id} · {triageLabel(task.issue.triage)}
                    {task.issue.milestone && ` · ${task.issue.milestone}`}
                  </span>
                  {task.unresolved_blockers.length > 0 && (
                    <span className="issue-blocked">
                      {w('等待依赖', 'Blocked by')} {task.unresolved_blockers.length}{' '}
                      {w('项', 'tasks')}
                    </span>
                  )}
                </span>
                <span className="issue-row-end">
                  <span className={`issue-stage issue-stage--${task.issue.stage}`}>
                    {stageLabel(task.issue.stage)}
                  </span>
                  {task.progress.total > 0 && (
                    <span>
                      <GitBranch size={14} /> {task.progress.done}/{task.progress.total}
                    </span>
                  )}
                  <span>
                    <MessageSquare size={14} />{' '}
                    {task.issue.comments.filter((c) => c.kind === 'comment').length}
                  </span>
                  {task.ready && (
                    <span className="issue-badge issue-ready">{w('可领取', 'Ready')}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="issue-pagination">
          <span>
            {total} {w('条任务', 'tasks')} · {page + 1} / {Math.max(1, Math.ceil(total / 20))}
          </span>
          <Button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
            {w('上一页', 'Previous')}
          </Button>
          <Button
            disabled={(page + 1) * 20 >= total || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {w('下一页', 'Next')}
          </Button>
        </footer>
      </section>
      {importProvider && (
        <TaskImportDialog
          teamId={teamId}
          providers={providers}
          providerId={importProvider}
          onClose={() => setImportProvider('')}
          onImported={changed}
        />
      )}
      <Drawer
        style={{ width: 'min(1120px, 100vw)', maxWidth: '100vw' }}
        visible={!!selectedId}
        title={w('任务详情', 'Task details')}
        size="l"
        onClose={() => setSelectedId(null)}
        destroyOnClose
      >
        {selectedId && (
          <IssueDetail
            key={selectedId}
            id={selectedId}
            teamId={teamId}
            agents={agents}
            onChange={changed}
            onSelect={setSelectedId}
            onCreateChild={() => {
              setParentId(selectedId);
              setCreating(true);
            }}
          />
        )}
      </Drawer>
      <Drawer
        style={{ maxWidth: '100vw' }}
        visible={creating}
        title={w('新建任务', 'New task')}
        size="l"
        onClose={() => setCreating(false)}
        destroyOnClose
      >
        {creating && (
          <IssueCreate
            teamId={teamId}
            parentId={parentId}
            onCreated={(task) => {
              setCreating(false);
              setSelectedId(task.task_id);
              changed();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function IssueCreate({
  teamId,
  parentId,
  onCreated,
}: {
  teamId: string;
  parentId: string | null;
  onCreated: (task: Issue) => void;
}) {
  const { words: w } = useWords();
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState('');
  const [kind, setKind] = useState<IssueFields['kind']>('enhancement');
  const [acceptance, setAcceptance] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="issue-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          onCreated(
            await issuesApi.create(teamId, title, description, {
              kind,
              parent_id: parentId,
              acceptance: acceptance
                .split('\n')
                .map((t) => t.trim())
                .filter(Boolean)
                .map((text) => ({ text, done: false })),
            }),
          );
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        {parentId && (
          <p>
            {w('父任务', 'Parent task')}: {parentId}
          </p>
        )}
        <label>
          {w('标题', 'Title')}
          <input
            required
            maxLength={500}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          {w('类型', 'Type')}
          <select value={kind} onChange={(e) => setKind(e.target.value as IssueFields['kind'])}>
            <option value="enhancement">{w('功能 / 改进', 'Enhancement')}</option>
            <option value="bug">Bug</option>
            <option value="spec">{w('需求 / Spec', 'Specification')}</option>
          </select>
        </label>
        <label>
          {w('描述（Markdown）', 'Description (Markdown)')}
          <textarea
            rows={9}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={w(
              '描述目标、范围和预期行为',
              'Describe the goal, scope and expected behavior',
            )}
          />
        </label>
        <label>
          {w('验收条件（每行一项）', 'Acceptance criteria (one per line)')}
          <textarea rows={4} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="issue-error">
            {error}
          </p>
        )}
        <button type="submit" className="issue-primary" disabled={busy || !title.trim()}>
          {busy ? w('创建中…', 'Creating…') : w('创建任务', 'Create task')}
        </button>
      </fieldset>
    </form>
  );
}

function IssueDetail({
  id,
  teamId,
  agents,
  onChange,
  onSelect,
  onCreateChild,
}: {
  id: string;
  teamId: string;
  agents: AgentOption[];
  onChange: () => void;
  onSelect: (id: string) => void;
  onCreateChild: () => void;
}) {
  const { words: w, stageLabel, triageLabel, kindLabel } = useWords();
  const [task, setTask] = useState<Issue | null>(null),
    [options, setOptions] = useState<Issue[]>([]);
  const [draft, setDraft] = useState<IssueFields | null>(null);
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [comment, setComment] = useState(''),
    [criterion, setCriterion] = useState('');
  const [labelText, setLabelText] = useState('');
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [participation, setParticipation] = useState<ParticipationLogEntity[]>([]);
  const resolveUserName = useDisplayNameResolver();
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [error]);
  useEffect(() => {
    let alive = true;
    setError('');
    Promise.all([
      issuesApi.get(id),
      issuesApi.all(teamId),
      participationLogsApi.listByTask(teamId, id),
    ])
      .then(([value, all, logs]) => {
        if (value.team_id !== teamId) throw new Error('This task belongs to another team');
        if (alive) {
          setTask(value);
          setDraft(value.issue);
          setTitle(value.title);
          setDescription(value.description ?? '');
          setLabelText(value.issue.labels.join(', '));
          setOptions(all);
          setParticipation(logs);
          setEditing(false);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [id, teamId, reload]);
  async function mutate(fn: () => Promise<Issue>) {
    setBusy(true);
    setError('');
    try {
      const value = await fn();
      setTask(value);
      setDraft(value.issue);
      setTitle(value.title);
      setDescription(value.description ?? '');
      setLabelText(value.issue.labels.join(', '));
      setEditing(false);
      onChange();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function patch<K extends keyof IssueFields>(key: K, value: IssueFields[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }
  const errorBlock = error && (
    <div role="alert" tabIndex={-1} ref={errorRef} className="issue-error">
      {error}{' '}
      <Button onClick={() => setReload((n) => n + 1)}>
        {w('重新加载（放弃草稿）', 'Reload (discard draft)')}
      </Button>
    </div>
  );
  if (!task || !draft)
    return (
      <div className="issue-detail">
        {errorBlock || <p role="status">{w('正在加载…', 'Loading…')}</p>}
      </div>
    );
  return (
    <div className="issue-detail">
      {errorBlock}
      <div className="issue-detail-heading">
        <h2>{task.title}</h2>
        <div className="issue-detail-meta">
          <span className={`issue-stage issue-stage--${task.issue.stage}`}>
            {stageLabel(task.issue.stage)}
          </span>
          <span className="issue-badge">{kindLabel(task.issue.kind)}</span>
          <code>{task.task_id}</code>
          <span>
            {w('版本', 'Revision')} {task.issue.revision}
          </span>
        </div>
      </div>
      <div className="issue-actions">
        <Button
          disabled={busy}
          onClick={() => {
            setDraft(task.issue);
            setTitle(task.title);
            setDescription(task.description ?? '');
            setLabelText(task.issue.labels.join(', '));
            setEditing(!editing);
          }}
        >
          {editing ? w('取消编辑', 'Cancel editing') : w('编辑任务', 'Edit task')}
        </Button>
        <Button disabled={busy} onClick={onCreateChild}>
          {w('创建子任务', 'Create subtask')}
        </Button>
      </div>
      <div
        className={
          editing ? 'issue-detail-content issue-detail-content--editing' : 'issue-detail-content'
        }
      >
        {editing ? (
          <form
            className="issue-form"
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(() =>
                issuesApi.update(task, {
                  title,
                  description,
                  issue: {
                    ...draft,
                    labels: labelText
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                }),
              );
            }}
          >
            <fieldset disabled={busy}>
              <label>
                {w('标题', 'Title')}
                <input
                  required
                  maxLength={500}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                {w('描述（Markdown）', 'Description (Markdown)')}
                <textarea
                  rows={8}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <div className="issue-field-grid">
                <label>
                  {w('类型', 'Type')}
                  <select
                    value={draft.kind}
                    onChange={(e) => patch('kind', e.target.value as IssueFields['kind'])}
                  >
                    {(['spec', 'enhancement', 'bug'] as const).map((k) => (
                      <option key={k} value={k}>
                        {kindLabel(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {w('阶段', 'Stage')}
                  <select
                    value={draft.stage}
                    onChange={(e) => patch('stage', e.target.value as IssueStage)}
                  >
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {stageLabel(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {w('处理方式', 'Routing')}
                  <select
                    value={draft.triage}
                    onChange={(e) => patch('triage', e.target.value as TriageState)}
                  >
                    {triages.map((s) => (
                      <option key={s} value={s}>
                        {triageLabel(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {w('负责 Agent', 'Assigned agent')}
                  <select
                    value={draft.assignee_agent_id ?? ''}
                    onChange={(e) => patch('assignee_agent_id', e.target.value || null)}
                  >
                    <option value="">{w('未指派', 'Unassigned')}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                {w('父任务', 'Parent task')}
                <select
                  value={draft.parent_id ?? ''}
                  onChange={(e) => patch('parent_id', e.target.value || null)}
                >
                  <option value="">{w('无', 'None')}</option>
                  {options
                    .filter((t) => t.task_id !== id)
                    .map((t) => (
                      <option key={t.task_id} value={t.task_id}>
                        {t.title} ({t.task_id})
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {w('依赖（可多选）', 'Blocked by (multiple)')}
                <select
                  multiple
                  size={Math.min(5, Math.max(2, options.length))}
                  value={draft.blocked_by}
                  onChange={(e) =>
                    patch(
                      'blocked_by',
                      Array.from(e.target.selectedOptions, (o) => o.value),
                    )
                  }
                >
                  {options
                    .filter((t) => t.task_id !== id)
                    .map((t) => (
                      <option key={t.task_id} value={t.task_id}>
                        {t.title} ({stageLabel(t.issue.stage)})
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {w('里程碑', 'Milestone')}
                <input
                  maxLength={120}
                  value={draft.milestone}
                  onChange={(e) => patch('milestone', e.target.value)}
                />
              </label>
              <label>
                {w('标签（逗号分隔）', 'Labels (comma separated)')}
                <input value={labelText} onChange={(e) => setLabelText(e.target.value)} />
              </label>
              <h3>{w('验收清单', 'Acceptance criteria')}</h3>
              {draft.acceptance.map((a, i) => (
                <div className="issue-check" key={i}>
                  <label>
                    <input
                      type="checkbox"
                      checked={a.done}
                      onChange={(e) =>
                        patch(
                          'acceptance',
                          draft.acceptance.map((row, n) =>
                            n === i ? { ...row, done: e.target.checked } : row,
                          ),
                        )
                      }
                    />
                    {a.text}
                  </label>
                  <Button
                    onClick={() =>
                      patch(
                        'acceptance',
                        draft.acceptance.filter((_, n) => n !== i),
                      )
                    }
                  >
                    {w('移除', 'Remove')}
                  </Button>
                </div>
              ))}
              <label>
                {w('新增验收条件', 'Add acceptance criterion')}
                <input value={criterion} onChange={(e) => setCriterion(e.target.value)} />
              </label>
              <Button
                disabled={!criterion.trim()}
                onClick={() => {
                  patch('acceptance', [
                    ...draft.acceptance,
                    { text: criterion.trim(), done: false },
                  ]);
                  setCriterion('');
                }}
              >
                {w('添加条件', 'Add criterion')}
              </Button>
              <label>
                {w('验证记录（完成前必填）', 'Verification evidence (required to complete)')}
                <textarea
                  rows={4}
                  value={draft.evidence}
                  onChange={(e) => patch('evidence', e.target.value)}
                  placeholder={w(
                    '记录测试命令、结果、提交或 PR 链接',
                    'Record test commands, results, commit or PR links',
                  )}
                />
              </label>
              <button type="submit" className="issue-primary" disabled={busy}>
                {busy ? w('保存中…', 'Saving…') : w('保存修改', 'Save changes')}
              </button>
            </fieldset>
          </form>
        ) : (
          <>
            <div className="issue-main">
              <section className="issue-section">
                <h3>
                  <FileText size={18} aria-hidden="true" />
                  {w('任务描述', 'Description')}
                </h3>
                <div className="issue-markdown">
                  {markdown(task.description || w('暂无描述', 'No description'))}
                </div>
              </section>
              {task.issue.blocked_by.length > 0 && (
                <section className="issue-section">
                  <h3>
                    <GitBranch size={18} aria-hidden="true" />
                    {w('前置任务', 'Dependencies')}
                  </h3>
                  {task.issue.blocked_by.map((dep) => (
                    <button key={dep} className="issue-related-row" onClick={() => onSelect(dep)}>
                      <span>{options.find((t) => t.task_id === dep)?.title ?? dep}</span>
                      <span
                        className={`issue-stage issue-stage--${task.unresolved_blockers.includes(dep) ? 'backlog' : 'done'}`}
                      >
                        {task.unresolved_blockers.includes(dep)
                          ? w('等待完成', 'Waiting')
                          : w('已完成', 'Done')}
                      </span>
                    </button>
                  ))}
                </section>
              )}
              {task.children.length > 0 && (
                <section className="issue-section">
                  <div className="issue-section-heading">
                    <h3>
                      <GitBranch size={18} aria-hidden="true" />
                      {w('子任务', 'Subtasks')}
                    </h3>
                    <span>
                      {task.progress.done} / {task.progress.total} {w('已完成', 'done')}
                      {task.progress.cancelled > 0 &&
                        ` · ${task.progress.cancelled} ${w('已取消', 'cancelled')}`}
                    </span>
                  </div>
                  <progress
                    className="issue-progress"
                    max={task.progress.total}
                    value={task.progress.done}
                    aria-label={w('子任务完成进度', 'Subtask completion')}
                  />
                  <div className="issue-related-list">
                    {task.children.map((child) => (
                      <button
                        key={child.task_id}
                        className="issue-related-row"
                        onClick={() => onSelect(child.task_id)}
                      >
                        {child.stage === 'done' ? (
                          <CheckCircle2 size={17} aria-hidden="true" />
                        ) : (
                          <CircleDot size={17} aria-hidden="true" />
                        )}
                        <span>{child.title}</span>
                        <span className={`issue-stage issue-stage--${child.stage}`}>
                          {stageLabel(child.stage)}
                        </span>
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {task.issue.acceptance.length > 0 && (
                <section className="issue-section">
                  <div className="issue-section-heading">
                    <h3>
                      <ListChecks size={18} aria-hidden="true" />
                      {w('验收清单', 'Acceptance criteria')}
                    </h3>
                    <span>
                      {task.issue.acceptance.filter((a) => a.done).length} /{' '}
                      {task.issue.acceptance.length}
                    </span>
                  </div>
                  <ul className="issue-acceptance">
                    {task.issue.acceptance.map((a, i) => (
                      <li key={i} className={a.done ? 'is-done' : ''}>
                        {a.done ? (
                          <Check size={18} aria-hidden="true" />
                        ) : (
                          <Circle size={18} aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {a.done ? w('已完成：', 'Completed: ') : w('未完成：', 'Incomplete: ')}
                        </span>
                        <span>{a.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {task.issue.evidence && (
                <section className="issue-section issue-evidence">
                  <h3>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    {w('验证记录', 'Verification evidence')}
                  </h3>
                  <div className="issue-markdown">{markdown(task.issue.evidence)}</div>
                </section>
              )}
            </div>
            <aside className="issue-sidebar" aria-label={w('任务属性', 'Task properties')}>
              <h3>{w('任务属性', 'Task properties')}</h3>
              <dl className="issue-properties">
                <dt>{w('处理方式', 'Routing')}</dt>
                <dd>{triageLabel(task.issue.triage)}</dd>
                <dt>{w('创建者', 'Created by')}</dt>
                <dd>{resolveUserName(task.creator_user_id)}</dd>
                <dt>{w('参与者', 'Participants')}</dt>
                <dd>
                  {[...new Set(participation.map((p) => p.user_id))]
                    .map(resolveUserName)
                    .join(', ') || '—'}
                </dd>
                <dt>{w('参与 Agent', 'Observed agents')}</dt>
                <dd>
                  {[...new Set(participation.map((p) => p.agent_id))]
                    .map((id) => agents.find((a) => a.id === id)?.name ?? id)
                    .join(', ') || '—'}
                </dd>
                {task.source_url && /^https?:\/\//i.test(task.source_url.trim()) && (
                  <>
                    <dt>{w('来源', 'Source')}</dt>
                    <dd>
                      <a href={task.source_url.trim()} target="_blank" rel="noopener noreferrer">
                        {w('打开来源任务', 'Open source task')}
                      </a>
                    </dd>
                  </>
                )}
                <dt>{w('负责 Agent', 'Assigned agent')}</dt>
                <dd>
                  {agents.find((a) => a.id === task.issue.assignee_agent_id)?.name ??
                    task.issue.assignee_agent_id ??
                    w('未指派', 'Unassigned')}
                </dd>
                <dt>{w('里程碑', 'Milestone')}</dt>
                <dd>{task.issue.milestone || '—'}</dd>
                <dt>{w('标签', 'Labels')}</dt>
                <dd className="issue-labels">
                  {task.issue.labels.length
                    ? task.issue.labels.map((label) => (
                        <span className="issue-badge" key={label}>
                          {label}
                        </span>
                      ))
                    : '—'}
                </dd>
              </dl>
              {task.issue.parent_id && (
                <div className="issue-parent">
                  <h4>{w('父任务', 'Parent task')}</h4>{' '}
                  <button className="issue-link" onClick={() => onSelect(task.issue.parent_id!)}>
                    {options.find((t) => t.task_id === task.issue.parent_id)?.title ??
                      task.issue.parent_id}
                  </button>
                </div>
              )}
            </aside>
          </>
        )}
        <section className="issue-timeline issue-section">
          <h3>
            <MessageSquare size={18} aria-hidden="true" />
            {w('活动与讨论', 'Activity and discussion')}
          </h3>
          {task.issue.comments.length === 0 && (
            <p>
              {w(
                '暂无活动。可以记录进展、阻塞原因或交接信息。',
                'No activity yet. Record progress, blockers or handoff notes.',
              )}
            </p>
          )}
          {task.issue.comments.map((c) => (
            <article key={c.id} className={`issue-comment issue-comment--${c.kind}`}>
              <header>
                <span className="issue-comment-author">{resolveUserName(c.author_id)}</span> ·{' '}
                <time dateTime={c.created_at}>{new Date(c.created_at).toLocaleString()}</time>
              </header>
              <div className="issue-markdown">{markdown(c.body)}</div>
            </article>
          ))}
          <form
            className="issue-form issue-comment-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await mutate(() => issuesApi.comment(task, comment))) setComment('');
            }}
          >
            <label>
              {w('发表评论（Markdown）', 'Add comment (Markdown)')}
              <textarea
                rows={4}
                value={comment}
                disabled={busy || editing}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            <button
              className="issue-primary"
              type="submit"
              disabled={busy || editing || !comment.trim()}
            >
              {w('发表评论', 'Comment')}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
