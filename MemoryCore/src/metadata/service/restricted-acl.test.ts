import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";

let store: SqliteMetadataStore;
let service: MetadataService;
let owner: string, member: string, team: string;
beforeEach(() => {
  store = new SqliteMetadataStore(":memory:");
  store.init();
  service = new MetadataService(store);
  owner = store.createUser({
    auth_provider: "local",
    external_id: "owner",
    username: "owner",
  }).user_id;
  member = store.createUser({
    auth_provider: "local",
    external_id: "member",
    username: "member",
  }).user_id;
  team = store.createTeam({ name: "Test team", owner_user_id: owner }).team_id;
  store.addTeamMember({ team_id: team, user_id: member, role: "member" });
  store.createAsset({
    asset_id: "wiki",
    team_id: team,
    owner_user_id: owner,
    asset_type: "llm_wiki",
    name: "Restricted wiki",
    source_type: "manual",
    visibility: "restricted",
  });
});
afterEach(() => store.close());
const check = (action: "read" | "write" = "read") =>
  service.checkAssetPermission({ user_id: member, asset_id: "wiki", action });
const grant = (permission: "read" | "write" = "read") =>
  store.grantAcl({
    asset_id: "wiki",
    subject_type: "user",
    subject_id: member,
    permission,
    granted_by: owner,
  });

describe("restricted asset explicit grants", () => {
  it("allows an explicit read grant even though the member role normally covers read", async () => {
    expect((await check()).allowed).toBe(false);
    const acl = grant();
    expect(await check()).toEqual({ allowed: true, reason: `acl:${acl.id}` });
    expect((await check("write")).allowed).toBe(false);
    store.revokeAcl(acl.id);
    expect((await check()).allowed).toBe(false);
  });
  it("allows an explicit write grant", async () => {
    grant("write");
    expect((await check("write")).allowed).toBe(true);
  });
  it("does not use a stale grant after the member leaves the team", async () => {
    grant();
    store.removeTeamMember(team, member);
    expect(await check()).toEqual({
      allowed: false,
      reason: "not_team_member",
    });
  });
  it("keeps private assets private even with a grant", async () => {
    store.updateAsset("wiki", { visibility: "private" });
    grant();
    expect((await check()).allowed).toBe(false);
  });
  it("preserves the shared asset read fast path", async () => {
    store.updateAsset("wiki", { visibility: "team" });
    const lookup = vi.spyOn(store, "listAclByAsset");
    expect((await check()).allowed).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});
