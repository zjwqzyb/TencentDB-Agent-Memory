import { z } from "zod";
import type { IMetadataStore } from "../store/interface.js";
import type { TaskEntity } from "../types.js";

export const issueStageSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);
export const triageSchema = z.enum([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
]);
const id = z.string().trim().min(1).max(200);
export const issueFieldsSchema = z.object({
  kind: z.enum(["spec", "enhancement", "bug"]).default("enhancement"),
  stage: issueStageSchema.default("backlog"),
  triage: triageSchema.default("needs-triage"),
  labels: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  parent_id: id.nullable().default(null),
  blocked_by: z.array(id).max(100).default([]),
  assignee_agent_id: id.nullable().default(null),
  milestone: z.string().trim().max(120).default(""),
  acceptance: z
    .array(
      z.object({ text: z.string().trim().min(1).max(2000), done: z.boolean() }),
    )
    .max(100)
    .default([]),
  evidence: z.string().max(20000).default(""),
});
// Remove defaults for PATCH: omitted fields must never reset existing values.
export const issuePatchSchema = z.object({
  kind: issueFieldsSchema.shape.kind.removeDefault().optional(),
  stage: issueFieldsSchema.shape.stage.removeDefault().optional(),
  triage: issueFieldsSchema.shape.triage.removeDefault().optional(),
  labels: issueFieldsSchema.shape.labels.removeDefault().optional(),
  parent_id: issueFieldsSchema.shape.parent_id.removeDefault().optional(),
  blocked_by: issueFieldsSchema.shape.blocked_by.removeDefault().optional(),
  assignee_agent_id: issueFieldsSchema.shape.assignee_agent_id
    .removeDefault()
    .optional(),
  milestone: issueFieldsSchema.shape.milestone.removeDefault().optional(),
  acceptance: issueFieldsSchema.shape.acceptance.removeDefault().optional(),
  evidence: issueFieldsSchema.shape.evidence.removeDefault().optional(),
});
export type IssueFields = z.infer<typeof issueFieldsSchema>;
export interface IssueComment {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  kind: "comment" | "event";
}
export interface IssueData extends IssueFields {
  revision: number;
  comments: IssueComment[];
}
export interface IssueView extends TaskEntity {
  issue: IssueData;
  unresolved_blockers: string[];
  children: Array<{
    task_id: string;
    title: string;
    stage: IssueFields["stage"];
  }>;
  progress: { done: number; cancelled: number; total: number };
  ready: boolean;
}

export function taskMetadata(
  task: Pick<TaskEntity, "metadata_json">,
): Record<string, unknown> {
  try {
    const value = JSON.parse(task.metadata_json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function readIssue(task: TaskEntity): IssueData {
  const raw = taskMetadata(task).issue as Partial<IssueData> | undefined;
  if (!raw)
    return {
      ...issueFieldsSchema.parse({
        stage: task.status === "completed" ? "done" : "in_progress",
      }),
      revision: 0,
      comments: [],
    };
  // Persisted issue data is written only by IssueService. Fail closed on corrupt data.
  return {
    ...issueFieldsSchema.parse(raw),
    revision: raw.revision ?? 0,
    comments: raw.comments ?? [],
  };
}

export function issueViews(tasks: TaskEntity[]): IssueView[] {
  const issues = new Map(tasks.map((task) => [task.task_id, readIssue(task)]));
  const childrenByParent = new Map<string, IssueView["children"]>();
  for (const task of tasks) {
    const issue = issues.get(task.task_id)!;
    if (issue.parent_id) {
      const children = childrenByParent.get(issue.parent_id) ?? [];
      children.push({
        task_id: task.task_id,
        title: task.title,
        stage: issue.stage,
      });
      childrenByParent.set(issue.parent_id, children);
    }
  }
  return tasks.map((task) => {
    const issue = issues.get(task.task_id)!;
    const unresolved_blockers = issue.blocked_by.filter(
      (id) => issues.get(id)?.stage !== "done",
    );
    const children = childrenByParent.get(task.task_id) ?? [];
    return {
      ...task,
      issue,
      unresolved_blockers,
      children,
      progress: {
        done: children.filter((t) => t.stage === "done").length,
        cancelled: children.filter((t) => t.stage === "cancelled").length,
        total: children.length,
      },
      ready:
        issue.kind !== "spec" &&
        issue.triage === "ready-for-agent" &&
        !issue.assignee_agent_id &&
        ["backlog", "todo"].includes(issue.stage) &&
        unresolved_blockers.length === 0,
    };
  });
}

export function issueView(task: TaskEntity, tasks: TaskEntity[]): IssueView {
  const snapshot = tasks.filter((t) => t.task_id !== task.task_id);
  snapshot.push(task);
  return issueViews(snapshot).find((t) => t.task_id === task.task_id)!;
}

/** Stores paginate even when passed null. Walk every page before graph validation. */
export async function listTeamTasks(
  store: IMetadataStore,
  teamId: string,
): Promise<TaskEntity[]> {
  const tasks: TaskEntity[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await store.listTasksByTeam(teamId, { offset, limit: 100 });
    tasks.push(...page.items);
    if (!page.items.length || tasks.length >= page.total) return tasks;
  }
}
