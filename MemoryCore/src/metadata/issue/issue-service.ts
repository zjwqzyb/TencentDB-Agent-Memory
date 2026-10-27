import {
  IssueWriteConflictError,
  type IssueGraphSnapshot,
} from "../store/issue-write-guard.js";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { IMetadataStore } from "../store/interface.js";
import type { TaskEntity } from "../types.js";
import type { V3AuthContext } from "../router/auth.js";
import {
  MetadataError,
  type MetadataService,
} from "../service/metadata-service.js";
import { paginateArray, resolvePagination } from "../pagination.js";
import {
  issueView,
  issueViews,
  readIssue,
  taskMetadata,
  listTeamTasks,
  type IssueData,
  type IssueFields,
} from "./issue-model.js";
import type {
  issueCreateSchema,
  issueListSchema,
  issueUpdateSchema,
  issueCommentSchema,
} from "./issue-schemas.js";

/** Task IDs remain the identity used by sessions, memories and external imports. */
export class IssueService {
  private writes = new Map<string, Promise<unknown>>();
  constructor(
    private store: IMetadataStore,
    private metadata: MetadataService,
  ) {}

  // Serialize graph edits in this Core instance; individual writes also use storage CAS.
  private async write<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(teamId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.writes.set(teamId, next);
    try {
      return await next;
    } catch (error) {
      if (error instanceof IssueWriteConflictError)
        throw new MetadataError("issue_conflict", error.message);
      throw error;
    } finally {
      if (this.writes.get(teamId) === next) this.writes.delete(teamId);
    }
  }

  private async team(teamId: string, ctx: V3AuthContext) {
    await this.metadata.assertExternalTaskImportAllowed(teamId, ctx);
    return listTeamTasks(this.store, teamId);
  }

  private async task(id: string, ctx: V3AuthContext) {
    const task = await this.store.getTaskById(id);
    if (!task) throw new MetadataError("task_not_found", "Issue not found");
    await this.metadata.assertExternalTaskImportAllowed(task.team_id, ctx);
    return task;
  }

  async get(id: string, ctx: V3AuthContext) {
    const task = await this.task(id, ctx);
    return issueView(task, await this.team(task.team_id, ctx));
  }

  async list(input: z.infer<typeof issueListSchema>, ctx: V3AuthContext) {
    const tasks = await this.team(input.team_id, ctx);
    let items = issueViews(tasks);
    if (input.query) {
      const query = input.query.toLocaleLowerCase();
      items = items.filter((t) =>
        `${t.task_id} ${t.title} ${t.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      );
    }
    if (input.state)
      items = items.filter(
        (t) => (t.status === "completed" ? "closed" : "open") === input.state,
      );
    if (input.stage) items = items.filter((t) => t.issue.stage === input.stage);
    if (input.triage)
      items = items.filter((t) => t.issue.triage === input.triage);
    if (input.label)
      items = items.filter((t) => t.issue.labels.includes(input.label!));
    if (input.parent_id)
      items = items.filter((t) => t.issue.parent_id === input.parent_id);
    if (input.ready !== undefined)
      items = items.filter((t) => t.ready === input.ready);
    items.sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        a.task_id.localeCompare(b.task_id),
    );
    return paginateArray(items, resolvePagination(input));
  }

  private async validate(
    task: TaskEntity,
    issue: IssueData,
    tasks: TaskEntity[],
    previous?: IssueData,
  ) {
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const refs = [
      ...issue.blocked_by,
      ...(issue.parent_id ? [issue.parent_id] : []),
    ];
    for (const id of refs) {
      if (id === task.task_id || !byId.has(id)) {
        throw new MetadataError(
          "invalid_issue",
          "Relationships must reference another issue in the same team",
        );
      }
    }
    if (
      issue.parent_id &&
      ["done", "cancelled"].includes(
        readIssue(byId.get(issue.parent_id)!).stage,
      ) &&
      !["done", "cancelled"].includes(issue.stage)
    ) {
      throw new MetadataError(
        "invalid_issue",
        "Reopen the parent before adding or reopening a sub-issue",
      );
    }
    // The execution graph includes parent -> children (parents finish after children)
    // as well as ticket -> blockers. Detect mixed parent/dependency deadlocks too.
    const graph = new Map(
      tasks.map((t) => [t.task_id, [...readIssue(t).blocked_by]]),
    );
    graph.set(task.task_id, [...issue.blocked_by]);
    for (const t of tasks) {
      const parent =
        t.task_id === task.task_id ? issue.parent_id : readIssue(t).parent_id;
      if (parent) graph.get(parent)?.push(t.task_id);
    }
    if (!byId.has(task.task_id) && issue.parent_id)
      graph.get(issue.parent_id)?.push(task.task_id);
    const active = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id))
        throw new MetadataError(
          "invalid_issue",
          "Parent/dependency relationship would create a cycle",
        );
      if (visited.has(id)) return;
      active.add(id);
      for (const next of graph.get(id) ?? []) visit(next);
      active.delete(id);
      visited.add(id);
    };
    for (const id of graph.keys()) visit(id);
    if (issue.assignee_agent_id) {
      const agent = await this.store.getAgentById(issue.assignee_agent_id);
      if (
        !agent ||
        agent.team_id !== task.team_id ||
        agent.status !== "active"
      ) {
        throw new MetadataError(
          "invalid_issue",
          "Assignee must be an active agent in this team",
        );
      }
    }
    if (issue.stage === "done") {
      // Historical completed tasks predate evidence. Preserve their closure while
      // editing metadata; reopening makes the next completion require evidence.
      const historicalClosure =
        previous?.stage === "done" && !previous.evidence.trim();
      if (
        issue.acceptance.some((a) => !a.done) ||
        (!issue.evidence.trim() && !historicalClosure)
      ) {
        throw new MetadataError(
          "invalid_issue",
          "Complete all acceptance criteria and supply verification evidence before closing",
        );
      }
      const view = issueView(
        { ...task, metadata_json: JSON.stringify({ issue }) },
        tasks,
      );
      if (
        view.unresolved_blockers.length ||
        view.children.some((t) => !["done", "cancelled"].includes(t.stage))
      ) {
        throw new MetadataError(
          "invalid_issue",
          "Resolve blockers and close sub-issues before completing this issue",
        );
      }
    }
    if (
      ["in_progress", "in_review"].includes(issue.stage) &&
      issue.blocked_by.some((id) => readIssue(byId.get(id)!).stage !== "done")
    ) {
      throw new MetadataError(
        "invalid_issue",
        "Resolve blockers before starting work",
      );
    }
  }

  async create(input: z.infer<typeof issueCreateSchema>, ctx: V3AuthContext) {
    await this.team(input.team_id, ctx);
    return this.write(input.team_id, async () => {
      const tasks = await this.team(input.team_id, ctx);
      const issue: IssueData = {
        ...input.issue,
        blocked_by: [...new Set(input.issue.blocked_by)],
        labels: [...new Set(input.issue.labels)],
        revision: 1,
        comments: [],
      };
      const taskId = `tsk-${randomUUID()}`;
      const candidate = {
        task_id: taskId,
        team_id: input.team_id,
      } as TaskEntity;
      await this.validate(candidate, issue, tasks);
      const task = await this.metadata.createTaskForCaller(
        {
          issue_graph_snapshot: tasks,
          team_id: input.team_id,
          creator_user_id: ctx.userId!,
          title: input.title,
          description: input.description,
          source_url: input.source_url,
          linked_agents: input.linked_agents,
          status: ["done", "cancelled"].includes(issue.stage)
            ? "completed"
            : "running",
          metadata_json: JSON.stringify({ issue }),
        },
        ctx,
      );
      return issueView(task, [...tasks, task]);
    });
  }

  async update(input: z.infer<typeof issueUpdateSchema>, ctx: V3AuthContext) {
    const initial = await this.task(input.task_id, ctx);
    return this.write(initial.team_id, async () => {
      const task = await this.task(input.task_id, ctx);
      const previous = readIssue(task);
      if (previous.revision !== input.expected_revision)
        throw new MetadataError(
          "issue_conflict",
          "Issue changed; reload and retry",
        );
      const issue: IssueData = {
        ...previous,
        ...input.issue,
        revision: previous.revision + 1,
      };
      issue.blocked_by = [...new Set(issue.blocked_by)];
      issue.labels = [...new Set(issue.labels)];
      const tasks = await this.team(task.team_id, ctx);
      await this.validate(task, issue, tasks, previous);
      const changed = Object.keys(input.issue).filter(
        (k) =>
          JSON.stringify(previous[k as keyof IssueFields]) !==
          JSON.stringify(issue[k as keyof IssueFields]),
      );
      if (input.title !== undefined && input.title !== task.title)
        changed.push("title");
      if (
        input.description !== undefined &&
        input.description !== task.description
      )
        changed.push("description");
      if (changed.length)
        issue.comments = [
          ...previous.comments,
          {
            id: randomUUID(),
            author_id: ctx.userId!,
            kind: "event",
            created_at: new Date().toISOString(),
            body: `Updated: ${changed.join(", ")}${previous.stage !== issue.stage ? ` (${previous.stage} → ${issue.stage})` : ""}`,
          },
        ];
      const updated = await this.save(
        task,
        issue,
        {
          title: input.title,
          description: input.description,
        },
        tasks,
      );
      return issueView(
        updated,
        tasks.map((t) => (t.task_id === updated.task_id ? updated : t)),
      );
    });
  }

  async comment(input: z.infer<typeof issueCommentSchema>, ctx: V3AuthContext) {
    const task = await this.task(input.task_id, ctx);
    const previous = readIssue(task);
    if (previous.revision !== input.expected_revision)
      throw new MetadataError(
        "issue_conflict",
        "Issue changed; reload and retry",
      );
    const issue: IssueData = {
      ...previous,
      revision: previous.revision + 1,
      comments: [
        ...previous.comments,
        {
          id: randomUUID(),
          author_id: ctx.userId!,
          body: input.body,
          kind: "comment",
          created_at: new Date().toISOString(),
        },
      ],
    };
    const updated = await this.save(task, issue);
    return issueView(updated, await this.team(task.team_id, ctx));
  }

  private async save(
    task: TaskEntity,
    issue: IssueData,
    patch: Partial<TaskEntity> = {},
    graph?: IssueGraphSnapshot,
  ) {
    const updated = await this.store.compareAndSwapTask(
      task.task_id,
      task.metadata_json,
      {
        ...patch,
        metadata_json: JSON.stringify({ ...taskMetadata(task), issue }),
        status: ["done", "cancelled"].includes(issue.stage)
          ? "completed"
          : "running",
      },
      graph,
    );
    if (!updated)
      throw new MetadataError(
        "issue_conflict",
        "Issue changed; reload and retry",
      );
    return updated;
  }
}
