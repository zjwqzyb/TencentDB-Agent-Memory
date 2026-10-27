/**
 * End-to-end (job-level) integration tests for the managed model snapshot.
 *
 * A deterministic OpenAI-compatible HTTP fixture records every upstream
 * request. The pipeline factories are mocked so each job runs the REAL
 * `StandaloneLLMRunner` (real HTTP) against the fixture, while the surrounding
 * L1/L2/L3 logic is replaced by a stub that performs the same kind of
 * multi-call work a real job does.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => {
  return {
    created: [] as Array<{ job: string; llmRunner: any }>,
  };
});

vi.mock("../../utils/pipeline-factory.js", () => {
  const record = (job: string, opts: any) => {
    captured.created.push({ job, llmRunner: opts.llmRunner });
  };
  return {
    L1_BATCH_PROCESS: 10,
    L1_BATCH_QUERY: 20,
    initDataDirectories: () => undefined,
    initStores: async () => ({}),
    resetStores: async () => undefined,
    createPipelineManager: () => ({}) as any,
    createPersister: () => ({}) as any,
    createL1Runner: (opts: any) => {
      record("l1", opts);
      return async () => {
        await opts.llmRunner.run({ prompt: "l1-prompt", taskId: "l1-task" });
        return { processedCount: 1, storedCount: 1, hasMore: false, hasFullBacklog: false, profileScopes: [] };
      };
    },
    createL2Runner: (opts: any) => {
      record("l2", opts);
      return async () => {
        // Two upstream requests in one job (tool-loop / multi-step analogue).
        await opts.llmRunner.run({ prompt: "l2-prompt-1", taskId: "l2-task" });
        if (typeof (globalThis as any).__midJobSwitch === "function") {
          (globalThis as any).__midJobSwitch();
        }
        await opts.llmRunner.run({ prompt: "l2-prompt-2", taskId: "l2-task" });
        return { skipped: false };
      };
    },
    createL3Runner: (opts: any) => {
      record("l3", opts);
      return async () => {
        await opts.llmRunner.run({ prompt: "l3-prompt", taskId: "l3-task" });
      };
    },
  };
});

const { TdaiCore } = await import("../tdai-core.js");

interface Recorded {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let upstream: Server;
let trap: Server;
let upstreamUrl = "";
let trapUrl = "";
let recorded: Recorded[] = [];
let trapHits = 0;

function startServer(handler: (req: any, res: any, body: any) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

beforeAll(async () => {
  const a = await startServer((req, res, body) => {
    recorded.push({ url: req.url ?? "", headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: body?.model ?? "unknown",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  upstream = a.server;
  upstreamUrl = a.url;

  const b = await startServer((_req, res) => {
    trapHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  trap = b.server;
  trapUrl = b.url;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => trap.close(() => r()));
});

beforeEach(() => {
  recorded = [];
  trapHits = 0;
  captured.created = [];
});

afterEach(() => {
  delete (globalThis as any).__midJobSwitch;
});

function snapshot(version: number, modelId: string) {
  return {
    status: "ready",
    snapshot: {
      snapshot_id: `snap_${version}`,
      version,
      provider: "deepseek",
      base_url: `${upstreamUrl}/v1`,
      api_key: `sk-v${version}`,
      model_id: modelId,
      description: "",
      activated_at: "2026-10-26T00:00:00.000Z",
    },
  };
}

function makeCore(current: () => any, opts?: { throwOnRead?: boolean }) {
  const logs: string[] = [];
  const logger = {
    debug: (m: string) => logs.push(m),
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const core = new TdaiCore({
    hostAdapter: {
      hostType: "standalone",
      getRuntimeContext: () => ({ dataDir: "/tmp/tdai-model-snapshot-test" }) as any,
      getLogger: () => logger as any,
      getLLMRunnerFactory: () => ({
        createRunner: () => ({
          async run() {
            // Trap runner: every request through the deployment default lands here.
            trapHits += 1;
            return "trap";
          },
        }),
      }),
    } as any,
    config: {
      llm: {
        enabled: true,
        provider: "openai",
        baseUrl: `${trapUrl}/v1`,
        apiKey: "trap-key",
        model: "trap-model",
        maxTokens: 64,
        timeoutMs: 5000,
      },
      skill: { enabled: false },
      embedding: { enabled: false, dimensions: 0 },
    } as any,
    instanceId: "inst-1",
    modelSnapshotSourceFactory: async () => ({
      async resolveActiveSnapshot() {
        if (opts?.throwOnRead) throw new Error("metadata down");
        return current();
      },
      async hasManagedConfiguration() {
        return false;
      },
    }),
  });
  return { core, logs };
}

const fakeStore = {} as any;
const fakeEmbedding = {} as any;

describe("managed snapshot → memory L1/L2/L3 jobs", () => {
  it("L1 hits the managed endpoint/model/credential and never the global trap", async () => {
    const { core } = makeCore(() => snapshot(1, "deepseek-chat"));
    await core.runL1WithStore("sess-1", fakeStore, fakeEmbedding);

    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/v1/chat/completions");
    expect(recorded[0].headers.authorization).toBe("Bearer sk-v1");
    expect(recorded[0].body.model).toBe("deepseek-chat");
  });

  it("L2 and L3 hit the managed endpoint/model/credential", async () => {
    const { core } = makeCore(() => snapshot(2, "glm-4"));
    await core.runL2WithStore("sess-1", fakeStore);
    await core.runL3WithStore(fakeStore);

    expect(trapHits).toBe(0);
    const models = recorded.map((r) => r.body.model);
    expect(models).toEqual(["glm-4", "glm-4", "glm-4"]);
    for (const req of recorded) {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers.authorization).toBe("Bearer sk-v2");
    }
  });

  it("freezes the snapshot at job start; a mid-job switch only affects the next job", async () => {
    let current = snapshot(1, "deepseek-chat");
    const { core } = makeCore(() => current);
    (globalThis as any).__midJobSwitch = () => {
      current = snapshot(9, "deepseek-reasoner");
    };

    await core.runL2WithStore("sess-1", fakeStore);
    expect(recorded.map((r) => r.body.model)).toEqual(["deepseek-chat", "deepseek-chat"]);
    expect(recorded.every((r) => r.headers.authorization === "Bearer sk-v1")).toBe(true);

    recorded = [];
    await core.runL2WithStore("sess-1", fakeStore);
    expect(recorded.map((r) => r.body.model)).toEqual(["deepseek-reasoner", "deepseek-reasoner"]);
    expect(recorded.every((r) => r.headers.authorization === "Bearer sk-v9")).toBe(true);
  });

  it("fails closed on a paused configuration without touching the global trap", async () => {
    const { core } = makeCore(() => ({ status: "paused" }));
    await expect(core.runL1WithStore("sess-1", fakeStore, fakeEmbedding)).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_PAUSED",
    });
    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("fails closed on an invalid configuration without touching the global trap", async () => {
    const { core } = makeCore(() => ({ status: "invalid", reason: "active_snapshot_missing_api_key" }));
    await expect(core.runL3WithStore(fakeStore)).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_INVALID",
    });
    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("fails closed when the snapshot cannot be read", async () => {
    const { core } = makeCore(() => snapshot(1, "deepseek-chat"), { throwOnRead: true });
    await expect(core.runL2WithStore("sess-1", fakeStore)).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_UNAVAILABLE",
    });
    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("logs config id/version/provider/model/endpoint/job type without secrets", async () => {
    const { core, logs } = makeCore(() => snapshot(4, "glm-4-flash"));
    await core.runL1WithStore("sess-1", fakeStore, fakeEmbedding);

    const joined = logs.join("\n");
    expect(joined).toContain("model.snapshot.resolved");
    expect(joined).toContain("model.job.started");
    expect(joined).toContain("model.job.succeeded");
    expect(joined).toContain("snap_4");
    expect(joined).toContain("\"version\":4");
    expect(joined).toContain("glm-4-flash");
    expect(joined).toContain("\"job_type\":\"l1\"");
    expect(joined).toContain(`127.0.0.1`);
    expect(joined).not.toContain("sk-v4");
    expect(joined.toLowerCase()).not.toContain("authorization");
  });
});

describe("managed snapshot → Skill extraction job", () => {
  it("uses the managed endpoint/model/credential", async () => {
    const { core } = makeCore(() => snapshot(5, "deepseek-chat"));
    const runner = await core.buildSkillRunnerForInstance("inst-1");
    expect(runner).toBeDefined();
    await runner!.run({ prompt: "skill-prompt", taskId: "skill-task" });

    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/v1/chat/completions");
    expect(recorded[0].headers.authorization).toBe("Bearer sk-v5");
    expect(recorded[0].body.model).toBe("deepseek-chat");
  });

  it("fails closed when the managed configuration is paused", async () => {
    const { core } = makeCore(() => ({ status: "paused" }));
    await expect(core.buildSkillRunnerForInstance("inst-1")).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_PAUSED",
    });
    expect(trapHits).toBe(0);
    expect(recorded).toHaveLength(0);
  });
});
