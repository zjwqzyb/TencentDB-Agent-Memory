import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { issueCreateSchema, issueUpdateSchema } from "./issue-schemas.js";
import type { V3AuthContext } from "../router/auth.js";
import type { IssueFields, IssueView } from "./issue-model.js";

let store: SqliteMetadataStore,
  svc: MetadataService,
  ctx: V3AuthContext,
  teamId: string;
async function create(title: string, issue: Partial<IssueFields> = {}) {
  return svc.issues.create(
    issueCreateSchema.parse({ team_id: teamId, title, issue }),
    ctx,
  );
}
async function update(task: IssueView, issue: Partial<IssueFields>) {
  return svc.issues.update(
    issueUpdateSchema.parse({
      task_id: task.task_id,
      expected_revision: task.issue.revision,
      issue,
    }),
    ctx,
  );
}
beforeEach(() => {
  store = new SqliteMetadataStore(":memory:");
  store.init();
  svc = new MetadataService(store);
  const user = store.createUser({
    auth_provider: "local",
    external_id: "owner",
    username: "owner",
  });
  teamId = store.createTeam({
    name: "Project",
    owner_user_id: user.user_id,
  }).team_id;
  ctx = {
    token: "test",
    userId: user.user_id,
    isAdmin: false,
    isSystemAdmin: false,
  };
});
afterEach(() => store.close());

describe("Issue development workflow", () => {
  it("keeps task identity and preserves legacy metadata during migration", async () => {
    const legacy = store.createTask({
      team_id: teamId,
      creator_user_id: ctx.userId!,
      title: "Legacy",
      metadata_json:
        '{"external":{"provider":"tapd"},"ui":{"participants":[]}}',
    });
    const issue = await svc.issues.get(legacy.task_id, ctx);
    expect(issue.issue.stage).toBe("in_progress");
    expect(issue.issue.revision).toBe(0);
    const edited = await update(issue, { milestone: "v1" });
    expect(edited.task_id).toBe(legacy.task_id);
    expect(JSON.parse(edited.metadata_json).external.provider).toBe("tapd");
    expect(edited.issue.stage).toBe("in_progress");
  });

  it("preserves historical completed tasks, external metadata and session participation", async () => {
    const agent = store.createAgent({
      team_id: teamId,
      owner_user_id: ctx.userId!,
      name: "Legacy agent",
    });
    const legacy = store.createTask({
      team_id: teamId,
      creator_user_id: ctx.userId!,
      title: "Historical completion",
      status: "completed",
      description: "Original description",
      source_type: "external",
      source_url: "https://tracker.example/task/42",
      linked_agents: [{ agent_id: agent.agent_id }],
      metadata_json:
        '{"external":{"provider":"tapd","id":"42"},"ui":{"participants":["owner"]}}',
    });
    const log = store.appendParticipationLog({
      team_id: teamId,
      task_id: legacy.task_id,
      agent_id: agent.agent_id,
      user_id: ctx.userId!,
      source: "session_init",
      metadata_json: '{"session_id":"historical-session"}',
    });
    let task = await svc.issues.get(legacy.task_id, ctx);
    expect(task.issue).toMatchObject({
      stage: "done",
      revision: 0,
      evidence: "",
    });
    expect(store.getTaskById(legacy.task_id)).toEqual(legacy); // Reading does not migrate storage.
    expect(
      (
        await svc.issues.list({ team_id: teamId, state: "closed" }, ctx)
      ).items.map((t) => t.task_id),
    ).toContain(legacy.task_id);
    // Comments may be the first write to a historical task.
    task = await svc.issues.comment(
      { task_id: task.task_id, expected_revision: 0, body: "Archive note" },
      ctx,
    );
    task = await svc.issues.update(
      issueUpdateSchema.parse({
        task_id: task.task_id,
        expected_revision: task.issue.revision,
        title: "Updated historical title",
      }),
      ctx,
    );
    task = await update(task, { labels: ["historical"] });
    expect(task).toMatchObject({
      task_id: legacy.task_id,
      status: "completed",
      source_type: "external",
      source_url: legacy.source_url,
      description: legacy.description,
      created_at: legacy.created_at,
    });
    expect(task.issue.evidence).toBe(""); // Never invent old verification evidence.
    expect(JSON.parse(task.metadata_json)).toMatchObject(
      JSON.parse(legacy.metadata_json),
    );
    expect(
      store.listTaskAgents(task.task_id).items.map((a) => a.agent_id),
    ).toContain(agent.agent_id);
    expect(
      store.listParticipationLogs({ team_id: teamId, task_id: task.task_id })
        .items,
    ).toEqual([log]);
    await expect(
      update(task, { acceptance: [{ text: "New check", done: false }] }),
    ).rejects.toThrow("acceptance");
    const blocker = await create("Unfinished dependency");
    await expect(
      update(task, { blocked_by: [blocker.task_id] }),
    ).rejects.toThrow("Resolve blockers");
    task = await update(task, { stage: "todo" });
    await expect(update(task, { stage: "done" })).rejects.toThrow("evidence");
    task = await update(task, {
      stage: "done",
      evidence: "Reverified after reopening",
    });
    await expect(update(task, { evidence: "" })).rejects.toThrow("evidence");
  });

  it("PATCH omits defaults and cannot reset unrelated fields", async () => {
    const task = await create("Patch", {
      labels: ["backend"],
      milestone: "release",
      triage: "ready-for-agent",
    });
    const updated = await update(task, { stage: "todo" });
    expect(updated.issue).toMatchObject({
      labels: ["backend"],
      milestone: "release",
      triage: "ready-for-agent",
      stage: "todo",
    });
  });

  it("works the ready frontier and counts completed sub-issues without closing the parent", async () => {
    const spec = await create("Specification", { kind: "spec" });
    let first = await create("First slice", {
      parent_id: spec.task_id,
      triage: "ready-for-agent",
    });
    const second = await create("Second slice", {
      parent_id: spec.task_id,
      blocked_by: [first.task_id],
      triage: "ready-for-agent",
    });
    let ready = await svc.issues.list({ team_id: teamId, ready: true }, ctx);
    expect(ready.items.map((t) => t.task_id)).toEqual([first.task_id]);
    await expect(update(second, { stage: "in_progress" })).rejects.toThrow(
      "Resolve blockers",
    );
    first = await update(first, {
      stage: "done",
      evidence: "Integration test passed",
    });
    ready = await svc.issues.list({ team_id: teamId, ready: true }, ctx);
    expect(ready.items.map((t) => t.task_id)).toEqual([second.task_id]);
    const parent = await svc.issues.get(spec.task_id, ctx);
    expect(parent.progress).toEqual({ done: 1, cancelled: 0, total: 2 });
    expect(parent.status).toBe("running");
  });

  it("rejects cycles, including a child that depends on its parent", async () => {
    const a = await create("A");
    const b = await create("B", { blocked_by: [a.task_id] });
    await expect(update(a, { blocked_by: [b.task_id] })).rejects.toThrow(
      "cycle",
    );
    await expect(
      create("Child", { parent_id: a.task_id, blocked_by: [a.task_id] }),
    ).rejects.toThrow("cycle");
    const child = await create("Child", { parent_id: a.task_id });
    await expect(update(a, { parent_id: child.task_id })).rejects.toThrow(
      "cycle",
    );
  });

  it("requires verification and completed acceptance checks", async () => {
    let task = await create("Test", {
      acceptance: [{ text: "Behavior verified", done: false }],
    });
    await expect(
      update(task, { stage: "done", evidence: "Passed" }),
    ).rejects.toThrow("acceptance");
    task = await update(task, {
      acceptance: [{ text: "Behavior verified", done: true }],
    });
    await expect(update(task, { stage: "done" })).rejects.toThrow("evidence");
    expect(
      (await update(task, { stage: "done", evidence: "Tests: 5 passed" }))
        .status,
    ).toBe("completed");
  });

  it("cancelled blockers do not unblock dependent work", async () => {
    let a = await create("A");
    const b = await create("B", {
      blocked_by: [a.task_id],
      triage: "ready-for-agent",
    });
    a = await update(a, { stage: "cancelled" });
    expect((await svc.issues.get(b.task_id, ctx)).unresolved_blockers).toEqual([
      a.task_id,
    ]);
  });

  it("filters before pagination and excludes specs from agent-ready work", async () => {
    await create("Specification", { kind: "spec", triage: "ready-for-agent" });
    for (let i = 0; i < 24; i++)
      await create(`Ticket ${i}`, {
        labels: ["release"],
        triage: "ready-for-agent",
      });
    const page = await svc.issues.list(
      { team_id: teamId, ready: true, label: "release", limit: 5, offset: 20 },
      ctx,
    );
    expect(page.total).toBe(24);
    expect(page.items).toHaveLength(4);
  });

  it("rejects cross-team reads, writes and relationship references", async () => {
    const outsider = store.createUser({
      auth_provider: "local",
      external_id: "outsider",
      username: "outsider",
    });
    const otherTeam = store.createTeam({
      name: "Other",
      owner_user_id: outsider.user_id,
    });
    const other = store.createTask({
      team_id: otherTeam.team_id,
      creator_user_id: outsider.user_id,
      title: "Private",
    });
    await expect(svc.issues.get(other.task_id, ctx)).rejects.toThrow(
      "not a team member",
    );
    await expect(
      svc.issues.list({ team_id: otherTeam.team_id }, ctx),
    ).rejects.toThrow("not a team member");
    await expect(
      create("Cross-team", { blocked_by: [other.task_id] }),
    ).rejects.toThrow("same team");
  });

  it("allows collaboration by another active team member and stamps comment authors", async () => {
    const task = await create("Shared");
    const member = store.createUser({
      auth_provider: "local",
      external_id: "member",
      username: "member",
    });
    store.addTeamMember({
      team_id: teamId,
      user_id: member.user_id,
      role: "member",
    });
    const result = await svc.issues.comment(
      { task_id: task.task_id, expected_revision: 1, body: "Progress update" },
      { ...ctx, userId: member.user_id },
    );
    expect(result.issue.comments[0].author_id).toBe(member.user_id);
    expect(result.issue.revision).toBe(2);
  });

  it("rejects stale concurrent updates instead of losing progress", async () => {
    const task = await create("Concurrent");
    const result = await Promise.allSettled([
      update(task, { stage: "todo" }),
      update(task, { milestone: "v2" }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const comments = await Promise.allSettled([
      svc.issues.comment(
        { task_id: task.task_id, expected_revision: 2, body: "First" },
        ctx,
      ),
      svc.issues.comment(
        { task_id: task.task_id, expected_revision: 2, body: "Second" },
        ctx,
      ),
    ]);
    expect(comments.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("protects history and rejects updates through the old task API", async () => {
    const task = await create("Protected");
    await expect(
      svc.updateTask(task.task_id, { status: "completed" }),
    ).rejects.toThrow("issue/update");
    await expect(svc.deleteTasks([task.task_id])).rejects.toThrow("history");
    const legacy = store.createTask({
      team_id: teamId,
      creator_user_id: ctx.userId!,
      title: "Referenced legacy",
    });
    await create("Dependent", { blocked_by: [legacy.task_id] });
    await expect(svc.deleteTasks([legacy.task_id])).rejects.toThrow(
      "referenced",
    );
  });
});

it("rejects graph write skew across independent service instances", async () => {
  const a = await create("A"),
    b = await create("B");
  const other = new MetadataService(store);
  const result = await Promise.allSettled([
    update(a, { blocked_by: [b.task_id] }),
    other.issues.update(
      issueUpdateSchema.parse({
        task_id: b.task_id,
        expected_revision: 1,
        issue: { blocked_by: [a.task_id] },
      }),
      ctx,
    ),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
});

it("does not miss blockers beyond the first storage page", async () => {
  const first = await create("Old blocker");
  for (let n = 0; n < 101; n++)
    store.createTask({
      team_id: teamId,
      creator_user_id: ctx.userId!,
      title: `Legacy ${n}`,
    });
  const issue = await create("Dependent", {
    blocked_by: [first.task_id],
    triage: "ready-for-agent",
  });
  expect(issue.unresolved_blockers).toEqual([first.task_id]);
  expect((await svc.issues.list({ team_id: teamId }, ctx)).total).toBe(103);
});

it("claims one issue atomically and requires reopening parents", async () => {
  const agent = store.createAgent({
    team_id: teamId,
    owner_user_id: ctx.userId!,
    name: "Agent",
  });
  const task = await create("Claim", {
    triage: "ready-for-agent",
    stage: "todo",
  });
  const claimed = await update(task, {
    assignee_agent_id: agent.agent_id,
    stage: "in_progress",
  });
  expect(claimed.ready).toBe(false);
  await expect(
    update(task, { assignee_agent_id: agent.agent_id }),
  ).rejects.toThrow("reload");
  const parent = await create("Closed spec", {
    kind: "spec",
    stage: "done",
    evidence: "Verified",
  });
  await expect(create("Child", { parent_id: parent.task_id })).rejects.toThrow(
    "Reopen",
  );
});
