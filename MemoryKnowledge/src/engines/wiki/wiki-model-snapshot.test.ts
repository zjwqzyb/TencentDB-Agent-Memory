import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type Db } from "../../db/client.js";
import { createKnowledgeModule, type KnowledgeModule } from "../../module.js";
import type { LlmConfig } from "../../config.js";
import { modelConfigFingerprint } from "../../store/index.js";

interface ChatRecord {
  path?: string;
  model: string;
  authorization: string | string[] | undefined;
  system: string;
  prompt: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, value: unknown): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function completion(content: string, model: string) {
  return {
    id: "chatcmpl-wiki",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

interface Fixture {
  server: Server;
  baseUrl: string;
  requests: ChatRecord[];
  hold: { enabled: boolean; release: (() => void) | null; started: Promise<void> };
  startHold: () => void;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const requests: ChatRecord[] = [];
  let release: (() => void) | null = null;
  let startedResolve: () => void = () => {};
  let started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const hold = {
    enabled: false,
    get release() {
      return release;
    },
    started,
  };

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<Record<string, unknown>>;
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content ?? ""))
      .join("\n");
    const model = String(body.model ?? "");
    requests.push({
      path: req.url,
      model,
      authorization: req.headers.authorization,
      system,
      prompt: messages.map((m) => String(m.content ?? "")).join("\n"),
    });

    if (system.includes("Output only the analysis itself")) {
      return json(
        res,
        completion('{"plan":"one concept page","title":"Redis","capabilities":["json"]}', model),
      );
    }

    if (system.includes("Merge two markdown pages on the same topic")) {
      return json(
        res,
        completion(
          [
            "---",
            "type: concept",
            "title: Redis",
            "description: In-memory cache",
            "sources:",
            "  - source.md",
            "---",
            "Redis is an in-memory cache. It supports persistence.",
          ].join("\n"),
          model,
        ),
      );
    }

    if (system.includes("知识库摘要生成器")) {
      return json(res, completion("Redis 缓存知识页摘要。", model));
    }

    // generate phase (system prompt includes the FILE-block protocol)
    if (hold.enabled) {
      hold.enabled = false;
      await new Promise<void>((resolve) => {
        release = resolve;
        startedResolve();
      });
    }
    return json(
      res,
      completion(
        [
          '<<<FILE path="wiki/concepts/redis.md">>>',
          "---",
          "type: concept",
          "title: Redis",
          "description: In-memory cache",
          "sources:",
          "  - source.md",
          "---",
          "Redis is an in-memory cache.",
          "<<<END>>>",
        ].join("\n"),
        model,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    server,
    baseUrl,
    requests,
    hold,
    startHold: () => {
      started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      hold.enabled = true;
      (hold as { started: Promise<void> }).started = started;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function startTrap(): Promise<{ server: Server; url: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url });
    res.statusCode = 500;
    res.end("trap upstream must not be called");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    server,
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const managedFingerprint = (provider: string, baseUrl: string, model: string, apiKey: string) =>
  modelConfigFingerprint({ provider, baseUrl, modelId: model, apiKey });

let dataDir: string;
let db: Db;
let fixture: Fixture;
let trap: Awaited<ReturnType<typeof startTrap>>;
let callback: { server: Server; url: string; posts: unknown[]; close: () => Promise<void> };
let proxy: { server: Server; url: string; requests: Array<{ path?: string; authorization: string | string[] | undefined; model: string }>; close: () => Promise<void> };

/**
 * Minimal context_proxy stand-in: authenticates the knowledge-service key, then
 * forwards with the *same* active snapshot credential/model the direct path
 * uses (what MemoryProxy's extraction override does in production).
 */
async function startProxy(target: string): Promise<typeof proxy> {
  const requests: Array<{ path?: string; authorization: string | string[] | undefined; model: string }> = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      model: String(body.model ?? ""),
    });
    const forwarded = await fetch(target.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer provider-key-v1",
      },
      body: JSON.stringify({ ...body, model: "snapshot-model-v1" }),
    });
    const text = await forwarded.text();
    res.statusCode = forwarded.status;
    res.setHeader("content-type", "application/json");
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function startCallback(): Promise<typeof callback> {
  const posts: unknown[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    posts.push({ url: req.url, body: raw });
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function globalConfig(url: string): LlmConfig {
  return {
    mode: "custom",
    protocol: "openai",
    provider: "trap",
    apiKey: "trap-key",
    model: "trap-model",
    baseUrl: url,
    maxTokens: 4096,
    timeoutMs: 5_000,
  };
}

function bind(
  module: KnowledgeModule,
  serviceId: string,
  overrides: {
    model?: string;
    apiKey?: string;
    version?: number;
    enabled?: boolean;
    fingerprint?: string;
    reason?: string | null;
  } = {},
) {
  const model = overrides.model ?? "snapshot-model-v1";
  const apiKey = overrides.apiKey ?? "provider-key-v1";
  const version = overrides.version ?? 1;
  module.llmBindingStore.upsert(serviceId, {
    mode: "byo",
    config_source: "managed",
    enabled: overrides.enabled ?? true,
    provider: "deepseek",
    protocol: "openai",
    model,
    base_url: fixture.baseUrl,
    api_key: apiKey,
    config_id: `snap-${version}`,
    config_version: version,
    snapshot_id: `snap-${version}`,
    fingerprint: overrides.fingerprint ?? managedFingerprint("deepseek", fixture.baseUrl, model, apiKey),
    unavailable_reason: overrides.reason ?? undefined,
  });
}

function newModule(): KnowledgeModule {
  return createKnowledgeModule({
    dataDir,
    db,
    llmConfig: globalConfig(trap.url),
    tmcCallbackUrl: callback.url,
  });
}

async function runIngest(
  module: KnowledgeModule,
  serviceId: string,
  teamId: string,
  name: string,
  sourceName = "source.md",
) {
  const { row } = module.wikiService.create({ service_id: serviceId, team_id: teamId, name });
  const wikiId = row.wiki_id;
  const dir = module.wikiService.dirFor(serviceId, teamId, wikiId);
  mkdirSync(join(dir, "wiki", "concepts"), { recursive: true });
  writeFileSync(
    join(dir, "wiki", "concepts", "redis.md"),
    "---\ntype: concept\ntitle: Redis\ndescription: Existing\nsources:\n  - old.md\n---\nRedis is a cache.\n",
    "utf-8",
  );
  module.wikiService.rawWrite(
    serviceId,
    teamId,
    wikiId,
    sourceName,
    `# Redis\nRedis is an in-memory cache.\n`,
  );
  const result = module.wikiService.ingest(serviceId, teamId, wikiId);
  expect(result.kind).toBe("ok");
  await module.wikiService.onIdle(wikiId);
  return { wikiId, dir };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "wiki-snapshot-"));
  db = createDb({ path: ":memory:" }).db;
  fixture = await startFixture();
  trap = await startTrap();
  callback = await startCallback();
  proxy = await startProxy(fixture.baseUrl);
});

afterEach(async () => {
  await fixture.close();
  await trap.close();
  await callback.close();
  await proxy.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Wiki jobs pin one managed model snapshot", () => {
  it("uses the active snapshot for body, merge and summary, never the global upstream", async () => {
    const module = newModule();
    bind(module, "svc-a");
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    let wikiId: string;
    try {
      ({ wikiId } = await runIngest(module, "svc-a", "team-a", "wiki-a"));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const row = module.wikiService.get("svc-a", "team-a", wikiId);
    expect(row?.status).toBe("ready");
    expect(row?.summary).toBe("Redis 缓存知识页摘要。");

    const phases = fixture.requests.map((r) => r.system);
    expect(phases.some((s) => s.includes("Output only the analysis itself"))).toBe(true);
    expect(phases.some((s) => s.includes("Merge two markdown pages"))).toBe(true);
    expect(phases.some((s) => s.includes("知识库摘要生成器"))).toBe(true);
    // Structured (JSON) analysis output is carried into the generation prompt on
    // the same snapshot — the fixture returns JSON for the analysis phase.
    expect(
      fixture.requests.some((r) => r.prompt.includes('"plan":"one concept page"')),
    ).toBe(true);
    for (const request of fixture.requests) {
      expect(request.model).toBe("snapshot-model-v1");
      expect(request.authorization).toBe("Bearer provider-key-v1");
    }
    expect(trap.requests).toHaveLength(0);
    // Diagnostics record provenance but never the credential.
    const logText = logs.join("\n");
    expect(logText).toContain("snapshot-model-v1");
    expect(logText).toContain("configId");
    expect(logText).not.toContain("provider-key-v1");
  });

  it("keeps an in-flight job on its snapshot and switches only the next job", async () => {
    const module = newModule();
    bind(module, "svc-a");
    fixture.startHold();
    const { row } = module.wikiService.create({ service_id: "svc-a", team_id: "team-a", name: "wiki-switch" });
    const dir = module.wikiService.dirFor("svc-a", "team-a", row.wiki_id);
    mkdirSync(join(dir, "wiki", "concepts"), { recursive: true });
    writeFileSync(
      join(dir, "wiki", "concepts", "redis.md"),
      "---\ntype: concept\ntitle: Redis\ndescription: Existing\nsources:\n  - old.md\n---\nRedis is a cache.\n",
      "utf-8",
    );
    module.wikiService.rawWrite("svc-a", "team-a", row.wiki_id, "source.md", "# Redis\nbody\n");
    module.wikiService.ingest("svc-a", "team-a", row.wiki_id);
    // The generate request is now blocked inside the fixture.
    await fixture.hold.started;
    // Switch the active configuration while the job is running.
    bind(module, "svc-a", { model: "snapshot-model-v2", apiKey: "provider-key-v2", version: 2 });
    fixture.hold.release?.();
    await module.wikiService.onIdle(row.wiki_id);

    const firstJob = fixture.requests.slice();
    expect(firstJob.every((r) => r.model === "snapshot-model-v1")).toBe(true);
    expect(firstJob.every((r) => r.authorization === "Bearer provider-key-v1")).toBe(true);

    // A new job picks up v2 — old job rows are untouched.
    fixture.requests.length = 0;
    module.wikiService.rawWrite("svc-a", "team-a", row.wiki_id, "source2.md", "# Redis 2\nmore\n");
    module.wikiService.ingest("svc-a", "team-a", row.wiki_id);
    await module.wikiService.onIdle(row.wiki_id);
    expect(fixture.requests.length).toBeGreaterThan(0);
    for (const request of fixture.requests) {
      expect(request.model).toBe("snapshot-model-v2");
      expect(request.authorization).toBe("Bearer provider-key-v2");
    }
    expect(trap.requests).toHaveLength(0);
  });

  it("reuses the persisted snapshot after a restart and isolates instances", async () => {
    const first = newModule();
    bind(first, "svc-a");
    bind(first, "svc-b", { model: "snapshot-model-b", apiKey: "provider-key-b", version: 4 });

    fixture.requests.length = 0;
    const restarted = newModule();
    const a = await runIngest(restarted, "svc-a", "team-a", "wiki-a-restart");
    expect(restarted.wikiService.get("svc-a", "team-a", a.wikiId)?.status).toBe("ready");
    const aRequests = fixture.requests.slice();
    expect(aRequests.length).toBeGreaterThan(0);
    expect(aRequests.every((r) => r.model === "snapshot-model-v1")).toBe(true);

    fixture.requests.length = 0;
    const b = await runIngest(restarted, "svc-b", "team-b", "wiki-b");
    expect(restarted.wikiService.get("svc-b", "team-b", b.wikiId)?.status).toBe("ready");
    expect(fixture.requests.length).toBeGreaterThan(0);
    for (const request of fixture.requests) {
      expect(request.model).toBe("snapshot-model-b");
      expect(request.authorization).toBe("Bearer provider-key-b");
    }
    expect(trap.requests).toHaveLength(0);
  });

  it("fails closed after pause without falling back to the global upstream", async () => {
    const module = newModule();
    bind(module, "svc-a");
    const first = await runIngest(module, "svc-a", "team-a", "wiki-pause");
    expect(module.wikiService.get("svc-a", "team-a", first.wikiId)?.status).toBe("ready");
    const callsBeforePause = fixture.requests.length;

    bind(module, "svc-a", { enabled: false, reason: "paused" });
    module.wikiService.rawWrite("svc-a", "team-a", first.wikiId, "source2.md", "# Redis 2\nmore\n");
    module.wikiService.ingest("svc-a", "team-a", first.wikiId);
    await module.wikiService.onIdle(first.wikiId);

    const row = module.wikiService.get("svc-a", "team-a", first.wikiId);
    expect(row?.status).toBe("failed");
    expect(row?.sync_error).toContain("MODEL_CONFIG_UNAVAILABLE(paused)");
    expect(fixture.requests).toHaveLength(callsBeforePause);
    expect(trap.requests).toHaveLength(0);
  });

  it("keeps direct and proxied transports on the same provider/model/credential", async () => {
    const module = newModule();
    // Direct (byo) instance.
    bind(module, "svc-direct");
    // Proxied instance: KS gets a knowledge-service key; the proxy resolves the
    // same active snapshot (provider/model/credential) for forwarding.
    module.llmBindingStore.upsert("svc-proxy", {
      mode: "proxy",
      config_source: "managed",
      enabled: true,
      provider: "deepseek",
      protocol: "openai",
      model: "snapshot-model-v1",
      base_url: fixture.baseUrl,
      proxy_base_url: proxy.url,
      api_key: "ks-user-key",
      config_id: "snap-1",
      config_version: 1,
      snapshot_id: "snap-1",
      fingerprint: managedFingerprint("deepseek", fixture.baseUrl, "snapshot-model-v1", "provider-key-v1"),
    });

    await runIngest(module, "svc-direct", "team-a", "wiki-direct");
    const directCalls = fixture.requests.splice(0);
    expect(directCalls.length).toBeGreaterThan(0);
    expect(directCalls.every((r) => r.model === "snapshot-model-v1")).toBe(true);
    expect(directCalls.every((r) => r.authorization === "Bearer provider-key-v1")).toBe(true);

    await runIngest(module, "svc-proxy", "team-b", "wiki-proxy");
    const proxiedCalls = fixture.requests.splice(0);
    expect(proxy.requests.length).toBeGreaterThan(0);
    expect(proxy.requests.every((r) => r.authorization === "Bearer ks-user-key")).toBe(true);
    expect(proxy.requests.every((r) => r.path?.startsWith("/proxy/svc-proxy/v1/"))).toBe(true);
    expect(proxiedCalls.length).toBeGreaterThan(0);
    expect(proxiedCalls.every((r) => r.model === "snapshot-model-v1")).toBe(true);
    expect(proxiedCalls.every((r) => r.authorization === "Bearer provider-key-v1")).toBe(true);
    expect(trap.requests).toHaveLength(0);
  });

  it("fails closed on a stale fingerprint", async () => {
    const module = newModule();
    bind(module, "svc-a", { fingerprint: "sha256:0000000000000000" });
    const { row } = module.wikiService.create({ service_id: "svc-a", team_id: "team-a", name: "wiki-mismatch" });
    module.wikiService.rawWrite("svc-a", "team-a", row.wiki_id, "source.md", "# Redis\nbody\n");
    module.wikiService.ingest("svc-a", "team-a", row.wiki_id);
    await module.wikiService.onIdle(row.wiki_id);

    const after = module.wikiService.get("svc-a", "team-a", row.wiki_id);
    expect(after?.status).toBe("failed");
    expect(after?.sync_error).toContain("MODEL_CONFIG_UNAVAILABLE(fingerprint_mismatch)");
    expect(fixture.requests).toHaveLength(0);
    expect(trap.requests).toHaveLength(0);
  });
});
