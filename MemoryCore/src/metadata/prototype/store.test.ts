import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import { runPrototypeStoreContract } from "./store.contract.js";

let mongoServer: MongoMemoryReplSet;
let mongoClient: MongoClient;
let sqliteDir: string;

const emptySnapshot = {
  format_version: 1 as const,
  views: ["create"],
  components: [],
};

const groupDefinition = {
  properties: {},
  slots: { children: ["field"] },
  bindings: [],
  interactions: [],
  views: ["create"],
};

runPrototypeStoreContract(
  "SQLite",
  async () => {
    sqliteDir = mkdtempSync(join(tmpdir(), "memhub-prototype-sqlite-"));
    const dbPath = join(sqliteDir, "metadata.db");
    const store = new SqliteMetadataStore(dbPath);
    return store;
  },
  async (store) => {
    await store.close();
    rmSync(sqliteDir, { recursive: true, force: true });
  },
);

describe("MongoDB", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    mongoClient = await MongoClient.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoClient?.close();
    await mongoServer?.stop();
  });

  runPrototypeStoreContract(
    "MongoDB",
    async () => {
      const dbName = "prototype_store_contract";
      const store = new MongoMetadataStore(mongoClient, dbName, {
        ownsClient: false,
      });
      return store;
    },
    async (store) => {
      await store.close();
      await mongoClient.db("prototype_store_contract").dropDatabase();
    },
  );

  it("reconciles a concurrent duplicate request key to the successful result", async () => {
    const dbName = "prototype_mongo_duplicate_key";
    const storeA = new MongoMetadataStore(mongoClient, dbName, {
      ownsClient: false,
    });
    const storeB = new MongoMetadataStore(mongoClient, dbName, {
      ownsClient: false,
    });
    await Promise.all([storeA.init(), storeB.init()]);

    const request = {
      asset_id: "asset",
      request_id: "same-key",
      author_id: "user",
      pages: [
        { page_key: "page", base_version: null, snapshot: emptySnapshot },
      ],
    };
    const results = await Promise.allSettled([
      storeA.prototype.savePages(request),
      storeB.prototype.savePages(request),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
      expect(results[1].value).toEqual(results[0].value);
    }
    const history = await storeA.prototype.listPageVersions({
      asset_id: "asset",
      page_key: "page",
    });
    expect(history).toHaveLength(1);

    await Promise.all([storeA.close(), storeB.close()]);
    await mongoClient.db(dbName).dropDatabase();
  });

  it("fails closed when MongoDB transactions are disabled", async () => {
    const dbName = "prototype_mongo_no_transactions";
    const store = new MongoMetadataStore(mongoClient, dbName, {
      ownsClient: false,
      useTransactions: false,
    });
    await store.init();

    await expect(
      store.prototype.publishContract({
        asset_id: "asset",
        component_type: "group",
        contract_version: 1,
        definition: groupDefinition,
        author_id: "user",
      }),
    ).rejects.toMatchObject({ reason: "transactions_required" });

    await store.close();
    await mongoClient.db(dbName).dropDatabase();
  });
});
