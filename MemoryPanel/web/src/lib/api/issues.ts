import { metaPost, metaListAll } from './base';
import type { BackendTask } from './tasks';

export type IssueStage = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type TriageState =
  'needs-triage' | 'needs-info' | 'ready-for-agent' | 'ready-for-human' | 'wontfix';
export interface IssueFields {
  kind: 'spec' | 'enhancement' | 'bug';
  stage: IssueStage;
  triage: TriageState;
  labels: string[];
  parent_id: string | null;
  blocked_by: string[];
  assignee_agent_id: string | null;
  milestone: string;
  acceptance: Array<{ text: string; done: boolean }>;
  evidence: string;
}
export interface Issue extends BackendTask {
  issue: IssueFields & {
    revision: number;
    comments: Array<{
      id: string;
      author_id: string;
      body: string;
      created_at: string;
      kind: 'comment' | 'event';
    }>;
  };
  unresolved_blockers: string[];
  children: Array<{ task_id: string; title: string; stage: IssueStage }>;
  progress: { done: number; cancelled: number; total: number };
  ready: boolean;
}
export interface IssueFilters {
  query?: string;
  state?: 'open' | 'closed';
  stage?: IssueStage;
  triage?: TriageState;
  label?: string;
  ready?: boolean;
  parent_id?: string;
}
export const issuesApi = {
  list: (team_id: string, filters: IssueFilters = {}, offset = 0) =>
    metaPost<{ items: Issue[]; total: number }>('issue/list', {
      team_id,
      ...filters,
      limit: 20,
      offset,
    }),
  all: (team_id: string) => metaListAll<Issue>('issue/list', { team_id }),
  get: (task_id: string) => metaPost<Issue>('issue/get', { task_id }),
  create: (team_id: string, title: string, description: string, issue: Partial<IssueFields>) =>
    metaPost<Issue>('issue/create', { team_id, title, description, issue }),
  update: (
    task: Issue,
    patch: { title?: string; description?: string; issue?: Partial<IssueFields> },
  ) =>
    metaPost<Issue>('issue/update', {
      task_id: task.task_id,
      expected_revision: task.issue.revision,
      ...patch,
    }),
  comment: (task: Issue, body: string) =>
    metaPost<Issue>('issue/comment', {
      task_id: task.task_id,
      expected_revision: task.issue.revision,
      body,
    }),
};
