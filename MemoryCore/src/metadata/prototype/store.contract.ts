import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IMetadataStore } from "../store/interface.js";
import type { Definition, Snapshot } from "./schema.js";
import { PrototypeStoreError } from "./store.js";

const groupDefinition: Definition = {
  properties: {},
  slots: { children: ["field"] },
  bindings: [],
  interactions: [],
  views: ["create"],
};

const fieldDefinition: Definition = {
  properties: {
    label: { type: "string", required: true },
  },
  slots: {},
  bindings: ["value"],
  interactions: [],
  views: ["create"],
};

const emptySnapshot: Snapshot = {
  format_version: 1,
  views: ["create"],
  components: [],
};

const fieldSnapshot: Snapshot = {
  format_version: 1,
  views: ["create"],
  components: [
    {
      id: "group",
      type: "group",
      contract_version: 1,
      parent_id: null,
      slot: null,
      order: 0,
      props: {},
      bindings: {},
    },
    {
      id: "field",
      type: "field",
      contract_version: 1,
      parent_id: "group",
      slot: "children",
      order: 0,
      props: { label: "Name" },
      bindings: { value: "customer.name" },
    },
  ],
};

export function runPrototypeStoreContract(
  name: string,
  makeStore: () => Promise<IMetadataStore>,
  teardown: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`Prototype store contract: ${name}`, () => {
    let store: IMetadataStore;

    beforeEach(async () => {
      store = await makeStore();
      await store.init();
    });

    afterEach(async () => {
      await teardown(store);
    });

    it("publishes immutable contracts idempotently", async () => {
      const input = {
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      };
      const first = await store.prototype.publishContract(input);
      const replay = await store.prototype.publishContract(input);
      expect(replay).toEqual(first);
      expect(Object.hasOwn(first, "_id")).toBe(false);

      await expect(
        store.prototype.publishContract({
          ...input,
          definition: {
            ...groupDefinition,
            views: ["edit"],
          },
        }),
      ).rejects.toBeInstanceOf(PrototypeStoreError);

      await expect(
        store.prototype.publishContract({
          ...input,
          component_type: "field",
          definition: fieldDefinition,
        }),
      ).resolves.toMatchObject({ component_type: "field" });

      const contracts = await store.prototype.listContracts({
        asset_id: "asset",
      });
      expect(contracts).toHaveLength(2);
      expect(Object.hasOwn(contracts[0], "_id")).toBe(false);
    });

    it("saves pages atomically and replays the same request", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "field",
        contract_version: 1,
        definition: fieldDefinition,
        author_id: "user",
      });

      const request = {
        asset_id: "asset",
        request_id: "request-1",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: null, snapshot: emptySnapshot },
          { page_key: "form", base_version: null, snapshot: fieldSnapshot },
        ],
      };
      const result = await store.prototype.savePages(request);
      expect(result.pages).toEqual([
        { page_key: "list", version: 1, created_at: expect.any(String) },
        { page_key: "form", version: 1, created_at: expect.any(String) },
      ]);

      const replay = await store.prototype.savePages(request);
      expect(replay).toEqual(result);

      await expect(
        store.prototype.savePages({
          ...request,
          pages: [
            { page_key: "list", base_version: null, snapshot: fieldSnapshot },
          ],
        }),
      ).rejects.toMatchObject({ reason: "request_conflict" });

      const second = await store.prototype.savePages({
        asset_id: "asset",
        request_id: "request-2",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: 1, snapshot: fieldSnapshot },
          { page_key: "form", base_version: 1, snapshot: emptySnapshot },
        ],
      });
      expect(second.pages.map((page) => page.version)).toEqual([2, 2]);

      const pages = await store.prototype.listPages({ asset_id: "asset" });
      expect(pages).toHaveLength(2);
      expect(Object.hasOwn(pages[0], "_id")).toBe(false);

      const exact = await store.prototype.getPageVersion({
        asset_id: "asset",
        page_key: "list",
        version: 1,
      });
      expect(exact?.snapshot).toEqual(emptySnapshot);
      expect(Object.hasOwn(exact ?? {}, "_id")).toBe(false);
    });

    it("rolls back a multi-page save when a later contract is missing", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });

      await expect(
        store.prototype.savePages({
          asset_id: "asset",
          request_id: "request-broken",
          author_id: "user",
          pages: [
            { page_key: "list", base_version: null, snapshot: emptySnapshot },
            { page_key: "form", base_version: null, snapshot: fieldSnapshot },
          ],
        }),
      ).rejects.toMatchObject({ reason: "contract_not_found" });

      const pages = await store.prototype.listPages({ asset_id: "asset" });
      expect(pages).toHaveLength(0);
    });

    it("allows only one concurrent writer for the same base version", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "field",
        contract_version: 1,
        definition: fieldDefinition,
        author_id: "user",
      });
      await store.prototype.savePages({
        asset_id: "asset",
        request_id: "request-initial",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: null, snapshot: emptySnapshot },
        ],
      });

      const results = await Promise.allSettled([
        store.prototype.savePages({
          asset_id: "asset",
          request_id: "request-a",
          author_id: "user",
          pages: [
            { page_key: "list", base_version: 1, snapshot: emptySnapshot },
          ],
        }),
        store.prototype.savePages({
          asset_id: "asset",
          request_id: "request-b",
          author_id: "user",
          pages: [
            { page_key: "list", base_version: 1, snapshot: fieldSnapshot },
          ],
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(PrototypeStoreError);
        expect(rejected.reason.reason).toBe("version_conflict");
      }
    });

    it("lets another member reuse the same request key independently", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });

      const first = await store.prototype.savePages({
        asset_id: "asset",
        request_id: "shared-request",
        author_id: "user-a",
        pages: [
          { page_key: "list", base_version: null, snapshot: emptySnapshot },
        ],
      });
      const second = await store.prototype.savePages({
        asset_id: "asset",
        request_id: "shared-request",
        author_id: "user-b",
        pages: [
          { page_key: "form", base_version: null, snapshot: emptySnapshot },
        ],
      });

      expect(first.pages).toHaveLength(1);
      expect(second.pages).toHaveLength(1);
      expect(first.pages[0].page_key).toBe("list");
      expect(second.pages[0].page_key).toBe("form");
    });

    it("validates every base version before writing any page", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "field",
        contract_version: 1,
        definition: fieldDefinition,
        author_id: "user",
      });

      await store.prototype.savePages({
        asset_id: "asset",
        request_id: "request-v1",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: null, snapshot: emptySnapshot },
          { page_key: "form", base_version: null, snapshot: fieldSnapshot },
        ],
      });

      await expect(
        store.prototype.savePages({
          asset_id: "asset",
          request_id: "request-invalid",
          author_id: "user",
          pages: [
            { page_key: "list", base_version: 1, snapshot: fieldSnapshot },
            { page_key: "form", base_version: 2, snapshot: emptySnapshot },
          ],
        }),
      ).rejects.toMatchObject({
        reason: "version_conflict",
        latest_versions: { list: 1, form: 1 },
      });

      const pages = await store.prototype.listPages({ asset_id: "asset" });
      expect(pages).toEqual([
        expect.objectContaining({ page_key: "form", current_version: 1 }),
        expect.objectContaining({ page_key: "list", current_version: 1 }),
      ]);
    });

    it("restores an exact historical version without rewriting history", async () => {
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      });
      await store.prototype.publishContract({
        asset_id: "asset",
        component_type: "field",
        contract_version: 1,
        definition: fieldDefinition,
        author_id: "user",
      });

      await store.prototype.savePages({
        asset_id: "asset",
        request_id: "request-v1",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: null, snapshot: emptySnapshot },
        ],
      });
      await store.prototype.savePages({
        asset_id: "asset",
        request_id: "request-v2",
        author_id: "user",
        pages: [
          { page_key: "list", base_version: 1, snapshot: fieldSnapshot },
        ],
      });

      const restored = await store.prototype.restorePage({
        asset_id: "asset",
        page_key: "list",
        request_id: "request-restore",
        author_id: "user",
        base_version: 2,
        restore_version: 1,
      });
      expect(restored).toMatchObject({
        version: 3,
        base_version: 2,
        restore_version: 1,
        operation: "restore",
      });
      expect(restored.snapshot).toEqual(emptySnapshot);
      expect(Object.hasOwn(restored, "_id")).toBe(false);

      const replay = await store.prototype.restorePage({
        asset_id: "asset",
        page_key: "list",
        request_id: "request-restore",
        author_id: "user",
        base_version: 2,
        restore_version: 1,
      });
      expect(replay).toEqual(restored);

      const v1 = await store.prototype.getPageVersion({
        asset_id: "asset",
        page_key: "list",
        version: 1,
      });
      const v2 = await store.prototype.getPageVersion({
        asset_id: "asset",
        page_key: "list",
        version: 2,
      });
      expect(v1?.snapshot).toEqual(emptySnapshot);
      expect(v2?.snapshot).toEqual(fieldSnapshot);

      const history = await store.prototype.listPageVersions({
        asset_id: "asset",
        page_key: "list",
      });
      expect(history.map((row) => row.version)).toEqual([3, 2, 1]);
      expect(Object.hasOwn(history[0], "_id")).toBe(false);

      await expect(
        store.prototype.restorePage({
          asset_id: "asset",
          page_key: "list",
          request_id: "request-missing",
          author_id: "user",
          base_version: 3,
          restore_version: 99,
        }),
      ).rejects.toMatchObject({ reason: "version_not_found" });
    });
  });
}
