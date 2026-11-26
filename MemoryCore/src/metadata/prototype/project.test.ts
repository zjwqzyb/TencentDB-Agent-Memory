import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { access, createProject, listProjects } from "./access.js";
import { publish, readContract, readPage, restore, save } from "./service.js";
import type { Definition, Snapshot } from "./schema.js";
import type { IMetadataStore } from "../store/interface.js";

describe.each(["SQLite", "MongoDB"])("prototype project on %s", (backend) => {
  let server: MongoMemoryReplSet | undefined;
  let client: MongoClient | undefined;
  let store: IMetadataStore;
  beforeAll(async () => {
    if (backend === "SQLite") store = new SqliteMetadataStore(":memory:");
    else {
      server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      client = await MongoClient.connect(server.getUri());
      store = new MongoMetadataStore(client, "prototype_project_contract");
    }
    await store.init();
  });
  afterAll(async () => {
    await store?.close();
    await client?.close();
    await server?.stop();
  });
  it("keeps blank pages, references, identities and read permissions scoped to the project", async () => {
    const svc = new MetadataService(store);
    const owner = await store.createUser({
      username: "product",
      external_id: "product",
      auth_provider: "local",
    });
    const reader = await store.createUser({
      username: "qa",
      external_id: "qa",
      auth_provider: "local",
    });
    const team = await store.createTeam({
      name: "Team",
      owner_user_id: owner.user_id,
    });
    const member = await store.addTeamMember({
      team_id: team.team_id,
      user_id: reader.user_id,
      role: "reviewer",
    });
    const editor = {
      userId: owner.user_id,
      token: "test",
      isAdmin: false,
      isSystemAdmin: false,
    };
    const viewer = { ...editor, userId: member.user_id };
    const project = {
      team_id: team.team_id,
      visibility: "team" as const,
      name: "DMS",
    };
    const { asset_id } = await createProject(svc, editor, project);
    const twin = await createProject(svc, editor, project);
    expect(twin.asset_id).not.toBe(asset_id);
    expect((await listProjects(svc, viewer, team.team_id)).items).toHaveLength(
      2,
    );
    const scope = { team_id: team.team_id, asset_id };
    const page = { ...scope, page_key: "claim-form" };
    const empty: Snapshot = {
      format_version: 1,
      views: ["create", "edit", "view"],
      components: [],
    };
    const key = { component_type: "field", contract_version: 1 };
    const def: Definition = {
      properties: { label: { type: "string", required: true } },
      slots: {},
      bindings: ["value"],
      interactions: [],
      views: empty.views,
    };
    const field = {
      id: "claimNo",
      type: "field",
      contract_version: 1,
      parent_id: null,
      slot: null,
      order: 0,
      props: { label: "索赔单号" },
      bindings: { value: "claimNo" },
    };
    const filled = { ...empty, components: [field] };
    const change = (base_version: number | null, snapshot: Snapshot) => ({
      page_key: page.page_key,
      base_version,
      snapshot,
    });
    await save(svc, editor, {
      ...scope,
      request_id: "init",
      pages: [change(null, empty)],
    });
    await publish(svc, editor, { ...scope, ...key, definition: def });
    await save(svc, editor, {
      ...scope,
      request_id: "field",
      pages: [change(1, filled)],
    });
    await publish(svc, editor, {
      ...scope,
      ...key,
      contract_version: 2,
      definition: { ...def, bindings: [] },
    });
    expect(
      (await readPage(svc, viewer, { ...page, version: 1 })).snapshot,
    ).toEqual(empty);
    expect(
      (await readPage(svc, viewer, { ...page, version: 2 })).snapshot,
    ).toEqual(filled);
    expect(
      (await readContract(svc, viewer, { ...scope, ...key })).definition,
    ).toEqual(def);
    expect((await access(svc, viewer, scope)).can_write).toBe(false);
    await expect(
      save(svc, viewer, {
        ...scope,
        request_id: "deny",
        pages: [change(2, filled)],
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      restore(svc, viewer, {
        ...page,
        request_id: "denyRestore",
        base_version: 2,
        restore_version: 1,
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      save(svc, editor, {
        ...scope,
        asset_id: twin.asset_id,
        request_id: "badRef",
        pages: [change(null, filled)],
      }),
    ).rejects.toMatchObject({ code: "invalid_prototype" });
    await expect(
      readPage(svc, viewer, { ...page, asset_id: twin.asset_id }),
    ).rejects.toMatchObject({ code: "prototype_not_found" });
  });
});
