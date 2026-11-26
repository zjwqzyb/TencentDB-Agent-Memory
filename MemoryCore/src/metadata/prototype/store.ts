import { createHash } from "node:crypto";
import type { Definition, Snapshot } from "./schema.js";

export type PrototypeMaybePromise<T> = T | Promise<T>;

export type PrototypeStoreReason =
  | "contract_conflict"
  | "contract_not_found"
  | "request_conflict"
  | "transactions_required"
  | "version_conflict"
  | "version_not_found";

export class PrototypeStoreError extends Error {
  constructor(
    public readonly reason: PrototypeStoreReason,
    message: string,
    public readonly latest_versions?: Record<string, number | null>,
  ) {
    super(message);
    this.name = "PrototypeStoreError";
  }
}

export interface PrototypeContractEntity {
  asset_id: string;
  component_type: string;
  contract_version: number;
  definition: Definition;
  definition_fingerprint: string;
  author_id: string;
  created_at: string;
}

export interface PrototypePageEntity {
  asset_id: string;
  page_key: string;
  current_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface PrototypePageVersionEntity {
  asset_id: string;
  page_key: string;
  version: number;
  base_version: number | null;
  author_id: string;
  request_id: string;
  operation: "save" | "restore";
  restore_version: number | null;
  snapshot: Snapshot;
  created_at: string;
}

export interface PrototypeSaveResult {
  asset_id: string;
  request_id: string;
  pages: Array<{
    page_key: string;
    version: number;
    created_at: string;
  }>;
}

export interface PrototypeContractInput {
  asset_id: string;
  component_type: string;
  contract_version: number;
  definition: Definition;
  author_id: string;
}

export interface PrototypeContractFilter {
  asset_id: string;
  component_type?: string;
}

export interface PrototypeContractRef {
  asset_id: string;
  component_type: string;
  contract_version: number;
}

export interface PrototypePageFilter {
  asset_id: string;
  page_key?: string;
}

export interface PrototypePageVersionFilter {
  asset_id: string;
  page_key: string;
  offset?: number;
  limit?: number;
}

export interface PrototypePageVersionRef {
  asset_id: string;
  page_key: string;
  version: number;
}

export interface PrototypeSavePageInput {
  page_key: string;
  base_version: number | null;
  snapshot: Snapshot;
}

export interface PrototypeSaveInput {
  asset_id: string;
  request_id: string;
  author_id: string;
  pages: PrototypeSavePageInput[];
}

export interface PrototypeRestoreInput {
  asset_id: string;
  page_key: string;
  request_id: string;
  author_id: string;
  base_version: number;
  restore_version: number;
}

export interface PrototypeStore {
  init(): PrototypeMaybePromise<void>;
  close(): PrototypeMaybePromise<void>;

  publishContract(
    input: PrototypeContractInput,
  ): PrototypeMaybePromise<PrototypeContractEntity>;
  getContract(
    input: PrototypeContractRef,
  ): PrototypeMaybePromise<PrototypeContractEntity | null>;
  listContracts(
    input: PrototypeContractFilter,
  ): PrototypeMaybePromise<PrototypeContractEntity[]>;

  listPages(
    input: PrototypePageFilter,
  ): PrototypeMaybePromise<PrototypePageEntity[]>;
  listPageVersions(
    input: PrototypePageVersionFilter,
  ): PrototypeMaybePromise<PrototypePageVersionEntity[]>;
  getPageVersion(
    input: PrototypePageVersionRef,
  ): PrototypeMaybePromise<PrototypePageVersionEntity | null>;

  savePages(
    input: PrototypeSaveInput,
  ): PrototypeMaybePromise<PrototypeSaveResult>;
  restorePage(
    input: PrototypeRestoreInput,
  ): PrototypeMaybePromise<PrototypePageVersionEntity>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function prototypeDefinitionFingerprint(definition: Definition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

export function prototypeRequestFingerprint(
  operation: "save" | "restore",
  payload: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, payload }))
    .digest("hex");
}
