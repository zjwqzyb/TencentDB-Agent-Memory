import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import type { IMetadataStore } from "../store/interface.js";
import type { Snapshot } from "./schema.js";

// Reject a write in the storage engine after the first page of the batch has
// written its version and advanced its pointer. Inspect the physical records.
describe.each(["SQLite", "MongoDB"])("%s transaction failure", (backend) => {
  let store: IMetadataStore;
  let installFault: () => Promise<void>;
  let clearFault: () => Promise<void>;
  let counts: () => Promise<number[]>;
  let cleanup: () => Promise<void>;
  const tables = [
    "meta_prototype_versions",
    "meta_prototype_pages",
    "meta_prototype_requests",
  ];
  beforeAll(async () => {
    if (backend === "SQLite") {
      const dir = mkdtempSync(join(tmpdir(), "prototype-fault-"));
      const path = join(dir, "metadata.db");
      store = new SqliteMetadataStore(path);
      await store.init();
      const probe = new DatabaseSync(path);
      installFault = async () => {
        probe.exec(`CREATE TRIGGER reject_second_version BEFORE INSERT ON meta_prototype_versions
        WHEN NEW.page_key='form' BEGIN SELECT RAISE(ABORT,'fixture: second page rejected'); END`);
      };
      clearFault = async () => {
        probe.exec("DROP TRIGGER reject_second_version");
      };
      counts = async () =>
        tables.map((table) =>
          Number(probe.prepare("SELECT COUNT(*) AS n FROM " + table).get()?.n),
        );
      cleanup = async () => {
        probe.close();
        await store.close();
        rmSync(dir, { recursive: true, force: true });
      };
    } else {
      const replica = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
      });
      const client = await MongoClient.connect(replica.getUri());
      const db = client.db("prototype_fault");
      store = new MongoMetadataStore(client, db.databaseName, {
        ownsClient: false,
      });
      await store.init();
      installFault = async () => {
        await db.command({
          collMod: tables[0],
          validator: { page_key: { $ne: "form" } },
          validationAction: "error",
        });
      };
      clearFault = async () => {
        await db.command({ collMod: tables[0], validator: {} });
      };
      counts = () =>
        Promise.all(
          tables.map((table) => db.collection(table).countDocuments({})),
        );
      cleanup = async () => {
        await store.close();
        await client.close();
        await replica.stop();
      };
    }
  });
  afterAll(async () => {
    await cleanup?.();
  });
  it("leaves no orphaned version, head or receipt and accepts the exact retry", async () => {
    const snapshot: Snapshot = {
      format_version: 1,
      views: ["list"],
      components: [],
    };
    const request = {
      asset_id: "asset",
      author_id: "editor",
      request_id: "dropped-batch",
      pages: ["list", "form"].map((page_key) => ({
        page_key,
        base_version: null,
        snapshot,
      })),
    };
    await installFault();
    await expect(async () =>
      store.prototype.savePages(request),
    ).rejects.toThrow();
    expect(await counts()).toEqual([0, 0, 0]);
    await clearFault();
    const first = await store.prototype.savePages(request);
    expect(first.pages.map((row) => [row.page_key, row.version])).toEqual([
      ["list", 1],
      ["form", 1],
    ]);
    expect(await store.prototype.savePages(request)).toEqual(first);
    expect(await counts()).toEqual([2, 2, 1]);
  });
});
