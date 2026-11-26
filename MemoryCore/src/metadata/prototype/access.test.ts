import { expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { access, createProject, listProjects } from "./access.js";

it("rechecks caller, team and independent Agent grants for every prototype read", async () => {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  try {
    const svc = new MetadataService(store);
    const owner = store.createUser({
      auth_provider: "local",
      external_id: "o",
      username: "owner",
    });
    const reader = store.createUser({
      auth_provider: "local",
      external_id: "r",
      username: "reader",
    });
    const team = store.createTeam({
      owner_user_id: owner.user_id,
      name: "test",
    });
    const makeContext = (userId: string) => ({
      userId,
      isAdmin: false,
      isSystemAdmin: false,
      token: "test",
    });
    const caller = makeContext(owner.user_id);
    const asset = await createProject(svc, caller, {
      team_id: team.team_id,
      name: "Blank",
      visibility: "team",
    });
    const scope = { team_id: team.team_id, asset_id: asset.asset_id };
    store.addTeamMember({
      team_id: team.team_id,
      user_id: reader.user_id,
      role: "member",
    });
    const agent = store.createAgent({
      team_id: team.team_id,
      owner_user_id: reader.user_id,
      name: "Agent",
    });
    const agentScope = { ...scope, agent_id: agent.agent_id };
    const who = makeContext(reader.user_id);
    expect((await access(svc, who, scope)).can_write).toBe(false);
    await expect(access(svc, who, scope, true)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(access(svc, who, agentScope)).rejects.toMatchObject({
      code: "prototype_not_found",
    });
    const grant = store.grantAcl({
      asset_id: asset.asset_id,
      subject_type: "agent",
      subject_id: agent.agent_id,
      permission: "read",
      granted_by: owner.user_id,
    });
    expect((await access(svc, who, agentScope)).user_id).toBe(reader.user_id);
    await expect(access(svc, caller, agentScope)).rejects.toMatchObject({
      code: "prototype_not_found",
    });
    store.revokeAcl(grant.id);
    await expect(access(svc, who, agentScope)).rejects.toMatchObject({
      code: "prototype_not_found",
    });
    store.updateUser(reader.user_id, { status: "inactive" });
    await expect(listProjects(svc, who, team.team_id)).rejects.toMatchObject({
      code: "prototype_not_found",
    });
    store.removeTeamMember(team.team_id, owner.user_id);
    await expect(access(svc, caller, scope, true)).rejects.toMatchObject({
      code: "prototype_not_found",
    });
    expect(await svc.getAssetForCaller(asset.asset_id, caller)).toBe(null);
  } finally {
    store.close();
  }
});
