import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearCache,
  getInstanceUpstreamConfigState,
  __setForceRefreshWindowForTests,
  type InstanceUpstreamRow,
} from "../instance-upstream-cache.js";
import {
  evaluateExtractionUpstream,
  extractionDecisionError,
  sanitizeUpstreamEndpoint,
} from "../extraction-gate.js";

function row(overrides: Partial<InstanceUpstreamRow> = {}): InstanceUpstreamRow {
  return {
    group_id: "grp-extraction",
    group_type: "extraction",
    name: "extraction",
    agents: [],
    enabled: true,
    mode: "official",
    base_url: "https://api.deepseek.com",
    api_key: "sk-live",
    model_id: "deepseek-chat",
    ...overrides,
  };
}

describe("evaluateExtractionUpstream (pure)", () => {
  it("accepts a complete enabled configuration", () => {
    const d = evaluateExtractionUpstream({ items: [row()], freshness: "fresh" });
    expect(d.kind).toBe("managed");
  });

  it("treats a never-configured instance as the deployment default", () => {
    const d = evaluateExtractionUpstream({ items: [], freshness: "fresh" });
    expect(d).toEqual({ kind: "unconfigured", reason: "no_extraction_row" });
  });

  it("treats a draft-only row (never activated) as unconfigured", () => {
    const d = evaluateExtractionUpstream({
      items: [row({ enabled: false, base_url: "", api_key: "", model_id: "" })],
      freshness: "fresh",
    });
    expect(d).toEqual({ kind: "unconfigured", reason: "never_activated" });
  });

  it("reports paused when a previously active configuration is disabled", () => {
    const d = evaluateExtractionUpstream({ items: [row({ enabled: false })], freshness: "fresh" });
    expect(d.kind).toBe("paused");
  });

  it("reports incomplete when the model id is missing", () => {
    const d = evaluateExtractionUpstream({ items: [row({ model_id: "" })], freshness: "fresh" });
    expect(d).toMatchObject({ kind: "incomplete", missing: ["model_id"] });
  });

  it("reports incomplete when the api key is missing", () => {
    const d = evaluateExtractionUpstream({ items: [row({ api_key: "" })], freshness: "fresh" });
    expect(d).toMatchObject({ kind: "incomplete", missing: ["api_key"] });
  });

  it("reports unavailable for stale or failed reads (never 'unconfigured')", () => {
    expect(evaluateExtractionUpstream({ items: [], freshness: "unavailable" }))
      .toEqual({ kind: "unavailable", reason: "config_unavailable" });
    expect(evaluateExtractionUpstream({ items: [row()], freshness: "stale" }))
      .toEqual({ kind: "unavailable", reason: "config_stale" });
  });

  it("redacts credentials/query from logged endpoints", () => {
    expect(sanitizeUpstreamEndpoint("https://user:pw@api.example.com/v1/?key=secret#x"))
      .toBe("https://api.example.com/v1");
  });

  it("maps blocked decisions to stable error codes", () => {
    expect(extractionDecisionError({ kind: "paused", row: row({ enabled: false }) }).code)
      .toBe("EXTRACTION_MODEL_PAUSED");
    expect(extractionDecisionError({ kind: "incomplete", row: row(), missing: ["model_id"] }).code)
      .toBe("EXTRACTION_MODEL_INCOMPLETE");
    expect(extractionDecisionError({ kind: "unavailable", reason: "config_unavailable" }).code)
      .toBe("EXTRACTION_MODEL_UNAVAILABLE");
  });
});

// ── Cache freshness / immediate effect ───────────────────────────────────────

let server: Server;
let endpoint = "";
let mode: "ok" | "fail" = "ok";
let rows: InstanceUpstreamRow[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 500 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { items: rows } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  clearCache();
  __setForceRefreshWindowForTests(0);
  mode = "ok";
  rows = [row()];
});

const coreSkill = () => ({ endpoint, serviceToken: "svc-token", timeoutMs: 2000 });
const cacheConfig = { cacheTtlSec: 3600 };

describe("getInstanceUpstreamConfigState", () => {
  it("reads a complete configuration as fresh", async () => {
    const state = await getInstanceUpstreamConfigState(coreSkill(), "inst-1", cacheConfig, { forceRefresh: true });
    expect(state.freshness).toBe("fresh");
    expect(evaluateExtractionUpstream(state).kind).toBe("managed");
  });

  it("sees a disable immediately despite a 1h TTL", async () => {
    const first = await getInstanceUpstreamConfigState(coreSkill(), "inst-1", cacheConfig, { forceRefresh: true });
    expect(evaluateExtractionUpstream(first).kind).toBe("managed");

    rows = [row({ enabled: false })];
    const second = await getInstanceUpstreamConfigState(coreSkill(), "inst-1", cacheConfig, { forceRefresh: true });
    expect(second.freshness).toBe("fresh");
    expect(evaluateExtractionUpstream(second).kind).toBe("paused");

    rows = [row()];
    const third = await getInstanceUpstreamConfigState(coreSkill(), "inst-1", cacheConfig, { forceRefresh: true });
    expect(evaluateExtractionUpstream(third).kind).toBe("managed");
  });

  it("does not treat a read failure as unconfigured", async () => {
    mode = "fail";
    const state = await getInstanceUpstreamConfigState(coreSkill(), "inst-2", cacheConfig, { forceRefresh: true });
    expect(state.freshness).toBe("unavailable");
    expect(evaluateExtractionUpstream(state).kind).toBe("unavailable");
  });

  it("does not treat a stale copy as authoritative", async () => {
    await getInstanceUpstreamConfigState(coreSkill(), "inst-3", cacheConfig, { forceRefresh: true });
    mode = "fail";
    const state = await getInstanceUpstreamConfigState(coreSkill(), "inst-3", cacheConfig, { forceRefresh: true });
    expect(state.freshness).toBe("stale");
    expect(evaluateExtractionUpstream(state).kind).toBe("unavailable");
  });

  it("treats a missing model id as incomplete", async () => {
    rows = [row({ model_id: "" })];
    const state = await getInstanceUpstreamConfigState(coreSkill(), "inst-4", cacheConfig, { forceRefresh: true });
    expect(evaluateExtractionUpstream(state)).toMatchObject({ kind: "incomplete", missing: ["model_id"] });
  });
});
