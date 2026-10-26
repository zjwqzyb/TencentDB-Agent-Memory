import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runInstanceUpstreamStoreContract } from "./instance-upstream.contract.js";
import { EXTRACTION_GROUP_NAME } from "../types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

runInstanceUpstreamStoreContract(
  "SQLite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => (store as SqliteMetadataStore).close(),
);

describe("SQLite extraction persistence", () => {
  it("retains the complete extraction row after closing and reopening a file database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memhub-extraction-persist-"));
    const dbPath = join(dir, "metadata.db");
    try {
      const first = new SqliteMetadataStore(dbPath);
      first.init();
      const created = first.createInstanceUpstreamGroup({
        group_type: "extraction",
        name: EXTRACTION_GROUP_NAME,
        mode: "custom_unified",
        provider: "glm",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api_key: "short",
        model_id: "glm-4-plus",
        description: "persist me",
      });
      first.close();

      const second = new SqliteMetadataStore(dbPath);
      second.init();
      expect(second.getInstanceUpstreamGroup(created.group_id)).toEqual(created);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds provider to an existing extraction table without dropping its data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memhub-extraction-migrate-"));
    const dbPath = join(dir, "metadata.db");
    try {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE meta_instance_upstream_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          group_type TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          agents TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          mode TEXT NOT NULL DEFAULT 'official',
          base_url TEXT NOT NULL DEFAULT '',
          api_key TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          supported_agents_snapshot TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(group_id)
        );
      `);
      legacy.prepare(`
        INSERT INTO meta_instance_upstream_config
          (group_id, group_type, name, agents, enabled, mode, base_url, api_key,
           model_id, description, version, supported_agents_snapshot, created_at, updated_at)
        VALUES (?, 'extraction', ?, '[]', 1, 'custom_unified', ?, ?, ?, ?, 7, '[]', ?, ?)
      `).run(
        "ext-legacy",
        EXTRACTION_GROUP_NAME,
        "https://legacy.example/v1",
        "legacy-secret",
        "legacy-model",
        "legacy config",
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
      );
      legacy.close();

      const store = new SqliteMetadataStore(dbPath);
      store.init();
      expect(store.getInstanceUpstreamGroup("ext-legacy")).toMatchObject({
        provider: "openai-compatible",
        base_url: "https://legacy.example/v1",
        api_key: "legacy-secret",
        model_id: "legacy-model",
        description: "legacy config",
        version: 7,
        updated_at: "2026-10-25T00:00:00.000Z",
      });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
