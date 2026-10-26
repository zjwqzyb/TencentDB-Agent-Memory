import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IMetadataStore } from "./interface.js";
import {
  EXTRACTION_GROUP_NAME,
  InstanceUpstreamWriteConflictError,
  type InstanceUpstreamConfigEntity,
} from "../types.js";

export function runInstanceUpstreamStoreContract(
  name: string,
  makeStore: () => Promise<IMetadataStore>,
  teardown: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`InstanceUpstream store contract: ${name}`, () => {
    let store: IMetadataStore;

    beforeEach(async () => {
      store = await makeStore();
      await store.init();
    });

    afterEach(async () => {
      await teardown(store);
    });

    async function createExtraction(
      over: Partial<Parameters<IMetadataStore["createInstanceUpstreamGroup"]>[0]> = {},
    ): Promise<InstanceUpstreamConfigEntity> {
      return store.createInstanceUpstreamGroup({
        group_type: "extraction",
        name: EXTRACTION_GROUP_NAME,
        mode: "custom_unified",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-deepseek-secret",
        model_id: "deepseek-chat",
        description: "primary extraction model",
        ...over,
      });
    }

    it("persists provider and returns the complete extraction row", async () => {
      const created = await createExtraction();
      expect(created).toMatchObject({
        group_id: expect.stringMatching(/^ext-/),
        group_type: "extraction",
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-deepseek-secret",
        model_id: "deepseek-chat",
        version: 1,
      });

      expect(await store.getInstanceUpstreamGroup(created.group_id)).toEqual(created);
    });

    it("keeps the extraction row singular per store", async () => {
      await createExtraction();
      await expect(createExtraction()).rejects.toMatchObject({
        reason: "extraction_already_exists",
      } satisfies Partial<InstanceUpstreamWriteConflictError>);
    });

    it("preserves the key when update omits it and replaces it only when supplied", async () => {
      const created = await createExtraction();

      const descriptionOnly = await store.updateInstanceUpstreamGroup({
        group_id: created.group_id,
        expected_group_type: "extraction",
        expected_version: created.version,
        provider: "glm",
        description: "updated note",
      });
      expect(descriptionOnly).toMatchObject({
        provider: "glm",
        api_key: created.api_key,
        description: "updated note",
        version: created.version + 1,
      });

      const replaced = await store.updateInstanceUpstreamGroup({
        group_id: created.group_id,
        expected_group_type: "extraction",
        expected_version: descriptionOnly.version,
        api_key: "sk-replacement",
      });
      expect(replaced.api_key).toBe("sk-replacement");
      expect(replaced.provider).toBe("glm");
    });

    it("rejects stale update and toggle versions", async () => {
      const created = await createExtraction();
      const updated = await store.updateInstanceUpstreamGroup({
        group_id: created.group_id,
        expected_group_type: "extraction",
        expected_version: created.version,
        description: "new version",
      });

      await expect(
        async () =>
          store.updateInstanceUpstreamGroup({
            group_id: created.group_id,
            expected_group_type: "extraction",
            expected_version: created.version,
            description: "stale",
          }),
      ).rejects.toMatchObject({ reason: "version_mismatch" });

      await expect(
        async () =>
          store.toggleInstanceUpstreamGroup({
            group_id: created.group_id,
            enabled: false,
            expected_version: created.version,
          }),
      ).rejects.toMatchObject({ reason: "version_mismatch" });

      const toggled = await store.toggleInstanceUpstreamGroup({
        group_id: created.group_id,
        enabled: false,
        expected_version: updated.version,
      });
      expect(toggled).toMatchObject({
        enabled: false,
        provider: "deepseek",
        version: updated.version + 1,
      });
    });

    it("allows only one write when two callers race on the same version", async () => {
      const created = await createExtraction();
      const results = await Promise.allSettled([
        (async () => store.updateInstanceUpstreamGroup({
          group_id: created.group_id,
          expected_group_type: "extraction",
          expected_version: created.version,
          description: "first writer",
        }))(),
        (async () => store.updateInstanceUpstreamGroup({
          group_id: created.group_id,
          expected_group_type: "extraction",
          expected_version: created.version,
          description: "second writer",
        }))(),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ reason: "version_mismatch" }),
      });
    });

    it("uses the OpenAI-compatible provider for legacy rows that omit provider", async () => {
      const created = await createExtraction({ provider: undefined });
      expect(created.provider).toBe("openai-compatible");
    });
  });
}
