import { describe, expect, it } from "vitest";
import {
  modelConfigFingerprint,
  newModelConfigSnapshotId,
} from "./model-config-fingerprint.js";

describe("modelConfigFingerprint", () => {
  const base = {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-chat",
    apiKey: "sk-test",
  };

  it("matches the fixed cross-surface test vector", () => {
    expect(modelConfigFingerprint(base)).toBe("sha256:0f4a34ca2735badd");
  });

  it("normalizes trailing slashes on the base URL", () => {
    expect(modelConfigFingerprint({ ...base, baseUrl: "https://api.deepseek.com///" }))
      .toBe(modelConfigFingerprint(base));
  });

  it("changes when the API key or model id changes", () => {
    const original = modelConfigFingerprint(base);
    expect(modelConfigFingerprint({ ...base, apiKey: "sk-other" })).not.toBe(original);
    expect(modelConfigFingerprint({ ...base, modelId: "deepseek-reasoner" }))
      .not.toBe(original);
  });

  it("generates a prefixed immutable snapshot id", () => {
    const first = newModelConfigSnapshotId(1_790_000_000_000);
    const second = newModelConfigSnapshotId(1_790_000_000_000);
    expect(first).toMatch(/^snap_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toMatch(/^snap_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).not.toBe(first);
  });
});
