import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  MetadataError,
  type MetadataService,
} from "../service/metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";
import { access } from "./access.js";
import * as S from "./schema.js";
import { PrototypeStoreError } from "./store.js";
import type { PrototypePageVersionEntity } from "./store.js";

const missing = (kind: string): never => {
  throw new MetadataError("prototype_not_found", kind + " not found");
};

function commitId(assetId: string, authorId: string, requestId: string) {
  return createHash("sha256")
    .update(JSON.stringify([assetId, authorId, requestId]))
    .digest("hex");
}

function describe(row: PrototypePageVersionEntity) {
  const { snapshot, ...header } = row;
  return {
    ...header,
    author_user_id: row.author_id,
    views: snapshot.views,
    commit_id: commitId(row.asset_id, row.author_id, row.request_id),
  };
}

export async function listPages(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.project>,
) {
  await access(svc, ctx, d);
  const store = svc.rawStore.prototype;
  const pages = await store.listPages(d);
  const items = await Promise.all(
    pages.map(async (page) => {
      if (page.current_version === null)
        return { ...page, version: null, views: [] };
      const row = await store.getPageVersion({
        ...d,
        page_key: page.page_key,
        version: page.current_version,
      });
      return describe(row ?? missing("Page version"));
    }),
  );
  return { items };
}

export async function history(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.page>,
) {
  await access(svc, ctx, d);
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const rows = await svc.rawStore.prototype.listPageVersions({
      ...d,
      offset,
      limit: 100,
    });
    items.push(...rows.map(describe));
    if (rows.length < 100) break;
  }
  return { items };
}

export async function readPage(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.readPage>,
) {
  await access(svc, ctx, d);
  const store = svc.rawStore.prototype;
  if (d.agent_id && d.version === undefined)
    throw new MetadataError("invalid_prototype", "Specify an exact version");
  const version =
    d.version ??
    (await store.listPages(d))[0]?.current_version ??
    missing("Page");
  const row =
    (await store.getPageVersion({ ...d, version })) ?? missing("Page version");
  return { ...row, ...describe(row), team_id: d.team_id };
}

export async function readContract(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.readContract>,
) {
  await access(svc, ctx, d);
  const row =
    (await svc.rawStore.prototype.getContract(d)) ??
    missing("Component contract");
  return { ...row, team_id: d.team_id };
}

async function mutate<T>(operation: () => T | Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof PrototypeStoreError)) throw error;
    if (error.reason === "transactions_required")
      throw new MetadataError("prototype_unavailable", error.message);
    if (error.reason === "version_not_found") return missing("Page version");
    if (error.reason === "contract_not_found")
      return missing("Component contract");
    throw new MetadataError("prototype_conflict", error.message, {
      reason: error.reason,
      latest_versions: error.latest_versions,
    });
  }
}

export async function publish(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.publish>,
) {
  const { user_id } = await access(svc, ctx, d, true);
  return mutate(() =>
    svc.rawStore.prototype.publishContract({
      asset_id: d.asset_id,
      component_type: d.component_type,
      contract_version: d.contract_version,
      definition: d.definition,
      author_id: user_id,
    }),
  );
}

export async function save(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.save>,
) {
  const { user_id } = await access(svc, ctx, d, true);
  const store = svc.rawStore.prototype;
  const contracts = new Map<string, S.Definition>();
  for (const { snapshot } of d.pages) {
    for (const { type, contract_version } of snapshot.components) {
      const key = type + "@" + contract_version;
      if (!contracts.has(key)) {
        const row = await store.getContract({
          asset_id: d.asset_id,
          component_type: type,
          contract_version,
        });
        if (!row)
          throw new MetadataError(
            "invalid_prototype",
            "Missing component contract " + key,
          );
        contracts.set(key, row.definition);
      }
    }
    try {
      S.validateTree(snapshot, (type, v) => contracts.get(type + "@" + v));
    } catch (error) {
      throw new MetadataError("invalid_prototype", (error as Error).message);
    }
  }
  const result = await mutate(() =>
    store.savePages({
      asset_id: d.asset_id,
      pages: d.pages,
      request_id: d.request_id,
      author_id: user_id,
    }),
  );
  return {
    ...result,
    commit_id: commitId(result.asset_id, user_id, result.request_id),
    versions: Object.fromEntries(
      result.pages.map((p) => [p.page_key, p.version]),
    ),
  };
}

export async function restore(
  svc: MetadataService,
  ctx: V3AuthContext,
  d: z.infer<typeof S.restore>,
) {
  const { user_id } = await access(svc, ctx, d, true);
  const row = await mutate(() =>
    svc.rawStore.prototype.restorePage({
      asset_id: d.asset_id,
      page_key: d.page_key,
      request_id: d.request_id,
      base_version: d.base_version,
      restore_version: d.restore_version,
      author_id: user_id,
    }),
  );
  return { ...row, ...describe(row), team_id: d.team_id };
}
