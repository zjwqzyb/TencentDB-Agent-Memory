import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { SupportedAgent } from "../types.js";
import { MetadataService } from "./metadata-service.js";

const SUPPORTED_AGENTS: SupportedAgent[] = [
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
];

interface Harness {
  server: Server;
  baseUrl: string;
  stores: SqliteMetadataStore[];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function startHarness(
  services: Record<string, MetadataService>,
): Promise<Harness> {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const handled = await handleV3MetaRoute(
        req,
        res,
        pathname,
        req.method ?? "",
        readJson,
        sendJson,
        {
          getMetadataService: (instanceId) => services[instanceId],
          getSupportedAgents: () => SUPPORTED_AGENTS,
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        },
      );
      if (!handled) sendJson(res, 404, { code: 404, message: "not_found" });
    } catch (error) {
      sendJson(res, 500, {
        code: 500,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    stores: Object.values(services).map(
      (service) => service.rawStore as SqliteMetadataStore,
    ),
  };
}

async function stopHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => (error ? reject(error) : resolve()));
  });
  for (const store of harness.stores) store.close();
}

async function post(
  baseUrl: string,
  action: string,
  body: Record<string, unknown>,
  headers: { instance: string; key: string },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/v3/meta/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": headers.instance,
      "x-tdai-user-key": headers.key,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function makeService(key: string, role: "system_admin" | "normal"): MetadataService {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  store.createUser({
    auth_provider: "local",
    external_id: `${role}-${key}`,
    username: `${role}-${key}`,
    user_type: role,
    default_key_value: key,
  });
  return new MetadataService(store);
}

describe("instance extraction admin API", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await stopHarness(harness);
    harness = undefined;
  });

  it("returns deployment source, normalized managed fields, masked key and required version", async () => {
    const service = makeService("admin-key", "system_admin");
    harness = await startHarness({ instance_a: service });
    const headers = { instance: "instance_a", key: "admin-key" };

    expect(await post(harness.baseUrl, "instance-upstream/extraction/get", {}, headers)).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: false,
          source: "deployment",
          version: 0,
          config_id: null,
          api_key_configured: false,
        },
      },
    });

    expect(await post(harness.baseUrl, "instance-upstream/extraction/create", {
      provider: "openai",
      base_url: "https://api.example.com/v1",
      api_key: "secret",
      model_id: "model",
    }, headers)).toMatchObject({ status: 400, json: { code: 400 } });

    expect(await post(harness.baseUrl, "instance-upstream/extraction/create", {
      provider: "openai-compatible",
      base_url: "file:///tmp/model",
      api_key: "secret",
      model_id: "model",
    }, headers)).toMatchObject({ status: 400, json: { code: 400 } });

    expect(await post(harness.baseUrl, "instance-upstream/extraction/create", {
      provider: "openai-compatible",
      base_url: "https://api.example.com/v1",
      api_key: "••••••••",
      model_id: "model",
    }, headers)).toMatchObject({ status: 400, json: { code: 400 } });

    const created = await post(harness.baseUrl, "instance-upstream/extraction/create", {
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1/",
      api_key: "short",
      model_id: "deepseek-chat",
      description: "primary",
    }, headers);
    expect(created).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: true,
          managed: true,
          source: "panel",
          provider: "deepseek",
          protocol: "openai-chat",
          base_url: "https://api.deepseek.com/v1",
          api_key_configured: true,
          api_key_masked: "••••••••",
          model_id: "deepseek-chat",
          enabled: true,
          version: 1,
        },
      },
    });
    expect(JSON.stringify(created.json)).not.toContain("short");

    const unconfirmedReuse = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      {
        expected_version: created.json.data.version,
        provider: "glm",
      },
      headers,
    );
    expect(unconfirmedReuse).toMatchObject({
      status: 400,
      json: { code: 400 },
    });
    expect(unconfirmedReuse.json.message).toContain("confirm_reuse_api_key");

    const confirmedReuse = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      {
        expected_version: created.json.data.version,
        provider: "glm",
        confirm_reuse_api_key: true,
      },
      headers,
    );
    expect(confirmedReuse).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          provider: "glm",
          enabled: true,
          api_key_configured: true,
          version: created.json.data.version + 1,
        },
      },
    });

    const missingVersion = await post(harness.baseUrl, "instance-upstream/extraction/update", {
      description: "changed",
    }, headers);
    expect(missingVersion).toMatchObject({
      status: 400,
      json: { code: 400 },
    });
    expect(missingVersion.json.message).toContain("expected_version");

    const missingToggleVersion = await post(
      harness.baseUrl,
      "instance-upstream/extraction/toggle",
      { enabled: false },
      headers,
    );
    expect(missingToggleVersion).toMatchObject({
      status: 400,
      json: { code: 400 },
    });

    const toggled = await post(harness.baseUrl, "instance-upstream/extraction/toggle", {
      enabled: false,
      expected_version: confirmedReuse.json.data.version,
    }, headers);
    expect(toggled).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          enabled: false,
          provider: "glm",
          version: confirmedReuse.json.data.version + 1,
        },
      },
    });
  });

  it("normalizes legacy stored endpoints only in the management response", async () => {
    const service = makeService("legacy-admin", "system_admin");
    const legacy = service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      base_url: "  https://legacy.example/v1/  ",
      api_key: "legacy-secret",
      model_id: "legacy-model",
      provider: "openai-compatible",
    });
    harness = await startHarness({ instance_legacy: service });

    expect(await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_legacy", key: "legacy-admin" },
    )).toMatchObject({
      status: 200,
      json: { code: 0, data: { base_url: "https://legacy.example/v1" } },
    });
    expect(service.rawStore.getInstanceUpstreamGroup(legacy.group_id)?.base_url)
      .toBe("  https://legacy.example/v1/  ");
  });

  it("enforces system_admin and instance isolation through the direct HTTP API", async () => {
    const adminA = makeService("admin-a", "system_admin");
    const adminB = makeService("admin-b", "system_admin");
    const member = makeService("member-key", "normal");
    harness = await startHarness({
      instance_a: adminA,
      instance_b: adminB,
      instance_member: member,
    });

    await post(harness.baseUrl, "instance-upstream/extraction/create", {
      provider: "glm",
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      api_key: "glm-secret",
      model_id: "glm-4-plus",
    }, { instance: "instance_a", key: "admin-a" });

    const otherInstance = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_b", key: "admin-b" },
    );
    expect(otherInstance).toMatchObject({
      status: 200,
      json: { code: 0, data: { configured: false, source: "deployment" } },
    });

    const foreignKey = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_b", key: "admin-a" },
    );
    expect(foreignKey).toMatchObject({ status: 401, json: { code: 401 } });

    const memberHeaders = { instance: "instance_member", key: "member-key" };
    const deniedRequests = [
      ["instance-upstream/extraction/get", {}],
      ["instance-upstream/extraction/create", {
        base_url: "https://member.example/v1",
        api_key: "member-secret",
        model_id: "member-model",
      }],
      ["instance-upstream/extraction/update", { expected_version: 1, description: "x" }],
      ["instance-upstream/extraction/toggle", { enabled: false, expected_version: 1 }],
      ["instance-upstream/extraction/delete", {}],
    ] as const;
    for (const [action, body] of deniedRequests) {
      expect(await post(harness.baseUrl, action, body, memberHeaders)).toMatchObject({
        status: 403,
        json: { code: 403 },
      });
    }
  });


  it("saves draft-only configuration without claiming an active managed model", async () => {
    const service = makeService("draft-create-admin", "system_admin");
    harness = await startHarness({ instance_draft: service });

    const created = await post(
      harness.baseUrl,
      "instance-upstream/extraction/create",
      {
        draft: true,
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1/",
        api_key: "draft-only-secret",
        model_id: "deepseek-chat",
        description: "draft only",
      },
      { instance: "instance_draft", key: "draft-create-admin" },
    );

    expect(created).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: false,
          source: "deployment",
          enabled: false,
          draft: {
            configured: true,
            provider: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            api_key_configured: true,
            model_id: "deepseek-chat",
            description: "draft only",
          },
        },
      },
    });
    expect(JSON.stringify(created.json)).not.toContain("draft-only-secret");

    const rows = service.rawStore.listInstanceUpstreamGroups({ group_type: "extraction" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enabled: false,
      base_url: "",
      api_key: "",
      model_id: "",
      description: "",
    });
    expect(JSON.parse(rows[0].draft_json ?? "{}")).toMatchObject({
      provider: "deepseek",
      api_key: "draft-only-secret",
      model_id: "deepseek-chat",
    });
    const internal = await service.listInstanceUpstreamGroupsInternal([]);
    expect(internal.items.find((item) => item.group_type === "extraction")?.draft_json).toBe("");
  });

  it("updates only draft fields and preserves active values and server-side keys", async () => {
    const service = makeService("draft-update-admin", "system_admin");
    const active = service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "openai-compatible",
      base_url: "https://active.example/v1",
      api_key: "active-secret",
      model_id: "active-model",
      description: "active config",
      enabled: true,
    });
    harness = await startHarness({ instance_draft_update: service });
    const headers = { instance: "instance_draft_update", key: "draft-update-admin" };

    const first = await post(harness.baseUrl, "instance-upstream/extraction/update", {
      draft: true,
      expected_version: active.version,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "draft-secret",
      model_id: "deepseek-chat",
      description: "first draft",
    }, headers);
    expect(first).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: true,
          source: "panel",
          provider: "openai-compatible",
          base_url: "https://active.example/v1",
          model_id: "active-model",
          description: "active config",
          draft: {
            provider: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            model_id: "deepseek-chat",
            description: "first draft",
            api_key_configured: true,
          },
        },
      },
    });

    const afterFirst = service.rawStore.getInstanceUpstreamGroup(active.group_id)!;
    expect(afterFirst).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      base_url: "https://active.example/v1",
      api_key: "active-secret",
      model_id: "active-model",
      description: "active config",
    });

    const second = await post(harness.baseUrl, "instance-upstream/extraction/update", {
      draft: true,
      expected_version: afterFirst.version,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      model_id: "deepseek-reasoner",
      description: "second draft",
    }, headers);
    expect(second).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          draft: {
            model_id: "deepseek-reasoner",
            description: "second draft",
            api_key_configured: true,
          },
        },
      },
    });

    const afterSecond = service.rawStore.getInstanceUpstreamGroup(active.group_id)!;
    expect(afterSecond.api_key).toBe("active-secret");
    expect(JSON.parse(afterSecond.draft_json ?? "{}")).toMatchObject({
      api_key: "draft-secret",
      model_id: "deepseek-reasoner",
    });

    const stale = await post(harness.baseUrl, "instance-upstream/extraction/update", {
      draft: true,
      expected_version: active.version,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      model_id: "stale-model",
    }, headers);
    expect(stale).toMatchObject({ status: 409, json: { code: 409 } });
  });

  it("does not expose a corrupt draft as a usable configuration", async () => {
    const service = makeService("corrupt-draft-admin", "system_admin");
    service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "glm",
      base_url: "",
      api_key: "",
      model_id: "",
      draft_json: JSON.stringify({
        provider: "glm",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
      }),
    });
    harness = await startHarness({ instance_corrupt: service });

    const response = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_corrupt", key: "corrupt-draft-admin" },
    );
    expect(response).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: false,
          managed: false,
          draft: null,
          source: "deployment",
        },
      },
    });
  });

  it("requires explicit confirmation before reusing a key for another endpoint", async () => {
    const service = makeService("key-reuse-admin", "system_admin");
    const active = service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "openai-compatible",
      base_url: "https://active.example/v1",
      api_key: "active-secret",
      model_id: "active-model",
      enabled: true,
    });
    harness = await startHarness({ instance_key_reuse: service });
    const headers = { instance: "instance_key_reuse", key: "key-reuse-admin" };
    const body = {
      draft: true,
      expected_version: active.version,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      model_id: "deepseek-chat",
    };

    const rejected = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      body,
      headers,
    );
    expect(rejected).toMatchObject({ status: 400, json: { code: 400 } });
    expect(rejected.json.message).toContain("API_KEY_CONFIRMATION_REQUIRED");
    expect(rejected.json.message).toContain("confirm_reuse_api_key");
    expect(service.rawStore.getInstanceUpstreamGroup(active.group_id)?.draft_json).toBe("");

    const confirmed = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      { ...body, confirm_reuse_api_key: true },
      headers,
    );
    expect(confirmed).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          draft: {
            provider: "deepseek",
            model_id: "deepseek-chat",
            api_key_configured: true,
          },
        },
      },
    });
  });
});
