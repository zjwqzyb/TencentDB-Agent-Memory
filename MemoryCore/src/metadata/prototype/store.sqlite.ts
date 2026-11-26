import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Definition, Snapshot } from "./schema.js";
import {
  prototypeDefinitionFingerprint,
  prototypeRequestFingerprint,
  PrototypeStoreError,
  type PrototypeContractEntity,
  type PrototypeContractFilter,
  type PrototypeContractInput,
  type PrototypeContractRef,
  type PrototypePageEntity,
  type PrototypePageFilter,
  type PrototypePageVersionEntity,
  type PrototypePageVersionFilter,
  type PrototypePageVersionRef,
  type PrototypeRestoreInput,
  type PrototypeSaveInput,
  type PrototypeSaveResult,
  type PrototypeStore,
} from "./store.js";

type SqliteRow = Record<string, SQLInputValue>;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: SQLInputValue): T {
  return JSON.parse(String(value)) as T;
}

export class SqlitePrototypeStore implements PrototypeStore {
  constructor(private readonly db: DatabaseSync) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_prototype_contracts (
        asset_id TEXT NOT NULL,
        component_type TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_fingerprint TEXT NOT NULL,
        author_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, component_type, contract_version)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_prototype_contracts_asset_type
        ON meta_prototype_contracts(asset_id, component_type);

      CREATE TABLE IF NOT EXISTS meta_prototype_pages (
        asset_id TEXT NOT NULL,
        page_key TEXT NOT NULL,
        current_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, page_key)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_prototype_pages_asset
        ON meta_prototype_pages(asset_id);

      CREATE TABLE IF NOT EXISTS meta_prototype_versions (
        asset_id TEXT NOT NULL,
        page_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        base_version INTEGER,
        author_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('save', 'restore')),
        restore_version INTEGER,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, page_key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_prototype_versions_page
        ON meta_prototype_versions(asset_id, page_key, version DESC);

      CREATE TABLE IF NOT EXISTS meta_prototype_requests (
        asset_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('save', 'restore')),
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, author_id, request_id)
      );
    `);
  }

  close(): void {}

  async publishContract(input: PrototypeContractInput): Promise<PrototypeContractEntity> {
    const fingerprint = prototypeDefinitionFingerprint(input.definition);
    const now = nowIso();

    return this.withImmediateTx(() => {
      const existing = this.findContract({
        asset_id: input.asset_id,
        component_type: input.component_type,
        contract_version: input.contract_version,
      });
      if (existing) {
        if (existing.definition_fingerprint === fingerprint) return existing;
        throw new PrototypeStoreError(
          "contract_conflict",
          `Contract ${input.component_type}@${input.contract_version} already exists with different content`,
        );
      }

      this.run(
        `INSERT INTO meta_prototype_contracts
          (asset_id, component_type, contract_version, definition_json, definition_fingerprint, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.asset_id,
        input.component_type,
        input.contract_version,
        JSON.stringify(input.definition),
        fingerprint,
        input.author_id,
        now,
      );

      return this.mapContract({
        asset_id: input.asset_id,
        component_type: input.component_type,
        contract_version: input.contract_version,
        definition_json: JSON.stringify(input.definition),
        definition_fingerprint: fingerprint,
        author_id: input.author_id,
        created_at: now,
      });
    });
  }

  async getContract(input: PrototypeContractRef): Promise<PrototypeContractEntity | null> {
    return this.findContract(input);
  }

  private findContract(input: PrototypeContractRef): PrototypeContractEntity | null {
    const row = this.get<SqliteRow>(
      `SELECT * FROM meta_prototype_contracts
       WHERE asset_id = ? AND component_type = ? AND contract_version = ?`,
      input.asset_id,
      input.component_type,
      input.contract_version,
    );
    return row ? this.mapContract(row) : null;
  }

  async listContracts(input: PrototypeContractFilter): Promise<PrototypeContractEntity[]> {
    const conditions = ["asset_id = ?"];
    const params: SQLInputValue[] = [input.asset_id];
    if (input.component_type !== undefined) {
      conditions.push("component_type = ?");
      params.push(input.component_type);
    }
    const rows = this.all<SqliteRow>(
      `SELECT * FROM meta_prototype_contracts
       WHERE ${conditions.join(" AND ")}
       ORDER BY component_type ASC, contract_version ASC`,
      ...params,
    );
    return rows.map((row) => this.mapContract(row));
  }

  async listPages(input: PrototypePageFilter): Promise<PrototypePageEntity[]> {
    const conditions = ["asset_id = ?"];
    const params: SQLInputValue[] = [input.asset_id];
    if (input.page_key !== undefined) {
      conditions.push("page_key = ?");
      params.push(input.page_key);
    }
    const rows = this.all<SqliteRow>(
      `SELECT * FROM meta_prototype_pages
       WHERE ${conditions.join(" AND ")}
       ORDER BY page_key ASC`,
      ...params,
    );
    return rows.map((row) => this.mapPage(row));
  }

  async listPageVersions(
    input: PrototypePageVersionFilter,
  ): Promise<PrototypePageVersionEntity[]> {
    const limit = input.limit === undefined ? "" : ` LIMIT ${Number(input.limit)}`;
    const offset = input.offset === undefined ? "" : ` OFFSET ${Number(input.offset)}`;
    const rows = this.all<SqliteRow>(
      `SELECT * FROM meta_prototype_versions
       WHERE asset_id = ? AND page_key = ?
       ORDER BY version DESC${limit}${offset}`,
      input.asset_id,
      input.page_key,
    );
    return rows.map((row) => this.mapVersion(row));
  }

  async getPageVersion(
    input: PrototypePageVersionRef,
  ): Promise<PrototypePageVersionEntity | null> {
    return this.findPageVersion(input);
  }

  private findPageVersion(
    input: PrototypePageVersionRef,
  ): PrototypePageVersionEntity | null {
    const row = this.get<SqliteRow>(
      `SELECT * FROM meta_prototype_versions
       WHERE asset_id = ? AND page_key = ? AND version = ?`,
      input.asset_id,
      input.page_key,
      input.version,
    );
    return row ? this.mapVersion(row) : null;
  }

  async savePages(input: PrototypeSaveInput): Promise<PrototypeSaveResult> {
    const fingerprint = prototypeRequestFingerprint("save", {
      author_id: input.author_id,
      pages: input.pages,
    });
    const now = nowIso();

    return this.withImmediateTx(() => {
      const replay = this.getRequest(
        input.asset_id,
        input.author_id,
        input.request_id,
      );
      if (replay) {
        if (replay.fingerprint === fingerprint) {
          return replay.result as PrototypeSaveResult;
        }
        throw new PrototypeStoreError(
          "request_conflict",
          `Request ${input.request_id} already exists with different content`,
        );
      }

      const prepared = input.pages.map((page) => {
        this.assertContractsForSnapshot(input.asset_id, page.snapshot);
        const current = this.getPage(input.asset_id, page.page_key);
        const currentVersion = current?.current_version ?? null;
        if (currentVersion !== page.base_version) {
          throw new PrototypeStoreError(
            "version_conflict",
            `Page ${page.page_key} base version mismatch`,
            this.latestVersions(input),
          );
        }
        return {
          page,
          current,
          currentVersion,
          nextVersion: currentVersion === null ? 1 : currentVersion + 1,
        };
      });

      const pages: PrototypeSaveResult["pages"] = [];
      for (const { page, current, currentVersion, nextVersion } of prepared) {
        this.insertVersion({
          asset_id: input.asset_id,
          page_key: page.page_key,
          version: nextVersion,
          base_version: currentVersion,
          author_id: input.author_id,
          request_id: input.request_id,
          operation: "save",
          restore_version: null,
          snapshot: page.snapshot,
          created_at: now,
        });

        if (current) {
          this.updatePagePointer(input.asset_id, page.page_key, nextVersion, now);
        } else {
          this.insertPage(input.asset_id, page.page_key, nextVersion, now);
        }

        pages.push({
          page_key: page.page_key,
          version: nextVersion,
          created_at: now,
        });
      }

      const result: PrototypeSaveResult = {
        asset_id: input.asset_id,
        request_id: input.request_id,
        pages,
      };
      this.insertRequest(
        input.asset_id,
        input.author_id,
        input.request_id,
        "save",
        fingerprint,
        result,
        now,
      );
      return result;
    });
  }

  async restorePage(input: PrototypeRestoreInput): Promise<PrototypePageVersionEntity> {
    const fingerprint = prototypeRequestFingerprint("restore", {
      author_id: input.author_id,
      page_key: input.page_key,
      base_version: input.base_version,
      restore_version: input.restore_version,
    });
    const now = nowIso();

    return this.withImmediateTx(() => {
      const replay = this.getRequest(
        input.asset_id,
        input.author_id,
        input.request_id,
      );
      if (replay) {
        if (replay.fingerprint === fingerprint) {
          return replay.result as PrototypePageVersionEntity;
        }
        throw new PrototypeStoreError(
          "request_conflict",
          `Request ${input.request_id} already exists with different content`,
        );
      }

      const current = this.getPage(input.asset_id, input.page_key);
      const currentVersion = current?.current_version ?? null;
      if (currentVersion !== input.base_version) {
        throw new PrototypeStoreError(
          "version_conflict",
          `Page ${input.page_key} base version mismatch`,
          { [input.page_key]: currentVersion },
        );
      }

      const target = this.findPageVersion({
        asset_id: input.asset_id,
        page_key: input.page_key,
        version: input.restore_version,
      });
      if (!target) {
        throw new PrototypeStoreError(
          "version_not_found",
          `Page ${input.page_key} version ${input.restore_version} not found`,
        );
      }

      const nextVersion = currentVersion === null ? 1 : currentVersion + 1;
      const row: PrototypePageVersionEntity = {
        asset_id: input.asset_id,
        page_key: input.page_key,
        version: nextVersion,
        base_version: currentVersion,
        author_id: input.author_id,
        request_id: input.request_id,
        operation: "restore",
        restore_version: input.restore_version,
        snapshot: target.snapshot,
        created_at: now,
      };
      this.insertVersion(row);
      if (current) {
        this.updatePagePointer(input.asset_id, input.page_key, nextVersion, now);
      } else {
        this.insertPage(input.asset_id, input.page_key, nextVersion, now);
      }
      this.insertRequest(
        input.asset_id,
        input.author_id,
        input.request_id,
        "restore",
        fingerprint,
        row,
        now,
      );
      return row;
    });
  }

  private assertContractsForSnapshot(assetId: string, snapshot: Snapshot): void {
    for (const component of snapshot.components) {
      const contract = this.findContract({
        asset_id: assetId,
        component_type: component.type,
        contract_version: component.contract_version,
      });
      if (!contract) {
        throw new PrototypeStoreError(
          "contract_not_found",
          `Contract ${component.type}@${component.contract_version} not found`,
        );
      }
    }
  }

  private latestVersions(
    input: PrototypeSaveInput,
  ): Record<string, number | null> {
    const result: Record<string, number | null> = {};
    for (const page of input.pages) {
      const current = this.getPage(input.asset_id, page.page_key);
      result[page.page_key] = current?.current_version ?? null;
    }
    return result;
  }

  private getPage(
    assetId: string,
    pageKey: string,
  ): PrototypePageEntity | null {
    const row = this.get<SqliteRow>(
      `SELECT * FROM meta_prototype_pages WHERE asset_id = ? AND page_key = ?`,
      assetId,
      pageKey,
    );
    return row ? this.mapPage(row) : null;
  }

  private insertPage(
    assetId: string,
    pageKey: string,
    currentVersion: number,
    now: string,
  ): void {
    this.run(
      `INSERT INTO meta_prototype_pages
        (asset_id, page_key, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      assetId,
      pageKey,
      currentVersion,
      now,
      now,
    );
  }

  private updatePagePointer(
    assetId: string,
    pageKey: string,
    currentVersion: number,
    now: string,
  ): void {
    this.run(
      `UPDATE meta_prototype_pages
       SET current_version = ?, updated_at = ?
       WHERE asset_id = ? AND page_key = ?`,
      currentVersion,
      now,
      assetId,
      pageKey,
    );
  }

  private insertVersion(row: PrototypePageVersionEntity): void {
    this.run(
      `INSERT INTO meta_prototype_versions
        (asset_id, page_key, version, base_version, author_id, request_id, operation, restore_version, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.asset_id,
      row.page_key,
      row.version,
      row.base_version,
      row.author_id,
      row.request_id,
      row.operation,
      row.restore_version,
      JSON.stringify(row.snapshot),
      row.created_at,
    );
  }

  private getRequest(
    assetId: string,
    authorId: string,
    requestId: string,
  ): { fingerprint: string; result: unknown } | null {
    const row = this.get<SqliteRow>(
      `SELECT request_fingerprint, result_json FROM meta_prototype_requests
       WHERE asset_id = ? AND author_id = ? AND request_id = ?`,
      assetId,
      authorId,
      requestId,
    );
    if (!row) return null;
    return {
      fingerprint: String(row.request_fingerprint),
      result: JSON.parse(String(row.result_json)),
    };
  }

  private insertRequest(
    assetId: string,
    authorId: string,
    requestId: string,
    operation: "save" | "restore",
    fingerprint: string,
    result: unknown,
    now: string,
  ): void {
    this.run(
      `INSERT INTO meta_prototype_requests
        (asset_id, request_id, author_id, operation, request_fingerprint, result_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      assetId,
      requestId,
      authorId,
      operation,
      fingerprint,
      JSON.stringify(result),
      now,
      now,
    );
  }

  private mapContract(row: SqliteRow): PrototypeContractEntity {
    return {
      asset_id: String(row.asset_id),
      component_type: String(row.component_type),
      contract_version: Number(row.contract_version),
      definition: parseJson<Definition>(row.definition_json),
      definition_fingerprint: String(row.definition_fingerprint),
      author_id: String(row.author_id),
      created_at: String(row.created_at),
    };
  }

  private mapPage(row: SqliteRow): PrototypePageEntity {
    return {
      asset_id: String(row.asset_id),
      page_key: String(row.page_key),
      current_version:
        row.current_version === null ? null : Number(row.current_version),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private mapVersion(row: SqliteRow): PrototypePageVersionEntity {
    return {
      asset_id: String(row.asset_id),
      page_key: String(row.page_key),
      version: Number(row.version),
      base_version: row.base_version === null ? null : Number(row.base_version),
      author_id: String(row.author_id),
      request_id: String(row.request_id),
      operation: String(row.operation) as "save" | "restore",
      restore_version:
        row.restore_version === null ? null : Number(row.restore_version),
      snapshot: parseJson<Snapshot>(row.snapshot_json),
      created_at: String(row.created_at),
    };
  }

  private withImmediateTx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private get<T = SqliteRow>(sql: string, ...params: SQLInputValue[]): T | null {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  private all<T = SqliteRow>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
}
