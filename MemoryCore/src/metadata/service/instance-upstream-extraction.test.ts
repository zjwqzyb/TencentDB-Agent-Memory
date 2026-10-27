import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import {
  handleInternalMetaRoute,
  V3_INTERNAL_ROUTES,
} from "../router/internal-meta-router.js";
import { V3_SCHEMAS } from "../router/v3-meta-schemas.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { SupportedAgent } from "../types.js";
import { MetadataService } from "./metadata-service.js";
import { modelConfigFingerprint } from "./model-config-fingerprint.js";

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
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const method = req.method ?? "";
      const handledInternal = await handleInternalMetaRoute(
        req,
        res,
        pathname,
        method,
        readJson,
        sendJson,
        {
          getMetadataService: (instanceId) => services[instanceId],
          getSupportedAgents: () => SUPPORTED_AGENTS,
          logger,
        },
      );
      if (handledInternal) return;
      const handled = await handleV3MetaRoute(
        req,
        res,
        pathname,
        method,
        readJson,
        sendJson,
        {
          getMetadataService: (instanceId) => services[instanceId],
          getSupportedAgents: () => SUPPORTED_AGENTS,
          logger,
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

async function postInternal(
  baseUrl: string,
  action: string,
  body: Record<string, unknown>,
  headers: { instance: string },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/v3/internal/meta/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": headers.instance,
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
      ["instance-upstream/extraction/enable", { expected_version: 1, test_id: "mct_denied" }],
      ["instance-upstream/extraction/disable", { expected_version: 1 }],
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

describe("internal extraction resolve", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await stopHarness(harness);
    harness = undefined;
  });

  it("returns the plaintext draft and active=null for a draft-only row", async () => {
    const service = makeService("resolve-draft-admin", "system_admin");
    const row = service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "deepseek",
      base_url: "",
      api_key: "",
      model_id: "",
      enabled: false,
      draft_json: JSON.stringify({
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "draft-plain-secret",
        model_id: "deepseek-chat",
        description: "draft only",
      }),
    });
    harness = await startHarness({ instance_resolve_draft: service });

    const resolved = await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/resolve",
      {},
      { instance: "instance_resolve_draft" },
    );
    expect(resolved).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          source: "deployment",
          config_id: row.group_id,
          version: row.version,
          enabled: false,
          draft_present: true,
          active: null,
          draft: {
            provider: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            api_key: "draft-plain-secret",
            model_id: "deepseek-chat",
            description: "draft only",
          },
        },
      },
    });
    expect(resolved.json.data.updated_at).toEqual(expect.any(String));
  });

  it("returns the active plaintext key on the internal route while the public get stays masked", async () => {
    const service = makeService("resolve-active-admin", "system_admin");
    const row = service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "glm",
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      api_key: "active-plain-secret",
      model_id: "glm-4-plus",
      description: "active config",
      enabled: true,
    });
    harness = await startHarness({ instance_resolve_active: service });

    const resolved = await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/resolve",
      {},
      { instance: "instance_resolve_active" },
    );
    expect(resolved).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          source: "panel",
          config_id: row.group_id,
          version: row.version,
          enabled: true,
          draft_present: false,
          active: {
            provider: "glm",
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            api_key: "active-plain-secret",
            model_id: "glm-4-plus",
            description: "active config",
          },
          draft: null,
        },
      },
    });

    const publicResponse = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_resolve_active", key: "resolve-active-admin" },
    );
    expect(publicResponse).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: true,
          source: "panel",
          provider: "glm",
          api_key_configured: true,
        },
      },
    });
    expect(publicResponse.json.data.api_key_masked).not.toBe("");
    expect(JSON.stringify(publicResponse.json)).not.toContain("active-plain-secret");
  });

  it("returns an empty resolution when no extraction row exists", async () => {
    const service = makeService("resolve-empty-admin", "system_admin");
    harness = await startHarness({ instance_resolve_empty: service });

    const resolved = await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/resolve",
      {},
      { instance: "instance_resolve_empty" },
    );
    expect(resolved).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          source: "deployment",
          config_id: null,
          version: 0,
          enabled: null,
          updated_at: null,
          draft_present: false,
          active: null,
          draft: null,
        },
      },
    });
  });

  it("returns active and draft side by side when both are present", async () => {
    const service = makeService("resolve-both-admin", "system_admin");
    service.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "openai-compatible",
      base_url: "https://active.example/v1",
      api_key: "active-key",
      model_id: "active-model",
      description: "active config",
      enabled: true,
      draft_json: JSON.stringify({
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "draft-key",
        model_id: "deepseek-chat",
        description: "draft config",
      }),
    });
    harness = await startHarness({ instance_resolve_both: service });

    const resolved = await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/resolve",
      {},
      { instance: "instance_resolve_both" },
    );
    expect(resolved).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          source: "panel",
          draft_present: true,
          active: {
            provider: "openai-compatible",
            api_key: "active-key",
            model_id: "active-model",
          },
          draft: {
            provider: "deepseek",
            api_key: "draft-key",
            model_id: "deepseek-chat",
          },
        },
      },
    });
  });

  it("records test evidence without changing configuration state", async () => {
    const service = makeService("test-evidence-admin", "system_admin");
    harness = await startHarness({ instance_test_evidence: service });
    const headers = { instance: "instance_test_evidence", key: "test-evidence-admin" };

    const created = await post(harness.baseUrl, "instance-upstream/extraction/create", {
      draft: true,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "draft-secret",
      model_id: "deepseek-chat",
      description: "evidence draft",
    }, headers);
    expect(created).toMatchObject({ status: 200, json: { code: 0 } });
    const before = service.rawStore.getInstanceUpstreamGroup(created.json.data.config_id)!;

    const recorded = await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/test-result",
      {
        test_id: "mct_evidence",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1/",
        model_id: "deepseek-chat",
        capabilities: { basic: "passed", json: "passed", tools: "passed" },
        passed: true,
      },
      headers,
    );
    expect(recorded).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          test_id: "mct_evidence",
          passed: true,
          version: before.version,
        },
      },
    });

    const after = service.rawStore.getInstanceUpstreamGroup(before.group_id)!;
    expect(after.version).toBe(before.version);
    expect(after.draft_json).toBe(before.draft_json);
    expect(after.enabled).toBe(false);
    expect(after.base_url).toBe("");
    expect(after.api_key).toBe("");
    const storedTest = JSON.parse(after.snapshot_json).test;
    expect(storedTest).toMatchObject({
      test_id: "mct_evidence",
      fingerprint: modelConfigFingerprint({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        modelId: "deepseek-chat",
        apiKey: "draft-secret",
      }),
      capabilities: { basic: "passed", json: "passed", tools: "passed" },
    });
    expect(Date.parse(storedTest.expires_at) - Date.parse(storedTest.tested_at))
      .toBe(15 * 60 * 1000);
    expect(JSON.parse(after.snapshot_json).active).toBeNull();

    const publicGet = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      headers,
    );
    expect(publicGet).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          paused: false,
          active_snapshot: null,
          version: before.version,
          test: {
            test_id: "mct_evidence",
            passed: true,
            matches_current: true,
          },
        },
      },
    });
    expect(JSON.stringify(publicGet.json)).not.toContain("draft-secret");
  });

  it("requires matching fresh evidence and enables atomically after a remark-only edit", async () => {
    const service = makeService("enable-gate-admin", "system_admin");
    harness = await startHarness({ instance_enable_gate: service });
    const headers = { instance: "instance_enable_gate", key: "enable-gate-admin" };

    const created = await post(harness.baseUrl, "instance-upstream/extraction/create", {
      draft: true,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "draft-secret",
      model_id: "deepseek-chat",
      description: "before remark",
    }, headers);
    const groupId = created.json.data.config_id as string;
    const initialVersion = created.json.data.version as number;

    const missing = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: initialVersion,
      test_id: "mct_missing",
    }, headers);
    expect(missing).toMatchObject({ status: 409, json: { code: 409 } });
    expect(missing.json.message).toContain("TEST_REQUIRED");
    const unchanged = service.rawStore.getInstanceUpstreamGroup(groupId)!;
    expect(unchanged.version).toBe(initialVersion);
    expect(unchanged.enabled).toBe(false);
    expect(unchanged.base_url).toBe("");

    const legacyToggle = await post(
      harness.baseUrl,
      "instance-upstream/extraction/toggle",
      { enabled: true, expected_version: initialVersion },
      headers,
    );
    expect(legacyToggle).toMatchObject({ status: 409, json: { code: 409 } });
    expect(legacyToggle.json.message).toContain("TEST_REQUIRED");
    const legacyUpdate = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      { enabled: true, expected_version: initialVersion },
      headers,
    );
    expect(legacyUpdate).toMatchObject({ status: 400, json: { code: 400 } });
    expect(legacyUpdate.json.message).toContain("USE_ENABLE_DISABLE_ENDPOINT");
    expect(service.rawStore.getInstanceUpstreamGroup(groupId)).toMatchObject({
      enabled: false,
      version: initialVersion,
    });

    expect(await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/test-result",
      {
        test_id: "mct_fresh",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        model_id: "deepseek-chat",
        capabilities: { basic: "passed", json: "passed", tools: "passed" },
        passed: true,
      },
      headers,
    )).toMatchObject({ status: 200, json: { code: 0 } });

    const remarkOnly = await post(
      harness.baseUrl,
      "instance-upstream/extraction/update",
      {
        draft: true,
        expected_version: initialVersion,
        description: "after remark",
      },
      headers,
    );
    expect(remarkOnly).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          version: initialVersion + 1,
          test: { test_id: "mct_fresh", matches_current: true },
        },
      },
    });
    expect(JSON.parse(service.rawStore.getInstanceUpstreamGroup(groupId)!.snapshot_json).test)
      .toMatchObject({ test_id: "mct_fresh" });

    const forged = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: initialVersion + 1,
      test_id: "mct_forged",
    }, headers);
    expect(forged).toMatchObject({ status: 409, json: { code: 409 } });
    expect(forged.json.message).toContain("TEST_STALE");

    const enabled = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: initialVersion + 1,
      test_id: "mct_fresh",
    }, headers);
    expect(enabled).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          configured: true,
          enabled: true,
          paused: false,
          provider: "deepseek",
          base_url: "https://api.deepseek.com/v1",
          model_id: "deepseek-chat",
          description: "after remark",
          version: initialVersion + 2,
          active_snapshot: {
            version: initialVersion + 2,
            provider: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            api_key_configured: true,
            model_id: "deepseek-chat",
            description: "after remark",
          },
          test: {
            test_id: "mct_fresh",
            matches_current: true,
          },
        },
      },
    });
    expect(enabled.json.data.active_snapshot.snapshot_id).toMatch(/^snap_/);
    expect(JSON.stringify(enabled.json)).not.toContain("draft-secret");
    expect(JSON.stringify(enabled.json)).not.toContain("sk-");

    const row = service.rawStore.getInstanceUpstreamGroup(groupId)!;
    expect(row).toMatchObject({
      enabled: true,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "draft-secret",
      model_id: "deepseek-chat",
      description: "after remark",
      version: initialVersion + 2,
    });
    expect(JSON.parse(row.snapshot_json).active).toMatchObject({
      snapshot_id: enabled.json.data.active_snapshot.snapshot_id,
      version: initialVersion + 2,
      api_key: "draft-secret",
      activated_at: enabled.json.data.active_snapshot.activated_at,
    });
    const internal = await service.listInstanceUpstreamGroupsInternal([]);
    expect(internal.items.find((item) => item.group_type === "extraction")).toMatchObject({
      draft_json: "",
      snapshot_json: "",
    });
  });

  it("rejects evidence after connection-field changes or expiry", async () => {
    const service = makeService("stale-gate-admin", "system_admin");
    harness = await startHarness({ instance_stale_gate: service });
    const headers = { instance: "instance_stale_gate", key: "stale-gate-admin" };

    const created = await post(harness.baseUrl, "instance-upstream/extraction/create", {
      draft: true,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "draft-secret",
      model_id: "deepseek-chat",
    }, headers);
    const groupId = created.json.data.config_id as string;

    await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/test-result",
      {
        test_id: "mct_old_model",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        model_id: "deepseek-chat",
        capabilities: { basic: "passed", json: "passed", tools: "passed" },
        passed: true,
      },
      headers,
    );
    const changed = await post(harness.baseUrl, "instance-upstream/extraction/update", {
      draft: true,
      expected_version: created.json.data.version,
      model_id: "deepseek-reasoner",
    }, headers);
    expect(changed).toMatchObject({
      status: 200,
      json: { code: 0, data: { version: created.json.data.version + 1 } },
    });

    const mismatched = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: changed.json.data.version,
      test_id: "mct_old_model",
    }, headers);
    expect(mismatched).toMatchObject({ status: 409, json: { code: 409 } });
    expect(mismatched.json.message).toContain("TEST_STALE");

    await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/test-result",
      {
        test_id: "mct_expired",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        model_id: "deepseek-reasoner",
        capabilities: { basic: "passed", json: "passed", tools: "passed" },
        passed: true,
        ttl_seconds: 0,
      },
      headers,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: changed.json.data.version,
      test_id: "mct_expired",
    }, headers);
    expect(expired).toMatchObject({ status: 409, json: { code: 409 } });
    expect(expired.json.message).toContain("TEST_STALE");
    expect(service.rawStore.getInstanceUpstreamGroup(groupId)?.enabled).toBe(false);
  });

  it("pauses with draft and active snapshot retained and reports version conflicts", async () => {
    const service = makeService("pause-admin", "system_admin");
    harness = await startHarness({ instance_pause: service });
    const headers = { instance: "instance_pause", key: "pause-admin" };

    const created = await post(harness.baseUrl, "instance-upstream/extraction/create", {
      draft: true,
      provider: "glm",
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      api_key: "glm-draft-key",
      model_id: "glm-4-plus",
      description: "paused config",
    }, headers);
    const groupId = created.json.data.config_id as string;
    await postInternal(
      harness.baseUrl,
      "instance-upstream/extraction/test-result",
      {
        test_id: "mct_pause",
        provider: "glm",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        model_id: "glm-4-plus",
        capabilities: { basic: "passed", json: "passed", tools: "passed" },
        passed: true,
      },
      headers,
    );
    const enabled = await post(harness.baseUrl, "instance-upstream/extraction/enable", {
      expected_version: created.json.data.version,
      test_id: "mct_pause",
    }, headers);
    expect(enabled).toMatchObject({ status: 200, json: { code: 0 } });

    const paused = await post(harness.baseUrl, "instance-upstream/extraction/disable", {
      expected_version: enabled.json.data.version,
    }, headers);
    expect(paused).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          enabled: false,
          paused: true,
          version: enabled.json.data.version + 1,
          active_snapshot: {
            snapshot_id: enabled.json.data.active_snapshot.snapshot_id,
            model_id: "glm-4-plus",
          },
          draft: {
            provider: "glm",
            model_id: "glm-4-plus",
          },
        },
      },
    });

    const row = service.rawStore.getInstanceUpstreamGroup(groupId)!;
    expect(row.enabled).toBe(false);
    expect(row.draft_json).not.toBe("");
    expect(JSON.parse(row.snapshot_json).active.snapshot_id)
      .toBe(enabled.json.data.active_snapshot.snapshot_id);

    const conflict = await post(harness.baseUrl, "instance-upstream/extraction/disable", {
      expected_version: enabled.json.data.version,
    }, headers);
    expect(conflict).toMatchObject({
      status: 409,
      json: {
        code: 409,
        data: {
          expected: enabled.json.data.version,
          actual: enabled.json.data.version + 1,
        },
      },
    });
    expect(conflict.json.message).toContain("WRITE_CONFLICT");
  });

  it("resolves ready, paused, unavailable and invalid snapshots for services", async () => {
    const ready = makeService("snapshot-ready-admin", "system_admin");
    const paused = makeService("snapshot-paused-admin", "system_admin");
    const unavailable = makeService("snapshot-empty-admin", "system_admin");
    const invalid = makeService("snapshot-invalid-admin", "system_admin");
    const legacy = makeService("snapshot-legacy-admin", "system_admin");

    const activeSnapshot = {
      snapshot_id: "snap_ready",
      version: 2,
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "active-secret",
      model_id: "deepseek-chat",
      description: "ready",
      activated_at: "2026-10-26T00:00:00.000Z",
    };
    ready.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "active-secret",
      model_id: "deepseek-chat",
      description: "ready",
      enabled: true,
      snapshot_json: JSON.stringify({ active: activeSnapshot, test: null }),
    });
    paused.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "active-secret",
      model_id: "deepseek-chat",
      description: "paused",
      enabled: false,
      snapshot_json: JSON.stringify({
        active: { ...activeSnapshot, snapshot_id: "snap_paused", activated_at: "2026-10-26T00:01:00.000Z" },
        test: null,
      }),
    });
    invalid.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      api_key: "active-secret",
      model_id: "deepseek-chat",
      enabled: true,
      snapshot_json: JSON.stringify({
        active: { ...activeSnapshot, api_key: "" },
        test: null,
      }),
    });
    const legacyRow = legacy.rawStore.createInstanceUpstreamGroup({
      group_type: "extraction",
      name: "抽取模型",
      mode: "custom_unified",
      provider: "glm",
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      api_key: "legacy-secret",
      model_id: "glm-4-plus",
      enabled: true,
    });

    harness = await startHarness({
      instance_snapshot_ready: ready,
      instance_snapshot_paused: paused,
      instance_snapshot_empty: unavailable,
      instance_snapshot_invalid: invalid,
      instance_snapshot_legacy: legacy,
    });
    const resolveSnapshot = (instance: string) => postInternal(
      harness!.baseUrl,
      "instance-upstream/extraction/snapshot",
      {},
      { instance },
    );

    expect(await resolveSnapshot("instance_snapshot_ready")).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          status: "ready",
          snapshot: {
            snapshot_id: "snap_ready",
            version: 2,
            provider: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            api_key: "active-secret",
            model_id: "deepseek-chat",
          },
        },
      },
    });
    expect(await resolveSnapshot("instance_snapshot_legacy")).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          status: "ready",
          snapshot: {
            snapshot_id: `legacy:${legacyRow.group_id}`,
            version: legacyRow.version,
            provider: "glm",
            api_key: "legacy-secret",
            model_id: "glm-4-plus",
          },
        },
      },
    });
    expect(await resolveSnapshot("instance_snapshot_paused")).toMatchObject({
      status: 200,
      json: { code: 0, data: { status: "paused" } },
    });
    expect(await resolveSnapshot("instance_snapshot_empty")).toMatchObject({
      status: 200,
      json: { code: 0, data: { status: "config_unavailable" } },
    });
    const invalidResult = await resolveSnapshot("instance_snapshot_invalid");
    expect(invalidResult).toMatchObject({
      status: 200,
      json: { code: 0, data: { status: "invalid" } },
    });
    expect(invalidResult.json.data.reason).toContain("api_key");
  });

  it("registers new extraction routes with the correct public/internal exposure", () => {
    expect(V3_INTERNAL_ROUTES).toEqual(expect.arrayContaining([
      "/v3/internal/meta/instance-upstream/extraction/resolve",
      "/v3/internal/meta/instance-upstream/extraction/test-result",
      "/v3/internal/meta/instance-upstream/extraction/snapshot",
    ]));
    expect(V3_SCHEMAS).toHaveProperty("/v3/meta/instance-upstream/extraction/enable");
    expect(V3_SCHEMAS).toHaveProperty("/v3/meta/instance-upstream/extraction/disable");
    expect(V3_SCHEMAS).not.toHaveProperty(
      "/v3/internal/meta/instance-upstream/extraction/test-result",
    );
    expect(V3_SCHEMAS).not.toHaveProperty(
      "/v3/internal/meta/instance-upstream/extraction/snapshot",
    );
  });
});
