import type { ClientSession, Db, Document, MongoClient } from "mongodb";
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

const PROJECT_NO_ID = { projection: { _id: 0 } } as const;

function nowIso(): string {
  return new Date().toISOString();
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

function isRequestKeyDuplicate(error: unknown): boolean {
  if (!isDuplicateKeyError(error)) return false;
  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  return (
    !!keyPattern &&
    ["asset_id", "author_id", "request_id"].every((key) => key in keyPattern)
  );
}

export interface MongoPrototypeStoreOptions {
  useTransactions?: boolean;
}

export class MongoPrototypeStore implements PrototypeStore {
  private readonly useTransactions: boolean;

  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    opts: MongoPrototypeStoreOptions = {},
  ) {
    this.useTransactions = opts.useTransactions ?? true;
  }

  async init(): Promise<void> {
    await Promise.all([
      this.db.collection("meta_prototype_contracts").createIndex(
        { asset_id: 1, component_type: 1, contract_version: 1 },
        { unique: true },
      ),
      this.db.collection("meta_prototype_contracts").createIndex(
        { asset_id: 1, component_type: 1 },
      ),
      this.db.collection("meta_prototype_pages").createIndex(
        { asset_id: 1, page_key: 1 },
        { unique: true },
      ),
      this.db.collection("meta_prototype_pages").createIndex({ asset_id: 1 }),
      this.db.collection("meta_prototype_versions").createIndex(
        { asset_id: 1, page_key: 1, version: 1 },
        { unique: true },
      ),
      this.db.collection("meta_prototype_versions").createIndex(
        { asset_id: 1, page_key: 1, version: -1 },
      ),
      this.db.collection("meta_prototype_requests").createIndex(
        { asset_id: 1, author_id: 1, request_id: 1 },
        { unique: true },
      ),
    ]);
  }

  async close(): Promise<void> {}

  async publishContract(
    input: PrototypeContractInput,
  ): Promise<PrototypeContractEntity> {
    const fingerprint = prototypeDefinitionFingerprint(input.definition);
    const now = nowIso();

    try {
      return await this.withTx(async (session) => {
        const doc = await this.db
          .collection("meta_prototype_contracts")
          .findOneAndUpdate(
            {
              asset_id: input.asset_id,
              component_type: input.component_type,
              contract_version: input.contract_version,
            } as Document,
            {
              $setOnInsert: {
                asset_id: input.asset_id,
                component_type: input.component_type,
                contract_version: input.contract_version,
                definition: input.definition,
                definition_fingerprint: fingerprint,
                author_id: input.author_id,
                created_at: now,
              },
            },
            {
              upsert: true,
              returnDocument: "after",
              projection: { _id: 0 },
              session,
            },
          );
        const entity = this.mapContract((doc ?? {}) as Document);
        if (entity.definition_fingerprint !== fingerprint) {
          throw new PrototypeStoreError(
            "contract_conflict",
            `Contract ${input.component_type}@${input.contract_version} already exists with different content`,
          );
        }
        return entity;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await this.getContract(input);
        if (existing && existing.definition_fingerprint === fingerprint) {
          return existing;
        }
        if (existing) {
          throw new PrototypeStoreError(
            "contract_conflict",
            `Contract ${input.component_type}@${input.contract_version} already exists with different content`,
          );
        }
      }
      throw error;
    }
  }

  async getContract(
    input: PrototypeContractRef,
    session?: ClientSession,
  ): Promise<PrototypeContractEntity | null> {
    const doc = await this.db
      .collection("meta_prototype_contracts")
      .findOne(
        {
          asset_id: input.asset_id,
          component_type: input.component_type,
          contract_version: input.contract_version,
        } as Document,
        { projection: { _id: 0 }, session },
      );
    return doc ? this.mapContract(doc) : null;
  }

  async listContracts(
    input: PrototypeContractFilter,
  ): Promise<PrototypeContractEntity[]> {
    const query: Document = { asset_id: input.asset_id };
    if (input.component_type !== undefined) {
      query.component_type = input.component_type;
    }
    const docs = await this.db
      .collection("meta_prototype_contracts")
      .find(query, PROJECT_NO_ID)
      .sort({ component_type: 1, contract_version: 1 })
      .toArray();
    return docs.map((doc) => this.mapContract(doc));
  }

  async listPages(
    input: PrototypePageFilter,
  ): Promise<PrototypePageEntity[]> {
    const query: Document = { asset_id: input.asset_id };
    if (input.page_key !== undefined) {
      query.page_key = input.page_key;
    }
    const docs = await this.db
      .collection("meta_prototype_pages")
      .find(query, PROJECT_NO_ID)
      .sort({ page_key: 1 })
      .toArray();
    return docs.map((doc) => this.mapPage(doc));
  }

  async listPageVersions(
    input: PrototypePageVersionFilter,
  ): Promise<PrototypePageVersionEntity[]> {
    let cursor = this.db
      .collection("meta_prototype_versions")
      .find(
        { asset_id: input.asset_id, page_key: input.page_key } as Document,
        PROJECT_NO_ID,
      )
      .sort({ version: -1 });
    if (input.offset !== undefined) {
      cursor = cursor.skip(input.offset);
    }
    if (input.limit !== undefined) {
      cursor = cursor.limit(input.limit);
    }
    const docs = await cursor.toArray();
    return docs.map((doc) => this.mapVersion(doc));
  }

  async getPageVersion(
    input: PrototypePageVersionRef,
    session?: ClientSession,
  ): Promise<PrototypePageVersionEntity | null> {
    const doc = await this.db
      .collection("meta_prototype_versions")
      .findOne(
        {
          asset_id: input.asset_id,
          page_key: input.page_key,
          version: input.version,
        } as Document,
        { projection: { _id: 0 }, session },
      );
    return doc ? this.mapVersion(doc) : null;
  }

  async savePages(
    input: PrototypeSaveInput,
  ): Promise<PrototypeSaveResult> {
    const fingerprint = prototypeRequestFingerprint("save", {
      author_id: input.author_id,
      pages: input.pages,
    });
    const now = nowIso();

    try {
      return await this.withTx(async (session) => {
        const replay = await this.getRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
          session,
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

        const prepared: Array<{
          page: PrototypeSaveInput["pages"][number];
          current: PrototypePageEntity | null;
          currentVersion: number | null;
          nextVersion: number;
        }> = [];
        for (const page of input.pages) {
          await this.assertContractsForSnapshot(
            input.asset_id,
            page.snapshot,
            session,
          );

          const current = await this.getPage(
            input.asset_id,
            page.page_key,
            session,
          );
          const currentVersion = current?.current_version ?? null;
          if (currentVersion !== page.base_version) {
            throw new PrototypeStoreError(
              "version_conflict",
              `Page ${page.page_key} base version mismatch`,
              await this.latestVersions(input, session),
            );
          }
          prepared.push({
            page,
            current,
            currentVersion,
            nextVersion: currentVersion === null ? 1 : currentVersion + 1,
          });
        }

        const pages: PrototypeSaveResult["pages"] = [];
        for (const {
          page,
          current,
          currentVersion,
          nextVersion,
        } of prepared) {
          await this.insertVersion(
            {
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
            },
            session,
          );

          if (current) {
            await this.updatePagePointer(
              input.asset_id,
              page.page_key,
              currentVersion,
              nextVersion,
              now,
              session,
            );
          } else {
            await this.insertPage(
              input.asset_id,
              page.page_key,
              nextVersion,
              now,
              session,
            );
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
        await this.insertRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
          "save",
          fingerprint,
          result,
          now,
          session,
        );
        return result;
      });
    } catch (error) {
      if (isRequestKeyDuplicate(error)) {
        const replay = await this.getRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
        );
        if (replay && replay.fingerprint === fingerprint) {
          return replay.result as PrototypeSaveResult;
        }
        if (replay) {
          throw new PrototypeStoreError(
            "request_conflict",
            `Request ${input.request_id} already exists with different content`,
          );
        }
      }
      if (isDuplicateKeyError(error)) {
        throw new PrototypeStoreError(
          "version_conflict",
          "Concurrent prototype write changed the page version",
          await this.latestVersions(input),
        );
      }
      throw error;
    }
  }

  async restorePage(
    input: PrototypeRestoreInput,
  ): Promise<PrototypePageVersionEntity> {
    const fingerprint = prototypeRequestFingerprint("restore", {
      author_id: input.author_id,
      page_key: input.page_key,
      base_version: input.base_version,
      restore_version: input.restore_version,
    });
    const now = nowIso();

    try {
      return await this.withTx(async (session) => {
        const replay = await this.getRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
          session,
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

        const current = await this.getPage(
          input.asset_id,
          input.page_key,
          session,
        );
        const currentVersion = current?.current_version ?? null;
        if (currentVersion !== input.base_version) {
          throw new PrototypeStoreError(
            "version_conflict",
            `Page ${input.page_key} base version mismatch`,
            { [input.page_key]: currentVersion },
          );
        }

        const target = await this.getPageVersion(
          {
            asset_id: input.asset_id,
            page_key: input.page_key,
            version: input.restore_version,
          },
          session,
        );
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
        await this.insertVersion(row, session);
        if (current) {
          await this.updatePagePointer(
            input.asset_id,
            input.page_key,
            currentVersion,
            nextVersion,
            now,
            session,
          );
        } else {
          await this.insertPage(
            input.asset_id,
            input.page_key,
            nextVersion,
            now,
            session,
          );
        }
        await this.insertRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
          "restore",
          fingerprint,
          row,
          now,
          session,
        );
        return row;
      });
    } catch (error) {
      if (isRequestKeyDuplicate(error)) {
        const replay = await this.getRequest(
          input.asset_id,
          input.author_id,
          input.request_id,
        );
        if (replay && replay.fingerprint === fingerprint) {
          return replay.result as PrototypePageVersionEntity;
        }
        if (replay) {
          throw new PrototypeStoreError(
            "request_conflict",
            `Request ${input.request_id} already exists with different content`,
          );
        }
      }
      if (isDuplicateKeyError(error)) {
        const current = await this.getPage(input.asset_id, input.page_key);
        throw new PrototypeStoreError(
          "version_conflict",
          "Concurrent prototype write changed the page version",
          { [input.page_key]: current?.current_version ?? null },
        );
      }
      throw error;
    }
  }

  private async assertContractsForSnapshot(
    assetId: string,
    snapshot: Snapshot,
    session?: ClientSession,
  ): Promise<void> {
    for (const component of snapshot.components) {
      const contract = await this.getContract(
        {
          asset_id: assetId,
          component_type: component.type,
          contract_version: component.contract_version,
        },
        session,
      );
      if (!contract) {
        throw new PrototypeStoreError(
          "contract_not_found",
          `Contract ${component.type}@${component.contract_version} not found`,
        );
      }
    }
  }

  private async getPage(
    assetId: string,
    pageKey: string,
    session?: ClientSession,
  ): Promise<PrototypePageEntity | null> {
    const doc = await this.db
      .collection("meta_prototype_pages")
      .findOne(
        { asset_id: assetId, page_key: pageKey } as Document,
        { projection: { _id: 0 }, session },
      );
    return doc ? this.mapPage(doc) : null;
  }

  private async latestVersions(
    input: PrototypeSaveInput,
    session?: ClientSession,
  ): Promise<Record<string, number | null>> {
    const result: Record<string, number | null> = {};
    for (const page of input.pages) {
      const current = await this.getPage(
        input.asset_id,
        page.page_key,
        session,
      );
      result[page.page_key] = current?.current_version ?? null;
    }
    return result;
  }

  private async insertPage(
    assetId: string,
    pageKey: string,
    currentVersion: number,
    now: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.db.collection("meta_prototype_pages").insertOne(
      {
        asset_id: assetId,
        page_key: pageKey,
        current_version: currentVersion,
        created_at: now,
        updated_at: now,
      } as Document,
      { session },
    );
  }

  private async updatePagePointer(
    assetId: string,
    pageKey: string,
    expectedVersion: number | null,
    nextVersion: number,
    now: string,
    session?: ClientSession,
  ): Promise<void> {
    const result = await this.db
      .collection("meta_prototype_pages")
      .updateOne(
        {
          asset_id: assetId,
          page_key: pageKey,
          current_version: expectedVersion,
        } as Document,
        { $set: { current_version: nextVersion, updated_at: now } },
        { session },
      );
    if ((result.matchedCount ?? 0) !== 1) {
      throw new PrototypeStoreError(
        "version_conflict",
        `Page ${pageKey} base version mismatch`,
        { [pageKey]: nextVersion },
      );
    }
  }

  private async insertVersion(
    row: PrototypePageVersionEntity,
    session?: ClientSession,
  ): Promise<void> {
    await this.db.collection("meta_prototype_versions").insertOne(
      {
        asset_id: row.asset_id,
        page_key: row.page_key,
        version: row.version,
        base_version: row.base_version,
        author_id: row.author_id,
        request_id: row.request_id,
        operation: row.operation,
        restore_version: row.restore_version,
        snapshot: row.snapshot,
        created_at: row.created_at,
      } as Document,
      { session },
    );
  }

  private async getRequest(
    assetId: string,
    authorId: string,
    requestId: string,
    session?: ClientSession,
  ): Promise<{ fingerprint: string; result: unknown } | null> {
    const doc = await this.db
      .collection("meta_prototype_requests")
      .findOne(
        { asset_id: assetId, author_id: authorId, request_id: requestId } as Document,
        { projection: { _id: 0, request_fingerprint: 1, result: 1 }, session },
      );
    if (!doc) return null;
    return {
      fingerprint: String(doc.request_fingerprint),
      result: doc.result,
    };
  }

  private async insertRequest(
    assetId: string,
    authorId: string,
    requestId: string,
    operation: "save" | "restore",
    fingerprint: string,
    result: unknown,
    now: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.db.collection("meta_prototype_requests").insertOne(
      {
        asset_id: assetId,
        author_id: authorId,
        request_id: requestId,
        operation,
        request_fingerprint: fingerprint,
        result,
        created_at: now,
        updated_at: now,
      } as Document,
      { session },
    );
  }

  private mapContract(doc: Document): PrototypeContractEntity {
    return {
      asset_id: String(doc.asset_id),
      component_type: String(doc.component_type),
      contract_version: Number(doc.contract_version),
      definition: doc.definition as Definition,
      definition_fingerprint: String(doc.definition_fingerprint),
      author_id: String(doc.author_id),
      created_at: String(doc.created_at),
    };
  }

  private mapPage(doc: Document): PrototypePageEntity {
    return {
      asset_id: String(doc.asset_id),
      page_key: String(doc.page_key),
      current_version:
        doc.current_version === null || doc.current_version === undefined
          ? null
          : Number(doc.current_version),
      created_at: String(doc.created_at),
      updated_at: String(doc.updated_at),
    };
  }

  private mapVersion(doc: Document): PrototypePageVersionEntity {
    return {
      asset_id: String(doc.asset_id),
      page_key: String(doc.page_key),
      version: Number(doc.version),
      base_version:
        doc.base_version === null || doc.base_version === undefined
          ? null
          : Number(doc.base_version),
      author_id: String(doc.author_id),
      request_id: String(doc.request_id),
      operation: String(doc.operation) as "save" | "restore",
      restore_version:
        doc.restore_version === null || doc.restore_version === undefined
          ? null
          : Number(doc.restore_version),
      snapshot: doc.snapshot as Snapshot,
      created_at: String(doc.created_at),
    };
  }

  private async withTx<T>(
    fn: (session?: ClientSession) => Promise<T>,
  ): Promise<T> {
    if (!this.useTransactions) {
      throw new PrototypeStoreError(
        "transactions_required",
        "MongoDB prototype writes require multi-document transactions",
      );
    }
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}
