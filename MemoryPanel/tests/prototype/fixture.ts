import { createRequire } from "node:module";
import { MongoMetadataStore } from "../../../MemoryCore/src/metadata/store/mongodb-adapter.js";
import type { IMetadataStore } from "../../../MemoryCore/src/metadata/store/interface.js";
// Loopback fixture for the cross-browser and MCP acceptance scenarios. Each run
// creates its own SQLite database, users, ACLs, ports and ephemeral test keys.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SqliteMetadataStore } from "../../../MemoryCore/src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../../MemoryCore/src/metadata/service/metadata-service.js";
import { handleV3MetaRoute } from "../../../MemoryCore/src/metadata/router/v3-meta-router.js";
import { InstanceRegistry } from "../../src/panel/config/instance-registry.js";
import { registerMetaProxyRoutes } from "../../src/panel/http/routes/meta/proxy.js";
import { registerMetaInstanceRoutes } from "../../src/panel/http/routes/meta/instances.js";
import { FetchMetaKernelAdapter } from "../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js";
import { FetchKernelHttpAdapter } from "../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js";
import type { PanelDeps } from "../../src/panel/panel-deps.js";
import { newExternalAssetId } from "../../../MemoryCore/src/metadata/utils/external-asset-id.js";

const output = process.argv[2];
if (!output) throw new Error("Pass a new temporary fixture metadata path");
const backend = process.argv[3] ?? "sqlite";
let store: IMetadataStore;
let stopReplica: (() => Promise<void>) | undefined;
if (backend === "mongo") {
  const corePackage = createRequire(
    new URL("../../../MemoryCore/package.json", import.meta.url),
  );
  const { MongoMemoryReplSet } = corePackage("mongodb-memory-server");
  const { MongoClient } = corePackage("mongodb");
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await MongoClient.connect(replica.getUri());
  store = new MongoMetadataStore(client, "prototype_http_acceptance", {
    ownsClient: false,
  });
  stopReplica = async () => {
    await client.close();
    await replica.stop();
  };
} else if (backend === "sqlite") {
  store = new SqliteMetadataStore(":memory:");
} else {
  throw new Error("Unknown fixture backend");
}
await store.init();
const instanceId = "prototype-qa";
const svc = new MetadataService(store, instanceId);
async function identity(name: string) {
  const key = randomUUID();
  const user = await store.createUser({
    auth_provider: "local",
    external_id: name,
    username: name,
    default_key_value: key,
  });
  return { user_id: user.user_id, userKey: key, username: name };
}
const owner = await identity("product"),
  editor = await identity("development"),
  reader = await identity("test"),
  other = await identity("other-team");
const team = await store.createTeam({
  name: "Team A",
  owner_user_id: owner.user_id,
});
const second = await store.createTeam({
  name: "Team B",
  owner_user_id: other.user_id,
});
for (const user of [editor, reader])
  await store.addTeamMember({
    team_id: team.team_id,
    user_id: user.user_id,
    role: "member",
  });
// The reader can switch between teams in one browser; editor and owners are team-specific.
await store.addTeamMember({
  team_id: second.team_id,
  user_id: reader.user_id,
  role: "member",
});
const agent = await store.createAgent({
  team_id: team.team_id,
  owner_user_id: owner.user_id,
  name: "QA Agent",
});
const ungranted = await store.createAgent({
  team_id: team.team_id,
  owner_user_id: owner.user_id,
  name: "QA Unassigned",
});
function project(team_id: string, owner_user_id: string) {
  return store.createAsset({
    asset_type: "prototype",
    asset_id: newExternalAssetId("prototype"),
    team_id,
    owner_user_id,
    name: "索赔单",
    source_type: "prototype",
    status: "approved",
    visibility: "team",
  });
}
const a = await project(team.team_id, owner.user_id),
  b = await project(second.team_id, other.user_id);
await store.grantAcl({
  asset_id: a.asset_id,
  subject_type: "user",
  subject_id: editor.user_id,
  permission: "write",
  granted_by: owner.user_id,
});
const grant = await store.grantAcl({
  asset_id: a.asset_id,
  subject_type: "agent",
  subject_id: agent.agent_id,
  permission: "read",
  granted_by: owner.user_id,
});
const gatewayToken = randomUUID();
const core = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer " + gatewayToken) {
    res.writeHead(401);
    res.end();
    return;
  }
  const handled = await handleV3MetaRoute(
    req,
    res,
    req.url ?? "",
    req.method ?? "",
    async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
    (res, code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    {
      getMetadataService: (id) => (id === instanceId ? svc : undefined),
      getSupportedAgents: () => [],
      logger: {
        info: () => {},
        warn: () => {},
        error: console.error,
        debug: () => {},
      },
    },
  );
  if (!handled) {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const gateway_endpoint =
  "http://127.0.0.1:" + (core.address() as AddressInfo).port;
const registry = new InstanceRegistry([
  {
    instance_id: instanceId,
    name: "QA",
    gateway_endpoint,
    api_key: gatewayToken,
  },
]);
const routes = new Hono();
const panelDeps = {
  instanceRegistry: registry,
  metaKernel: new FetchMetaKernelAdapter(new FetchKernelHttpAdapter(), 10000),
  config: {
    auth: { sessionCookieName: "prototype-qa" },
    featureAnalyticsEnabled: false,
  },
  auth: { resolveSession: () => null },
  logger: console,
} as unknown as PanelDeps;
registerMetaInstanceRoutes(routes, panelDeps);
registerMetaProxyRoutes(routes, panelDeps);
const app = new Hono();
app.route("/api/v1", routes);
// The same relative entry point and build base as the real Panel mount.
if (process.env.PROTOTYPE_EDITOR_DIST_DIR) {
  app.use(
    "/prototype-editor/*",
    serveStatic({
      root: process.env.PROTOTYPE_EDITOR_DIST_DIR,
      rewriteRequestPath: (path) => path.slice("/prototype-editor".length),
    }),
  );
}
if (process.env.UI_DIST_DIR)
  app.use("/*", serveStatic({ root: process.env.UI_DIST_DIR }));
const panel = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const listener = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
    () => resolve(listener),
  );
});
const baseUrl = "http://127.0.0.1:" + (panel.address() as AddressInfo).port;
writeFileSync(
  output,
  JSON.stringify({
    backend,
    baseUrl,
    instanceId,
    team: team.team_id,
    second: second.team_id,
    asset: a.asset_id,
    otherAsset: b.asset_id,
    owner,
    editor,
    reader,
    other,
    agent: agent.agent_id,
    ungranted: ungranted.agent_id,
    grant: grant.id,
  }),
  { flag: "wx", mode: 0o600 },
);
console.log("Prototype QA fixture ready");
async function stop() {
  panel.close();
  core.closeAllConnections();
  core.close();
  await store.close();
  await stopReplica?.();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
