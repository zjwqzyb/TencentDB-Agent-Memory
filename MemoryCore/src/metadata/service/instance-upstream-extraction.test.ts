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
          version: 1,
        },
      },
    });
    expect(JSON.stringify(created.json)).not.toContain("short");

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
      expected_version: created.json.data.version,
    }, headers);
    expect(toggled).toMatchObject({
      status: 200,
      json: {
        code: 0,
        data: {
          enabled: false,
          provider: "deepseek",
          version: created.json.data.version + 1,
        },
      },
    });
  });

  it("enforces system_admin and instance isolation through the direct HTTP API", async () => {
    const adminA = makeService("shared-admin", "system_admin");
    const adminB = makeService("shared-admin", "system_admin");
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
    }, { instance: "instance_a", key: "shared-admin" });

    const otherInstance = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_b", key: "shared-admin" },
    );
    expect(otherInstance).toMatchObject({
      status: 200,
      json: { code: 0, data: { configured: false, source: "deployment" } },
    });

    const denied = await post(
      harness.baseUrl,
      "instance-upstream/extraction/get",
      {},
      { instance: "instance_member", key: "member-key" },
    );
    expect(denied).toMatchObject({
      status: 403,
      json: { code: 403 },
    });
  });
});
