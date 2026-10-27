import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { issueCreateSchema, issueUpdateSchema } from "./issue-schemas.js";
import type { V3AuthContext } from "../router/auth.js";

let server: MongoMemoryReplSet, client: MongoClient, store: MongoMetadataStore;
let svc: MetadataService,
  second: MetadataService,
  ctx: V3AuthContext,
  teamId: string;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
  store = new MongoMetadataStore(client, "issue_test");
  await store.init();
  svc = new MetadataService(store);
  second = new MetadataService(store);
  const user = await store.createUser({
    auth_provider: "local",
    external_id: "mongo",
    username: "mongo",
  });
  teamId = (
    await store.createTeam({
      name: "Mongo project",
      owner_user_id: user.user_id,
    })
  ).team_id;
  ctx = {
    token: "test",
    userId: user.user_id,
    isAdmin: false,
    isSystemAdmin: false,
  };
});
afterAll(async () => {
  await client?.close();
  await server?.stop();
});
it("MongoDB protects comments with atomic revision checks", async () => {
  const task = await svc.issues.create(
    issueCreateSchema.parse({ team_id: teamId, title: "Concurrent comments" }),
    ctx,
  );
  const results = await Promise.allSettled(
    [svc, second].map((s) =>
      s.issues.comment(
        { task_id: task.task_id, expected_revision: 1, body: "Comment" },
        ctx,
      ),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await svc.issues.get(task.task_id, ctx)).issue.comments).toHaveLength(
    1,
  );
});
it("MongoDB rejects cross-service graph write skew", async () => {
  const a = await svc.issues.create(
    issueCreateSchema.parse({ team_id: teamId, title: "A" }),
    ctx,
  );
  const b = await svc.issues.create(
    issueCreateSchema.parse({ team_id: teamId, title: "B" }),
    ctx,
  );
  const results = await Promise.allSettled([
    svc.issues.update(
      issueUpdateSchema.parse({
        task_id: a.task_id,
        expected_revision: 1,
        issue: { blocked_by: [b.task_id] },
      }),
      ctx,
    ),
    second.issues.update(
      issueUpdateSchema.parse({
        task_id: b.task_id,
        expected_revision: 1,
        issue: { blocked_by: [a.task_id] },
      }),
      ctx,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});
