import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import type { Db } from "../db/client.js";
import {
  StaleLlmBindingError,
  createLlmBindingStore,
  modelConfigFingerprint,
  resolveLlmBinding,
  sanitizeEndpointForLog,
} from "./index.js";
import type { LlmConfig } from "../config.js";

const fallback: LlmConfig = {
  mode: "proxy",
  protocol: "openai",
  provider: "global",
  apiKey: "",
  model: "global-model",
  baseUrl: "",
  maxTokens: 4096,
  timeoutMs: 10_000,
};

let db: Db;

beforeEach(() => {
  db = createDb({ path: ":memory:" }).db;
});

function managed(overrides: Partial<Parameters<ReturnType<typeof createLlmBindingStore>["upsert"]>[1]> = {}) {
  const store = createLlmBindingStore(db);
  return store.upsert("svc-a", {
    mode: "byo",
    config_source: "managed",
    enabled: true,
    provider: "deepseek",
    protocol: "openai",
    model: "deepseek-chat",
    base_url: "https://api.deepseek.com/v1",
    api_key: "sk-test-secret",
    config_id: "snap-1",
    config_version: 1,
    fingerprint: modelConfigFingerprint({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      apiKey: "sk-test-secret",
    }),
    snapshot_id: "snap-1",
    ...overrides,
  });
}

describe("managed model binding resolver", () => {
  it("pins provider/model/protocol/version and never uses the global model", () => {
    const store = createLlmBindingStore(db);
    managed();
    const resolved = resolveLlmBinding("svc-a", store.get("svc-a"), fallback);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.managed).toBe(true);
    expect(resolved.config.model).toBe("deepseek-chat");
    expect(resolved.config.provider).toBe("deepseek");
    expect(resolved.config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(resolved.config.apiKey).toBe("sk-test-secret");
    expect(resolved.meta).toMatchObject({
      source: "managed",
      config_id: "snap-1",
      version: 1,
      model: "deepseek-chat",
      endpoint: "https://api.deepseek.com/v1",
    });
  });

  it("fails closed when the managed binding is paused (no global fallback)", () => {
    const store = createLlmBindingStore(db);
    managed();
    store.upsert("svc-a", { mode: "byo", enabled: false, unavailable_reason: "paused" });
    const resolved = resolveLlmBinding("svc-a", store.get("svc-a"), {
      ...fallback,
      mode: "custom",
      apiKey: "global-key",
      baseUrl: "https://global.invalid",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("paused");
    expect(resolved.message).toContain("config=snap-1");
    expect(resolved.message).toContain("version=1");
  });

  it("fails closed when a managed snapshot is incomplete", () => {
    const store = createLlmBindingStore(db);
    managed();
    store.upsert("svc-a", { mode: "byo", model: null });
    const resolved = resolveLlmBinding("svc-a", store.get("svc-a"), fallback);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("incomplete");
    expect(resolved.message).toContain("model");
  });

  it("recomputes the fingerprint in byo mode and fails on mismatch", () => {
    const store = createLlmBindingStore(db);
    managed({ api_key: "sk-different-key" });
    const resolved = resolveLlmBinding("svc-a", store.get("svc-a"), fallback);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("fingerprint_mismatch");
  });

  it("keeps legacy deployment rows on the global model", () => {
    const store = createLlmBindingStore(db);
    store.upsert("svc-a", {
      mode: "byo",
      base_url: "https://legacy.invalid/v1",
      api_key: "legacy-key",
      enabled: true,
    });
    const resolved = resolveLlmBinding("svc-a", store.get("svc-a"), {
      ...fallback,
      mode: "custom",
      model: "global-model",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.managed).toBe(false);
    expect(resolved.config.model).toBe("global-model");
    expect(resolved.meta.source).toBe("deployment");
  });

  it("never rolls a managed snapshot back to an older version", () => {
    const store = createLlmBindingStore(db);
    managed({ config_version: 3 });
    expect(() => managed({ config_version: 2 })).toThrow(StaleLlmBindingError);
    expect(store.get("svc-a")?.config_version).toBe(3);
  });

  it("sanitizes endpoints for logs", () => {
    expect(sanitizeEndpointForLog("https://user:pass@api.example.com/v1/chat?key=abc#x")).toBe(
      "https://api.example.com/v1/chat",
    );
    expect(sanitizeEndpointForLog("not a url")).toBe("(invalid)");
    expect(sanitizeEndpointForLog(null)).toBe("(none)");
  });

  it("pins the shared fingerprint algorithm with a fixed vector", () => {
    expect(
      modelConfigFingerprint({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        modelId: "deepseek-chat",
        apiKey: "sk-test-secret",
      }),
    ).toBe("sha256:7f71139bafa01982");
  });
});
