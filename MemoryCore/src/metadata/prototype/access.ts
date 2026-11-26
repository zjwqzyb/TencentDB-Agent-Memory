import {
  MetadataError,
  type MetadataService,
} from "../service/metadata-service.js";
import { newExternalAssetId } from "../utils/external-asset-id.js";
import type { V3AuthContext } from "../router/auth.js";
import type { z } from "zod";
import type * as schema from "./schema.js";

function unavailable(): never {
  throw new MetadataError("prototype_not_found", "Project is unavailable");
}

export async function member(
  svc: MetadataService,
  ctx: V3AuthContext,
  teamId: string,
) {
  const userId = ctx.userId;
  if (!userId || !(await svc.activePrototypeMember(teamId, userId)))
    return unavailable();
  return userId;
}

export async function access(
  svc: MetadataService,
  ctx: V3AuthContext,
  scope: { team_id: string; asset_id: string; agent_id?: string },
  write = false,
) {
  const user_id = await member(svc, ctx, scope.team_id);
  const asset = await svc.getAssetById(scope.asset_id);
  if (
    asset?.asset_type !== "prototype" ||
    asset.team_id !== scope.team_id ||
    asset.status !== "approved"
  )
    return unavailable();
  const permission = { asset_id: asset.asset_id, user_id };
  const canWrite = (
    await svc.checkAssetPermission({ ...permission, action: "write" })
  ).allowed;
  if (
    !canWrite &&
    !(await svc.checkAssetPermission({ ...permission, action: "read" })).allowed
  )
    return unavailable();
  if (
    scope.agent_id &&
    !(
      await svc.checkAssetPermission({
        ...permission,
        action: "read",
        agent_id: scope.agent_id,
      })
    ).allowed
  )
    return unavailable();
  if (write && (!canWrite || scope.agent_id))
    throw new MetadataError("permission_denied", "Project is read-only");
  return { asset, user_id, can_write: canWrite && !scope.agent_id };
}

export async function createProject(
  svc: MetadataService,
  ctx: V3AuthContext,
  input: z.infer<typeof schema.projectCreate>,
) {
  const owner_user_id = await member(svc, ctx, input.team_id);
  return svc.createAsset({
    ...input,
    asset_id: newExternalAssetId("prototype"),
    asset_type: "prototype",
    owner_user_id,
    source_type: "prototype",
    status: "approved",
  });
}

export async function listProjects(
  svc: MetadataService,
  ctx: V3AuthContext,
  team_id: string,
) {
  await member(svc, ctx, team_id);
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const page = await svc.rawStore.listAssetsByTeam(
      team_id,
      { offset, limit: 100 },
      { asset_type: "prototype", status: "approved" },
    );
    for (const asset of page.items) {
      const visible = await svc.getAssetForCaller(asset.asset_id, ctx);
      if (visible) items.push(visible);
    }
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
  return { items };
}
