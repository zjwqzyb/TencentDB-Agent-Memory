import { describe, expect, it } from "vitest";
import { sanitizeEndpoint } from "./endpoint.js";
import { ModelSnapshotResolver, normalizeActiveSnapshot } from "./resolver.js";
import { ModelSnapshotError, type ModelSnapshotSource } from "./types.js";

const READY = {
  status: "ready",
  snapshot: {
    snapshot_id: "snap_01",
    version: 7,
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    api_key: "sk-secret-value",
    model_id: "deepseek-chat",
    description: "",
    activated_at: "2026-10-26T00:00:00.000Z",
  },
};

function sourceReturning(
  value: unknown,
  opts?: { managed?: boolean; throwOnResolve?: boolean; throwOnProbe?: boolean },
): ModelSnapshotSource {
  return {
    async resolveActiveSnapshot() {
      if (opts?.throwOnResolve) throw new Error("db down");
      return value as Record<string, unknown>;
    },
    async hasManagedConfiguration() {
      if (opts?.throwOnProbe) throw new Error("probe down");
      return opts?.managed ?? false;
    },
  };
}

describe("normalizeActiveSnapshot", () => {
  it("freezes a complete ready snapshot", () => {
    const snap = normalizeActiveSnapshot(READY);
    expect(snap).not.toBeNull();
    expect(snap).toMatchObject({
      configId: "snap_01",
      version: 7,
      provider: "deepseek",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-chat",
    });
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("rejects a ready snapshot missing the model id", () => {
    const broken = { ...READY, snapshot: { ...READY.snapshot, model_id: "  " } };
    expect(normalizeActiveSnapshot(broken)).toBeNull();
  });
});

describe("sanitizeEndpoint", () => {
  it("keeps origin + path and drops credentials/query/hash", () => {
    expect(sanitizeEndpoint("https://user:pw@api.example.com/v1/?key=secret#frag"))
      .toBe("https://api.example.com/v1");
  });
});

describe("ModelSnapshotResolver", () => {
  it("returns the frozen snapshot for a ready configuration", async () => {
    const resolver = new ModelSnapshotResolver({ source: sourceReturning(READY) });
    const snap = await resolver.resolveForJob("l1");
    expect(snap?.configId).toBe("snap_01");
    expect(snap?.version).toBe(7);
    expect(snap?.modelId).toBe("deepseek-chat");
  });

  it("fails closed when the managed configuration is paused", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning({ status: "paused" }),
    });
    await expect(resolver.resolveForJob("l2")).rejects.toMatchObject({
      name: "ModelSnapshotError",
      code: "MODEL_SNAPSHOT_PAUSED",
    });
  });

  it("fails closed when the managed configuration is invalid", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning({ status: "invalid", reason: "active_snapshot_missing_base_url" }),
    });
    await expect(resolver.resolveForJob("l3")).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_INVALID",
    });
  });

  it("fails closed when a managed extraction row exists but has no active snapshot", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning({ status: "config_unavailable" }, { managed: true }),
    });
    await expect(resolver.resolveForJob("skill")).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_UNAVAILABLE",
    });
  });

  it("uses the deployment default only when the instance was never configured", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning({ status: "config_unavailable" }, { managed: false }),
    });
    await expect(resolver.resolveForJob("l1")).resolves.toBeNull();
  });

  it("fails closed when the metadata read throws", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning(null, { throwOnResolve: true }),
    });
    await expect(resolver.resolveForJob("l1")).rejects.toBeInstanceOf(ModelSnapshotError);
  });

  it("fails closed when the managed-state probe throws", async () => {
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning({ status: "config_unavailable" }, { throwOnProbe: true }),
    });
    await expect(resolver.resolveForJob("l2")).rejects.toMatchObject({
      code: "MODEL_SNAPSHOT_UNAVAILABLE",
    });
  });

  it("returns null when no metadata source is wired (open-source deployment)", async () => {
    const resolver = new ModelSnapshotResolver({});
    await expect(resolver.resolveForJob("l3")).resolves.toBeNull();
  });

  it("never logs the api key or authorization header", async () => {
    const lines: string[] = [];
    const logger = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: (m: string) => lines.push(m),
    };
    const resolver = new ModelSnapshotResolver({
      source: sourceReturning(READY),
      logger,
      instanceId: "inst-1",
    });
    await resolver.resolveForJob("l1");
    const joined = lines.join("\n");
    expect(joined).toContain("model.snapshot.resolved");
    expect(joined).toContain("snap_01");
    expect(joined).toContain("\"version\":7");
    expect(joined).toContain("deepseek-chat");
    expect(joined).toContain("https://api.deepseek.com");
    expect(joined).not.toContain("sk-secret-value");
    expect(joined.toLowerCase()).not.toContain("authorization");
  });
});
