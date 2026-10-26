import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import type { IMetadataStore } from "./interface.js";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import { runInstanceUpstreamStoreContract } from "./instance-upstream.contract.js";
import { EXTRACTION_GROUP_NAME } from "../types.js";

let server: MongoMemoryReplSet;
let client: MongoClient;
let sequence = 0;
const names = new WeakMap<IMetadataStore, string>();

function makeStore(): MongoMetadataStore {
  const dbName = `instance_upstream_contract_${++sequence}`;
  const store = new MongoMetadataStore(client, dbName);
  names.set(store, dbName);
  return store;
}

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

runInstanceUpstreamStoreContract(
  "MongoDB",
  async () => makeStore(),
  async (store) => {
    const dbName = names.get(store);
    if (dbName) await client.db(dbName).dropDatabase();
  },
);

describe("MongoDB extraction compatibility", () => {
  it("returns the default provider for legacy documents without provider", async () => {
    const dbName = `instance_upstream_legacy_${++sequence}`;
    const store = new MongoMetadataStore(client, dbName);
    await store.init();
    await client.db(dbName).collection("meta_instance_upstream_config").insertOne({
      id: 1,
      group_id: "ext-legacy",
      group_type: "extraction",
      name: EXTRACTION_GROUP_NAME,
      agents: [],
      enabled: true,
      mode: "custom_unified",
      base_url: "https://legacy.example/v1",
      api_key: "legacy-secret",
      model_id: "legacy-model",
      description: "legacy config",
      version: 7,
      supported_agents_snapshot: [],
      created_at: "2026-10-25T00:00:00.000Z",
      updated_at: "2026-10-25T00:00:00.000Z",
    });
    expect(await store.getInstanceUpstreamGroup("ext-legacy")).toMatchObject({
      provider: "openai-compatible",
      api_key: "legacy-secret",
      version: 7,
    });
    await client.db(dbName).dropDatabase();
  });
});
